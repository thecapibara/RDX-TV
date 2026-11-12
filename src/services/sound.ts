/**
 * RDX-TV - UI Audio Engine (Pure Web Audio API Oscillator)
 * Uses the exact same AudioContext + OscillatorNode pipeline as the boot splash
 * (which works reliably in WebKitGTK Linux, Android TV WebView, and Samsung Tizen
 * without GStreamer MP3 decode bugs or suspended-context issues).
 */

const UI_SOUNDS_KEY = "rdx_tv_ui_sounds";

// ON by default for TV unless explicitly disabled by the user
let uiSoundsEnabled: boolean = (() => {
  try {
    return localStorage.getItem(UI_SOUNDS_KEY) !== "false";
  } catch {
    return true;
  }
})();

let lastHoverSoundTime = 0;
let sharedAudioCtx: AudioContext | null = null;

function withActiveAudioContext(fn: (ctx: AudioContext) => void) {
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
        .catch(() => {
          // If shared context failed to resume, create a fresh one in this user gesture
          try {
            const fresh = new AudioCtx();
            sharedAudioCtx = fresh;
            fn(fresh);
          } catch {}
        });
    } else {
      fn(ctx);
    }
  } catch {}
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
    gain.gain.linearRampToValueAtTime(peakGain, t + 0.004);
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

  withActiveAudioContext((ctx) => {
    playTone(ctx, 540, 280, 0.042, 0.24);
  });
};

/**
 * Warm cinematic swell when opening a movie/series card
 */
export const playModalOpenSound = () => {
  if (!uiSoundsEnabled) return;

  withActiveAudioContext((ctx) => {
    playTone(ctx, 300, 450, 0.19, 0.2);
    playTone(ctx, 450, 675, 0.19, 0.14, 0.015);
  });
};

/**
 * Crisp soft click for OK / button press
 */
export const playButtonClickSound = () => {
  if (!uiSoundsEnabled) return;

  withActiveAudioContext((ctx) => {
    playTone(ctx, 780, 360, 0.036, 0.24);
  });
};

/**
 * Soft downward tick/whoosh when pressing Back on the TV remote
 */
export const playBackSound = () => {
  if (!uiSoundsEnabled) return;

  withActiveAudioContext((ctx) => {
    playTone(ctx, 460, 200, 0.06, 0.2);
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

    playTone(ctx, 310, 690, 0.085, 0.22, 0.0);
    playTone(ctx, 460, 980, 0.09, 0.18, 0.07);
    playTone(ctx, 640, 1220, 0.07, 0.11, 0.145);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {}
};
