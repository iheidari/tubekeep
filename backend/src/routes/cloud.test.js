const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { ensureDownloadDir, downloadsDir } = require('../utils/storage');
const { createMemoryStore } = require('../services/downloadsStore');

// routes/cloud.js resolves the provider registry through '../services/cloud'
// (services/cloud/index.js) — same module cloud/jobs.test.js stubs, same
// reason: isEnabled() reads OAuth env vars this suite doesn't have. Swap the
// module's cached exports for a fake BEFORE createCloudRouter is required, so
// both the router and the job manager it drives resolve to the same fake.
const indexPath = require.resolve('../services/cloud');

const fakeProvider = {
  name: 'fake',
  isEnabled: () => true,
  upload: async () => ({ name: 'video.mp4', path: '/video.mp4', link: 'https://cloud.example/v' }),
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

const { createCloudRouter } = require('./cloud');

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

let server;
let base;
let store;
const tempDirs = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/cloud',
    (req, _res, next) => {
      req.user = { user_id: USER };
      next();
    },
    createCloudRouter({
      store: {
        findForUser: (...a) => store.findForUser(...a),
        markMoved: (...a) => store.markMoved(...a),
      },
    }),
  );
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  delete require.cache[indexPath];
});

beforeEach(() => {
  store = createMemoryStore();
});

function onDisk(id) {
  const dir = path.join(downloadsDir, id);
  ensureDownloadDir(id);
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'.repeat(32));
  return dir;
}

// Seed a row for USER at the given status, with matching media on disk.
async function seed(status) {
  const downloadId = crypto.randomUUID();
  await store.insert({ downloadId, userId: USER, url: `https://example.com/${downloadId}` });
  if (status === 'complete') {
    await store.markComplete(downloadId, { filename: 'video.mp4', filesize: 32 });
  }
  onDisk(downloadId);
  return downloadId;
}

function upload(body) {
  return fetch(`${base}/api/cloud/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'fake', accessToken: 'tok', ...body }),
  });
}

test('POST /upload against a still-downloading id is refused — never uploads or touches the directory', async () => {
  const downloadId = await seed('downloading');
  const dir = path.join(downloadsDir, downloadId);

  const res = await upload({ downloadId });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.success, false);
  // Nothing was uploaded or deleted: the partial file and its directory
  // survive untouched, and the row was never flagged moved.
  assert.equal(fs.existsSync(dir), true);
  assert.equal((await store.findForUser(downloadId, USER)).moved, undefined);
});

test('POST /upload against a completed download succeeds and starts a job', async (t) => {
  // createJob schedules real 30-min/2-min TTL timers; mock them so this test
  // doesn't keep the process alive waiting them out (same fix cloud/jobs.test.js
  // uses for the same reason).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const downloadId = await seed('complete');

  const res = await upload({ downloadId });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.jobId);
});

test('POST /upload on another user’s download is 404 regardless of its status', async () => {
  const downloadId = crypto.randomUUID();
  await store.insert({ downloadId, userId: OTHER, url: 'https://example.com/x' });
  await store.markComplete(downloadId, { filename: 'video.mp4', filesize: 32 });
  onDisk(downloadId);

  const res = await upload({ downloadId });

  assert.equal(res.status, 404);
});

test('POST /upload with an unknown provider is refused before the ownership check', async () => {
  const downloadId = await seed('complete');

  const res = await upload({ downloadId, provider: 'not-a-real-provider' });

  assert.equal(res.status, 400);
});
