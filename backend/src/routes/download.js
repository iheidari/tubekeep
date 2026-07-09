const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { isSupportedUrl } = require('../services/ytdlp');
const { initSSE } = require('../utils/sse');
const { startJob, subscribe, cancelJob, DownloadCapError } = require('../services/downloadManager');

// Start a download job and return its id. POST both mints the id AND starts the
// job server-side (via the download manager), so the download runs to completion
// independent of any client connection. The download parameters ride the request
// body; the concurrency cap is enforced here, before any SSE is opened.
router.post('/', (req, res) => {
  const { url, formatId, type, title, thumbnail, keep } = req.body;

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
