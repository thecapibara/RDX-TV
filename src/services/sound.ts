/**
 * RDX Obsidian Crimson - UI Audio Engine
 * Hardware-level native sound dispatch via Rust (rodio/PipeWire) with 0ms latency,
 * zero WebKitGTK bugs, and rate-limiting against rapid mouse sweep.
 */

import { api } from "./api";

// Initialize state from localStorage (default: false, OFF by default)
let uiSoundsEnabled: boolean = (() => {
  try {
    return localStorage.getItem("rdx_ui_sounds") === "true";
  } catch {
    return false;
  }
})();

let lastHoverSoundTime = 0;

export const setUiSoundsEnabled = (enabled: boolean) => {
  uiSoundsEnabled = enabled;
  try {
    localStorage.setItem("rdx_ui_sounds", enabled ? "true" : "false");
  } catch {}
};

export const getUiSoundsEnabled = (): boolean => {
  return uiSoundsEnabled;
};

/**
 * Temporarily suppress hover sound triggers (e.g. when closing modal or navigating back,
 * so the card appearing under the cursor doesn't play an accidental hover sound).
 */
export const suppressHoverSound = (cooldownMs: number = 400) => {
  lastHoverSoundTime = performance.now() + cooldownMs;
};

/**
 * Tactile, warm velvet hover tap (Apple TV / PS5 focus style)
 * Rate-limited to prevent rapid mouse traversal flutter.
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 110) return;
  lastHoverSoundTime = now;

  api.playUiSound("hover");
};

/**
 * Cinematic opening swell when selecting a movie/series card
 */
export const playModalOpenSound = () => {
  if (!uiSoundsEnabled) return;
  api.playUiSound("modal_open");
};

/**
 * Tactile interface button click sound (navigation tabs, category filters, pagination)
 */
export const playButtonClickSound = () => {
  if (!uiSoundsEnabled) return;
  api.playUiSound("button_click");
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
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const triggerBubble = (startOffsetSec: number, startFreq: number, endFreq: number, durationSec: number, peakGain: number) => {
      const now = ctx.currentTime + startOffsetSec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + durationSec);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(peakGain, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + durationSec + 0.02);
    };

    // Two crisp water-bubble pops + subtle high sparkle
    triggerBubble(0.0, 310, 690, 0.085, 0.22);
    triggerBubble(0.07, 460, 980, 0.09, 0.18);
    triggerBubble(0.145, 640, 1220, 0.07, 0.11);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {
    // Ignore autoplay or Web Audio restrictions
  }
};
