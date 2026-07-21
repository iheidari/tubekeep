// End-to-end regression guard for 0XC-128 ("rate limiter buckets collapsed to
// one shared bucket in production because Express never had `trust proxy`
// configured behind Cloudflare").
//
// backend/src/utils/rateLimit.test.js already unit-tests the limiter's IP
// bucketing logic against a hand-built Express app that sets `trust proxy`
// itself. That proves the *function* is correct, but not that the *real*
// server.js actually wires `app.set('trust proxy', 1)` together with a
// rate-limited route the way production does — a regression here (e.g.
// someone removing that `app.set` call, or moving a route above/below it)
// would slip past the isolated unit test entirely.
//
// This spawns the real server as a child process (the same pattern as
// cors-env.test.js / schema-boot.test.js) and drives POST /api/auth/request
// (rate-limited inline at max: 10/min — see routes/auth.js) with spoofed
// X-Forwarded-For / CF-Connecting-IP headers, exactly as Cloudflare would set
// them at its edge.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3993;
const base = `http://localhost:${PORT}`;
let server;
let tmpDir;

async function requestAs(ip, extraHeaders = {}) {
  return fetch(`${base}/api/auth/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      ...extraHeaders,
    },
    body: JSON.stringify({ email: 'nobody@example.com' }),
  });
}

// Drive `count` requests as `ip`+headers concurrently — used to walk a bucket
// right up to its max: 10 limit. Order doesn't matter: the limiter reads/writes
// its hit map synchronously per request (no `await` in between), so concurrent
// requests can't race each other into the same slot.
async function fireN(count, ip, extraHeaders = {}) {
  const responses = await Promise.all(
    Array.from({ length: count }, () => requestAs(ip, extraHeaders)),
  );
  return responses.every((res) => res.status === 200);
}

before(async () => {
  // Scratch cwd with an explicit empty .env so DATABASE_URL/FRONTEND_URL can
  // ONLY come from the spawn env, never a real backend/.env on this machine
  // (same isolation as cors-env.test.js / schema-boot.test.js). No DB is
  // needed: /api/auth/request's store call is wrapped in try/catch and still
  // answers its generic 200 on failure (see routes/auth.js), and the rate
  // limiter runs ahead of that DB call regardless.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-ratelimit-proxy-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), '');

  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  delete env.FRONTEND_URL;

  server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: tmpDir,
    env,
    stdio: 'ignore',
  });

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
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the real server buckets by X-Forwarded-For client, not one shared IP (trust proxy wired end-to-end)', async () => {
  const clientA = '203.0.113.201';
  const clientB = '203.0.113.202';

  // Exhaust A's bucket: 10 allowed, the 11th throttled.
  const allSucceeded = await fireN(10, clientA);
  assert.ok(allSucceeded, 'all 10 requests within the limit should succeed');
  const blocked = await requestAs(clientA);
  assert.equal(blocked.status, 429, 'the 11th request from the same client should be throttled');
  const body = await blocked.json();
  assert.equal(body.success, false);
  assert.equal(typeof body.error, 'string');
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60);

  // A fresh client is untouched — proves the real server derives distinct
  // bucket keys per forwarded client instead of collapsing onto one shared
  // req.ip (the pre-0XC-128 bug).
  const other = await requestAs(clientB);
  assert.equal(other.status, 200, "a different client's request must not inherit A's throttling");
});

test('the real server prefers CF-Connecting-IP over X-Forwarded-For (Cloudflare edge IP cannot collapse two visitors)', async () => {
  const sharedEdge = '198.51.100.9'; // what a naive req.ip read would see for every visitor
  const real1 = '203.0.113.211';
  const real2 = '203.0.113.212';

  const allSucceeded = await fireN(10, sharedEdge, { 'CF-Connecting-IP': real1 });
  assert.ok(allSucceeded);
  const blocked = await requestAs(sharedEdge, { 'CF-Connecting-IP': real1 });
  assert.equal(blocked.status, 429, 'real1 should be throttled after exhausting its own bucket');

  const distinctVisitor = await requestAs(sharedEdge, { 'CF-Connecting-IP': real2 });
  assert.equal(
    distinctVisitor.status,
    200,
    'real2 must get its own bucket despite sharing X-Forwarded-For with real1',
  );
});
