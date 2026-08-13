# Tubekeep

A full-stack web application for downloading videos from YouTube and other platforms using yt-dlp. Features include video/audio quality selection, real-time download progress, in-browser streaming, and download history management.

## Architecture

```
tubekeep/
├── backend/               # Node.js Express API server
│   ├── src/
│   │   ├── server.js      # Express app configuration
│   │   ├── routes/        # API endpoints
│   │   │   ├── info.js         # Video info endpoint
│   │   │   ├── download.js     # Download endpoint
│   │   │   ├── disk.js         # Disk usage + the caller's storage quota
│   │   │   └── files.js        # Per-user download list + file serving
│   │   ├── services/      # Business logic
│   │   │   ├── ytdlp.js        # yt-dlp wrapper
│   │   │   ├── downloadsStore.js # Per-user history (Postgres `downloads` table)
│   │   │   └── cleanup.js      # Auto-cleanup service
│   │   └── utils/         # Utilities
│   │       └── storage.js      # File management
│   └── downloads/         # Temporary storage directory
├── frontend/              # Vite + React SPA
│   └── src/
│       ├── App.jsx        # Main app component
│       └── components/    # React components
│           ├── UrlInput.jsx
│           ├── FormatSelector.jsx
│           ├── ProgressBar.jsx
│           ├── VideoPlayer.jsx
│           └── ProtectedRoute.jsx  # login gate
└── start.sh               # Convenience startup script
```

## Technologies

### Backend
- **Node.js 18+** - Runtime environment
- **Express 4** - Web framework
- **yt-dlp** - Video downloading engine (CLI tool)
- **ffmpeg** - Merges separate video + audio streams into mp4 (CLI tool)
- **pg** - Postgres client (Neon; per-user history, quotas, and the `users` allowlist)
- **jsonwebtoken** - Session-cookie JWTs for the magic-link login
- **resend** - Transactional email for the magic link (unset key → link logged to the console)
- **dropbox** - SDK for the Dropbox "Move to cloud" provider (Google Drive and OneDrive are hand-rolled over `fetch`)
- **helmet** - Security headers
- **cors** - Cross-origin resource sharing
- **morgan** - HTTP request logging
- **cookie-parser** - Reads the session cookie
- **dotenv** - Loads `backend/.env`
- **uuid** - Unique ID generation

### Frontend
- **Vite 8** - Build tool and dev server
- **React 19** - UI library
- **React Router 7** - Routing (`createBrowserRouter`)
- **No HTTP-client dependency** - every API call goes through `apiFetch`, a thin `credentials: 'include'` wrapper over the browser's native `fetch` (`src/lib/media.js`); download progress uses the browser's `EventSource` (SSE)
- **Material Symbols** (Google Fonts) - Icon library, rendered as ligature text in a `<span class="material-symbols-outlined">`
- **Tailwind CSS via the runtime CDN** - Styling, with the whole Material Design 3 design-token theme declared inline in `frontend/index.html`. There is no Tailwind dependency, `tailwind.config.js`, or PostCSS in this repo — see CLAUDE.md → *Styling system — non-obvious* before changing a token.
- **Playwright** - The a11y smoke suite (`frontend/test/a11y/`)

## Features

- **Video Quality Selection**: Choose from 360p to 4K+ resolutions
- **Audio Extraction**: Download audio-only files
- **High Quality Support**: Automatically merges high-res video with audio
- **Real-time Progress**: Watch download progress with Server-Sent Events (SSE)
- **In-browser Player**: Stream videos directly in the browser
- **Resume Where You Left Off**: The player remembers your position and picks a video back up on your next visit — per browser, so it isn't synced across devices
- **Download History**: View, play, and manage previous downloads — stored per-user in Postgres, so it follows your account across devices
- **Per-user Storage Quota**: Each account has a `max_storage_bytes` allowance (default 5 GB, `-1` = unlimited) enforced before a download starts
- **You Decide When Files Go**: Nothing is deleted on a timer — a download stays until you delete it, move it to your cloud, or replace it with a re-download. Your quota is what bounds disk use
- **Unicode Support**: Handles filenames with special characters (Arabic, Persian, etc.)
- **Responsive Design**: Works on desktop and mobile devices

## Prerequisites

Before running the application, ensure you have:

1. **Node.js 18+** installed
   - Check: `node --version`
   - Download: https://nodejs.org/

2. **yt-dlp** installed on your system
   
   **macOS:**
   ```bash
   brew install yt-dlp
   ```
   
   **Ubuntu/Debian:**
   ```bash
   sudo apt update
   sudo apt install yt-dlp
   ```
   
   **Windows:**
   Download from: https://github.com/yt-dlp/yt-dlp/releases
   
   **Verify installation:**
   ```bash
   yt-dlp --version
   ```

3. **ffmpeg** installed on your system

   Required for every video+audio merge (`type: 'video'` downloads are merged
   to mp4). Without it, high-quality downloads fail.

   **macOS:**
   ```bash
   brew install ffmpeg
   ```

   **Ubuntu/Debian:**
   ```bash
   sudo apt install ffmpeg
   ```

   **Verify installation:**
   ```bash
   ffmpeg -version
   ```

## Installation

1. **Clone or create the project directory:**
   ```bash
   mkdir tubekeep
   cd tubekeep
   ```

2. **Install backend dependencies:**
   ```bash
   cd backend
   npm install
   ```

3. **Install frontend dependencies:**
   ```bash
   cd ../frontend
   npm install
   ```

## Running the Application

### Option 1: Using the start script (Recommended)

From the project root:
```bash
./start.sh
```

This will:
- Check for yt-dlp installation
- Start the backend server on port 3001
- Start the frontend dev server on port 5173

### Option 2: Manual startup

**Terminal 1 - Backend:**
```bash
cd backend
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```

### Access the application

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3001
- **Health Check:** http://localhost:3001/health

## Configuration

### Environment Variables

Create `.env` files in the respective directories:

**backend/.env:**
```env
PORT=3001
FRONTEND_URL=http://localhost:5173
NODE_ENV=development
MAX_CONCURRENT_DOWNLOADS=3   # max simultaneous downloads (over the cap → HTTP 429)

# Auth + database (magic-link login). See backend/.env.example for details.
DATABASE_URL=postgres://user:pass@host/db?sslmode=require
JWT_SECRET=                  # session-cookie JWT secret (generate a random value)
APP_URL=http://localhost:3001
RESEND_API_KEY=              # unset in dev → magic link is logged to the console
EMAIL_FROM=Tubekeep <login@yourdomain>
```

Login is an emailed single-use magic link (JWT httpOnly cookie session). Users are managed by hand in the Neon `users` table — there is no signup. The backend applies `schema.sql` automatically on every boot when `DATABASE_URL` is set (idempotent — safe to re-run, and self-heals a database missing a column a later commit added); `cd backend && npm run db:init` still works standalone if you want to provision a fresh database by hand ahead of time. All API routes require a session **except** the public `GET /api/files/:id/:filename` media route, so share links keep working.

**frontend/.env:**
```env
VITE_API_URL=http://localhost:3001
```

### Download Cleanup

**Nothing expires on a timer.** A download's media stays on the server until
someone acts on it: you delete it (default = *expire*, keeping the history row so
it can be re-downloaded), you move it to your cloud, or a fresh download of the
same video supersedes it. What bounds disk use is the **per-user quota**
(`users.max_storage_bytes`, default 5 GB) — hit it and the next download is
refused with a `507` until you free space.

An hourly sweep (`backend/src/services/cleanup.js`) still runs, but it only
reconciles the `downloads` table against the filesystem: healing rows whose
completion write was lost, marking rows whose media went missing as expired, and
retiring (plus cleaning up after) downloads a restart stranded mid-flight. It
never removes the media of a download that succeeded.

## API Endpoints

### Video Info
```
GET /api/info?url=<video_url>
```
Returns video metadata and available formats.

### Start Download
```
POST /api/download
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=...",
  "formatId": "22",
  "type": "combined",
  "title": "Video Title",
  "thumbnail": "https://...",
  "filesize": 12345678
}
```
Mints a `downloadId` **and starts the download server-side** — it runs to
completion regardless of any client connection. The optional `filesize` (the
selected format's bytes) is checked against two independent limits, both
returning **HTTP 507**: your account's storage quota (`users.max_storage_bytes`)
and the server's free disk margin. Over the concurrency cap
(`MAX_CONCURRENT_DOWNLOADS`, default 3) it returns **HTTP 429**. All three run
before any download starts. On success the download is recorded in the
`downloads` table under your user as `status: 'downloading'`, so it survives a
page reload, and is flipped to `complete`/`failed` when the job ends.

### Download Progress (SSE)
```
GET /api/download/progress/:downloadId
```
Pure observer: attaches to the running job and streams real-time progress
(`progress` / `complete` / `error` + `ping` heartbeats). It does not
start a download; disconnecting just unsubscribes, and reconnecting re-attaches.
An unknown id yields a `"download not found"` error.

### Cancel Download
```
DELETE /api/download/:downloadId
```
Aborts a running download job, removes its partial files, and drops its history
row (scoped to your own downloads).

### Storage Usage
```
GET /api/disk
```
Returns `{ total, free, used }` (bytes) for the filesystem holding the downloads
directory, the fit knobs (`sizeMultiplier`, `headroomBytes`), and
`quota: { used, max, remaining }` for the signed-in user (`max`/`remaining` of
`-1` = unlimited). The format screen uses these to show the storage banner and
disable formats that either limit would reject.

### List Downloads
```
GET /api/files
```
Returns **your** downloads, read from the `downloads` table (requires a session).

### Stream/Download File
```
GET /api/files/:downloadId/:filename?action=download
```
- Without `action=download`: Stream in browser
- With `action=download`: Force file download

### Delete Download
```
DELETE /api/files/:downloadId[?permanent=true]
```
Default *expires* the download (media removed, row kept so it can be
re-downloaded); `?permanent=true` deletes the row and directory outright. Both
are scoped to your own downloads — another user's id reads as `404` — and both
free the bytes from your quota.

## Usage Guide

1. **Enter Video URL**
   - Paste a YouTube (or other supported platform) URL
   - Click "Get Info"

2. **Select Quality**
   - **Video Quality (HD/4K)** - High quality options (1080p, 4K, etc.)
   - **Ready to Use (Pre-merged)** - Lower quality but ready immediately
   - **Audio Only** - Audio extraction

3. **Download**
   - Click "Download" button
   - Watch real-time progress bar

4. **Play or Download**
   - Stream directly in the browser
   - Click "Download File" to save to your device
   - Click "Open in New Tab" for full-screen viewing

5. **Manage History**
   - View all downloads in the history section below
   - Shows remaining time before auto-deletion
   - Click "Play" to stream again
   - Click "Delete" to remove permanently

## Supported Platforms

yt-dlp supports hundreds of video platforms, including:
- YouTube
- Vimeo
- Dailymotion
- Facebook
- Twitter/X
- TikTok
- Instagram
- And many more...

## Troubleshooting

### "yt-dlp not found" error
```bash
# macOS
brew install yt-dlp

# Ubuntu/Debian
sudo apt install yt-dlp

# Or use pip
pip install yt-dlp
```

### Video won't play in browser
- Some formats (MKV, WebM) may not play in all browsers
- Try "Open in New Tab" or download the file
- Chrome/Firefox have the best video codec support

### "Failed to load media" error
- The media may have been deleted (by you, or superseded by a re-download of the same video) or moved to a cloud account
- Re-download the video

### CORS errors
- Ensure backend and frontend are running on correct ports
- Check CORS configuration in `backend/src/server.js`

### History looks empty or out of date
- History lives in Postgres, scoped to your account — make sure you're logged in as the right user
- Confirm `DATABASE_URL` is set — the schema applies itself on boot, but check the server log for `❌ Failed to apply database schema` (fatal in production, a warning in development); `cd backend && npm run db:init` re-applies it by hand if needed
- Look for `❌ Server sync error` in the browser console, or a 401 (expired session — log in again)

### "Not enough storage in your account" when starting a download
- You've hit your per-user quota (`users.max_storage_bytes`, default 5 GB). Delete
  or move some downloads to free space, or raise the value on your `users` row in
  the Neon dashboard (`-1` = unlimited)

## Development

### Backend Development
```bash
cd backend
npm run dev  # Uses nodemon for auto-reload
```

### Frontend Development
```bash
cd frontend
npm run dev  # Uses Vite dev server
```

### Production Build
```bash
cd frontend
npm run build  # Creates dist/ folder
```

### Tests
```bash
cd backend  && npm test         # node:test unit + integration suite
cd frontend && npm test         # Playwright a11y smoke suite (rendered pages)
cd frontend && npm run test:install  # one-time: fetch the browser
```

Both suites are hermetic — no network, database, or `yt-dlp` needed — and both run on every PR
(`.github/workflows/ci.yml`). The frontend suite is a small rendered-page regression net for the
things lint and `vite build` structurally can't see: focus-ring visibility (a CSS specificity
conflict once shipped it invisible on every text input) and the `aria-disabled` +
`aria-describedby` convention.

## Security Considerations

- Downloads are stored temporarily and auto-deleted
- Download history is per-user: every list/expire/delete/keep query is scoped to the session's `user_id`, so one account can't read or remove another's downloads
- CORS is pinned to `FRONTEND_URL` with credentials enabled (never a wildcard)
- Helmet provides security headers but CSP is disabled for video streaming
- Authentication is an emailed single-use magic link → JWT httpOnly cookie session. Users are a closed, hand-managed set in the Neon `users` table (no public signup). All API routes require a session except the public `GET /api/files/:id/:filename` media route (so share links work)

## Contributing

Multi-user support is in place: magic-link login, Neon Postgres, a gated React SPA,
per-user download history in the `downloads` table, and the per-user storage quota
(`users.max_storage_bytes`, `-1` = unlimited) enforced alongside the global free-disk
guard.

## License

MIT License - Feel free to use, modify, and distribute.

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - The powerful video downloader this project is built on
- [Vite](https://vitejs.dev/) - Fast frontend tooling
- [React](https://react.dev/) - UI library
