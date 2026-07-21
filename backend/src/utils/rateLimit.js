// Minimal in-memory sliding-window rate limiter — no external dependency.
// Each yt-dlp-spawning endpoint gets its own limiter so abuse of one (cheap
// subprocess spawns) can't exhaust the box. Fine for a single-instance app;
// swap for a shared store if this ever runs multi-instance.

function rateLimit({ windowMs = 60_000, max = 30, message = 'Too many requests' } = {}) {
  const hits = new Map(); // ip -> number[] (timestamps within the window)

  return (req, res, next) => {
    const now = Date.now();
    // Prefer CF-Connecting-IP: Cloudflare sets/overwrites this at its edge, so
    // it can't be spoofed by a client going through Cloudflare, and it's right
    // regardless of whether `trust proxy` matches the actual hop count. Falls
    // back to req.ip (correct once `trust proxy` is set — see server.js) for
    // local dev and any deploy not sitting behind Cloudflare.
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
