import React, { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Play,
  Bookmark as BookmarkIcon,
  Star,
  Loader2,
  Check,
  Clock,
  Mic,
  Film,
  Tv,
  X,
} from "lucide-react";
import type {
  Bookmark,
  MediaCard,
  MediaDetails,
  WatchProgress,
  Translator,
  EpisodeProgress,
} from "../types";
import { api } from "../services/api";
import { cn } from "../lib/utils";
import { playHoverSound, playModalOpenSound, playButtonClickSound, suppressHoverSound } from "../services/sound";
import { focusFirstInScope, useTvBack } from "../hooks/useTvNavigation";

interface MediaDetailsModalProps {
  media: MediaCard | null;
  isOpen: boolean;
  onClose: () => void;
  onPlay: (
    details: MediaDetails,
    translatorId?: string,
    season?: number,
    episode?: number,
    positionSec?: number
  ) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (bookmark: Bookmark) => void;
}

type DetailTab = "episodes" | "details";

export const MediaDetailsModal: React.FC<MediaDetailsModalProps> = ({
  media,
  isOpen,
  onClose,
  onPlay,
  isBookmarked = false,
  onToggleBookmark,
}) => {
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [savedProgress, setSavedProgress] = useState<WatchProgress | null>(null);
  const [episodeProgressList, setEpisodeProgressList] = useState<EpisodeProgress[]>([]);
  const [selectedTranslator, setSelectedTranslator] = useState<Translator | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [selectedEpisode, setSelectedEpisode] = useState<number>(1);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [maxKnownSeasons, setMaxKnownSeasons] = useState<number>(1);
  const [activeTab, setActiveTab] = useState<DetailTab>("details");

  // TV D-pad voiceover drawer state
  const [isTranslatorModalOpen, setIsTranslatorModalOpen] = useState(false);
  const [translatorFilterTab, setTranslatorFilterTab] = useState<"all" | "ukr">("all");

  const getBookmarkCategory = (): string => {
    if (
      savedProgress &&
      savedProgress.duration_sec > 0 &&
      savedProgress.position_sec / savedProgress.duration_sec >= 0.9
    ) {
      return "completed";
    }
    if (savedProgress && savedProgress.position_sec > 15) {
      return "watching";
    }
    return "favorites";
  };

  const handleClose = useCallback(() => {
    suppressHoverSound(400);
    setIsTranslatorModalOpen(false);
    onClose();
  }, [onClose]);

  // TV Remote Back key: close translator drawer first, otherwise close details screen
  useTvBack(isOpen && !isTranslatorModalOpen, handleClose);
  useTvBack(isOpen && isTranslatorModalOpen, () => setIsTranslatorModalOpen(false));

  // Auto-focus primary CTA when modal opens or translator drawer closes
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => {
      focusFirstInScope();
    }, 60);
    return () => clearTimeout(t);
  }, [isOpen, isTranslatorModalOpen, details?.id]);

  useEffect(() => {
    if (!isOpen || !media) {
      setDetails(null);
      setBackdropUrl(null);
      setBackdropLoaded(false);
      setFetchError(null);
      setIsTranslatorModalOpen(false);
      return;
    }

    let isMounted = true;
    setBackdropLoaded(false);
    playModalOpenSound();

    // Try fetching TMDB backdrop immediately in parallel
    const yearMatch = media.misc_info?.match(/\b(19|20)\d{2}\b/);
    api
      .getBackdrop(media.title, undefined, yearMatch?.[0])
      .then((url) => {
        if (isMounted && url) setBackdropUrl(url);
      })
      .catch(() => {});

    const fetchData = async () => {
      setLoading(true);
      setFetchError(null);
      try {
        const [det, initialProgress, initialEpProgress] = await Promise.all([
          api.getMediaDetails(media.url),
          api.getWatchProgress(media.id).catch(() => null),
          api.getEpisodeProgress(media.id).catch(() => []),
        ]);
        if (!isMounted) return;

        // Refine TMDB backdrop using orig_title + year if we didn't get one yet
        const detYear =
          det.info_table.find(([k]) => k.toLowerCase().includes("рік") || k.toLowerCase().includes("год"))?.[1]?.match(/\b(19|20)\d{2}\b/)?.[0] ||
          yearMatch?.[0];
        api
          .getBackdrop(det.title, det.orig_title || undefined, detYear)
          .then((url) => {
            if (isMounted && url) setBackdropUrl(url);
          })
          .catch(() => {});

        let progress = initialProgress;
        let epProgress = initialEpProgress;

        if (det.id !== media.id) {
          if (!progress) {
            progress = await api.getWatchProgress(det.id).catch(() => null);
          }
          if (epProgress.length === 0) {
            epProgress = await api.getEpisodeProgress(det.id).catch(() => []);
          }
          if (!isMounted) return;
        }

        let hintedMax = det.seasons.length;
        if (media.series_info) {
          const m1 = media.series_info.match(/(\d+)\s*сезон/i);
          const m2 = media.series_info.match(/s(\d+)/i);
          if (m1) hintedMax = Math.max(hintedMax, parseInt(m1[1], 10) || 1);
          if (m2) hintedMax = Math.max(hintedMax, parseInt(m2[1], 10) || 1);
        }
        setMaxKnownSeasons(hintedMax);

        let defaultT: Translator | null = null;
        if (det.translators && det.translators.length > 0) {
          const savedT = progress?.translator_id
            ? det.translators.find((t) => t.id === progress.translator_id)
            : null;

          const ukrT = det.translators.find(
            (t) =>
              t.language?.toLowerCase().includes("украин") ||
              t.language?.toLowerCase().includes("україн")
          );

          defaultT =
            savedT || ukrT || det.translators.find((t) => t.is_active) || det.translators[0];
          setSelectedTranslator(defaultT);
        }

        const hasSeasons = Boolean(det.seasons && det.seasons.length > 0);
        setActiveTab(hasSeasons ? "episodes" : "details");

        setDetails(det);
        setSavedProgress(progress);
        setEpisodeProgressList(epProgress || []);
        setLoading(false);

        if (progress?.season) {
          const seasonExists = det.seasons.some((s) => parseInt(s.id, 10) === progress.season);
          if (seasonExists) {
            setSelectedSeason(progress.season);
          } else if (det.seasons.length > 0) {
            const firstS = parseInt(det.seasons[0].id, 10);
            setSelectedSeason(isNaN(firstS) ? 1 : firstS);
          }
        } else if (det.seasons && det.seasons.length > 0) {
          const firstSeasonNum = parseInt(det.seasons[0].id, 10);
          setSelectedSeason(isNaN(firstSeasonNum) ? 1 : firstSeasonNum);
        }

        if (progress?.episode) {
          setSelectedEpisode(progress.episode);
        } else {
          setSelectedEpisode(1);
        }

        if (hasSeasons && defaultT) {
          setLoadingEpisodes(true);
          api
            .getEpisodes(det.id, defaultT.id, det.url)
            .then((epData) => {
              if (isMounted && epData.episodes && epData.episodes.length > 0) {
                if (epData.seasons.length > 0) {
                  setMaxKnownSeasons((prev) => Math.max(prev, epData.seasons.length));
                }
                setDetails((prev) =>
                  prev
                    ? {
                        ...prev,
                        seasons: epData.seasons.length > 0 ? epData.seasons : prev.seasons,
                        episodes: epData.episodes,
                        initial_streams: epData.stream_data || prev.initial_streams,
                      }
                    : prev
                );
              }
            })
            .catch((epErr) => {
              console.warn("Failed to load initial episodes for default translator:", epErr);
            })
            .finally(() => {
              if (isMounted) setLoadingEpisodes(false);
            });
        }
      } catch (err) {
        console.error("Failed to load media details:", err);
        if (isMounted) {
          setFetchError("Не вдалося завантажити інформацію про цей фільм. Перевірте дзеркало в налаштуваннях.");
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchData();
    return () => {
      isMounted = false;
    };
  }, [isOpen, media]);

  const handleTranslatorSelect = async (translator: Translator) => {
    setSelectedTranslator(translator);
    setIsTranslatorModalOpen(false);
    if (!details || details.seasons.length === 0) return;

    setLoadingEpisodes(true);
    try {
      const data = await api.getEpisodes(details.id, translator.id, details.url);
      if (data.seasons.length > 0) {
        setMaxKnownSeasons((prev) => Math.max(prev, data.seasons.length));
      }
      setDetails((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          seasons: data.seasons,
          episodes: data.episodes,
          initial_streams: data.stream_data || prev.initial_streams,
        };
      });

      const seasonExists = data.seasons.some((s) => parseInt(s.id, 10) === selectedSeason);
      if (!seasonExists && data.seasons.length > 0) {
        const firstSeason = parseInt(data.seasons[0].id, 10);
        setSelectedSeason(isNaN(firstSeason) ? 1 : firstSeason);
        setSelectedEpisode(1);
      }
    } catch (e) {
      console.error("Failed to update episodes for translator:", e);
    } finally {
      setLoadingEpisodes(false);
    }
  };

  if (!isOpen || !media) return null;

  const isSeries = details
    ? Boolean(details.seasons && details.seasons.length > 0)
    : Boolean(
        media.series_info ||
          media.entity_type?.toLowerCase().includes("series") ||
          media.entity_type?.toLowerCase().includes("сериал") ||
          media.entity_type?.toLowerCase().includes("серіал")
      );

  const currentSeasonEpisodes =
    details?.episodes.filter((ep) => Number(ep.season_id) === Number(selectedSeason)) || [];

  const hasAvailableStream = Boolean(
    (details?.translators && details.translators.length > 0) ||
      (details?.initial_streams && details.initial_streams.qualities.length > 0) ||
      (details?.episodes && details.episodes.length > 0)
  );

  const handleStartPlayback = (season?: number, ep?: number) => {
    if (!details) return;

    const playSeason = season ?? selectedSeason;
    const playEp = ep ?? selectedEpisode;

    const epProg = isSeries
      ? episodeProgressList.find((p) => p.season === playSeason && p.episode === playEp)
      : null;

    let initialPos = 0;
    if (epProg && epProg.duration_sec > 0) {
      const pct = (epProg.position_sec / epProg.duration_sec) * 100;
      if (pct < 90) initialPos = epProg.position_sec;
    } else if (
      savedProgress &&
      (!isSeries || (savedProgress.season === playSeason && savedProgress.episode === playEp))
    ) {
      initialPos = savedProgress.position_sec;
    }

    onPlay(
      details,
      selectedTranslator?.id,
      isSeries ? playSeason : undefined,
      isSeries ? playEp : undefined,
      initialPos
    );
  };

  const ukrTranslators =
    details?.translators.filter(
      (t) =>
        t.language?.toLowerCase().includes("украин") ||
        t.language?.toLowerCase().includes("україн")
    ) || [];

  const sortedTranslators = (() => {
    if (!details?.translators) return [];
    const base = translatorFilterTab === "ukr" ? ukrTranslators : [...details.translators];
    return base.sort((a, b) => {
      const aUkr =
        a.language?.toLowerCase().includes("украин") ||
        a.language?.toLowerCase().includes("україн");
      const bUkr =
        b.language?.toLowerCase().includes("украин") ||
        b.language?.toLowerCase().includes("україн");
      if (aUkr && !bUkr) return -1;
      if (!aUkr && bUkr) return 1;
      return 0;
    });
  })();

  const fallbackPoster = details?.high_res_poster || details?.poster || media.poster;

  // Extract concise metadata badges
  const yearVal = details?.info_table.find(([k]) => k.toLowerCase().includes("рік") || k.toLowerCase().includes("год"))?.[1];
  const durationVal = details?.info_table.find(([k]) => k.toLowerCase().includes("тривалість") || k.toLowerCase().includes("время"))?.[1];
  const genreVal = details?.info_table.find(([k]) => k.toLowerCase().includes("жанр"))?.[1];

  return (
    <div
      data-tv-scope="modal"
      data-modal-open="true"
      className="fixed inset-0 z-50 bg-[var(--bg-base,#000000)] overflow-y-auto overflow-x-hidden select-none"
    >
      {/* Apple TV / Disney+ Full-Bleed Right-Aligned Hero Section */}
      <div className="relative min-h-[72vh] w-full flex flex-col justify-end">
        {/* Right-side / Full-bleed Backdrop Image (two-layer cross-fade, zero flicker) */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {/* Base HDRezka fallback layer */}
          <img
            src={fallbackPoster}
            alt=""
            aria-hidden="true"
            decoding="async"
            className={cn(
              "w-full h-full object-cover object-right blur-[6px] scale-105 transition-opacity duration-500",
              backdropLoaded ? "opacity-0" : "opacity-50"
            )}
          />
          {/* High-res TMDB backdrop layer (fades in only after image finishes decoding) */}
          {backdropUrl && (
            <img
              src={backdropUrl}
              alt={details?.title || media.title}
              decoding="async"
              onLoad={() => setBackdropLoaded(true)}
              className={cn(
                "absolute inset-0 w-full h-full object-cover object-right-top sm:object-[70%_20%] transition-opacity duration-500 ease-out",
                backdropLoaded ? "opacity-90" : "opacity-0"
              )}
            />
          )}
          {/* Left-to-right cinematic fade so left text & buttons are 100% legible */}
          <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg-base,#000000)] via-[var(--bg-base,#000000)]/90 via-40% to-transparent" />
          {/* Top subtle vignette */}
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[var(--bg-base,#000000)]/70 to-transparent" />
          {/* Bottom seamless fade into tabs/episodes */}
          <div className="absolute inset-x-0 bottom-0 h-52 bg-gradient-to-t from-[var(--bg-base,#000000)] via-[var(--bg-base,#000000)]/85 to-transparent" />
        </div>

        {/* Left Content Column (10-foot safe-area padding) */}
        <div className="relative z-10 px-[4vw] pt-10 pb-8 max-w-4xl space-y-5">
          {/* Type & Rating Badges Row */}
          <div className="flex flex-wrap items-center gap-2.5 text-sm font-semibold">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-600 text-white font-bold uppercase tracking-wider text-xs shadow-lg shadow-rose-950/50">
              {isSeries ? <Tv className="w-3.5 h-3.5" /> : <Film className="w-3.5 h-3.5" />}
              {isSeries ? "Серіал" : "Фільм"}
            </span>

            {(details?.imdb_rating || media.rating) && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                IMDb {details?.imdb_rating || media.rating}
              </span>
            )}

            {details?.kp_rating && (
              <span className="px-3 py-1 rounded-lg bg-white/10 text-zinc-200 border border-white/10">
                KP {details.kp_rating}
              </span>
            )}

            {yearVal && <span className="text-zinc-300">{yearVal}</span>}
            {durationVal && <span className="text-zinc-300">• {durationVal}</span>}
          </div>

          {/* Title & Original Title */}
          <div className="space-y-1.5">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tight text-white leading-[1.08] drop-shadow-2xl">
              {details?.title || media.title}
            </h1>
            {details?.orig_title && (
              <p className="text-base sm:text-lg text-zinc-400 font-medium">
                {details.orig_title}
              </p>
            )}
            {genreVal && (
              <p className="text-sm text-zinc-300/90 font-medium pt-0.5">{genreVal}</p>
            )}
          </div>

          {/* Short Synopsis */}
          {details?.description && (
            <p className="text-base sm:text-lg text-zinc-200/90 leading-relaxed line-clamp-3 max-w-2xl">
              {details.description}
            </p>
          )}

          {/* Error Banner */}
          {fetchError && (
            <div className="p-4 rounded-2xl bg-rose-950/60 border border-rose-500/40 text-rose-200 text-sm">
              {fetchError}
            </div>
          )}

          {/* Primary TV Action Buttons Row */}
          <div data-tv-row="details-actions" className="flex items-center gap-3 pt-2 whitespace-nowrap">
            {loading ? (
              <div className="flex items-center gap-3 px-7 py-3.5 rounded-2xl bg-white/10 text-zinc-200 text-base font-semibold">
                <Loader2 className="w-5 h-5 animate-spin text-rose-500" />
                <span>Завантаження...</span>
              </div>
            ) : hasAvailableStream ? (
              <button
                data-tv-focusable
                data-tv-autofocus
                onClick={() => {
                  playButtonClickSound();
                  handleStartPlayback();
                }}
                className="flex items-center gap-2.5 px-6 py-3.5 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-base shadow-[0_8px_28px_rgba(225,29,72,0.4)] transition-all focus:outline-none focus:ring-4 focus:ring-rose-400 focus:scale-105 cursor-pointer shrink-0"
              >
                <Play className="w-5 h-5 fill-current" />
                <span>
                  {savedProgress && savedProgress.position_sec > 15
                    ? isSeries
                      ? `Продовжити S${savedProgress.season || selectedSeason}E${savedProgress.episode || selectedEpisode}`
                      : "Продовжити"
                    : isSeries
                    ? `Дивитися S${selectedSeason}E${selectedEpisode}`
                    : "Дивитися"}
                </span>
              </button>
            ) : (
              <div className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-300 text-base font-bold shrink-0">
                <Clock className="w-5 h-5" />
                <span>Очікується реліз</span>
              </div>
            )}

            {/* Voiceover Selector Button (opens D-pad modal instead of mouse popover) */}
            {details && details.translators.length > 0 && (
              <button
                data-tv-focusable
                onClick={() => {
                  playButtonClickSound();
                  setIsTranslatorModalOpen(true);
                }}
                className="flex items-center gap-2 px-4 py-3.5 rounded-2xl bg-zinc-900/90 hover:bg-zinc-800 text-white border border-white/15 text-sm sm:text-base font-semibold transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 focus:scale-105 cursor-pointer max-w-[230px] shrink-0"
              >
                <Mic className="w-4 h-4 text-rose-400 shrink-0" />
                <span className="truncate">{selectedTranslator?.name || "Озвучення"}</span>
              </button>
            )}

            {/* Bookmark Toggle */}
            {details && onToggleBookmark && (
              <button
                data-tv-focusable
                onClick={() => {
                  playButtonClickSound();
                  onToggleBookmark({
                    media_id: details.id,
                    media_type: isSeries ? "series" : "film",
                    title: details.title,
                    poster_url: details.poster,
                    media_url: details.url,
                    year_info: yearVal || media.misc_info || null,
                    rating: details.imdb_rating || media.rating || null,
                    category: getBookmarkCategory(),
                    added_at: Math.floor(Date.now() / 1000),
                  });
                }}
                title={isBookmarked ? "Видалити із закладок" : "Додати в закладки"}
                className={cn(
                  "p-3.5 rounded-2xl border transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 focus:scale-105 cursor-pointer shrink-0",
                  isBookmarked
                    ? "bg-amber-500/20 text-amber-300 border-amber-400/50"
                    : "bg-zinc-900/90 text-zinc-200 border-white/15 hover:bg-zinc-800"
                )}
              >
                <BookmarkIcon className={cn("w-5 h-5", isBookmarked && "fill-amber-400")} />
              </button>
            )}

            {/* Back Button (compact icon; also mapped to remote Back/Escape) */}
            <button
              data-tv-focusable
              onClick={handleClose}
              title="Назад"
              aria-label="Назад"
              className="p-3.5 rounded-2xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 focus:scale-105 cursor-pointer shrink-0"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Tabs & Content (Apple TV / Disney+ Style) */}
      {details && (
        <div className="relative z-10 px-[4vw] pb-14 space-y-6">
          {/* Tabs Bar */}
          <div data-tv-row="details-tabs" className="flex items-center gap-6 border-b border-white/10 pb-3">
            {isSeries && (
              <button
                data-tv-focusable
                onClick={() => {
                  playButtonClickSound();
                  setActiveTab("episodes");
                }}
                className={cn(
                  "text-base font-bold tracking-wider uppercase px-3 py-1.5 rounded-xl transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 cursor-pointer",
                  activeTab === "episodes"
                    ? "text-white bg-white/10"
                    : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                Серії {maxKnownSeasons > 1 ? `(${maxKnownSeasons} сез.)` : ""}
              </button>
            )}
            <button
              data-tv-focusable
              onClick={() => {
                playButtonClickSound();
                setActiveTab("details");
              }}
              className={cn(
                "text-base font-bold tracking-wider uppercase px-3 py-1.5 rounded-xl transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 cursor-pointer",
                activeTab === "details"
                  ? "text-white bg-white/10"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              Деталі
            </button>
          </div>

          {/* Series Tab: Seasons + Episodes */}
          {activeTab === "episodes" && isSeries && (
            <div className="space-y-5">
              {/* Season Selector Strip */}
              {details.seasons.length > 0 && (
                <div data-tv-row="details-seasons" className="flex flex-wrap items-center gap-2.5">
                  {details.seasons.map((s) => {
                    const sNum = parseInt(s.id, 10) || 1;
                    const isActive = Number(selectedSeason) === sNum;
                    return (
                      <button
                        key={s.id}
                        data-tv-focusable
                        onClick={() => {
                          playButtonClickSound();
                          setSelectedSeason(sNum);
                          setSelectedEpisode(1);
                        }}
                        className={cn(
                          "px-4 py-2 rounded-xl text-sm font-bold transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 focus:scale-105 cursor-pointer border",
                          isActive
                            ? "bg-rose-600 text-white border-rose-400/50 shadow-lg"
                            : "bg-zinc-900 text-zinc-300 border-white/10 hover:bg-zinc-800"
                        )}
                      >
                        {s.title}
                      </button>
                    );
                  })}
                  {loadingEpisodes && (
                    <Loader2 className="w-5 h-5 animate-spin text-rose-500 ml-2" />
                  )}
                </div>
              )}

              {/* Episodes Grid */}
              <div
                data-tv-row="details-episodes"
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3.5"
              >
                {currentSeasonEpisodes.map((ep) => {
                  const epNum = parseInt(ep.episode_id, 10) || 1;
                  const epProg = episodeProgressList.find(
                    (p) => p.season === selectedSeason && p.episode === epNum
                  );
                  const pct =
                    epProg && epProg.duration_sec > 0
                      ? Math.min(100, Math.round((epProg.position_sec / epProg.duration_sec) * 100))
                      : 0;
                  const isCurrent = selectedEpisode === epNum;

                  return (
                    <button
                      key={`${ep.season_id}-${ep.episode_id}`}
                      data-tv-focusable
                      onFocus={playHoverSound}
                      onClick={() => {
                        playButtonClickSound();
                        setSelectedEpisode(epNum);
                        handleStartPlayback(selectedSeason, epNum);
                      }}
                      className={cn(
                        "relative flex flex-col justify-between p-4 rounded-2xl text-left border transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 focus:scale-105 cursor-pointer overflow-hidden",
                        isCurrent
                          ? "bg-rose-600/20 border-rose-500/60 text-white"
                          : "bg-zinc-900/90 border-white/10 text-zinc-200 hover:bg-zinc-800"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-white">
                          {ep.title || `Серія ${epNum}`}
                        </span>
                        <Play className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      </div>
                      {pct > 0 && (
                        <div className="mt-3 h-1 w-full bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-rose-500 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Details Tab: Full Description & Info Table */}
          {activeTab === "details" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-3">
                <h3 className="text-lg font-bold text-white">Про фільм / серіал</h3>
                <p className="text-base text-zinc-300 leading-relaxed">
                  {details.description || "Опис відсутній."}
                </p>
              </div>
              <div className="space-y-3 bg-zinc-900/60 border border-white/10 rounded-2xl p-5">
                {details.info_table.map(([label, value], idx) => (
                  <div key={idx} className="text-sm flex flex-col gap-0.5">
                    <span className="text-zinc-400 font-medium">{label}</span>
                    <span className="text-zinc-100 font-semibold">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* D-Pad Friendly Voiceover Selection Modal */}
      {isTranslatorModalOpen && details && (
        <div
          data-tv-scope="modal"
          className="fixed inset-0 z-[60] bg-black/85 backdrop-blur-md flex items-center justify-center p-6"
        >
          <div className="w-full max-w-2xl max-h-[82vh] bg-zinc-950 border border-white/15 rounded-3xl p-6 flex flex-col gap-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
                <Mic className="w-5 h-5 text-rose-500" />
                <span>Вибір озвучення</span>
              </h2>
              <button
                data-tv-focusable
                onClick={() => setIsTranslatorModalOpen(false)}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-200 focus:outline-none focus:ring-4 focus:ring-rose-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filter Pills */}
            <div data-tv-row="translator-filters" className="flex items-center gap-3">
              <button
                data-tv-focusable
                onClick={() => setTranslatorFilterTab("all")}
                className={cn(
                  "px-4 py-2 rounded-xl text-sm font-bold border transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 cursor-pointer",
                  translatorFilterTab === "all"
                    ? "bg-rose-600 text-white border-rose-400/50"
                    : "bg-zinc-900 text-zinc-300 border-white/10"
                )}
              >
                Всі ({details.translators.length})
              </button>
              {ukrTranslators.length > 0 && (
                <button
                  data-tv-focusable
                  onClick={() => setTranslatorFilterTab("ukr")}
                  className={cn(
                    "px-4 py-2 rounded-xl text-sm font-bold border transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 cursor-pointer",
                    translatorFilterTab === "ukr"
                      ? "bg-rose-600 text-white border-rose-400/50"
                      : "bg-zinc-900 text-zinc-300 border-white/10"
                  )}
                >
                  🇺🇦 Українські ({ukrTranslators.length})
                </button>
              )}
            </div>

            {/* Translator List */}
            <div className="overflow-y-auto space-y-2 pr-1">
              {sortedTranslators.map((t, idx) => {
                const isSelected = selectedTranslator?.id === t.id;
                return (
                  <button
                    key={t.id}
                    data-tv-focusable
                    data-tv-autofocus={isSelected || idx === 0 ? "true" : undefined}
                    onClick={() => {
                      playButtonClickSound();
                      handleTranslatorSelect(t);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-3.5 rounded-2xl text-left border transition-all focus:outline-none focus:ring-4 focus:ring-rose-500 cursor-pointer",
                      isSelected
                        ? "bg-rose-600/20 border-rose-500 text-white"
                        : "bg-zinc-900/90 border-white/10 text-zinc-200 hover:bg-zinc-800"
                    )}
                  >
                    <div className="flex flex-col">
                      <span className="text-base font-bold">{t.name}</span>
                      {t.language && (
                        <span className="text-xs text-zinc-400">{t.language}</span>
                      )}
                    </div>
                    {isSelected && <Check className="w-5 h-5 text-rose-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
