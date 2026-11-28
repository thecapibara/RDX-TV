/**
 * Unified TypeScript HDRezka Scraper & #h Stream Decryptor for RDX-TV v2.
 * Routes all HTTP requests through `platform.http`:
 * - Android TV: native Kotlin OkHttp (DoH, CookieJar, custom Referer/UA)
 * - LG webOS: local Node.js webos-service (DoH, CookieJar, custom Referer/UA)
 * - Samsung Tizen / Web: direct fetch (<access origin="*">), zero Cloudflare relay.
 */
import { platform } from "../platform";
import type {
  EpisodeTab,
  EpisodesData,
  MediaCard,
  MediaDetails,
  MirrorStatus,
  SearchItem,
  SeasonTab,
  StreamData,
  StreamQuality,
  SubtitleTrack,
  Translator,
} from "../types";

const GENRE_PATH_MAP: Record<string, string> = {
  "Бойовики": "action",
  "Фантастика": "fiction",
  "Фентезі": "fantasy",
  "Трилери": "thriller",
  "Драми": "drama",
  "Комедії": "comedy",
  "Мелодрами": "melodrama",
  "Детективи": "detective",
  "Пригоди": "adventures",
  "Жахи": "horror",
  "Кримінал": "crime",
  "Сімейні": "family",
  "Військові": "military",
  "Історичні": "historical",
  "Біографічні": "biographical",
  "Документальні": "documentary",
  "Вестерни": "western",
  "Спорт": "sport",
  "Музичні": "musical",
};

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `${cleanBase}${href.startsWith("/") ? "" : "/"}${href}`;
}

function cleanTag(raw: string): string {
  return raw.replace(/<[^>]*>/g, "").trim();
}

export function deobfuscateStream(rawStream: string): string {
  const trimmed = (rawStream || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.includes("http")) return trimmed;

  let cleaned = trimmed;
  if (cleaned.startsWith("#h")) cleaned = cleaned.slice(2);
  else if (cleaned.startsWith("#")) cleaned = cleaned.slice(1);

  const stripped = cleaned.replace(/\/\/_\/\/|bk[0-9]/g, "").trim();
  const padLen = (4 - (stripped.length % 4)) % 4;
  const padded = stripped + "=".repeat(padLen);

  try {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (decoded.includes("http")) return decoded;
  } catch {
    // fallback below
  }
  return trimmed;
}

export function parseStreamData(
  rawUrl: string,
  rawSubtitles?: string | null,
  defaultQuality = "720p"
): StreamData {
  const deobfuscated = deobfuscateStream(rawUrl);
  const qualities: StreamQuality[] = [];
  const streamRe = /\[(.*?)\]([^\[]+)/g;
  let match: RegExpExecArray | null;

  while ((match = streamRe.exec(deobfuscated)) !== null) {
    const label = cleanTag(match[1]);
    const urlsStr = match[2].trim().replace(/,+$/, "");
    const variants = urlsStr.split(" or ").map((s) => s.trim());

    let hls_url: string | null = null;
    let mp4_url: string | null = null;

    for (const v of variants) {
      if (v.includes(".m3u8") || v.includes(":hls:manifest.m3u8")) {
        hls_url = v;
      } else if (v.includes(".mp4")) {
        mp4_url = v;
      } else if (!hls_url && v.startsWith("http")) {
        hls_url = v;
      }
    }

    if (label && (hls_url || mp4_url)) {
      qualities.push({ label, hls_url, mp4_url });
    }
  }

  const subtitles: SubtitleTrack[] = [];
  if (rawSubtitles) {
    const subRe = /\[(.*?)\](https?:\/\/[^\s,]+)/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = subRe.exec(rawSubtitles)) !== null) {
      subtitles.push({
        label: cleanTag(sMatch[1]),
        url: sMatch[2].trim(),
      });
    }
  }

  return {
    qualities,
    default_quality: defaultQuality || qualities[qualities.length - 1]?.label || "720p",
    subtitles,
    thumbnails: null,
  };
}

function parseCatalogHtml(html: string, baseUrl: string): MediaCard[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = Array.from(doc.querySelectorAll(".b-content__inline_item"));
  const items: MediaCard[] = [];

  for (const el of nodes) {
    const linkEl = el.querySelector(".b-content__inline_item-link a") as HTMLAnchorElement | null;
    const coverLink = el.querySelector(".b-content__inline_item-cover a") as HTMLAnchorElement | null;
    const href = linkEl?.getAttribute("href") || coverLink?.getAttribute("href") || el.getAttribute("data-url") || "";
    const url = resolveUrl(href, baseUrl);
    if (!url) continue;

    const id =
      el.getAttribute("data-id") ||
      url.match(/\/(\d+)-/)?.[1] ||
      url;

    const imgEl = el.querySelector(".b-content__inline_item-cover img");
    const rawPoster = imgEl?.getAttribute("data-src") || imgEl?.getAttribute("src") || "";
    const poster = resolveUrl(rawPoster, baseUrl);

    const title = linkEl?.textContent?.trim() || "";
    if (!title) continue;

    const misc_info = el.querySelector(".b-content__inline_item-link div")?.textContent?.trim() || "";
    const catText = el.querySelector(".cat")?.textContent?.trim() || "";
    const infoBadge = el.querySelector(".info")?.textContent?.trim() || null;
    const rating = el.querySelector(".b-category-bestrating")?.textContent?.trim() || null;

    let entity_type = "movie";
    if (catText.includes("Сериал") || catText.includes("Серіал") || url.includes("/series/")) {
      entity_type = "series";
    } else if (catText.includes("Мульт") || url.includes("/cartoons/")) {
      entity_type = "cartoon";
    } else if (catText.includes("Аниме") || catText.includes("Аніме") || url.includes("/animation/")) {
      entity_type = "anime";
    }

    items.push({
      id,
      url,
      title,
      poster,
      misc_info,
      entity_type,
      rating,
      series_info: infoBadge,
    });
  }

  return items;
}

function isAnubisHtml(html: string): boolean {
  return (
    html.includes("anubis_challenge") ||
    html.includes("/.within.website/x/cmd/anubis/") ||
    html.includes("Проверяем, что вы не бот")
  );
}

function isCloudflareChallenge(html: string, status: number): boolean {
  return (
    status === 403 ||
    status === 503
  ) && (
    html.includes("cf-browser-verification") ||
    html.includes("challenge-platform") ||
    html.includes("Just a moment...")
  );
}

// Pure-JS SHA-256 fallback for environments where crypto.subtle is unavailable (e.g. file:// on Tizen)
function sha256PureJs(ascii: string): string {
  const utf8 = unescape(encodeURIComponent(ascii));
  const words: number[] = [];
  for (let i = 0; i < utf8.length; i++) {
    words[i >> 2] |= utf8.charCodeAt(i) << (24 - (i % 4) * 8);
  }
  const bitLen = utf8.length * 8;
  words[bitLen >> 5] |= 0x80 << (24 - (bitLen % 32));
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));

  for (let j = 0; j < words.length; j += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[j + i] | 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + k[i] + w[i]) | 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

async function sha256Hex(input: string, enc: TextEncoder): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
      const bytes = new Uint8Array(buf);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fallback to pure-JS SHA-256 if subtle.digest fails in non-secure context
    }
  }
  return sha256PureJs(input);
}

async function solveAnubisChallenge(html: string, targetUrl: string): Promise<boolean> {
  if (!isAnubisHtml(html)) {
    return false;
  }
  const m = html.match(/id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return false;

  try {
    const payload = JSON.parse(m[1].trim()) as {
      rules?: { algorithm?: string; difficulty?: number };
      challenge?: { id?: string; randomData?: string; difficulty?: number };
    };
    const ch = payload.challenge;
    if (!ch?.id || !ch?.randomData) return false;
    const alg = payload.rules?.algorithm?.trim().toLowerCase();
    if (alg && alg !== "fast") return false;

    const rawDiff = ch.difficulty ?? payload.rules?.difficulty ?? 2;
    const difficulty = Math.min(6, Math.max(1, rawDiff));
    const prefix = "0".repeat(difficulty);
    const enc = new TextEncoder();
    const start = performance.now();
    let nonce = 0;
    let hashHex = "";
    let solved = false;

    while (nonce < 2_000_000) {
      hashHex = await sha256Hex(`${ch.randomData}${nonce}`, enc);
      if (hashHex.startsWith(prefix)) {
        solved = true;
        break;
      }
      nonce++;
    }
    if (!solved) return false;

    const parsed = new URL(targetUrl);
    const redir = `${parsed.pathname || "/"}${parsed.search || ""}`;
    const elapsed = Math.max(120, Math.min(30_000, Math.round(performance.now() - start)));
    const passUrl = `${parsed.origin}/.within.website/x/cmd/anubis/api/pass-challenge?id=${encodeURIComponent(ch.id)}&response=${hashHex}&nonce=${nonce}&redir=${encodeURIComponent(redir)}&elapsedTime=${elapsed}`;
    const passRes = await platform.http.request({ url: passUrl, method: "GET" });
    return passRes.ok || passRes.status === 302 || passRes.status === 301;
  } catch {
    return false;
  }
}

const FETCH_TIMEOUT_MS = 12_000;

function originReferer(targetUrl: string): string {
  try {
    return `${new URL(targetUrl).origin}/`;
  } catch {
    return "";
  }
}

async function fetchHtml(url: string): Promise<{ text: string; dohBypass?: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    if (platform.http.supportsCustomHeaders) {
      const ref = originReferer(url);
      if (ref) headers.Referer = ref;
    }
    const res = await platform.http.request({
      url,
      method: "GET",
      headers,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const text = res.text;
    if (isCloudflareChallenge(text, res.status)) {
      throw new Error(`Cloudflare challenge on ${url}`);
    }
    if (isAnubisHtml(text)) {
      const solved = await solveAnubisChallenge(text, url);
      if (solved) continue;
      throw new Error(`Anubis challenge unsolved on ${url}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return { text, dohBypass: res.dohBypass };
  }
  throw new Error(`Anubis challenge persisted on ${url}`);
}

async function postForm(url: string, body: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    };
    if (platform.http.supportsCustomHeaders) {
      const ref = originReferer(url);
      if (ref) headers.Referer = ref;
    }
    const res = await platform.http.request({
      url,
      method: "POST",
      headers,
      body,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const text = res.text;
    if (isAnubisHtml(text)) {
      const solved = await solveAnubisChallenge(text, url);
      if (solved) continue;
      throw new Error(`Anubis challenge unsolved on ${url}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return text;
  }
  throw new Error(`Anubis challenge persisted on ${url}`);
}

function formatMirrorError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || "");
  if (msg.includes("Anubis") || msg.includes("Cloudflare")) return "Anti-Bot";
  if (msg.includes("Timeout") || msg.includes("AbortError")) return "Таймаут";
  const httpMatch = msg.match(/HTTP\s+(\d{3})/);
  if (httpMatch) return `HTTP ${httpMatch[1]}`;
  if (/failed to fetch|network|cors|load failed/i.test(msg)) return "Мережа/CORS";
  return "Недоступно";
}

export const tizenRezka = {
  checkMirrorStatus: async (mirrorUrl: string): Promise<MirrorStatus> => {
    const clean = mirrorUrl.replace(/\/+$/, "");
    const start = performance.now();
    try {
      const { text: html, dohBypass } = await fetchHtml(clean);
      const latency_ms = Math.round(performance.now() - start);
      const hasCatalog = html.includes("b-content__inline_item");
      const usedDoh = Boolean(dohBypass || platform.http.supportsDoh);
      return {
        mirror_url: clean,
        online: true,
        latency_ms,
        status_message: hasCatalog
          ? usedDoh
            ? "OK • DoH"
            : "OK • Пряме"
          : "Обмежено",
        doh_bypass: usedDoh,
        catalog_available: hasCatalog,
        stream_available: hasCatalog,
      };
    } catch (err) {
      const latency_ms = Math.round(performance.now() - start);
      return {
        mirror_url: clean,
        online: false,
        latency_ms,
        status_message: formatMirrorError(err),
        doh_bypass: platform.http.supportsDoh,
        catalog_available: false,
        stream_available: false,
      };
    }
  },

  getHomeCatalog: async (
    baseUrl: string,
    filter?: string,
    genre?: string,
    page?: number
  ): Promise<MediaCard[]> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams();
    if (filter) params.set("filter", filter);
    if (genre && GENRE_PATH_MAP[genre]) {
      const p = page && page > 1 ? `page/${page}/` : "";
      const qs = params.toString() ? `?${params.toString()}` : "";
      const { text: html } = await fetchHtml(`${clean}/films/${GENRE_PATH_MAP[genre]}/${p}${qs}`);
      return parseCatalogHtml(html, clean);
    }
    const p = page && page > 1 ? `/page/${page}/` : "/";
    const qs = params.toString() ? `?${params.toString()}` : "";
    const { text: html } = await fetchHtml(`${clean}${p}${qs}`);
    return parseCatalogHtml(html, clean);
  },

  getCategoryCatalog: async (
    baseUrl: string,
    category: string,
    genre?: string,
    filter?: string,
    page?: number
  ): Promise<MediaCard[]> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const pageSlug = page && page > 1 ? `page/${page}/` : "";
    if (category === "new") {
      const targetCat = genre && ["films", "series", "cartoons", "animation"].includes(genre) ? genre : "";
      const effFilter = filter || "last";
      const path = targetCat ? `${targetCat}/${pageSlug}` : `new/${pageSlug}`;
      const { text: html } = await fetchHtml(`${clean}/${path}?filter=${encodeURIComponent(effFilter)}`);
      return parseCatalogHtml(html, clean);
    }
    const mappedGenre = genre ? GENRE_PATH_MAP[genre] || genre : "";
    const genreSlug = mappedGenre ? `${mappedGenre}/` : "";
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : "";
    const { text: html } = await fetchHtml(`${clean}/${category}/${genreSlug}${pageSlug}${qs}`);
    return parseCatalogHtml(html, clean);
  },

  searchMedia: async (baseUrl: string, query: string): Promise<MediaCard[]> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const { text: html } = await fetchHtml(
      `${clean}/search/?do=search&subaction=search&q=${encodeURIComponent(query)}`
    );
    return parseCatalogHtml(html, clean);
  },

  searchAutocomplete: async (baseUrl: string, query: string): Promise<SearchItem[]> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const body = new URLSearchParams({ q: query });
    let html: string;
    try {
      html = await postForm(`${clean}/engine/ajax/search.php`, body.toString());
    } catch {
      return [];
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll(".b-search__section_list li")).map((li) => {
      const a = li.querySelector("a") as HTMLAnchorElement | null;
      const title = li.querySelector(".enty")?.textContent?.trim() || a?.textContent?.trim() || "";
      const rating = li.querySelector(".rating i")?.textContent?.trim() || null;
      return {
        title,
        orig_title: null,
        year: "",
        entity_type: "Реліз",
        rating,
        url: resolveUrl(a?.getAttribute("href") || "", clean),
      };
    });
  },

  getMediaDetails: async (baseUrl: string, itemUrl: string): Promise<MediaDetails> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const fullUrl = resolveUrl(itemUrl, clean);
    const { text: html } = await fetchHtml(fullUrl);
    const doc = new DOMParser().parseFromString(html, "text/html");

    const id =
      doc.querySelector("#post_id")?.getAttribute("value") ||
      html.match(/initCDN(?:Movies|Series)Events\(\s*(\d+)/)?.[1] ||
      fullUrl.match(/\/(\d+)-/)?.[1] ||
      "0";

    const parsedTitle =
      doc.querySelector('h1[itemprop="name"]')?.textContent?.trim() ||
      doc.querySelector("div.b-post__title > h1")?.textContent?.trim() ||
      doc.querySelector(".b-post__title")?.textContent?.trim();
    if (!parsedTitle) {
      throw new Error("Не вдалося завантажити деталі релізу з дзеркала");
    }
    const title = parsedTitle;
    const orig_title = doc.querySelector(".b-post__origtitle")?.textContent?.trim() || null;
    const imgEl = doc.querySelector(".b-sidecover img");
    const poster = resolveUrl(imgEl?.getAttribute("src") || "", clean);
    const highHref = doc.querySelector(".b-sidecover a")?.getAttribute("href") || "";
    const high_res_poster = highHref ? resolveUrl(highHref, clean) : poster;

    const imdb_rating = doc.querySelector(".b-post__info_rates.imdb span")?.textContent?.trim() || null;
    const kp_rating = doc.querySelector(".b-post__info_rates.kp span")?.textContent?.trim() || null;
    const description = doc.querySelector(".b-post__description_text")?.textContent?.trim() || "";

    const info_table: [string, string][] = Array.from(
      doc.querySelectorAll(".b-post__info tr")
    )
      .map((tr) => {
        const k = tr.querySelector("td.l")?.textContent?.replace(/:$/, "").trim() || "";
        const v = tr.querySelector("td:not(.l)")?.textContent?.trim() || "";
        return [k, v] as [string, string];
      })
      .filter(([k, v]) => k && v);

    const translators: Translator[] = Array.from(
      doc.querySelectorAll("#translators-list .b-translator__item")
    )
      .filter((el) => !el.classList.contains("b-prem_translator"))
      .map((el) => {
        const name = el.getAttribute("title") || el.textContent?.trim() || "Озвучка";
        const flag = el.querySelector("img")?.getAttribute("alt") || "";
        return {
          id: el.getAttribute("data-translator_id") || "0",
          name,
          language: flag || (/укр/i.test(name) ? "Українська" : ""),
          is_active: el.classList.contains("active"),
        };
      });

    // Single-dub movie/series fallback: extract translator_id from sof.tv.initCDN*Events(id, translator_id, ...)
    if (translators.length === 0) {
      const initMatch = html.match(/initCDN(?:Movies|Series)Events\(\s*\d+\s*,\s*(\d+)/);
      if (initMatch?.[1]) {
        translators.push({
          id: initMatch[1],
          name: "Дубляж / Оригінал",
          language: "",
          is_active: true,
        });
      }
    } else if (!translators.some((t) => t.is_active)) {
      const ukr = translators.find((t) => /укр/i.test(`${t.language} ${t.name}`));
      if (ukr) ukr.is_active = true;
      else translators[0].is_active = true;
    }

    const seasons: SeasonTab[] = Array.from(
      doc.querySelectorAll("#simple-seasons-tabs .b-simple_season__item")
    ).map((el) => ({
      id: el.getAttribute("data-tab_id") || "1",
      title: el.textContent?.trim() || "1 сезон",
    }));

    const episodes: EpisodeTab[] = Array.from(
      doc.querySelectorAll("#simple-episodes-tabs .b-simple_episode__item")
    ).map((el) => ({
      season_id: el.getAttribute("data-season_id") || "1",
      episode_id: el.getAttribute("data-episode_id") || "1",
      title: el.textContent?.trim() || "1 серія",
    }));

    let initial_streams: StreamData | null = null;
    const streamsMatch = html.match(/"streams"\s*:\s*"([^"]+)"/);
    if (streamsMatch?.[1]) {
      const decodedJsonStr = streamsMatch[1].replace(/\\\//g, "/");
      const subMatch = html.match(/"subtitle"\s*:\s*"([^"]*)"/);
      initial_streams = parseStreamData(decodedJsonStr, subMatch?.[1] || null);
    }

    return {
      id,
      url: fullUrl,
      title,
      orig_title,
      poster,
      high_res_poster,
      imdb_rating,
      kp_rating,
      description,
      info_table,
      translators,
      seasons,
      episodes,
      initial_streams,
    };
  },

  getStream: async (
    baseUrl: string,
    mediaId: string,
    isSeries: boolean,
    translatorId?: string,
    season?: number,
    episode?: number
  ): Promise<StreamData> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams();
    params.set("id", mediaId);
    if (translatorId) params.set("translator_id", translatorId);
    if (isSeries) {
      params.set("season", String(season ?? 1));
      params.set("episode", String(episode ?? 1));
      params.set("action", "get_stream");
    } else {
      params.set("is_camrip", "0");
      params.set("is_ads", "0");
      params.set("is_director", "0");
      params.set("action", "get_movie");
    }
    params.set("favs", "");

    const rawText = await postForm(
      `${clean}/ajax/get_cdn_series/?t=${Date.now()}`,
      params.toString()
    );
    const data = JSON.parse(rawText) as {
      success?: boolean;
      url?: string;
      subtitle?: string;
      quality?: string;
      message?: string;
    };
    if (!data.url) {
      throw new Error(data.message || "Потік недоступний");
    }
    return parseStreamData(data.url, data.subtitle || null, data.quality || "720p");
  },

  getEpisodes: async (
    baseUrl: string,
    mediaId: string,
    translatorId: string
  ): Promise<EpisodesData> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({
      id: mediaId,
      translator_id: translatorId,
      action: "get_episodes",
    });
    const rawText = await postForm(
      `${clean}/ajax/get_cdn_series/?t=${Date.now()}`,
      params.toString()
    );
    const data = JSON.parse(rawText) as {
      seasons?: string;
      episodes?: string;
      url?: string;
      subtitle?: string;
      quality?: string;
    };

    const sDoc = new DOMParser().parseFromString(data.seasons || "", "text/html");
    const eDoc = new DOMParser().parseFromString(data.episodes || "", "text/html");

    const seasons: SeasonTab[] = Array.from(
      sDoc.querySelectorAll(".b-simple_season__item")
    ).map((el) => ({
      id: el.getAttribute("data-tab_id") || "1",
      title: el.textContent?.trim() || "1 сезон",
    }));

    const episodes: EpisodeTab[] = Array.from(
      eDoc.querySelectorAll(".b-simple_episode__item")
    ).map((el) => ({
      season_id: el.getAttribute("data-season_id") || "1",
      episode_id: el.getAttribute("data-episode_id") || "1",
      title: el.textContent?.trim() || "1 серія",
    }));

    const stream_data = data.url
      ? parseStreamData(data.url, data.subtitle || null, data.quality || "720p")
      : null;

    return { seasons, episodes, stream_data };
  },

  getBackdrop: async (
    title: string,
    origTitle?: string,
    year?: string,
    mediaType?: "movie" | "tv"
  ): Promise<string | null> => {
    const match = await resolveTmdbMatch(title, origTitle, year, mediaType);
    return match?.backdropUrl || null;
  },

  getTmdbRecommendations: async (
    baseUrl: string,
    title: string,
    origTitle?: string,
    year?: string,
    mediaType?: "movie" | "tv",
    excludeId?: string
  ): Promise<MediaCard[]> => {
    const match = await resolveTmdbMatch(title, origTitle, year, mediaType);
    if (!match) return [];

    const recs: Array<{ title: string; origTitle?: string; year?: string }> = [];
    const seen = new Set<string>();

    for (const endpoint of ["recommendations", "similar"]) {
      for (const lang of ["uk-UA", "ru-RU"]) {
        if (recs.length >= 10) break;
        try {
          const res = await fetch(
            `https://api.themoviedb.org/3/${match.mediaType}/${match.id}/${endpoint}?api_key=4e44d9029b1270a757cddc766a1bcb63&language=${lang}&page=1`
          );
          if (!res.ok) continue;
          const data = (await res.json()) as {
            results?: Array<{
              title?: string;
              name?: string;
              original_title?: string;
              original_name?: string;
              release_date?: string;
              first_air_date?: string;
            }>;
          };
          for (const item of data.results || []) {
            const t = (item.title || item.name || "").trim();
            if (!t || seen.has(t.toLowerCase())) continue;
            seen.add(t.toLowerCase());
            const orig = (item.original_title || item.original_name || "").trim() || undefined;
            const y = (item.release_date || item.first_air_date || "").slice(0, 4) || undefined;
            recs.push({ title: t, origTitle: orig, year: y });
            if (recs.length >= 10) break;
          }
        } catch {}
      }
      if (recs.length >= 10) break;
    }

    if (recs.length === 0) return [];

    const settled = await Promise.all(
      recs.map(async (rec) => {
        let results = await tizenRezka.searchMedia(baseUrl, rec.title).catch(() => []);
        if (results.length === 0 && rec.origTitle) {
          results = await tizenRezka.searchMedia(baseUrl, rec.origTitle).catch(() => []);
        }
        return (
          results.find((card) => {
            if (excludeId && card.id === excludeId) return false;
            if (mediaType) {
              const isSeries =
                card.entity_type.toLowerCase().includes("сериал") ||
                card.entity_type.toLowerCase().includes("серіал") ||
                card.url.includes("/series/");
              if (mediaType === "tv" && !isSeries) return false;
              if (mediaType === "movie" && isSeries) return false;
            }
            if (rec.year && card.misc_info.includes(rec.year)) return true;
            return true;
          }) || null
        );
      })
    );

    const out: MediaCard[] = [];
    const usedIds = new Set<string>();
    for (const c of settled) {
      if (c && !usedIds.has(c.id)) {
        usedIds.add(c.id);
        out.push(c);
      }
    }
    return out;
  },
};

async function resolveTmdbMatch(
  title: string,
  origTitle?: string,
  year?: string,
  mediaType?: "movie" | "tv"
): Promise<{ id: number; mediaType: "movie" | "tv"; backdropUrl: string | null } | null> {
  const candidates: Array<{ query: string; isLatin: boolean }> = [];
  const seenQ = new Set<string>();
  const addCandidate = (q: string) => {
    const clean = q.replace("(все сезоны)", "").replace("(сериал)", "").trim();
    if (!clean || seenQ.has(clean)) return;
    seenQ.add(clean);
    const isLatin = /[a-zA-Z]/.test(clean) && !/[а-яА-ЯёЁіІїЇєЄґҐ]/.test(clean);
    candidates.push({ query: clean, isLatin });
  };

  if (origTitle) {
    for (const p of origTitle.split("/")) addCandidate(p);
  }
  for (const p of title.split("/")) addCandidate(p);

  const expectedYear = year ? parseInt(year.slice(0, 4), 10) : NaN;
  const searchTypes: Array<"movie" | "tv"> = mediaType ? [mediaType] : ["movie", "tv"];
  let best: { score: number; id: number; mediaType: "movie" | "tv"; backdropUrl: string | null } | null = null;

  for (const cand of candidates) {
    for (const st of searchTypes) {
      for (const lang of ["uk-UA", "ru-RU"]) {
        try {
          const yearParam =
            !Number.isNaN(expectedYear)
              ? st === "movie"
                ? `&year=${expectedYear}`
                : `&first_air_date_year=${expectedYear}`
              : "";
          const res = await fetch(
            `https://api.themoviedb.org/3/search/${st}?api_key=4e44d9029b1270a757cddc766a1bcb63&query=${encodeURIComponent(cand.query)}&include_adult=false&language=${lang}${yearParam}`
          );
          if (!res.ok) continue;
          const data = (await res.json()) as {
            results?: Array<{
              id: number;
              backdrop_path?: string;
              original_language?: string;
              vote_count?: number;
              popularity?: number;
              release_date?: string;
              first_air_date?: string;
            }>;
          };

          for (const item of data.results || []) {
            if (!item.backdrop_path) continue;
            // Filter out non-Cyrillic hits when query was Cyrillic (unless no orig_title)
            const origLang = item.original_language || "";
            if (!cand.isLatin && origLang && !["ru", "uk", "be", "bg", "sr"].includes(origLang)) {
              // Keep only if no better latin candidate exists, with penalty
            }

            let score = (item.vote_count || 0) * 2 + (item.popularity || 0);
            if (mediaType && st === mediaType) score += 20000;
            if (!cand.isLatin && ["ru", "uk", "be"].includes(origLang)) score += 5000;

            if (!Number.isNaN(expectedYear)) {
              const rel = item.release_date || item.first_air_date || "";
              const iy = parseInt(rel.slice(0, 4), 10);
              if (!Number.isNaN(iy)) {
                const diff = Math.abs(iy - expectedYear);
                if (diff === 0) score += 100000;
                else if (diff === 1) score += 40000;
                else score -= 50000;
              }
            }

            const backdropUrl = `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`;
            if (!best || score > best.score) {
              best = { score, id: item.id, mediaType: st, backdropUrl };
            }
          }

          if (best && best.score >= (!Number.isNaN(expectedYear) ? 100000 : 100)) {
            return best;
          }
        } catch {}
      }
    }
  }

  return best;
}
