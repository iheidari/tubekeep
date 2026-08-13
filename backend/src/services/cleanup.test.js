const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Isolate this file's sweeps in a private DOWNLOADS_DIR (0XC-127): test files
// run in parallel processes, and the directory removals exercised here would
// otherwise race other files' fixtures in the shared real downloads root (and
// vice versa). Must be set BEFORE ./cleanup (→ ../utils/storage) is required,
// since storage.js resolves the directory once at load time.
process.env.DOWNLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tubekeep-cleanup-test-'));

const { runCleanup } = require('./cleanup');
const { createMemoryStore } = require('./downloadsStore');
const { ensureDownloadDir } = require('../utils/storage');

const ONE_HOUR_MS = 60 * 60 * 1000;
const USER = '11111111-1111-1111-1111-111111111111';

// Directories this file creates, removed even if an assertion throws so a
// failed run never leaves debris behind.
const created = [];

// A download whose job actually finished: a real directory holding only its
// final media file — the exact shape downloadManager.js leaves behind right
// before its completion hook runs (no partial artifacts, no metadata.json).
function makeFinishedDir(downloadId, { filename = 'video.mp4', contents = 'x'.repeat(10) } = {}) {
  const dir = ensureDownloadDir(downloadId);
  created.push(dir);
  fs.writeFileSync(path.join(dir, filename), contents);
  return dir;
}

// A completed row matching an on-disk directory, the way a real download
// leaves both behind. `ageMs` backdates both timestamps, since every window in
// the sweep is measured from the row, never from the directory.
async function seedCompletedRow(store, id, { ageMs = 0 } = {}) {
  await store.insert({ downloadId: id, userId: USER, url: `https://x/${id}`, filesize: 1 });
  await store.markComplete(id, { filename: 'video.mp4', filesize: 1 });
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    store._rows.get(id).created_at = when;
    store._rows.get(id).completed_at = when;
  }
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  fs.rmSync(process.env.DOWNLOADS_DIR, { recursive: true, force: true });
});

// --- no expiry by age -------------------------------------------------------
// Downloads are storage, not a transfer: media stays until its owner deletes
// it, and disk is bounded by the per-user quota instead of a clock. The sweep
// must therefore never remove the media of a download that succeeded, however
// old it looks.

test('a completed download is never expired by age, however old — the sweep only reconciles', async () => {
  const id = crypto.randomUUID();
  const dir = makeFinishedDir(id);
  const store = createMemoryStore();
  await seedCompletedRow(store, id, { ageMs: 100 * ONE_HOUR_MS });

  await runCleanup(store);

  assert.equal(fs.existsSync(dir), true);
  const row = await store.findForUser(id, USER);
  assert.equal(row.expired, false);
  assert.equal(row.status, 'complete');
});

test('an old, empty directory is left alone too — nothing on disk is aged out', async () => {
  // Every path that abandons a download (failure, cancel) removes its whole
  // directory already, so an empty one is not evidence of anything the sweep
  // should act on — and acting on it by age is exactly what was removed.
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  // No code path reads mtime any more (getDownloadDir stopped stat-ing), so
  // backdating is deliberately inert here — it's the bait a reintroduced age
  // sweep would take, which is the regression this guards.
  const when = new Date(Date.now() - 100 * ONE_HOUR_MS);
  fs.utimesSync(dir, when, when);

  await runCleanup(createMemoryStore());

  assert.equal(fs.existsSync(dir), true);
});

test('runCleanup() with no store at all does not throw and touches no media', async () => {
  // The defensive no-store path runCleanup() supports (startCleanupScheduler
  // called without one, as in some unit tests). Every reconcile step is a
  // table operation, so there is nothing left for it to do but prune jobs.
  const id = crypto.randomUUID();
  const dir = makeFinishedDir(id);

  const result = await runCleanup();

  assert.equal(fs.existsSync(dir), true);
  assert.equal(result.expiredRows, 0);
  assert.deepEqual(result.failedIds, []);
});

// --- expireMissing ----------------------------------------------------------
// With no age sweep, this only catches media that went away by some route
// outside the app — a manual rm, a lost volume, a half-finished delete.

test('a completed row whose media vanished from disk is marked expired', async () => {
  const id = crypto.randomUUID();
  const store = createMemoryStore();
  // No directory at all: seeded as complete, then the files went away.
  await seedCompletedRow(store, id, { ageMs: 2 * ONE_HOUR_MS });

  await runCleanup(store);

  assert.equal((await store.findForUser(id, USER)).expired, true);
});

test('a just-completed row is inside the grace window and is not expired', async () => {
  // A download that finishes *while* the sweep runs is missing from the
  // directory snapshot it compares against, so without the grace window it
  // would be expired the moment it landed.
  const id = crypto.randomUUID();
  const store = createMemoryStore();
  await seedCompletedRow(store, id); // completed just now, no directory

  await runCleanup(store);

  assert.equal((await store.findForUser(id, USER)).expired, false);
});

// --- the stranded-download reconcile (0XC-120) ------------------------------
// A `downloading` row whose completion hook's DB write was lost must be
// corrected to `complete` from the real on-disk file, never retired as
// `failed`. Post-0XC-109 there's no metadata.json to consult: "finished" is
// detected from the directory itself (media present, no yt-dlp partials, job
// not running in this process), and the result file is the largest one — the
// same rule the download flow's describeDownloadedFile uses.

test('reconciles a stranded downloading row to complete when its media already finished', async () => {
  const id = crypto.randomUUID();
  makeFinishedDir(id, { filename: 'video.mp4', contents: 'x'.repeat(4242) });

  const store = createMemoryStore();
  await store.insert({
    downloadId: id,
    userId: USER,
    url: 'https://example.com/watch?v=x',
    filesize: 100,
  });
  // Simulate the completion hook's DB write having been lost: the row is
  // still `downloading` even though the file above already fully landed.

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'complete');
  assert.equal(row.filename, 'video.mp4');
  // Read from the real file, not the row's stale client-estimated `filesize: 100`.
  assert.equal(row.size, 4242);
});

test('a stranded downloading row with no finished media is still retired as failed', async () => {
  const id = crypto.randomUUID();
  // No directory at all — a restart stranded the row before anything landed.
  const store = createMemoryStore();
  await store.insert({ downloadId: id, userId: USER, filesize: 100 });
  store._rows.get(id).created_at = new Date(Date.now() - 7 * ONE_HOUR_MS); // past the 6h window

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'failed');
});

test('a stranded downloading row whose directory holds only a partial file is not reconciled to complete', async () => {
  // A job killed mid-flight leaves a yt-dlp `.part` artifact. That is NOT
  // evidence of success — the row must be left to failStale, exactly as if no
  // media had landed (0XC-120's partial-media edge case).
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4.part'), 'x'.repeat(50));

  const store = createMemoryStore();
  await store.insert({ downloadId: id, userId: USER, filesize: 100 });
  store._rows.get(id).created_at = new Date(Date.now() - 7 * ONE_HOUR_MS); // past the 6h window

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'failed');
});

test('failStale also removes the partial files the crashed job left behind', async () => {
  // Nothing else ever reaches those bytes: a failed row renders as a dismissable
  // card with no media, and it is excluded from the quota — so with no age
  // sweep left to reclaim it, a killed download would leak disk permanently.
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4.part'), 'x'.repeat(5000));

  const store = createMemoryStore();
  await store.insert({ downloadId: id, userId: USER, filesize: 100 });
  store._rows.get(id).created_at = new Date(Date.now() - 7 * ONE_HOUR_MS);

  const result = await runCleanup(store);

  assert.deepEqual(result.failedIds, [id]);
  assert.equal(fs.existsSync(dir), false);
});

test('a recent downloading row is untouched by either step', async () => {
  const id = crypto.randomUUID();
  const store = createMemoryStore();
  await store.insert({ downloadId: id, userId: USER, filesize: 100 });
  // created_at defaults to "now" — well inside both the reconcile and
  // failStale windows.

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'downloading');
});

test('a lost completion write is healed before failStale can retire it as failed', async () => {
  // The exact scenario 0XC-120 describes: the job finished (the file is on
  // disk), but the completion hook's DB write failed, so the row is stuck
  // `downloading` — and old enough that failStale would otherwise claim it in
  // the very same sweep, deleting the finished media along with it. The
  // reconcile step must win that race.
  const id = crypto.randomUUID();
  const dir = makeFinishedDir(id, { filename: 'audio.m4a', contents: 'y'.repeat(999) });

  const store = createMemoryStore();
  await store.insert({
    downloadId: id,
    userId: USER,
    url: 'https://example.com/watch?v=y',
    filesize: 1,
  });
  store._rows.get(id).created_at = new Date(Date.now() - 7 * ONE_HOUR_MS); // past failStale's window

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'complete');
  assert.equal(row.size, 999);
  assert.equal(fs.existsSync(dir), true);
});

test('a failing stranded-reconcile fails CLOSED — no failStale that sweep', async () => {
  // With no trustworthy answer to "did this row actually finish?", recording it
  // as failed and deleting the media that would have proved otherwise could
  // both be wrong, and an hour's wait for the next sweep costs nothing.
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x');
  let failStaleCalls = 0;
  const brokenStore = {
    async downloadingIds() {
      throw new Error('db unavailable');
    },
    async expireMissing() {
      return 0;
    },
    // Counted rather than thrown from: runCleanup catches everything in this
    // block, so a throw here would be swallowed and the assertion vacuous.
    async failStale() {
      failStaleCalls++;
      return [];
    },
  };

  const result = await runCleanup(brokenStore);

  assert.equal(failStaleCalls, 0);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(result.errors.length, 0);
});
