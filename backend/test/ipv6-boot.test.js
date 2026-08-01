// Regression guard for 0XC-126 ("Auto-detect black-holed IPv6"). server.js's
// boot sequence now runs `ensureIpv4Decision()` (services/ipv6.js's
// decideForceIpv4) alongside ensureSchema() before app.listen(). That decision
// must never touch the real network in the test suite (hermetic — same
// reasoning as schema-boot.test.js's DATABASE_URL skip), and an explicit
// YTDLP_FORCE_IPV4 must still reach all the way through boot.
//
// Spawn the real server as a child process (same pattern as schema-boot.test.js
// / cors-env.test.js) and confirm both directions: the skip is proven directly
// via a `net.connect`-spying preload script (written into the scratch tmpDir
// below, not committed — it must not be picked up as its own test file by
// node --test's directory-based discovery) that the probe made zero connection
// attempts — a boot-time sanity check alone can't tell "skipped" apart from
// "ran and happened to resolve fast" (e.g. an immediate 'no-route' rejection).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The port is the helper's business, not this file's: it spawns the server on
// an OS-assigned ephemeral port and reads back the one actually bound. This
// file is why that helper exists — it was written on 3993, the port
// rateLimit-proxy.test.js already used, and the two raced for the bind under
// `node --test`'s per-file parallelism. That was caught during PR #33's review
// and patched by moving to 3994, so `main` never carried the collision — but a
// hand-picked port is a trap the next author springs again, which is what
// 0XC-275 replaced with the helper.
const { spawnServer, scratchCwd, removeScratchCwd } = require('./helpers/spawnServer');

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
  tmpDir = scratchCwd('tk-ipv6-boot-');

  // Written into the scratch tmpDir (outside the repo, so it can never be
  // picked up by node --test's own directory-based file discovery) rather
  // than committed under test/ as its own file.
  connectSpyPath = path.join(tmpDir, 'ipv6ConnectSpy.js');
  fs.writeFileSync(connectSpyPath, CONNECT_SPY_SOURCE);
});

after(() => {
  removeScratchCwd(tmpDir);
});

function bootServer(extraEnv, execArgv = []) {
  return spawnServer({
    cwd: tmpDir,
    // DATABASE_URL is deleted LAST, after extraEnv, so a caller can't reinstate
    // it by accident — the hermetic-suite guarantee must not depend on what a
    // particular test passes in. (Pre-0XC-275 this file spread extraEnv first
    // and then `delete env.DATABASE_URL`, i.e. the same unconditional order.)
    env: { ...extraEnv, DATABASE_URL: undefined },
    execArgv,
  });
}

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
