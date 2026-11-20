/**
 * RDX-TV Serverless Relay for Samsung Tizen (Cloudflare Worker)
 *
 * Solves two fundamental Samsung Tizen WebView (.wgt) limitations without needing a PC:
 * 1. Bypasses ISP DNS blocking (runs on Cloudflare's global edge network).
 * 2. Bypasses Anubis PoW & SameSite=Lax cookie blocking on file:// WebView origins.
 *
 * Only tiny HTML/AJAX catalog & stream-link requests pass through this worker.
 * Video streams (.m3u8 / .mp4) play directly from the CDN to the TV.
 *
 * Free Cloudflare Workers tier: 100,000 requests/day.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// Per-origin cookie jar cached in worker isolate memory
const cookieStore = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-RDX-Referer, Accept",
  "Access-Control-Max-Age": "86400",
};

function getCookieHeader(origin) {
  const jar = cookieStore.get(origin);
  if (!jar || jar.size === 0) return "";
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function storeSetCookies(origin, response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  if (setCookies.length === 0) return;

  let jar = cookieStore.get(origin);
  if (!jar) {
    jar = new Map();
    cookieStore.set(origin, jar);
  }

  for (const raw of setCookies) {
    const first = raw.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!value || /max-age=0/i.test(raw)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function isAnubisHtml(html) {
  return (
    html.includes("anubis_challenge") ||
    html.includes("/.within.website/x/cmd/anubis/") ||
    html.includes("Проверяем, что вы не бот")
  );
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function solveAnubis(html, targetUrl) {
  const match = html.match(/id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match || !match[1]) return false;

  let payload;
  try {
    payload = JSON.parse(match[1].trim());
  } catch {
    return false;
  }

  const ch = payload && payload.challenge;
  if (!ch || !ch.id || !ch.randomData) return false;
  const alg = payload.rules && payload.rules.algorithm ? String(payload.rules.algorithm).trim().toLowerCase() : "fast";
  if (alg && alg !== "fast") return false;

  const rawDiff = ch.difficulty || (payload.rules && payload.rules.difficulty) || 2;
  const difficulty = Math.min(5, Math.max(1, rawDiff));
  const prefix = "0".repeat(difficulty);

  const start = Date.now();
  let nonce = 0;
  let hashHex = "";
  let solved = false;

  while (nonce < 500_000) {
    hashHex = await sha256Hex(`${ch.randomData}${nonce}`);
    if (hashHex.startsWith(prefix)) {
      solved = true;
      break;
    }
    nonce++;
  }
  if (!solved) return false;

  const parsed = new URL(targetUrl);
  const redir = `${parsed.pathname || "/"}${parsed.search || ""}`;
  const elapsed = Math.max(120, Math.min(30_000, Date.now() - start));
  const passUrl = `${parsed.origin}/.within.website/x/cmd/anubis/api/pass-challenge?id=${encodeURIComponent(
    ch.id
  )}&response=${hashHex}&nonce=${nonce}&redir=${encodeURIComponent(redir)}&elapsedTime=${elapsed}`;

  const headers = new Headers({
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: targetUrl,
  });
  const cookieHeader = getCookieHeader(parsed.origin);
  if (cookieHeader) headers.set("Cookie", cookieHeader);

  const passRes = await fetch(passUrl, {
    method: "GET",
    headers,
    redirect: "manual",
  });
  storeSetCookies(parsed.origin, passRes);
  return passRes.status >= 200 && passRes.status < 400;
}

async function fetchWithAnubis(targetUrl, method, contentType, bodyText, referer) {
  const parsed = new URL(targetUrl);

  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = new Headers({
      "User-Agent": USER_AGENT,
      Accept:
        method === "POST"
          ? "application/json, text/javascript, */*; q=0.01"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7",
      Referer: referer || `${parsed.origin}/`,
    });
    if (method === "POST") {
      headers.set("Content-Type", contentType || "application/x-www-form-urlencoded");
      headers.set("X-Requested-With", "XMLHttpRequest");
      headers.set("Origin", parsed.origin);
    }
    const cookieHeader = getCookieHeader(parsed.origin);
    if (cookieHeader) headers.set("Cookie", cookieHeader);

    const res = await fetch(targetUrl, {
      method,
      headers,
      body: method === "POST" ? bodyText : undefined,
      redirect: "follow",
    });
    storeSetCookies(parsed.origin, res);

    const text = await res.text();
    if (isAnubisHtml(text)) {
      const solved = await solveAnubis(text, targetUrl);
      if (solved) continue;
    }

    return new Response(text, {
      status: res.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": res.headers.get("Content-Type") || "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(JSON.stringify({ error: "Anubis challenge persisted" }), {
    status: 502,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");

    if (!target) {
      return new Response(JSON.stringify({ ok: true, service: "rdx-tv-relay" }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(target);
      if (parsedTarget.protocol !== "https:" && parsedTarget.protocol !== "http:") {
        throw new Error("Invalid protocol");
      }
    } catch {
      return new Response(JSON.stringify({ error: "Invalid target url" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const method = request.method === "POST" ? "POST" : "GET";
    const bodyText = method === "POST" ? await request.text() : undefined;
    const contentType = request.headers.get("Content-Type") || undefined;
    const refParam = reqUrl.searchParams.get("ref");
    const referer =
      (refParam && /^https?:\/\//i.test(refParam) ? refParam : null) ||
      request.headers.get("X-RDX-Referer") ||
      `${parsedTarget.origin}/`;

    try {
      return await fetchWithAnubis(parsedTarget.toString(), method, contentType, bodyText, referer);
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message ? err.message : err) }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  },
};
