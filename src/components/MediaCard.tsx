import React, { useState } from "react";
import { Play, Star, Loader2 } from "lucide-react";
import type { MediaCard as MediaCardType } from "../types";
import { cn } from "../lib/utils";
import { playHoverSound } from "../services/sound";
import { ukrainizeMiscInfo, ukrainizeSeriesInfo } from "../utils/ukrainize";

interface MediaCardProps {
  card: MediaCardType;
  onSelect: (card: MediaCardType) => void;
  onPlayDirect?: (card: MediaCardType) => void;
  className?: string;
}

export const MediaCard: React.FC<MediaCardProps> = React.memo(({
  card,
  onSelect,
  onPlayDirect,
  className,
}) => {
  const [isLoading, setIsLoading] = useState(false);

  const handlePlayClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLoading) return;
    if (onPlayDirect) {
      setIsLoading(true);
      try {
        await onPlayDirect(card);
      } finally {
        setTimeout(() => setIsLoading(false), 5000);
      }
    } else {
      onSelect(card);
    }
  };

  const entityType = card.entity_type?.toLowerCase() || "";
  let typeLabel = "Фільм";
  let typeBadgeClass = "bg-indigo-600 text-white";

  if (entityType.includes("series") || entityType.includes("серіал") || card.series_info) {
    typeLabel = "Серіал";
    typeBadgeClass = "bg-rose-600 text-white";
  } else if (entityType.includes("anime") || entityType.includes("аніме")) {
    typeLabel = "Аніме";
    typeBadgeClass = "bg-purple-600 text-white";
  } else if (entityType.includes("cartoon") || entityType.includes("мульт")) {
    typeLabel = "Мультфільм";
    typeBadgeClass = "bg-emerald-600 text-white";
  }

  return (
    <div
      tabIndex={0}
      role="button"
      data-tv-focusable
      onClick={() => onSelect(card)}
      onFocus={playHoverSound}
      onMouseEnter={playHoverSound}
      className={cn(
        "group relative flex flex-col cursor-pointer select-none focus:outline-none rounded-2xl transition-transform duration-150 focus:scale-[1.04] focus:z-10 [contain:layout_style]",
        className
      )}
    >
      {/* Poster 2:3 container — flat single-layer composite on idle, hardware scale on focus/hover */}
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl bg-zinc-900 border border-white/10 group-hover:border-rose-500/50 group-focus:border-rose-500 group-focus:ring-4 group-focus:ring-rose-500/70 transition-all duration-150 ease-out group-hover:scale-[1.025] transform-gpu">
        <img
          src={card.poster}
          alt={card.title}
          draggable={false}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover pointer-events-none select-none"
          onError={(e) => {
            e.currentTarget.onerror = null;
            (e.currentTarget as HTMLImageElement).src =
              "data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22200%22%20height%3D%22300%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20fill%3D%22%2318181b%22%20width%3D%22200%22%20height%3D%22300%22%2F%3E%3Ctext%20fill%3D%22%2371717a%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%3ERDX%3C%2Ftext%3E%3C%2Fsvg%3E";
          }}
        />

        {/* Top Badges Row */}
        <div className="absolute top-2.5 inset-x-2.5 z-10 pointer-events-none flex items-start justify-between gap-1.5">
          <span
            className={cn(
              "px-2 py-0.5 rounded-md text-[11px] font-bold tracking-wide uppercase shadow-sm shrink-0",
              typeBadgeClass
            )}
          >
            {typeLabel}
          </span>
          {card.series_info && (
            <span className="bg-zinc-950/90 px-2 py-0.5 rounded-md text-[11px] font-semibold text-zinc-200 border border-white/10 truncate shadow-sm min-w-0">
              {ukrainizeSeriesInfo(card.series_info)}
            </span>
          )}
        </div>

        {/* Center Hover Action */}
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10 pointer-events-none">
          <button
            onClick={handlePlayClick}
            className="w-12 h-12 rounded-full bg-rose-600 text-white flex items-center justify-center pointer-events-auto hover:bg-rose-500 active:scale-95 cursor-pointer shadow-lg shadow-rose-950/60"
            title="Дивитися зараз"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Play className="w-5 h-5 fill-current ml-0.5" />
            )}
          </button>
        </div>

        {/* Bottom-Right Badge: Rating */}
        {card.rating && (
          <div className="absolute bottom-2.5 right-2.5 z-10 pointer-events-none">
            <div className="flex items-center gap-1 bg-zinc-950/90 px-2 py-0.5 rounded-lg text-xs font-bold text-amber-400 border border-white/10 shadow-sm">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              <span>{card.rating}</span>
            </div>
          </div>
        )}
      </div>

      {/* Metadata Below Poster */}
      <div className="mt-2.5 px-0.5 flex flex-col space-y-0.5">
        <h3 className="font-semibold text-sm text-zinc-100 leading-snug line-clamp-1 group-hover:text-rose-400">
          {card.title}
        </h3>
        <p className="text-xs text-zinc-400 line-clamp-1">
          {ukrainizeMiscInfo(card.misc_info) || "HDRezka"}
        </p>
      </div>
    </div>
  );
});
