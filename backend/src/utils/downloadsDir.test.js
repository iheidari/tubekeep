const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// storage.js resolves DOWNLOADS_DIR once at require time, so honoring a custom
// value can only be observed in a fresh process — this repo's own require
// cache already has the default baked in from every other test file.
const BACKEND_ROOT = path.join(__dirname, '..', '..');

function resolvedDownloadsDir(env) {
  return execFileSync(
    process.execPath,
    ['-e', "console.log(require('./src/utils/storage').downloadsDir)"],
    {
      cwd: BACKEND_ROOT,
      env,
      encoding: 'utf8',
    },
  ).trim();
}

test('DOWNLOADS_DIR env var overrides the default downloads location', () => {
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'tubekeep-downloads-'));
  try {
    const resolved = resolvedDownloadsDir({ ...process.env, DOWNLOADS_DIR: custom });
    assert.equal(resolved, path.resolve(custom));
  } finally {
    fs.rmSync(custom, { recursive: true, force: true });
  }
});

test('DOWNLOADS_DIR defaults to backend/downloads when unset', () => {
  const env = { ...process.env };
  delete env.DOWNLOADS_DIR;
  const resolved = resolvedDownloadsDir(env);
  assert.equal(resolved, path.join(BACKEND_ROOT, 'downloads'));
});

test('a relative DOWNLOADS_DIR is resolved to an absolute path', () => {
  const resolved = resolvedDownloadsDir({ ...process.env, DOWNLOADS_DIR: '../.data/downloads' });
  assert.ok(path.isAbsolute(resolved));
  assert.equal(resolved, path.resolve(BACKEND_ROOT, '../.data/downloads'));
});
