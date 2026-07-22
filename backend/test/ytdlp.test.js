const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { runYtDlp, setForceIpv4 } = require('../src/services/ytdlp');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Write a throwaway executable that mimics a yt-dlp invocation and return its path.
function fakeBin(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-fake-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'fake-yt-dlp.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

// Regression for the "Downloaded file not found" bug on slow downloads:
// yt-dlp was spawned with a default 2-minute timeout that also applied to the
// download subprocess. When a real download outran it, the process was killed
// by the timeout signal (exit code === null), and the close handler treated that
// signal-kill as SUCCESS — so the caller went on to look for a finished file
// that was never written. A killed subprocess must reject, never resolve.
test('runYtDlp rejects when the subprocess is killed by the spawn timeout', async () => {
  // `exec` so the shell becomes sleep — the timeout signal then kills the leaf
  // process directly (no orphaned child holding the stdout pipe open).
  const bin = fakeBin('exec sleep 10'); // outruns the timeout below, produces no output
  await assert.rejects(
    () => runYtDlp(['--dump-json'], { binary: bin, timeout: 300 }),
    /terminated|SIGTERM|timed out/i,
    'a timeout-killed download must surface as an error, not resolve as success',
  );
});

test('runYtDlp resolves when the subprocess exits 0', async () => {
  const bin = fakeBin('echo ok; exit 0');
  const { stdout } = await runYtDlp(['--version'], { binary: bin, timeout: 5000 });
  assert.match(stdout, /ok/);
});

test('runYtDlp rejects when the subprocess exits non-zero', async () => {
  const bin = fakeBin('echo "boom" 1>&2; exit 1');
  await assert.rejects(
    () => runYtDlp(['--bad'], { binary: bin, timeout: 5000 }),
    /exited with code 1/i,
  );
});

// Regression for 0XC-126: setForceIpv4 is the seam server.js's boot-time IPv6
// probe uses to flip this on/off after the fact — confirm it actually reaches
// the spawned args, in both directions.
test('setForceIpv4(true) prepends --force-ipv4 to every yt-dlp invocation', async () => {
  const bin = fakeBin('echo "$@"');
  try {
    setForceIpv4(true);
    const { stdout } = await runYtDlp(['--dump-json'], { binary: bin, timeout: 5000 });
    assert.match(stdout, /--force-ipv4/);
  } finally {
    setForceIpv4(false);
  }
});

test('setForceIpv4(false) omits --force-ipv4', async () => {
  const bin = fakeBin('echo "$@"');
  setForceIpv4(false);
  const { stdout } = await runYtDlp(['--dump-json'], { binary: bin, timeout: 5000 });
  assert.doesNotMatch(stdout, /--force-ipv4/);
});
