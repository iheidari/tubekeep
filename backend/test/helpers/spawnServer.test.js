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
//
// The rest of the file covers the parts of the returned contract the five
// migrated files depend on — `env` overrides (including the `undefined`
// deletion the "unset DATABASE_URL" tests need), `execArgv` passthrough, the
// captured stdout/stderr on a boot failure — plus the drift guards that keep
// the next spawn-based test file inside the helper.

const { test } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { spawnServer, scratchCwd, removeScratchCwd } = require('./spawnServer');

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
    removeScratchCwd(cwd);
  }
});

test('two servers running at once get distinct ports (the collision this replaces)', async () => {
  const cwdA = scratchCwd('tk-spawn-helper-a-');
  const cwdB = scratchCwd('tk-spawn-helper-b-');
  // allSettled, not all: `all` rejects on the first failure and drops the
  // other handle on the floor, leaking a live child whose piped stdio keeps
  // the runner's event loop open — so a genuine failure here would surface as
  // a hung suite instead of a red test.
  const [settledA, settledB] = await Promise.allSettled([
    spawnServer({ cwd: cwdA, env: { DATABASE_URL: undefined } }),
    spawnServer({ cwd: cwdB, env: { DATABASE_URL: undefined } }),
  ]);
  const a = settledA.value;
  const b = settledB.value;
  try {
    assert.ok(a && b, `both servers must boot (${settledA.reason ?? ''}${settledB.reason ?? ''})`);

    assert.notStrictEqual(a.port, b.port, 'concurrent servers must not share a port');

    // Both must be independently reachable — the pre-0XC-275 failure mode was
    // one server losing the bind while the other answered for both.
    for (const { base } of [a, b]) {
      const res = await fetch(`${base}/health`);
      assert.strictEqual(res.status, 200);
    }
  } finally {
    a?.server.kill('SIGKILL');
    b?.server.kill('SIGKILL');
    removeScratchCwd(cwdA);
    removeScratchCwd(cwdB);
  }
});

test('an explicit env override reaches the child', async () => {
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
    removeScratchCwd(cwd);
  }
});

// The half the "overrides reach the child" test above cannot see. Three of the
// five migrated files (cors-env, rateLimit-proxy, schema-boot) depend on this
// exact behavior to exercise an "unset FRONTEND_URL / DATABASE_URL" path while
// the developer running the suite has both set in their own environment. If
// the deletion silently stopped working, those files would quietly assert
// against a server booted with the real values and still pass.
//
// So this asserts the claim AND its premise: the same variable is proven to be
// inherited when it isn't overridden, so "the child didn't see it" can't be
// green because the child was never going to see it in the first place.
test('an `undefined` env value deletes a variable the child would otherwise inherit', async () => {
  const cwd = scratchCwd('tk-spawn-helper-unset-');
  const inherited = 'http://spawn-helper-inherited.test';
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = inherited;

  try {
    // Premise: with no override at all, the parent's FRONTEND_URL does reach
    // the child and pins CORS to it.
    const kept = await spawnServer({ cwd, env: { DATABASE_URL: undefined } });
    try {
      const res = await fetch(`${kept.base}/api/auth/me`, { headers: { Origin: inherited } });
      assert.strictEqual(
        res.headers.get('access-control-allow-origin'),
        inherited,
        'premise failed: the child should inherit FRONTEND_URL when it is not overridden',
      );
    } finally {
      kept.server.kill('SIGKILL');
    }

    // Claim: `undefined` removes it, so the child boots as if it were never set
    // (server.js falls back to `origin: false`, which emits no ACAO header).
    const dropped = await spawnServer({
      cwd,
      env: { DATABASE_URL: undefined, FRONTEND_URL: undefined },
    });
    try {
      const res = await fetch(`${dropped.base}/api/auth/me`, { headers: { Origin: inherited } });
      assert.strictEqual(
        res.headers.get('access-control-allow-origin'),
        null,
        'FRONTEND_URL: undefined must delete the inherited value, not pass it through',
      );
    } finally {
      dropped.server.kill('SIGKILL');
    }
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
    removeScratchCwd(cwd);
  }
});

// PORT is the one variable exempt from BOTH halves of the env contract above:
// a caller can neither override it nor delete it. The delete half is the
// non-obvious one — `PORT: undefined` used to strip the helper's own `PORT=0`,
// dropping the child onto server.js's hardcoded 3001 default and reintroducing
// the very fixed-port collision this helper exists to prevent. The drift guard
// below would catch a *test file* writing that, but the helper's invariant
// should hold on its own rather than resting on a lint-style scan.
test('PORT cannot be overridden or unset by a caller', async () => {
  const cwd = scratchCwd('tk-spawn-helper-port-');
  try {
    for (const override of [{ PORT: undefined }, { PORT: '3001' }]) {
      const { server, port } = await spawnServer({
        cwd,
        env: { DATABASE_URL: undefined, ...override },
      });
      try {
        assert.notStrictEqual(
          port,
          3001,
          `env ${JSON.stringify(override)} must not reach the child — the helper owns the port`,
        );
        const res = await fetch(`http://localhost:${port}/health`);
        assert.strictEqual(res.status, 200);
      } finally {
        server.kill('SIGKILL');
      }
    }
  } finally {
    removeScratchCwd(cwd);
  }
});

// execArgv is only used by ipv6-boot.test.js, and only to preload a `net.connect`
// spy whose assertion is a NEGATIVE one (`doesNotMatch(/IPV6_PROBE_CONNECT_ATTEMPT/)`).
// That makes a dropped execArgv invisible there: the preload would never load,
// the marker would never print, and the strongest assertion in that file would
// pass for the wrong reason. This is the positive control for it — a preload
// that prints a sentinel, asserted to actually appear in the child's stdout.
//
// It doubles as the only exercise of the returned handle's `kill()` (the five
// migrated files all reach for `server.kill()` instead), so the child is torn
// down through it and its exit awaited.
test('execArgv is passed to the child node process ahead of the entry point', async () => {
  const cwd = scratchCwd('tk-spawn-helper-execargv-');
  const preloadPath = path.join(cwd, 'preload.js');
  const sentinel = 'SPAWN_HELPER_PRELOAD_RAN';
  fs.writeFileSync(preloadPath, `console.log('${sentinel}');\n`);

  const { server, stdout, kill } = await spawnServer({
    cwd,
    env: { DATABASE_URL: undefined },
    execArgv: ['--require', preloadPath],
  });
  try {
    assert.match(
      stdout(),
      new RegExp(sentinel),
      'the --require preload never ran, so execArgv did not reach the child',
    );
  } finally {
    kill();
    await once(server, 'exit');
    removeScratchCwd(cwd);
  }
});

test("fails loudly with the child's stderr when the server can't boot", async () => {
  const cwd = scratchCwd('tk-spawn-helper-boom-');
  try {
    // NODE_ENV=production with no JWT_SECRET makes server.js throw at require
    // time — a deterministic boot failure. Before the helper this surfaced as a
    // 5s poll timeout into a bare "did not start in time" with no cause.
    //
    // The handle is captured rather than discarded: if the child ever DID boot,
    // an un-killed server's piped stdio would hold the runner's event loop open
    // and this assertion failure would present as a hung suite.
    let booted = null;
    await assert.rejects(
      async () => {
        booted = await spawnServer({
          cwd,
          env: { NODE_ENV: 'production', JWT_SECRET: undefined },
        });
      },
      (err) => {
        assert.match(err.message, /exited before it started listening/);
        assert.match(err.message, /JWT_SECRET is required in production/);
        return true;
      },
    );
    booted?.cleanup();
  } finally {
    removeScratchCwd(cwd);
  }
});

// ---------------------------------------------------------------------------
// Drift guards: the helper only prevents the collision if every test file that
// needs a real server actually goes through it.
// ---------------------------------------------------------------------------

const BACKEND_ROOT = path.join(__dirname, '..', '..');

// The one thing src/server.js owes the helper. `PORT=0` only becomes legible
// from out here because that log line reports `server.address().port` — the
// port the OS actually bound — rather than echoing the requested value.
//
// The behavioral tests above do catch a regression here, but expensively and
// opaquely: an echoed `PORT` prints `localhost:0`, the helper polls a port
// nothing is listening on, and every spawn-based test file dies 20s later with
// a bare "did not start within 20000ms" pointing nowhere near server.js. This
// turns that into an immediate, self-explaining failure.
test('src/server.js reports the bound port, not the requested one', () => {
  const source = stripComments(
    fs.readFileSync(path.join(BACKEND_ROOT, 'src', 'server.js'), 'utf8'),
  );

  const listeningLog = source.match(/Server running on http:\/\/localhost:\$\{([^}]+)\}/);
  assert.ok(
    listeningLog,
    'server.js must keep logging a `Server running on http://localhost:<port>` line — ' +
      'test/helpers/spawnServer.js parses it to learn where the child is listening',
  );
  assert.match(
    listeningLog[1],
    /address\(\)\.port/,
    'server.js must log `server.address().port` (the bound port). Echoing the requested ' +
      'PORT hands the helper a useless `0` and stalls every spawn-based test file for 20s',
  );
});

// Exempt from both scans below: the helper itself — which the corpus now does
// reach, since it scans every `.js` in this directory, and which names both the
// port and the entry point by design — and this file, which has to spell out
// the very shapes the scans look for in order to test them. Any other file
// added here needs a reason as good as those two.
const SCAN_EXEMPT = new Set([
  path.join(__dirname, 'spawnServer.js'),
  path.join(__dirname, 'spawnServer.test.js'),
]);

// Comments are stripped before any detector below runs, so prose about ports or
// about server.js can't trip a guard — only real code counts. The `[^:]` guard
// on the line-comment rule keeps `http://…` in real code from being mistaken
// for a comment start, which would silently truncate the rest of that line and
// hide whatever followed it from every scan.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// A spawn env entry (`PORT: '3993'`) or a per-file constant (`const PORT = 3993`),
// either of which is a hand-picked port that can collide with another file's.
// The optional quotes and `]` cover the forms a spawn env can equally well be
// written in — `{ 'PORT': '3993' }`, `env["PORT"] = …` — which a bare `\bPORT\b`
// would walk straight past. `[^=]` keeps a comparison
// (`process.env.PORT === '…'`) from matching.
function namesAPort(source) {
  return /['"]?\bPORT\b['"]?\]?\s*[:=][^=]/.test(stripComments(source));
}

// Naming a port is the symptom; spawning the server yourself is the disease. A
// file could `spawn('node', [… 'src/server.js'])` with no PORT at all and let
// it default to 3001 — no collision with a sibling test file, but a guaranteed
// one with a running dev server, and no ephemeral port either.
//
// Matched as a *module path* rather than a bare `includes('server.js')`: the
// extension is optional, since `require('../src/server')` boots the same
// hardcoded 3001 in-process and would otherwise slip through, and requiring the
// `src/` segment inside quotes stops an assertion message that merely mentions
// server.js from being a false positive.
function spawnsTheServerItself(source) {
  // `[/\\]+` rather than a single separator: a backslash path written in JS
  // source arrives here escaped (`"src\\server.js"`), so the literal text
  // carries two.
  return /['"][^'"]*\bsrc[/\\]+server(\.js)?['"]/.test(stripComments(source));
}

// The scan corpus: every `*.test.js` under backend/ (the spawn-based suites in
// `test/` and the colocated ones under `src/`), plus every `.js` under
// `test/helpers/` — a future shared boot helper is not a test file, so without
// that second rule it could hardcode a port or spawn the entry point with
// neither guard noticing. Read once, since all three scans share the corpus.
const HELPERS_DIR = __dirname;

function isScannable(full, name) {
  return name.endsWith('.test.js') || path.dirname(full) === HELPERS_DIR;
}

const SCANNED_TEST_FILES = (function collectScannedFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.js') &&
        isScannable(full, entry.name) &&
        !SCAN_EXEMPT.has(full)
      )
        found.push(full);
    }
  };
  walk(root);
  return found;
})(BACKEND_ROOT).map((full) => ({
  file: path.relative(BACKEND_ROOT, full),
  source: fs.readFileSync(full, 'utf8'),
}));

// Non-vacuity for the two scans below. Both assert an EMPTY offender list, so a
// walk that silently reached nothing — wrong root, a changed extension filter, a
// widened exemption — would make them pass while policing nothing at all.
test('the drift scan actually reaches the spawn-based test files', () => {
  const scanned = SCANNED_TEST_FILES.map(({ file }) => file);

  // The five files 0XC-275 migrated: if the scan can't see these, it can't
  // catch the next one that regresses.
  for (const file of [
    'test/cors-env.test.js',
    'test/api-cache.test.js',
    'test/schema-boot.test.js',
    'test/rateLimit-proxy.test.js',
    'test/ipv6-boot.test.js',
  ]) {
    assert.ok(scanned.includes(file), `the drift scan never visited ${file}`);
  }

  // It must reach the colocated `src/**/*.test.js` files too — a future
  // spawn-based test could land there rather than under test/.
  assert.ok(
    scanned.some((f) => f.startsWith(`src${path.sep}`)),
    'the drift scan never descended into src/, where colocated *.test.js files live',
  );

  // And every non-exempt `.js` in test/helpers/, not just `*.test.js`: the next
  // shared boot helper wouldn't be a test file, and is exactly the kind of place
  // a hardcoded port would reappear unnoticed.
  const helpersDir = path.relative(BACKEND_ROOT, HELPERS_DIR);
  assert.deepStrictEqual(
    fs
      .readdirSync(HELPERS_DIR)
      .filter((n) => n.endsWith('.js') && !SCAN_EXEMPT.has(path.join(HELPERS_DIR, n)))
      .filter((n) => !scanned.includes(path.join(helpersDir, n))),
    [],
    'the drift scan skipped a non-exempt .js file in test/helpers/',
  );
});

// Non-vacuity for the detectors themselves: an over-narrow regex that matched
// nothing would also report zero offenders forever.
test('the port detector flags a hand-picked port but not a process.env read', () => {
  assert.ok(namesAPort("const server = spawn('node', [entry], { env: { PORT: '3993' } });"));
  assert.ok(namesAPort('const PORT = 3993;'));
  // The quoted forms a spawn env can equally well be written in.
  assert.ok(namesAPort("spawn('node', [entry], { env: { 'PORT': '3993' } });"));
  assert.ok(namesAPort('env["PORT"] = \'3993\';'));

  assert.ok(!namesAPort('// Taken so far: 3989 cors-env, 3990 api-cache.'));
  assert.ok(!namesAPort('/* a block comment naming PORT = 3993 */'));
  assert.ok(!namesAPort("if (process.env.PORT === '3001') {}"));
  assert.ok(!namesAPort('const base = process.env.PORT;'));

  // A `//` inside a real code string must not be read as a comment start: doing
  // so truncates the rest of the line and hides anything after it from the scan.
  assert.ok(namesAPort("const base = 'http://localhost'; const PORT = 3993;"));
});

test('the direct-spawn detector flags spawning the server entry point itself', () => {
  assert.ok(spawnsTheServerItself("spawn('node', [path.join(__dirname, '../src/server.js')]);"));
  // The extension is optional: `require('../src/server')` boots the same
  // hardcoded 3001, in-process, and a bare `includes('server.js')` misses it.
  assert.ok(spawnsTheServerItself("const app = require('../src/server');"));
  assert.ok(spawnsTheServerItself('spawn("node", ["src\\\\server.js"]);'));

  assert.ok(
    !spawnsTheServerItself('// same pattern as schema-boot.test.js, which boots server.js'),
  );
  assert.ok(!spawnsTheServerItself("const { spawnServer } = require('./helpers/spawnServer');"));
  // A message that merely mentions the entry point is not a spawn — the bare
  // substring form flagged this, which is why a whole file needed exempting.
  assert.ok(!spawnsTheServerItself("assert.ok(ok, 'server.js must log the bound port');"));
});

// The guards themselves: the point of the helper is that the NEXT test file to
// spawn a server can't quietly reintroduce a hand-picked port. Only the helper
// may name a PORT, and only the helper may name the entry point.
for (const { title, detect, complaint } of [
  {
    title: 'no test file names a server PORT — only the helper does',
    detect: namesAPort,
    complaint: 'hardcode a server port instead of using test/helpers/spawnServer.js',
  },
  {
    title: 'no test file spawns the server itself — the helper is the only entry point',
    detect: spawnsTheServerItself,
    complaint: 'launch the server entry point directly instead of via test/helpers/spawnServer.js',
  },
]) {
  test(title, () => {
    const offenders = SCANNED_TEST_FILES.filter(({ source }) => detect(source)).map(
      ({ file }) => file,
    );

    assert.deepStrictEqual(offenders, [], `these test files ${complaint}: ${offenders.join(', ')}`);
  });
}
