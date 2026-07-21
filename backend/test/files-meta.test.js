// Coverage for GET /api/files/meta/:downloadId (0XC-112) — the public
// single-item metadata endpoint that lets a /play/:id share link resolve for
// someone who isn't the row's owner. Exercises the router directly (an
// in-memory store, no Postgres) plus one real-filesystem case for the
// route-ordering guarantee against the serve route.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createFilesRouter } = require('../src/routes/files');
const { createMemoryStore } = require('../src/services/downloadsStore');
const { downloadsDir } = require('../src/utils/storage');

const READY_ID = '11111111-1111-1111-1111-111111111111';
const DOWNLOADING_ID = '22222222-2222-2222-2222-222222222222';
const MOVED_ID = '33333333-3333-3333-3333-333333333333';
const EXPIRED_ID = '44444444-4444-4444-4444-444444444444';
const META_FILENAME_ID = '55555555-5555-5555-5555-555555555555';
const UNKNOWN_ID = '99999999-9999-9999-9999-999999999999';

function row(overrides = {}) {
  return {
    download_id: READY_ID,
    user_id: 'owner-1',
    url: 'https://youtu.be/secret-source',
    title: 'Some Title',
    thumbnail: 'https://img.example/thumb.jpg',
    type: 'video',
    filename: 'video.mp4',
    filesize: 12345,
    status: 'complete',
    completed_at: new Date(),
    expired: false,
    expired_at: null,
    moved: false,
    moved_info: null,
    kept: false,
    created_at: new Date(),
    ...overrides,
  };
}

// requireAuth is never exercised by this endpoint (it's declared above the
// choke), so a middleware that always 401s proves that if it ever ran.
const requireAuth = (_req, res) => res.status(401).json({ success: false, error: 'unauth' });

function startRouter(store) {
  const app = express();
  app.use('/api/files', createFilesRouter(requireAuth, { store }));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

let server;
let base;

before(async () => {
  const store = createMemoryStore({
    rows: [
      row(),
      row({
        download_id: DOWNLOADING_ID,
        status: 'downloading',
        filename: null,
        completed_at: null,
      }),
      row({ download_id: MOVED_ID, moved: true }),
      row({ download_id: EXPIRED_ID, expired: true }),
    ],
  });

  server = await startRouter(store);
  base = `http://localhost:${server.address().port}`;

  // Real on-disk fixture for the "filename literally 'meta'" route-ordering
  // case — the serve route reads the filesystem directly, not the store.
  fs.mkdirSync(path.join(downloadsDir, META_FILENAME_ID), { recursive: true });
  fs.writeFileSync(path.join(downloadsDir, META_FILENAME_ID, 'meta'), 'hello-world');
});

after(() => {
  fs.rmSync(path.join(downloadsDir, META_FILENAME_ID), { recursive: true, force: true });
  return new Promise((resolve) => server.close(resolve));
});

test('resolves a ready download with no owner detail', async () => {
  const res = await fetch(`${base}/api/files/meta/${READY_ID}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.data, {
    downloadId: READY_ID,
    title: 'Some Title',
    thumbnail: 'https://img.example/thumb.jpg',
    type: 'video',
    filename: 'video.mp4',
    expired: false,
  });
  for (const leaked of ['user_id', 'url', 'size', 'status', 'kept']) {
    assert.ok(!(leaked in body.data), `must not expose ${leaked}`);
  }
});

test('a still-downloading row reports unavailable, not a null filename', async () => {
  const res = await fetch(`${base}/api/files/meta/${DOWNLOADING_ID}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.data.expired, true);
  assert.strictEqual(body.data.filename, null);
});

test('a moved-to-cloud row reports unavailable rather than a dangling filename', async () => {
  const res = await fetch(`${base}/api/files/meta/${MOVED_ID}`);
  const body = await res.json();
  assert.strictEqual(body.data.expired, true);
  assert.strictEqual(body.data.filename, null);
});

test('an expired row resolves with expired: true instead of 404', async () => {
  const res = await fetch(`${base}/api/files/meta/${EXPIRED_ID}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.data.expired, true);
  assert.strictEqual(body.data.filename, null);
});

test('an unknown id returns 404', async () => {
  const res = await fetch(`${base}/api/files/meta/${UNKNOWN_ID}`);
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.success, false);
});

test('a malformed id returns 404 without ever querying the store', async () => {
  const poisoned = createMemoryStore();
  poisoned.findById = async () => {
    throw new Error('store must not be queried for a malformed id');
  };
  const poisonedServer = await startRouter(poisoned);
  const poisonedBase = `http://localhost:${poisonedServer.address().port}`;
  try {
    const res = await fetch(`${poisonedBase}/api/files/meta/not-a-uuid`);
    assert.strictEqual(res.status, 404);
  } finally {
    await new Promise((resolve) => poisonedServer.close(resolve));
  }
});

test('route ordering: a real download whose filename is literally "meta" still serves', async () => {
  const res = await fetch(`${base}/api/files/${META_FILENAME_ID}/meta`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'hello-world');
});
