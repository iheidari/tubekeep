const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// downloadManager.js imports downloadVideo/downloadAudio from './ytdlp' at the
// top of the file, which is real subprocess spawning we don't want anywhere
// near a unit test. Swap ytdlp's cached module exports for a stub BEFORE
// downloadManager is (re)required, so its own `require('./ytdlp')` resolves to
// ours — the same require.cache substitution used by cloud/jobs.test.js for
// the same reason. `pending` lets each test control exactly when a "download"
// settles (resolve/reject), so runningDownloadIds()/sweepJobs() can be
// exercised at precise moments without waiting on anything real.
const ytdlpPath = require.resolve('./ytdlp');
const managerPath = require.resolve('./downloadManager');

let pending; // downloadId -> { resolve, reject }

function fakeDownload(_url, _formatId, downloadId, _onProgress, mergeOrSignal, maybeSignal) {
  // downloadVideo(url, formatId, downloadId, onProgress, mergeAudio, signal)
  // downloadAudio(url, formatId, downloadId, onProgress, signal)
  const signal = maybeSignal || mergeOrSignal;
  return new Promise((resolve, reject) => {
    // `signal` is kept on the record so a test can assert cancelJob actually
    // aborted it, not just deleted the job from the registry.
    pending[downloadId] = { resolve, reject, signal };
    signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
}

require.cache[ytdlpPath] = {
  id: ytdlpPath,
  filename: ytdlpPath,
  loaded: true,
  exports: {
    downloadVideo: (...args) => fakeDownload(...args),
    downloadAudio: (...args) => fakeDownload(...args),
  },
};

// downloadManager keeps its job registry as module-level state, so get a fresh
// module (a clean `jobs` Map) for every test rather than leaking jobs — and
// concurrency-cap counts — from one test into the next.
function freshManager() {
  delete require.cache[managerPath];
  return require('./downloadManager');
}

let manager;
let origMaxConcurrent;

beforeEach(() => {
  pending = {};
  manager = freshManager();
  origMaxConcurrent = process.env.MAX_CONCURRENT_DOWNLOADS;
});

afterEach(() => {
  if (origMaxConcurrent === undefined) delete process.env.MAX_CONCURRENT_DOWNLOADS;
  else process.env.MAX_CONCURRENT_DOWNLOADS = origMaxConcurrent;
});

after(() => {
  delete require.cache[ytdlpPath];
  delete require.cache[managerPath];
});

function start(overrides = {}) {
  const downloadId = crypto.randomUUID();
  return manager.startJob({
    downloadId,
    url: 'https://example.com/watch?v=x',
    formatId: '137',
    type: 'video',
    title: 'A video',
    thumbnail: null,
    keep: false,
    ...overrides,
  });
}

const noopObservers = () => ({ onProgress() {}, onComplete() {}, onError() {} });

// Resolves once the job's terminal `event` ('complete' | 'error') fires.
function waitForTerminal(downloadId, event) {
  return new Promise((resolve) => {
    manager.subscribe(downloadId, {
      onProgress() {},
      onComplete(result) {
        if (event === 'complete') resolve(result);
      },
      onError(message) {
        if (event === 'error') resolve(message);
      },
    });
  });
}

// --- runningDownloadIds ------------------------------------------------------

test('runningDownloadIds is empty when nothing has ever been started', () => {
  assert.deepEqual(manager.runningDownloadIds(), []);
});

test('runningDownloadIds includes a job the moment it starts running', () => {
  const job = start();
  assert.deepEqual(manager.runningDownloadIds(), [job.downloadId]);
});

test('runningDownloadIds drops a job once it completes', async () => {
  const job = start();
  const done = waitForTerminal(job.downloadId, 'complete');

  pending[job.downloadId].resolve({ filename: 'a.mp4', size: 10 });
  await done;

  assert.deepEqual(manager.runningDownloadIds(), []);
});

test('runningDownloadIds drops a job once it errors', async () => {
  const job = start();
  const done = waitForTerminal(job.downloadId, 'error');

  pending[job.downloadId].reject(new Error('boom'));
  await done;

  assert.deepEqual(manager.runningDownloadIds(), []);
});

test('runningDownloadIds never reports an id nothing started', () => {
  assert.equal(manager.runningDownloadIds().includes(crypto.randomUUID()), false);
});

// --- cancelJob ----------------------------------------------------------------

test('cancelJob aborts a running job and removes it from the registry immediately', () => {
  const job = start();

  assert.equal(manager.cancelJob(job.downloadId), true);

  assert.equal(manager.runningDownloadIds().includes(job.downloadId), false);
  assert.equal(manager.subscribe(job.downloadId, noopObservers()), null);
});

test('cancelJob aborts the underlying signal — it does not just delete the record', () => {
  const job = start();
  assert.equal(pending[job.downloadId].signal.aborted, false);

  manager.cancelJob(job.downloadId);

  assert.equal(pending[job.downloadId].signal.aborted, true);
});

test('cancelJob on an unknown id returns false and touches nothing', () => {
  assert.equal(manager.cancelJob(crypto.randomUUID()), false);
});

test('cancelJob on an already-finished job still returns true and removes the record', async () => {
  const job = start();
  const done = waitForTerminal(job.downloadId, 'complete');
  pending[job.downloadId].resolve({ filename: 'a.mp4', size: 10 });
  await done;

  assert.equal(manager.cancelJob(job.downloadId), true);
  assert.equal(manager.subscribe(job.downloadId, noopObservers()), null);
});

// --- concurrency cap (startJob) ------------------------------------------------

test('startJob throws DownloadCapError once the concurrency cap is hit, without registering the rejected job', () => {
  process.env.MAX_CONCURRENT_DOWNLOADS = '2';
  const a = start();
  const b = start();
  assert.deepEqual(new Set(manager.runningDownloadIds()), new Set([a.downloadId, b.downloadId]));

  // Checked against `manager.DownloadCapError` (this test's freshly-required
  // module), not a top-level import — freshManager() re-executes the module
  // per test, so an import captured once at file load would be a stale class
  // and fail `instanceof` against an error thrown by the current instance.
  assert.throws(
    () => start(),
    (err) => err instanceof manager.DownloadCapError && err.code === 'CAP_EXCEEDED',
  );
  assert.equal(manager.runningDownloadIds().length, 2);
});

test('a finished job frees a slot under the cap', async () => {
  process.env.MAX_CONCURRENT_DOWNLOADS = '1';
  const a = start();
  const done = waitForTerminal(a.downloadId, 'complete');
  pending[a.downloadId].resolve({ filename: 'a.mp4', size: 10 });
  await done;

  // Would have thrown while `a` was still running.
  const b = start();
  assert.deepEqual(manager.runningDownloadIds(), [b.downloadId]);
});

// --- sweepJobs ------------------------------------------------------------------

test('sweepJobs leaves a terminal job alone until the retention window elapses, then prunes it', async () => {
  const job = start();
  const done = waitForTerminal(job.downloadId, 'complete');
  pending[job.downloadId].resolve({ filename: 'a.mp4', size: 10 });
  await done;

  const terminalAt = Date.now();
  assert.equal(manager.sweepJobs(terminalAt + 29 * 60 * 1000), 0);
  assert.notEqual(manager.subscribe(job.downloadId, noopObservers()), null);

  assert.equal(manager.sweepJobs(terminalAt + 31 * 60 * 1000), 1);
  assert.equal(manager.subscribe(job.downloadId, noopObservers()), null);
});

test('sweepJobs never prunes a still-running job, however far `now` is pushed', () => {
  const job = start();

  assert.equal(manager.sweepJobs(Date.now() + 365 * 24 * 60 * 60 * 1000), 0);
  assert.notEqual(manager.subscribe(job.downloadId, noopObservers()), null);
});

// --- terminal hooks -----------------------------------------------------------

test('a completion hook that throws does not stop the job from reporting success', async () => {
  // This is the existing, deliberate guarantee 0XC-120 builds on: a DB blip in
  // the completion hook must never turn a finished download into a failed one
  // from the client's point of view. The sweep-side reconcile in cleanup.js is
  // what later corrects the row this hook failed to write.
  let hookCalls = 0;
  const downloadId = crypto.randomUUID();
  const job = manager.startJob(
    {
      downloadId,
      url: 'https://example.com/watch?v=x',
      formatId: '137',
      type: 'video',
      title: 'A video',
      thumbnail: null,
      keep: false,
    },
    {
      onComplete: () => {
        hookCalls++;
        throw new Error('simulated DB write failure');
      },
      onError: () => {
        throw new Error('should not be called on a successful download');
      },
    },
  );
  const done = waitForTerminal(job.downloadId, 'complete');

  pending[job.downloadId].resolve({ filename: 'stub.mp4', size: 4242 });
  const result = await done;

  assert.equal(hookCalls, 1);
  assert.equal(result.filename, 'stub.mp4');
  assert.equal(result.size, 4242);
});
