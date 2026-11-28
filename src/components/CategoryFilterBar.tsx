import React, { useState, useEffect } from "react";
import { Check, X, Filter } from "lucide-react";
import { SORT_FILTERS, CATEGORY_GENRES } from "../constants/genres";
import { cn } from "../lib/utils";
import { playButtonClickSound, playBackSound } from "../services/sound";
import { focusFirstInScope, useTvBack } from "../hooks/useTvNavigation";

interface CategoryFilterBarProps {
  category: string; // "films" | "series" | "cartoons" | "animation" | "new"
  activeSort: string;
  onSortChange: (sortId: string) => void;
  activeGenre: string | null;
  onGenreChange: (genreId: string | null) => void;
}

export const CategoryFilterBar: React.FC<CategoryFilterBarProps> = ({
  category,
  activeSort,
  onSortChange,
  activeGenre,
  onGenreChange,
}) => {
  const [isGenreModalOpen, setIsGenreModalOpen] = useState(false);

  const availableGenres = CATEGORY_GENRES[category] || [];

  useTvBack(isGenreModalOpen, () => setIsGenreModalOpen(false));

  useEffect(() => {
    if (isGenreModalOpen) {
      const t = window.setTimeout(() => focusFirstInScope(), 30);
      return () => window.clearTimeout(t);
    }
  }, [isGenreModalOpen]);

  // Reset genre when switching categories if the genre isn't valid for the new category
  useEffect(() => {
    if (activeGenre && !availableGenres.some((g) => g.id === activeGenre)) {
      onGenreChange(null);
    }
  }, [category, activeGenre, availableGenres, onGenreChange]);

  const quickGenres = availableGenres.slice(0, 6);
  const activeGenreLabel = availableGenres.find((g) => g.id === activeGenre)?.label;

  return (
    <div className="w-full space-y-4 pt-1 pb-3 select-none">
      {/* 1. Sort Filter Pills */}
      <div data-tv-row="category-sort" className="flex flex-wrap items-center gap-2 sm:gap-2.5">
        {SORT_FILTERS.map((filter) => {
          const isActive = activeSort === filter.id;
          return (
            <button
              key={filter.id}
              data-tv-focusable
              onClick={() => {
                playButtonClickSound();
                onSortChange(filter.id);
              }}
              className={cn(
                "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                isActive
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-950/60 border border-rose-500"
                  : "bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10"
              )}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {/* 2. Quick Genre Chips + 10-Foot TV Genre Grid Modal Trigger */}
      {availableGenres.length > 0 && (
        <div data-tv-row="category-genres" className="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            data-tv-focusable
            onClick={() => {
              playButtonClickSound();
              onGenreChange(null);
            }}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
              activeGenre === null
                ? "bg-rose-600 text-white font-bold shadow-sm shadow-rose-600/30"
                : "bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white border border-white/10"
            )}
          >
            {category === "new" ? "Всі новинки" : "Всі жанри"}
          </button>

          {quickGenres.map((g) => {
            const isActive = activeGenre === g.id;
            return (
              <button
                key={g.id}
                data-tv-focusable
                onClick={() => {
                  playButtonClickSound();
                  onGenreChange(isActive ? null : g.id);
                }}
                className={cn(
                  "px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                  isActive
                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/50 font-semibold"
                    : "bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/5"
                )}
              >
                {g.label}
              </button>
            );
          })}

          {availableGenres.length > quickGenres.length && (
            <button
              data-tv-focusable
              onClick={() => {
                playButtonClickSound();
                setIsGenreModalOpen(true);
              }}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                activeGenre && !quickGenres.some((g) => g.id === activeGenre)
                  ? "bg-rose-600/30 text-rose-200 border-rose-500/60"
                  : "bg-zinc-900/90 hover:bg-zinc-800 text-zinc-200 hover:text-white border-white/15"
              )}
            >
              <Filter className="w-3.5 h-3.5 text-rose-400" />
              <span>
                {activeGenre && !quickGenres.some((g) => g.id === activeGenre)
                  ? activeGenreLabel
                  : "Усі жанри"}
              </span>
            </button>
          )}
        </div>
      )}

      {/* 3. Full 10-Foot TV Genre Grid Modal (D-pad friendly, zero keyboard input needed) */}
      {isGenreModalOpen && (
        <div
          data-tv-scope="modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              playBackSound();
              setIsGenreModalOpen(false);
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 sm:p-10"
        >
          <div className="w-full max-w-4xl max-h-[82vh] rounded-3xl bg-zinc-950 border border-white/15 shadow-2xl p-6 sm:p-8 flex flex-col gap-5 overflow-hidden rdx-anim-modal">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Filter className="w-5 h-5 text-rose-500" />
                <h2 className="text-xl font-black text-white">Вибір жанру</h2>
              </div>
              <button
                data-tv-focusable
                onClick={() => {
                  playBackSound();
                  setIsGenreModalOpen(false);
                }}
                className="p-2.5 rounded-xl bg-zinc-900 border border-white/10 text-zinc-300 hover:text-white cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
                title="Закрити"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto no-scrollbar pr-1">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                <button
                  data-tv-focusable
                  data-tv-autofocus={activeGenre === null || undefined}
                  onClick={() => {
                    playButtonClickSound();
                    onGenreChange(null);
                    setIsGenreModalOpen(false);
                  }}
                  className={cn(
                    "flex items-center justify-between px-4 py-3.5 rounded-2xl border text-sm font-bold text-left cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                    activeGenre === null
                      ? "bg-rose-600 border-rose-500 text-white"
                      : "bg-zinc-900 border-white/10 text-zinc-200 hover:bg-zinc-800"
                  )}
                >
                  <span>Всі жанри</span>
                  {activeGenre === null && <Check className="w-4 h-4 shrink-0" />}
                </button>

                {availableGenres.map((g) => {
                  const isSelected = activeGenre === g.id;
                  return (
                    <button
                      key={g.id}
                      data-tv-focusable
                      data-tv-autofocus={isSelected || undefined}
                      onClick={() => {
                        playButtonClickSound();
                        onGenreChange(g.id);
                        setIsGenreModalOpen(false);
                      }}
                      className={cn(
                        "flex items-center justify-between px-4 py-3.5 rounded-2xl border text-sm font-semibold text-left cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                        isSelected
                          ? "bg-rose-600 border-rose-500 text-white font-bold"
                          : "bg-zinc-900 border-white/10 text-zinc-200 hover:bg-zinc-800"
                      )}
                    >
                      <span className="truncate">{g.label}</span>
                      {isSelected && <Check className="w-4 h-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
