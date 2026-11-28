# RDX-TV v2 — Lightweight Smart TV Streaming Client

## Project Overview
**RDX-TV v2** is an ultra-lightweight Smart TV streaming client designed specifically for **1–2 GB RAM TVs**:
- **Android TV (32-bit `armeabi-v7a` + 64-bit `arm64-v8a`)**: lightweight Kotlin shell (`android-tv/`) hosting a transparent Preact WebView UI over native **Media3 / ExoPlayer** + **OkHttp DoH (`1.1.1.1`)** + **SoundPool**.
- **Samsung Tizen (`.wgt`)**: packaged web app (`tizen/config.xml`) using native hardware **`webapis.avplay`** and direct mirror fetches (`<access origin="*">`).
- **LG webOS (`.ipk`)**: packaged web app (`webos/appinfo.json`) using native `<video>` HLS + local Node.js **`webos-service`** (`webos/service/index.js`) with DoH (`1.1.1.1`/`8.8.8.8`) and CookieJar.

> The legacy Rust/Tauri v1 codebase is archived in the `legacy-rdxtv` branch.

## Tech Stack
- **UI Core (`src/`)**: **Preact** (`preact/compat`) + TypeScript + Vite + Tailwind CSS (zero `framer-motion`, zero `tailwind-merge`, zero WebGL shaders, zero Cloudflare relays).
- **Platform Adapters (`src/platform/`)**:
  - `http.ts` — Android `OkHttp` bridge / webOS Luna service / Tizen direct `fetch` / Vite dev-only DoH proxy.
  - `player.ts` — Android `ExoPlayer` / Samsung `AVPlay` / LG webOS native HLS / lazy-loaded `hls.js` fallback.
  - `audio.ts` — Android `SoundPool` / Web Audio MP3 buffers + oscillator fallback.
- **Scraper (`src/services/tizenRezka.ts`)**: unified client-side HDRezka parser, `#h` stream deobfuscator, chunked Anubis PoW solver, and TMDB `w1280` backdrop lookup.

## Build & Verification
- Dev server (with local DoH proxy): `npm run dev` (`http://localhost:1420`)
- Production web bundle check: `npm run build` (`tsc && vite build`, target `< 80 KB` gzip main JS)
- Samsung Tizen staging: `npm run build:tizen`
- LG webOS staging: `npm run build:webos`
- Android TV assets sync: `npm run build:android-assets`

## Workflow Rules
- **No Cloudflare / external relays**: all networking runs locally on the TV device.
- **TV Performance Budget**: avoid `backdrop-filter`, heavy JS animation libraries, and unbounded buffers on 1–2 GB RAM TVs.
- **Subagent / Swarm Model Policy**: Do NOT use `Model: "flash"` or `Model: "flash_lite"` for subagents in this project. Always use `Model: "inherit"`.
