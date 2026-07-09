const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { isSupportedUrl } = require('../services/ytdlp');
const { getDiskUsage, hasRoomFor, requiredBytesFor } = require('../utils/storage');
const { initSSE } = require('../utils/sse');
const { startJob, subscribe, cancelJob, DownloadCapError } = require('../services/downloadManager');

// Human-readable bytes for the disk-full error message. Backend has no shared
// formatter, and this is the only place that needs one.
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

// Start a download job and return its id. POST both mints the id AND starts the
// job server-side (via the download manager), so the download runs to completion
// independent of any client connection. The download parameters ride the request
// body; the concurrency cap and disk backstop are both enforced here, before any
// job (or SSE) is created.
router.post('/', async (req, res) => {
  const { url, formatId, type, title, thumbnail, keep, filesize } = req.body;

  if (!url || !formatId) {
    return res.status(400).json({
      success: false,
      error: 'URL and formatId are required',
    });
  }

  if (!isSupportedUrl(url)) {
    return res.status(400).json({
      success: false,
      error: 'A valid http(s) URL is required',
    });
  }

  const downloadId = uuidv4();
  const resolvedType = type || 'video';

  // Backstop the client-side disable-check: refuse a download that won't fit
  // within the disk margin before starting the job. `filesize` is the selected
  // format's byte size (untrusted, UX guard only); unknown/absent size skips the
  // check, mirroring hasRoomFor. Fail-open: if reading disk usage errors, we let
  // the download proceed rather than block it (this is UX, not a security
  // boundary, and the frontend degrades the same way when /api/disk fails).
  const wantBytes = Number.parseInt(filesize, 10);
  if (Number.isFinite(wantBytes) && wantBytes > 0) {
    let free = null;
    try {
      ({ free } = await getDiskUsage());
    } catch (diskErr) {
      console.warn(`⚠️  Disk-space check skipped for ${downloadId}: ${diskErr.message}`);
    }
    if (free !== null && !hasRoomFor(free, wantBytes)) {
      // Report the margined requirement straight from the fit math so the
      // "need ~X" figure can't drift from the actual check (incl. headroom).
      const needBytes = requiredBytesFor(wantBytes);
      console.warn(
        `⚠️  Refusing download ${downloadId}: needs ~${formatBytes(needBytes)}, ` +
          `${formatBytes(free)} free`,
      );
      return res.status(507).json({
        success: false,
        error: `Not enough disk space — need ~${formatBytes(needBytes)}, have ${formatBytes(free)} free`,
      });
    }
  }

  try {
    startJob({
      downloadId,
      url,
      formatId,
      type: resolvedType,
      title,
      thumbnail,
      keep: keep === true || keep === 'true',
    });
  } catch (error) {
    if (error instanceof DownloadCapError) {
      // Over the concurrency cap — a plain HTTP error the UI surfaces inline.
      return res.status(429).json({ success: false, error: error.message });
    }
    console.error('❌ Failed to start download:', error);
    return res.status(500).json({ success: false, error: 'Failed to start download' });
  }

  res.json({
    success: true,
    data: {
      downloadId,
      url,
      formatId,
      type: resolvedType,
      status: 'started',
    },
  });
});

// Pure observer: attach to an already-running job and stream its progress as SSE
// frames. This endpoint NEVER spawns a process — it's a thin serializer over the
// download manager's subscribe() (which owns the replay-then-listen state
// machine). Disconnecting only unsubscribes; the job keeps running server-side.
// An unknown id yields a terminal "download not found" error (e.g. after a
// server restart) instead of starting a download.
router.get('/progress/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const sendEvent = initSSE(res);

  let heartbeatInterval = null;
  const stopHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  };

  const unsubscribe = subscribe(downloadId, {
    onProgress: (progress) => sendEvent({ type: 'progress', downloadId, progress }),
    onComplete: (data) => {
      sendEvent({ type: 'complete', downloadId, progress: 100, data });
      stopHeartbeat();
      res.end();
    },
    onError: (error) => {
      sendEvent({ type: 'error', downloadId, error });
      stopHeartbeat();
      res.end();
    },
  });

  if (!unsubscribe) {
    sendEvent({ type: 'error', downloadId, error: 'Download not found' });
    return res.end();
  }

  // A terminal replay above (job already complete/error) may have already ended
  // the response — nothing more to stream.
  if (res.writableEnded) return;

  // Still running: heartbeat to keep proxies from timing out the idle stream,
  // and unsubscribe (no abort — the job keeps running) when the client leaves.
  heartbeatInterval = setInterval(() => sendEvent({ type: 'ping', downloadId }), 15000);
  req.on('close', () => {
    stopHeartbeat();
    unsubscribe();
  });
});

// Explicit cancel: abort a running job and clean up its partial files (the
// yt-dlp layer removes partials on abort). Wired to the "Dismiss" on a
// downloading row and the "Cancel" on the download page.
router.delete('/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const ok = cancelJob(downloadId);

  if (ok) {
    return res.json({ success: true, message: 'Download cancelled' });
  }
  return res.status(404).json({ success: false, error: 'Download not found' });
});

module.exports = router;
