const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const {
  requestMagicLink,
  verifyMagicLink,
  signSession,
  verifySession,
  hashToken,
  appUrl,
  frontendUrl,
  TOKEN_TTL_MS,
} = require('./authService');
const { createMemoryStore } = require('./authStore');

const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice', max_storage_bytes: 100 };

// Collects the raw token the mailer would send, so tests can act as the user
// clicking the link.
function fakeMailer() {
  const sent = [];
  return {
    sent,
    async sendMagicLink(email, rawToken) {
      sent.push({ email, rawToken });
    },
  };
}

test('requestMagicLink emails a link only for a known user and stores the hash', async () => {
  const store = createMemoryStore({ users: [USER] });
  const mailer = fakeMailer();

  await requestMagicLink('alice@example.com', { store, mailer });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].email, 'alice@example.com');
  // Only the hash is persisted, never the raw token.
  const stored = store._tokens.get(hashToken(mailer.sent[0].rawToken));
  assert.ok(stored, 'token hash should be stored');
  assert.equal(store._tokens.has(mailer.sent[0].rawToken), false);
});

test('requestMagicLink is a silent no-op for an unknown email (no allowlist leak)', async () => {
  const store = createMemoryStore({ users: [USER] });
  const mailer = fakeMailer();

  await requestMagicLink('stranger@example.com', { store, mailer });

  assert.equal(mailer.sent.length, 0);
  assert.equal(store._tokens.size, 0);
});

test('requestMagicLink normalizes email case/whitespace', async () => {
  const store = createMemoryStore({ users: [USER] });
  const mailer = fakeMailer();

  await requestMagicLink('  ALICE@example.com  ', { store, mailer });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].email, 'alice@example.com');
});

test('requestMagicLink matches a user whose stored email is mixed-case', async () => {
  // Regression: findUserByEmail must be case-insensitive, or a hand-entered
  // mixed-case `users` row could never log in (silent generic 200).
  const mixed = { id: 'user-2', email: 'Bob@Example.com', name: 'Bob', max_storage_bytes: 100 };
  const store = createMemoryStore({ users: [mixed] });
  const mailer = fakeMailer();

  await requestMagicLink('bob@example.com', { store, mailer });

  assert.equal(mailer.sent.length, 1);
});

test('verifyMagicLink returns the user for a valid token', async () => {
  const store = createMemoryStore({ users: [USER] });
  const mailer = fakeMailer();
  await requestMagicLink('alice@example.com', { store, mailer });

  const user = await verifyMagicLink(mailer.sent[0].rawToken, { store });
  assert.equal(user.id, 'user-1');
});

test('verifyMagicLink is single-use — a second verify fails', async () => {
  const store = createMemoryStore({ users: [USER] });
  const mailer = fakeMailer();
  await requestMagicLink('alice@example.com', { store, mailer });
  const token = mailer.sent[0].rawToken;

  const first = await verifyMagicLink(token, { store });
  assert.ok(first, 'first verify should succeed');
  const second = await verifyMagicLink(token, { store });
  assert.equal(second, null, 'second verify must be rejected');
});

test('verifyMagicLink rejects an expired token', async () => {
  const store = createMemoryStore({ users: [USER] });
  const mailer = fakeMailer();
  // Mint the token "in the past" so its 15-min TTL is already elapsed.
  const past = () => Date.now() - TOKEN_TTL_MS - 1000;
  await requestMagicLink('alice@example.com', { store, mailer, now: past });

  const user = await verifyMagicLink(mailer.sent[0].rawToken, { store });
  assert.equal(user, null, 'expired token must be rejected');
});

test('verifyMagicLink rejects an unknown/garbage token', async () => {
  const store = createMemoryStore({ users: [USER] });
  assert.equal(await verifyMagicLink('not-a-real-token', { store }), null);
  assert.equal(await verifyMagicLink('', { store }), null);
});

test('session JWT round-trips and rejects tampering', () => {
  const token = signSession(USER);
  const payload = verifySession(token);
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.email, 'alice@example.com');
  assert.equal(verifySession(`${token}tampered`), null);
  assert.equal(verifySession(null), null);
});

// In split dev (Vite :5173 + API :3001) the magic link must point at the backend
// but the post-verify redirect must land on the Vite origin, or the user ends up
// on the backend's stale `frontend/dist` build.
test('frontendUrl prefers FRONTEND_URL and falls back to APP_URL', () => {
  const savedApp = process.env.APP_URL;
  const savedFront = process.env.FRONTEND_URL;
  try {
    process.env.APP_URL = 'http://localhost:3001';
    process.env.FRONTEND_URL = 'http://localhost:5173/';
    assert.equal(frontendUrl(), 'http://localhost:5173');
    assert.equal(appUrl(), 'http://localhost:3001', 'the link base stays on the backend');

    delete process.env.FRONTEND_URL;
    assert.equal(frontendUrl(), 'http://localhost:3001', 'single-server mode: same origin');
  } finally {
    if (savedApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedApp;
    if (savedFront === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = savedFront;
  }
});
