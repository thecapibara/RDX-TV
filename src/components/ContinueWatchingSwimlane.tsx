import React, { useState, useEffect, useRef } from "react";
import { History } from "lucide-react";
import type { WatchProgress, MediaCard } from "../types";
import { ContinueWatchingCard } from "./ContinueWatchingCard";
import { cn } from "../lib/utils";

interface ContinueWatchingSwimlaneProps {
  items: WatchProgress[];
  onResume: (item: WatchProgress) => void;
  onRemove: (mediaId: string) => void;
  onOpenDetails?: (card: MediaCard) => void;
  className?: string;
}

export const ContinueWatchingSwimlane: React.FC<ContinueWatchingSwimlaneProps> = React.memo(({
  items,
  onResume,
  onRemove,
  onOpenDetails,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(() => (items ? items.length > 3 : false));

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

  if (!items || items.length === 0) {
    return null;
  }

  return (
    <div className={cn("relative py-4 space-y-3 group/swimlane [contain:layout_style]", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-[clamp(1.25rem,4vw,4rem)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white shadow-sm">
            <History className="w-4 h-4" />
          </div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Продовжити перегляд
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30">
              {items.length}
            </span>
          </h2>
        </div>
      </div>

      {/* Track (TV D-pad auto-scrolls on focus; no floating mouse chevrons) */}
      <div className="relative">
        {/* Left Edge Vignette Fade */}
        {canScrollLeft && (
          <div className="absolute left-0 top-0 bottom-4 w-12 sm:w-20 z-20 pointer-events-none bg-gradient-to-r from-[var(--bg-base,#000000)] via-[var(--bg-base,#000000)]/70 to-transparent transition-opacity duration-200" />
        )}

        {/* Right Edge Vignette Fade */}
        {canScrollRight && (
          <div className="absolute right-0 top-0 bottom-4 w-12 sm:w-20 z-20 pointer-events-none bg-gradient-to-l from-[var(--bg-base,#000000)] via-[var(--bg-base,#000000)]/70 to-transparent transition-opacity duration-200" />
        )}

        {/* Horizontal Carousel Track */}
        <div
          ref={scrollRef}
          data-tv-row="continue-watching"
          onWheel={handleWheel}
          className="flex gap-4 overflow-x-auto px-[clamp(1.25rem,4vw,4rem)] pb-4 pt-2 no-scrollbar scroll-smooth"
          style={{
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
        >
          <div ref={startSentinelRef} className="w-px h-1 shrink-0 -mr-4 pointer-events-none opacity-0" aria-hidden="true" />
          {items.map((item) => (
            <ContinueWatchingCard
              key={item.media_id}
              item={item}
              onResume={onResume}
              onRemove={onRemove}
              onOpenDetails={onOpenDetails}
            />
          ))}
          <div ref={endSentinelRef} className="w-px h-1 shrink-0 -ml-4 pointer-events-none opacity-0" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
});
