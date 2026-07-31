const net = require('node:net');

// A public, reliably-listening IPv6 host: Google Public DNS also answers
// DNS-over-TCP, so a plain TCP connect on port 53 works from any network with
// real IPv6 connectivity — no DNS resolution of our own needed first (which
// would add another network round-trip and its own failure modes). This is a
// proxy for "does yt-dlp's own IPv6 traffic get through", not a guarantee —
// a network that black-holes only port 53 while leaving 443 open would
// misclassify as blackholed (harmless: forces IPv4 needlessly), but a
// route-level black hole (the actual failure mode this targets) affects every
// port, so the reverse false-negative isn't a realistic concern.
const PROBE_HOST = '2001:4860:4860::8888';
const PROBE_PORT = 53;
const PROBE_TIMEOUT_MS = 2000;

// Attempt one IPv6 TCP connect and classify what happened. `connect` is
// injectable so tests never touch a real socket.
//   'reachable'  — connected before the timeout: real, working IPv6.
//   'no-route'   — the OS rejected the attempt immediately (no IPv6 default
//                  route at all — an ordinary IPv4-only machine; yt-dlp never
//                  even attempts an AAAA lookup here).
//   'blackholed' — neither connected nor errored before the timeout: a route
//                  exists but the packets vanish — the exact failure mode
//                  this module exists to detect (0XC-126).
function probeIpv6Reachability({
  host = PROBE_HOST,
  port = PROBE_PORT,
  timeoutMs = PROBE_TIMEOUT_MS,
  connect = (opts) => net.connect(opts),
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port, family: 6 });

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Deliberately NOT socket.removeAllListeners() here: an OS-delivered
      // connection error can still land just after the timeout fires, and an
      // 'error' event with zero listeners throws synchronously in Node —
      // crashing the whole boot sequence over a single probe socket. The
      // `once('error', ...)` below stays attached and self-removes after
      // firing; `settled` makes a late, redundant call a no-op either way.
      socket.destroy?.();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish('blackholed'), timeoutMs);

    socket.once('connect', () => finish('reachable'));
    socket.once('error', () => finish('no-route'));
  });
}

// Explicit YTDLP_FORCE_IPV4 always wins over the probe, in both directions:
// unset defers to the probe; any set value is authoritative ('true' → force
// on, anything else → force off), matching the flag's pre-existing semantics.
function readExplicitForceIpv4(env = process.env) {
  const raw = env.YTDLP_FORCE_IPV4;
  if (raw === undefined) return undefined;
  return raw === 'true';
}

// Resolve, once, whether yt-dlp calls should force IPv4 for this process.
// `skipProbe` lets the hermetic test suite (which must reach no real network)
// short-circuit to the safe default of `false` when there's no explicit
// override, instead of waiting out a real probe.
async function decideForceIpv4({
  env = process.env,
  probe = probeIpv6Reachability,
  skipProbe = false,
} = {}) {
  const explicit = readExplicitForceIpv4(env);
  if (explicit !== undefined) {
    // Log both directions, not just the forcing one: YTDLP_FORCE_IPV4 being
    // *set at all* — including a typo'd or stray value, which reads the same
    // as an intentional "false" — silently skips the probe below. Without a
    // log line here, "auto-detect decided false" and "override forced false"
    // are indistinguishable to an operator debugging a still-slow yt-dlp.
    console.log(
      explicit
        ? '🔧 yt-dlp: forcing IPv4 (YTDLP_FORCE_IPV4 override)'
        : '🔧 yt-dlp: not forcing IPv4 (YTDLP_FORCE_IPV4 override, skipping the boot probe)',
    );
    return explicit;
  }

  if (skipProbe) return false;

  // This is a best-effort auto-detection, not a required boot step — a probe
  // that throws (e.g. `connect` raising synchronously for an environment
  // reason) must never take the whole server down with it. Fall back to the
  // same safe default as an ambiguous outcome, and let the process boot.
  let outcome;
  try {
    outcome = await probe();
  } catch (err) {
    console.warn(
      `⚠️  yt-dlp: IPv6 probe failed unexpectedly (${err.message}) — leaving IPv4 unforced.`,
    );
    return false;
  }

  if (outcome === 'blackholed') {
    console.warn(
      '⚠️  yt-dlp: IPv6 route present but unreachable (boot probe timed out) — forcing IPv4 for this process. Set YTDLP_FORCE_IPV4=false to override.',
    );
    return true;
  }
  return false;
}

module.exports = {
  probeIpv6Reachability,
  readExplicitForceIpv4,
  decideForceIpv4,
};
