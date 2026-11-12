/**
 * RDX-TV - UI Audio Engine (Web Audio API + Original Baked MP3s)
 * Preloads & decodes the original RDX MP3 assets (/hovercard.mp3, /opencard.mp3, /buttonclick.mp3)
 * into AudioBuffers for 0ms latency playback across Android TV, Samsung Tizen, and Desktop.
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
const bufferCache = new Map<string, AudioBuffer>();
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
  const cached = bufferCache.get(url);
  if (cached) return cached;

  const inflight = loadingBuffers.get(url);
  if (inflight) return inflight;

  const ctx = getAudioContext();
  if (!ctx) return null;

  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arr);
      bufferCache.set(url, decoded);
      return decoded;
    } catch {
      return null;
    } finally {
      loadingBuffers.delete(url);
    }
  })();

  loadingBuffers.set(url, promise);
  return promise;
}

function playBakedMp3(url: string, volume: number = 0.85, playbackRate: number = 1.0) {
  if (!uiSoundsEnabled) return;

  const ctx = getAudioContext();
  if (!ctx) {
    // Fallback to HTMLAudioElement if Web Audio API is unavailable
    try {
      const audio = new Audio(url);
      audio.volume = Math.min(1, volume);
      audio.playbackRate = playbackRate;
      audio.play().catch(() => {});
    } catch {}
    return;
  }

  const startBuffer = (buffer: AudioBuffer) => {
    const doPlay = () => {
      try {
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buffer;
        src.playbackRate.value = playbackRate;
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
      } catch {}
    };

    if (ctx.state === "suspended") {
      ctx.resume().then(doPlay).catch(() => {});
    } else {
      doPlay();
    }
  };

  const cached = bufferCache.get(url);
  if (cached) {
    startBuffer(cached);
    return;
  }

  loadSoundBuffer(url).then((buf) => {
    if (buf) startBuffer(buf);
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
    localStorage.setItem("rdx_ui_sounds", enabled ? "true" : "false");
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
 * Original baked hover/focus sound (/hovercard.mp3)
 */
export const playHoverSound = () => {
  if (!uiSoundsEnabled) return;
  const now = performance.now();
  if (now < lastHoverSoundTime || now - lastHoverSoundTime < 55) return;
  lastHoverSoundTime = now;

  playBakedMp3("/hovercard.mp3", 0.7);
};

/**
 * Original baked card/modal open sound (/opencard.mp3)
 */
export const playModalOpenSound = () => {
  playBakedMp3("/opencard.mp3", 0.85);
};

/**
 * Original baked button/OK click sound (/buttonclick.mp3)
 */
export const playButtonClickSound = () => {
  playBakedMp3("/buttonclick.mp3", 0.85);
};

/**
 * Back remote sound (slightly lower-pitched baked click)
 */
export const playBackSound = () => {
  playBakedMp3("/buttonclick.mp3", 0.65, 0.78);
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
