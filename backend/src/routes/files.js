const express = require('express');
const router = express.Router();
const path = require('node:path');
const fs = require('node:fs');
const {
  listDownloads,
  getDownloadFilePath,
  deleteDownload,
  expireDownload,
  setKept,
} = require('../utils/storage');

// RFC 5987 encoding for unicode filenames in Content-Disposition header
function encodeRFC5987(filename) {
  // Encode non-ASCII characters according to RFC 5987
  return encodeURIComponent(filename)
    .replace(/['()]/g, escape)
    .replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
}

function getContentDisposition(filename, isDownload) {
  const dispositionType = isDownload ? 'attachment' : 'inline';
  // Use both filename (for compatibility) and filename* (for unicode)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips all non-ASCII (incl. control chars) for the ASCII filename fallback
  const asciiFilename = filename.replace(/[^\x00-\x7F]/g, '_');
  const encodedFilename = encodeRFC5987(filename);
  return `${dispositionType}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

router.get('/', (_req, res) => {
  try {
    const downloads = listDownloads();
    res.json({
      success: true,
      data: downloads,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get('/:downloadId/:filename', (req, res) => {
  const { downloadId, filename } = req.params;
  const { action } = req.query;

  const filePath = getDownloadFilePath(downloadId, filename);

  if (!filePath) {
    return res.status(404).json({
      success: false,
      error: 'File not found',
    });
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  // Decode URL-encoded filename
  const decodedFilename = decodeURIComponent(filename);

  // Set Content-Disposition with proper unicode handling
  res.setHeader(
    'Content-Disposition',
    getContentDisposition(decodedFilename, action === 'download'),
  );

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.srt': 'text/plain',
    '.vtt': 'text/vtt',
  };

  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', chunksize);

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }
});

router.patch('/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const kept = req.query.kept === 'true';

  try {
    const ok = setKept(downloadId, kept);
    if (ok) {
      res.json({
        success: true,
        data: { downloadId, kept },
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Download not found',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.delete('/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const permanent = req.query.permanent === 'true';

  try {
    const ok = permanent ? deleteDownload(downloadId) : expireDownload(downloadId);
    if (ok) {
      res.json({
        success: true,
        message: permanent ? 'Download deleted permanently' : 'Download expired',
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Download not found',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
