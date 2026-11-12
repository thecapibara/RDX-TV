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
