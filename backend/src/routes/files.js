const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const {
  isValidDownloadId,
  getDownloadFilePath,
  deleteDownload,
  expireDownload,
} = require('../utils/storage');
const { cancelJob } = require('../services/downloadManager');
const { rateLimit } = require('../utils/rateLimit');
const { hasLocalMedia } = require('../services/downloadsStore');

// Public per-item metadata (0XC-112): project a store row down to only what a
// share-link recipient needs, never an owner detail (no user_id, email, url,
// size, status). `filename` is withheld — and the row reported unavailable —
// whenever there's no local media to serve: still downloading, failed, moved
// to the owner's own cloud, or already expired. The recipient already holds
// the id, so collapsing all of these to one `expired: true` shape leaks
// nothing new; it just tells the player "not playable here" without
// distinguishing *why* for a non-owner.
function toPublicMeta(row) {
  const ready = hasLocalMedia(row);
  return {
    downloadId: row.downloadId,
    title: row.title,
    thumbnail: row.thumbnail,
    type: row.type,
    filename: ready ? row.filename : null,
    expired: !ready,
  };
}

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

// Build the files router. `requireAuth` and the per-user history `store` are
// injected (both built once in server.js over the shared pg pool) so the auth
// wiring is consistent with the other routers and unit-testable without Postgres.
function createFilesRouter(requireAuth, { store }) {
  const router = express.Router();

  const notFound = (res) => res.status(404).json({ success: false, error: 'Download not found' });

  // PUBLIC: single-item metadata for a /play/:id share link (0XC-112). Declared
  // FIRST — ahead of the `/:downloadId/:filename` serve route below, which would
  // otherwise swallow it: `meta/<id>` is the same two-segment shape as
  // `<downloadId>/<filename>`, so without this ordering it would match there
  // first as downloadId="meta" (an invalid UUID) and 404 before ever reaching
  // this handler. A real download whose filename happens to be "meta" is
  // unaffected either way, since its first segment is the download's UUID, not
  // the literal "meta". Also declared above the requireAuth choke below, since
  // the whole point is resolving a link for someone with no session.
  // Looser than the auth-adjacent limiters (this never touches yt-dlp or the
  // filesystem) but still capped so an id can't be scanned unboundedly.
  router.get('/meta/:downloadId', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
    const { downloadId } = req.params;
    if (!isValidDownloadId(downloadId)) return notFound(res);

    try {
      const row = await store.findById(downloadId);
      if (!row) return notFound(res);
      res.json({ success: true, data: toPublicMeta(row) });
    } catch (error) {
      console.error('❌ Public metadata lookup error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to load download metadata' });
    }
  });

  // PUBLIC: byte-range media serving. Declared above the requireAuth choke
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

  // The download LIST is private and per-user: it comes from the `downloads`
  // table scoped to the session's user, not from a scan of the downloads
  // directory, so one user never sees another's history.
  router.get('/', async (req, res) => {
    try {
      res.json({ success: true, data: await store.listByUser(req.user.user_id) });
    } catch (error) {
      console.error('❌ Download list error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to load your downloads' });
    }
  });

  // Toggle "keep forever". The `downloads` row is the only place this lives —
  // the age-based cleanup sweep reads `kept` from the store (see
  // services/cleanup.js), not from disk.
  router.patch('/:downloadId', async (req, res) => {
    const { downloadId } = req.params;
    const kept = req.query.kept === 'true';
    if (!isValidDownloadId(downloadId)) return notFound(res);

    try {
      const ok = await store.setKeptForUser(downloadId, req.user.user_id, kept);
      if (!ok) return notFound(res);
      res.json({ success: true, data: { downloadId, kept } });
    } catch (error) {
      console.error('❌ Keep toggle error:', error.message);
      res.status(500).json({ success: false, error: 'Failed to update the download' });
    }
  });

  // Two-tier destroy, both scoped to the caller's own rows (the ownership check
  // IS the store's WHERE user_id, so another user's id reads as "not found"):
  //   default          → expire: drop the media, keep the row (re-downloadable).
  //                      Complete downloads only — see expireForUser.
  //   ?permanent=true  → delete: drop the media AND the row, stopping the job
  //                      first if one is still running.
  // Either way the freed bytes stop counting toward the user's quota.
  router.delete('/:downloadId', async (req, res) => {
    const { downloadId } = req.params;
    const permanent = req.query.permanent === 'true';
    if (!isValidDownloadId(downloadId)) return notFound(res);

    let ok;
    try {
      ok = permanent
        ? await store.deleteForUser(downloadId, req.user.user_id)
        : await store.expireForUser(downloadId, req.user.user_id);
    } catch (error) {
      console.error('❌ Download delete error:', error.message);
      return res.status(500).json({ success: false, error: 'Failed to remove the download' });
    }
    if (!ok) return notFound(res);

    // Past this point the row has already changed and the caller's intent is
    // recorded, so a filesystem failure is logged rather than reported as a
    // failed request — the hourly sweep reconciles whatever is left on disk.
    try {
      if (permanent) {
        // The row is gone, so nothing would ever point at a still-running job's
        // output. Stop it before removing the directory.
        cancelJob(downloadId);
        deleteDownload(downloadId);
      } else {
        expireDownload(downloadId);
      }
    } catch (error) {
      console.error(`⚠️  Media cleanup failed for ${downloadId}: ${error.message}`);
    }

    res.json({
      success: true,
      message: permanent ? 'Download deleted permanently' : 'Download expired',
    });
  });

  return router;
}

module.exports = { createFilesRouter };
