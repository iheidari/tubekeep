const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { isSupportedUrl } = require('../services/ytdlp');
const {
  getDiskUsage,
  hasRoomFor,
  requiredBytesFor,
  hasQuotaFor,
  remainingQuota,
  deleteDownload,
  isValidDownloadId,
} = require('../utils/storage');
const { initSSE } = require('../utils/sse');
const { startJob, subscribe, cancelJob, DownloadCapError } = require('../services/downloadManager');

// The namespaced extractor id (0XC-117) rides the request body from the
// client, which already has it from `/api/info` — untrusted input, exactly
// like the `filesize` estimate below. It's only ever used to group THE
// CALLER'S OWN rows for supersede matching (`supersedeForUser` is scoped by
// `userId`), so a forged value can only cause a user to affect their own
// history — not a security boundary, just validate shape/length and move on.
// An invalid value is dropped (falls back to url-based matching) rather than
// rejecting the whole download.
// Postgres `text` rejects an embedded NUL outright, and any other C0 control
// character has no business in an id string — reject the whole class (not
// just \r\n) so a value that fails validation is actually DROPPED as
// documented above, rather than passing here and then blowing up `store.insert`'s
// query, which would reject the whole download instead of just falling back.
const MAX_SOURCE_KEY_LENGTH = 200;
function isValidSourceKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SOURCE_KEY_LENGTH &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control chars to reject them
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

// Human-readable bytes for the out-of-space error messages. Backend has no
// shared formatter, and this is the only place that needs one.
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

// One row per canonical video identity (0XC-10, refined by 0XC-117). When a
// download completes, drop the user's older rows for the same video and remove
// their media, so a re-download replaces the stale entry instead of sitting
// next to it — and the old copy stops occupying the quota. Moved-to-cloud and
// still-downloading rows are spared by the store's supersede rule.
//
// This lives in the job's completion hook, NOT in the browser: downloads finish
// server-side whether or not a client is watching the SSE (0XC-25/0XC-26), and
// the original client-side dedupe silently did nothing whenever the user left
// the download page — which is the normal flow.
//
// Best-effort by design: `runHook` already isolates hook failures so a DB or
// filesystem blip can never turn a finished download into a failed one. The
// hourly sweep reconciles anything left behind.
async function supersedeOlderRows(store, { downloadId, userId, url, sourceKey }) {
  const superseded = await store.supersedeForUser({ downloadId, userId, url, sourceKey });
  for (const id of superseded) {
    try {
      deleteDownload(id);
    } catch (err) {
      console.error(`⚠️  Could not remove superseded media ${id}: ${err.message}`);
    }
  }
  if (superseded.length > 0) {
    console.log(`🧹 Superseded ${superseded.length} older download(s) for ${url}`);
  }
  return superseded;
}

// Build the download router. The per-user history store is injected (server.js
// builds one over the shared pg pool) so the routes stay unit-testable against
// createMemoryStore() without Postgres — same pattern as the files/auth routers.
// `start` defaults to the real download manager; tests pass a stub so the guards
// can be exercised without spawning yt-dlp.
function createDownloadRouter({ store, start = startJob }) {
  const router = express.Router();

  // Start a download job and return its id. POST both mints the id AND starts the
  // job server-side (via the download manager), so the download runs to completion
  // independent of any client connection. The download parameters ride the request
  // body; the concurrency cap, the global disk backstop and the per-user storage
  // quota are all enforced here, before any job (or SSE) is created.
  router.post('/', async (req, res) => {
    const { url, formatId, type, title, thumbnail, keep, filesize, sourceKey } = req.body;
    const userId = req.user.user_id;
    const resolvedSourceKey = isValidSourceKey(sourceKey) ? sourceKey : null;

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
    const kept = keep === true || keep === 'true';

    // The selected format's byte size. Untrusted (it comes from the client) and
    // only a UX guard, exactly like the disk check it feeds — the real size is
    // written back to the row on completion. Unknown/absent size skips both
    // checks, mirroring hasRoomFor/hasQuotaFor.
    const wantBytes = Number.parseInt(filesize, 10);
    const hasWantBytes = Number.isFinite(wantBytes) && wantBytes > 0;

    // Both pre-download guards, behind the one condition that gates them: an
    // unknown/absent size is never blocked. The two lookups are independent, so
    // they run concurrently — a Neon round-trip and a statfs, not one after the
    // other — but they're still evaluated in order, quota before disk, so the
    // rejection the user sees is the one that matters most to them.
    if (hasWantBytes) {
      const max = Number(req.user.max_storage_bytes);
      const [usage, disk] = await Promise.allSettled([store.usageForUser(userId), getDiskUsage()]);

      // Guard 1 — per-user storage quota. Fail-CLOSED on a store error, unlike
      // the disk guard below: the quota is the user's own accounting, so a
      // database outage must not silently hand out unlimited storage.
      if (usage.status === 'rejected') {
        console.error(`❌ Quota check failed for ${downloadId}: ${usage.reason?.message}`);
        return res
          .status(500)
          .json({ success: false, error: 'Could not check your storage quota — try again' });
      }
      const used = usage.value;
      if (!hasQuotaFor(used, max, wantBytes)) {
        const left = remainingQuota(used, max);
        console.warn(
          `⚠️  Refusing download ${downloadId}: over quota (${formatBytes(used)} of ` +
            `${formatBytes(max)} used, wants ${formatBytes(wantBytes)})`,
        );
        return res.status(507).json({
          success: false,
          error:
            `Not enough storage in your account — this download needs ${formatBytes(wantBytes)} ` +
            `but only ${formatBytes(left)} of your ${formatBytes(max)} quota is left. ` +
            'Delete something from your downloads to free space.',
        });
      }

      // Guard 2 — global free disk. Backstops the client-side disable-check:
      // refuse a download that won't fit within the disk margin before starting
      // the job. Fail-OPEN: if reading disk usage errors, we let the download
      // proceed rather than block it (this is server housekeeping, not the
      // user's allowance, and the frontend degrades the same way when /api/disk
      // fails).
      if (disk.status === 'rejected') {
        console.warn(`⚠️  Disk-space check skipped for ${downloadId}: ${disk.reason?.message}`);
      }
      const free = disk.status === 'fulfilled' ? disk.value.free : null;
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

    // Record the download under this user BEFORE starting the job, so the row
    // exists (as `downloading`) even if the client never returns for the SSE —
    // history is server-side now, so this is what makes an in-flight download
    // survive a reload. A failed insert aborts the start: an untracked download
    // would consume disk while counting toward nobody's quota.
    try {
      await store.insert({
        downloadId,
        userId,
        url,
        title,
        thumbnail,
        type: resolvedType,
        filesize: hasWantBytes ? wantBytes : null,
        kept,
        sourceKey: resolvedSourceKey,
      });
    } catch (err) {
      console.error(`❌ Failed to record download ${downloadId}:`, err.message);
      return res.status(500).json({ success: false, error: 'Failed to start download' });
    }

    try {
      start(
        {
          downloadId,
          url,
          formatId,
          type: resolvedType,
          title,
          thumbnail,
          keep: kept,
          sourceKey: resolvedSourceKey,
        },
        {
          // Terminal outcomes land on the user's row. `result.size` is the real
          // on-disk size, replacing the client's estimate for quota accounting.
          onComplete: async (result) => {
            await store.markComplete(downloadId, {
              filename: result.filename,
              filesize: result.size,
            });
            // Only now that this download has actually landed does it replace
            // the user's older rows for the same video — an abandoned or
            // failed re-download must leave the existing one intact.
            await supersedeOlderRows(store, {
              downloadId,
              userId,
              url,
              sourceKey: resolvedSourceKey,
            });
          },
          onError: () => store.markFailed(downloadId),
        },
      );
    } catch (error) {
      // The row is already inserted, so drop it again — a job that never
      // started must not linger as a phantom `downloading` row against the quota.
      store
        .deleteForUser(downloadId, userId)
        .catch((err) => console.error(`⚠️  Could not roll back ${downloadId}: ${err.message}`));

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
  //
  // Scoped to the caller's own downloads: the `complete` frame carries the
  // stored filename, which is the one thing a stranger needs to pull the file
  // off the public serve route. Someone else's id is reported as not found,
  // exactly like an id that never existed.
  router.get('/progress/:downloadId', async (req, res) => {
    const { downloadId } = req.params;
    const sendEvent = initSSE(res);

    let owned = false;
    if (isValidDownloadId(downloadId)) {
      try {
        owned = (await store.findForUser(downloadId, req.user.user_id)) !== null;
      } catch (err) {
        console.error(`❌ Progress ownership check failed (${downloadId}): ${err.message}`);
        sendEvent({ type: 'error', downloadId, error: 'Could not open the progress stream' });
        return res.end();
      }
    }
    if (!owned) {
      sendEvent({ type: 'error', downloadId, error: 'Download not found' });
      return res.end();
    }

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
  // downloading row and the "Cancel" on the download page. The history row is
  // dropped too — a cancelled download never landed, so it shouldn't linger in
  // the list or count against the quota.
  //
  // Deleting the row comes FIRST and is what authorizes the rest: its `WHERE
  // user_id` is the ownership check, so a download id belonging to someone else
  // matches nothing and we stop at 404 without touching their job. (Aborting
  // first would let any logged-in user kill another user's running download by
  // id alone.) A second click finds no row and 404s — harmless, the first one
  // already cancelled.
  router.delete('/:downloadId', async (req, res) => {
    const { downloadId } = req.params;
    if (!isValidDownloadId(downloadId)) {
      return res.status(404).json({ success: false, error: 'Download not found' });
    }

    let owned;
    try {
      owned = await store.deleteForUser(downloadId, req.user.user_id);
    } catch (err) {
      console.error(`❌ Failed to drop cancelled download ${downloadId}:`, err.message);
      return res.status(500).json({ success: false, error: 'Failed to cancel the download' });
    }
    if (!owned) {
      return res.status(404).json({ success: false, error: 'Download not found' });
    }

    // Ours: stop the job if it's still running, then drop the directory. yt-dlp
    // removes its own partials on abort, but a job that finished in the gap
    // between the click and this request would otherwise leave media on disk
    // with no row pointing at it.
    cancelJob(downloadId);
    deleteDownload(downloadId);
    return res.json({ success: true, message: 'Download cancelled' });
  });

  return router;
}

module.exports = { createDownloadRouter };
