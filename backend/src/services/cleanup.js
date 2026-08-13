const {
  listDownloadDirs,
  isValidDownloadId,
  hasMedia,
  getDownloadFileSize,
  removeMediaFor,
} = require('../utils/storage');
const { sweepJobs, runningDownloadIds } = require('./downloadManager');

// How often the reconcile sweep runs.
//
// There is deliberately NO age-based expiry: a download's media stays until its
// owner deletes it. Disk is bounded by the per-user quota
// (`users.max_storage_bytes`, enforced at POST /api/download), not by a clock —
// so this sweep never removes the media of a download that succeeded. What it
// still does is keep the `downloads` table honest against the filesystem
// (stranded rows healed, vanished media marked expired, crashed downloads
// retired) and prune finished job records.
const CLEANUP_INTERVAL_HOURS = 1;

// A `downloading` history row older than this can't still be running — the job
// registry is in-memory, so a restart strands its row. Generously past the
// longest plausible download so a slow-but-live one is never retired early.
const STALE_DOWNLOADING_MS = 6 * 60 * 60 * 1000;

// A download that finishes *while* the sweep is running is missing from the
// directory snapshot the reconcile compares against, so it would be expired the
// moment it landed. Rows younger than this are left alone — comfortably longer
// than a sweep, far shorter than any real download's lifetime.
const RECONCILE_GRACE_MS = 10 * 60 * 1000;

let cleanupInterval = null;

// yt-dlp's work-in-progress artifacts. A directory containing one of these is
// a download that died mid-flight, not one that finished — only *finished*
// media is evidence of success (0XC-120's partial-media edge case).
const PARTIAL_FILE_RE = /\.(part|ytdl)$/i;

// A download whose media landed on disk must never end up recorded as failed.
// A `downloading` row whose directory already holds finished media — files
// present, none of them yt-dlp partials — and whose job is NOT running in
// this process didn't fail: the completion hook's DB write was lost (e.g. a
// transient error), not the download. Detect it from the `downloads` snapshot
// the caller already scanned and correct the row from the real file, not a
// stale/client-estimated size. The result file is picked the same way the
// download flow itself does (see ytdlp.js's describeDownloadedFile): the
// LARGEST file wins, since the merged output always outweighs any leftover
// intermediate fragments.
//
// This MUST run before failStale (see the call site's ordering note): on the
// same sweep, whichever runs first wins the race for a row that qualifies for
// both, and only this one is correct for a row with finished media on disk. A
// genuinely in-flight job is untouched here — it's excluded via
// runningDownloadIds() (and a job that died mid-flight leaves partial
// artifacts, caught above).
//
// Pre-filters to rows that are actually `downloading` in the DB first —
// normally none, and never more than a handful — instead of stat-ing and
// updating every live download on disk each sweep. Unlike
// expireMissing/failStale, this can't be one bulk UPDATE: it needs a distinct
// on-disk filename/size per row, which only exists after reading the
// filesystem. Returns the number of rows reconciled.
async function reconcileStrandedDownloads(store, downloads) {
  const downloadingIds = new Set(await store.downloadingIds());
  if (downloadingIds.size === 0) return 0;
  const running = new Set(runningDownloadIds());
  let reconciled = 0;
  for (const d of downloads) {
    if (!downloadingIds.has(d.downloadId) || running.has(d.downloadId)) continue;
    if (!hasMedia(d) || d.files.some((f) => PARTIAL_FILE_RE.test(f))) continue;
    let result = null;
    for (const f of d.files) {
      const size = getDownloadFileSize(d.downloadId, f);
      if (size !== null && (!result || size > result.filesize)) {
        result = { filename: f, filesize: size };
      }
    }
    if (!result) continue; // the files vanished between the scan and now
    if (await store.markComplete(d.downloadId, result, { onlyIfDownloading: true })) {
      reconciled++;
    }
  }
  return reconciled;
}

// `store` is the per-user history store (server.js passes the live one). Omitted
// — as in unit tests, which have no database — the sweep can only prune job
// records, since every reconcile step it performs is a table operation.
function startCleanupScheduler({ store = null } = {}) {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;

  console.log(
    `🧹 Cleanup scheduler started (reconcile sweep every ${CLEANUP_INTERVAL_HOURS}h; downloads never expire by age)`,
  );

  // runCleanup is async (it syncs the history table); the scheduler is
  // fire-and-forget, so catch here or a failed sweep becomes an unhandled
  // rejection that takes the process down.
  const sweep = () =>
    runCleanup(store).catch((err) => console.error('❌ Cleanup failed:', err.message));

  sweep();
  cleanupInterval = setInterval(sweep, intervalMs);

  process.on('SIGINT', () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }
    process.exit(0);
  });
}

async function runCleanup(store = null) {
  console.log('🧹 Running cleanup...');
  const result = { reconciled: 0, expiredRows: 0, failedIds: [], errors: [], prunedJobs: 0 };

  if (!store) {
    // Every reconcile step below is a `downloads`-table operation, so with no
    // store there is nothing to do but prune the in-memory job registry — not
    // even the directory scan, which is why it lives below this return.
    result.prunedJobs = pruneJobs();
    return result;
  }

  // Scan the downloads directory once and reuse the snapshot below:
  // listDownloadDirs is synchronous and readdir's every download dir, so a
  // second walk would block the event loop twice per sweep for the same answer.
  const downloads = listDownloadDirs();

  // Heal hook-stranded rows FIRST — before failStale below can retire one that
  // actually succeeded (0XC-120/0XC-151). The reconcile is the only step that
  // can tell a lost completion write apart from a download that really died.
  //
  // A failure here fails CLOSED for failStale: without a trustworthy answer to
  // "did this row actually finish?", recording it as failed (and deleting the
  // media that would have proved otherwise, below) could be wrong, and waiting
  // an hour for the next sweep costs nothing.
  let strandedReconcileOk = true;
  try {
    result.reconciled = await reconcileStrandedDownloads(store, downloads);
    if (result.reconciled > 0) {
      console.log(
        `🧹 Reconciled ${result.reconciled} stranded download(s) that had already finished`,
      );
    }
  } catch (err) {
    console.error(
      '⚠️ Cleanup could not reconcile stranded downloads — skipping failStale this sweep:',
      err.message,
    );
    strandedReconcileOk = false;
  }

  try {
    // Mark rows whose media is gone. Nothing expires media on a timer any more,
    // so this now only catches media that went away by some other route — a
    // manual `rm` in DOWNLOADS_DIR, a lost volume, a partially-failed delete.
    // The row stays visible and re-downloadable, and stops occupying quota.
    const present = downloads
      .filter(hasMedia)
      .map((d) => d.downloadId)
      // The ids become a ::uuid[] parameter, so one non-UUID directory name
      // would abort the whole reconcile with a cast error.
      .filter(isValidDownloadId);
    result.expiredRows = await store.expireMissing(present, RECONCILE_GRACE_MS);
    if (result.expiredRows > 0) {
      console.log(`🧹 Marked ${result.expiredRows} history row(s) expired`);
    }

    // Only ever retire a row as failed once the reconcile above has had its
    // say. A download the server was killed mid-flight leaves a `.part` file
    // behind that no user action will ever reach — the row renders as failed,
    // and a failed row is excluded from the quota — so removing that directory
    // is what keeps a crash from leaking disk permanently now that nothing
    // expires by age. Only the ids failStale itself just retired are touched,
    // so this can never reach a download that succeeded.
    //
    // Sharing expireMissing's try block means an expireMissing failure skips
    // this step too. That's incidental rather than load-bearing — unlike the
    // strandedReconcileOk gate — but it errs the same safe way, so it stays.
    if (strandedReconcileOk) {
      result.failedIds = await store.failStale(STALE_DOWNLOADING_MS);
      if (result.failedIds.length > 0) {
        console.log(
          `🧹 Marked ${result.failedIds.length} stranded in-progress download(s) as failed`,
        );
        result.errors.push(...removeMediaFor(result.failedIds).errors);
      }
    }
  } catch (err) {
    console.error('⚠️ Cleanup could not update download history:', err.message);
  }

  if (result.errors.length > 0) {
    console.error('⚠️ Cleanup errors:', result.errors);
  }

  result.prunedJobs = pruneJobs();
  return result;
}

// Prune terminal (complete/error) download-job records the manager retains for
// reconnects, so a long-lived process doesn't accumulate them.
function pruneJobs() {
  const pruned = sweepJobs();
  if (pruned > 0) {
    console.log(`🧹 Pruned ${pruned} finished download job(s)`);
  }
  return pruned;
}

function stopCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

module.exports = {
  startCleanupScheduler,
  stopCleanupScheduler,
  runCleanup,
};
