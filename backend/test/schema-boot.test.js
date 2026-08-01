// Regression guard for 0XC-115 ("Apply schema.sql automatically on boot").
// server.js's boot sequence is now `ensureSchema().then(startCleanupScheduler
// ...).then(app.listen ...)`. ensureSchema() must be a true no-op — it must
// never call getPool()/applySchema() — when DATABASE_URL is unset, so the
// server still boots and serves traffic with no database configured at all
// (this sandbox, unit tests elsewhere in this suite, an offline dev install).
//
// This is the one true end-to-end path testable without a real Postgres: spawn
// the real server as a child process (the same pattern as cors-env.test.js /
// api-cache.test.js) with DATABASE_URL explicitly absent, and confirm it
// reaches app.listen() (i.e. /health answers) with no schema-related error.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { spawnServer, scratchCwd, removeScratchCwd } = require('./helpers/spawnServer');

let server;
let base;
let stdout;
let stderr;
let tmpDir;

before(async () => {
  // DATABASE_URL has to be absent BOTH ways for this to exercise the skip path:
  // deleted from the child's env, and absent from the `.env` the scratch cwd
  // supplies (a real backend/.env — which this repo's README has you create —
  // would otherwise load it right back and run applySchema() against a live
  // database). The helper also captures the child's stdout/stderr, the two
  // streams this test's assertions read.
  tmpDir = scratchCwd('tk-schema-boot-');
  ({ server, base, stdout, stderr } = await spawnServer({
    cwd: tmpDir,
    env: { DATABASE_URL: undefined },
  }));
});

after(() => {
  if (server) server.kill('SIGKILL');
  removeScratchCwd(tmpDir);
});

test('server boots and serves /health with no DATABASE_URL configured (ensureSchema skip path)', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');

  // ensureSchema()'s only observable output is on the two paths it must NOT
  // take here: a successful apply logs "Database schema up to date" (stdout),
  // a failed one logs "Failed to apply database schema" (stderr). Neither
  // should appear — the function should have returned immediately on the
  // missing DATABASE_URL check, before ever touching getPool()/applySchema().
  assert.ok(
    !stdout().includes('Database schema up to date'),
    'ensureSchema must not attempt a schema apply when DATABASE_URL is unset',
  );
  assert.ok(
    !stderr().includes('Failed to apply database schema'),
    'ensureSchema must not attempt (and fail) a schema apply when DATABASE_URL is unset',
  );
});
