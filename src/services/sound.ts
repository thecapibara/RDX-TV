/**
 * RDX-TV - UI Audio Engine (Web Audio API + Original Baked MP3s + Synth Fallback)
 * Preloads /hovercard.mp3, /opencard.mp3, /buttonclick.mp3 into AudioBuffers,
 * with automatic HTMLAudioElement + Web Audio oscillator fallback for WebKitGTK.
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
    if (sharedAudioCtx.state === "suspended") {
      sharedAudioCtx.resume().catch(() => {});
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
    } catch {
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

  const playHtmlOrSynth = () => {
    try {
      const audio = new Audio(url);
      audio.volume = Math.min(1, volume);
      audio.playbackRate = playbackRate;
      audio.play().catch(() => {
        if (ctx) fallbackSynth(ctx);
      });
    } catch {
      if (ctx) fallbackSynth(ctx);
    }
  };

  if (!ctx) {
    playHtmlOrSynth();
    return;
  }

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
    runWithCtx(() => playHtmlOrSynth());
    return;
  }

  loadSoundBuffer(url).then((buf) => {
    runWithCtx(() => {
      if (buf) {
        try {
          const src = ctx.createBufferSource();
          const gain = ctx.createGain();
          src.buffer = buf;
          src.playbackRate.value = playbackRate;
          gain.gain.value = volume;
          src.connect(gain);
          gain.connect(ctx.destination);
          src.start(0);
          return;
        } catch {}
      }
      playHtmlOrSynth();
    });
  });
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
 * Original baked hover/focus sound (/hovercard.mp3) with synth fallback
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;

  playSound("/hovercard.mp3", 0.75, 1.0, (ctx) => playSynthTone(ctx, 520, 260, 0.04, 0.18));
};

/**
 * Original baked card/modal open sound (/opencard.mp3) with synth fallback
 */
export const playModalOpenSound = () => {
  playSound("/opencard.mp3", 0.85, 1.0, (ctx) => {
    playSynthTone(ctx, 280, 420, 0.18, 0.15);
    playSynthTone(ctx, 420, 630, 0.18, 0.1);
  });
};

/**
 * Original baked button/OK click sound (/buttonclick.mp3) with synth fallback
 */
export const playButtonClickSound = () => {
  playSound("/buttonclick.mp3", 0.85, 1.0, (ctx) => playSynthTone(ctx, 760, 340, 0.035, 0.2));
};

/**
 * Back remote sound
 */
export const playBackSound = () => {
  playSound("/buttonclick.mp3", 0.65, 0.78, (ctx) => playSynthTone(ctx, 440, 190, 0.055, 0.16));
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
