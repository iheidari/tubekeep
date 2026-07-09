const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { downloadVideo, downloadAudio, isSupportedUrl } = require('../services/ytdlp');
const {
  saveDownloadMetadata,
  getDiskUsage,
  hasRoomFor,
  requiredBytesFor,
} = require('../utils/storage');
const { initSSE } = require('../utils/sse');

// Human-readable bytes for the disk-full SSE error message. Backend has no
// shared formatter, and this is the only place that needs one.
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

router.post('/', async (req, res) => {
  const { url, formatId, type } = req.body;

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

  res.json({
    success: true,
    data: {
      downloadId,
      url,
      formatId,
      type: type || 'video',
      status: 'started',
    },
  });
});

router.get('/progress/:downloadId', async (req, res) => {
  const { downloadId } = req.params;
  const { url, formatId, type, title, thumbnail, keep, filesize } = req.query;

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

  const sendEvent = initSSE(res);

  let result;
  let progress = 0;
  let finished = false;

  // Heartbeat to prevent proxy timeout (every 15 seconds)
  const heartbeatInterval = setInterval(() => {
    sendEvent({ type: 'ping', downloadId, progress });
  }, 15000);

  // If the client navigates away / closes the tab, stop wasting a yt-dlp
  // subprocess (and the heartbeat) on a dead connection.
  const abortController = new AbortController();
  req.on('close', () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeatInterval);
    abortController.abort();
    console.log(`⚠️  Client disconnected — aborting download ${downloadId}`);
  });

  try {
    // Backstop the client-side disable-check: refuse a download that won't fit
    // within the disk margin before spawning yt-dlp. `filesize` is the selected
    // format's byte size (untrusted, UX guard only); unknown/absent size skips
    // the check, mirroring hasRoomFor. Uses the same fit math as the frontend.
    // The guard is fail-open: if reading disk usage errors, we let the download
    // proceed rather than block it (this is UX, not a security boundary, and the
    // frontend degrades the same way when /api/disk fails).
    const wantBytes = Number.parseInt(filesize, 10);
    if (Number.isFinite(wantBytes) && wantBytes > 0) {
      let free = null;
      try {
        ({ free } = await getDiskUsage());
      } catch (diskErr) {
        console.warn(`⚠️  Disk-space check skipped for ${downloadId}: ${diskErr.message}`);
      }
      if (free !== null && !hasRoomFor(free, wantBytes)) {
        finished = true;
        clearInterval(heartbeatInterval);
        // Report the margined requirement straight from the fit math so the
        // "need ~X" figure can't drift from the actual check (incl. headroom).
        const needBytes = requiredBytesFor(wantBytes);
        console.warn(
          `⚠️  Refusing download ${downloadId}: needs ~${formatBytes(needBytes)}, ` +
            `${formatBytes(free)} free`,
        );
        sendEvent({
          type: 'error',
          downloadId,
          error: `Not enough disk space — need ~${formatBytes(needBytes)}, have ${formatBytes(free)} free`,
        });
        res.end();
        return;
      }
    }

    sendEvent({ type: 'started', downloadId, progress: 0 });

    const onProgress = (p) => {
      progress = Math.min(100, Math.max(0, p));
      sendEvent({ type: 'progress', downloadId, progress });
    };

    const { signal } = abortController;
    if (type === 'audio') {
      result = await downloadAudio(url, formatId, downloadId, onProgress, signal);
    } else if (type === 'video') {
      // Video-only format - will be merged with best audio
      result = await downloadVideo(url, formatId, downloadId, onProgress, true, signal);
    } else {
      // Combined format
      result = await downloadVideo(url, formatId, downloadId, onProgress, false, signal);
    }

    const metadata = {
      url,
      title: title || result.filename,
      thumbnail,
      formatId,
      type: type || 'video',
      filename: result.filename,
      size: result.size,
      kept: keep === 'true',
      createdAt: new Date().toISOString(),
      downloadId,
    };

    // Client already gone (aborted mid-download): don't persist or emit.
    if (finished) return;
    finished = true;

    saveDownloadMetadata(downloadId, metadata);

    sendEvent({
      type: 'complete',
      downloadId,
      progress: 100,
      data: {
        ...metadata,
        fileUrl: `/api/files/${downloadId}/${encodeURIComponent(result.filename)}`,
      },
    });

    clearInterval(heartbeatInterval);
    res.end();
  } catch (error) {
    clearInterval(heartbeatInterval);
    // Swallow errors caused by our own abort-on-disconnect.
    if (finished) return;
    finished = true;
    console.error('❌ Download error:', error);
    sendEvent({
      type: 'error',
      downloadId,
      error: error.message,
    });
    res.end();
  }
});

module.exports = router;
