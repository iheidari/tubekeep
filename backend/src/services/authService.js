// Auth orchestration + crypto primitives, deliberately free of Express and
// Postgres so it can be unit-tested in isolation. Routes inject a `store`
// (authStore.js) and `mailer` (mailer.js); the JWT helpers read JWT_SECRET.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

// Magic links are valid ~15 minutes; sessions ~30 days.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = 'tk_session';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set — cannot sign/verify sessions.');
  return secret;
}

// The app's public base URL (no trailing slash). Single source of truth so the
// emailed magic link (mailer) and the post-login redirect (auth router) can't
// drift onto different origins.
function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

// Raw token the user receives in the link; the hash is what we store.
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Sign a session JWT carrying the user id + email.
function signSession(user) {
  return jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

// Verify a session JWT; returns its payload or null (never throws).
function verifySession(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

// Step 1 of login: given a submitted email, if it belongs to an allowed user,
// mint a single-use token, store its hash, and send the magic link. Returns
// nothing meaningful — the route always responds generically so the allowlist
// never leaks. `now` is injectable for deterministic tests.
async function requestMagicLink(email, { store, mailer, now = Date.now } = {}) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return;

  const user = await store.findUserByEmail(normalized);
  if (!user) return; // unknown email: silently do nothing (generic response upstream)

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now() + TOKEN_TTL_MS);

  await store.insertLoginToken({ tokenHash, email: normalized, expiresAt });
  await mailer.sendMagicLink(normalized, rawToken);
}

// Step 2 of login: consume the raw token from the link. Returns the user on
// success, or null if the token is invalid/expired/used or its email no longer
// maps to a user. Consumption is atomic in the store (single-use guarantee).
async function verifyMagicLink(rawToken, { store } = {}) {
  if (!rawToken) return null;
  const email = await store.consumeLoginToken(hashToken(rawToken));
  if (!email) return null;
  return store.findUserByEmail(email);
}

module.exports = {
  TOKEN_TTL_MS,
  SESSION_TTL_SECONDS,
  SESSION_COOKIE,
  appUrl,
  generateToken,
  hashToken,
  signSession,
  verifySession,
  requestMagicLink,
  verifyMagicLink,
};
