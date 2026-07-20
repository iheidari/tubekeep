# Agent Instructions for Tubekeep

This is a full-stack YouTube video downloader application with a React frontend and Node.js/Express backend.

## Project Structure

```
/
├── frontend/          # Vite + React SPA (port 5173)
│   ├── src/
│   │   ├── App.jsx
│   │   └── components/   # React components
│   └── package.json
├── biome.json         # Biome lint + format config (whole repo)
├── backend/           # Express API server (port 3001)
│   ├── src/
│   │   ├── server.js
│   │   ├── routes/       # API endpoints
│   │   ├── services/     # Business logic (yt-dlp wrapper)
│   │   └── utils/        # File management
│   └── package.json
└── start.sh            # Convenience startup script
```

## Build & Development Commands

### Running the Application

**Option 1: Use the start script (recommended)**
```bash
./start.sh
```
This starts both backend (port 3001) and frontend (port 5173).

**Option 2: Manual startup**
```bash
# Terminal 1 - Backend
cd backend && npm run dev

# Terminal 2 - Frontend
cd frontend && npm run dev
```

### Frontend Commands

```bash
cd frontend
npm run dev       # Start dev server (Vite)
npm run build     # Production build to dist/
npm run lint      # Run Biome (biome check .)
npm run format    # Apply Biome formatting
npm run preview   # Preview production build
```

### Backend Commands

```bash
cd backend
npm start         # Start with node
npm run dev       # Start with nodemon (auto-reload)
npm run cleanup   # Run cleanup service manually
```

### Linting & Formatting

[Biome](https://biomejs.dev) handles both linting and formatting for the whole repo via a single root `biome.json`. Run from the repo root:

```bash
npm run lint      # biome check .  (diagnostics only)
npm run format    # biome format --write .
npm run check     # biome check --write .  (safe lint fixes + formatting)
```

**Note:** No test framework is currently configured in this project.

## Code Style Guidelines

### JavaScript/JSX (Frontend)

- **Module System**: ES modules (`import`/`export`) - `"type": "module"` in package.json
- **Quotes**: Single quotes for strings
- **Semicolons**: Omit trailing semicolons
- **Indentation**: 2 spaces
- **Max Line Length**: ~100 characters
- **Components**: Functional components with hooks
- **File Naming**: PascalCase for components (e.g., `UrlInput.jsx`), camelCase for utilities

```jsx
// Good
function UrlInput({ onSubmit, loading }) {
  const [url, setUrl] = useState('')
  
  return (
    <div className="url-input-container">
      <input value={url} onChange={(e) => setUrl(e.target.value)} />
    </div>
  )
}

export default UrlInput
```

### JavaScript (Backend)

- **Module System**: CommonJS (`require`/`module.exports`)
- **Quotes**: Single quotes for strings
- **Semicolons**: Always use semicolons
- **Indentation**: 2 spaces
- **File Naming**: camelCase (e.g., `download.js`)

```javascript
// Good
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ success: true });
});

module.exports = router;
```

### Imports Order

1. Built-in modules (e.g., `fs`, `path`)
2. External dependencies (e.g., `express`, `react`)
3. Internal modules (e.g., `./services/ytdlp`)
4. Styles (CSS files last)

```jsx
import { useState } from 'react'
import { Link } from 'lucide-react'
import UrlInput from './components/UrlInput'
import './App.css'
```

### Naming Conventions

- **Components**: PascalCase (e.g., `DownloadHistory.jsx`)
- **Functions/Variables**: camelCase (e.g., `fetchVideoInfo`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `API_URL`)
- **Routes**: kebab-case for URLs (e.g., `/api/download`)
- **File names**: Match the default export name

### Error Handling

- Use try-catch for async operations
- Log errors with descriptive messages (use emoji prefixes for visibility)
- Return consistent error responses in API

```javascript
// Frontend
try {
  const response = await fetch(url)
} catch (err) {
  console.error('❌ Fetch error:', err)
  setError(err.message)
}

// Backend
try {
  await downloadVideo(url)
} catch (error) {
  console.error('Download error:', error);
  res.status(500).json({ success: false, error: error.message });
}
```

### React Patterns

- Use hooks (`useState`, `useEffect`, `useRef`)
- Use functional components, not class components
- Keep state close to where it's used
- Use `useRef` to prevent stale closures in callbacks
- Use early returns for conditional rendering

### API Response Format

Always return consistent response structure:

```javascript
// Success
{ success: true, data: {...} }

// Error
{ success: false, error: 'Error message' }
```

### Biome Configuration

Linting and formatting are configured in the root `biome.json`:
- Biome recommended rules + the `react` domain (React Hooks + Fast Refresh rules)
- Formatter: 2-space indent, 100 col, single quotes, double-quoted JSX
- Semicolons: `asNeeded` (frontend, no semicolons) with a `backend/**` override forcing `always`
- Respects `.gitignore`; unused vars/params prefixed with `_` are ignored

## Dependencies

### Prerequisites
- Node.js 18+
- yt-dlp installed system-wide (`brew install yt-dlp` on macOS)

### Key Frontend Dependencies
- React 19, Vite 8
- Axios (HTTP client)
- lucide-react (icons)

### Key Backend Dependencies
- Express 4
- helmet (security headers)
- cors, morgan
- uuid

## Environment Variables

Backend (`.env`):
```
PORT=3001
FRONTEND_URL=http://localhost:5173   # CORS origin (pinned; credentials enabled)
NODE_ENV=development

# Auth + database (magic-link login) — see backend/.env.example
DATABASE_URL=postgres://user:pass@host/db?sslmode=require
JWT_SECRET=                          # session-cookie JWT secret
APP_URL=http://localhost:3001        # magic-link base + post-login redirect
RESEND_API_KEY=                      # unset in dev → link logged to console
EMAIL_FROM=Tubekeep <login@yourdomain>
```

Frontend (`.env`):
```
VITE_API_URL=http://localhost:3001
```

## Skills Available

This repo has agent skills installed in `.agents/skills/`:
- `grill-me`: Interview user relentlessly about plans/designs

## Important Notes

- Media files are stored in `backend/downloads/` and auto-expired after 1 hour (`MAX_FILE_AGE_HOURS`)
- Download history lives in the Postgres `downloads` table, scoped to the session's user; each account has a storage quota (`users.max_storage_bytes`, default 5 GB, `-1` = unlimited) enforced at `POST /api/download`
- Uses Server-Sent Events (SSE) for real-time download progress
- CORS is pinned to `FRONTEND_URL` with credentials enabled (never a wildcard)
- Auth is an emailed single-use magic link → JWT httpOnly cookie session; users are a closed, hand-managed set in the Neon `users` table (no signup). All API routes require a session except the public `GET /api/files/:id/:filename` media route
- Always run both frontend and backend together
