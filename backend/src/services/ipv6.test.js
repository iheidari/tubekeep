const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { probeIpv6Reachability, readExplicitForceIpv4, decideForceIpv4 } = require('./ipv6');

// A fake `net.connect`-shaped socket the tests drive by hand, so the probe
// never opens a real socket. `behavior` decides what happens after connect():
// 'connect' emits success synchronously-ish (next tick), 'error' emits an
// immediate connection error, 'hang' never emits anything (the black-holed
// case) so the probe's own timeout must be what resolves it.
function fakeConnect(behavior) {
  return () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    if (behavior === 'connect') {
      queueMicrotask(() => socket.emit('connect'));
    } else if (behavior === 'error') {
      queueMicrotask(() => socket.emit('error', new Error('ENETUNREACH')));
    }
    // 'hang': emit nothing — the caller's timeoutMs must fire instead.
    return socket;
  };
}

test('probeIpv6Reachability resolves "reachable" when the socket connects', async () => {
  const outcome = await probeIpv6Reachability({ connect: fakeConnect('connect'), timeoutMs: 50 });
  assert.equal(outcome, 'reachable');
});

test('probeIpv6Reachability resolves "no-route" when the socket errors immediately', async () => {
  const outcome = await probeIpv6Reachability({ connect: fakeConnect('error'), timeoutMs: 50 });
  assert.equal(outcome, 'no-route');
});

test('probeIpv6Reachability resolves "blackholed" when nothing happens before the timeout', async () => {
  const outcome = await probeIpv6Reachability({ connect: fakeConnect('hang'), timeoutMs: 20 });
  assert.equal(outcome, 'blackholed');
});

test('readExplicitForceIpv4 is undefined when YTDLP_FORCE_IPV4 is unset', () => {
  assert.equal(readExplicitForceIpv4({}), undefined);
});

test('readExplicitForceIpv4 is true only for the exact string "true"', () => {
  assert.equal(readExplicitForceIpv4({ YTDLP_FORCE_IPV4: 'true' }), true);
  assert.equal(readExplicitForceIpv4({ YTDLP_FORCE_IPV4: 'false' }), false);
  assert.equal(readExplicitForceIpv4({ YTDLP_FORCE_IPV4: '1' }), false);
});

let logs;
let warns;
let originalLog;
let originalWarn;

beforeEach(() => {
  logs = [];
  warns = [];
  originalLog = console.log;
  originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => warns.push(args.join(' '));
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
});

test('decideForceIpv4 returns true on an explicit override without probing', async () => {
  let probed = false;
  const result = await decideForceIpv4({
    env: { YTDLP_FORCE_IPV4: 'true' },
    probe: () => {
      probed = true;
      return Promise.resolve('reachable');
    },
  });
  assert.equal(result, true);
  assert.equal(probed, false, 'an explicit override must skip the probe entirely');
  assert.ok(logs.some((l) => l.includes('forcing IPv4')));
});

test('decideForceIpv4 returns false on an explicit override without probing', async () => {
  let probed = false;
  const result = await decideForceIpv4({
    env: { YTDLP_FORCE_IPV4: 'false' },
    probe: () => {
      probed = true;
      return Promise.resolve('blackholed');
    },
  });
  assert.equal(result, false, 'an explicit false must win even if the probe would force IPv4');
  assert.equal(probed, false);
});

test('decideForceIpv4 skips the probe and defaults to false when skipProbe is set', async () => {
  let probed = false;
  const result = await decideForceIpv4({
    env: {},
    skipProbe: true,
    probe: () => {
      probed = true;
      return Promise.resolve('blackholed');
    },
  });
  assert.equal(result, false);
  assert.equal(probed, false);
});

test('decideForceIpv4 defers to the probe when unset: "reachable" does not force IPv4', async () => {
  const result = await decideForceIpv4({ env: {}, probe: () => Promise.resolve('reachable') });
  assert.equal(result, false);
});

test('decideForceIpv4 defers to the probe when unset: "no-route" does not force IPv4', async () => {
  const result = await decideForceIpv4({ env: {}, probe: () => Promise.resolve('no-route') });
  assert.equal(result, false);
});

test('decideForceIpv4 defers to the probe when unset: "blackholed" forces IPv4 and logs why', async () => {
  const result = await decideForceIpv4({ env: {}, probe: () => Promise.resolve('blackholed') });
  assert.equal(result, true);
  assert.ok(warns.some((w) => w.includes('forcing IPv4')));
});

// This is best-effort auto-detection, not a required boot step — a probe that
// rejects (rather than resolving to one of the three known outcomes) must
// never propagate and take the whole boot sequence down with it.
test('decideForceIpv4 falls back to false and logs a warning when the probe itself rejects', async () => {
  const result = await decideForceIpv4({
    env: {},
    probe: () => Promise.reject(new Error('boom')),
  });
  assert.equal(result, false);
  assert.ok(warns.some((w) => w.includes('probe failed unexpectedly')));
});
