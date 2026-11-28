export type PlatformKind = "android-tv" | "tizen" | "webos" | "web";

export type AudioSoundKey = "startup" | "hover" | "modal_open" | "button_click" | "back";

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  finalUrl?: string;
  dohBypass?: boolean;
}

export interface HttpAdapter {
  readonly supportsCustomHeaders: boolean;
  readonly supportsDoh: boolean;
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface AudioAdapter {
  play(key: AudioSoundKey, volume?: number): void;
  preload(): void;
}

export interface SubtitleItem {
  label: string;
  url: string;
}

export interface PlayerLoadOptions {
  url: string;
  fallbackUrl?: string | null;
  title?: string;
  subtitleText?: string;
  startSec?: number;
  subtitles?: SubtitleItem[];
  headers?: Record<string, string>;
}

export interface PlayerCallbacks {
  onReady?: (durationSec: number) => void;
  onTimeUpdate?: (currentSec: number, durationSec: number, bufferedSec: number) => void;
  onStateChange?: (state: "loading" | "playing" | "paused" | "buffering" | "ended") => void;
  onError?: (message: string) => void;
  onResolution?: (width: number, height: number) => void;
}

export interface PlayerAdapter {
  readonly kind: "android-exo" | "tizen-avplay" | "webos-native" | "html5-hls";
  readonly isExternalSurface: boolean;
  attachVideoElement?(video: HTMLVideoElement | null): void;
  load(opts: PlayerLoadOptions, callbacks: PlayerCallbacks): Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setPlaybackRate(rate: number): void;
  setVolume(volume01: number): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

/** Native Android TV Kotlin WebView bridge (`window.RDXAndroid`) */
export interface RDXAndroidBridge {
  httpRequestAsync?(requestId: string, payloadJson: string): void;
  playSound?(key: string): void;
  playerOpen?(payloadJson: string): void;
  playerPlay?(): void;
  playerPause?(): void;
  playerSeek?(seconds: number): void;
  playerSetSpeed?(rate: number): void;
  playerClose?(): void;
  exitApp?(): void;
}

/** Samsung Tizen WebAPIs (`window.webapis.avplay`) */
export interface TizenAvPlay {
  open(url: string): void;
  close(): void;
  prepareAsync(onSuccess: () => void, onError: (err: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(ms: number, onSuccess?: () => void, onError?: (err: unknown) => void): void;
  setSpeed(speed: number): void;
  setDisplayRect(x: number, y: number, w: number, h: number): void;
  setDisplayMethod(method: string): void;
  setListener(listener: Record<string, (...args: unknown[]) => void>): void;
  getDuration(): number;
  getCurrentTime(): number;
  getState(): string;
}

/** LG webOS Luna service (`window.webOS`) */
export interface WebOSGlobal {
  platformBack?(): void;
  service?: {
    request(
      uri: string,
      params: {
        method: string;
        parameters?: Record<string, unknown>;
        onSuccess?: (res: Record<string, unknown>) => void;
        onFailure?: (err: Record<string, unknown>) => void;
      }
    ): void;
  };
}

declare global {
  interface Window {
    RDXAndroid?: RDXAndroidBridge;
    __rdxAndroidHttpCallback?: (requestId: string, responseJson: string) => void;
    __rdxAndroidPlayerEvent?: (eventJson: string) => void;
    webapis?: { avplay?: TizenAvPlay };
    tizen?: {
      tvinputdevice?: { registerKey(key: string): void; registerKeyBatch?(keys: string[]): void };
      application?: { getCurrentApplication(): { exit(): void } };
    };
    webOS?: WebOSGlobal;
  }
}
