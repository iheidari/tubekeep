# Cloud Upload ("Move to cloud") — Design & Next Steps

> Status: **implemented** for **Dropbox and Google Drive**. This document is the agreed design
> from the design interview; OneDrive remains a fast-follow. See "Implementation" below for where
> the code lives. To enable a provider, set its env vars (Dropbox →
> [dropbox-setup.md](./dropbox-setup.md); Google Drive → [google-drive-setup.md](./google-drive-setup.md));
> with them unset that provider is cleanly hidden from the "Move to cloud" menu.

## Goal

After a video/audio is downloaded onto our server, let the visitor **move** it to their own
personal cloud account. "Move" means: upload the file to the visitor's cloud, then
**hard-delete the local copy** on success. The visitor may instead just download the file to
their device. Either way, files auto-expire off our server after **1 hour** (reduced from 24h).

This turns the download from a server-hosted media item into a **transfer**: fetch on our
server → hand to the visitor's cloud → forget.

---

## Settled decisions

### Identity & credentials
- **Per-visitor, anonymous.** No user accounts, no database. Every visitor connects *their own*
  cloud account; files land in *their* cloud.
- **Browser is the system of record for credentials.** Access + refresh tokens live only in the
  visitor's browser (`sessionStorage`). The server **persists nothing** about tokens.
- **Reconnect per session** (sessionStorage dies with the tab). Acceptable because moving is a
  deliberate, occasional action.

### Backend as a stateless OAuth relay
- The backend holds **only the OAuth client secret** (in env, never shipped to the browser).
- It performs the **authorization-code → token exchange** and **refresh-token → access-token**
  refresh, then **returns the tokens to the browser and stores nothing**.
- At move time the browser sends the **access token in the request body** (never a URL); the
  backend uses it for that one upload and discards it.
- Rationale: Google's web token endpoint requires the client secret (no true secret-less public
  web client), so a relay is the only way to keep all three providers uniform while keeping the
  secret safe and tokens client-side. Best-practice OAuth.

### Lifecycle — Model "A" (Move = leaves the server)
- After a **confirmed** upload, immediately `deleteDownload()` (hard-delete the whole dir,
  including `metadata.json`).
- Independently, **auto-expiry drops from 24h → 1h** (`MAX_FILE_AGE_HOURS` in
  `services/cleanup.js`; also update any frontend copy that says "24h").
- **Consequence, accepted:** Play (`/play/:id`) and any shared `/play/:id` link **stop working**
  the moment a file is moved. This is intentional under Model A.
- The "moved" history row lives **only in the browser's localStorage** (the server keeps no
  record after delete). Row shows a **"Open in Dropbox"** affordance.
  > **Superseded (0XC-100).** History is now server-side, per user: the move flags the
  > `downloads` row `moved = true` with the provider link in `moved_info`, and the media
  > directory keeps its `metadata.json` (`markMoved`) rather than being hard-deleted. A
  > moved row stops counting against the user's storage quota.

### Providers
- **v1: Dropbox only.** Fastest path to the exact security model (PKCE public client, browser
  refresh token, no verification wait).
- **Fast-follow:** OneDrive, then Google Drive. **Start Google verification paperwork early** —
  it's the long pole. Use **`drive.file` scope only** (upload-only, can't see the user's files).
- **Easy later adds:** Box, pCloud (same OAuth-relay shape).
- **Separate interface later, only if requested:** WebDAV (Nextcloud/ownCloud/Koofr) and
  S3-compatible (B2/R2/Wasabi) — these use pasted credentials/keys, not per-visitor OAuth, so
  they do **not** fit the OAuth interface. Do not contort the OAuth interface for them.
- All OAuth providers behind one `CloudProvider` interface:
  `isEnabled`, `getPublicConfig`, `exchangeCode`, `refresh`, `upload` (the shipped shape).

### Dropbox specifics
- **App-folder permission model** (not full Dropbox). Files land in `/Apps/Tubekeep/`. No folder
  picker. Tightest blast radius, easiest production approval.
- **Scopes:** `files.content.write` (upload) + `account_info.read` (show "Connected as …").
- **Collisions:** use `autorename` on `finish` so nothing is silently overwritten.
- **Connect UX:** **popup** window → tiny `/oauth/callback` route → `postMessage` to opener →
  popup closes. Main app never navigates away. Triggered **lazily** on first "Move to Dropbox"
  click; token reused from sessionStorage for the rest of the visit.
- **PKCE + `state`** required (CSRF); verifier + state in sessionStorage.
- **"Open in Dropbox":** use a **path-based web deep link** (no extra scope) rather than a shared
  link (`sharing.write`) or temporary link (`files.content.read`).

### Upload engine
- **Use the official `dropbox` npm SDK** (handles upload sessions, refresh, typed errors).
- **Chunked upload sessions** for anything over Dropbox's **150 MB** single-shot cap
  (`upload_session/start` → `append_v2` → `finish`). Just use sessions for everything, or a
  small threshold (≤8 MB single-shot, else session).
- **Stream from disk** (`fs.createReadStream`), never buffer whole files into memory.
- **Token-refresh-aware chunk loop** as cheap insurance (Dropbox access tokens last ~4h, so
  mid-upload expiry is a rare edge — huge files or heavy concurrency only).
- **Per-chunk retry with backoff** (mirrors the SABR retry ethos in `ytdlp.js`).
- **Move all non-metadata files** in the download dir (today it's one media file, but
  `listDownloads` returns a `files` array — future-proofs subtitle/thumbnail writing).
- **No practical per-file size limit** (sessions allow ~350 GB). The real wall is the visitor's
  **Dropbox quota** (free ≈ 2 GB) → `insufficient_space`.

### UX
- **SSE progress bar** for the upload (reuse the download progress UX). See transport below.
- **Button:** "Move to cloud ▾" (Dropbox in v1), on completed items in `DownloadPage` and active
  rows in `DownloadsPage`. **Hidden on already-expired rows** (no file to move).
- **Success:** local file hard-deleted; row flips to "Moved to Dropbox" + "Open in Dropbox" link.
- **Failure (quota / network / auth):** local file **kept**, clear error, fallback button
  **"Download to your device instead."**

### Token-leak-safe SSE transport (differs from the download route)
`EventSource` can't set headers, and the download route puts params in the query string — we must
**not** do that with a live access token (it lands in logs/history). So:
1. `POST /api/cloud/upload` with `{ downloadId, provider, accessToken }` **in the body**.
   Backend creates an in-memory **job**, holds the token in memory *for that job only*, returns a
   `jobId`.
2. `GET /api/cloud/upload/:jobId/progress` (SSE) — URL carries only the opaque `jobId`.
3. On completion/failure the job + token are discarded from memory.

### Security guardrails (v1)
- **Global upload concurrency cap** (e.g. 2–3 simultaneous uploads; queue the rest; surface
  "queued" over SSE). Single most important safeguard for a public, no-auth server.
- **Per-IP rate limiting** (`express-rate-limit`) on `/api/info`, the download endpoint, and the
  OAuth/upload endpoints.
- **Token-exchange hygiene:** validate `state` + PKCE; only accept the registered `redirect_uri`;
  **never log tokens or auth codes**; HTTPS only.
- **In-memory job TTL:** clean up abandoned upload jobs (and their held tokens) after a timeout.

---

## New env vars
Each provider is independent — configure any subset; a provider appears in the menu only
when all of its required creds are set. See `backend/.env.example` / `frontend/.env.example`
for the full list.
```
# backend/.env
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...
DROPBOX_REDIRECT_URI=https://<host>/oauth/callback   # exact match; add localhost for dev

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<host>/oauth/callback    # exact match; add localhost for dev
GOOGLE_DRIVE_FOLDER=Tubekeep                          # optional; default "Tubekeep"

# frontend/.env  (optional — only to OVERRIDE the values the backend publishes)
VITE_DROPBOX_APP_KEY=...          # public app key for the popup/PKCE
VITE_DROPBOX_REDIRECT_URI=...     # exact-match redirect URI
VITE_GOOGLE_CLIENT_ID=...         # public client id for the popup/PKCE
VITE_GOOGLE_REDIRECT_URI=...      # exact-match redirect URI
```
See **[dropbox-setup.md](./dropbox-setup.md)** and **[google-drive-setup.md](./google-drive-setup.md)**
for how to obtain these.

---

## Implementation (v1, shipped)
- **Backend**
  - `services/cloud/dropbox.js` — provider: PKCE/secret token exchange + refresh (direct to
    Dropbox's `/oauth2/token`), account lookup, and the chunked upload engine (8 MB single-shot
    threshold, upload sessions above it, per-chunk retry, disk streaming, typed CloudError codes
    `auth`/`quota`/`upload`). Builds the no-scope "Open in Dropbox" deep link.
  - `services/cloud/googledrive.js` — provider: PKCE/secret token exchange + refresh (direct to
    Google's `/token`), and the resumable-upload engine (find-or-create the "Tubekeep" folder,
    8 MB chunked PUTs to a resumable session, per-chunk retry, disk streaming, same typed
    CloudError codes `auth`/`quota`/`upload`). Uses the `drive.file` scope (app-created files only).
  - `services/cloud/index.js` — provider registry (`getProvider`, `listEnabledProviders`).
  - `services/cloud/jobs.js` — in-memory job manager: concurrency cap (3), queue, per-job
    EventEmitter, hard TTL (30m), token cleared the instant a job settles. On success calls
    `markMoved()` (keeps the metadata row + cloud link, drops the local media) — **not** the
    hard-delete "Model A" sketched in the design section above; that was never shipped.
  - `routes/cloud.js` — `GET /providers`, `POST /oauth/token`, `POST /oauth/refresh`,
    `POST /upload` (token in body → jobId), `GET /upload/:jobId/progress` (SSE). Mounted at
    `/api/cloud` with per-IP rate limiting.
- **Frontend**
  - `lib/cloud.js` — generic, data-driven by a per-provider table (Dropbox, Google Drive): PKCE
    (Web Crypto), popup connect, per-provider sessionStorage token store, refresh-aware
    `getFreshAccessToken(provider)`, `getEnabledProviders()`. Config resolved from
    `/api/cloud/providers` (VITE_ vars optional overrides).
  - `pages/OAuthCallbackPage.jsx` + `/oauth/callback` route (standalone, outside the app shell).
  - `hooks/useCloudMove.js` + `components/MoveToCloud.jsx` — the button/progress/fallback UI.
  - `context/HistoryContext.jsx` — `markMoved`/`forgetMoved`. (As of 0XC-100 the server owns the
    moved flag; the provider only mirrors it, and `dropLocal` is gone.)
  - Wired into `DownloadsPage` (active cards + a `MovedCard`) and `PlayPage`.
- **Known follow-up (not yet done):** the hourly cleanup (`MAX_FILE_AGE_HOURS = 1`) does not yet
  exempt an in-flight move. A move of a file already near the 1h mark could have its source
  expired mid-upload → the upload fails and the local file is kept-then-removed. Low probability;
  the fix is to mark the download `kept` (or hold a lock) for the life of the job. Folded into
  "Future hardening" below.

## Out of scope (parked)
- **Subscription / retention tier:** paid users get files stored *by us* with a
  user-defined retention period. Future feature, not this change.
- **OneDrive, Box, pCloud, WebDAV, S3** connectors (roadmap above). *(Google Drive shipped —
  see Implementation.)*

## Future hardening (make it stronger)
- Optional **real auth** / accounts for users who want "connect once, remembered."
- Mature **rate-limiting** + **abuse monitoring** (per-IP/per-token quotas, anomaly alerts).
- **Per-user upload quotas** and disk-pressure protection.
- Revisit concurrency cap under real load; consider a proper job queue if volume grows.
