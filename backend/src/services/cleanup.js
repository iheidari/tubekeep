const { cleanupOldDownloads, listDownloads } = require('../utils/storage');
const { sweepJobs } = require('./downloadManager');

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
  // Scan the downloads directory once and reuse the snapshot below: listDownloads
  // is synchronous and stats every download dir, so a second walk would block the
  // event loop twice per sweep for the same answer.
  const downloads = listDownloads();
  const result = cleanupOldDownloads(MAX_FILE_AGE_HOURS, downloads);

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
      // Reconcile against what is actually still on disk, so rows also expire
      // when the files went away by some other route (standalone `npm run
      // cleanup`, a manual rm) — not just when this run expired them. Derived
      // from the pre-sweep snapshot minus what this run just expired, which is
      // the same set a fresh scan would report.
      const expiredNow = new Set(result.expiredIds);
      const present = downloads
        .filter((d) => !d.expired && !expiredNow.has(d.downloadId))
        .map((d) => d.downloadId);
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

// Standalone `npm run cleanup`: filesystem only. No store is registered in this
// process, so history rows are left to the running server's hourly sweep to
// reconcile (it re-derives expiry from the media that is now gone).
if (require.main === module) {
  const result = cleanupOldDownloads(MAX_FILE_AGE_HOURS);
  console.log('Manual cleanup result:', result);
  process.exit(0);
}

module.exports = {
  startCleanupScheduler,
  stopCleanupScheduler,
  runCleanup,
};
