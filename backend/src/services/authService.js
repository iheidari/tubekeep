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

// The backend's public base URL (no trailing slash). The emailed magic link must
// point here — /api/auth/verify is what consumes the token and sets the cookie.
function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

// Where to land the browser *after* verifying. In single-server mode the SPA is
// served by this backend, so APP_URL is right. In split dev (Vite on :5173,
// API on :3001) it is not — sending the user to APP_URL would drop them on the
// backend's stale `frontend/dist` build. FRONTEND_URL is already the pinned dev
// origin for CORS, so reuse it and fall back to APP_URL when unset (production).
// Safe because it is operator config, never anything the request supplies.
function frontendUrl() {
  return (process.env.FRONTEND_URL || appUrl()).replace(/\/+$/, '');
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
    // Pin the algorithm: never accept a token signed with anything but our HS256
    // (defense-in-depth against algorithm-confusion, even though jsonwebtoken@9
    // already rejects `alg:none`).
    return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
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
  frontendUrl,
  generateToken,
  hashToken,
  signSession,
  verifySession,
  requestMagicLink,
  verifyMagicLink,
};
