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
const { requireAuth } = require('../middleware/requireAuth');

// RFC 5987 encoding for unicode filenames in Content-Disposition header
function encodeRFC5987(filename) {
  // encodeURIComponent leaves !'()* untouched, but RFC 5987 attr-char forbids
  // them — percent-encode the ones it misses. (Avoids the deprecated `escape`.)
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function getContentDisposition(filename, isDownload) {
  const dispositionType = isDownload ? 'attachment' : 'inline';
  // Use both filename (for compatibility) and filename* (for unicode)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips all non-ASCII (incl. control chars) for the ASCII filename fallback
  const asciiFilename = filename.replace(/[^\x00-\x7F]/g, '_');
  const encodedFilename = encodeRFC5987(filename);
  return `${dispositionType}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

// PUBLIC: byte-range media serving. Declared FIRST, above the requireAuth choke
// below, so it stays reachable without a session — shared `/play/:id` links play
// for recipients who never logged in (see 0XC-97). Every route defined after the
// choke is private by default, so a new route can't accidentally leak.
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

  let stat;
  try {
    // The file can vanish between the existence check and here (hourly cleanup
    // or a concurrent DELETE), so stat defensively → clean 404, never a raw 500.
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

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

  // A read error mid-stream (file deleted, disk issue) must not crash the
  // process on an unhandled 'error' event.
  const onStreamError = (err) => {
    console.error(`❌ File stream error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to read file' });
    } else {
      res.destroy(err);
    }
  };

  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (match[1] === '' && match[2] === '')) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    let start;
    let end;
    if (match[1] === '') {
      // Suffix range: bytes=-N → last N bytes.
      const suffix = parseInt(match[2], 10);
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] === '' ? stat.size - 1 : parseInt(match[2], 10);
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    end = Math.min(end, stat.size - 1);
    const chunksize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', chunksize);

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', onStreamError);
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(filePath);
    stream.on('error', onStreamError);
    stream.pipe(res);
  }
});

// Everything below requires a session. Gating at the router here (rather than
// per-route) makes private the default: any route added after this line is
// auth-gated automatically, and only the public serve route above is exempt.
router.use(requireAuth);

// The download LIST is private — it reflects the server's stored downloads.
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
