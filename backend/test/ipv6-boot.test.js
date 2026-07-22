// Regression guard for 0XC-126 ("Auto-detect black-holed IPv6"). server.js's
// boot sequence now runs `ensureIpv4Decision()` (services/ipv6.js's
// decideForceIpv4) alongside ensureSchema() before app.listen(). That decision
// must never touch the real network in the test suite (hermetic — same
// reasoning as schema-boot.test.js's DATABASE_URL skip), and an explicit
// YTDLP_FORCE_IPV4 must still reach all the way through boot.
//
// Spawn the real server as a child process (same pattern as schema-boot.test.js
// / cors-env.test.js) and confirm both directions.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3993;
const base = `http://localhost:${PORT}`;
let tmpDir;

before(() => {
  // Same reasoning as schema-boot.test.js: a scratch cwd with an empty `.env`
  // so server.js's dotenv.config() can't silently pick up a real backend/.env.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-ipv6-boot-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), '');
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bootServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test', ...extraEnv };
    delete env.DATABASE_URL;

    const server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
      cwd: tmpDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    server.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    server.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const started = Date.now();
    (async () => {
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`${base}/health`);
          if (res.ok) {
            resolve({
              server,
              stdout: () => stdout,
              stderr: () => stderr,
              elapsedMs: Date.now() - started,
            });
            return;
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      reject(new Error(`Test server did not start in time. stderr: ${stderr}`));
    })();
  });
}

test('boots quickly with no YTDLP_FORCE_IPV4 set — the probe is skipped in NODE_ENV=test', async () => {
  const { server, elapsedMs } = await bootServer({});
  try {
    // Skipping the probe means boot isn't gated on any network round-trip; a
    // real (non-skipped) probe is bounded at ~2s by itself, so an unrelated
    // regression that re-enabled probing in tests would push this well past a
    // generous margin.
    assert.ok(elapsedMs < 4000, `expected a fast boot with the probe skipped, took ${elapsedMs}ms`);
  } finally {
    server.kill('SIGKILL');
  }
});

test('an explicit YTDLP_FORCE_IPV4=true reaches through boot and is logged', async () => {
  const { server, stdout } = await bootServer({ YTDLP_FORCE_IPV4: 'true' });
  try {
    assert.match(stdout(), /forcing IPv4/);
  } finally {
    server.kill('SIGKILL');
  }
});
