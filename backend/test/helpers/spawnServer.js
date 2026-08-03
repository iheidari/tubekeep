// Shared "spawn the real server and drive it over HTTP" helper (0XC-275).
//
// `node --test` runs test FILES in parallel (one process per file, up to the
// CPU count), so any two files that spawn `src/server.js` on the same
// hand-picked port race for the bind. The loser either dies with EADDRINUSE
// and fails every request with ECONNREFUSED, or — worse — its /health poll
// succeeds against the OTHER file's server and it asserts against a process
// booted with different env (DATABASE_URL, FRONTEND_URL, YTDLP_FORCE_IPV4).
// That's a false pass, or a failure pointing at the wrong cause.
//
// The fix is to take the choice away: the child always binds PORT=0 (an
// OS-assigned ephemeral port) and reports back the port it actually got, read
// off its own startup line. No test file names a port, so none can collide —
// enforced by the drift guard in spawnServer.test.js.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_ENTRY = path.join(__dirname, '..', '..', 'src', 'server.js');

// server.js logs this from inside app.listen's callback using
// `server.address().port` — the port the OS actually bound, never the
// requested one. That's what makes PORT=0 legible from out here, and why
// spawnServer.test.js pins that contract at the source level: an echoed
// `process.env.PORT` would print `localhost:0`, and every spawn below would
// poll a dead port for the full BOOT_TIMEOUT_MS before throwing something that
// points nowhere near the cause.
const LISTENING_RE = /Server running on http:\/\/localhost:(\d+)/;

const BOOT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 2_000;

/**
 * Make a throwaway directory to spawn a child in, holding only the `.env` it
 * should see.
 *
 * server.js runs `dotenv.config()` against its cwd, so a child spawned in the
 * inherited cwd reads whatever real `backend/.env` this machine has. Deleting a
 * variable from the spawn `env` is not enough on its own — dotenv loads it
 * straight back off disk — so a test meaning to exercise an "unset
 * DATABASE_URL / FRONTEND_URL" path would silently assert against the real
 * values instead, and behave differently on a developer machine than in CI.
 *
 * @param {string} prefix `mkdtemp` prefix, e.g. `'tk-cors-'`.
 * @param {string} [contents] `.env` body. Empty (the default) means "configured
 *   with nothing"; pass a body when the `.env` load itself is under test.
 * @returns {string} Absolute path; pass it as `spawnServer`'s `cwd` and hand it
 *   to `removeScratchCwd` on teardown.
 */
function scratchCwd(prefix, contents = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, '.env'), contents);
  return dir;
}

/** Teardown counterpart to `scratchCwd`. A no-op if the dir was never made. */
function removeScratchCwd(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Spawn `src/server.js` as a child process on an ephemeral port and resolve
 * once it answers `/health`.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] Working directory for the child — a scratch dir
 *   from `scratchCwd`, when the `.env` body itself matters. Omit it and the
 *   helper makes its own empty-`.env` scratch dir and removes it on `cleanup()`;
 *   the child is never spawned in the inherited cwd.
 * @param {Record<string, string|undefined>} [options.env] Overrides merged over
 *   `process.env`. A key set to `undefined` is DELETED from the child's env —
 *   how a test exercises an "unset DATABASE_URL" style path.
 * @param {string[]} [options.execArgv] Extra `node` argv placed before the
 *   entry point (e.g. `['--require', spyPath]`).
 * @returns {Promise<{server: import('node:child_process').ChildProcess, port: number,
 *   base: string, stdout: () => string, stderr: () => string,
 *   kill: (signal?: string) => void, cleanup: (signal?: string) => void}>}
 *   Call `cleanup()` in teardown — it kills the child and removes the scratch
 *   dir the helper owns. `kill()` only does the former.
 * @throws If the child exits, fails to spawn, or never listens — with its
 *   captured stdout/stderr in the message, rather than an opaque timeout.
 */
async function spawnServer({ cwd, env: envOverrides = {}, execArgv = [] } = {}) {
  // Isolation is the default here, not opt-in. The port is mandatory but the
  // cwd used to be optional, and a child spawned in the inherited cwd has
  // dotenv load this machine's real backend/.env straight back over whatever
  // `env` just deleted — the same silent "asserted against the wrong config"
  // failure the fixed ports caused, one layer down. No drift guard can catch a
  // caller simply omitting an argument, so the default closes it instead.
  const ownedCwd = cwd === undefined ? scratchCwd('tk-spawn-server-') : null;

  // An `undefined` override deletes the variable — but PORT is exempt from
  // both halves of that: it's set last so a caller can't override it, and
  // skipped in the delete loop so a caller can't *unset* it either. Without
  // the exemption, `env: { PORT: undefined }` would strip it and the child
  // would fall back to server.js's hardcoded 3001 — reintroducing exactly the
  // fixed-port collision this helper exists to prevent.
  const env = { ...process.env, NODE_ENV: 'test', ...envOverrides, PORT: '0' };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined && key !== 'PORT') delete env[key];
  }

  const server = spawn('node', [...execArgv, SERVER_ENTRY], {
    cwd: cwd ?? ownedCwd,
    env,
    // stdout must be piped — it's how the bound port gets back here. stderr is
    // piped so a boot failure can be reported with its actual cause. Both are
    // consumed below, so the child can't block on a full pipe.
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

  let spawnError = null;
  let exited = null;
  server.on('error', (err) => {
    spawnError = err;
  });
  // `close`, not `exit`: exit can fire while the stdio pipes still hold unread
  // data, which would truncate — or empty — the very stderr this helper's
  // loud-failure reporting exists to surface. close is the drained-guaranteed
  // event.
  server.on('close', (code, signal) => {
    exited = { code, signal };
  });

  const bootFailure = (reason) => {
    server.kill('SIGKILL');
    removeScratchCwd(ownedCwd);
    return new Error(
      `${reason}\n--- child stderr ---\n${stderr || '(empty)'}\n--- child stdout ---\n${stdout || '(empty)'}`,
    );
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let port = null;

  while (Date.now() < deadline) {
    if (spawnError) {
      throw bootFailure(`Failed to spawn the test server: ${spawnError.message}`);
    }
    if (exited) {
      throw bootFailure(
        `Test server exited before it started listening (code ${exited.code}, signal ${exited.signal}).`,
      );
    }

    if (port === null) {
      const match = stdout.match(LISTENING_RE);
      if (match) port = Number(match[1]);
    }

    if (port !== null) {
      try {
        // The deadline is only checked at the top of the loop, so an
        // unbounded fetch that wedges would hang spawnServer past
        // BOOT_TIMEOUT_MS forever. `node --test` applies no hook timeout of
        // its own, so that lands as a hung CI job rather than a failure —
        // cap each probe instead.
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (res.ok) {
          return {
            server,
            port,
            base: `http://localhost:${port}`,
            stdout: () => stdout,
            stderr: () => stderr,
            kill: (signal = 'SIGKILL') => server.kill(signal),
            cleanup: (signal = 'SIGKILL') => {
              server.kill(signal);
              removeScratchCwd(ownedCwd);
            },
          };
        }
      } catch {
        // Listening but not answering yet.
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw bootFailure(`Test server did not start within ${BOOT_TIMEOUT_MS}ms.`);
}

module.exports = { spawnServer, scratchCwd, removeScratchCwd };
