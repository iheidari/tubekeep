const { cleanupOldDownloads } = require('../utils/storage');

const CLEANUP_INTERVAL_HOURS = 1;
// Downloads are a transfer, not storage: a visitor either moves a file to their
// own cloud or downloads it to their device shortly after. Expire after 1h.
const MAX_FILE_AGE_HOURS = 1;

let cleanupInterval = null;

function startCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;

  console.log(
    `🧹 Cleanup scheduler started (runs every ${CLEANUP_INTERVAL_HOURS}h, max age: ${MAX_FILE_AGE_HOURS}h)`,
  );

  runCleanup();

  cleanupInterval = setInterval(() => {
    runCleanup();
  }, intervalMs);

  process.on('SIGINT', () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }
    process.exit(0);
  });
}

function runCleanup() {
  console.log('🧹 Running cleanup...');
  const result = cleanupOldDownloads(MAX_FILE_AGE_HOURS);

  if (result.expired > 0) {
    console.log(`✅ Expired ${result.expired} old downloads: ${result.expiredIds.join(', ')}`);
  } else {
    console.log('✅ No old downloads to expire');
  }

  if (result.errors.length > 0) {
    console.error('⚠️ Cleanup errors:', result.errors);
  }

  return result;
}

function stopCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

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
