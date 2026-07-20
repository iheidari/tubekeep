# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ticket management

Tickets live in Linear under the **Tubekeep** project (team **0xCode**, key `0XC`).

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
2. `POST /api/download` → mints a `downloadId` (a UUID) **and starts the download job** server-side via the download manager. The parameters ride the **request body** (`url`, `formatId`, `type`, `title`, `thumbnail`, `keep`, `filesize`). The job runs yt-dlp to completion **independent of any client connection** — navigating away no longer aborts it. Two guards run here, before any job starts: over the concurrency cap it returns **HTTP 429**, and if the client-passed `filesize` fails the disk fit margin (`hasRoomFor` in `utils/storage.js`) it returns **HTTP 507** — both `{ success: false, error }` the UI surfaces inline.
3. `GET /api/download/progress/:downloadId` → **pure observer SSE.** It looks the job up in the registry, replays current progress, and streams `progress` / `complete` / `error` events plus `ping` heartbeats every 15s (for proxy keep-alive). It **does not spawn a process**; disconnecting only unsubscribes (the job keeps running). Reconnecting (reload / new tab / cold visit) **attaches** to the in-flight job — no second process, no query params needed. An unknown id (e.g. after a server restart) yields a terminal `"download not found"` error.
4. `DELETE /api/download/:downloadId` → **explicit cancel.** Aborts the running job (via its `AbortController`) and removes its partial files. Wired to the `DownloadingCard` **Dismiss** and the download page **Cancel**.
5. `GET /api/files/:downloadId/:filename` → serves the file with HTTP range support (in-browser seeking/streaming) and RFC 5987 `Content-Disposition` for unicode filenames. `?action=download` forces an attachment.

**Download manager (`services/downloadManager.js`)** — an in-memory `Map<downloadId, job>` registry. Each job holds `{ status: 'running'|'complete'|'error', progress, result, error, params, emitter, abortController }`. Observers attach through `subscribe(downloadId, { onProgress, onComplete, onError })`, which atomically replays the job's current/terminal state and then streams live events (returning an unsubscribe fn, or `null` for an unknown id) — the `emitter` stays internal so the observer route is a thin SSE serializer. On completion the job writes `metadata.json` (moved out of the route) so `/api/files`, the mount-time `sync()`, and the `DownloadPage` reconcile path all resolve the finished file. **In-memory only** — an in-flight download dies on server restart (a reconnect then gets "download not found"); terminal jobs are retained ~30 min for late reconnects, then pruned by the hourly cleanup sweep (`sweepJobs`). The concurrency cap is `MAX_CONCURRENT_DOWNLOADS` (default **3**) simultaneously-running jobs.

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

**Pending/failed rows (client-only lifecycle):** downloads run server-side and finish even if the user leaves the download page, so history rows are written **at click time**, not on SSE completion. `handleDownload` (`InfoPage.jsx`) calls `startPending()` to write a `status: 'downloading'` row to `tubekeepHistory` immediately (fields: `downloadId`, `url`, `type`, `title`, `thumbnail`, `createdAt` — no `filename`/`size` yet). On SSE `complete`, `addDownload(data.data)` replaces it in place with the full completed record (which carries **no** `status`), so it renders as a normal `ActiveCard`. On SSE `error`, `markFailed()` flips it to `status: 'failed'`. `DownloadsPage` routes `status === 'downloading'` → `DownloadingCard` (spinner, links to `/download/:id`, plus a **Dismiss**) and `status === 'failed'` → `FailedCard` (Redownload + Dismiss) **before** the `ActiveCard` fallback. Because these rows aren't on the server yet, `sync()` preserves local `downloading`/`failed` rows whose `downloadId` isn't in the server's id set (mirroring `preservedMoved`). The two Dismisses differ: a **downloading** row uses `cancelDownload()` — the job runs server-side regardless of the client, so dismissing it must `DELETE /api/download/:id` to actually stop the job (abort + remove partials) **and** drop the row; a **failed** row uses `dropLocal()` — a local-only removal (no server `DELETE`, no move to the expired list) since its file may never have landed.

### Backend (`backend/src/`)
- **`server.js`** — Express entry (helmet with CSP disabled for media + cross-origin resource policy, CORS, morgan), route mounting, static SPA serving, cleanup scheduler bootstrap.
- **`routes/`** — thin HTTP layer: `info.js`, `download.js` (start job / observer SSE / cancel), `files.js` (range serving + expire/delete), `disk.js` (`GET /api/disk` — server disk usage + fit knobs).
- **`services/ytdlp.js`** — all subprocess spawning (see above).
- **`services/downloadManager.js`** — in-memory job registry that runs downloads to completion decoupled from the client SSE; enforces `MAX_CONCURRENT_DOWNLOADS` (see Download flow).
- **`services/cleanup.js`** — hourly scheduler; also runnable standalone (`npm run cleanup`). Also prunes finished download-job records (`sweepJobs`).
- **`utils/storage.js`** — the source of truth for the directory layout, `metadata.json` I/O, `listDownloads`/`expireDownload`/`deleteDownload`, and the disk-space guard (`getDiskUsage`/`hasRoomFor` + the fit constants).
- **`utils/friendlyError.js`** — `friendlyYtDlpError(rawMessage)`: maps raw yt-dlp stderr to short, blame-free user copy via an ordered `{ pattern, message }` list (unavailable/removed, private, members-only, age-restricted, geo-blocked, live/premiere, unsupported URL, network/timeout), falling back to a generic message. Matches lowercased substrings anywhere in multi-line stderr, most-specific first. `getVideoInfo`'s catch and `downloadManager`'s `runJob` error path both run every user-facing error through it, so `/api/info` and SSE `error` never leak exit codes, extractor tags, or enforcement-vendor names. The **full raw stderr is still `console.error`-logged** server-side for operators — only the user-facing string is rewritten.

### Auth + database (magic-link login)
Only emails present in a **manually-managed** Neon `users` table can log in — there is **no signup and no admin UI**; add/remove a user or change their quota by editing the `users` row in the Neon dashboard. Login is an emailed single-use magic link → a JWT httpOnly cookie session.

- **`db.js`** — lazily-created `pg` connection pool over `DATABASE_URL` (forces TLS). Exposes `query(text, params)` and `getPool()`. Importing it never connects, so tests that inject their own store don't need a database.
- **`schema.sql`** + **`npm run db:init`** (`src/dbInit.js`) — hand-written schema (no ORM/migrations). Defines `users` (id, email UNIQUE, name, `max_storage_bytes` bigint default 5 GB / `-1` = unlimited), `login_tokens` (stores only the SHA-256 **hash** of each token, single-use + ~15-min expiry), and `downloads` (defined here for 0XC-100 to populate; not yet wired). Idempotent — safe to re-run. Apply once against Neon: `DATABASE_URL=… npm run db:init`.
- **`services/mailer.js`** — `sendMagicLink(email, rawToken)`. Sends via the **Resend** HTTP API when `RESEND_API_KEY` is set; otherwise (dev/tests) **logs the link to the server console** so the flow is testable without credentials. Builds links from `APP_URL`, sends from `EMAIL_FROM`. Never throws to the caller (a mail outage must not leak whether an address was allowed).
- **`services/authService.js`** — Express/Postgres-free crypto + orchestration (so it unit-tests in isolation): token `generate`/`hash`, JWT `signSession`/`verifySession` (reads `JWT_SECRET`, 30-day expiry), and `requestMagicLink`/`verifyMagicLink`. Token consumption is a single atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now()` in the store, which is what enforces single-use even under concurrent clicks.
- **`services/authStore.js`** — data access behind a small interface. `createStore(query)` is the Postgres-backed impl; `createMemoryStore()` implements the same four methods in memory for tests. Routes/middleware take a store so nothing touches Postgres in unit tests.
- **`routes/auth.js`** — `createAuthRouter({ store, mailer })`. `POST /api/auth/request` (rate-limited; **generic response regardless of allowlist**), `GET /api/auth/verify?token=…` (consume token → set cookie → redirect to `APP_URL/?login=success|error`), `POST /api/auth/logout` (clear cookie), `GET /api/auth/me` (session user or 401). Cookie flags: httpOnly + SameSite=Lax always, Secure only in prod.
- **`middleware/requireAuth.js`** — `createRequireAuth(store)` verifies the session cookie JWT, loads the user, and attaches `req.user` (incl. `user_id` for 0XC-100); 401 otherwise. Mounted on **every** API router (`/api/info`, `/api/download`, `/api/disk`, `/api/cloud`, and `/api/files`'s list/PATCH/DELETE) **except** the public `GET /api/files/:downloadId/:filename` serve route, so shared `/play/:id` links keep working for logged-out visitors. CORS runs with `credentials: true` against the **pinned** `FRONTEND_URL` (never a wildcard).
- **Deploy ordering** — because every API route now requires a session, this backend must ship **together with or after** the frontend login UI (0XC-98). Deploying it ahead of 0XC-98 would 401 the existing SPA (which sends no session cookie yet) and lock users out. `db.js` verifies the DB's TLS cert by default (`DATABASE_SSL_NO_VERIFY=true` opts out); the server refuses to boot in production without `JWT_SECRET`.

### Frontend (`frontend/src/`)
Routing-based, **not** a single mega-component (the old `App.jsx`-holds-all-state model is gone):
- **`main.jsx`** — `createBrowserRouter` defines routes; `<AuthProvider>` wraps `<HistoryProvider>` wraps `<PlayerProvider>` wraps the router so auth, history, and player state are all global. `/login` and `/oauth/callback` are standalone (outside the `App` shell); everything under `/` is in the shell, with the public `play/:downloadId` declared **before** the `<ProtectedRoute>` layout route that gates the rest.
- **`App.jsx`** — layout shell only (header/nav + `<Outlet/>`). The header shows the logged-in user's `name` (falling back to email) + a **Logout** button (`logout()` → `/login`), or a **Log in** link when signed out (so anonymous `/play/:id` visitors can still reach login).
- **`components/ProtectedRoute.jsx`** — the login gate. Renders `<Outlet/>` for authed users, redirects the rest to `/login`. It also absorbs the magic-link landing: the backend's `GET /api/auth/verify` 302s to `/?login=success|error`, so `ProtectedRoute` strips `?login=success` once the session is loaded, and on `?login=error` (or any anonymous visit) redirects to `/login` carrying `state.linkError` so the login page explains the expired/invalid link.
- **`pages/`** — `LoginPage` (`/login`, email → `POST /api/auth/request` → generic "check your inbox" confirmation; no signup/password), `HomePage` (URL input → navigates to `/info?url=`), `InfoPage` (format selection), `DownloadPage` (`/download/:id`, runs the SSE), `DownloadsPage` (active + expired lists), `PlayPage` (`/play/:id`), `NotFoundPage`.
- **`context/`** follows the same three-file split for every provider (React Fast Refresh / Biome's `useComponentExportOnlyModules` rule): `xContext.js` (`createContext` + constants), `XContext.jsx` (the provider with all logic), `useX.js` (the hook). This holds for `history*`, `player*`, and **`auth*`** (`authContext.js` / `AuthContext.jsx` / `useAuth.js`). Keep this separation when editing. `AuthProvider` loads `GET /api/auth/me` on mount and exposes `{ user, loading, login(email), logout(), refresh() }`; `user` is `{ email, name, max_storage_bytes }` or `null`.
- **Auth is cookie-based** — the session is a JWT httpOnly cookie the frontend never reads. `lib/media.js` exports **`apiFetch`**: a `credentials: 'include'` wrapper every same-origin API call routes through, which broadcasts the `AUTH_UNAUTHORIZED_EVENT` (`tk:unauthorized`) window event on any 401 so `AuthProvider` drops the user and `ProtectedRoute` bounces to `/login` (session expired). SSE streams (`useDownloadProgress`, `useCloudMove`) pass `{ withCredentials: true }` for the same reason. The auth endpoints themselves (`/api/auth/*`) use plain credentialed `fetch` inside `AuthProvider`, **not** `apiFetch` — a 401 from `/me` is the normal "logged out" signal, not a session-expiry event, so it must not re-broadcast the event.
- **`components/`** — `UrlInput`, `FormatSelector`, `ProgressBar`, `VideoPlayer`, `ProtectedRoute`.
- **Share links:** `/play/:downloadId` is a stable shareable URL (the Share button copies `window.location.origin/play/:id`). It is **exempt from the login gate**, and `PlayPage` does a "cold" `GET /api/files` lookup when the download isn't in local context. Note that `/api/files` (the list) is itself session-gated (only `GET /api/files/:id/:filename` is public), so a fully anonymous cold recipient without the row in their own localStorage can't resolve the filename — the gate exemption keeps the route reachable, but true cross-user anonymous resolution would need a public single-item metadata endpoint (backend, out of scope for 0XC-98).
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
FRONTEND_URL=http://localhost:5173   # CORS origin (pinned; credentials enabled). Unset = same-origin only
NODE_ENV=development
MAX_CONCURRENT_DOWNLOADS=3            # max simultaneous downloads; unset/invalid → 3 (429 over the cap)

# --- Auth + database (magic-link login) -----------------------------------
DATABASE_URL=postgres://user:pass@host/db?sslmode=require  # Neon connection string
# DATABASE_SSL_NO_VERIFY=true        # opt-out: skip TLS cert verification (still encrypted) if the DB's CA isn't trusted
JWT_SECRET=                          # HMAC secret for the session cookie JWT (generate a long random value). REQUIRED in production — the server refuses to start without it
APP_URL=http://localhost:3001        # base URL the emailed magic link points at; also the post-login redirect target
RESEND_API_KEY=                      # Resend API key. UNSET in dev → the magic link is logged to the server console instead of emailed
EMAIL_FROM=Tubekeep <login@yourdomain>  # verified Resend sender for the magic-link email

# frontend/.env
VITE_API_URL=http://localhost:3001   # unset → falls back to window.location.origin
```

Secrets (`DATABASE_URL`, `JWT_SECRET`, `RESEND_API_KEY`) live only in `backend/.env` (gitignored) — never commit them.

## Deployment

CI/CD lives in `.github/workflows/deploy.yml`. On push to `main` (or manual dispatch):
1. Build a multi-stage Docker image (`Dockerfile`: frontend `npm run build` → Node 22 runtime with `ffmpeg` + `yt-dlp` installed via pip) and push to `ghcr.io/<repo>:latest`.
2. SSH to a Proxmox Docker host **through a Cloudflare Access tunnel** (`cloudflared access ssh`, using CF service-token secrets), then `cd /opt/tubekeep && docker compose pull && docker compose up -d`.

`docker-compose.yml` runs that GHCR image, maps `3001:3001`, and bind-mounts `./downloads`. The legacy `deploy/ecosystem.config.js` (PM2) is **not** the active path — Docker is. There is no Caddyfile in this repo; TLS/routing is handled externally (Cloudflare).

## Prerequisites
- Node.js 18+ (Docker image uses Node 22)
- `yt-dlp` installed system-wide for local dev (`brew install yt-dlp` on macOS); `ffmpeg` is needed for video+audio merges.
