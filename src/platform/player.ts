import type HlsType from "hls.js";
import type { AspectMode, PlatformKind, PlayerAdapter, PlayerCallbacks, PlayerLoadOptions } from "./types";

/**
 * 1. Android TV Native Media3 / ExoPlayer Adapter (`window.RDXAndroid`)
 * Plays 1080p/4K hardware-decoded video directly on Android SurfaceView with ~60-90MB RAM.
 */
class AndroidExoPlayerAdapter implements PlayerAdapter {
  readonly kind = "android-exo" as const;
  readonly isExternalSurface = true;
  private callbacks: PlayerCallbacks = {};

  async load(opts: PlayerLoadOptions, callbacks: PlayerCallbacks): Promise<void> {
    this.callbacks = callbacks;
    window.__rdxAndroidPlayerEvent = (eventJson: string) => {
      try {
        const ev = JSON.parse(eventJson) as {
          type: string;
          currentSec?: number;
          durationSec?: number;
          bufferedSec?: number;
          state?: "loading" | "playing" | "paused" | "buffering" | "ended";
          message?: string;
          width?: number;
          height?: number;
        };
        if (ev.type === "ready") this.callbacks.onReady?.(ev.durationSec ?? 0);
        else if (ev.type === "time") {
          this.callbacks.onTimeUpdate?.(ev.currentSec ?? 0, ev.durationSec ?? 0, ev.bufferedSec ?? 0);
        } else if (ev.type === "state" && ev.state) {
          this.callbacks.onStateChange?.(ev.state);
        } else if (ev.type === "resolution" && ev.width && ev.height) {
          this.callbacks.onResolution?.(ev.width, ev.height);
        } else if (ev.type === "error") {
          this.callbacks.onError?.(ev.message || "Помилка ExoPlayer");
        }
      } catch {}
    };

    window.RDXAndroid?.playerOpen?.(JSON.stringify(opts));
  }

  play() {
    window.RDXAndroid?.playerPlay?.();
  }
  pause() {
    window.RDXAndroid?.playerPause?.();
  }
  seek(seconds: number) {
    window.RDXAndroid?.playerSeek?.(Math.max(0, seconds));
  }
  setPlaybackRate(rate: number) {
    window.RDXAndroid?.playerSetSpeed?.(rate);
  }
  setVolume(_v: number) {}
  setMuted(_m: boolean) {}
  setAspectMode(mode: AspectMode) {
    window.RDXAndroid?.playerSetAspectMode?.(mode);
  }
  setAudioBoost(percent: number) {
    window.RDXAndroid?.playerSetAudioBoost?.(percent);
  }
  setSubtitle(url: string | null) {
    window.RDXAndroid?.playerSetSubtitle?.(url || "");
  }
  destroy() {
    window.__rdxAndroidPlayerEvent = undefined;
    window.RDXAndroid?.playerClose?.();
  }
}

/**
 * 2. Samsung Tizen Hardware AVPlay Adapter (`window.webapis.avplay`)
 * Bypasses WebView MSE/hls.js completely for smooth hardware 1080p/4K playback on 1-2GB Samsung TVs.
 */
class TizenAvPlayAdapter implements PlayerAdapter {
  readonly kind = "tizen-avplay" as const;
  readonly isExternalSurface = true;
  private durationSec = 0;

  async load(opts: PlayerLoadOptions, callbacks: PlayerCallbacks): Promise<void> {
    const avplay = window.webapis?.avplay;
    if (!avplay) {
      callbacks.onError?.("Tizen AVPlay недоступний");
      return;
    }

    try {
      try {
        avplay.stop();
        avplay.close();
      } catch {}

      callbacks.onStateChange?.("loading");
      avplay.open(opts.url);
      avplay.setDisplayRect(0, 0, window.innerWidth || 1920, window.innerHeight || 1080);
      try {
        avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX");
      } catch {}

      avplay.setListener({
        onbufferingstart: () => callbacks.onStateChange?.("buffering"),
        onbufferingcomplete: () => callbacks.onStateChange?.("playing"),
        oncurrentplaytime: (ms: unknown) => {
          const cur = Number(ms || 0) / 1000;
          callbacks.onTimeUpdate?.(cur, this.durationSec, cur);
        },
        onstreamcompleted: () => {
          callbacks.onStateChange?.("ended");
        },
        onerror: (err: unknown) => {
          callbacks.onError?.(`AVPlay error: ${String(err)}`);
        },
      });

      await new Promise<void>((resolve, reject) => {
        avplay.prepareAsync(
          () => {
            this.durationSec = Math.max(0, avplay.getDuration() / 1000);
            callbacks.onReady?.(this.durationSec);
            if (opts.startSec && opts.startSec > 3) {
              try {
                avplay.seekTo(Math.floor(opts.startSec * 1000));
              } catch {}
            }
            avplay.play();
            callbacks.onStateChange?.("playing");
            resolve();
          },
          (err) => {
            reject(err);
          }
        );
      });
    } catch (err) {
      callbacks.onError?.(`Помилка Samsung AVPlay: ${String(err)}`);
    }
  }

  play() {
    try {
      window.webapis?.avplay?.play();
    } catch {}
  }
  pause() {
    try {
      window.webapis?.avplay?.pause();
    } catch {}
  }
  seek(seconds: number) {
    try {
      window.webapis?.avplay?.seekTo(Math.max(0, Math.floor(seconds * 1000)));
    } catch {}
  }
  setPlaybackRate(rate: number) {
    try {
      window.webapis?.avplay?.setSpeed(rate);
    } catch {}
  }
  setVolume(_v: number) {}
  setMuted(_m: boolean) {}
  setAspectMode(mode: AspectMode) {
    try {
      const av = window.webapis?.avplay;
      if (!av) return;
      const m =
        mode === "fill"
          ? "PLAYER_DISPLAY_MODE_CROPPED_FULL"
          : mode === "stretch"
            ? "PLAYER_DISPLAY_MODE_FULL_SCREEN"
            : "PLAYER_DISPLAY_MODE_LETTER_BOX";
      av.setDisplayMethod(m);
    } catch {}
  }
  destroy() {
    try {
      window.webapis?.avplay?.stop();
      window.webapis?.avplay?.close();
    } catch {}
  }
}

/**
 * 3. Lightweight HTML5 / Native HLS (webOS) + Low-RAM hls.js Fallback
 * Uses native HLS where supported (LG webOS / Safari) and tight TV memory buffers for hls.js.
 */
class Html5HlsPlayerAdapter implements PlayerAdapter {
  readonly kind: "webos-native" | "html5-hls";
  readonly isExternalSurface = false;
  private video: HTMLVideoElement | null = null;
  private hls: HlsType | null = null;
  private cleanupListeners: (() => void) | null = null;

  constructor(private readonly platformKind: PlatformKind) {
    this.kind = platformKind === "webos" ? "webos-native" : "html5-hls";
  }

  attachVideoElement(video: HTMLVideoElement | null) {
    this.video = video;
  }

  async load(opts: PlayerLoadOptions, callbacks: PlayerCallbacks): Promise<void> {
    this.teardownPlayback();
    const video = this.video;
    if (!video) {
      callbacks.onError?.("Відеоелемент не готовий");
      return;
    }

    callbacks.onStateChange?.("loading");

    const onLoadedMeta = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      if (opts.startSec && opts.startSec > 2 && dur > opts.startSec + 2) {
        try {
          video.currentTime = opts.startSec;
        } catch {}
      }
      if (video.videoWidth && video.videoHeight) {
        callbacks.onResolution?.(video.videoWidth, video.videoHeight);
      }
      callbacks.onReady?.(dur);
    };

    const onTimeUpdate = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      let buffered = video.currentTime;
      if (video.buffered.length > 0) {
        buffered = video.buffered.end(video.buffered.length - 1);
      }
      callbacks.onTimeUpdate?.(video.currentTime, dur, buffered);
    };

    const onPlaying = () => callbacks.onStateChange?.("playing");
    const onPause = () => callbacks.onStateChange?.("paused");
    const onWaiting = () => callbacks.onStateChange?.("buffering");
    const onEnded = () => callbacks.onStateChange?.("ended");
    const onError = () => callbacks.onError?.("Помилка відтворення потоку");

    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);

    this.cleanupListeners = () => {
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };

    const isHlsUrl = opts.url.includes(".m3u8") || opts.url.includes(":hls:");
    const canNativeHls = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));

    // Prefer native hardware HLS on LG webOS / Safari (zero JS demuxing RAM, never loads hls.js)
    if (!isHlsUrl || (this.platformKind === "webos" && canNativeHls)) {
      video.src = opts.url;
      video.load();
      video.play().catch(() => {});
      return;
    }

    // Lazy-load hls.js only when MSE fallback is actually needed (saves ~520KB on ExoPlayer/AVPlay/webOS)
    const { default: Hls } = await import("hls.js");

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        progressive: false,
        startPosition: opts.startSec && opts.startSec > 0 ? opts.startSec : -1,
        // Tight TV RAM budget (18s forward, 30s max, 8s backBuffer vs 150s+ desktop)
        maxBufferLength: 18,
        maxMaxBufferLength: 30,
        backBufferLength: 8,
        maxBufferSize: 24 * 1000 * 1000,
        maxBufferHole: 1.2,
      });
      this.hls = hls;

      let mediaErrorRetries = 0;
      let firstSegmentLoaded = false;
      const watchdog = window.setTimeout(() => {
        if (firstSegmentLoaded || this.hls !== hls) return;
        if (opts.fallbackUrl) {
          hls.destroy();
          this.hls = null;
          video.src = opts.fallbackUrl;
          video.load();
          video.play().catch(() => {});
        } else {
          callbacks.onError?.("Таймаут завантаження HLS-потоку (8с)");
        }
      }, 8000);

      const clearWatchdog = () => {
        firstSegmentLoaded = true;
        window.clearTimeout(watchdog);
      };

      hls.loadSource(opts.url);
      hls.attachMedia(video);

      hls.on(Hls.Events.FRAG_LOADED, clearWatchdog);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && mediaErrorRetries < 2) {
          mediaErrorRetries++;
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrorRetries < 2) {
          mediaErrorRetries++;
          hls.recoverMediaError();
        } else if (opts.fallbackUrl) {
          clearWatchdog();
          hls.destroy();
          this.hls = null;
          video.src = opts.fallbackUrl;
          video.load();
          video.play().catch(() => {});
        } else {
          clearWatchdog();
          callbacks.onError?.(`HLS error: ${data.details}`);
        }
      });
      return;
    }

    if (canNativeHls) {
      video.src = opts.url;
      video.load();
      video.play().catch(() => {});
      return;
    }

    if (opts.fallbackUrl) {
      video.src = opts.fallbackUrl;
      video.load();
      video.play().catch(() => {});
    } else {
      callbacks.onError?.("HLS не підтримується на цьому пристрої");
    }
  }

  play() {
    this.video?.play().catch(() => {});
  }
  pause() {
    this.video?.pause();
  }
  seek(seconds: number) {
    if (this.video && Number.isFinite(seconds)) {
      this.video.currentTime = Math.max(0, seconds);
    }
  }
  setPlaybackRate(rate: number) {
    if (this.video) this.video.playbackRate = rate;
  }
  setVolume(volume01: number) {
    if (this.video) this.video.volume = Math.max(0, Math.min(1, volume01));
  }
  setMuted(muted: boolean) {
    if (this.video) this.video.muted = muted;
  }

  private teardownPlayback() {
    if (this.cleanupListeners) {
      this.cleanupListeners();
      this.cleanupListeners = null;
    }
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.video) {
      try {
        this.video.pause();
        this.video.removeAttribute("src");
        this.video.load();
      } catch {}
    }
  }

  destroy() {
    this.teardownPlayback();
  }
}

export function createPlayerAdapter(kind: PlatformKind): PlayerAdapter {
  if (kind === "android-tv" && typeof window !== "undefined" && window.RDXAndroid?.playerOpen) {
    return new AndroidExoPlayerAdapter();
  }
  if (kind === "tizen" && typeof window !== "undefined" && window.webapis?.avplay) {
    return new TizenAvPlayAdapter();
  }
  return new Html5HlsPlayerAdapter(kind);
}
