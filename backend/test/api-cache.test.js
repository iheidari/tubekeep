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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnServer } = require('./helpers/spawnServer');

let server;
let base;
let tmpDir;

before(async () => {
  // A scratch cwd with an empty `.env`, the same isolation the other
  // spawn-based files use: server.js runs `dotenv.config()` against its cwd,
  // so spawning with the inherited one would pick up a developer's real
  // backend/.env (DATABASE_URL, FRONTEND_URL). Nothing here depends on either,
  // but a spawn that behaves differently on a developer machine than in CI is
  // the seed of the next "passes locally" mystery.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-api-cache-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), '');

  // The helper spawns the real server on an OS-assigned port and waits for it
  // to answer /health (0XC-275) — no hand-picked port to collide with the
  // other spawn-based test files this runs in parallel with.
  ({ server, base } = await spawnServer({ cwd: tmpDir, env: { DATABASE_URL: undefined } }));
});

after(() => {
  if (server) server.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Probe `/api/auth/me`: a public, always-present `/api` route (returns 401 with
// no session, short-circuiting before any DB access). The ETag/no-store
// behavior under test is app-level middleware, so it applies to every `/api`
// response regardless of route or status.
test('API JSON is non-cacheable: no ETag, Cache-Control no-store', async () => {
  const res = await fetch(`${base}/api/auth/me`);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get('etag'), null, 'API responses must not carry an ETag');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

test('a full conditional round-trip never yields 304', async () => {
  // Capture whatever validator the first response offers, then replay it — the
  // exact sequence a browser performs. Before the fix the server emitted an
  // ETag and this replay returned 304; now there's no validator, so it never
  // revalidates to 304.
  const first = await fetch(`${base}/api/auth/me`);
  const etag = first.headers.get('etag');
  assert.strictEqual(etag, null, 'API must not offer a validator to revalidate against');

  const second = await fetch(`${base}/api/auth/me`, {
    headers: { 'If-None-Match': etag ?? 'W/"replay"' },
  });
  assert.notStrictEqual(
    second.status,
    304,
    'API must never return 304 — a cross-origin revalidated 304 breaks the browser fetch',
  );
});
