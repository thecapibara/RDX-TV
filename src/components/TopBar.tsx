import React, { useState, useEffect } from "react";
import { Search, Settings } from "lucide-react";
import type { MirrorStatus } from "../types";
import { cn } from "../lib/utils";
import { playButtonClickSound } from "../services/sound";
import { api } from "../services/api";

export type NavTab =
  | "home"
  | "films"
  | "series"
  | "bookmarks"
  | "cartoons"
  | "animation"
  | "new";

interface TopBarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onOpenSearch: () => void;
  onOpenMirrorModal: () => void;
  onOpenSettings?: () => void;
  mirrorStatus: MirrorStatus | null;
  activeMirrorUrl: string;
}

const TABS: { id: NavTab; label: string }[] = [
  { id: "home", label: "Головна" },
  { id: "films", label: "Фільми" },
  { id: "series", label: "Серіали" },
  { id: "cartoons", label: "Мультфільми" },
  { id: "animation", label: "Аніме" },
  { id: "new", label: "Новинки" },
  { id: "bookmarks", label: "Закладки" },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onTabChange,
  onOpenSearch,
  onOpenMirrorModal,
  onOpenSettings,
  mirrorStatus,
  activeMirrorUrl,
}) => {
  const [timeString, setTimeString] = useState("");

  // Live TV Clock (HH:MM e.g. 23:47) with host system time synchronization
  useEffect(() => {
    let isMounted = true;
    const updateTime = () => {
      api
        .getSystemTime()
        .then((time) => {
          if (isMounted && time) setTimeString(time);
        })
        .catch(() => {
          const now = new Date();
          if (isMounted) {
            setTimeString(
              now.toLocaleTimeString("uk-UA", {
                hour: "2-digit",
                minute: "2-digit",
              })
            );
          }
        });
    };

    updateTime();
    const interval = setInterval(updateTime, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const mirrorHost = (() => {
    try {
      return new URL(activeMirrorUrl).hostname;
    } catch {
      return activeMirrorUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    }
  })();

  return (
    <header className="sticky top-0 z-40 w-full px-4 sm:px-6 lg:px-10 py-3.5 bg-[var(--bg-base,#000000)] border-b border-white/[0.06] flex items-center justify-between gap-4 sm:gap-6 select-none">
      {/* Left: Brand Wordmark & Responsive Android TV Navigation */}
      <div className="flex items-center gap-4 sm:gap-7 lg:gap-8 min-w-0">
        {/* Brand Wordmark */}
        <div
          onClick={() => {
            playButtonClickSound();
            onTabChange("home");
          }}
          className="flex items-baseline cursor-pointer group flex-shrink-0"
        >
          <span className="text-xl sm:text-2xl font-black tracking-tighter text-white group-hover:text-zinc-200 transition-colors">
            RDX-TV<span className="text-rose-500">.</span>
          </span>
        </div>

        {/* Navigation Tabs (px-1.5 py-1.5 prevents clipping TV focus rings) */}
        <nav data-tv-row="topbar" className="flex items-center gap-3 sm:gap-5 lg:gap-6 px-1.5 py-1.5 overflow-x-auto no-scrollbar">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                data-tv-focusable
                onClick={() => {
                  playButtonClickSound();
                  onTabChange(tab.id);
                }}
                className={cn(
                  "relative px-3.5 py-1.5 rounded-full text-xs sm:text-sm lg:text-[15px] tracking-wide transition-all duration-200 whitespace-nowrap cursor-pointer focus:outline-none focus:ring-2 focus:ring-rose-500 focus:bg-rose-600 focus:text-white",
                  isActive
                    ? "bg-white/12 text-white font-semibold"
                    : "text-zinc-400 font-medium hover:text-zinc-100"
                )}
              >
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right: Actions, Network Status & Clock */}
      <div data-tv-row="topbar" className="flex items-center gap-3 sm:gap-5 flex-shrink-0">
        {/* Minimal Search Button */}
        <button
          data-tv-focusable
          onClick={() => {
            playButtonClickSound();
            onOpenSearch();
          }}
          title="Пошук"
          className="text-zinc-300 hover:text-white transition-all cursor-pointer p-1.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 focus:bg-white/10 focus:text-white"
        >
          <Search className="w-5 h-5" />
        </button>

        {/* Minimal Mirror Status Button */}
        <button
          data-tv-focusable
          onClick={onOpenMirrorModal}
          title="Дзеркало HDRezka / Налаштування мережі"
          className="flex items-center gap-2 text-xs font-mono text-zinc-400 hover:text-zinc-200 transition-all cursor-pointer p-1.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 focus:bg-white/10 focus:text-white"
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full flex-shrink-0",
              mirrorStatus?.online
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                : mirrorStatus
                ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]"
                : "bg-emerald-400"
            )}
          />
          <span className="hidden xl:inline text-[13px]">{mirrorHost}</span>
        </button>

        {/* Settings Gear Button */}
        <button
          data-tv-focusable
          onClick={onOpenSettings || onOpenMirrorModal}
          title="Налаштування програми"
          className="text-zinc-300 hover:text-white transition-all cursor-pointer p-1.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 focus:bg-white/10 focus:text-white"
        >
          <Settings className="w-5 h-5" />
        </button>

        {/* Android TV Clock */}
        <span className="hidden lg:inline text-base sm:text-lg font-medium text-zinc-100 tracking-tight tabular-nums font-mono pl-1">
          {timeString}
        </span>
      </div>
    </header>
  );
};
