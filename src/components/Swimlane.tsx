import React, { useState, useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";
import type { MediaCard as MediaCardType } from "../types";
import { MediaCard } from "./MediaCard";
import { cn } from "../lib/utils";
import { playButtonClickSound } from "../services/sound";

interface SwimlaneProps {
  title: string;
  subtitle?: string;
  badge?: string;
  items: MediaCardType[];
  onSelectCard: (card: MediaCardType) => void;
  onPlayDirect?: (card: MediaCardType) => void;
  onMoreClick?: () => void;
  className?: string;
  loading?: boolean;
}

export const Swimlane: React.FC<SwimlaneProps> = React.memo(({
  title,
  subtitle,
  badge,
  items,
  onSelectCard,
  onPlayDirect,
  onMoreClick,
  className,
  loading,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(() => (items ? items.length > 5 : true));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Zero-overhead boundary tracking via IntersectionObserver (no synchronous layout thrashing)
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === startSentinelRef.current) {
            setCanScrollLeft(!entry.isIntersecting);
          } else if (entry.target === endSentinelRef.current) {
            setCanScrollRight(!entry.isIntersecting);
          }
        }
      },
      {
        root: el,
        threshold: 0.1,
      }
    );

    if (startSentinelRef.current) observer.observe(startSentinelRef.current);
    if (endSentinelRef.current) observer.observe(endSentinelRef.current);

    return () => {
      observer.disconnect();
    };
  }, [items]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!scrollRef.current) return;
    if ((e.shiftKey && e.deltaY !== 0) || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      scrollRef.current.scrollLeft += e.deltaY || e.deltaX;
    }
  };

  if (loading && (!items || items.length === 0)) {
    return (
      <div
        data-testid="swimlane-skeleton"
        className={cn("relative py-4 space-y-3 group/swimlane [contain:layout_style]", className)}
      >
        {/* Swimlane Header */}
        <div className="flex items-center justify-between px-[clamp(1.25rem,4vw,4rem)]">
          <div className="flex items-center gap-3">
            {title ? (
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                {title}
                {badge && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30">
                    {badge}
                  </span>
                )}
              </h2>
            ) : (
              <div className="h-7 w-48 rounded-xl bg-zinc-800/80 animate-pulse" />
            )}
            {subtitle && (
              <span className="hidden sm:inline-block text-xs text-zinc-400 font-medium">
                • {subtitle}
              </span>
            )}
          </div>
        </div>

        {/* 7 skeleton cards */}
        <div
          className="flex gap-4 overflow-x-hidden px-[clamp(1.25rem,4vw,4rem)] pb-4 pt-1"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="w-40 sm:w-44 md:w-48 flex-shrink-0 space-y-2.5">
              <div className="aspect-[2/3] w-full rounded-2xl bg-zinc-900/80 border border-white/5 overflow-hidden relative animate-pulse bg-gradient-to-tr from-zinc-900 via-zinc-800/60 to-zinc-900" />
              <div className="h-3.5 w-3/4 rounded-md bg-zinc-800/80 animate-pulse" />
              <div className="h-2.5 w-1/2 rounded-md bg-zinc-900/80 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return null;
  }

  return (
    <div className={cn("relative py-4 space-y-3 group/swimlane [contain:layout_style]", className)}>
      {/* Swimlane Header */}
      <div className="flex items-center justify-between px-[clamp(1.25rem,4vw,4rem)]">
        <div className="flex items-center gap-3">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            {title}
            {badge && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30">
                {badge}
              </span>
            )}
          </h2>
          {subtitle && (
            <span className="hidden sm:inline-block text-xs text-zinc-400 font-medium">
              • {subtitle}
            </span>
          )}
        </div>

        {onMoreClick && (
          <button
            data-tv-focusable
            onClick={() => {
              playButtonClickSound();
              onMoreClick();
            }}
            className="text-xs font-semibold text-zinc-400 hover:text-white flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:text-white transition-all cursor-pointer"
          >
            <span>Більше</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Horizontal Carousel Track (TV D-pad auto-scrolls on focus; no floating mouse chevrons) */}
      <div className="relative group/track">
        {/* Left Edge Vignette Fade */}
        {canScrollLeft && (
          <div className="absolute left-0 top-0 bottom-4 w-12 sm:w-20 z-20 pointer-events-none bg-gradient-to-r from-[var(--bg-base,#000000)] via-[var(--bg-base,#000000)]/70 to-transparent transition-opacity duration-200" />
        )}

        {/* Right Edge Vignette Fade */}
        {canScrollRight && (
          <div className="absolute right-0 top-0 bottom-4 w-12 sm:w-20 z-20 pointer-events-none bg-gradient-to-l from-[var(--bg-base,#000000)] via-[var(--bg-base,#000000)]/70 to-transparent transition-opacity duration-200" />
        )}

        {/* Carousel Track */}
        <div
          ref={scrollRef}
          data-tv-row={title}
          onWheel={handleWheel}
          className="flex gap-4 overflow-x-auto px-[clamp(1.25rem,4vw,4rem)] pb-4 pt-2 no-scrollbar scroll-smooth"
          style={{
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
        >
          <div ref={startSentinelRef} className="w-px h-1 shrink-0 -mr-4 pointer-events-none opacity-0" aria-hidden="true" />
          {items.map((card) => (
            <div key={card.id || card.url} className="w-40 sm:w-44 md:w-48 flex-shrink-0">
              <MediaCard
                card={card}
                onSelect={onSelectCard}
                onPlayDirect={onPlayDirect}
              />
            </div>
          ))}
          <div ref={endSentinelRef} className="w-px h-1 shrink-0 -ml-4 pointer-events-none opacity-0" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
});
