const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Isolate this file's sweeps in a private DOWNLOADS_DIR (0XC-127): test files
// run in parallel processes, and the age sweeps exercised here would otherwise
// race other files' fixtures in the shared real downloads root (and vice
// versa). Must be set BEFORE ./cleanup (→ ../utils/storage) is required, since
// storage.js resolves the directory once at load time. The spawned CLI
// subprocess below inherits this env too, so it sweeps the same sandbox.
process.env.DOWNLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tubekeep-cleanup-test-'));

const { runCleanup } = require('./cleanup');
const { createMemoryStore } = require('./downloadsStore');
const { ensureDownloadDir } = require('../utils/storage');

const ONE_HOUR_MS = 60 * 60 * 1000;
const USER = '11111111-1111-1111-1111-111111111111';

// Directories this file creates, removed even if an assertion throws so a
// failed run never leaves debris in the real downloads root (same pattern as
// utils/cleanupOldDownloads.test.js, which this exercises the caller of).
const created = [];

function makeOldDir() {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x');
  const when = new Date(Date.now() - 2 * ONE_HOUR_MS);
  fs.utimesSync(dir, when, when);
  return { id, dir };
}

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
// leaves both behind.
async function seedCompletedRow(store, id, { kept = false } = {}) {
  await store.insert({ downloadId: id, userId: USER, url: `https://x/${id}`, filesize: 1 });
  await store.markComplete(id, { filename: 'video.mp4', filesize: 1 });
  if (kept) await store.setKeptForUser(id, USER, true);
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  fs.rmSync(process.env.DOWNLOADS_DIR, { recursive: true, force: true });
});

test('a `kept` download is never expired on disk, however old — the skip-set carries the store’s kept flag', async () => {
  const { id, dir } = makeOldDir();
  const store = createMemoryStore();
  await seedCompletedRow(store, id, { kept: true });

  const result = await runCleanup(store);

  assert.equal(result.expiredIds.includes(id), false);
  assert.equal(fs.existsSync(dir), true);
  // The row itself is untouched — nothing reconciled it away either.
  assert.equal((await store.findForUser(id, USER)).expired, false);
});

test('an old, non-kept download is expired on disk', async () => {
  const { id, dir } = makeOldDir();
  const store = createMemoryStore();
  await seedCompletedRow(store, id, { kept: false });

  const result = await runCleanup(store);

  assert.ok(result.expiredIds.includes(id));
  assert.equal(fs.existsSync(dir), false);
});

test('a `kept` row belonging to a different user still protects the directory — keptIds spans all users', async () => {
  const { id, dir } = makeOldDir();
  const store = createMemoryStore();
  await store.insert({ downloadId: id, userId: 'other-user', url: 'https://x', filesize: 1 });
  await store.markComplete(id, { filename: 'video.mp4', filesize: 1 });
  await store.setKeptForUser(id, 'other-user', true);

  const result = await runCleanup(store);

  assert.equal(result.expiredIds.includes(id), false);
  assert.equal(fs.existsSync(dir), true);
});

test('a store.keptIds() failure fails CLOSED — nothing is age-expired this sweep, not even the non-kept', async () => {
  const { id, dir } = makeOldDir();
  const brokenStore = {
    async keptIds() {
      throw new Error('db unavailable');
    },
  };

  const result = await runCleanup(brokenStore);

  // Deleting a `kept` download's media is irreversible; without a reliable
  // kept list there's no way to tell which directories are safe to age out,
  // so none of them are touched this pass — not just the ones that might be
  // kept. The next successful sweep (an hour later) catches up.
  assert.equal(result.expiredIds.includes(id), false);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(result.errors.length, 0);
});

test('runCleanup() called with no store at all still expires by directory age — only a *failing* store fails closed, not a missing one', async () => {
  // This is NOT the standalone `npm run cleanup` CLI (that entry point calls
  // cleanupOldDownloads directly — see the CLI tests below); it's the
  // defensive no-store path runCleanup() itself supports (startCleanupScheduler
  // called without a store, as in some unit tests). Since keptIds() is never
  // attempted here, canExpireByAge stays true — this is a different case from
  // the fail-closed one above, where a store IS present but its query throws.
  const { id, dir } = makeOldDir();

  const result = await runCleanup(); // no store argument — must not throw

  assert.ok(result.expiredIds.includes(id));
  assert.equal(fs.existsSync(dir), false);
});

// --- the standalone `npm run cleanup` CLI (a real, separate process) -------
// A one-shot `node src/services/cleanup.js` invocation has neither a store
// (no `keptIds()`) nor a job registry (no `runningDownloadIds()` — that only
// knows about jobs in *its own* process). With neither guard, it must use a
// wider age threshold than the server sweep's 1h, or a live download running
// in some OTHER process (the actual server) could have its directory deleted
// out from under it for looking merely mtime-quiet within the first hour.

test('the standalone CLI does not touch a 2h-old directory — inside the server sweep window but not its own', () => {
  const { dir } = makeOldDir(); // 2h old, per makeOldDir's fixed age

  execFileSync('node', ['src/services/cleanup.js'], { cwd: path.join(__dirname, '../..') });

  assert.equal(fs.existsSync(dir), true);
});

test('the standalone CLI still reclaims a directory old enough to be unambiguous debris (7h)', () => {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x');
  const when = new Date(Date.now() - 7 * ONE_HOUR_MS);
  fs.utimesSync(dir, when, when);

  execFileSync('node', ['src/services/cleanup.js'], { cwd: path.join(__dirname, '../..') });

  assert.equal(fs.existsSync(dir), false);
});

test('a fresh download — kept or not — is left alone', async () => {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x');
  const store = createMemoryStore();
  await seedCompletedRow(store, id, { kept: false });

  const result = await runCleanup(store);

  assert.equal(result.expiredIds.includes(id), false);
  assert.equal(fs.existsSync(dir), true);
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
  store._rows.get(id).created_at = new Date(Date.now() - 7 * 60 * 60 * 1000); // past the 6h window

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
  store._rows.get(id).created_at = new Date(Date.now() - 7 * 60 * 60 * 1000); // past the 6h window

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'failed');
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
  // the very same sweep. The reconcile step must win that race.
  const id = crypto.randomUUID();
  makeFinishedDir(id, { filename: 'audio.m4a', contents: 'y'.repeat(999) });

  const store = createMemoryStore();
  await store.insert({
    downloadId: id,
    userId: USER,
    url: 'https://example.com/watch?v=y',
    filesize: 1,
  });
  store._rows.get(id).created_at = new Date(Date.now() - 7 * 60 * 60 * 1000); // also past failStale's window

  await runCleanup(store);

  const row = await store.findForUser(id, USER);
  assert.equal(row.status, 'complete');
  assert.equal(row.size, 999);
});
