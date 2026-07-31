const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Isolate this file's sweeps in a private DOWNLOADS_DIR (0XC-127): the
// fresh-scan `cleanupOldDownloads(1)` calls below would otherwise delete
// other, concurrently-running test files' aged fixtures in the shared real
// downloads root. Must be set BEFORE ./storage is required, since it resolves
// the directory once at load time.
process.env.DOWNLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tubekeep-sweep-test-'));

const {
  cleanupOldDownloads,
  downloadsDir,
  ensureDownloadDir,
  listDownloadDirs,
} = require('./storage');

// Directories this test created, removed even if an assertion throws so a
// failed run never leaves debris in the real downloads root.
const created = [];

function makeDir({ ageMs = 0, empty = false } = {}) {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  if (!empty) fs.writeFileSync(path.join(dir, 'video.mp4'), 'x');
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
  }
  return { id, dir };
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  fs.rmSync(process.env.DOWNLOADS_DIR, { recursive: true, force: true });
});

const ONE_HOUR_MS = 60 * 60 * 1000;

test('expires (removes the whole directory of) an old download by mtime', () => {
  const old = makeDir({ ageMs: 2 * ONE_HOUR_MS });

  const result = cleanupOldDownloads(1);

  assert.ok(result.expiredIds.includes(old.id));
  assert.equal(fs.existsSync(old.dir), false);
});

test('leaves a recent download alone', () => {
  const fresh = makeDir();

  const result = cleanupOldDownloads(1);

  assert.equal(result.expiredIds.includes(fresh.id), false);
  assert.equal(fs.existsSync(fresh.dir), true);
});

test('never touches a download whose id is in skipIds, however old (kept / actively running)', () => {
  const kept = makeDir({ ageMs: 2 * ONE_HOUR_MS });

  const result = cleanupOldDownloads(1, { skipIds: new Set([kept.id]) });

  assert.equal(result.expiredIds.includes(kept.id), false);
  assert.equal(fs.existsSync(kept.dir), true);
});

test('an old, empty directory is reclaimed too — this is the replacement for the old orphan-dir sweep', () => {
  // A directory `ensureDownloadDir` created for a download that died before
  // any bytes landed looks exactly like this: present, empty, aging. Nothing
  // else in the codebase removes it, so this sweep must.
  const emptyOld = makeDir({ ageMs: 2 * ONE_HOUR_MS, empty: true });

  const result = cleanupOldDownloads(1);

  assert.ok(result.expiredIds.includes(emptyOld.id));
  assert.equal(fs.existsSync(emptyOld.dir), false);
});

test('a fresh empty directory is left alone — it may be a download that just started', () => {
  const emptyFresh = makeDir({ empty: true });

  const result = cleanupOldDownloads(1);

  assert.equal(result.expiredIds.includes(emptyFresh.id), false);
  assert.equal(fs.existsSync(emptyFresh.dir), true);
});

test('a stray metadata.json left over from before the deploy is treated like any other file — ignored, removed with the directory', () => {
  const old = makeDir();
  fs.writeFileSync(path.join(old.dir, 'metadata.json'), JSON.stringify({ downloadId: old.id }));
  // Writing metadata.json above bumps the directory's mtime, so age it down
  // afterward — matching what actually happens (the write predates the sweep).
  const when = new Date(Date.now() - 2 * ONE_HOUR_MS);
  fs.utimesSync(old.dir, when, when);

  const result = cleanupOldDownloads(1);

  assert.ok(result.expiredIds.includes(old.id));
  assert.equal(fs.existsSync(old.dir), false);
});

test('listDownloadDirs ignores non-UUID directory names', () => {
  const stray = path.join(downloadsDir, 'not-a-download-id');
  fs.mkdirSync(stray, { recursive: true });
  created.push(stray);

  const dirs = listDownloadDirs();

  assert.equal(
    dirs.some((d) => d.downloadId === 'not-a-download-id'),
    false,
  );
});
