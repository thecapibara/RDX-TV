import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Play,
  Pause,
  Rewind,
  FastForward,
  X,
  Settings,
  Subtitles,
  SkipForward,
  SkipBack,
  ListVideo,
  Gauge,
  Check,
  Loader2,
  Timer,
  Crown,
  Volume2,
  VolumeX,
  Maximize,
  Info,
} from "lucide-react";
import { UaFlag } from "./UaFlag";
import type {
  MediaDetails,
  StreamData,
  StreamQuality,
  WatchProgress,
  SeasonTab,
  EpisodeTab,
} from "../types";
import { api } from "../services/api";
import { platform, type AspectMode, type PlayerAdapter } from "../platform";
import { cn } from "../lib/utils";
import { playBackSound, playButtonClickSound } from "../services/sound";

export type PlayerMode = "full" | "docked" | "os_pip";

interface VideoPlayerProps {
  details: MediaDetails;
  initialStreams: StreamData | null;
  activeTranslatorId?: string;
  activeSeason?: number;
  activeEpisode?: number;
  initialPositionSec?: number;
  mode: PlayerMode;
  onModeChange: (mode: PlayerMode) => void;
  onClose: () => void;
  onEpisodeChange?: (season: number, episode: number) => void;
  onTranslatorChange?: (translatorId: string) => void;
}

type DrawerKind = null | "quality" | "translator" | "episodes" | "subtitles" | "speed" | "sleep";
type SubSize = "sm" | "md" | "lg";

const ASPECT_LABELS: Record<AspectMode, string> = {
  fit: "Авто",
  fill: "Заповнити",
  stretch: "16:9",
};

function isPremiumQuality(label?: string | null): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return (
    l.includes("ultra") ||
    l.includes("2k") ||
    l.includes("4k") ||
    l.includes("prem") ||
    l.includes("2160") ||
    l.includes("1440")
  );
}

function formatTime(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function pickInitialQuality(qualities: StreamQuality[], defaultQuality?: string): StreamQuality | null {
  if (!qualities.length) return null;
  let saved = "";
  try {
    saved = localStorage.getItem("rdx_preferred_quality") || "";
  } catch {}
  const target = saved || defaultQuality || "720p";
  return (
    qualities.find((q) => q.label.toLowerCase() === target.toLowerCase()) ||
    qualities.find((q) => q.label.includes("720")) ||
    qualities[qualities.length - 1]
  );
}

const ENGINE_LABELS: Record<PlayerAdapter["kind"], string> = {
  "android-exo": "ExoPlayer",
  "tizen-avplay": "AVPlay",
  "webos-native": "webOS Native",
  "html5-hls": "HLS",
};

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  details,
  initialStreams,
  activeTranslatorId,
  activeSeason,
  activeEpisode,
  initialPositionSec = 0,
  onClose,
  onEpisodeChange,
  onTranslatorChange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const adapterRef = useRef<PlayerAdapter | null>(null);
  const osdTimerRef = useRef<number | null>(null);
  const streamReqIdRef = useRef(0);
  const lastSavedSecRef = useRef(0);
  const currentTimeRef = useRef(initialPositionSec);
  const durationRef = useRef(0);

  const isSeries = useMemo(
    () => details.seasons.length > 0 || details.episodes.length > 0 || Boolean(activeSeason),
    [details.seasons.length, details.episodes.length, activeSeason]
  );

  const [translatorId, setTranslatorId] = useState<string>(
    activeTranslatorId ||
      details.translators.find((t) => t.is_active)?.id ||
      details.translators[0]?.id ||
      ""
  );
  const [seasons, setSeasons] = useState<SeasonTab[]>(details.seasons);
  const [episodes, setEpisodes] = useState<EpisodeTab[]>(details.episodes);
  const [season, setSeason] = useState<number>(
    activeSeason || parseInt(details.seasons[0]?.id || "1", 10) || 1
  );
  const [episode, setEpisode] = useState<number>(
    activeEpisode || parseInt(details.episodes[0]?.episode_id || "1", 10) || 1
  );

  const htmlActiveTranslatorId = useMemo(
    () => details.translators.find((t) => t.is_active)?.id,
    [details.translators]
  );

  const [streamData, setStreamData] = useState<StreamData | null>(() =>
    !translatorId || (htmlActiveTranslatorId && translatorId === htmlActiveTranslatorId)
      ? initialStreams
      : null
  );
  const [selectedQuality, setSelectedQuality] = useState<StreamQuality | null>(() => {
    const matchesDefault =
      !translatorId || (htmlActiveTranslatorId && translatorId === htmlActiveTranslatorId);
    return matchesDefault && initialStreams
      ? pickInitialQuality(initialStreams.qualities, initialStreams.default_quality)
      : null;
  });
  const [selectedSubUrl, setSelectedSubUrl] = useState<string>("");

  const [playState, setPlayState] = useState<"loading" | "playing" | "paused" | "buffering" | "ended">("loading");
  const [currentTime, setCurrentTime] = useState<number>(initialPositionSec);
  const [duration, setDuration] = useState<number>(0);
  const [bufferedTime, setBufferedTime] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [muted, setMuted] = useState<boolean>(false);
  const [resolution, setResolution] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [osdVisible, setOsdVisible] = useState<boolean>(true);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [hudNotice, setHudNotice] = useState<string | null>(
    initialPositionSec > 5 ? `Відновлено з ${formatTime(initialPositionSec)}` : null
  );
  const [sleepMinutes, setSleepMinutes] = useState<number>(0);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [engineKind, setEngineKind] = useState<PlayerAdapter["kind"]>("html5-hls");
  const [isExternalSurface, setIsExternalSurface] = useState<boolean>(false);
  const [aspectMode, setAspectMode] = useState<AspectMode>("fit");
  const [audioBoost, setAudioBoost] = useState<number>(100);
  const [showStats, setShowStats] = useState<boolean>(false);
  const [subSize, setSubSize] = useState<SubSize>(() => {
    try {
      const s = localStorage.getItem("rdx_sub_size");
      if (s === "sm" || s === "md" || s === "lg") return s;
    } catch {}
    return "md";
  });

  const activeTranslator = useMemo(
    () => details.translators.find((t) => t.id === translatorId) || details.translators[0],
    [details.translators, translatorId]
  );

  const sortedTranslators = useMemo(() => {
    return [...details.translators].sort((a, b) => {
      const aUa = /укр/i.test(`${a.language || ""} ${a.name}`) ? 1 : 0;
      const bUa = /укр/i.test(`${b.language || ""} ${b.name}`) ? 1 : 0;
      return bUa - aUa;
    });
  }, [details.translators]);

  const currentSeasonEpisodes = useMemo(
    () => episodes.filter((e) => parseInt(e.season_id, 10) === season),
    [episodes, season]
  );

  const nextEpisodeInfo = useMemo(() => {
    if (!isSeries || episodes.length === 0) return null;
    const idx = episodes.findIndex(
      (e) => parseInt(e.season_id, 10) === season && parseInt(e.episode_id, 10) === episode
    );
    if (idx >= 0 && idx + 1 < episodes.length) {
      const next = episodes[idx + 1];
      const nextS = parseInt(next.season_id, 10) || season;
      const nextE = parseInt(next.episode_id, 10) || episode + 1;
      return { season: nextS, episode: nextE, isNewSeason: nextS !== season };
    }
    return null;
  }, [isSeries, episodes, season, episode]);

  const prevEpisodeInfo = useMemo(() => {
    if (!isSeries || episodes.length === 0) return null;
    const idx = episodes.findIndex(
      (e) => parseInt(e.season_id, 10) === season && parseInt(e.episode_id, 10) === episode
    );
    if (idx > 0) {
      const prev = episodes[idx - 1];
      return {
        season: parseInt(prev.season_id, 10) || season,
        episode: parseInt(prev.episode_id, 10) || 1,
      };
    }
    return null;
  }, [isSeries, episodes, season, episode]);

  const showNotice = useCallback((text: string) => {
    setHudNotice(text);
    window.setTimeout(() => {
      setHudNotice((prev) => (prev === text ? null : prev));
    }, 2400);
  }, []);

  const revealOsd = useCallback(() => {
    setOsdVisible(true);
    if (osdTimerRef.current) window.clearTimeout(osdTimerRef.current);
    osdTimerRef.current = window.setTimeout(() => {
      setDrawer((d) => {
        if (!d) setOsdVisible(false);
        return d;
      });
    }, 4500);
  }, []);

  const saveProgressNow = useCallback(() => {
    const pos = Math.floor(currentTimeRef.current);
    const dur = Math.floor(durationRef.current);
    if (pos < 3 || dur <= 0) return;
    lastSavedSecRef.current = pos;
    const progress: WatchProgress = {
      media_id: details.id,
      media_url: details.url,
      title: details.title,
      orig_title: details.orig_title,
      poster_url: details.poster,
      media_type: isSeries ? "series" : "movie",
      translator_id: translatorId || null,
      translator_name: activeTranslator?.name || null,
      season: isSeries ? season : null,
      episode: isSeries ? episode : null,
      position_sec: pos,
      duration_sec: dur,
      updated_at: Math.floor(Date.now() / 1000),
    };
    api.saveWatchProgress(progress).catch(() => {});
  }, [details, isSeries, translatorId, activeTranslator?.name, season, episode]);

  // Create platform player adapter on mount
  useEffect(() => {
    const adapter = platform.createPlayer();
    adapterRef.current = adapter;
    setEngineKind(adapter.kind);
    setIsExternalSurface(adapter.isExternalSurface);
    adapter.attachVideoElement?.(videoRef.current);

    return () => {
      saveProgressNow();
      adapter.destroy();
      adapterRef.current = null;
      if (osdTimerRef.current) window.clearTimeout(osdTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch stream when translator / season / episode changes
  useEffect(() => {
    const reqId = ++streamReqIdRef.current;
    // `initialStreams` embedded in HDRezka HTML always belongs to the HTML's `.active` translator
    const htmlActiveTranslatorId = details.translators.find((t) => t.is_active)?.id;
    const isHtmlDefaultTranslator =
      !translatorId || (Boolean(htmlActiveTranslatorId) && translatorId === htmlActiveTranslatorId);
    const isHtmlDefaultEpisode =
      !isSeries ||
      (season === (parseInt(details.seasons[0]?.id || "1", 10) || 1) &&
        episode === (parseInt(details.episodes[0]?.episode_id || "1", 10) || 1));

    const shouldUseInitial =
      reqId === 1 &&
      initialStreams &&
      initialStreams.qualities.length > 0 &&
      isHtmlDefaultTranslator &&
      isHtmlDefaultEpisode;

    if (shouldUseInitial) {
      setStreamData(initialStreams);
      setSelectedQuality(pickInitialQuality(initialStreams.qualities, initialStreams.default_quality));
      return;
    }

    setPlayState("loading");
    setErrorMsg(null);
    api
      .getStream(details.id, details.url, isSeries, translatorId || undefined, season, episode)
      .then((data) => {
        if (streamReqIdRef.current !== reqId) return;
        setStreamData(data);
        setSelectedQuality(pickInitialQuality(data.qualities, data.default_quality));
      })
      .catch((err) => {
        if (streamReqIdRef.current !== reqId) return;
        setErrorMsg(err instanceof Error ? err.message : "Не вдалося отримати потік");
        setPlayState("paused");
      });
  }, [details.id, details.url, details.translators, details.seasons, details.episodes, isSeries, translatorId, season, episode, initialStreams]);

  // Load selected stream URL into PlayerAdapter
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !selectedQuality) return;
    const primaryUrl = selectedQuality.hls_url || selectedQuality.mp4_url;
    if (!primaryUrl) return;

    setErrorMsg(null);
    setNextCountdown(null);
    adapter.attachVideoElement?.(videoRef.current);

    const startAt = currentTimeRef.current > 2 ? currentTimeRef.current : initialPositionSec;

    adapter.load(
      {
        url: primaryUrl,
        fallbackUrl: selectedQuality.hls_url ? selectedQuality.mp4_url : null,
        title: details.title,
        subtitleText: isSeries ? `S${season}E${episode}` : undefined,
        startSec: startAt,
        subtitles: streamData?.subtitles || [],
      },
      {
        onReady: (dur) => {
          if (dur > 0) {
            durationRef.current = dur;
            setDuration(dur);
          }
          adapter.setPlaybackRate(playbackSpeed);
        },
        onTimeUpdate: (cur, dur, buf) => {
          currentTimeRef.current = cur;
          setCurrentTime(cur);
          if (dur > 0) {
            durationRef.current = dur;
            setDuration(dur);
          }
          setBufferedTime(buf);
          if (Math.abs(cur - lastSavedSecRef.current) >= 5) {
            saveProgressNow();
          }
        },
        onStateChange: (st) => {
          setPlayState(st);
          if (st === "paused") saveProgressNow();
          if (st === "ended") {
            saveProgressNow();
            if (nextEpisodeInfo) {
              setNextCountdown(15);
            }
          }
        },
        onResolution: (w, h) => {
          if (w && h) setResolution(`${w}×${h}`);
        },
        onError: (msg) => {
          setErrorMsg(msg);
          setPlayState("paused");
        },
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedQuality]);

  // Next episode countdown timer
  useEffect(() => {
    if (nextCountdown === null) return;
    if (nextCountdown <= 0 && nextEpisodeInfo) {
      setNextCountdown(null);
      currentTimeRef.current = 0;
      setCurrentTime(0);
      setSeason(nextEpisodeInfo.season);
      setEpisode(nextEpisodeInfo.episode);
      onEpisodeChange?.(nextEpisodeInfo.season, nextEpisodeInfo.episode);
      return;
    }
    const t = window.setTimeout(() => setNextCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => window.clearTimeout(t);
  }, [nextCountdown, nextEpisodeInfo, onEpisodeChange]);

  // Sleep timer
  useEffect(() => {
    if (sleepMinutes <= 0) return;
    const t = window.setTimeout(() => {
      adapterRef.current?.pause();
      saveProgressNow();
      onClose();
    }, sleepMinutes * 60_000);
    return () => window.clearTimeout(t);
  }, [sleepMinutes, saveProgressNow, onClose]);

  const togglePlay = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    if (playState === "playing") {
      adapter.pause();
      setPlayState("paused");
    } else {
      adapter.play();
      setPlayState("playing");
    }
    revealOsd();
  }, [playState, revealOsd]);

  const seekBy = useCallback(
    (delta: number) => {
      const target = Math.max(0, Math.min(durationRef.current || Infinity, currentTimeRef.current + delta));
      currentTimeRef.current = target;
      setCurrentTime(target);
      adapterRef.current?.seek(target);
      showNotice(`${delta > 0 ? "+" : ""}${delta} с`);
      revealOsd();
    },
    [showNotice, revealOsd]
  );

  const handleSelectTranslator = useCallback(
    async (newId: string) => {
      playButtonClickSound();
      setDrawer(null);
      if (newId === translatorId) return;
      setTranslatorId(newId);
      onTranslatorChange?.(newId);
      if (isSeries) {
        try {
          const epData = await api.getEpisodes(details.id, newId, details.url);
          if (epData.seasons.length > 0) setSeasons(epData.seasons);
          if (epData.episodes.length > 0) setEpisodes(epData.episodes);
        } catch {}
      }
    },
    [translatorId, onTranslatorChange, isSeries, details.id, details.url]
  );

  const handleSelectQuality = useCallback((q: StreamQuality) => {
    playButtonClickSound();
    setDrawer(null);
    setSelectedQuality(q);
    try {
      localStorage.setItem("rdx_preferred_quality", q.label);
    } catch {}
  }, []);

  const handleJumpEpisode = useCallback(
    (s: number, e: number) => {
      playButtonClickSound();
      setDrawer(null);
      setNextCountdown(null);
      currentTimeRef.current = 0;
      setCurrentTime(0);
      setSeason(s);
      setEpisode(e);
      onEpisodeChange?.(s, e);
    },
    [onEpisodeChange]
  );

  // TV Remote / Keyboard bindings
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const code = e.code;
      const isBack =
        key === "Escape" ||
        key === "XF86Back" ||
        key === "GoBack" ||
        key === "Backspace" ||
        e.keyCode === 10009 ||
        e.keyCode === 461;

      if (isBack) {
        e.preventDefault();
        e.stopPropagation();
        playBackSound();
        if (drawer) {
          setDrawer(null);
          return;
        }
        if (nextCountdown !== null) {
          setNextCountdown(null);
          return;
        }
        saveProgressNow();
        onClose();
        return;
      }

      if (drawer) return; // Let D-pad navigate inside drawer

      if (code === "KeyI") {
        e.preventDefault();
        setShowStats((prev) => !prev);
      } else if (code === "Space" || key === "MediaPlayPause" || e.keyCode === 10252) {
        e.preventDefault();
        togglePlay();
      } else if (key === "MediaPlay" || e.keyCode === 415) {
        e.preventDefault();
        adapterRef.current?.play();
        revealOsd();
      } else if (key === "MediaPause" || e.keyCode === 19) {
        e.preventDefault();
        adapterRef.current?.pause();
        revealOsd();
      } else if (key === "ArrowLeft" || key === "MediaRewind" || e.keyCode === 412) {
        if (!osdVisible) {
          e.preventDefault();
          seekBy(e.shiftKey ? -30 : -10);
        }
      } else if (key === "ArrowRight" || key === "MediaFastForward" || e.keyCode === 417) {
        if (!osdVisible) {
          e.preventDefault();
          seekBy(e.shiftKey ? 30 : 10);
        }
      } else if (key === "ArrowUp" || key === "ArrowDown" || key === "Enter") {
        if (!osdVisible) {
          e.preventDefault();
          revealOsd();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [drawer, nextCountdown, osdVisible, togglePlay, seekBy, revealOsd, saveProgressNow, onClose]);

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedTime / duration) * 100) : 0;

  return (
    <div
      data-tv-scope="modal"
      onMouseMove={revealOsd}
      className={cn(
        "fixed inset-0 z-50 flex flex-col justify-between select-none overflow-hidden",
        isExternalSurface ? "bg-transparent" : "bg-black"
      )}
    >
      {/* HTML5 Video Surface (hidden/unused when Android ExoPlayer or Samsung AVPlay owns hardware surface) */}
      {!isExternalSurface && (
        <video
          ref={videoRef}
          className={cn(
            "absolute inset-0 w-full h-full bg-black",
            aspectMode === "fill"
              ? "object-cover"
              : aspectMode === "stretch"
                ? "object-fill"
                : "object-contain"
          )}
          style={{
            fontSize: subSize === "lg" ? "1.35rem" : subSize === "sm" ? "0.9rem" : "1.1rem",
          }}
          playsInline
          onClick={togglePlay}
        >
          {selectedSubUrl && (
            <track kind="subtitles" src={selectedSubUrl} srcLang="uk" label="Субтитри" default />
          )}
        </video>
      )}

      {/* Stream Diagnostics Overlay */}
      {showStats && (
        <div className="absolute top-20 right-8 z-30 w-72 rounded-2xl bg-zinc-950/95 border border-white/15 p-4 text-xs text-zinc-200 space-y-1.5 pointer-events-none">
          <div className="font-black text-rose-400 uppercase tracking-wider mb-1">
            Статистика потоку
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Рушій:</span>
            <span className="font-bold">{ENGINE_LABELS[engineKind]}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Якість / Кадр:</span>
            <span className="font-bold">
              {selectedQuality?.label || "—"} {resolution ? `(${resolution})` : ""}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Буфер попереду:</span>
            <span className="font-bold">+{Math.max(0, Math.round(bufferedTime - currentTime))} с</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Масштаб:</span>
            <span className="font-bold">{ASPECT_LABELS[aspectMode]}</span>
          </div>
          {engineKind === "android-exo" && (
            <div className="flex justify-between">
              <span className="text-zinc-400">Підсилення звуку:</span>
              <span className="font-bold">{audioBoost}%</span>
            </div>
          )}
        </div>
      )}

      {/* Loading / Buffering Spinner */}
      {(playState === "loading" || playState === "buffering") && !errorMsg && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
          <div className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-zinc-950/90 border border-white/10">
            <Loader2 className="w-6 h-6 text-rose-500 animate-spin" />
            <span className="text-sm font-semibold text-white">
              {playState === "loading" ? "Завантаження потоку..." : "Буферизація..."}
            </span>
          </div>
        </div>
      )}

      {/* HUD Notice Toast */}
      {hudNotice && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-xl bg-zinc-950/95 border border-rose-500/40 text-sm font-bold text-white pointer-events-none">
          {hudNotice}
        </div>
      )}

      {/* Error Overlay */}
      {errorMsg && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/85 p-6">
          <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-rose-500/30 p-6 text-center space-y-4">
            <p className="text-base font-bold text-rose-400">Помилка відтворення</p>
            <p className="text-sm text-zinc-300">{errorMsg}</p>
            <div className="flex items-center justify-center gap-3">
              <button
                data-tv-focusable
                data-tv-autofocus
                onClick={() => {
                  setErrorMsg(null);
                  setSelectedQuality((q) => (q ? { ...q } : q));
                }}
                className="px-5 py-2.5 rounded-xl bg-rose-600 text-white text-sm font-bold cursor-pointer"
              >
                Спробувати ще раз
              </button>
              <button
                data-tv-focusable
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl bg-zinc-800 text-zinc-200 text-sm font-semibold cursor-pointer"
              >
                Закрити
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top OSD Bar */}
      <div
        className={cn(
          "relative z-20 flex items-center justify-between px-8 pt-6 pb-10 transition-opacity duration-200",
          osdVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, transparent 100%)" }}
      >
        <div className="flex items-center gap-4 min-w-0">
          <button
            data-tv-focusable
            onClick={() => {
              saveProgressNow();
              onClose();
            }}
            className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/15 text-zinc-200 hover:text-white cursor-pointer"
            title="Назад"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h2 className="text-lg sm:text-xl font-black text-white truncate">{details.title}</h2>
            <div className="flex items-center gap-2 text-xs text-zinc-300 mt-0.5">
              {isSeries && (
                <span className="px-2 py-0.5 rounded bg-rose-600/90 text-white font-bold">
                  S{season}E{episode}
                </span>
              )}
              {activeTranslator && <span className="truncate max-w-xs">{activeTranslator.name}</span>}
              <span className="px-2 py-0.5 rounded bg-white/10 text-zinc-200 font-semibold">
                {ENGINE_LABELS[engineKind]}
                {resolution ? ` • ${resolution}` : ""}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom OSD Controls */}
      <div
        className={cn(
          "relative z-20 px-8 pb-7 pt-12 space-y-4 transition-opacity duration-200",
          osdVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.94) 0%, transparent 100%)" }}
      >
        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              const target = ratio * duration;
              currentTimeRef.current = target;
              setCurrentTime(target);
              adapterRef.current?.seek(target);
            }}
            className="relative h-2.5 w-full rounded-full bg-white/15 cursor-pointer overflow-hidden"
          >
            <div
              className="absolute inset-y-0 left-0 bg-white/25"
              style={{ width: `${bufferedPct}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-rose-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs font-mono text-zinc-300">
            <span>{formatTime(currentTime)}</span>
            <span>{duration > 0 ? `-${formatTime(Math.max(0, duration - currentTime))}` : "0:00"}</span>
          </div>
        </div>

        {/* Control Buttons Row */}
        <div data-tv-row="player-controls" className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            {prevEpisodeInfo && (
              <button
                data-tv-focusable
                onClick={() => handleJumpEpisode(prevEpisodeInfo.season, prevEpisodeInfo.episode)}
                className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/15 text-zinc-200 cursor-pointer"
                title="Попередня серія"
              >
                <SkipBack className="w-5 h-5" />
              </button>
            )}
            <button
              data-tv-focusable
              onClick={() => seekBy(-10)}
              className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/15 text-zinc-200 cursor-pointer"
              title="-10 сек"
            >
              <Rewind className="w-5 h-5" />
            </button>
            <button
              data-tv-focusable
              data-tv-autofocus
              onClick={togglePlay}
              className="p-3.5 rounded-2xl bg-rose-600 text-white cursor-pointer"
              title={playState === "playing" ? "Пауза" : "Відтворити"}
            >
              {playState === "playing" ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current" />
              )}
            </button>
            <button
              data-tv-focusable
              onClick={() => seekBy(10)}
              className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/15 text-zinc-200 cursor-pointer"
              title="+10 сек"
            >
              <FastForward className="w-5 h-5" />
            </button>
            {nextEpisodeInfo && (
              <button
                data-tv-focusable
                onClick={() => handleJumpEpisode(nextEpisodeInfo.season, nextEpisodeInfo.episode)}
                className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/15 text-zinc-200 cursor-pointer"
                title="Наступна серія"
              >
                <SkipForward className="w-5 h-5" />
              </button>
            )}
            {!isExternalSurface && (
              <button
                data-tv-focusable
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  adapterRef.current?.setMuted(next);
                }}
                className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/15 text-zinc-200 cursor-pointer"
                title="Звук"
              >
                {muted ? <VolumeX className="w-5 h-5 text-rose-400" /> : <Volume2 className="w-5 h-5" />}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {isSeries && (
              <button
                data-tv-focusable
                onClick={() => setDrawer(drawer === "episodes" ? null : "episodes")}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900/90 border border-white/15 text-xs font-bold text-white cursor-pointer"
              >
                <ListVideo className="w-4 h-4 text-rose-400" />
                <span>Серії</span>
              </button>
            )}
            {details.translators.length > 1 && (
              <button
                data-tv-focusable
                onClick={() => setDrawer(drawer === "translator" ? null : "translator")}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900/90 border border-white/15 text-xs font-bold text-white cursor-pointer"
              >
                <span>Озвучка</span>
              </button>
            )}
            {streamData && streamData.qualities.length > 0 && (
              <button
                data-tv-focusable
                onClick={() => setDrawer(drawer === "quality" ? null : "quality")}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900/90 border border-white/15 text-xs font-bold text-white cursor-pointer"
              >
                {isPremiumQuality(selectedQuality?.label) ? (
                  <Crown className="w-4 h-4 text-amber-400" />
                ) : (
                  <Settings className="w-4 h-4 text-rose-400" />
                )}
                <span>{selectedQuality?.label || "Якість"}</span>
              </button>
            )}
            {streamData && streamData.subtitles.length > 0 && (
              <button
                data-tv-focusable
                onClick={() => setDrawer(drawer === "subtitles" ? null : "subtitles")}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900/90 border border-white/15 text-xs font-bold text-white cursor-pointer"
              >
                <Subtitles className="w-4 h-4" />
                <span>Субтитри</span>
              </button>
            )}
            <button
              data-tv-focusable
              onClick={() => setDrawer(drawer === "speed" ? null : "speed")}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900/90 border border-white/15 text-xs font-bold text-white cursor-pointer"
            >
              <Gauge className="w-4 h-4" />
              <span>{playbackSpeed}x</span>
            </button>
            <button
              data-tv-focusable
              onClick={() => {
                const next: AspectMode =
                  aspectMode === "fit" ? "fill" : aspectMode === "fill" ? "stretch" : "fit";
                setAspectMode(next);
                adapterRef.current?.setAspectMode?.(next);
                showNotice(`Масштаб: ${ASPECT_LABELS[next]}`);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900/90 border border-white/15 text-xs font-bold text-white cursor-pointer"
              title="Масштаб екрана"
            >
              <Maximize className="w-4 h-4" />
              <span>{ASPECT_LABELS[aspectMode]}</span>
            </button>
            {engineKind === "android-exo" && (
              <button
                data-tv-focusable
                onClick={() => {
                  const next = audioBoost === 100 ? 150 : audioBoost === 150 ? 200 : 100;
                  setAudioBoost(next);
                  adapterRef.current?.setAudioBoost?.(next);
                  showNotice(`Звук: ${next}%`);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold cursor-pointer",
                  audioBoost > 100
                    ? "bg-rose-600/30 border-rose-500 text-rose-200"
                    : "bg-zinc-900/90 border-white/15 text-white"
                )}
                title="Підсилення гучності"
              >
                <Volume2 className="w-4 h-4" />
                <span>{audioBoost}%</span>
              </button>
            )}
            <button
              data-tv-focusable
              onClick={() => setDrawer(drawer === "sleep" ? null : "sleep")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold cursor-pointer",
                sleepMinutes > 0
                  ? "bg-rose-600/30 border-rose-500 text-rose-200"
                  : "bg-zinc-900/90 border-white/15 text-white"
              )}
            >
              <Timer className="w-4 h-4" />
              <span>{sleepMinutes > 0 ? `${sleepMinutes} хв` : "Сон"}</span>
            </button>
            <button
              data-tv-focusable
              onClick={() => setShowStats((s) => !s)}
              className={cn(
                "p-2 rounded-xl border text-xs font-bold cursor-pointer",
                showStats
                  ? "bg-rose-600/30 border-rose-500 text-rose-200"
                  : "bg-zinc-900/90 border-white/15 text-zinc-200"
              )}
              title="Статистика потоку (I)"
            >
              <Info className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Next Episode Autoplay Countdown */}
      {nextCountdown !== null && nextEpisodeInfo && (
        <div className="absolute right-8 bottom-32 z-30 w-80 rounded-2xl bg-zinc-950/95 border border-rose-500/40 p-5 space-y-3">
          {nextEpisodeInfo.isNewSeason && (
            <span className="inline-block px-2.5 py-0.5 rounded-md bg-amber-500/20 text-amber-300 text-xs font-black">
              🌟 НОВИЙ СЕЗОН
            </span>
          )}
          <div className="text-sm font-bold text-white">
            Наступна серія: S{nextEpisodeInfo.season}E{nextEpisodeInfo.episode} через {nextCountdown} с
          </div>
          <div className="flex gap-2">
            <button
              data-tv-focusable
              onClick={() => handleJumpEpisode(nextEpisodeInfo.season, nextEpisodeInfo.episode)}
              className="flex-1 py-2 rounded-xl bg-rose-600 text-white text-xs font-bold cursor-pointer"
            >
              Дивитися зараз
            </button>
            <button
              data-tv-focusable
              onClick={() => setNextCountdown(null)}
              className="px-4 py-2 rounded-xl bg-zinc-800 text-zinc-200 text-xs font-semibold cursor-pointer"
            >
              Скасувати
            </button>
          </div>
        </div>
      )}

      {/* Side Drawer (Quality / Translator / Episodes / Subtitles / Speed / Sleep) */}
      {drawer && (
        <div
          data-tv-scope="modal"
          className="absolute inset-y-0 right-0 z-40 w-80 sm:w-96 bg-zinc-950/95 border-l border-white/10 p-6 flex flex-col gap-4 overflow-y-auto"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-base font-black text-white">
              {drawer === "quality" && "Якість відео"}
              {drawer === "translator" && "Озвучка"}
              {drawer === "episodes" && "Сезони та серії"}
              {drawer === "subtitles" && "Субтитри"}
              {drawer === "speed" && "Швидкість"}
              {drawer === "sleep" && "Таймер сну"}
            </h3>
            <button
              data-tv-focusable
              onClick={() => setDrawer(null)}
              className="p-2 rounded-xl bg-zinc-900 text-zinc-300 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {drawer === "quality" && streamData && (
            <div className="space-y-2">
              {streamData.qualities.map((q) => {
                const active = selectedQuality?.label === q.label;
                return (
                  <button
                    key={q.label}
                    data-tv-focusable
                    data-tv-autofocus={active || undefined}
                    onClick={() => handleSelectQuality(q)}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-bold cursor-pointer",
                      active
                        ? "bg-rose-600/25 border-rose-500 text-white"
                        : "bg-zinc-900 border-white/10 text-zinc-300"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {isPremiumQuality(q.label) && <Crown className="w-4 h-4 text-amber-400" />}
                      {q.label}
                    </span>
                    {active && <Check className="w-4 h-4 text-rose-400" />}
                  </button>
                );
              })}
            </div>
          )}

          {drawer === "translator" && (
            <div className="space-y-2">
              {sortedTranslators.map((t) => {
                const active = t.id === translatorId;
                const isUa = /укр/i.test(`${t.language || ""} ${t.name}`);
                return (
                  <button
                    key={t.id}
                    data-tv-focusable
                    data-tv-autofocus={active || undefined}
                    onClick={() => handleSelectTranslator(t.id)}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-semibold text-left cursor-pointer",
                      active
                        ? "bg-rose-600/25 border-rose-500 text-white"
                        : "bg-zinc-900 border-white/10 text-zinc-300"
                    )}
                  >
                    <span className="flex items-center gap-2 truncate">
                      {isUa && <UaFlag className="w-4 h-3 shrink-0" />}
                      <span className="truncate">{t.name}</span>
                    </span>
                    {active && <Check className="w-4 h-4 text-rose-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          {drawer === "episodes" && (
            <div className="space-y-4">
              {seasons.length > 1 && (
                <div className="flex gap-2 flex-wrap">
                  {seasons.map((s) => {
                    const num = parseInt(s.id, 10) || 1;
                    return (
                      <button
                        key={s.id}
                        data-tv-focusable
                        onClick={() => setSeason(num)}
                        className={cn(
                          "px-3 py-1.5 rounded-lg text-xs font-bold border cursor-pointer",
                          season === num
                            ? "bg-rose-600 border-rose-500 text-white"
                            : "bg-zinc-900 border-white/10 text-zinc-300"
                        )}
                      >
                        {s.title}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                {currentSeasonEpisodes.map((ep) => {
                  const epNum = parseInt(ep.episode_id, 10) || 1;
                  const active = epNum === episode;
                  return (
                    <button
                      key={`${ep.season_id}-${ep.episode_id}`}
                      data-tv-focusable
                      data-tv-autofocus={active || undefined}
                      onClick={() => handleJumpEpisode(season, epNum)}
                      className={cn(
                        "py-2.5 px-2 rounded-xl border text-xs font-bold cursor-pointer",
                        active
                          ? "bg-rose-600 border-rose-500 text-white"
                          : "bg-zinc-900 border-white/10 text-zinc-300"
                      )}
                    >
                      {epNum} серія
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {drawer === "subtitles" && streamData && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {(["sm", "md", "lg"] as SubSize[]).map((sz) => (
                  <button
                    key={sz}
                    data-tv-focusable
                    onClick={() => {
                      setSubSize(sz);
                      try {
                        localStorage.setItem("rdx_sub_size", sz);
                      } catch {}
                    }}
                    className={cn(
                      "flex-1 py-2 rounded-xl border text-xs font-bold cursor-pointer",
                      subSize === sz
                        ? "bg-rose-600 border-rose-500 text-white"
                        : "bg-zinc-900 border-white/10 text-zinc-300"
                    )}
                  >
                    {sz === "sm" ? "Малий" : sz === "md" ? "Середній" : "Великий"}
                  </button>
                ))}
              </div>
              <button
                data-tv-focusable
                onClick={() => {
                  setSelectedSubUrl("");
                  adapterRef.current?.setSubtitle?.(null);
                  setDrawer(null);
                }}
                className={cn(
                  "w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-bold cursor-pointer",
                  !selectedSubUrl
                    ? "bg-rose-600/25 border-rose-500 text-white"
                    : "bg-zinc-900 border-white/10 text-zinc-300"
                )}
              >
                <span>Вимкнено</span>
                {!selectedSubUrl && <Check className="w-4 h-4 text-rose-400" />}
              </button>
              {streamData.subtitles.map((sub) => (
                <button
                  key={sub.url}
                  data-tv-focusable
                  onClick={() => {
                    setSelectedSubUrl(sub.url);
                    adapterRef.current?.setSubtitle?.(sub.url);
                    setDrawer(null);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-semibold cursor-pointer",
                    selectedSubUrl === sub.url
                      ? "bg-rose-600/25 border-rose-500 text-white"
                      : "bg-zinc-900 border-white/10 text-zinc-300"
                  )}
                >
                  <span>{sub.label}</span>
                  {selectedSubUrl === sub.url && <Check className="w-4 h-4 text-rose-400" />}
                </button>
              ))}
            </div>
          )}

          {drawer === "speed" && (
            <div className="space-y-2">
              {[0.75, 1, 1.25, 1.5, 2].map((spd) => (
                <button
                  key={spd}
                  data-tv-focusable
                  onClick={() => {
                    setPlaybackSpeed(spd);
                    adapterRef.current?.setPlaybackRate(spd);
                    setDrawer(null);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-bold cursor-pointer",
                    playbackSpeed === spd
                      ? "bg-rose-600/25 border-rose-500 text-white"
                      : "bg-zinc-900 border-white/10 text-zinc-300"
                  )}
                >
                  <span>{spd}x</span>
                  {playbackSpeed === spd && <Check className="w-4 h-4 text-rose-400" />}
                </button>
              ))}
            </div>
          )}

          {drawer === "sleep" && (
            <div className="space-y-2">
              {[0, 15, 30, 60, 90].map((m) => (
                <button
                  key={m}
                  data-tv-focusable
                  onClick={() => {
                    setSleepMinutes(m);
                    setDrawer(null);
                    showNotice(m > 0 ? `Таймер сну: ${m} хв` : "Таймер сну вимкнено");
                  }}
                  className={cn(
                    "w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-bold cursor-pointer",
                    sleepMinutes === m
                      ? "bg-rose-600/25 border-rose-500 text-white"
                      : "bg-zinc-900 border-white/10 text-zinc-300"
                  )}
                >
                  <span>{m === 0 ? "Вимкнено" : `${m} хвилин`}</span>
                  {sleepMinutes === m && <Check className="w-4 h-4 text-rose-400" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
