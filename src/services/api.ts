import { tizenRezka } from "./tizenRezka";
import type {
  AppSettings,
  Bookmark,
  EpisodeProgress,
  EpisodesData,
  MediaCard,
  MediaDetails,
  MirrorStatus,
  SearchItem,
  SmartRotationResult,
  StreamData,
  WatchProgress,
} from "../types";

const PRESET_MIRRORS = [
  "https://rezka-tv.org",
  "https://hdrezka.me",
  "https://hdrezka.kim",
  "https://rezka.pub",
  "https://rezka.ag",
  "https://hdrezka.sh",
  "https://rezkify.com",
  "https://rezka-ua.org",
  "https://rezka-ua.tv",
  "https://hdrezka.club",
];

function getStoredProgress(): WatchProgress[] {
  try {
    const raw = localStorage.getItem("rdx_watch_progress");
    if (raw) {
      const parsed = JSON.parse(raw) as WatchProgress[];
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => Boolean(p?.title) && p.title !== "Без назви");
      }
    }
  } catch {}
  return [];
}

function saveStoredProgress(items: WatchProgress[]) {
  try {
    localStorage.setItem("rdx_watch_progress", JSON.stringify(items));
  } catch {}
}

function getStoredBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem("rdx_bookmarks");
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveStoredBookmarks(items: Bookmark[]) {
  try {
    localStorage.setItem("rdx_bookmarks", JSON.stringify(items));
  } catch {}
}

function upsertStoredEpisodeProgress(mediaId: string, item: EpisodeProgress) {
  try {
    const key = `rdx_episode_progress_${mediaId}`;
    const raw = localStorage.getItem(key);
    const list: EpisodeProgress[] = raw ? JSON.parse(raw) : [];
    const idx = list.findIndex((p) => p.season === item.season && p.episode === item.episode);
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.push(item);
    }
    list.sort((a, b) => (a.season === b.season ? a.episode - b.episode : a.season - b.season));
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ==================== UNIFIED PLATFORM API (ZERO TAURI, ZERO CLOUDFLARE) ====================

export const api = {
  getSettings: async (): Promise<AppSettings> => {
    try {
      const raw = localStorage.getItem("rdx_settings");
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      active_mirror: "https://rezka-tv.org",
      custom_mirrors: ["https://hdrezka.me", "https://rezka.ag"],
      proxy_url: "",
      preferred_quality: "720p",
      preferred_translator: "Українська",
      autoplay_next: true,
    };
  },

  updateSettings: async (settings: AppSettings): Promise<void> => {
    localStorage.setItem("rdx_settings", JSON.stringify(settings));
  },

  saveWatchProgress: async (progress: WatchProgress): Promise<void> => {
    if (progress.season != null && progress.episode != null) {
      upsertStoredEpisodeProgress(progress.media_id, {
        media_id: progress.media_id,
        season: progress.season,
        episode: progress.episode,
        position_sec: progress.position_sec,
        duration_sec: progress.duration_sec,
        updated_at: progress.updated_at,
      });
    }
    const items = getStoredProgress().filter((p) => p.media_id !== progress.media_id);
    items.unshift(progress);
    saveStoredProgress(items.slice(0, 50));
  },

  getWatchProgress: async (mediaId: string): Promise<WatchProgress | null> => {
    return getStoredProgress().find((p) => p.media_id === mediaId) || null;
  },

  getContinueWatching: async (limit = 20): Promise<WatchProgress[]> => {
    return getStoredProgress().slice(0, limit);
  },

  deleteWatchProgress: async (mediaId: string): Promise<boolean> => {
    try {
      localStorage.removeItem(`rdx_episode_progress_${mediaId}`);
    } catch {}
    const items = getStoredProgress().filter((p) => p.media_id !== mediaId);
    saveStoredProgress(items);
    return true;
  },

  getEpisodeProgress: async (mediaId: string): Promise<EpisodeProgress[]> => {
    try {
      const raw = localStorage.getItem(`rdx_episode_progress_${mediaId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  },

  toggleBookmark: async (bookmark: Bookmark): Promise<boolean> => {
    const items = getStoredBookmarks();
    const index = items.findIndex((b) => b.media_id === bookmark.media_id);
    if (index >= 0) {
      items.splice(index, 1);
      saveStoredBookmarks(items);
      return false;
    }
    items.unshift(bookmark);
    saveStoredBookmarks(items);
    return true;
  },

  getBookmarks: async (category?: string): Promise<Bookmark[]> => {
    const items = getStoredBookmarks();
    if (!category || category === "all") return items;
    return items.filter((b) => b.category === category);
  },

  isBookmarked: async (mediaId: string): Promise<string | null> => {
    const found = getStoredBookmarks().find((b) => b.media_id === mediaId);
    return found ? found.category : null;
  },

  checkPendingBookmarkReleases: async (): Promise<Bookmark[]> => {
    return [];
  },

  checkMirrorStatus: async (mirrorUrl: string): Promise<MirrorStatus> => {
    return tizenRezka.checkMirrorStatus(mirrorUrl);
  },

  checkAllMirrors: async (mirrorUrls: string[]): Promise<MirrorStatus[]> => {
    return mapWithConcurrency(mirrorUrls, 3, (url) => tizenRezka.checkMirrorStatus(url));
  },

  smartSelectMirror: async (forceRotate = false): Promise<SmartRotationResult> => {
    const s = await api.getSettings();
    const candidates = Array.from(
      new Set([s.active_mirror, ...PRESET_MIRRORS, ...s.custom_mirrors].filter(Boolean))
    );
    const statuses = await mapWithConcurrency(candidates, 3, (u) =>
      tizenRezka.checkMirrorStatus(u)
    );
    const working = statuses
      .filter((st) => st.online && st.catalog_available)
      .sort((a, b) => a.latency_ms - b.latency_ms);
    const best =
      (forceRotate && working.length > 1
        ? working.find((st) => st.mirror_url !== s.active_mirror)
        : undefined) ||
      working[0] ||
      statuses.find((st) => st.online) ||
      statuses[0];
    const selected_mirror = best?.mirror_url || s.active_mirror;
    const switched = selected_mirror !== s.active_mirror;
    if (switched) await api.setActiveMirror(selected_mirror);
    return { selected_mirror, switched, statuses };
  },

  getActiveMirror: async (): Promise<string> => {
    const s = await api.getSettings();
    return s.active_mirror;
  },

  setActiveMirror: async (mirrorUrl: string): Promise<void> => {
    const s = await api.getSettings();
    s.active_mirror = mirrorUrl;
    await api.updateSettings(s);
  },

  openCaptchaWindow: async (mirrorUrl?: string): Promise<void> => {
    window.open(mirrorUrl || "https://rezka-tv.org", "_blank");
  },

  getHomeCatalog: async (filter?: string, genre?: string, page?: number): Promise<MediaCard[]> => {
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka.getHomeCatalog(mirror, filter, genre, page);
    } catch (e) {
      console.warn("[RDX] getHomeCatalog failed:", e);
      return [];
    }
  },

  getCategoryCatalog: async (
    category: string,
    genre?: string,
    filter?: string,
    page?: number
  ): Promise<MediaCard[]> => {
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getCategoryCatalog(mirror, category, genre, filter, page);
  },

  searchMedia: async (query: string): Promise<MediaCard[]> => {
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka.searchMedia(mirror, query);
    } catch (e) {
      console.warn("[RDX] searchMedia failed:", e);
      return [];
    }
  },

  searchAutocomplete: async (query: string): Promise<SearchItem[]> => {
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka.searchAutocomplete(mirror, query);
    } catch {
      return [];
    }
  },

  getMediaDetails: async (itemUrl: string): Promise<MediaDetails> => {
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getMediaDetails(mirror, itemUrl);
  },

  getStream: async (
    mediaId: string,
    _refererUrl: string,
    isSeries: boolean,
    translatorId?: string,
    season?: number,
    episode?: number
  ): Promise<StreamData> => {
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getStream(mirror, mediaId, isSeries, translatorId, season, episode);
  },

  getEpisodes: async (
    mediaId: string,
    translatorId: string,
    _refererUrl: string
  ): Promise<EpisodesData> => {
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getEpisodes(mirror, mediaId, translatorId);
  },

  setFullscreenMode: async (enabled: boolean): Promise<boolean> => enabled,
  startDragWindow: async (): Promise<void> => {},
  openUrl: async (url: string): Promise<void> => {
    window.open(url, "_blank");
  },

  getTurboStreamUrl: async (rawUrl: string): Promise<string> => rawUrl,
  getTurboStats: async () => ({
    enabled: false,
    port: 0,
    buffered_mb: 0,
    total_prefetched_mb: 0,
    active_workers: 0,
    cdn_mode: "Native",
  }),
  selectFastestCdn: async (_streamUrl: string): Promise<[string, number]> => ["auto", 0],

  getBackdrop: async (
    title: string,
    origTitle?: string,
    year?: string,
    mediaType?: "movie" | "tv"
  ): Promise<string | null> => {
    return tizenRezka.getBackdrop(title, origTitle, year, mediaType).catch(() => null);
  },

  getTmdbRecommendations: async (
    title: string,
    origTitle?: string,
    year?: string,
    mediaType?: "movie" | "tv",
    excludeId?: string
  ): Promise<MediaCard[]> => {
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka
        .getTmdbRecommendations(mirror, title, origTitle, year, mediaType, excludeId)
        .catch(() => []);
    } catch {
      return [];
    }
  },

  getSystemTime: async (): Promise<string> => {
    return new Date().toLocaleTimeString("uk-UA", {
      hour: "2-digit",
      minute: "2-digit",
    });
  },
};
