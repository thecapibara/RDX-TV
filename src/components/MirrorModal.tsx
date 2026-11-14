import React, { useState, useEffect, useMemo } from "react";
import { UaFlag } from "./UaFlag";
import {
  X,
  Server,
  Plus,
  RefreshCw,
  Check,
  Loader2,
  Shield,
  Shuffle,
  Trash2,
  Film,
  Info,
  Crown,
  Volume2,
  Sliders,
  Palette,
  Moon,
  Globe,
  Play,
  Sparkles,
} from "lucide-react";
import type { AppSettings, MirrorStatus } from "../types";
import { api } from "../services/api";
import { cn } from "../lib/utils";
import {
  getUiSoundsEnabled,
  setUiSoundsEnabled,
  playButtonClickSound,
} from "../services/sound";
import {
  getAccentColor,
  setAccentColor,
  getBgTheme,
  setBgTheme,
  ACCENT_OPTIONS,
  type AccentColor,
  type BgTheme,
} from "../services/theme";
import { focusFirstInScope, useTvBack } from "../hooks/useTvNavigation";

interface MirrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMirrorChanged: (newMirror: string) => void;
  onCheckUpdates?: () => Promise<boolean> | boolean | void;
}

const APP_VERSION = "1.1.2";

const PRESET_MIRRORS = [
  "https://rezka-tv.org",
  "https://hdrezka.me",
  "https://hdrezka.kim",
  "https://rezka.pub",
  "https://rezka.ag",
  "https://hdrezka.sh",
];

const QUALITY_OPTIONS = [
  { id: "1080p Ultra", label: "1080p Ultra", premium: true },
  { id: "1080p", label: "1080p", premium: false },
  { id: "720p", label: "720p", premium: false },
  { id: "480p", label: "480p", premium: false },
  { id: "360p", label: "360p", premium: false },
];

const TRANSLATOR_OPTIONS = [
  { id: "", label: "Авто (Українська пріоритет)" },
  { id: "Цікава Ідея", label: "Цікава Ідея", isUkr: true },
  { id: "НеЗупиняйСкорочення", label: "НеЗупиняйСкорочення", isUkr: true },
  { id: "DniproFilm", label: "DniproFilm", isUkr: true },
  { id: "Original", label: "Оригінал (EN)" },
];

const TvSwitch: React.FC<{
  checked: boolean;
  onToggle: () => void;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = ({ checked, onToggle, label, description, icon }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    data-tv-focusable
    onClick={() => {
      playButtonClickSound();
      onToggle();
    }}
    className="w-full flex items-center justify-between gap-6 p-5 rounded-2xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-left transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500 focus:bg-white/[0.1]"
  >
    <div className="flex items-center gap-4 min-w-0">
      <div className="w-11 h-11 rounded-xl bg-rose-500/15 border border-rose-500/25 flex items-center justify-center text-rose-400 shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-base font-bold text-white">{label}</div>
        <div className="text-sm text-zinc-400 mt-0.5 leading-snug">{description}</div>
      </div>
    </div>

    <div
      className={cn(
        "w-14 h-8 rounded-full p-1 transition-colors shrink-0 flex items-center",
        checked ? "bg-rose-600 justify-end" : "bg-zinc-700 justify-start"
      )}
    >
      <div className="w-6 h-6 rounded-full bg-white shadow-md" />
    </div>
  </button>
);

export const MirrorModal: React.FC<MirrorModalProps> = ({
  isOpen,
  onClose,
  onMirrorChanged,
  onCheckUpdates,
}) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeTab, setActiveTab] = useState<"network" | "playback" | "appearance" | "about">(
    "network"
  );
  const [preferredQuality, setPreferredQuality] = useState<string>("720p");
  const [preferredTranslator, setPreferredTranslator] = useState<string>("");
  const [customInput, setCustomInput] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const [testingStatus, setTestingStatus] = useState<Record<string, MirrorStatus>>({});
  const [testing, setTesting] = useState(false);
  const [smartRotating, setSmartRotating] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<string | null>(null);

  const [mirrorAutopilot, setMirrorAutopilot] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rdx_mirror_autopilot") !== "false";
    } catch {
      return true;
    }
  });
  const [autoplayNext, setAutoplayNext] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rdx_autoplay_next") !== "false";
    } catch {
      return true;
    }
  });
  const [startupSound, setStartupSound] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rdx_startup_sound") !== "false";
    } catch {
      return true;
    }
  });
  const [uiSounds, setUiSounds] = useState<boolean>(() => getUiSoundsEnabled());
  const [accentColor, setAccentColorState] = useState<AccentColor>(() => getAccentColor());
  const [bgTheme, setBgThemeState] = useState<BgTheme>(() => getBgTheme());

  useTvBack(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        setProxyInput(s.proxy_url || "");
        setPreferredQuality(s.preferred_quality || "720p");
        setPreferredTranslator(s.preferred_translator || "");
        if (s.startup_sound !== undefined) setStartupSound(s.startup_sound);
        if (s.autoplay_next !== undefined) setAutoplayNext(s.autoplay_next);
      })
      .catch(() => {});

    const t = setTimeout(() => focusFirstInScope(), 60);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [isOpen]);

  const allMirrors = useMemo(() => {
    const base = new Set(PRESET_MIRRORS);
    if (settings?.active_mirror) base.add(settings.active_mirror);
    settings?.custom_mirrors?.forEach((m) => base.add(m));
    return Array.from(base);
  }, [settings]);

  const handleTestAll = async () => {
    setTesting(true);
    try {
      const results = await api.checkAllMirrors(allMirrors);
      const map: Record<string, MirrorStatus> = {};
      results.forEach((r) => {
        map[r.mirror_url] = r;
      });
      setTestingStatus(map);
    } catch (e) {
      console.error(e);
    } finally {
      setTesting(false);
    }
  };

  const handleSmartRotate = async () => {
    setSmartRotating(true);
    try {
      const res = await api.smartSelectMirror(true);
      const map: Record<string, MirrorStatus> = {};
      res.statuses.forEach((r) => {
        map[r.mirror_url] = r;
      });
      setTestingStatus(map);
      if (settings) {
        setSettings({ ...settings, active_mirror: res.selected_mirror });
      }
      onMirrorChanged(res.selected_mirror);
    } catch (e) {
      console.error(e);
    } finally {
      setSmartRotating(false);
    }
  };

  const handleSelectMirror = async (url: string) => {
    await api.setActiveMirror(url);
    if (settings) setSettings({ ...settings, active_mirror: url });
    onMirrorChanged(url);
  };

  const handleAddCustomMirror = async () => {
    const trimmed = customInput.trim().replace(/\/+$/, "");
    if (!trimmed || !settings) return;
    const normalized = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
    const updatedCustom = Array.from(new Set([...(settings.custom_mirrors || []), normalized]));
    const next = { ...settings, custom_mirrors: updatedCustom, active_mirror: normalized };
    await api.updateSettings(next);
    setSettings(next);
    setCustomInput("");
    onMirrorChanged(normalized);
  };

  const handleRemoveCustomMirror = async (url: string) => {
    if (!settings) return;
    const updatedCustom = (settings.custom_mirrors || []).filter((m) => m !== url);
    const nextActive =
      settings.active_mirror === url ? PRESET_MIRRORS[0] : settings.active_mirror;
    const next = { ...settings, custom_mirrors: updatedCustom, active_mirror: nextActive };
    await api.updateSettings(next);
    setSettings(next);
    if (nextActive !== settings.active_mirror) onMirrorChanged(nextActive);
  };

  const handleSaveProxy = async () => {
    if (!settings) return;
    setSavingProxy(true);
    try {
      const next = { ...settings, proxy_url: proxyInput.trim() };
      await api.updateSettings(next);
      setSettings(next);
    } finally {
      setSavingProxy(false);
    }
  };

  const handleQualityChange = async (q: string) => {
    setPreferredQuality(q);
    try {
      localStorage.setItem("rdx_preferred_quality", q);
    } catch {}
    if (settings) {
      const next = { ...settings, preferred_quality: q };
      setSettings(next);
      await api.updateSettings(next).catch(() => {});
    }
  };

  const handleTranslatorChange = async (t: string) => {
    setPreferredTranslator(t);
    try {
      localStorage.setItem("rdx_preferred_translator", t);
    } catch {}
    if (settings) {
      const next = { ...settings, preferred_translator: t };
      setSettings(next);
      await api.updateSettings(next).catch(() => {});
    }
  };

  const handleManualUpdateCheck = async () => {
    setIsCheckingUpdates(true);
    setUpdateCheckResult(null);
    try {
      if (onCheckUpdates) {
        const found = await onCheckUpdates();
        setUpdateCheckResult(
          found
            ? "Знайдено нову версію!"
            : `У вас найновіша версія (v${APP_VERSION})`
        );
        return;
      }
      const res = await fetch("https://api.github.com/repos/thecapibara/RDX-TV/releases/latest", {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        setUpdateCheckResult(`Актуальна версія (v${APP_VERSION})`);
        return;
      }
      const data = (await res.json()) as { tag_name?: string };
      const latest = (data.tag_name || "").replace(/^v/, "");
      if (latest && latest !== APP_VERSION) {
        setUpdateCheckResult(`Доступна версія v${latest} на GitHub Releases`);
      } else {
        setUpdateCheckResult(`У вас найновіша версія (v${APP_VERSION})`);
      }
    } catch {
      setUpdateCheckResult(`Актуальна версія (v${APP_VERSION})`);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  if (!isOpen) return null;

  const navItems: Array<{
    id: "network" | "playback" | "appearance" | "about";
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: "network", label: "Мережа та дзеркала", icon: <Globe className="w-5 h-5" /> },
    { id: "playback", label: "Відтворення", icon: <Play className="w-5 h-5" /> },
    { id: "appearance", label: "Вигляд і звук", icon: <Palette className="w-5 h-5" /> },
    { id: "about", label: "Про RDX-TV", icon: <Info className="w-5 h-5" /> },
  ];

  return (
    <div
      data-modal-open="true"
      data-tv-scope="modal"
      className="fixed inset-0 z-50 bg-[#070709]/98 flex text-white select-none"
    >
      {/* Left 10-foot Android TV Sidebar */}
      <aside className="w-72 lg:w-80 bg-zinc-950/90 border-r border-white/10 p-6 flex flex-col justify-between shrink-0">
        <div className="space-y-8">
          {/* Brand Header */}
          <div className="flex items-center gap-3.5 px-2">
            <img
              src="/icon-tv.png"
              alt="RDX-TV"
              className="w-11 h-11 rounded-2xl object-contain shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xl font-black tracking-tight text-white">
                  RDX-TV<span className="text-rose-500">.</span>
                </span>
                <span className="px-2 py-0.5 rounded-full bg-white/10 text-[11px] font-mono font-semibold text-zinc-300">
                  v{APP_VERSION}
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">Налаштування телевізора</p>
            </div>
          </div>

          {/* Vertical D-Pad Navigation Categories */}
          <nav className="space-y-2">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-tv-focusable
                  data-tv-autofocus={active ? "true" : undefined}
                  onClick={() => {
                    playButtonClickSound();
                    setActiveTab(item.id);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3.5 px-4 py-4 rounded-2xl text-left text-base font-bold transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                    active
                      ? "bg-rose-600 text-white shadow-lg shadow-rose-600/25"
                      : "bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] hover:text-white"
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Close Action */}
        <button
          type="button"
          data-tv-focusable
          onClick={() => {
            playButtonClickSound();
            onClose();
          }}
          className="w-full flex items-center justify-center gap-2.5 px-4 py-3.5 rounded-2xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-zinc-200 font-bold text-sm transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
        >
          <X className="w-5 h-5" />
          <span>Закрити (Back)</span>
        </button>
      </aside>

      {/* Right Spacious TV Content Pane */}
      <main className="flex-1 overflow-y-auto p-8 lg:p-12">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* ================= TAB 1: NETWORK & MIRRORS ================= */}
          {activeTab === "network" && (
            <>
              <div>
                <h2 className="text-2xl font-black text-white">Мережа та дзеркала HDRezka</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Оберіть активне дзеркало або запустіть автоматичний пошук найшвидшого сервера.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  data-tv-focusable
                  disabled={smartRotating}
                  onClick={() => {
                    playButtonClickSound();
                    handleSmartRotate();
                  }}
                  className="flex items-center gap-2.5 px-5 py-3.5 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm transition-all cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-rose-400"
                >
                  {smartRotating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Shuffle className="w-4 h-4" />
                  )}
                  <span>Розумний підбір дзеркала</span>
                </button>

                <button
                  type="button"
                  data-tv-focusable
                  disabled={testing}
                  onClick={() => {
                    playButtonClickSound();
                    handleTestAll();
                  }}
                  className="flex items-center gap-2.5 px-5 py-3.5 rounded-2xl bg-white/[0.07] hover:bg-white/[0.14] border border-white/10 text-white font-bold text-sm transition-all cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-rose-500"
                >
                  {testing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  <span>Перевірити всі</span>
                </button>
              </div>

              <TvSwitch
                checked={mirrorAutopilot}
                onToggle={() => {
                  const next = !mirrorAutopilot;
                  setMirrorAutopilot(next);
                  try {
                    localStorage.setItem("rdx_mirror_autopilot", next ? "true" : "false");
                  } catch {}
                }}
                label="Авторотація дзеркал"
                description="Автоматично перемикатись на робоче дзеркало при збої або блокуванні"
                icon={<Sparkles className="w-5 h-5" />}
              />

              {/* Mirror List */}
              <div className="space-y-2.5">
                <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 px-1">
                  Доступні дзеркала
                </div>
                {allMirrors.map((mirror) => {
                  const isActive = settings?.active_mirror === mirror;
                  const status = testingStatus[mirror];
                  const isCustom = !PRESET_MIRRORS.includes(mirror);
                  return (
                    <div key={mirror} className="flex items-center gap-2.5">
                      <button
                        type="button"
                        data-tv-focusable
                        onClick={() => {
                          playButtonClickSound();
                          handleSelectMirror(mirror);
                        }}
                        className={cn(
                          "flex-1 flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border text-left transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                          isActive
                            ? "bg-rose-600/15 border-rose-500/50 text-white"
                            : "bg-white/[0.04] hover:bg-white/[0.08] border-white/10 text-zinc-200"
                        )}
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <Server
                            className={cn(
                              "w-5 h-5 shrink-0",
                              isActive ? "text-rose-400" : "text-zinc-400"
                            )}
                          />
                          <span className="font-mono text-base font-semibold truncate">
                            {mirror}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          {status && (
                            <span
                              className={cn(
                                "px-2.5 py-1 rounded-lg text-xs font-mono font-semibold",
                                status.online
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-rose-500/15 text-rose-300"
                              )}
                            >
                              {status.online ? `${status.latency_ms} ms` : "Офлайн"}
                            </span>
                          )}
                          {isActive && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-600 text-white text-xs font-bold">
                              <Check className="w-3.5 h-3.5" /> Активне
                            </span>
                          )}
                        </div>
                      </button>

                      {isCustom && (
                        <button
                          type="button"
                          data-tv-focusable
                          onClick={() => {
                            playButtonClickSound();
                            handleRemoveCustomMirror(mirror);
                          }}
                          title="Видалити дзеркало"
                          className="p-4 rounded-2xl bg-white/[0.04] hover:bg-rose-600/20 border border-white/10 text-zinc-400 hover:text-rose-400 cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add Custom Mirror */}
              <div className="p-5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-3">
                <div className="text-sm font-bold text-white">Додати власне дзеркало</div>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={customInput}
                    onChange={(e) => setCustomInput(e.target.value)}
                    data-tv-focusable
                    placeholder="https://example-rezka.org"
                    className="flex-1 px-4 py-3 rounded-xl bg-zinc-950 border border-white/15 text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-4 focus:ring-rose-500"
                  />
                  <button
                    type="button"
                    data-tv-focusable
                    onClick={() => {
                      playButtonClickSound();
                      handleAddCustomMirror();
                    }}
                    className="flex items-center gap-2 px-5 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-400"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Додати</span>
                  </button>
                </div>
              </div>

              {/* Proxy */}
              <div className="p-5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-3">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <Shield className="w-4 h-4 text-zinc-400" />
                  <span>HTTP / SOCKS5 Проксі (Опціонально)</span>
                </div>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={proxyInput}
                    onChange={(e) => setProxyInput(e.target.value)}
                    data-tv-focusable
                    placeholder="socks5://127.0.0.1:9050 або http://host:port"
                    className="flex-1 px-4 py-3 rounded-xl bg-zinc-950 border border-white/15 text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-4 focus:ring-rose-500"
                  />
                  <button
                    type="button"
                    data-tv-focusable
                    disabled={savingProxy}
                    onClick={() => {
                      playButtonClickSound();
                      handleSaveProxy();
                    }}
                    className="flex items-center gap-2 px-5 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-rose-400"
                  >
                    {savingProxy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    <span>Зберегти</span>
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ================= TAB 2: PLAYBACK ================= */}
          {activeTab === "playback" && (
            <>
              <div>
                <h2 className="text-2xl font-black text-white">Відтворення та якість</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Параметри потоку за замовчуванням для телевізора.
                </p>
              </div>

              {/* Default Quality */}
              <div className="p-5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-4">
                <div className="flex items-center gap-3">
                  <Sliders className="w-5 h-5 text-rose-400" />
                  <span className="text-base font-bold text-white">Якість відео за замовчуванням</span>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {QUALITY_OPTIONS.map((q) => {
                    const selected = preferredQuality === q.id;
                    return (
                      <button
                        key={q.id}
                        type="button"
                        data-tv-focusable
                        onClick={() => {
                          playButtonClickSound();
                          handleQualityChange(q.id);
                        }}
                        className={cn(
                          "flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-bold border transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                          selected
                            ? "bg-rose-600 border-rose-500 text-white"
                            : "bg-zinc-950/70 border-white/10 text-zinc-300 hover:text-white"
                        )}
                      >
                        {q.premium && <Crown className="w-4 h-4 text-amber-300" />}
                        <span>{q.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Preferred Translator */}
              <div className="p-5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-4">
                <div className="flex items-center gap-3">
                  <Film className="w-5 h-5 text-rose-400" />
                  <span className="text-base font-bold text-white">Пріоритетна озвучка</span>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {TRANSLATOR_OPTIONS.map((tr) => {
                    const selected = preferredTranslator === tr.id;
                    return (
                      <button
                        key={tr.id || "auto"}
                        type="button"
                        data-tv-focusable
                        onClick={() => {
                          playButtonClickSound();
                          handleTranslatorChange(tr.id);
                        }}
                        className={cn(
                          "px-4 py-3 rounded-xl text-sm font-bold border transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                          selected
                            ? "bg-rose-600 border-rose-500 text-white"
                            : "bg-zinc-950/70 border-white/10 text-zinc-300 hover:text-white"
                        )}
                      >
                        <span className="inline-flex items-center gap-2">
                          {tr.label}
                          {"isUkr" in tr && tr.isUkr && <UaFlag className="w-4 h-3 rounded-[2px] shrink-0" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <TvSwitch
                checked={autoplayNext}
                onToggle={() => {
                  const next = !autoplayNext;
                  setAutoplayNext(next);
                  try {
                    localStorage.setItem("rdx_autoplay_next", next ? "true" : "false");
                  } catch {}
                  if (settings) {
                    const updated = { ...settings, autoplay_next: next };
                    setSettings(updated);
                    api.updateSettings(updated).catch(() => {});
                  }
                }}
                label="Автоперехід до наступної серії"
                description="Автоматично запускати наступний епізод серіалу після завершення поточного"
                icon={<Play className="w-5 h-5" />}
              />
            </>
          )}

          {/* ================= TAB 3: APPEARANCE & SOUND ================= */}
          {activeTab === "appearance" && (
            <>
              <div>
                <h2 className="text-2xl font-black text-white">Вигляд і звук</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Налаштування контрасту OLED-екрана та звукового супроводу пульта.
                </p>
              </div>

              {/* Accent Color */}
              <div className="p-5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-4">
                <div className="flex items-center gap-3">
                  <Palette className="w-5 h-5 text-rose-400" />
                  <span className="text-base font-bold text-white">Колірний акцент</span>
                </div>
                <div className="flex flex-wrap gap-3.5">
                  {ACCENT_OPTIONS.map((opt) => {
                    const isSelected = accentColor === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        data-tv-focusable
                        onClick={() => {
                          playButtonClickSound();
                          setAccentColorState(opt.id);
                          setAccentColor(opt.id);
                        }}
                        title={opt.name}
                        className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                          isSelected ? "ring-2 ring-white scale-110" : "opacity-80 hover:opacity-100"
                        )}
                        style={{ backgroundColor: opt.hex }}
                      >
                        {isSelected && <Check className="w-5 h-5 text-white stroke-[3]" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* OLED Background Depth */}
              <div className="p-5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-4">
                <div className="flex items-center gap-3">
                  <Moon className="w-5 h-5 text-rose-400" />
                  <span className="text-base font-bold text-white">Глибина темної теми</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    data-tv-focusable
                    onClick={() => {
                      playButtonClickSound();
                      setBgThemeState("oled");
                      setBgTheme("oled");
                    }}
                    className={cn(
                      "flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                      bgTheme === "oled"
                        ? "bg-rose-600/15 border-rose-500 text-white"
                        : "bg-black/40 border-white/10 text-zinc-300"
                    )}
                  >
                    <div className="w-9 h-9 rounded-lg bg-black border border-white/30 shrink-0" />
                    <div>
                      <div className="text-sm font-bold">True OLED (#000000)</div>
                      <div className="text-xs text-zinc-400">Абсолютний чорний для ТВ</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    data-tv-focusable
                    onClick={() => {
                      playButtonClickSound();
                      setBgThemeState("obsidian");
                      setBgTheme("obsidian");
                    }}
                    className={cn(
                      "flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-all cursor-pointer focus:outline-none focus:ring-4 focus:ring-rose-500",
                      bgTheme === "obsidian"
                        ? "bg-rose-600/15 border-rose-500 text-white"
                        : "bg-zinc-900/50 border-white/10 text-zinc-300"
                    )}
                  >
                    <div className="w-9 h-9 rounded-lg bg-[#09090b] border border-white/30 shrink-0" />
                    <div>
                      <div className="text-sm font-bold">Obsidian (#09090b)</div>
                      <div className="text-xs text-zinc-400">М'який глибокий темний фон</div>
                    </div>
                  </button>
                </div>
              </div>

              <TvSwitch
                checked={startupSound}
                onToggle={() => {
                  const next = !startupSound;
                  setStartupSound(next);
                  try {
                    localStorage.setItem("rdx_startup_sound", next ? "true" : "false");
                  } catch {}
                  if (settings) {
                    const updated = { ...settings, startup_sound: next };
                    setSettings(updated);
                    api.updateSettings(updated).catch(() => {});
                  }
                }}
                label="Звук запуску"
                description="Відтворювати фірмовий звук при старті RDX-TV"
                icon={<Volume2 className="w-5 h-5" />}
              />

              <TvSwitch
                checked={uiSounds}
                onToggle={() => {
                  const next = !uiSounds;
                  setUiSounds(next);
                  setUiSoundsEnabled(next);
                }}
                label="Звуки навігації (D-pad)"
                description="Тактильний звуковий відгук при русі пультом і відкритті карток"
                icon={<Volume2 className="w-5 h-5" />}
              />
            </>
          )}

          {/* ================= TAB 4: ABOUT ================= */}
          {activeTab === "about" && (
            <>
              <div>
                <h2 className="text-2xl font-black text-white">Про RDX-TV</h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Клієнт для Android TV та Samsung Smart TV (Tizen).
                </p>
              </div>

              <div className="p-6 rounded-2xl bg-white/[0.04] border border-white/10 space-y-5">
                <div className="flex items-center gap-4">
                  <img
                    src="/icon-tv.png"
                    alt="RDX-TV"
                    className="w-16 h-16 rounded-2xl object-contain shrink-0"
                  />
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl font-black text-white">
                        RDX-TV<span className="text-rose-500">.</span>
                      </span>
                      <span className="px-2.5 py-0.5 rounded-full bg-rose-600/20 border border-rose-500/35 text-xs font-mono font-bold text-rose-300">
                        v{APP_VERSION}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-400 mt-1">
                      10-foot Smart TV інтерфейс • Розробник: <span className="text-white font-semibold">justgl</span>
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    data-tv-focusable
                    disabled={isCheckingUpdates}
                    onClick={() => {
                      playButtonClickSound();
                      handleManualUpdateCheck();
                    }}
                    className="flex items-center gap-2 px-5 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-rose-400"
                  >
                    {isCheckingUpdates ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    <span>{isCheckingUpdates ? "Перевірка..." : "Перевірити оновлення"}</span>
                  </button>

                  {updateCheckResult && (
                    <span className="px-4 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-sm text-emerald-300 font-medium">
                      {updateCheckResult}
                    </span>
                  )}
                </div>
              </div>

              {/* TV Remote Guide */}
              <div className="p-6 rounded-2xl bg-white/[0.04] border border-white/10 space-y-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
                  Керування з пульта ДК (TV Remote)
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950/80 border border-white/10">
                    <span className="text-zinc-300">Навігація</span>
                    <kbd className="px-2.5 py-1 rounded-lg bg-white/10 font-mono text-xs text-white">
                      D-Pad (↑ ↓ ← →)
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950/80 border border-white/10">
                    <span className="text-zinc-300">Вибір / Пауза</span>
                    <kbd className="px-2.5 py-1 rounded-lg bg-white/10 font-mono text-xs text-white">
                      OK / Enter
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950/80 border border-white/10">
                    <span className="text-zinc-300">Назад / Закрити</span>
                    <kbd className="px-2.5 py-1 rounded-lg bg-white/10 font-mono text-xs text-white">
                      Return / Back
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950/80 border border-white/10">
                    <span className="text-zinc-300">Перемотка у плеєрі</span>
                    <kbd className="px-2.5 py-1 rounded-lg bg-white/10 font-mono text-xs text-white">
                      ← / → (±10с)
                    </kbd>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
};
