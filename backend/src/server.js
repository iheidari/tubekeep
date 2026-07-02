const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('node:path');
const fs = require('node:fs');

const infoRoutes = require('./routes/info');
const downloadRoutes = require('./routes/download');
const filesRoutes = require('./routes/files');
const { startCleanupScheduler } = require('./services/cleanup');
const { downloadsDir } = require('./utils/storage');

const app = express();
const PORT = process.env.PORT || 3001;

// Use helmet but configure it to allow media streaming
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable CSP for media streaming
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin resource sharing
    crossOriginEmbedderPolicy: false, // Allow embedding media
  }),
);

// Configure CORS - allow same-origin requests and configured FRONTEND_URL
const corsOrigin = process.env.FRONTEND_URL || false; // false = allow same-origin only

app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
    credentials: true,
  }),
);

app.use(morgan('dev'));
app.use(express.json());

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use('/api/info', infoRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/files', filesRoutes);

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
  console.error('Error:', err);
  res.status(500).json({
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
