// Session gate. Verifies the JWT session cookie, loads the user, and attaches
// `req.user` (with `user_id` for downstream consumers like 0XC-100). Returns a
// 401 `{ success, error }` when the cookie is missing/invalid or the user no
// longer exists. Mounted on every API router EXCEPT the public file-serving GET.
//
// Exposed as a factory so tests can inject an in-memory store; the default
// export lazily wires the real Postgres-backed store.
const { verifySession, SESSION_COOKIE } = require('../services/authService');

function createRequireAuth(store) {
  const unauthorized = (res) =>
    res.status(401).json({ success: false, error: 'Authentication required' });

  return async function requireAuth(req, res, next) {
    const token = req.cookies?.[SESSION_COOKIE];
    const payload = verifySession(token);
    if (!payload) {
      return unauthorized(res);
    }

    try {
      const user = await store.findUserById(payload.sub);
      if (!user) {
        return unauthorized(res);
      }
      req.user = {
        user_id: user.id,
        id: user.id,
        email: user.email,
        name: user.name,
        max_storage_bytes: user.max_storage_bytes,
      };
      next();
    } catch (err) {
      console.error('❌ Auth middleware error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

// Lazily build the real store so requiring this module doesn't touch the DB
// (and doesn't throw when DATABASE_URL is unset in unit tests).
let defaultMiddleware;
function requireAuth(req, res, next) {
  if (!defaultMiddleware) {
    const { query } = require('../db');
    const { createStore } = require('../services/authStore');
    defaultMiddleware = createRequireAuth(createStore(query));
  }
  return defaultMiddleware(req, res, next);
}

module.exports = { requireAuth, createRequireAuth };
