# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start both services for local dev (recommended)
./start.sh

# Backend only
cd backend && npm run dev      # nodemon auto-reload
cd backend && npm start        # production
cd backend && npm run cleanup  # run cleanup once and exit

# Frontend only
cd frontend && npm run dev     # Vite dev server (port 5173), proxies /api → :3001
cd frontend && npm run build   # production build to dist/
cd frontend && npm run preview # preview built dist/ (port 4173), proxies /api → :3001

# Lint & format (Biome) — run from the repo root, covers both frontend and backend
npm run lint                   # biome check .  (lint + format diagnostics, no writes)
npm run format                 # biome format --write .  (apply formatting)
npm run check                  # biome check --write .  (apply safe lint fixes + formatting)
```

No test framework is configured. Linting/formatting is [Biome](https://biomejs.dev) via a single root `biome.json`; the `frontend/` and `backend/` packages each also expose `npm run lint` / `npm run format` that shell out to the same root-installed Biome.

**Single-server mode:** if `frontend/dist/` exists, `backend` serves it statically with an SPA fallback (see `server.js`). So `cd frontend && npm run build` then `cd backend && npm start` serves the whole app on port 3001 with no separate frontend process. This is how production runs.

## Architecture

**Tubekeep** — a yt-dlp-backed video/audio downloader. React SPA (Vite, port 5173 in dev) + Express API (port 3001) + the `yt-dlp` CLI. Downloads land in `backend/downloads/<downloadId>/` and are *expired* (not hard-deleted) after 24h.

### Download flow
1. `GET /api/info?url=...` → `services/ytdlp.js` runs `yt-dlp --dump-json`, returns formats grouped into `{ video, audio, combined }`.
2. `POST /api/download` → only mints and returns a `downloadId` (a UUID). **No download happens here.**
3. `GET /api/download/progress/:downloadId?url=...&formatId=...&type=...&filesize=...` → this SSE endpoint is what actually spawns yt-dlp. Before spawning it applies a **pre-download disk-space check**: if the client-passed `filesize` (the selected format's bytes) fails the fit margin (`hasRoomFor` in `utils/storage.js`), it emits a clean `error` event and never starts yt-dlp. It streams `started` / `progress` / `complete` / `error` events plus `ping` heartbeats every 15s (for proxy keep-alive), and writes `metadata.json` on completion.
4. `GET /api/files/:downloadId/:filename` → serves the file with HTTP range support (in-browser seeking/streaming) and RFC 5987 `Content-Disposition` for unicode filenames. `?action=download` forces an attachment.

**Disk-space guard (`GET /api/disk`, `routes/disk.js`):** returns `{ total, free, used }` (bytes, via `fs.promises.statfs(downloadsDir)`) plus the fit knobs `{ sizeMultiplier, headroomBytes }`. The format screen (`FormatSelector`) shows a storage banner and disables any format whose `filesize` fails the margin. The fit math lives once in `utils/storage.js` — `hasRoomFor(free, filesize)` with `free >= filesize * DISK_SIZE_MULTIPLIER (2×) + DISK_HEADROOM_BYTES (500 MB)` — and the frontend reads the same knobs from the `/api/disk` response (`hasRoomFor` in `lib/media.js`) so client disable-check and server backstop can't drift. The `2×` covers the transient video+audio merge; unknown-size formats are never blocked. The client-passed `filesize` is untrusted (a UX guard, not a security boundary).

### yt-dlp integration (`services/ytdlp.js`) — read before touching downloads
This file carries deliberate workarounds for YouTube's 2026-era extraction breakage. Do not "simplify" them away:
- **`YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=android_vr;formats=missing_pot'`** is passed to *every* yt-dlp invocation. The default web/tv clients require a JS challenge solver that's broken in yt-dlp 2026.02.x (yields only a single 360p format and hangs). `android_vr` restores the full 144p→4K ladder; `formats=missing_pot` keeps formats whose URLs lack a PO Token. Namespaced under `youtube:` so other extractors are unaffected.
- **SABR retries.** YouTube's per-session SABR experiment intermittently strips format URLs. `getVideoInfo` retries the metadata fetch up to 4× with back-off until video-only formats appear. `downloadVideo`/`downloadAudio` retry up to 3× on `Requested format is not available|SABR|missing a URL`, and use fallback format strings (e.g. `${formatId}+bestaudio/bestvideo+bestaudio/best`) so a vanished exact format still resolves to *something*.
- **Binary & PATH.** Prefers `~/.local/bin/yt-dlp` over the system one, and injects Node's dir into `PATH` because yt-dlp's SABR challenge solver shells out to `node`.
- Video+audio (`type: 'video'`) merges to mp4 via `--merge-output-format mp4`; `type: 'combined'` downloads a pre-merged format as-is; `type: 'audio'` pulls bestaudio.

### Expire vs. delete (two-tier lifecycle)
A download is **"expired"** when its directory + `metadata.json` still exist but the media files are gone (`files.length === 0` in `listDownloads`). This keeps the row visible so it can be re-downloaded. Two distinct destructive operations, both via `DELETE /api/files/:downloadId`:
- default → `expireDownload()`: removes media files, keeps metadata, stamps `expiredAt`.
- `?permanent=true` → `deleteDownload()`: removes the whole directory.

The hourly cleanup scheduler (`services/cleanup.js`, `MAX_FILE_AGE_HOURS = 24`) *expires* old downloads — it does not hard-delete. The frontend mirrors this with two localStorage keys: `tubekeepHistory` (active) and `tubekeepExpired`.

**Re-download dedupe:** when a download **completes** (`addDownload` in `HistoryContext.jsx`), any older *expired* row for the same source URL is dropped from `tubekeepExpired` **and** hard-deleted server-side (`?permanent=true`) so the mount-time `sync()` can't resurrect it on reload — one current row per source. Only expired rows are matched; active and moved-to-cloud rows are left intact.

**Pending/failed rows (client-only lifecycle):** downloads run server-side and finish even if the user leaves the download page, so history rows are written **at click time**, not on SSE completion. `handleDownload` (`InfoPage.jsx`) calls `startPending()` to write a `status: 'downloading'` row to `tubekeepHistory` immediately (fields: `downloadId`, `url`, `type`, `title`, `thumbnail`, `createdAt` — no `filename`/`size` yet). On SSE `complete`, `addDownload(data.data)` replaces it in place with the full completed record (which carries **no** `status`), so it renders as a normal `ActiveCard`. On SSE `error`, `markFailed()` flips it to `status: 'failed'`. `DownloadsPage` routes `status === 'downloading'` → `DownloadingCard` (spinner, links to `/download/:id`, plus a **Dismiss**) and `status === 'failed'` → `FailedCard` (Redownload + Dismiss) **before** the `ActiveCard` fallback. Both give a Dismiss because the backend **aborts the yt-dlp subprocess on client disconnect** (`download.js` `req.on('close')`), so navigating away mid-download abandons it — the placeholder must be user-removable (the ticket forbids auto-cleanup). Because these rows aren't on the server yet, `sync()` preserves local `downloading`/`failed` rows whose `downloadId` isn't in the server's id set (mirroring `preservedMoved`), and Dismiss uses `dropLocal()` — a local-only removal with **no** server `DELETE` and no move to the expired list (unlike `removeDownload`).

### Backend (`backend/src/`)
- **`server.js`** — Express entry (helmet with CSP disabled for media + cross-origin resource policy, CORS, morgan), route mounting, static SPA serving, cleanup scheduler bootstrap.
- **`routes/`** — thin HTTP layer: `info.js`, `download.js` (SSE), `files.js` (range serving + expire/delete), `disk.js` (`GET /api/disk` — server disk usage + fit knobs).
- **`services/ytdlp.js`** — all subprocess spawning (see above).
- **`services/cleanup.js`** — hourly scheduler; also runnable standalone (`npm run cleanup`).
- **`utils/storage.js`** — the source of truth for the directory layout, `metadata.json` I/O, `listDownloads`/`expireDownload`/`deleteDownload`, and the disk-space guard (`getDiskUsage`/`hasRoomFor` + the fit constants).

### Frontend (`frontend/src/`)
Routing-based, **not** a single mega-component (the old `App.jsx`-holds-all-state model is gone):
- **`main.jsx`** — `createBrowserRouter` defines routes; `<HistoryProvider>` wraps the whole router so history state is global.
- **`App.jsx`** — layout shell only (header/nav + `<Outlet/>`).
- **`pages/`** — `HomePage` (URL input → navigates to `/info?url=`), `InfoPage` (format selection), `DownloadPage` (`/download/:id`, runs the SSE), `DownloadsPage` (active + expired lists), `PlayPage` (`/play/:id`), `NotFoundPage`.
- **`context/`** is intentionally split three ways for React Fast Refresh / Biome's `useComponentExportOnlyModules` rule (the react-refresh equivalent): `historyContext.js` (`createContext` + constants), `HistoryContext.jsx` (the `HistoryProvider` with all logic), `useHistory.js` (the hook). Keep this separation when editing.
- **`components/`** — `UrlInput`, `FormatSelector`, `ProgressBar`, `VideoPlayer`.
- **Share links:** `/play/:downloadId` is a stable shareable URL (the Share button copies `window.location.origin/play/:id`). `PlayPage` therefore does a "cold" `GET /api/files` lookup when the download isn't in local context, so a recipient who never downloaded it can still play it.
- `VITE_API_URL` defaults to `window.location.origin` when unset (works in single-server mode).

### Styling system — non-obvious
There is **no Tailwind in `package.json`, no `tailwind.config.js`, and no PostCSS.** Tailwind is loaded at runtime from `cdn.tailwindcss.com` in `frontend/index.html`, and the entire Material Design 3 design-token theme (colors like `surface-container-high`, spacing like `gutter`/`stack-lg`, type scale like `headline-md`/`label-md`) is defined inline in the `<script id="tailwind-config">` block there. **To add or change a design token, edit `index.html`, not a config file.** Icons are Material Symbols via Google Fonts, used as `<span className="material-symbols-outlined">icon_name</span>`. Font is Space Grotesk. `App.css` holds a small amount of legacy plain-CSS for the video player.

## Code Conventions

**Frontend** — ES modules, **no semicolons**, single quotes, 2-space indent, ~100 col, functional components + hooks only. PascalCase component files; the file name matches the default export. Biome ignores unused vars/params prefixed with an underscore (`_foo`).

**Backend** — CommonJS (`require`/`module.exports`), **semicolons**, single quotes, 2-space indent, camelCase files.

API responses are always `{ success: true, data: {...} }` or `{ success: false, error: '...' }`.

Log errors with emoji prefixes for grep-ability (e.g. `❌ Fetch error:`, `⚠️`, `🧹`, `🚀`).

## Environment Variables

```
# backend/.env
PORT=3001
FRONTEND_URL=http://localhost:5173   # CORS origin; unset = same-origin only
NODE_ENV=development

# frontend/.env
VITE_API_URL=http://localhost:3001   # unset → falls back to window.location.origin
```

## Deployment

CI/CD lives in `.github/workflows/deploy.yml`. On push to `main` (or manual dispatch):
1. Build a multi-stage Docker image (`Dockerfile`: frontend `npm run build` → Node 22 runtime with `ffmpeg` + `yt-dlp` installed via pip) and push to `ghcr.io/<repo>:latest`.
2. SSH to a Proxmox Docker host **through a Cloudflare Access tunnel** (`cloudflared access ssh`, using CF service-token secrets), then `cd /opt/tubekeep && docker compose pull && docker compose up -d`.

`docker-compose.yml` runs that GHCR image, maps `3001:3001`, and bind-mounts `./downloads`. The legacy `deploy/ecosystem.config.js` (PM2) is **not** the active path — Docker is. There is no Caddyfile in this repo; TLS/routing is handled externally (Cloudflare).

## Prerequisites
- Node.js 18+ (Docker image uses Node 22)
- `yt-dlp` installed system-wide for local dev (`brew install yt-dlp` on macOS); `ffmpeg` is needed for video+audio merges.
