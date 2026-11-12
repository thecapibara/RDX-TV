/**
 * Standalone TypeScript HDRezka Scraper & #h Stream Decryptor for Samsung Tizen (.wgt).
 * Packaged Tizen apps with <access origin="*" subdomains="true"/> bypass browser CORS
 * and communicate directly with HDRezka mirrors from the TV without any PC bridge.
 */
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

async function solveAnubisChallenge(html: string, targetUrl: string): Promise<boolean> {
  if (!html.includes("anubis_challenge") && !html.includes("/.within.website/x/cmd/anubis/")) {
    return false;
  }
  const m = html.match(/id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return false;

  try {
    const payload = JSON.parse(m[1].trim()) as {
      rules?: { difficulty?: number };
      challenge?: { id?: string; randomData?: string; difficulty?: number };
    };
    const ch = payload.challenge;
    if (!ch?.id || !ch?.randomData) return false;

    const difficulty = payload.rules?.difficulty ?? ch.difficulty ?? 4;
    const prefix = "0".repeat(difficulty);
    const enc = new TextEncoder();
    const start = performance.now();
    let nonce = 0;
    let hashHex = "";

    while (nonce < 2_000_000) {
      const buf = await crypto.subtle.digest("SHA-256", enc.encode(`${ch.randomData}${nonce}`));
      const bytes = new Uint8Array(buf);
      hashHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      if (hashHex.startsWith(prefix)) break;
      nonce++;
    }

    const parsed = new URL(targetUrl);
    const redir = `${parsed.pathname || "/"}${parsed.search || ""}`;
    const elapsed = Math.round(performance.now() - start);
    const passUrl = `${parsed.origin}/.within.website/x/cmd/anubis/api/pass-challenge?id=${encodeURIComponent(ch.id)}&response=${hashHex}&nonce=${nonce}&redir=${encodeURIComponent(redir)}&elapsedTime=${elapsed}`;
    await fetch(passUrl, { method: "GET", credentials: "include" });
    return true;
  } catch {
    return false;
  }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const text = await res.text();
  if (await solveAnubisChallenge(text, url)) {
    const retry = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!retry.ok) throw new Error(`HTTP ${retry.status} on ${url}`);
    return retry.text();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return text;
}

export const tizenRezka = {
  checkMirrorStatus: async (mirrorUrl: string): Promise<MirrorStatus> => {
    const clean = mirrorUrl.replace(/\/+$/, "");
    const start = performance.now();
    try {
      const res = await fetch(clean, { method: "GET", credentials: "include" });
      const latency_ms = Math.round(performance.now() - start);
      const html = res.ok ? await res.text() : "";
      const hasCatalog = html.includes("b-content__inline_item");
      return {
        mirror_url: clean,
        online: res.ok,
        latency_ms,
        status_message: hasCatalog ? "OK • Пряме" : res.ok ? "Обмежено" : `HTTP ${res.status}`,
        doh_bypass: false,
        catalog_available: hasCatalog,
        stream_available: hasCatalog,
      };
    } catch {
      return {
        mirror_url: clean,
        online: false,
        latency_ms: 0,
        status_message: "Недоступно",
        doh_bypass: false,
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
      const html = await fetchHtml(`${clean}/films/${GENRE_PATH_MAP[genre]}/${p}${qs}`);
      return parseCatalogHtml(html, clean);
    }
    const p = page && page > 1 ? `/page/${page}/` : "/";
    const qs = params.toString() ? `?${params.toString()}` : "";
    const html = await fetchHtml(`${clean}${p}${qs}`);
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
    const genreSlug = genre && GENRE_PATH_MAP[genre] ? `${GENRE_PATH_MAP[genre]}/` : "";
    const pageSlug = page && page > 1 ? `page/${page}/` : "";
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : "";
    const html = await fetchHtml(`${clean}/${category}/${genreSlug}${pageSlug}${qs}`);
    return parseCatalogHtml(html, clean);
  },

  searchMedia: async (baseUrl: string, query: string): Promise<MediaCard[]> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const html = await fetchHtml(
      `${clean}/search/?do=search&subaction=search&q=${encodeURIComponent(query)}`
    );
    return parseCatalogHtml(html, clean);
  },

  searchAutocomplete: async (baseUrl: string, query: string): Promise<SearchItem[]> => {
    const clean = baseUrl.replace(/\/+$/, "");
    const body = new URLSearchParams({ q: query });
    const res = await fetch(`${clean}/engine/ajax/search.php`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return [];
    const html = await res.text();
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
    const html = await fetchHtml(fullUrl);
    const doc = new DOMParser().parseFromString(html, "text/html");

    const id =
      doc.querySelector("#post_id")?.getAttribute("value") ||
      html.match(/initCDN(?:Movies|Series)Events\(\s*(\d+)/)?.[1] ||
      fullUrl.match(/\/(\d+)-/)?.[1] ||
      "0";

    const title = doc.querySelector('h1[itemprop="name"]')?.textContent?.trim() || "Без назви";
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
    ).map((el) => {
      const name = el.getAttribute("title") || el.textContent?.trim() || "Озвучка";
      const flag = el.querySelector("img")?.getAttribute("alt") || "";
      return {
        id: el.getAttribute("data-translator_id") || "0",
        name,
        language: flag || (/укр/i.test(name) ? "Українська" : ""),
        is_active: el.classList.contains("active"),
      };
    });

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
      params.set("action", "get_movie");
    }

    const res = await fetch(`${clean}/ajax/get_cdn_series/?t=${Date.now()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Stream AJAX HTTP ${res.status}`);
    const data = (await res.json()) as {
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
    const res = await fetch(`${clean}/ajax/get_cdn_series/?t=${Date.now()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Episodes AJAX HTTP ${res.status}`);
    const data = (await res.json()) as {
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
    const candidates: string[] = [];
    if (origTitle) {
      for (const p of origTitle.split("/").map((s) => s.trim()).filter(Boolean)) {
        if (!candidates.includes(p)) candidates.push(p);
      }
    }
    for (const p of title.split("/").map((s) => s.trim()).filter(Boolean)) {
      const clean = p.replace("(все сезоны)", "").replace("(сериал)", "").trim();
      if (clean && !candidates.includes(clean)) candidates.push(clean);
    }

    const expectedYear = year ? parseInt(year.slice(0, 4), 10) : NaN;
    let best: { score: number; url: string } | null = null;

    for (const q of candidates) {
      try {
        const res = await fetch(
          `https://api.themoviedb.org/3/search/multi?api_key=4e44d9029b1270a757cddc766a1bcb63&query=${encodeURIComponent(q)}&include_adult=false&language=uk-UA`
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          results?: Array<{
            backdrop_path?: string;
            media_type?: string;
            vote_count?: number;
            popularity?: number;
            release_date?: string;
            first_air_date?: string;
          }>;
        };

        for (const item of data.results || []) {
          if (!item.backdrop_path) continue;
          const itemType = item.media_type || "";
          if (mediaType && (itemType === "movie" || itemType === "tv") && itemType !== mediaType) {
            continue;
          }
          if (!mediaType && itemType === "person") continue;

          let score = (item.vote_count || 0) * 2 + (item.popularity || 0);
          if (mediaType && itemType === mediaType) score += 20000;

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

          const url = `https://image.tmdb.org/t/p/original${item.backdrop_path}`;
          if (!best || score > best.score) best = { score, url };
        }

        if (best && best.score >= (!Number.isNaN(expectedYear) ? 100000 : 100)) break;
      } catch {}
    }

    return best?.url || null;
  },
};
