const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { downloadVideo, downloadAudio, isSupportedUrl } = require('../services/ytdlp');
const { saveDownloadMetadata } = require('../utils/storage');
const { initSSE } = require('../utils/sse');

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
  const { url, formatId, type, title, thumbnail, keep } = req.query;

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
