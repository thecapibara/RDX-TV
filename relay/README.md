# RDX-TV Relay для Samsung Tizen (без ПК)

На Samsung Tizen (`.wgt`) додаток працює з `file://`, тому браузерний WebView блокує `SameSite=Lax` cookies від захисту **Anubis** на всіх дзеркалах HDRezka, а також не вміє робити DoH проти DNS-блокувань провайдера.

Щоб користувачі на Samsung TV могли дивитися фільми **без ПК та без ручних налаштувань**, достатньо 1 раз задеплоїти безкоштовний **Cloudflare Worker** (`100 000` запитів/день безкоштовно). Відеопотоки (`.m3u8` / `.mp4`) йдуть напряму з CDN на телевізор — через Worker проходять лише легкі HTML/AJAX запити каталогу.

## Як підняти за 2 хвилини (безкоштовно)

1. Зайди на [dash.cloudflare.com](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Create Worker** (наприклад, `rdx-tv-relay`).
2. Заміни код на вміст файлу [`cloudflare-worker.js`](./cloudflare-worker.js) та натисни **Deploy**.
3. Скопіюй виданий URL (наприклад, `https://rdx-tv-relay.<твій-subdomain>.workers.dev`).

## Як підключити в RDX-TV

- **Автоматично для всіх користувачів у збірці**: додай у GitHub репозиторії `Settings → Secrets and variables → Actions → New repository secret`:
  - Name: `VITE_TIZEN_RELAY_URL`
  - Value: `https://rdx-tv-relay.<твій-subdomain>.workers.dev`
  Після цього всі нові збірки `.wgt` працюватимуть «з коробки» на будь-якому Samsung TV.
- **Або вручну на телевізорі**: у налаштуваннях `RDX-TV` → **Мережа та дзеркала** → поле **RDX Relay / Проксі** встав URL воркера та натисни **Зберегти**.
