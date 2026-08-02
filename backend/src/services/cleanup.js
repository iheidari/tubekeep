const {
  cleanupOldDownloads,
  listDownloadDirs,
  isValidDownloadId,
  hasMedia,
  getDownloadFileSize,
} = require('../utils/storage');
const { sweepJobs, runningDownloadIds } = require('./downloadManager');

const CLEANUP_INTERVAL_HOURS = 1;
// Downloads are a transfer, not storage: a visitor either moves a file to their
// own cloud or downloads it to their device shortly after. Expire after 1h.
const MAX_FILE_AGE_HOURS = 1;

// A `downloading` history row older than this can't still be running — the job
// registry is in-memory, so a restart strands its row. Generously past the
// longest plausible download so a slow-but-live one is never retired early.
const STALE_DOWNLOADING_MS = 6 * 60 * 60 * 1000;

// A download that finishes *while* the sweep is running is missing from the
// directory snapshot the reconcile compares against, so it would be expired the
// moment it landed. Rows younger than this are left alone — comfortably longer
// than a sweep, far shorter than MAX_FILE_AGE_HOURS.
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
// This MUST run before failStale: on the same sweep, whichever runs first
// wins the race for a row that qualifies for both, and only this one is
// correct for a row with finished media on disk. A genuinely in-flight job is
// untouched here — it's excluded via runningDownloadIds() (and a job that
// died mid-flight leaves partial artifacts, caught above).
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
// — as in unit tests and the standalone CLI, which have no database — the sweep
// is filesystem-only.
function startCleanupScheduler({ store = null } = {}) {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;

  console.log(
    `🧹 Cleanup scheduler started (runs every ${CLEANUP_INTERVAL_HOURS}h, max age: ${MAX_FILE_AGE_HOURS}h)`,
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
  // Scan the downloads directory once and reuse the snapshot below: listDownloadDirs
  // is synchronous and stats every download dir, so a second walk would block the
  // event loop twice per sweep for the same answer.
  const downloads = listDownloadDirs();

  // Never age out a directory a job in *this* process is actively writing to.
  // With a store, also spare anything flagged `kept` — the DB is the only
  // remaining record of that, so a directory can't tell on its own. Unlike
  // the pre-0XC-109 metadata.json mirror, `kept` protection now depends on
  // this query succeeding *every* sweep, not just at toggle time — so a
  // failure here fails CLOSED (skip age-based expiry entirely this pass)
  // rather than open. Deleting a `kept` download's media is irreversible; a
  // transient DB hiccup delaying a disk reclaim by an hour is not. Same
  // reasoning as the per-user quota check's fail-closed behavior in
  // routes/download.js.
  const skipIds = new Set(runningDownloadIds());
  let canExpireByAge = true;
  if (store) {
    try {
      for (const id of await store.keptIds()) skipIds.add(id);
    } catch (err) {
      console.error(
        '⚠️ Could not load kept downloads — skipping age-based expiry this sweep to avoid deleting one:',
        err.message,
      );
      canExpireByAge = false;
    }
  }

  const result = canExpireByAge
    ? cleanupOldDownloads(MAX_FILE_AGE_HOURS, { downloads, skipIds })
    : { expired: 0, expiredIds: [], errors: [] };

  if (result.expired > 0) {
    console.log(`✅ Expired ${result.expired} old downloads: ${result.expiredIds.join(', ')}`);
  } else {
    console.log('✅ No old downloads to expire');
  }

  // Mirror the filesystem sweep into the per-user history table, which is what
  // the UI lists and the quota is computed from — otherwise an aged-out download
  // would keep occupying its owner's allowance. No store in unit tests / the
  // standalone CLI without a database, where this is a no-op.
  if (store) {
    try {
      const strandedComplete = await reconcileStrandedDownloads(store, downloads);
      if (strandedComplete > 0) {
        console.log(
          `🧹 Reconciled ${strandedComplete} stranded download(s) that had already finished`,
        );
      }

      // Reconcile against what is actually still on disk, so rows also expire
      // when the files went away by some other route (standalone `npm run
      // cleanup`, a manual rm) — not just when this run expired them. Derived
      // from the pre-sweep snapshot minus what this run just expired, which is
      // the same set a fresh scan would report.
      const expiredNow = new Set(result.expiredIds);
      const present = downloads
        .filter((d) => hasMedia(d) && !expiredNow.has(d.downloadId))
        .map((d) => d.downloadId)
        // The ids become a ::uuid[] parameter, so one non-UUID directory name
        // would abort the whole reconcile with a cast error.
        .filter(isValidDownloadId);
      const reconciled = await store.expireMissing(present, RECONCILE_GRACE_MS);
      if (reconciled > 0) {
        console.log(`🧹 Marked ${reconciled} history row(s) expired`);
      }
      const stale = await store.failStale(STALE_DOWNLOADING_MS);
      if (stale > 0) {
        console.log(`🧹 Marked ${stale} stranded in-progress download(s) as failed`);
      }
    } catch (err) {
      console.error('⚠️ Cleanup could not update download history:', err.message);
    }
  }

  if (result.errors.length > 0) {
    console.error('⚠️ Cleanup errors:', result.errors);
  }

  // Prune terminal (complete/error) download-job records the manager retains for
  // reconnects, so a long-lived process doesn't accumulate them.
  const prunedJobs = sweepJobs();
  if (prunedJobs > 0) {
    console.log(`🧹 Pruned ${prunedJobs} finished download job(s)`);
  }

  return result;
}

function stopCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Standalone `npm run cleanup`: filesystem only, driven by directory mtime —
// there's no store (so no `kept` to read) and no job registry (so no
// `runningDownloadIds()` either, since that only knows about jobs in *this*
// process — this is always a separate, one-shot process from the running
// server). With neither guard available, use the same generous window the
// old dedicated orphan-directory sweep used (`STALE_DOWNLOADING_MS`, 6h)
// instead of the server sweep's much tighter `MAX_FILE_AGE_HOURS` (1h): the
// tight window is only safe *because* the running server's `runCleanup` has
// `runningDownloadIds()` to fall back on, and a lone CLI invocation does not.
// This is still a partial sweep — the running server's hourly sweep is what
// reconciles the history rows and honors `kept` — but it no longer risks
// deleting a live server's in-progress download out from under it just for
// being mtime-quiet within the first hour.
if (require.main === module) {
  const result = cleanupOldDownloads(STALE_DOWNLOADING_MS / (60 * 60 * 1000));
  console.log('Manual cleanup result:', result);
  process.exit(0);
}

module.exports = {
  startCleanupScheduler,
  stopCleanupScheduler,
  runCleanup,
};
