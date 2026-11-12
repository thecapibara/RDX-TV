/**
 * RDX-TV - UI Audio Engine (Pure Web Audio API Oscillator)
 * Stores a single AudioContext on window.__rdxAudioCtx so Vite HMR never leaks
 * WebKitGTK/PipeWire audio sinks, and triggers OscillatorNode synchronously
 * inside user gestures just like the boot splash.
 */

import { api } from "./api";

const UI_SOUNDS_KEY = "rdx_tv_ui_sounds";
const isDesktopTauri =
  typeof window !== "undefined" &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) &&
  !/android/i.test(navigator.userAgent);

type TvSoundKey = "hover" | "modal_open" | "button_click";

const TV_SOUND_PATHS: Record<TvSoundKey, string> = {
  hover: "/hovercard.mp3",
  modal_open: "/opencard.mp3",
  button_click: "/buttonclick.mp3",
};

const tvAudioBuffers: Partial<Record<TvSoundKey, AudioBuffer>> = {};
let tvPreloadStarted = false;

// ON by default for TV unless explicitly disabled by the user
let uiSoundsEnabled: boolean = (() => {
  try {
    return localStorage.getItem(UI_SOUNDS_KEY) !== "false";
  } catch {
    return true;
  }
})();

let lastHoverSoundTime = 0;

function getOrCreateAudioContext(): AudioContext | null {
  try {
    const win = window as unknown as {
      __rdxAudioCtx?: AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioCtx = window.AudioContext || win.webkitAudioContext;
    if (!AudioCtx) return null;

    if (!win.__rdxAudioCtx || win.__rdxAudioCtx.state === "closed") {
      win.__rdxAudioCtx = new AudioCtx();
    }
    if (win.__rdxAudioCtx.state === "suspended") {
      win.__rdxAudioCtx.resume().catch(() => {});
    }
    return win.__rdxAudioCtx;
  } catch {
    return null;
  }
}

function preloadTvAudioBuffers() {
  if (isDesktopTauri || tvPreloadStarted || typeof window === "undefined") return;
  tvPreloadStarted = true;

  const ctx = getOrCreateAudioContext();
  if (!ctx) return;

  (Object.entries(TV_SOUND_PATHS) as Array<[TvSoundKey, string]>).forEach(([key, path]) => {
    fetch(path)
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error("fetch failed"))))
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        tvAudioBuffers[key] = decoded;
      })
      .catch(() => {});
  });
}

if (!isDesktopTauri && typeof window !== "undefined") {
  preloadTvAudioBuffers();
}

function playTvAudioBuffer(key: TvSoundKey, volume: number): boolean {
  const ctx = getOrCreateAudioContext();
  const buffer = tvAudioBuffers[key];
  if (!ctx || !buffer) {
    if (!tvPreloadStarted) preloadTvAudioBuffers();
    return false;
  }
  try {
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(0);
    return true;
  } catch {
    return false;
  }
}

function playTone(
  ctx: AudioContext,
  f1: number,
  f2: number,
  dur: number,
  peakGain: number,
  delaySec: number = 0
) {
  try {
    const t = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f1, t);
    osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peakGain, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch {}
}

export const setUiSoundsEnabled = (enabled: boolean) => {
  uiSoundsEnabled = enabled;
  try {
    localStorage.setItem(UI_SOUNDS_KEY, enabled ? "true" : "false");
  } catch {}
};

export const getUiSoundsEnabled = (): boolean => {
  return uiSoundsEnabled;
};

/**
 * Temporarily suppress hover sound triggers (e.g. when closing modal or navigating back).
 */
export const suppressHoverSound = (cooldownMs: number = 400) => {
  lastHoverSoundTime = performance.now() + cooldownMs;
};

/**
 * Crisp tactile D-pad / focus tick (Apple TV / PS5 style)
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;

  if (isDesktopTauri) {
    api.playUiSound("hover");
    return;
  }

  if (playTvAudioBuffer("hover", 0.4)) return;

  const ctx = getOrCreateAudioContext();
  if (ctx) playTone(ctx, 540, 280, 0.06, 0.26);
};

/**
 * Warm cinematic swell when opening a movie/series card
 */
export const playModalOpenSound = () => {
  if (!uiSoundsEnabled) return;

  if (isDesktopTauri) {
    api.playUiSound("modal_open");
    return;
  }

  if (playTvAudioBuffer("modal_open", 0.5)) return;

  const ctx = getOrCreateAudioContext();
  if (ctx) {
    playTone(ctx, 300, 450, 0.19, 0.22);
    playTone(ctx, 450, 675, 0.19, 0.15, 0.015);
  }
};

/**
 * Crisp soft click for OK / button press
 */
export const playButtonClickSound = () => {
  if (!uiSoundsEnabled) return;

  if (isDesktopTauri) {
    api.playUiSound("button_click");
    return;
  }

  if (playTvAudioBuffer("button_click", 0.5)) return;

  const ctx = getOrCreateAudioContext();
  if (ctx) playTone(ctx, 780, 360, 0.045, 0.26);
};

/**
 * Soft downward tick/whoosh when pressing Back on the TV remote
 */
export const playBackSound = () => {
  if (!uiSoundsEnabled) return;

  if (isDesktopTauri) {
    api.playUiSound("button_click");
    return;
  }

  if (playTvAudioBuffer("button_click", 0.4)) return;

  const ctx = getOrCreateAudioContext();
  if (ctx) playTone(ctx, 460, 200, 0.065, 0.22);
};

/**
 * Playful cross-platform Web Audio API "bubbles" pop SFX when the TV antenna
 * horns & "-TV" suffix appear during the boot splash animation.
 */
export const playAntennaBubblesSound = () => {
  try {
    if (localStorage.getItem("rdx_startup_sound") === "false") return;
  } catch {}

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    playTone(ctx, 310, 690, 0.085, 0.22, 0.0);
    playTone(ctx, 460, 980, 0.09, 0.18, 0.07);
    playTone(ctx, 640, 1220, 0.07, 0.11, 0.145);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {}
};
