/**
 * Local Node.js webOS Luna Service (`luna://com.rdx.tv.service/fetch`)
 * Runs directly on LG webOS TV: supports DoH (1.1.1.1 / 8.8.8.8), custom Referer/UA, and CookieJar.
 * Zero external relays, 100% local on the TV.
 */
const Service = require("webos-service");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

const service = new Service("com.rdx.tv.service");
const dohCache = new Map(); // host -> { ip, exp }
const cookieJar = new Map(); // host -> Map<name, value>

const DEFAULT_UA =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.211 Safari/537.36";

function resolveDoh(hostname) {
  const cached = dohCache.get(hostname);
  if (cached && cached.exp > Date.now()) return Promise.resolve(cached.ip);

  return new Promise((resolve) => {
    const req = https.get(
      `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { Accept: "application/dns-json" }, timeout: 3000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            const ans = (data.Answer || []).find((a) => a.type === 1 && a.data);
            if (ans && ans.data) {
              dohCache.set(hostname, { ip: ans.data, exp: Date.now() + 10 * 60 * 1000 });
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
}

function getCookieHeader(host) {
  const map = cookieJar.get(host);
  if (!map || map.size === 0) return "";
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function storeCookies(host, setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders)) return;
  let map = cookieJar.get(host);
  if (!map) {
    map = new Map();
    cookieJar.set(host, map);
  }
  for (const line of setCookieHeaders) {
    const pair = String(line).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) {
      map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

async function performRequest(targetUrl, method, headers, body, timeoutMs, redirectsLeft = 4) {
  const u = new URL(targetUrl);
  const isHttps = u.protocol === "https:";
  const dohIp = await resolveDoh(u.hostname);
  const reqHeaders = Object.assign(
    {
      "User-Agent": DEFAULT_UA,
      "Accept-Encoding": "gzip, deflate",
    },
    headers || {}
  );
  const cookie = getCookieHeader(u.hostname);
  if (cookie && !reqHeaders.Cookie) reqHeaders.Cookie = cookie;

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: method || "GET",
      headers: reqHeaders,
      timeout: timeoutMs || 12000,
      ...(dohIp
        ? {
            lookup: (_h, o, cb) =>
              o && o.all ? cb(null, [{ address: dohIp, family: 4 }]) : cb(null, dohIp, 4),
            servername: u.hostname,
          }
        : {}),
    };

    const req = mod.request(opts, (res) => {
      storeCookies(u.hostname, res.headers["set-cookie"]);
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        res.resume();
        return performRequest(nextUrl, "GET", headers, null, timeoutMs, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
      }

      const chunks = [];
      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());

      stream.on("data", (d) => chunks.push(d));
      stream.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode || 200,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text,
          finalUrl: targetUrl,
          dohBypass: Boolean(dohIp),
        });
      });
      stream.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy(new Error("Timeout"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

service.register("fetch", async (message) => {
  const { url, method, headers, body, timeoutMs } = message.payload || {};
  if (!url) {
    message.respond({ returnValue: false, errorText: "Missing url" });
    return;
  }
  try {
    const result = await performRequest(url, method, headers, body, timeoutMs);
    message.respond(Object.assign({ returnValue: true }, result));
  } catch (err) {
    message.respond({
      returnValue: false,
      errorText: err && err.message ? err.message : String(err),
    });
  }
});
