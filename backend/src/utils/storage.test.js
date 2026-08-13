const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Isolate this file's fixtures in a private DOWNLOADS_DIR (0XC-127): test files
// run in parallel processes, and the stray-directory fixture below would
// otherwise be created in — and briefly visible to — the shared real downloads
// root that other files sweep. Must be set BEFORE ./storage is required, since
// storage.js resolves the directory once at load time.
process.env.DOWNLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tubekeep-storage-test-'));

const {
  hasQuotaFor,
  remainingQuota,
  isUnlimitedQuota,
  UNLIMITED_QUOTA,
  downloadsDir,
  getDownloadFileSize,
  listDownloadDirs,
  ensureDownloadDir,
} = require('./storage');

const GB = 1024 ** 3;

test('a download fits while used + size stays within the quota', () => {
  assert.equal(hasQuotaFor(4 * GB, 5 * GB, 1 * GB), true); // exactly at the cap
  assert.equal(hasQuotaFor(4 * GB, 5 * GB, 1 * GB + 1), false); // one byte over
  assert.equal(hasQuotaFor(0, 5 * GB, 6 * GB), false);
});

test('an unlimited quota (-1) never blocks', () => {
  assert.equal(isUnlimitedQuota(UNLIMITED_QUOTA), true);
  assert.equal(hasQuotaFor(500 * GB, UNLIMITED_QUOTA, 100 * GB), true);
  assert.equal(remainingQuota(500 * GB, UNLIMITED_QUOTA), UNLIMITED_QUOTA);
});

test('unknown or zero filesize is never blocked (mirrors the disk guard)', () => {
  assert.equal(hasQuotaFor(5 * GB, 5 * GB, 0), true);
  assert.equal(hasQuotaFor(5 * GB, 5 * GB, null), true);
  assert.equal(hasQuotaFor(5 * GB, 5 * GB, undefined), true);
});

test('remaining quota never goes negative', () => {
  assert.equal(remainingQuota(2 * GB, 5 * GB), 3 * GB);
  assert.equal(remainingQuota(9 * GB, 5 * GB), 0);
});

// --- getDownloadFileSize ------------------------------------------------

// Directories this suite created, removed even if an assertion throws — same
// pattern as orphanDirs.test.js, so a failed run never leaves debris in the
// real downloads root.
const created = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  fs.rmSync(process.env.DOWNLOADS_DIR, { recursive: true, force: true });
});

test('getDownloadFileSize returns the real on-disk byte size', () => {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'.repeat(777));

  assert.equal(getDownloadFileSize(id, 'video.mp4'), 777);
});

test('getDownloadFileSize returns null when metadata names a file that is not actually there', () => {
  // The directory (and other files) can exist while the one declared filename
  // is missing — e.g. a partial download, or the file was removed by hand.
  // This must not throw and must not be confused with "no directory at all".
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'metadata.json'), '{}');

  assert.equal(getDownloadFileSize(id, 'video.mp4'), null);
});

test('getDownloadFileSize returns null for an invalid downloadId', () => {
  assert.equal(getDownloadFileSize('../../etc', 'passwd'), null);
  assert.equal(getDownloadFileSize('not-a-uuid', 'video.mp4'), null);
});

test('getDownloadFileSize rejects a traversal-unsafe filename', () => {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'.repeat(10));

  assert.equal(getDownloadFileSize(id, '../video.mp4'), null);
  assert.equal(getDownloadFileSize(id, '..%2Fvideo.mp4'), null);
});

// --- listDownloadDirs ---------------------------------------------------

test('listDownloadDirs ignores non-UUID directory names', () => {
  // The cleanup reconcile feeds these ids to a ::uuid[] parameter, so a stray
  // directory name that reached it would abort the whole sweep with a cast
  // error.
  const stray = path.join(downloadsDir, 'not-a-download-id');
  fs.mkdirSync(stray, { recursive: true });
  created.push(stray);

  const dirs = listDownloadDirs();

  assert.equal(
    dirs.some((d) => d.downloadId === 'not-a-download-id'),
    false,
  );
});
