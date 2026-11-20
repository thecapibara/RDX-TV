import { invoke } from "@tauri-apps/api/core";
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

const isTauri =
  typeof window !== "undefined" &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

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
    let list: EpisodeProgress[] = raw ? JSON.parse(raw) : [];
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

// ==================== UNIFIED API ====================

export const api = {
  // Settings & Storage
  getSettings: async (): Promise<AppSettings> => {
    if (isTauri) return invoke<AppSettings>("get_settings");
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
    if (isTauri) return invoke<void>("update_settings", { settings });
    localStorage.setItem("rdx_settings", JSON.stringify(settings));
  },

  // Watch Progress
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

    if (isTauri) return invoke<void>("save_watch_progress", { progress });
    const items = getStoredProgress().filter((p) => p.media_id !== progress.media_id);
    items.unshift(progress);
    saveStoredProgress(items.slice(0, 50));
  },

  getWatchProgress: async (mediaId: string): Promise<WatchProgress | null> => {
    if (isTauri) return invoke<WatchProgress | null>("get_watch_progress", { mediaId });
    return getStoredProgress().find((p) => p.media_id === mediaId) || null;
  },

  getContinueWatching: async (limit = 20): Promise<WatchProgress[]> => {
    if (isTauri) return invoke<WatchProgress[]>("get_continue_watching", { limit });
    return getStoredProgress().slice(0, limit);
  },

  deleteWatchProgress: async (mediaId: string): Promise<boolean> => {
    try {
      localStorage.removeItem(`rdx_episode_progress_${mediaId}`);
    } catch {}
    if (isTauri) return invoke<boolean>("delete_watch_progress", { mediaId });
    const items = getStoredProgress().filter((p) => p.media_id !== mediaId);
    saveStoredProgress(items);
    return true;
  },

  getEpisodeProgress: async (mediaId: string): Promise<EpisodeProgress[]> => {
    if (isTauri) return invoke<EpisodeProgress[]>("get_episode_progress", { mediaId });
    try {
      const raw = localStorage.getItem(`rdx_episode_progress_${mediaId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}

    if (mediaId === "54231") {
      const mockList: EpisodeProgress[] = [
        {
          media_id: "54231",
          season: 1,
          episode: 1,
          position_sec: 600,
          duration_sec: 634,
          updated_at: Math.floor(Date.now() / 1000) - 10000,
        },
        {
          media_id: "54231",
          season: 1,
          episode: 2,
          position_sec: 610,
          duration_sec: 634,
          updated_at: Math.floor(Date.now() / 1000) - 8000,
        },
        {
          media_id: "54231",
          season: 1,
          episode: 3,
          position_sec: 95,
          duration_sec: 634,
          updated_at: Math.floor(Date.now() / 1000) - 7200,
        },
      ];
      try {
        localStorage.setItem(`rdx_episode_progress_${mediaId}`, JSON.stringify(mockList));
      } catch {}
      return mockList;
    }
    return [];
  },

  // Bookmarks
  toggleBookmark: async (bookmark: Bookmark): Promise<boolean> => {
    if (isTauri) return invoke<boolean>("toggle_bookmark", { bookmark });
    const items = getStoredBookmarks();
    const index = items.findIndex((b) => b.media_id === bookmark.media_id);
    if (index >= 0) {
      items.splice(index, 1);
      saveStoredBookmarks(items);
      return false;
    } else {
      items.unshift(bookmark);
      saveStoredBookmarks(items);
      return true;
    }
  },

  getBookmarks: async (category?: string): Promise<Bookmark[]> => {
    if (isTauri) return invoke<Bookmark[]>("get_bookmarks", { category });
    const items = getStoredBookmarks();
    if (!category || category === "all") return items;
    return items.filter((b) => b.category === category);
  },

  isBookmarked: async (mediaId: string): Promise<string | null> => {
    if (isTauri) return invoke<string | null>("is_bookmarked", { mediaId });
    const found = getStoredBookmarks().find((b) => b.media_id === mediaId);
    return found ? found.category : null;
  },

  checkPendingBookmarkReleases: async (): Promise<Bookmark[]> => {
    if (isTauri) return invoke<Bookmark[]>("check_pending_bookmark_releases");
    return [];
  },

  // Mirror Management
  checkMirrorStatus: async (mirrorUrl: string): Promise<MirrorStatus> => {
    if (isTauri) return invoke<MirrorStatus>("check_mirror_status", { mirrorUrl });
    return tizenRezka.checkMirrorStatus(mirrorUrl);
  },

  checkAllMirrors: async (mirrorUrls: string[]): Promise<MirrorStatus[]> => {
    if (isTauri) return invoke<MirrorStatus[]>("check_all_mirrors", { mirrorUrls });
    return mapWithConcurrency(mirrorUrls, 3, (url) => tizenRezka.checkMirrorStatus(url));
  },

  smartSelectMirror: async (forceRotate = false): Promise<SmartRotationResult> => {
    if (isTauri) return invoke<SmartRotationResult>("smart_select_mirror", { forceRotate });
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
    if (isTauri) return invoke<string>("get_active_mirror");
    const s = await api.getSettings();
    return s.active_mirror;
  },

  setActiveMirror: async (mirrorUrl: string): Promise<void> => {
    if (isTauri) return invoke<void>("set_active_mirror", { mirrorUrl });
    const s = await api.getSettings();
    s.active_mirror = mirrorUrl;
    await api.updateSettings(s);
  },

  openCaptchaWindow: async (mirrorUrl?: string): Promise<void> => {
    if (isTauri) return invoke<void>("open_captcha_window", { mirrorUrl });
    window.open(mirrorUrl || "https://rezka-tv.org", "_blank");
  },

  // Catalog & Search
  getHomeCatalog: async (filter?: string, genre?: string, page?: number): Promise<MediaCard[]> => {
    if (isTauri) return invoke<MediaCard[]>("get_home_catalog", { filter, genre, page });
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka.getHomeCatalog(mirror, filter, genre, page);
    } catch (e) {
      console.warn("[Tizen] getHomeCatalog direct fetch failed:", e);
      return [];
    }
  },

  getCategoryCatalog: async (
    category: string,
    genre?: string,
    filter?: string,
    page?: number
  ): Promise<MediaCard[]> => {
    const args = {
      category,
      genre: genre || undefined,
      filter: filter || undefined,
      page,
    };
    if (isTauri) return invoke<MediaCard[]>("get_category_catalog", args);
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getCategoryCatalog(mirror, category, genre, filter, page);
  },

  searchMedia: async (query: string): Promise<MediaCard[]> => {
    if (isTauri) return invoke<MediaCard[]>("search_media", { query });
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka.searchMedia(mirror, query);
    } catch (e) {
      console.warn("[Tizen] searchMedia direct fetch failed:", e);
      return [];
    }
  },

  searchAutocomplete: async (query: string): Promise<SearchItem[]> => {
    if (isTauri) return invoke<SearchItem[]>("search_autocomplete", { query });
    try {
      const mirror = await api.getActiveMirror();
      return await tizenRezka.searchAutocomplete(mirror, query);
    } catch {
      return [];
    }
  },

  // Media Details & Streaming
  getMediaDetails: async (itemUrl: string): Promise<MediaDetails> => {
    if (isTauri) return invoke<MediaDetails>("get_media_details", { itemUrl });
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getMediaDetails(mirror, itemUrl);
  },

  getStream: async (
    mediaId: string,
    refererUrl: string,
    isSeries: boolean,
    translatorId?: string,
    season?: number,
    episode?: number
  ): Promise<StreamData> => {
    const args = {
      mediaId,
      translatorId,
      season,
      episode,
      isSeries,
      refererUrl,
    };
    if (isTauri) return invoke<StreamData>("get_stream", args);
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getStream(mirror, mediaId, isSeries, translatorId, season, episode);
  },

  getEpisodes: async (
    mediaId: string,
    translatorId: string,
    refererUrl: string
  ): Promise<EpisodesData> => {
    const args = { mediaId, translatorId, refererUrl };
    if (isTauri) return invoke<EpisodesData>("get_episodes", args);
    const mirror = await api.getActiveMirror();
    return await tizenRezka.getEpisodes(mirror, mediaId, translatorId);
  },

  // Window & Player Helpers
  setFullscreenMode: async (enabled: boolean): Promise<boolean> => {
    if (isTauri) return invoke<boolean>("set_fullscreen_mode", { enabled });
    return enabled;
  },

  startDragWindow: async (): Promise<void> => {
    if (isTauri) return invoke<void>("start_drag_window");
  },

  openUrl: async (url: string): Promise<void> => {
    if (isTauri) {
      try {
        await invoke<void>("open_url", { url });
        return;
      } catch (err) {
        console.warn("Native open_url failed, falling back to window.open:", err);
      }
    }
    window.open(url, "_blank");
  },

  getTurboStreamUrl: async (rawUrl: string): Promise<string> => {
    if (isTauri) {
      return invoke<string>("get_turbo_stream_url", { rawUrl });
    }
    return rawUrl;
  },

  getTurboStats: async (): Promise<any> => {
    if (isTauri) {
      return invoke<any>("get_turbo_stats");
    }
    return { enabled: false, port: 0, buffered_mb: 0, total_prefetched_mb: 0, active_workers: 0, cdn_mode: "Off" };
  },

  selectFastestCdn: async (streamUrl: string): Promise<[string, number]> => {
    if (isTauri) {
      return invoke<[string, number]>("select_fastest_cdn", { streamUrl });
    }
    return ["auto", 0];
  },

  getBackdrop: async (
    title: string,
    origTitle?: string,
    year?: string,
    mediaType?: "movie" | "tv"
  ): Promise<string | null> => {
    if (isTauri) {
      try {
        return await invoke<string | null>("get_backdrop", {
          title,
          origTitle,
          year,
          mediaType,
        });
      } catch (e) {
        console.warn("[TMDB] Failed to get backdrop:", e);
        return null;
      }
    }
    return tizenRezka.getBackdrop(title, origTitle, year, mediaType).catch(() => null);
  },

  getTmdbRecommendations: async (
    title: string,
    origTitle?: string,
    year?: string,
    mediaType?: "movie" | "tv",
    excludeId?: string
  ): Promise<MediaCard[]> => {
    if (isTauri) {
      try {
        return await invoke<MediaCard[]>("get_tmdb_recommendations", {
          title,
          origTitle,
          year,
          mediaType,
          excludeId,
        });
      } catch (e) {
        console.warn("[TMDB] Failed to get recommendations:", e);
        return [];
      }
    }
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
    if (isTauri) {
      try {
        return await invoke<string>("get_system_time");
      } catch {
        // Fall back to JS clock if invocation fails
      }
    }
    const now = new Date();
    return now.toLocaleTimeString("uk-UA", {
      hour: "2-digit",
      minute: "2-digit",
    });
  },

  playUiSound: (soundType: "hover" | "modal_open" | "button_click") => {
    if (isTauri) {
      invoke("play_ui_sound", { soundType }).catch(() => {});
    }
  },
};
