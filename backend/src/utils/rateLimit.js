// Minimal in-memory sliding-window rate limiter — no external dependency.
// Each yt-dlp-spawning endpoint gets its own limiter so abuse of one (cheap
// subprocess spawns) can't exhaust the box. Fine for a single-instance app;
// swap for a shared store if this ever runs multi-instance.

function rateLimit({ windowMs = 60_000, max = 30, message = 'Too many requests' } = {}) {
  const hits = new Map(); // ip -> number[] (timestamps within the window)

  return (req, res, next) => {
    const now = Date.now();
    // Prefer CF-Connecting-IP as the primary signal: Cloudflare overwrites it
    // at its edge, so it's trustworthy even though X-Forwarded-For (what
    // req.ip resolves from once `trust proxy` is set — see server.js) is
    // client-supplied content Cloudflare *appends to* rather than replaces —
    // a request that never touched Cloudflare can walk in with an arbitrary
    // forged X-Forwarded-For chain. req.ip is the fallback for local dev and
    // any deploy that isn't behind Cloudflare, where no CF-Connecting-IP
    // header exists at all.
    const ip = req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';

    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: message });
    }

    recent.push(now);
    hits.set(ip, recent);

    // Opportunistically evict idle IPs so the map can't grow unbounded.
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(key);
      }
    }

    next();
  };
}

module.exports = { rateLimit };
