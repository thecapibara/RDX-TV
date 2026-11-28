import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import cascadeLayers from "@csstools/postcss-cascade-layers";
import postcssPresetEnv from "postcss-preset-env";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

/**
 * Dev-only local HTTP proxy with DoH (1.1.1.1) & CookieJar so developers can test
 * RDX-TV v2 directly in a desktop browser at http://localhost:1420 without CORS blocks.
 * Never included in production builds (APK / WGT / IPK).
 */
function rdxDevProxyPlugin(): Plugin {
  const dohCache = new Map<string, { ip: string; exp: number }>();
  const cookieJar = new Map<string, Map<string, string>>();
  const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  const resolveDoh = (hostname: string): Promise<string | null> => {
    const c = dohCache.get(hostname);
    if (c && c.exp > Date.now()) return Promise.resolve(c.ip);
    return new Promise((resolve) => {
      const req = https.get(
        `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        { headers: { Accept: "application/dns-json" }, timeout: 3000 },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(raw) as { Answer?: Array<{ type: number; data?: string }> };
              const ans = data.Answer?.find((a) => a.type === 1 && a.data);
              if (ans?.data) {
                dohCache.set(hostname, { ip: ans.data, exp: Date.now() + 10 * 60_000 });
                return resolve(ans.data);
              }
            } catch {}
            resolve(null);
          });
        }
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    });
  };

  const fetchTarget = async (
    targetUrl: string,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    redirectsLeft = 4
  ): Promise<{ status: number; contentType: string; data: Buffer; dohBypass: boolean }> => {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === "https:";
    const dohIp = await resolveDoh(u.hostname);

    const jar = cookieJar.get(u.hostname);
    const cookieHeader = jar
      ? Array.from(jar.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join("; ")
      : "";

    const reqHeaders: Record<string, string> = {
      "User-Agent": UA,
      "Accept-Encoding": "gzip, deflate",
      Referer: `${u.origin}/`,
      ...headers,
    };
    if (cookieHeader && !reqHeaders.Cookie) reqHeaders.Cookie = cookieHeader;
    if (body && body.length > 0) reqHeaders["Content-Length"] = String(body.length);

    return new Promise((resolve, reject) => {
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method,
          headers: reqHeaders,
          timeout: 12_000,
          ...(dohIp
            ? {
                lookup: (_h, opts, cb) => {
                  if (opts && typeof opts === "object" && opts.all) {
                    (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
                      null,
                      [{ address: dohIp, family: 4 }]
                    );
                  } else {
                    cb(null, dohIp, 4);
                  }
                },
                servername: u.hostname,
              }
            : {}),
        },
        (res) => {
          const setCookies = res.headers["set-cookie"];
          if (Array.isArray(setCookies)) {
            let map = cookieJar.get(u.hostname);
            if (!map) {
              map = new Map();
              cookieJar.set(u.hostname, map);
            }
            for (const line of setCookies) {
              const pair = line.split(";")[0];
              const eq = pair.indexOf("=");
              if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
          }

          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            const nextUrl = new URL(res.headers.location, targetUrl).toString();
            res.resume();
            fetchTarget(nextUrl, "GET", {}, undefined, redirectsLeft - 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          const chunks: Buffer[] = [];
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          let stream: NodeJS.ReadableStream = res;
          if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
          else if (enc === "deflate") stream = res.pipe(zlib.createInflate());

          stream.on("data", (d: Buffer) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
          stream.on("end", () => {
            resolve({
              status: res.statusCode || 200,
              contentType: String(res.headers["content-type"] || "text/html; charset=utf-8"),
              data: Buffer.concat(chunks),
              dohBypass: Boolean(dohIp),
            });
          });
          stream.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error("Timeout")));
      req.on("error", reject);
      if (body && body.length > 0) req.write(body);
      req.end();
    });
  };

  return {
    name: "rdx-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__rdx_dev_proxy", (req, res) => {
        const parsed = new URL(req.url || "/", "http://localhost");
        const targetUrl = parsed.searchParams.get("url");
        if (!targetUrl) {
          res.statusCode = 400;
          res.end("Missing url");
          return;
        }
        const bodyChunks: Buffer[] = [];
        req.on("data", (c: Buffer) => bodyChunks.push(c));
        req.on("end", async () => {
          try {
            const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;
            const fwdHeaders: Record<string, string> = {};
            if (req.headers["content-type"]) {
              fwdHeaders["Content-Type"] = String(req.headers["content-type"]);
            }
            if (req.headers["x-requested-with"]) {
              fwdHeaders["X-Requested-With"] = String(req.headers["x-requested-with"]);
            }
            const out = await fetchTarget(targetUrl, req.method || "GET", fwdHeaders, body);
            res.statusCode = out.status;
            res.setHeader("Content-Type", out.contentType);
            res.setHeader("X-RDX-DoH", out.dohBypass ? "1" : "0");
            res.end(out.data);
          } catch (err) {
            res.statusCode = 502;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), rdxDevProxyPlugin()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom/test-utils": "preact/test-utils",
      "react-dom/client": "preact/compat/client",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss(),
        cascadeLayers(),
        postcssPresetEnv({
          browsers: "chrome >= 70",
          stage: 2,
          features: {
            "cascade-layers": false,
          },
        }),
      ],
    },
  },
  build: {
    target: "chrome70",
    cssTarget: "chrome70",
    minify: "esbuild",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
