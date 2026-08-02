const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { rateLimit } = require('./rateLimit');

// Small app with a tight limiter mounted behind `trust proxy: 1`, mirroring
// production's Cloudflare → Docker topology (see server.js).
let server;
let base;

before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/limited', rateLimit({ windowMs: 60_000, max: 2 }));
  app.get('/limited', (_req, res) => res.json({ success: true }));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

test('two different X-Forwarded-For clients get independent buckets', async () => {
  const clientA = '203.0.113.10';
  const clientB = '203.0.113.20';

  // Exhaust client A's bucket (max: 2).
  const a1 = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': clientA } });
  const a2 = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': clientA } });
  const a3 = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': clientA } });
  assert.equal(a1.status, 200);
  assert.equal(a2.status, 200);
  assert.equal(a3.status, 429);

  // Client B is untouched — a fresh bucket, not sharing A's.
  const b1 = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': clientB } });
  assert.equal(b1.status, 200);
});

test('CF-Connecting-IP takes precedence over X-Forwarded-For for bucketing', async () => {
  // Two requests share the same X-Forwarded-For (as Cloudflare's edge IP
  // would look via a naive req.ip read) but carry distinct CF-Connecting-IP
  // values — they must not share a bucket.
  const sharedEdge = '198.51.100.1';
  const real1 = '203.0.113.30';
  const real2 = '203.0.113.31';

  const r1a = await fetch(`${base}/limited`, {
    headers: { 'X-Forwarded-For': sharedEdge, 'CF-Connecting-IP': real1 },
  });
  const r1b = await fetch(`${base}/limited`, {
    headers: { 'X-Forwarded-For': sharedEdge, 'CF-Connecting-IP': real1 },
  });
  const r1c = await fetch(`${base}/limited`, {
    headers: { 'X-Forwarded-For': sharedEdge, 'CF-Connecting-IP': real1 },
  });
  assert.equal(r1a.status, 200);
  assert.equal(r1b.status, 200);
  assert.equal(r1c.status, 429, 'real1 should be rate-limited after 2 requests');

  const r2a = await fetch(`${base}/limited`, {
    headers: { 'X-Forwarded-For': sharedEdge, 'CF-Connecting-IP': real2 },
  });
  assert.equal(r2a.status, 200, 'real2 has its own bucket despite sharing an edge IP');
});

test('requests with no forwarding headers (local dev) bucket per socket address', async () => {
  const r1 = await fetch(`${base}/limited`);
  const r2 = await fetch(`${base}/limited`);
  const r3 = await fetch(`${base}/limited`);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
});

test('a throttled request gets a JSON 429 body and a sane Retry-After header', async () => {
  const client = '203.0.113.40';
  await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': client } });
  await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': client } });
  const blocked = await fetch(`${base}/limited`, { headers: { 'X-Forwarded-For': client } });

  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { success: false, error: 'Too many requests' });

  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter), 'Retry-After must be present and integer-valued');
  assert.ok(
    retryAfter > 0 && retryAfter <= 60,
    `Retry-After (${retryAfter}) should fall within the 60s window`,
  );
});
