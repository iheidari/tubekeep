const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

// downloadManager.js requires ./ytdlp for the actual (network-spawning)
// download work. Stub it out via require.cache BEFORE downloadManager is
// first required, so its `const { downloadVideo, downloadAudio } =
// require('./ytdlp')` picks up these fakes instead of shelling out to
// yt-dlp. node:test runs each test file in its own process, so this only
// affects this file.
const ytdlpPath = require.resolve('./ytdlp');
require.cache[ytdlpPath] = {
  id: ytdlpPath,
  filename: ytdlpPath,
  loaded: true,
  exports: {
    downloadVideo: async () => ({ filename: 'stub.mp4', size: 4242 }),
    downloadAudio: async () => ({ filename: 'stub.m4a', size: 4242 }),
    getVideoInfo: async () => ({}),
    isSupportedUrl: () => true,
    runYtDlp: async () => {},
  },
};

const { ensureDownloadDir } = require('../utils/storage');
const { startJob, subscribe } = require('./downloadManager');

const created = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a completion hook that throws does not stop the job from reporting success', async () => {
  // This is the existing, deliberate guarantee 0XC-120 builds on: a DB blip in
  // the completion hook must never turn a finished download into a failed
  // one from the client's point of view. Left unchanged here — the ticket
  // only adds a sweep-side reconcile for what the hook's write left behind.
  const downloadId = crypto.randomUUID();
  created.push(ensureDownloadDir(downloadId));

  let hookCalls = 0;
  const job = startJob(
    {
      downloadId,
      url: 'https://example.com/watch?v=x',
      formatId: 'best',
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

  const result = await new Promise((resolve, reject) => {
    const unsubscribe = subscribe(job.downloadId, {
      onProgress: () => {},
      onComplete: (r) => {
        unsubscribe();
        resolve(r);
      },
      onError: (err) => {
        unsubscribe();
        reject(new Error(`unexpected error event: ${err}`));
      },
    });
  });

  assert.equal(hookCalls, 1);
  assert.equal(result.filename, 'stub.mp4');
  assert.equal(result.size, 4242);
});

test('the download directory really did receive metadata.json before the hook ran', async () => {
  // Sanity-checks the stub setup itself: downloadManager writes metadata.json
  // synchronously before invoking the hook (see cleanup.js's reconcile, which
  // depends on that ordering).
  const downloadId = crypto.randomUUID();
  const dir = ensureDownloadDir(downloadId);
  created.push(dir);

  const job = startJob(
    {
      downloadId,
      url: 'https://example.com/watch?v=y',
      formatId: 'best',
      type: 'audio',
      title: 'An audio track',
      thumbnail: null,
      keep: false,
    },
    { onComplete: () => {}, onError: () => {} },
  );

  await new Promise((resolve, reject) => {
    const unsubscribe = subscribe(job.downloadId, {
      onProgress: () => {},
      onComplete: () => {
        unsubscribe();
        resolve();
      },
      onError: (err) => {
        unsubscribe();
        reject(new Error(String(err)));
      },
    });
  });

  assert.equal(fs.existsSync(`${dir}/metadata.json`), true);
  const metadata = JSON.parse(fs.readFileSync(`${dir}/metadata.json`, 'utf8'));
  assert.equal(metadata.filename, 'stub.m4a');
});
