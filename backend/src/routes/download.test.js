const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createDownloadRouter } = require('./download');
const { createMemoryStore } = require('../services/downloadsStore');
const { DownloadCapError } = require('../services/downloadManager');

const GB = 1024 ** 3;
// Requests that are expected to PASS the guards use MB-scale sizes: the global
// free-disk backstop runs for real here, and it wants 2× the size plus headroom.
const MB = 1024 ** 2;
const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '33333333-3333-3333-3333-333333333333';

let server;
let base;
let store;
let user;
let started; // jobs the stubbed download manager was asked to start
let startImpl;

// Mount the router behind a stub session and a stub job starter, so the guards
// are exercised without Postgres, without a real login, and without ever
// spawning yt-dlp.
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/download',
    (req, _res, next) => {
      req.user = user;
      next();
    },
    createDownloadRouter({
      store: {
        // Delegate to whichever memory store the current test set up.
        insert: (...a) => store.insert(...a),
        usageForUser: (...a) => store.usageForUser(...a),
        deleteForUser: (...a) => store.deleteForUser(...a),
        markComplete: (...a) => store.markComplete(...a),
        markFailed: (...a) => store.markFailed(...a),
        supersedeForUser: (...a) => store.supersedeForUser(...a),
      },
      start: (params, hooks) => startImpl(params, hooks),
    }),
  );
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

beforeEach(() => {
  store = createMemoryStore();
  started = [];
  startImpl = (params, hooks) => {
    started.push({ params, hooks });
    return { downloadId: params.downloadId };
  };
  user = { user_id: USER, max_storage_bytes: 5 * GB };
});

function start(body) {
  return fetch(`${base}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://example.com/watch?v=abc',
      formatId: '137',
      type: 'video',
      title: 'A video',
      ...body,
    }),
  });
}

// Seed `bytes` of completed storage for `userId`.
async function seedUsage(userId, bytes) {
  await store.insert({ downloadId: 'seed', userId, filesize: bytes });
  await store.markComplete('seed', { filename: 'seed.mp4', filesize: bytes });
}

test('a download that would exceed the user’s quota is refused with 507', async () => {
  await seedUsage(USER, 4.5 * GB); // 0.5 GB left of a 5 GB quota

  const res = await start({ filesize: GB });
  const body = await res.json();

  assert.equal(res.status, 507);
  assert.equal(body.success, false);
  assert.match(body.error, /storage/i);
  // No job started, and nothing recorded for the refused download.
  assert.equal(started.length, 0);
  assert.equal((await store.listByUser(USER)).length, 1);
});

test('the quota check reads the requesting user’s own usage, not everyone’s', async () => {
  await seedUsage(OTHER, 4.9 * GB); // someone else is nearly full

  const res = await start({ filesize: 10 * MB });

  assert.equal(res.status, 200);
  assert.equal(started.length, 1);
});

test('an unlimited (-1) quota is never blocked by usage', async () => {
  user = { user_id: USER, max_storage_bytes: -1 };
  await seedUsage(USER, 500 * GB); // far past any finite quota

  const res = await start({ filesize: 10 * MB });

  assert.equal(res.status, 200);
  assert.equal(started.length, 1);
});

test('a started download is recorded under the user as `downloading`', async () => {
  const res = await start({ filesize: 10 * MB });
  const { downloadId } = (await res.json()).data;

  const row = await store.findForUser(downloadId, USER);
  assert.equal(row.status, 'downloading');
  assert.equal(row.title, 'A video');
  // The in-flight row already occupies the quota.
  assert.equal(await store.usageForUser(USER), 10 * MB);
});

test('the job’s terminal hooks write the outcome back to the row', async () => {
  const res = await start({ filesize: 10 * MB });
  const { downloadId } = (await res.json()).data;

  await started[0].hooks.onComplete({ filename: 'real.mp4', size: 21 * MB });
  const row = await store.findForUser(downloadId, USER);
  assert.equal(row.status, 'complete');
  assert.equal(row.filename, 'real.mp4');
  // The real on-disk size replaces the client's estimate for quota accounting.
  assert.equal(row.size, 21 * MB);
});

test('a failed start (over the concurrency cap) rolls its row back', async () => {
  startImpl = () => {
    throw new DownloadCapError(3);
  };

  const res = await start({ filesize: 10 * MB });

  assert.equal(res.status, 429);
  assert.equal((await store.listByUser(USER)).length, 0);
  assert.equal(await store.usageForUser(USER), 0);
});

// --- DELETE /api/download/:id (cancel) -------------------------------------
// The real download manager's cancelJob() runs here; it returns false for an id
// it has never seen, so no job (and no yt-dlp process) is ever involved.

const cancel = (downloadId) => fetch(`${base}/api/download/${downloadId}`, { method: 'DELETE' });

test('cancelling drops the caller’s in-flight row so it stops occupying the quota', async () => {
  const res = await start({ filesize: 10 * MB });
  const { downloadId } = (await res.json()).data;

  const cancelled = await cancel(downloadId);

  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).success, true);
  assert.equal(await store.findForUser(downloadId, USER), null);
  assert.equal(await store.usageForUser(USER), 0);
});

test('cancelling another user’s download is 404 and leaves their row running', async () => {
  const res = await start({ filesize: 10 * MB });
  const { downloadId } = (await res.json()).data;

  // Same id, different session.
  user = { user_id: OTHER, max_storage_bytes: 5 * GB };
  const cancelled = await cancel(downloadId);

  assert.equal(cancelled.status, 404);
  assert.equal((await cancelled.json()).success, false);
  assert.equal((await store.findForUser(downloadId, USER)).status, 'downloading');
});

test('cancelling an unknown download id is 404', async () => {
  const res = await cancel('44444444-4444-4444-4444-444444444444');

  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Download not found');
});

// --- 0XC-10: a completed download supersedes older rows for the same URL -----
// The regression these cover: the dedupe used to live in the browser and only
// ran if a tab happened to witness the SSE `complete` event. Downloads finish
// server-side whether or not anyone is watching, so these drive the job's
// completion hook directly — no client, no SSE.

const SRC = 'https://example.com/watch?v=abc';

// Seed a completed download for `userId` at `url`, bypassing the route.
async function seedAt(id, userId, url, patch = {}) {
  await store.insert({ downloadId: id, userId, url, type: 'video', filesize: 100 });
  await store.markComplete(id, { filename: `${id}.mp4`, filesize: 100 });
  Object.assign(store._rows.get(id), patch);
}

// Run the started job's completion hook, as the download manager does.
function finish(job, filename = 'fresh.mp4') {
  return job.hooks.onComplete({ filename, size: 4242 });
}

test('completing a download removes the user’s older row for the same URL', async () => {
  await seedAt('old', USER, SRC, { expired: true });

  const res = await start({ url: SRC, filesize: 10 * MB });
  assert.equal(res.status, 200);
  await finish(started[0]);

  const ids = (await store.listByUser(USER)).map((r) => r.downloadId);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], 'old');
});

test('a moved-to-cloud row survives a re-download of the same URL', async () => {
  await seedAt('cloud', USER, SRC, { moved: true, moved_info: { provider: 'dropbox' } });

  await start({ url: SRC, filesize: 10 * MB });
  await finish(started[0]);

  assert.ok(await store.findForUser('cloud', USER));
  assert.equal((await store.listByUser(USER)).length, 2);
});

test('an abandoned re-download leaves the old row alone until it completes', async () => {
  await seedAt('old', USER, SRC, { expired: true });

  await start({ url: SRC, filesize: 10 * MB });
  // Job never completes (user navigated away, then it failed).
  await started[0].hooks.onError(new Error('boom'));

  assert.ok(await store.findForUser('old', USER));
});

test('superseding frees the old row’s quota', async () => {
  await seedAt('old', USER, SRC);
  assert.equal(await store.usageForUser(USER), 100);

  await start({ url: SRC, filesize: 10 * MB });
  await finish(started[0]);

  // Only the fresh download's real on-disk size remains.
  assert.equal(await store.usageForUser(USER), 4242);
});

// --- 0XC-117: supersede by canonical video identity, not just the raw URL ---

test('a completed re-download with a matching sourceKey supersedes an old row pasted as a different URL form', async () => {
  await seedAt('old', USER, SRC, { source_key: 'youtube:abc' });

  const res = await start({
    url: 'https://youtu.be/abc?si=xyz',
    filesize: 10 * MB,
    sourceKey: 'youtube:abc',
  });
  assert.equal(res.status, 200);
  await finish(started[0]);

  const ids = (await store.listByUser(USER)).map((r) => r.downloadId);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], 'old');
});

test('an invalid sourceKey is dropped rather than rejecting the download', async () => {
  const res = await start({ url: SRC, filesize: 10 * MB, sourceKey: 'x'.repeat(500) });
  assert.equal(res.status, 200);

  const { downloadId } = (await res.json()).data;
  assert.equal((await store.findForUser(downloadId, USER)).sourceKey, null);
});

// isValidSourceKey isn't exported — it's exercised the same way as the rest of
// this route, through the public contract: POST, then read back what actually
// landed on the row. Each case below is a distinct reason `isValidSourceKey`
// can reject a value, so a regression in any one of its checks shows up here.

async function sourceKeyAfter(sourceKey) {
  const res = await start({ url: SRC, filesize: 10 * MB, sourceKey });
  assert.equal(res.status, 200, 'a rejected sourceKey must still let the download start');
  const { downloadId } = (await res.json()).data;
  return (await store.findForUser(downloadId, USER)).sourceKey;
}

test('an empty-string sourceKey is dropped', async () => {
  assert.equal(await sourceKeyAfter(''), null);
});

test('a non-string sourceKey is dropped', async () => {
  assert.equal(await sourceKeyAfter(12345), null);
});

test('a sourceKey containing a newline is dropped', async () => {
  assert.equal(await sourceKeyAfter('youtube:abc\nX-Injected: true'), null);
  assert.equal(await sourceKeyAfter('youtube:abc\r\nX-Injected: true'), null);
});

// Postgres `text` rejects an embedded NUL outright — without this check the
// value would clear isValidSourceKey only to fail later at store.insert's
// query, turning into a 500 that rejects the whole download instead of just
// falling back to url-based matching as documented.
test('a sourceKey containing a NUL byte is dropped', async () => {
  assert.equal(await sourceKeyAfter(`youtube:abc${String.fromCharCode(0)}`), null);
});

test('a sourceKey containing a tab or other control character is dropped', async () => {
  assert.equal(await sourceKeyAfter('youtube:abc\tdef'), null);
});

test('a sourceKey exactly at the length limit is kept', async () => {
  const key = `youtube:${'a'.repeat(192)}`; // 200 chars total
  assert.equal(key.length, 200);
  assert.equal(await sourceKeyAfter(key), key);
});

test('a sourceKey one character over the length limit is dropped', async () => {
  const key = `youtube:${'a'.repeat(193)}`; // 201 chars total
  assert.equal(key.length, 201);
  assert.equal(await sourceKeyAfter(key), null);
});
