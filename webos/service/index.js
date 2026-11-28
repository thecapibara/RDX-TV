/**
 * Local Node.js webOS Luna Service (`luna://com.rdx.tv.service/fetch`)
 * Runs directly on LG webOS TV: supports DoH (1.1.1.1 + 8.8.8.8 fallback),
 * custom Referer/UA, bounded CookieJar, 4MB OOM cap & stream error guards.
 */
const Service = require("webos-service");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

const service = new Service("com.rdx.tv.service");
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB OOM cap for webOS Node service
const MAX_CACHE_ENTRIES = 64;

const dohCache = new Map(); // host -> { ip, exp }
const cookieJar = new Map(); // host -> Map<name, value>

const DEFAULT_UA =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.211 Safari/537.36";

function setBounded(map, key, value) {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function queryDohEndpoint(endpointUrl) {
  return new Promise((resolve) => {
    const req = https.get(
      endpointUrl,
      { headers: { Accept: "application/dns-json" }, timeout: 2500 },
      (res) => {
        let raw = "";
        res.on("error", () => resolve(null));
        res.on("data", (c) => {
          if (raw.length < 32768) raw += c;
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            const ans = (data.Answer || []).find((a) => a.type === 1 && a.data);
            if (ans && ans.data) return resolve(ans.data);
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

async function resolveDoh(hostname) {
  const cached = dohCache.get(hostname);
  if (cached && cached.exp > Date.now()) return cached.ip;

  const q = encodeURIComponent(hostname);
  let ip = await queryDohEndpoint(`https://1.1.1.1/dns-query?name=${q}&type=A`);
  if (!ip) {
    ip = await queryDohEndpoint(`https://dns.google/resolve?name=${q}&type=A`);
  }
  if (ip) {
    setBounded(dohCache, hostname, { ip, exp: Date.now() + 10 * 60 * 1000 });
  }
  return ip;
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
    setBounded(cookieJar, host, map);
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

  const deadlineMs = Math.max(2000, Math.min(30000, Number(timeoutMs) || 12000));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const mod = isHttps ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: method || "GET",
      headers: reqHeaders,
      timeout: deadlineMs,
      ...(dohIp
        ? {
            lookup: (_h, o, cb) =>
              o && o.all ? cb(null, [{ address: dohIp, family: 4 }]) : cb(null, dohIp, 4),
            servername: u.hostname,
          }
        : {}),
    };

    const req = mod.request(opts, (res) => {
      res.on("error", (err) => finish(err));
      storeCookies(u.hostname, res.headers["set-cookie"]);

      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        res.resume();
        clearTimeout(deadlineTimer);
        performRequest(nextUrl, "GET", headers, null, deadlineMs, redirectsLeft - 1)
          .then((v) => finish(null, v))
          .catch((e) => finish(e));
        return;
      }

      const chunks = [];
      let totalBytes = 0;
      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());

      stream.on("error", (err) => finish(err));
      stream.on("data", (d) => {
        totalBytes += d.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          finish(new Error("Response exceeds 4MB limit"));
          return;
        }
        chunks.push(d);
      });
      stream.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        finish(null, {
          status: res.statusCode || 200,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text,
          finalUrl: targetUrl,
          dohBypass: Boolean(dohIp),
        });
      });
    });

    const deadlineTimer = setTimeout(() => {
      req.destroy(new Error("Request deadline exceeded"));
      finish(new Error("Timeout"));
    }, deadlineMs);

    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.on("error", (err) => finish(err));
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
