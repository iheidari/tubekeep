const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

// The auth middleware runs for real against an in-memory auth store, so the
// session cookie below travels the same path it does in production — no
// Postgres. JWT_SECRET must be set before authService is required.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const { createFilesRouter } = require('./files');
const { createRequireAuth } = require('../middleware/requireAuth');
const { createMemoryStore } = require('../services/authStore');
const { createMemoryStore: createDownloadsMemoryStore } = require('../services/downloadsStore');
const { signSession, SESSION_COOKIE } = require('../services/authService');
const { downloadsDir } = require('../utils/storage');

const ME = { id: '11111111-1111-1111-1111-111111111111', email: 'me@example.com' };
const THEM = { id: '22222222-2222-2222-2222-222222222222', email: 'them@example.com' };

let server;
let base;
let store; // swapped per test; the router holds a delegating facade
const tempDirs = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const requireAuth = createRequireAuth(createMemoryStore({ users: [ME, THEM] }));
  app.use(
    '/api/files',
    createFilesRouter(requireAuth, {
      store: {
        listByUser: (...a) => store.listByUser(...a),
        setKeptForUser: (...a) => store.setKeptForUser(...a),
        expireForUser: (...a) => store.expireForUser(...a),
        deleteForUser: (...a) => store.deleteForUser(...a),
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
});

beforeEach(() => {
  store = createDownloadsMemoryStore();
});

function cookieFor(user) {
  return `${SESSION_COOKIE}=${signSession(user)}`;
}

function as(user, url, init = {}) {
  return fetch(`${base}${url}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: cookieFor(user) },
  });
}

// A real on-disk download: just the media file, exactly what the
// expire/delete helpers in utils/storage operate on. Registered for teardown
// so the suite leaves the downloads directory as it found it.
function onDisk(id) {
  const dir = path.join(downloadsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'.repeat(64));
  return dir;
}

// Seed a completed row for `user`, with its media on disk.
async function seed(user, { kept = false } = {}) {
  const downloadId = crypto.randomUUID();
  await store.insert({
    downloadId,
    userId: user.id,
    url: `https://example.com/${downloadId}`,
    title: 'A video',
    type: 'video',
    filesize: 64,
    kept,
  });
  await store.markComplete(downloadId, { filename: 'video.mp4', filesize: 64 });
  onDisk(downloadId);
  return downloadId;
}

const exists = (id, file) => fs.existsSync(path.join(downloadsDir, id, file));

test('GET /api/files (download list) is private — 401 without a session', async () => {
  const res = await fetch(`${base}/api/files`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).success, false);
});

test('PATCH /api/files/:id is private — 401 without a session', async () => {
  const res = await fetch(`${base}/api/files/some-id?kept=true`, { method: 'PATCH' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).success, false);
});

test('DELETE /api/files/:id is private — 401 without a session', async () => {
  const res = await fetch(`${base}/api/files/some-id`, { method: 'DELETE' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).success, false);
});

test('GET /api/files/:id/:filename byte-range serve stays public (not 401) for shared links', async () => {
  // No session cookie: the serve route must not be auth-gated. A non-existent
  // download yields 404 (proving the handler ran), never a 401.
  const res = await fetch(`${base}/api/files/missing-id/missing.mp4`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).success, false);
});

test('GET /api/files lists only the session user’s own downloads', async () => {
  const mine = await seed(ME);
  await seed(THEM);

  const res = await as(ME, '/api/files');
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.data.map((r) => r.downloadId),
    [mine],
  );
});

test('PATCH ?kept=true flips the row — the `downloads` row is the only record of it', async () => {
  const id = await seed(ME);

  const res = await as(ME, `/api/files/${id}?kept=true`, { method: 'PATCH' });

  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { downloadId: id, kept: true });
  assert.equal((await store.findForUser(id, ME.id)).kept, true);
});

test('PATCH on another user’s download is 404 and leaves that row untouched', async () => {
  const id = await seed(THEM);

  const res = await as(ME, `/api/files/${id}?kept=true`, { method: 'PATCH' });

  assert.equal(res.status, 404);
  assert.equal((await store.findForUser(id, THEM.id)).kept, false);
});

test('DELETE expires: the row survives as expired, the whole directory is dropped', async () => {
  const id = await seed(ME);

  const res = await as(ME, `/api/files/${id}`, { method: 'DELETE' });

  assert.equal(res.status, 200);
  const row = await store.findForUser(id, ME.id);
  assert.equal(row.expired, true);
  assert.equal(fs.existsSync(path.join(downloadsDir, id)), false);
  // Expired bytes stop counting against the quota.
  assert.equal(await store.usageForUser(ME.id), 0);
});

test('DELETE ?permanent=true removes the row and the whole directory', async () => {
  const id = await seed(ME);

  const res = await as(ME, `/api/files/${id}?permanent=true`, { method: 'DELETE' });

  assert.equal(res.status, 200);
  assert.equal(await store.findForUser(id, ME.id), null);
  assert.equal(fs.existsSync(path.join(downloadsDir, id)), false);
});

test('DELETE on another user’s download is 404 and destroys neither the row nor the files', async () => {
  const id = await seed(THEM);

  const res = await as(ME, `/api/files/${id}?permanent=true`, { method: 'DELETE' });

  assert.equal(res.status, 404);
  assert.equal((await store.findForUser(id, THEM.id)).expired, false);
  assert.equal(exists(id, 'video.mp4'), true);
});

test('a traversal-shaped downloadId is rejected as 404 before touching the store or disk', async () => {
  const id = await seed(ME);

  const res = await as(ME, '/api/files/..%2F..%2Fetc?permanent=true', { method: 'DELETE' });

  assert.equal(res.status, 404);
  // Nothing else was collaterally removed.
  assert.equal(exists(id, 'video.mp4'), true);
});
