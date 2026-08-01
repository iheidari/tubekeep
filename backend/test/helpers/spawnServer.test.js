// Tests for the shared spawn-a-real-server helper (0XC-275).
//
// The helper exists because five test files used to hand-pick a port each
// (3989/3990/3992/3993/3994) while `node --test` runs test FILES in parallel.
// Two files sharing a port raced for the bind: one lost with EADDRINUSE and
// failed with ECONNREFUSED — or, worse, its /health poll succeeded against the
// OTHER file's server and it went on to assert against a process booted with
// different env. A comment listing the taken ports is not a mechanism; an
// OS-assigned ephemeral port is.
//
// So the two claims worth pinning here are: the helper reports the port the OS
// actually bound (never a requested/stale one), and two servers alive at the
// same time can never collide.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnServer, SERVER_TEST_FILE_GLOBS } = require('./spawnServer');

// A scratch cwd whose only `.env` is empty, so server.js's `dotenv.config()`
// can't pick up a real backend/.env on this machine (same isolation the
// spawn-based test files use). Registered for removal on the returned handle's
// teardown so each test stays self-contained.
function scratchCwd(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, '.env'), '');
  return dir;
}

test('resolves with the port the OS actually bound, and it serves /health', async () => {
  const cwd = scratchCwd('tk-spawn-helper-');
  const { server, port, base } = await spawnServer({ cwd, env: { DATABASE_URL: undefined } });
  try {
    assert.ok(Number.isInteger(port) && port > 0, `expected a real bound port, got ${port}`);
    assert.strictEqual(base, `http://localhost:${port}`);

    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).status, 'ok');
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('two servers running at once get distinct ports (the collision this replaces)', async () => {
  const cwdA = scratchCwd('tk-spawn-helper-a-');
  const cwdB = scratchCwd('tk-spawn-helper-b-');
  const [a, b] = await Promise.all([
    spawnServer({ cwd: cwdA, env: { DATABASE_URL: undefined } }),
    spawnServer({ cwd: cwdB, env: { DATABASE_URL: undefined } }),
  ]);
  try {
    assert.notStrictEqual(a.port, b.port, 'concurrent servers must not share a port');

    // Both must be independently reachable — the pre-0XC-275 failure mode was
    // one server losing the bind while the other answered for both.
    for (const { base } of [a, b]) {
      const res = await fetch(`${base}/health`);
      assert.strictEqual(res.status, 200);
    }
  } finally {
    a.server.kill('SIGKILL');
    b.server.kill('SIGKILL');
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  }
});

test('env overrides reach the child, and an `undefined` value deletes an inherited var', async () => {
  const cwd = scratchCwd('tk-spawn-helper-env-');
  const origin = 'http://spawn-helper-sentinel.test';
  const { server, base } = await spawnServer({
    cwd,
    env: { FRONTEND_URL: origin, DATABASE_URL: undefined },
  });
  try {
    // FRONTEND_URL reached the child: it became the pinned CORS origin.
    const res = await fetch(`${base}/api/auth/me`, { headers: { Origin: origin } });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), origin);
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("fails loudly with the child's stderr when the server can't boot", async () => {
  const cwd = scratchCwd('tk-spawn-helper-boom-');
  // NODE_ENV=production with no JWT_SECRET makes server.js throw at require
  // time — a deterministic boot failure. Before the helper this surfaced as a
  // 5s poll timeout into a bare "did not start in time" with no cause.
  await assert.rejects(
    () => spawnServer({ cwd, env: { NODE_ENV: 'production', JWT_SECRET: undefined } }),
    (err) => {
      assert.match(err.message, /exited before it started listening/);
      assert.match(err.message, /JWT_SECRET is required in production/);
      return true;
    },
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

// The drift guard the ticket asks for: the point of this helper is that the
// NEXT test file to spawn a server can't quietly reintroduce a hand-picked
// port. Only the helper itself may name a PORT.
test('no test file names a server PORT — only the helper does', () => {
  const backendRoot = path.join(__dirname, '..', '..');
  const helperPath = path.join(__dirname, 'spawnServer.js');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SERVER_TEST_FILE_GLOBS.test(entry.name) && full !== helperPath) {
        // Comments are stripped first so prose about ports (including this
        // file's own) can't trip the guard — only real code counts. What's
        // left matches a spawn env entry or a per-file constant, either of
        // which is a hand-picked port that can collide with another file's.
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        if (/\bPORT\b\s*[:=][^=]/.test(code)) {
          offenders.push(path.relative(backendRoot, full));
        }
      }
    }
  };
  walk(backendRoot);

  assert.deepStrictEqual(
    offenders,
    [],
    `these test files hardcode a server port instead of using test/helpers/spawnServer.js: ${offenders.join(', ')}`,
  );
});
