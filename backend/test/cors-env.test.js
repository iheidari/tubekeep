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
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3989;
const base = `http://localhost:${PORT}`;
const ORIGIN = 'http://cors-sentinel.test';
let server;
let tmpDir;

before(async () => {
  // A scratch cwd whose only .env sets FRONTEND_URL. dotenv reads cwd/.env, so
  // the value can ONLY reach the server via .env loading — not the spawn env.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-cors-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), `FRONTEND_URL=${ORIGIN}\n`);

  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test' };
  delete env.FRONTEND_URL; // must come from .env, not inherited

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

test('FRONTEND_URL from .env is applied as the CORS origin (dotenv is loaded)', async () => {
  const res = await fetch(`${base}/api/files`, { headers: { Origin: ORIGIN } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(
    res.headers.get('access-control-allow-origin'),
    ORIGIN,
    'cross-origin request from the configured FRONTEND_URL must receive Access-Control-Allow-Origin',
  );
});
