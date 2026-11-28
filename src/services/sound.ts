/**
 * RDX-TV v2 UI Audio Engine
 * Delegates to platform.audio:
 * - Android TV: native Kotlin SoundPool (zero latency)
 * - Samsung Tizen / LG webOS / Web: preloaded Web Audio MP3 buffers + Oscillator fallback
 */
import { platform } from "../platform";

const UI_SOUNDS_KEY = "rdx_tv_ui_sounds";

let uiSoundsEnabled: boolean = (() => {
  try {
    return localStorage.getItem(UI_SOUNDS_KEY) !== "false";
  } catch {
    return true;
  }
})();

let lastHoverSoundTime = 0;

if (typeof window !== "undefined") {
  platform.audio.preload();
}

export const setUiSoundsEnabled = (enabled: boolean) => {
  uiSoundsEnabled = enabled;
  try {
    localStorage.setItem(UI_SOUNDS_KEY, enabled ? "true" : "false");
  } catch {}
};

export const getUiSoundsEnabled = (): boolean => uiSoundsEnabled;

export const suppressHoverSound = (cooldownMs: number = 400) => {
  lastHoverSoundTime = performance.now() + cooldownMs;
};

export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;
  platform.audio.play("hover", 0.4);
};

export const playModalOpenSound = () => {
  if (!uiSoundsEnabled) return;
  platform.audio.play("modal_open", 0.5);
};

export const playButtonClickSound = () => {
  if (!uiSoundsEnabled) return;
  platform.audio.play("button_click", 0.5);
};

export const playBackSound = () => {
  if (!uiSoundsEnabled) return;
  platform.audio.play("back", 0.4);
};

export const playAntennaBubblesSound = () => {
  try {
    if (localStorage.getItem("rdx_startup_sound") === "false") return;
  } catch {}
  platform.audio.play("startup", 0.5);
};
