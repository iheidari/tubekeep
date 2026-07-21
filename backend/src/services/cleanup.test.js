const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ensureDownloadDir, saveDownloadMetadata } = require('../utils/storage');
const { createMemoryStore } = require('./downloadsStore');
const { runCleanup } = require('./cleanup');

const USER = '11111111-1111-1111-1111-111111111111';

// Directories this test created, removed even if an assertion throws so a
// failed run never leaves debris in the real downloads root (same pattern as
// orphanDirs.test.js).
const created = [];

// A download whose job actually finished: a real directory with metadata.json
// and its declared media file already on disk — the exact shape
// downloadManager.js leaves behind right before its completion hook runs.
function makeFinishedDir(downloadId, { filename = 'video.mp4', contents = 'x'.repeat(10) } = {}) {
  const dir = ensureDownloadDir(downloadId);
  created.push(dir);
  fs.writeFileSync(path.join(dir, filename), contents);
  saveDownloadMetadata(downloadId, {
    url: 'https://example.com/watch?v=x',
    title: 'A video',
    filename,
    size: 1, // deliberately wrong/stale — the reconcile must read the real size off disk
    kept: false,
    createdAt: new Date().toISOString(),
    downloadId,
  });
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  // Read from the real file, not metadata's stale `size: 1`.
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
