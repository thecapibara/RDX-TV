import type { AudioAdapter, AudioSoundKey, PlatformKind } from "./types";

const SOUND_PATHS: Record<Exclude<AudioSoundKey, "back">, string> = {
  startup: "/startup.mp3",
  hover: "/hovercard.mp3",
  modal_open: "/opencard.mp3",
  button_click: "/buttonclick.mp3",
};

const decodedBuffers: Partial<Record<Exclude<AudioSoundKey, "back">, AudioBuffer>> = {};
let preloaded = false;

function getAudioContext(): AudioContext | null {
  try {
    const win = window as unknown as {
      __rdxAudioCtx?: AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx = window.AudioContext || win.webkitAudioContext;
    if (!Ctx) return null;
    if (!win.__rdxAudioCtx || win.__rdxAudioCtx.state === "closed") {
      win.__rdxAudioCtx = new Ctx();
    }
    if (win.__rdxAudioCtx.state === "suspended") {
      win.__rdxAudioCtx.resume().catch(() => {});
    }
    return win.__rdxAudioCtx;
  } catch {
    return null;
  }
}

function playFallbackTone(key: AudioSoundKey) {
  const ctx = getAudioContext();
  if (!ctx) return;

  const tone = (f1: number, f2: number, dur: number, peak: number, delay = 0) => {
    try {
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f1, t);
      osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch {}
  };

  if (key === "hover") tone(540, 280, 0.06, 0.24);
  else if (key === "modal_open") {
    tone(300, 450, 0.19, 0.2);
    tone(450, 675, 0.19, 0.14, 0.015);
  } else if (key === "back") tone(460, 200, 0.065, 0.2);
  else tone(780, 360, 0.045, 0.24);
}

export function createAudioAdapter(kind: PlatformKind): AudioAdapter {
  const preload = () => {
    if (preloaded || typeof window === "undefined") return;
    if (kind === "android-tv" && window.RDXAndroid?.playSound) {
      preloaded = true;
      return;
    }
    preloaded = true;
    const ctx = getAudioContext();
    if (!ctx) return;
    (Object.entries(SOUND_PATHS) as Array<[Exclude<AudioSoundKey, "back">, string]>).forEach(
      ([k, path]) => {
        fetch(path)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
          .then((buf) => ctx.decodeAudioData(buf))
          .then((decoded) => {
            decodedBuffers[k] = decoded;
          })
          .catch(() => {});
      }
    );
  };

  const play = (key: AudioSoundKey, volume = 0.45) => {
    // Native Android TV SoundPool (zero latency, zero WebView audio overhead)
    if (kind === "android-tv" && window.RDXAndroid?.playSound) {
      try {
        window.RDXAndroid.playSound(key);
        return;
      } catch {}
    }

    const mappedKey: Exclude<AudioSoundKey, "back"> = key === "back" ? "button_click" : key;
    const ctx = getAudioContext();
    const buf = decodedBuffers[mappedKey];
    if (ctx && buf) {
      try {
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buf;
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
        return;
      } catch {}
    }

    if (!preloaded) preload();
    playFallbackTone(key);
  };

  return { play, preload };
}
