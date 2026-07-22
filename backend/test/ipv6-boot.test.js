// Regression guard for 0XC-126 ("Auto-detect black-holed IPv6"). server.js's
// boot sequence now runs `ensureIpv4Decision()` (services/ipv6.js's
// decideForceIpv4) alongside ensureSchema() before app.listen(). That decision
// must never touch the real network in the test suite (hermetic — same
// reasoning as schema-boot.test.js's DATABASE_URL skip), and an explicit
// YTDLP_FORCE_IPV4 must still reach all the way through boot.
//
// Spawn the real server as a child process (same pattern as schema-boot.test.js
// / cors-env.test.js) and confirm both directions. The "is the probe really
// skipped" claim is checked two ways: a coarse fast-boot timing sanity check,
// and a direct, deterministic proof via a `net.connect`-spying preload script
// (written into the scratch tmpDir below, not committed — it must not be
// picked up as its own test file by node --test's directory-based discovery)
// that the probe made zero connection attempts. See the comment on that test
// for why the timing check alone isn't enough.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3993;
const base = `http://localhost:${PORT}`;
let tmpDir;
let connectSpyPath;

// Patches net.connect to log a distinguishable marker whenever something
// calls it with the exact `{ family: 6 }` shape services/ipv6.js's probe
// uses, then delegates to the real implementation so normal boot (HTTP
// listen, etc.) is unaffected. Loaded into the spawned server subprocess via
// `node --require`, never into this test process.
const CONNECT_SPY_SOURCE = `
const net = require('node:net');
const originalConnect = net.connect;
net.connect = function ipv6ProbeSpyConnect(...args) {
  const opts = args[0];
  if (opts && typeof opts === 'object' && opts.family === 6) {
    console.log('IPV6_PROBE_CONNECT_ATTEMPT ' + JSON.stringify({ host: opts.host, port: opts.port }));
  }
  return originalConnect.apply(net, args);
};
`;

before(() => {
  // Same reasoning as schema-boot.test.js: a scratch cwd with an empty `.env`
  // so server.js's dotenv.config() can't silently pick up a real backend/.env.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-ipv6-boot-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), '');

  // Written into the scratch tmpDir (outside the repo, so it can never be
  // picked up by node --test's own directory-based file discovery) rather
  // than committed under test/ as its own file.
  connectSpyPath = path.join(tmpDir, 'ipv6ConnectSpy.js');
  fs.writeFileSync(connectSpyPath, CONNECT_SPY_SOURCE);
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bootServer(extraEnv, execArgv = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test', ...extraEnv };
    delete env.DATABASE_URL;

    const server = spawn('node', [...execArgv, path.join(__dirname, '..', 'src', 'server.js')], {
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

// The fast-boot test above is a coarse proxy: a real (non-skipped) probe that
// happens to resolve quickly — e.g. an immediate 'no-route' rejection, which
// is exactly what a sandboxed/offline CI runner with no IPv6 route would give
// it — would boot just as fast as a truly skipped one, so that assertion alone
// can't tell "skipped" apart from "ran and returned fast". This test proves
// the stronger, direct claim instead: with the probe preload spy watching
// every `net.connect` call, NODE_ENV=test must produce *zero* connect attempts
// shaped like `services/ipv6.js`'s probe — i.e. the probe genuinely never ran,
// not just that it finished quickly.
test('no IPv6 probe connect attempt is made at all when NODE_ENV=test skips it', async () => {
  const { server, stdout } = await bootServer({}, ['--require', connectSpyPath]);
  try {
    assert.doesNotMatch(
      stdout(),
      /IPV6_PROBE_CONNECT_ATTEMPT/,
      'skipProbe must prevent probeIpv6Reachability from ever calling net.connect',
    );
  } finally {
    server.kill('SIGKILL');
  }
});
