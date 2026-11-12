import React, { useState, useEffect, useRef } from "react";
import { Search, X, Loader2, Keyboard, Delete } from "lucide-react";
import type { MediaCard } from "../types";
import { api } from "../services/api";
import { MediaCard as MediaCardComponent } from "./MediaCard";
import { focusFirstInScope, useTvBack } from "../hooks/useTvNavigation";

const TV_KB_ROWS_UA = [
  ["й", "ц", "у", "к", "е", "н", "г", "ш", "щ", "з", "х", "ї"],
  ["ф", "і", "в", "а", "п", "р", "о", "л", "д", "ж", "є", "ґ"],
  ["я", "ч", "с", "м", "и", "т", "ь", "б", "ю", "1", "2", "3"],
  ["4", "5", "6", "7", "8", "9", "0", "-", ":"],
];

const TV_KB_ROWS_EN = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "1", "2"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "3", "4", "5"],
  ["z", "x", "c", "v", "b", "n", "m", "6", "7", "8", "9", "0"],
];

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectMedia: (card: MediaCard) => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  onSelectMedia,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [showTvKeyboard, setShowTvKeyboard] = useState(false);
  const [kbLang, setKbLang] = useState<"ua" | "en">("ua");
  const inputRef = useRef<HTMLInputElement>(null);

  useTvBack(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => {
        focusFirstInScope();
      }, 50);
      return () => clearTimeout(t);
    } else {
      setQuery("");
      setResults([]);
      setLoading(false);
    }
  }, [isOpen]);

  // Live search debounced 350ms
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const items = await api.searchMedia(query.trim());
        setResults(items);
      } catch (err) {
        console.error("Search media error:", err);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      const prevBodyOverflow = document.body.style.overflow;
      const prevHtmlOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";

      return () => {
        document.body.style.overflow = prevBodyOverflow;
        document.documentElement.style.overflow = prevHtmlOverflow;
      };
    }
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    // Samsung Tizen IME Done (65376) / Cancel (65385)
    if (e.keyCode === 65376 || e.keyCode === 65385) {
      e.preventDefault();
      inputRef.current?.blur();
      focusFirstInScope();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      data-modal-open="true"
      data-tv-scope="modal"
      className="fixed inset-0 z-50 bg-[var(--bg-base,#000000)]/98 flex flex-col overflow-y-auto select-none backdrop-blur-md transition-colors duration-250"
    >
      {/* Top Search Input Bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        data-tv-row="search-header"
        className="sticky top-0 z-20 w-full bg-[var(--bg-base,#000000)]/90 border-b border-white/10 px-[clamp(1.5rem,5vw,5rem)] py-6 flex items-center justify-between gap-6 backdrop-blur-md transition-colors duration-250"
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <Search className="w-6 h-6 text-rose-500 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            data-tv-focusable
            data-tv-autofocus
            placeholder="Введіть назву фільму або серіалу..."
            className="w-full bg-transparent text-xl sm:text-2xl font-bold text-white placeholder-zinc-500 rounded-xl px-2 py-1 focus:outline-none focus:ring-4 focus:ring-rose-500"
          />
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {loading && <Loader2 className="w-5 h-5 text-rose-500 animate-spin" />}
          <button
            onClick={() => setShowTvKeyboard((v) => !v)}
            data-tv-focusable
            title="Екранна ТВ-клавіатура"
            className={`px-3 py-2 rounded-xl flex items-center gap-2 text-sm font-bold transition-colors cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500 ${
              showTvKeyboard
                ? "bg-rose-600 text-white"
                : "bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white"
            }`}
          >
            <Keyboard className="w-5 h-5" />
            <span className="hidden sm:inline">Клавіатура</span>
          </button>
          {query && !loading && (
            <button
              onClick={() => setQuery("")}
              data-tv-focusable
              className="p-2 rounded-full hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
            >
              <X className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={onClose}
            data-tv-focusable
            className="p-2 rounded-full bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white transition-colors cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Built-in D-pad TV On-Screen Keyboard (UA / EN) */}
      {showTvKeyboard && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full px-[clamp(1.5rem,5vw,5rem)] py-4 bg-zinc-950/90 border-b border-white/10 space-y-2"
        >
          {(kbLang === "ua" ? TV_KB_ROWS_UA : TV_KB_ROWS_EN).map((row, rIdx) => (
            <div key={rIdx} data-tv-row={`kb-${rIdx}`} className="flex flex-wrap gap-1.5 justify-center">
              {row.map((ch) => (
                <button
                  key={ch}
                  onClick={() => setQuery((q) => q + ch)}
                  data-tv-focusable
                  className="min-w-[2.6rem] h-10 px-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-base uppercase transition-colors cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
                >
                  {ch}
                </button>
              ))}
            </div>
          ))}
          <div data-tv-row="kb-actions" className="flex flex-wrap gap-2 justify-center pt-1">
            <button
              onClick={() => setKbLang((l) => (l === "ua" ? "en" : "ua"))}
              data-tv-focusable
              className="h-10 px-4 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-sm cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
            >
              {kbLang === "ua" ? "UA → EN" : "EN → UA"}
            </button>
            <button
              onClick={() => setQuery((q) => q + " ")}
              data-tv-focusable
              className="h-10 px-10 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-sm cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
            >
              ПРОБІЛ
            </button>
            <button
              onClick={() => setQuery((q) => q.slice(0, -1))}
              data-tv-focusable
              className="h-10 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-sm flex items-center gap-1.5 cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
            >
              <Delete className="w-4 h-4" />
              Стерти
            </button>
            <button
              onClick={() => setQuery("")}
              data-tv-focusable
              className="h-10 px-4 rounded-xl bg-rose-500/20 hover:bg-rose-500/35 text-rose-300 font-bold text-sm cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
            >
              Очистити
            </button>
          </div>
        </div>
      )}

      {/* Results Container with Fluid Responsive Grid */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full px-[clamp(1.5rem,5vw,5rem)] py-8 flex-1"
      >
        {results.length > 0 ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-wider">
                Результати пошуку ({results.length})
              </h2>
            </div>

            {/* Poster Cards Grid with Real Posters */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(185px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-5">
              {results.map((card) => (
                <MediaCardComponent
                  key={card.id || card.url}
                  card={card}
                  onSelect={(c) => {
                    onSelectMedia(c);
                    onClose();
                  }}
                />
              ))}
            </div>
          </div>
        ) : query.trim().length >= 2 && !loading ? (
          <div className="py-24 text-center space-y-2">
            <h3 className="text-lg font-bold text-zinc-200">
              Нічого не знайдено
            </h3>
            <p className="text-xs text-zinc-400">
              За запитом «{query}» результатів не знайдено. Спробуйте іншу назву.
            </p>
          </div>
        ) : (
          <div className="py-28 text-center text-zinc-500 text-sm">
            Почніть вводити назву для миттєвого пошуку серед тисяч фільмів та серіалів
          </div>
        )}
      </div>
    </div>
  );
};
