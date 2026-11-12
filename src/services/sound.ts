/**
 * RDX-TV - UI Audio Engine (Pure Web Audio API)
 * Lightweight synthesized UI feedback sounds for Android TV, Samsung Tizen, and WebKit.
 * Zero native dependency, zero latency, and rate-limiting against rapid cursor sweeps.
 */

// Initialize state from localStorage (default: true on TV, ON by default unless explicitly disabled)
let uiSoundsEnabled: boolean = (() => {
  try {
    return localStorage.getItem("rdx_ui_sounds") !== "false";
  } catch {
    return true;
  }
})();

let lastHoverSoundTime = 0;
let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === "suspended") {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

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
 * Subtle velvet tap for hover/focus (Apple TV / PS5 focus style)
 * Rate-limited to prevent rapid traversal flutter.
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(75, t + 0.045);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.08, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + 0.05);
  } catch {}
};

/**
 * Warm low-pass swell for modal open
 */
export const playModalOpenSound = () => {
  if (!uiSoundsEnabled) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const dur = 0.22;

    const oscRoot = ctx.createOscillator();
    const oscFifth = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    oscRoot.type = "sine";
    oscRoot.frequency.setValueAtTime(150, t);
    oscRoot.frequency.exponentialRampToValueAtTime(220, t + dur);

    oscFifth.type = "sine";
    oscFifth.frequency.setValueAtTime(225, t);
    oscFifth.frequency.exponentialRampToValueAtTime(330, t + dur);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(480, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.07, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    oscRoot.connect(filter);
    oscFifth.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    oscRoot.start(t);
    oscFifth.start(t);
    oscRoot.stop(t + dur + 0.02);
    oscFifth.stop(t + dur + 0.02);
  } catch {}
};

/**
 * Crisp soft click for button click (navigation tabs, filters, buttons)
 */
export const playButtonClickSound = () => {
  if (!uiSoundsEnabled) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const dur = 0.026;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + dur);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.09, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + dur + 0.01);
  } catch {}
};

/**
 * Soft downward tick/whoosh when pressing Back on the TV remote
 */
export const playBackSound = () => {
  if (!uiSoundsEnabled) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const dur = 0.055;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + dur);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.08, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + dur + 0.01);
  } catch {}
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
