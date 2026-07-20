const express = require('express');
const {
  requestMagicLink,
  verifyMagicLink,
  signSession,
  frontendUrl,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} = require('../services/authService');
const { createRequireAuth } = require('../middleware/requireAuth');
const { rateLimit } = require('../utils/rateLimit');

// Cookie flags: httpOnly always; SameSite=Lax so the emailed link's top-level
// GET /verify navigation still sends/sets the cookie; Secure only in prod (a
// Secure cookie is dropped over plain-http localhost). Path=/ so it rides every
// API request.
function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
  };
}

// Build the auth router. `store` and `mailer` are injected so the whole router
// is testable without Postgres or a real mail provider.
function createAuthRouter({ store, mailer }) {
  const router = express.Router();
  const requireAuth = createRequireAuth(store);

  // Step 1: request a magic link. Always responds the same way whether or not
  // the email is in the allowlist, so the response can't be used to enumerate
  // users. Rate-limited inline (per-IP) since it can both send mail and probe
  // the users table.
  router.post('/request', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    try {
      await requestMagicLink(email, { store, mailer });
    } catch (err) {
      console.error('❌ Magic-link request error:', err.message);
      // Still respond generically — never reveal that this specific email failed.
    }
    res.json({
      success: true,
      data: { message: 'If that email is registered, a sign-in link is on its way.' },
    });
  });

  // Step 2: the emailed link lands here. Consume the token, set the session
  // cookie, and redirect into the app. On any failure, redirect to the app with
  // a `?login=error` flag the frontend (0XC-98) can surface.
  router.get('/verify', async (req, res) => {
    const { token } = req.query;
    try {
      const user = await verifyMagicLink(token, { store });
      if (!user) {
        return res.redirect(`${frontendUrl()}/?login=error`);
      }
      const session = signSession(user);
      res.cookie(SESSION_COOKIE, session, {
        ...sessionCookieOptions(),
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
      return res.redirect(`${frontendUrl()}/?login=success`);
    } catch (err) {
      console.error('❌ Magic-link verify error:', err.message);
      return res.redirect(`${frontendUrl()}/?login=error`);
    }
  });

  // Clear the session cookie. Must pass the same flags (minus maxAge) or some
  // browsers won't match and clear it.
  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.json({ success: true, data: { message: 'Logged out' } });
  });

  // Current session's user, or 401. requireAuth has already attached req.user.
  router.get('/me', requireAuth, (req, res) => {
    const { email, name, max_storage_bytes } = req.user;
    res.json({ success: true, data: { email, name, max_storage_bytes } });
  });

  return router;
}

module.exports = { createAuthRouter, sessionCookieOptions };
