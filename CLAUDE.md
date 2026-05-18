# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start both services (recommended)
./start.sh

# Backend only
cd backend && npm run dev      # nodemon auto-reload
cd backend && npm start        # production
cd backend && npm run cleanup  # manually run cleanup service

# Frontend only
cd frontend && npm run dev     # Vite dev server (port 5173)
cd frontend && npm run build   # production build to dist/
cd frontend && npm run preview # preview production build
cd frontend && npm run lint    # ESLint
```

No test framework is configured in this project.

## Architecture

**Full-stack YouTube/video downloader**: React SPA frontend (port 5173) + Express API backend (port 3001) + yt-dlp CLI tool.

### Download flow
1. `GET /api/info?url=...` → yt-dlp fetches metadata, returns available formats
2. `POST /api/download` → spawns yt-dlp process, returns `downloadId`
3. `GET /api/download/progress/:downloadId` → SSE stream with real-time progress (15s heartbeats for proxy compatibility)
4. `GET /api/files/:downloadId/:filename` → serve file with HTTP range support for in-browser streaming

Files are stored in `backend/downloads/` and auto-deleted after 24 hours by a cleanup scheduler.

### Backend (`backend/src/`)
- **`server.js`** — Express entry point (helmet, CORS, morgan)
- **`routes/`** — thin HTTP layer: `info.js`, `download.js`, `files.js`
- **`services/ytdlp.js`** — all yt-dlp subprocess spawning (video, audio, subtitle download)
- **`services/cleanup.js`** — hourly scheduler that deletes files older than 24h
- **`utils/storage.js`** — metadata JSON read/write, file path management

### Frontend (`frontend/src/`)
- **`App.jsx`** — all state (URL input, formats, progress, history); syncs localStorage history with server on load
- **`components/`** — `FormatSelector`, `ProgressBar`, `VideoPlayer`, `DownloadHistory`, `UrlInput`
- Uses axios + native `fetch` for HTTP, browser `EventSource` for SSE
- Download history persisted in `localStorage` and synced against server file list

### Production deployment
- PM2 process manager (`deploy/ecosystem.config.js`)
- Caddy reverse proxy (`deploy/Caddyfile`) at `ytd.heidari.ca`
- GitHub Actions deploys on push to `main` via SSH (port 22222)

## Code Conventions

**Frontend** — ES modules, no semicolons, single quotes, 2-space indent, functional components + hooks only.

**Backend** — CommonJS (`require`/`module.exports`), semicolons, single quotes, 2-space indent.

API responses always use `{ success: true, data: {...} }` / `{ success: false, error: '...' }`.

Log errors with emoji prefixes for visibility (e.g. `❌ Fetch error:`).

## Environment Variables

```
# backend/.env
PORT=3001
FRONTEND_URL=http://localhost:5173
NODE_ENV=development

# frontend/.env
VITE_API_URL=http://localhost:3001
```

## Prerequisites
- Node.js 18+
- `yt-dlp` installed system-wide (`brew install yt-dlp` on macOS)
