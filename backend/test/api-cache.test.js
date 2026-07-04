// Regression guard for the "NetworkError on repeat /api/info fetch" bug.
//
// Root cause: Express's default weak ETag made dynamic API JSON answer
// `304 Not Modified` on a repeat fetch. A cross-origin revalidated 304 could
// surface in the browser as a bare "NetworkError", and caching yt-dlp output
// (rotating signed URLs) is wrong regardless. The fix disables ETags app-wide
// and marks /api responses `no-store`, so the API must ALWAYS answer 200 and
// never 304 — even when a client sends a conditional `If-None-Match`.
//
// No test framework is configured in this repo, so this uses the built-in
// node:test runner and spawns the real server as a child process (Node 18+
// global fetch). Run with `npm test`.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3990;
const base = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  // Poll /health until the server is listening.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Test server did not start in time');
});

after(() => {
  if (server) server.kill('SIGKILL');
});

test('API JSON is non-cacheable: no ETag, Cache-Control no-store', async () => {
  const res = await fetch(`${base}/api/files`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('etag'), null, 'API responses must not carry an ETag');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

test('a full conditional round-trip never yields 304', async () => {
  // Capture whatever validator the first response offers, then replay it — the
  // exact sequence a browser performs. Before the fix the server emitted an
  // ETag and this replay returned 304; now there's no validator, so it's 200.
  const first = await fetch(`${base}/api/files`);
  const etag = first.headers.get('etag');
  assert.strictEqual(etag, null, 'API must not offer a validator to revalidate against');

  const second = await fetch(`${base}/api/files`, {
    headers: { 'If-None-Match': etag ?? 'W/"replay"' },
  });
  assert.strictEqual(
    second.status,
    200,
    'API must never return 304 — a cross-origin revalidated 304 breaks the browser fetch',
  );
});
