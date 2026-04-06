const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { downloadVideo, downloadAudio, downloadSubtitle } = require('../services/ytdlp');
const { saveDownloadMetadata } = require('../utils/storage');

const activeDownloads = new Map();

router.post('/', async (req, res) => {
  const { url, formatId, type, title, thumbnail } = req.body;

  if (!url || !formatId) {
    return res.status(400).json({
      success: false,
      error: 'URL and formatId are required'
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
      status: 'started'
    }
  });
});

router.get('/progress/:downloadId', async (req, res) => {
  const { downloadId } = req.params;
  const { url, formatId, type, title, thumbnail } = req.query;

  if (!url || !formatId) {
    return res.status(400).json({
      success: false,
      error: 'URL and formatId are required'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let result;
  let progress = 0;

  // Heartbeat to prevent proxy timeout (every 15 seconds)
  const heartbeatInterval = setInterval(() => {
    sendEvent({ type: 'ping', downloadId, progress });
  }, 15000);

  try {
    sendEvent({ type: 'started', downloadId, progress: 0 });

    const onProgress = (p) => {
      progress = Math.min(100, Math.max(0, p));
      sendEvent({ type: 'progress', downloadId, progress });
    };

    if (type === 'audio') {
      result = await downloadAudio(url, formatId, downloadId, onProgress);
    } else if (type === 'video') {
      // Video-only format - will be merged with best audio
      result = await downloadVideo(url, formatId, downloadId, onProgress, true);
    } else {
      // Combined format
      result = await downloadVideo(url, formatId, downloadId, onProgress, false);
    }

    const metadata = {
      url,
      title: title || result.filename,
      thumbnail,
      formatId,
      type: type || 'video',
      filename: result.filename,
      size: result.size,
      createdAt: new Date().toISOString(),
      downloadId
    };

    saveDownloadMetadata(downloadId, metadata);

    sendEvent({
      type: 'complete',
      downloadId,
      progress: 100,
      data: {
        ...metadata,
        fileUrl: `/api/files/${downloadId}/${encodeURIComponent(result.filename)}`
      }
    });

    clearInterval(heartbeatInterval);
    res.end();
  } catch (error) {
    console.error('Download error:', error);
    clearInterval(heartbeatInterval);
    sendEvent({
      type: 'error',
      downloadId,
      error: error.message
    });
    res.end();
  }
});

module.exports = router;
