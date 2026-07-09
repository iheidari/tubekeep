// Load backend/.env FIRST — before any module reads process.env. Without this
// FRONTEND_URL (CORS origin) and the DROPBOX_* creds in .env are never applied,
// so cross-origin requests get no Access-Control-Allow-Origin and the cloud
// feature stays disabled. Requires must come after so their module-load-time
// env reads (e.g. services/cloud/dropbox.js) see the loaded values.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('node:path');
const fs = require('node:fs');

const infoRoutes = require('./routes/info');
const downloadRoutes = require('./routes/download');
const filesRoutes = require('./routes/files');
const cloudRoutes = require('./routes/cloud');
const diskRoutes = require('./routes/disk');
const { startCleanupScheduler } = require('./services/cleanup');
const { downloadsDir } = require('./utils/storage');
const { rateLimit } = require('./utils/rateLimit');

const app = express();
const PORT = process.env.PORT || 3001;

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
    // The Dropbox "Move to cloud" flow opens a consent popup that navigates
    // cross-origin (dropbox.com) and relays the auth code back to its opener via
    // postMessage. Helmet's default COOP `same-origin` severs window.opener the
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

// Configure CORS - allow same-origin requests and configured FRONTEND_URL.
// No cookies/Authorization are used, so credentials stay off (enabling them
// alongside a reflected origin is a needless risk).
const corsOrigin = process.env.FRONTEND_URL || false; // false = allow same-origin only

app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
  }),
);

app.use(morgan('dev'));
app.use(express.json());

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Dynamic API responses must not be cached by the browser (pairs with the
// app-wide `etag: false` above so /api/info never answers a 304).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Throttle the endpoints that each shell out to yt-dlp. Generous limits: this
// is a personal app, so the goal is only to cap runaway abuse, not normal use.
app.use('/api/info', rateLimit({ windowMs: 60_000, max: 30 }), infoRoutes);
app.use('/api/download', rateLimit({ windowMs: 60_000, max: 40 }), downloadRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/disk', rateLimit({ windowMs: 60_000, max: 60 }), diskRoutes);
// OAuth exchange + upload kick-off talk to a provider; throttle per-IP. The SSE
// progress stream shares this generous window (60/min absorbs reconnects).
app.use('/api/cloud', rateLimit({ windowMs: 60_000, max: 60 }), cloudRoutes);

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

startCleanupScheduler();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Downloads directory: ${downloadsDir}`);
});

module.exports = app;
