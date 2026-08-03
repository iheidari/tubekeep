const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ensureDownloadDir } = require('../../utils/storage');

// jobs.js resolves its cloud provider through './index' (services/cloud/index.js),
// which in turn decides `isEnabled()` from OAuth env vars we don't have in tests.
// Rather than wiring real Dropbox/Google Drive credentials, stand in a fake
// provider the same way downloadManager's tests stand in a fake yt-dlp: swap the
// module's cached `exports` for a stub BEFORE jobs.js is (re)required, so its
// `require('./index')` resolves to ours. This is the cheapest way to exercise
// jobs.js's own logic (the getDownloadDir "no longer available" guard, and what
// it does with a successful upload) without touching a real provider or network.
const indexPath = require.resolve('./index');
const jobsPath = require.resolve('./jobs');

// Mutable so each test can swap in its own `upload` behavior without re-stubbing
// the module. `uploadImpl` defaults to a no-op — only used by the happy-path test.
let uploadImpl = async () => ({ name: 'x', path: '/x', link: 'https://cloud.example/x' });

const fakeProvider = {
  name: 'fake',
  isEnabled: () => true,
  upload: (...args) => uploadImpl(...args),
};

require.cache[indexPath] = {
  id: indexPath,
  filename: indexPath,
  loaded: true,
  exports: {
    getProvider: (name) => (name === 'fake' ? fakeProvider : null),
    listEnabledProviders: () => [{ name: 'fake' }],
  },
};

// jobs.js keeps its job registry in module-level state, so get a fresh module
// (and thus a clean registry, unaffected by a previous test's jobs) each time.
function freshJobs() {
  delete require.cache[jobsPath];
  return require('./jobs');
}

// Directories this test creates, removed even if an assertion throws.
const created = [];
function makeDownloadDir({ withFile = true } = {}) {
  const id = crypto.randomUUID();
  const dir = ensureDownloadDir(id);
  created.push(dir);
  if (withFile) fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'.repeat(32));
  return { id, dir };
}

// Wait for a job to reach a terminal snapshot (status complete|error), via the
// module's own subscribe — mirrors how the SSE route consumes it.
function waitForTerminal(jobs, jobId) {
  return new Promise((resolve) => {
    const unsubscribe = jobs.subscribe(jobId, (snapshot) => {
      if (jobs.isTerminal(snapshot.status)) {
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

// createJob schedules a hard-TTL (30 min) and, once the job settles, a 2-minute
// linger timer before it's dropped from the registry — real `setTimeout`s that
// `node --test` will otherwise wait out before the process can exit. Mock the
// timers for the run so those timers exist only in mock-time; nothing in the
// job's own logic (an fs.readdirSync/statSync check, then an awaited Promise
// from our fake `upload`) depends on real timers, so this doesn't change what's
// under test.
function withMockedTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

test('a downloadId with no directory on disk fails as "no longer available to move"', async (t) => {
  withMockedTimers(t);
  const jobs = freshJobs();
  const missingId = crypto.randomUUID();

  const snapshot = jobs.createJob({ downloadId: missingId, providerName: 'fake' });

  // The getDownloadDir check has no await before it, so the failure — like the
  // provider-missing check above it — lands synchronously within createJob().
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.error.code, 'notfound');
  assert.match(snapshot.error.message, /no longer available/i);
});

test('a downloadId whose directory exists but is empty fails the same way', async (t) => {
  withMockedTimers(t);
  const jobs = freshJobs();
  const { id } = makeDownloadDir({ withFile: false });

  const snapshot = jobs.createJob({ downloadId: id, providerName: 'fake' });

  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.error.code, 'notfound');
  assert.match(snapshot.error.message, /no longer available/i);
});

test('an unknown provider name fails before the directory is ever consulted', async (t) => {
  withMockedTimers(t);
  const jobs = freshJobs();
  const { id } = makeDownloadDir();

  const snapshot = jobs.createJob({ downloadId: id, providerName: 'not-a-real-provider' });

  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.error.code, 'provider');
});

test('a successful upload deletes the local directory and reports the move via the store', async (t) => {
  withMockedTimers(t);
  const jobs = freshJobs();
  const { id, dir } = makeDownloadDir();
  uploadImpl = async () => ({
    name: 'video.mp4',
    path: '/video.mp4',
    link: 'https://cloud.example/v',
  });

  const moved = [];
  const store = {
    async markMoved(downloadId, result) {
      moved.push({ downloadId, result });
    },
  };

  const started = jobs.createJob({ downloadId: id, providerName: 'fake', store });
  assert.equal(started.status, 'uploading');

  const final = await waitForTerminal(jobs, started.jobId);

  assert.equal(final.status, 'complete');
  assert.equal(final.result.provider, 'fake');
  // markMoved (utils/storage) deletes the whole directory now that the row —
  // not a metadata.json — is the lifecycle record.
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(moved, [{ downloadId: id, result: final.result }]);
});

test('a store.markMoved failure does not fail the already-succeeded upload', async (t) => {
  withMockedTimers(t);
  const jobs = freshJobs();
  const { id } = makeDownloadDir();
  uploadImpl = async () => ({
    name: 'video.mp4',
    path: '/video.mp4',
    link: 'https://cloud.example/v',
  });
  const store = {
    async markMoved() {
      throw new Error('db blip');
    },
  };

  const started = jobs.createJob({ downloadId: id, providerName: 'fake', store });
  const final = await waitForTerminal(jobs, started.jobId);

  assert.equal(final.status, 'complete');
});

after(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Leave module resolution as we found it for any test file that runs after
  // this one in the same process.
  delete require.cache[indexPath];
  delete require.cache[jobsPath];
});
