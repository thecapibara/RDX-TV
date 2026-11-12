/**
 * RDX-TV - UI Audio Engine (Pure Web Audio API)
 * Lightweight synthesized UI feedback sounds for Android TV, Samsung Tizen, and WebKit.
 * Zero native dependency, zero latency, and rate-limiting against rapid traversal.
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

function withAudioContext(fn: (ctx: AudioContext) => void) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx();
    }

    const ctx = sharedAudioCtx;
    if (ctx.state === "suspended") {
      ctx
        .resume()
        .then(() => fn(ctx))
        .catch(() => {});
    } else {
      fn(ctx);
    }
  } catch {}
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
 * Crisp tactile D-pad / focus tick (Apple TV / PS5 style, audible on laptop & TV speakers)
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;

  withAudioContext((ctx) => {
    const t = ctx.currentTime;
    const dur = 0.038;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(260, t + dur);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + dur + 0.01);
  });
};

/**
 * Warm cinematic swell when opening a movie/series card
 */
export const playModalOpenSound = () => {
  if (!uiSoundsEnabled) return;

  withAudioContext((ctx) => {
    const t = ctx.currentTime;
    const dur = 0.19;

    const oscRoot = ctx.createOscillator();
    const oscFifth = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    oscRoot.type = "sine";
    oscRoot.frequency.setValueAtTime(280, t);
    oscRoot.frequency.exponentialRampToValueAtTime(420, t + dur);

    oscFifth.type = "sine";
    oscFifth.frequency.setValueAtTime(420, t);
    oscFifth.frequency.exponentialRampToValueAtTime(630, t + dur);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1100, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    oscRoot.connect(filter);
    oscFifth.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    oscRoot.start(t);
    oscFifth.start(t);
    oscRoot.stop(t + dur + 0.02);
    oscFifth.stop(t + dur + 0.02);
  });
};

/**
 * Crisp soft click for OK / button press
 */
export const playButtonClickSound = () => {
  if (!uiSoundsEnabled) return;

  withAudioContext((ctx) => {
    const t = ctx.currentTime;
    const dur = 0.032;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(760, t);
    osc.frequency.exponentialRampToValueAtTime(340, t + dur);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.2, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + dur + 0.01);
  });
};

/**
 * Soft downward tick/whoosh when pressing Back on the TV remote
 */
export const playBackSound = () => {
  if (!uiSoundsEnabled) return;

  withAudioContext((ctx) => {
    const t = ctx.currentTime;
    const dur = 0.055;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(190, t + dur);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + dur + 0.01);
  });
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

    const triggerBubble = (
      startOffsetSec: number,
      startFreq: number,
      endFreq: number,
      durationSec: number,
      peakGain: number
    ) => {
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

    triggerBubble(0.0, 310, 690, 0.085, 0.22);
    triggerBubble(0.07, 460, 980, 0.09, 0.18);
    triggerBubble(0.145, 640, 1220, 0.07, 0.11);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {}
};
