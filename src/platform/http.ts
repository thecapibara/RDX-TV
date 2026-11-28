import type { HttpAdapter, HttpRequest, HttpResponse, PlatformKind } from "./types";

const DEFAULT_TIMEOUT_MS = 12_000;

/** Pending async HTTP promises for Android Kotlin OkHttp bridge */
const androidPending = new Map<
  string,
  { resolve: (res: HttpResponse) => void; reject: (err: Error) => void; timer: number }
>();

let androidReqSeq = 0;

function ensureAndroidHttpCallback() {
  if (typeof window === "undefined" || window.__rdxAndroidHttpCallback) return;
  window.__rdxAndroidHttpCallback = (requestId: string, responseJson: string) => {
    const entry = androidPending.get(requestId);
    if (!entry) return;
    androidPending.delete(requestId);
    clearTimeout(entry.timer);
    try {
      const parsed = JSON.parse(responseJson) as {
        status?: number;
        ok?: boolean;
        text?: string;
        error?: string;
        finalUrl?: string;
        dohBypass?: boolean;
      };
      if (parsed.error) {
        entry.reject(new Error(parsed.error));
      } else {
        entry.resolve({
          status: parsed.status ?? 200,
          ok: parsed.ok ?? ((parsed.status ?? 200) >= 200 && (parsed.status ?? 200) < 300),
          text: parsed.text ?? "",
          finalUrl: parsed.finalUrl,
          dohBypass: parsed.dohBypass,
        });
      }
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error("Invalid bridge HTTP JSON"));
    }
  };
}

function createAndroidHttpAdapter(): HttpAdapter {
  ensureAndroidHttpCallback();
  return {
    supportsCustomHeaders: true,
    supportsDoh: true,
    request(req: HttpRequest): Promise<HttpResponse> {
      const bridge = window.RDXAndroid;
      if (!bridge?.httpRequestAsync) {
        return createDirectHttpAdapter().request(req);
      }
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const id = `r_${Date.now()}_${++androidReqSeq}`;
      return new Promise<HttpResponse>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          androidPending.delete(id);
          reject(new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);
        androidPending.set(id, { resolve, reject, timer });
        try {
          bridge.httpRequestAsync!(
            id,
            JSON.stringify({
              url: req.url,
              method: req.method || "GET",
              headers: req.headers || {},
              body: req.body ?? null,
              timeoutMs,
            })
          );
        } catch (err) {
          androidPending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}

function createWebOsHttpAdapter(): HttpAdapter {
  return {
    supportsCustomHeaders: true,
    supportsDoh: true,
    request(req: HttpRequest): Promise<HttpResponse> {
      const svc = window.webOS?.service;
      if (!svc) return createDirectHttpAdapter().request(req);
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise<HttpResponse>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        svc.request("luna://com.rdx.tv.service", {
          method: "fetch",
          parameters: {
            url: req.url,
            method: req.method || "GET",
            headers: req.headers || {},
            body: req.body ?? null,
            timeoutMs,
          },
          onSuccess: (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const status = Number(res.status ?? 200);
            resolve({
              status,
              ok: Boolean(res.ok ?? (status >= 200 && status < 300)),
              text: String(res.text ?? ""),
              finalUrl: typeof res.finalUrl === "string" ? res.finalUrl : undefined,
              dohBypass: Boolean(res.dohBypass),
            });
          },
          onFailure: (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(String(err.errorText || err.message || "webOS service error")));
          },
        });
      });
    },
  };
}

function getUserProxyUrl(): string {
  try {
    const raw = localStorage.getItem("rdx_settings");
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { proxy_url?: string };
    const p = (parsed.proxy_url || "").trim();
    if (p.startsWith("http://") || p.startsWith("https://")) {
      return p.replace(/\/+$/, "");
    }
  } catch {}
  return "";
}

function createDirectHttpAdapter(): HttpAdapter {
  return {
    supportsCustomHeaders: false,
    supportsDoh: false,
    async request(req: HttpRequest): Promise<HttpResponse> {
      const method = req.method || "GET";
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const userProxy = getUserProxyUrl();

      let targetUrl = req.url;
      let headers: Record<string, string> = { ...(req.headers || {}) };
      let credentials: RequestCredentials | undefined = "include";

      // Optional user-supplied HTTP proxy (never hardcoded, zero Cloudflare)
      if (userProxy) {
        let ref = "";
        try {
          ref = `${new URL(req.url).origin}/`;
        } catch {}
        targetUrl = `${userProxy}/?url=${encodeURIComponent(req.url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
        headers =
          method === "POST" && headers["Content-Type"]
            ? { "Content-Type": headers["Content-Type"] }
            : {};
        credentials = undefined;
      }

      const init: RequestInit = {
        method,
        ...(credentials ? { credentials } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
      };

      if (typeof AbortController !== "undefined") {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(targetUrl, { ...init, signal: controller.signal });
          const text = await res.text();
          return { status: res.status, ok: res.ok, text, finalUrl: res.url };
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }

      const res = await Promise.race([
        fetch(targetUrl, init),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)
        ),
      ]);
      const text = await res.text();
      return { status: res.status, ok: res.ok, text, finalUrl: res.url };
    },
  };
}

function createDevBrowserHttpAdapter(): HttpAdapter {
  return {
    supportsCustomHeaders: true,
    supportsDoh: true,
    async request(req: HttpRequest): Promise<HttpResponse> {
      const method = req.method || "GET";
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const proxyUrl = `/__rdx_dev_proxy?url=${encodeURIComponent(req.url)}`;
      const headers: Record<string, string> = {};
      if (req.headers?.["Content-Type"]) headers["Content-Type"] = req.headers["Content-Type"];
      if (req.headers?.["X-Requested-With"]) headers["X-Requested-With"] = req.headers["X-Requested-With"];

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(proxyUrl, {
          method,
          headers,
          body: req.body,
          signal: controller.signal,
        });
        const text = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          text,
          finalUrl: req.url,
          dohBypass: res.headers.get("X-RDX-DoH") === "1",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createHttpAdapter(kind: PlatformKind): HttpAdapter {
  if (kind === "android-tv" && typeof window !== "undefined" && window.RDXAndroid?.httpRequestAsync) {
    return createAndroidHttpAdapter();
  }
  if (kind === "webos" && typeof window !== "undefined" && window.webOS?.service) {
    return createWebOsHttpAdapter();
  }
  const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  if (kind === "web" && isDev) {
    return createDevBrowserHttpAdapter();
  }
  return createDirectHttpAdapter();
}
