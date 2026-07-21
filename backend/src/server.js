// Load backend/.env FIRST — before any module reads process.env. Without this
// FRONTEND_URL (CORS origin) and the cloud-provider creds (DROPBOX_*/GOOGLE_*)
// in .env are never applied, so cross-origin requests get no
// Access-Control-Allow-Origin and the cloud feature stays disabled. Requires
// must come after so their module-load-time env reads (e.g.
// services/cloud/dropbox.js, services/cloud/googledrive.js) see the values.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const fs = require('node:fs');

const infoRoutes = require('./routes/info');
const { createDownloadRouter } = require('./routes/download');
const { createFilesRouter } = require('./routes/files');
const { createCloudRouter } = require('./routes/cloud');
const { createDiskRouter } = require('./routes/disk');
const { createAuthRouter } = require('./routes/auth');
const { createStore } = require('./services/authStore');
const { createStore: createDownloadsStore } = require('./services/downloadsStore');
const { createRequireAuth } = require('./middleware/requireAuth');
const mailer = require('./services/mailer');
const { query, getPool } = require('./db');
const { applySchema } = require('./dbInit');
const { startCleanupScheduler } = require('./services/cleanup');
const { downloadsDir } = require('./utils/storage');
const { rateLimit } = require('./utils/rateLimit');

const app = express();
const PORT = process.env.PORT || 3001;

// Production sits behind exactly one proxy hop: Cloudflare, terminating
// straight into this container (docker-compose maps the port directly, no
// nginx/Caddy in front — see CLAUDE.md's Deployment section). `trust proxy: 1`
// tells Express to read the client's real address from the outermost
// X-Forwarded-For entry set by that one hop, so `req.ip` reflects the actual
// visitor instead of Cloudflare's own edge IP for every request (which
// collapsed every client into one rate-limit bucket — 0XC-128). A blanket
// `true` would be wrong here: it trusts every hop in an X-Forwarded-For chain,
// letting a client forge extra entries to mint unlimited buckets.
//
// This is still only the fallback path, though: X-Forwarded-For is content a
// client controls, not something Cloudflare's edge authenticates — a request
// that skips Cloudflare entirely can present any chain it likes. rateLimit.js
// prefers the CF-Connecting-IP header (which Cloudflare does overwrite) for
// exactly that reason; `req.ip`/`trust proxy` only matters as its fallback
// for local dev and non-Cloudflare deploys.
app.set('trust proxy', 1);

// Fail fast on missing required secrets rather than degrading silently (a missing
// JWT_SECRET otherwise makes every session 401 while /verify 500s). Hard error in
// production; a warning in dev/test so the spawn-based tests still boot.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('❌ JWT_SECRET is required in production — refusing to start.');
  }
  console.warn('⚠️  JWT_SECRET is not set — auth sessions will not work until it is configured.');
}

// Never let the browser cache or revalidate dynamic API JSON. Express adds a
// default weak ETag to res.json responses, so a repeat `GET /api/info` (fresh
// yt-dlp output) answers `304 Not Modified` — and a cross-origin revalidated
// 304 can surface in the browser as a bare "NetworkError". The data must not be
// cached anyway (yt-dlp's signed URLs rotate per fetch), so kill ETags app-wide
// and mark every /api response `no-store` (see the middleware below). Static
// frontend assets keep their own serve-static ETags — this only affects
// res.json/res.send-generated ones.
app.set('etag', false);

// Use helmet with a scoped CSP. It can't be fully locked down — the Tailwind
// Play CDN JIT-compiles with `new Function` (needs unsafe-eval) and the inline
// tailwind.config block needs unsafe-inline — but it still restricts where the
// app can connect/embed, which is real defense-in-depth for reflected content.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com'],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.tailwindcss.com',
          'https://fonts.googleapis.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin resource sharing
    crossOriginEmbedderPolicy: false, // Allow embedding media
    // The "Move to cloud" flow opens a provider consent popup that navigates
    // cross-origin (dropbox.com / accounts.google.com) and relays the auth code
    // back to its opener via postMessage. Helmet's default COOP `same-origin`
    // severs window.opener the
    // moment the popup goes cross-origin, so the callback lands with a null
    // opener and the flow hangs. `same-origin-allow-popups` keeps the reference
    // to popups this page opened while still isolating us from other openers.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // Don't emit HSTS on a plain-HTTP localhost dev server: browsers store it
    // per-host ignoring the port, so it can force-upgrade every
    // http://localhost:* (incl. the Vite dev server) to https and then fail to
    // connect. Keep HSTS in production, which is served over TLS.
    ...(process.env.NODE_ENV === 'production' ? {} : { hsts: false }),
  }),
);

// Configure CORS. The magic-link session rides an httpOnly cookie, so credentials
// must be enabled — but only against a single PINNED origin (FRONTEND_URL), never
// a wildcard or reflected `*`, which browsers forbid with credentials anyway and
// which would let any site drive the authenticated API. When FRONTEND_URL is
// unset we serve same-origin only (`origin: false` emits no ACAO header), which
// is the single-server production layout.
const corsOrigin = process.env.FRONTEND_URL || false; // false = allow same-origin only

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
  }),
);

app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Dynamic API responses must not be cached by the browser (pairs with the
// app-wide `etag: false` above so /api/info never answers a 304).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// One shared store (over the single pg pool) feeds every consumer, and one
// requireAuth is built from it — no per-router duplication.
const store = createStore(query);
const requireAuth = createRequireAuth(store);

// Per-user download history + storage quota. Injected into the routers below and
// into the background workers (hourly cleanup sweep, cloud-move job) that run
// outside any request — one store, handed down explicitly.
const downloadsStore = createDownloadsStore(query);

// Auth endpoints are public (they establish the session). The magic-link
// request route is rate-limited inside the router; the store + mailer are
// injected so the same router is unit-testable without Postgres/Resend.
app.use('/api/auth', createAuthRouter({ store, mailer }));

// Everything below requires a valid session (`requireAuth` → 401 otherwise),
// EXCEPT the public byte-range file serve route, which is gated inside the files
// router (public serve route first, then a requireAuth choke) so shared
// `/play/:id` links keep working for logged-out visitors.
// Throttle the endpoints that each shell out to yt-dlp. Generous limits: this
// is a personal app, so the goal is only to cap runaway abuse, not normal use.
app.use('/api/info', rateLimit({ windowMs: 60_000, max: 30 }), requireAuth, infoRoutes);
app.use(
  '/api/download',
  rateLimit({ windowMs: 60_000, max: 40 }),
  requireAuth,
  createDownloadRouter({ store: downloadsStore }),
);
app.use('/api/files', createFilesRouter(requireAuth, { store: downloadsStore }));
app.use(
  '/api/disk',
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireAuth,
  createDiskRouter({ store: downloadsStore }),
);
// OAuth exchange + upload kick-off talk to a provider; throttle per-IP. The SSE
// progress stream shares this generous window (60/min absorbs reconnects).
app.use(
  '/api/cloud',
  rateLimit({ windowMs: 60_000, max: 60 }),
  requireAuth,
  createCloudRouter({ store: downloadsStore }),
);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^\/(?!api\/|health$).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error('❌ Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Apply schema.sql (idempotent) before accepting traffic, so a database
// missing a column a later commit added self-heals with no manual `db:init`
// step (0XC-115). Skipped with no DATABASE_URL (unit tests, offline dev) —
// db.js's pool is created lazily, so importing it here doesn't connect on its
// own. A failure is fatal in production (mirrors the JWT_SECRET check above);
// in development it's a loud warning so working offline still boots.
async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
  try {
    await applySchema(getPool());
    console.log('✅ Database schema up to date.');
  } catch (err) {
    console.error('❌ Failed to apply database schema:', err.message);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
    console.warn('⚠️  Continuing without a verified schema (development only).');
  }
}

ensureSchema().then(() => {
  startCleanupScheduler({ store: downloadsStore });

  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Downloads directory: ${downloadsDir}`);
  });
});

module.exports = app;
