/**
 * RDX-TV - UI Audio Engine (Web Audio API + Original Baked MP3s + 0ms Synth Fallback)
 * Preloads /hovercard.mp3, /opencard.mp3, /buttonclick.mp3 into AudioBuffers with gain boost
 * (since original MP3s peak at -14.7dB..-4.1dB), and falls back directly to 0ms Web Audio
 * oscillators if WebKitGTK cannot decode MP3s in AudioContext.
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
const bufferCache = new Map<string, AudioBuffer>();
const failedBuffers = new Set<string>();
const loadingBuffers = new Map<string, Promise<AudioBuffer | null>>();

function getAudioContext(): AudioContext | null {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx();
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

async function loadSoundBuffer(url: string): Promise<AudioBuffer | null> {
  if (failedBuffers.has(url)) return null;
  const cached = bufferCache.get(url);
  if (cached) return cached;

  const inflight = loadingBuffers.get(url);
  if (inflight) return inflight;

  const ctx = getAudioContext();
  if (!ctx) return null;

  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failedBuffers.add(url);
        return null;
      }
      const arr = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arr);
      bufferCache.set(url, decoded);
      return decoded;
    } catch (err) {
      console.warn("[RDX-Audio] decodeAudioData failed for", url, "— using Web Audio synth:", err);
      failedBuffers.add(url);
      return null;
    } finally {
      loadingBuffers.delete(url);
    }
  })();

  loadingBuffers.set(url, promise);
  return promise;
}

function playSynthTone(
  ctx: AudioContext,
  f1: number,
  f2: number,
  dur: number,
  peakGain: number
) {
  try {
    const t = ctx.currentTime;
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
    osc.stop(t + dur + 0.015);
  } catch {}
}

function playSound(
  url: string,
  volume: number,
  playbackRate: number,
  fallbackSynth: (ctx: AudioContext) => void
) {
  if (!uiSoundsEnabled) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  const runWithCtx = (fn: () => void) => {
    if (ctx.state === "suspended") {
      ctx.resume().then(fn).catch(() => {});
    } else {
      fn();
    }
  };

  const cached = bufferCache.get(url);
  if (cached) {
    runWithCtx(() => {
      try {
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = cached;
        src.playbackRate.value = playbackRate;
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
      } catch {
        fallbackSynth(ctx);
      }
    });
    return;
  }

  if (failedBuffers.has(url)) {
    runWithCtx(() => fallbackSynth(ctx));
    return;
  }

  // Trigger preload for next time, and play synth immediately on first hit so 0ms latency
  loadSoundBuffer(url);
  runWithCtx(() => fallbackSynth(ctx));
}

// Preload all baked UI sounds on module load
if (typeof window !== "undefined") {
  loadSoundBuffer("/hovercard.mp3");
  loadSoundBuffer("/opencard.mp3");
  loadSoundBuffer("/buttonclick.mp3");
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
 * Original baked hover/focus sound (/hovercard.mp3, boosted from -14.7dB) with 0ms synth fallback
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;

  playSound("/hovercard.mp3", 2.8, 1.0, (ctx) => playSynthTone(ctx, 520, 260, 0.04, 0.22));
};

/**
 * Original baked card/modal open sound (/opencard.mp3, boosted from -9.5dB) with 0ms synth fallback
 */
export const playModalOpenSound = () => {
  playSound("/opencard.mp3", 1.8, 1.0, (ctx) => {
    playSynthTone(ctx, 280, 420, 0.18, 0.18);
    playSynthTone(ctx, 420, 630, 0.18, 0.12);
  });
};

/**
 * Original baked button/OK click sound (/buttonclick.mp3) with 0ms synth fallback
 */
export const playButtonClickSound = () => {
  playSound("/buttonclick.mp3", 1.4, 1.0, (ctx) => playSynthTone(ctx, 760, 340, 0.035, 0.22));
};

/**
 * Back remote sound
 */
export const playBackSound = () => {
  playSound("/buttonclick.mp3", 1.1, 0.78, (ctx) => playSynthTone(ctx, 440, 190, 0.055, 0.18));
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
