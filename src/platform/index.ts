import { createAudioAdapter } from "./audio";
import { createHttpAdapter } from "./http";
import { createPlayerAdapter } from "./player";
import type { AudioAdapter, HttpAdapter, PlatformKind, PlayerAdapter } from "./types";

export * from "./types";

export function detectPlatform(): PlatformKind {
  if (typeof window === "undefined") return "web";
  const ua = navigator.userAgent || "";
  if (window.RDXAndroid || /Android/i.test(ua)) return "android-tv";
  if (window.tizen || window.webapis?.avplay || /Tizen|SMART-TV/i.test(ua)) return "tizen";
  if (window.webOS || /Web0S|webOS|NetCast/i.test(ua)) return "webos";
  return "web";
}

const kind = detectPlatform();

export const platform: {
  readonly kind: PlatformKind;
  readonly isTv: boolean;
  readonly http: HttpAdapter;
  readonly audio: AudioAdapter;
  createPlayer(): PlayerAdapter;
  exitApp(): void;
} = {
  kind,
  isTv: kind !== "web",
  http: createHttpAdapter(kind),
  audio: createAudioAdapter(kind),
  createPlayer: () => createPlayerAdapter(kind),
  exitApp: () => {
    try {
      if (kind === "android-tv") window.RDXAndroid?.exitApp?.();
      else if (kind === "tizen") window.tizen?.application?.getCurrentApplication()?.exit();
      else if (kind === "webos") window.webOS?.platformBack?.();
    } catch {}
  },
};
