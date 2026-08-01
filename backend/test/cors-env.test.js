// Regression guard for the "CORS header Access-Control-Allow-Origin missing"
// bug. Root cause: the backend never loaded backend/.env (no dotenv), so
// FRONTEND_URL was undefined → the CORS origin fell back to `false` (same-origin
// only) → cross-origin requests from the dev frontend got NO
// Access-Control-Allow-Origin and the browser blocked the 200 response.
//
// This test spawns the server with a throwaway cwd containing only a `.env`
// that sets FRONTEND_URL, passing NO FRONTEND_URL in the process env. So it
// proves BOTH that dotenv loads `.env` from disk AND that CORS honors it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { spawnServer, scratchCwd, removeScratchCwd } = require('./helpers/spawnServer');

const ORIGIN = 'http://cors-sentinel.test';
let server;
let base;
let tmpDir;

before(async () => {
  // The scratch cwd's only .env sets FRONTEND_URL, and it is deleted from the
  // child's env — so the value can ONLY reach the server by being loaded off
  // disk, which is the whole claim under test.
  tmpDir = scratchCwd('tk-cors-', `FRONTEND_URL=${ORIGIN}\n`);
  ({ server, base } = await spawnServer({ cwd: tmpDir, env: { FRONTEND_URL: undefined } }));
});

after(() => {
  if (server) server.kill('SIGKILL');
  removeScratchCwd(tmpDir);
});

test('FRONTEND_URL from .env is applied as the CORS origin (dotenv is loaded)', async () => {
  // Probe `/api/auth/me`: a public, always-present `/api` route that returns a
  // deterministic 401 with no session (short-circuits before any DB access).
  // CORS runs ahead of the auth gate, so the Access-Control-Allow-Origin header
  // — the thing under test — is present regardless of the 401 status.
  const res = await fetch(`${base}/api/auth/me`, { headers: { Origin: ORIGIN } });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(
    res.headers.get('access-control-allow-origin'),
    ORIGIN,
    'cross-origin request from the configured FRONTEND_URL must receive Access-Control-Allow-Origin',
  );
});
