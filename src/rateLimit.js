// Limitation de débit (rate-limiting) en mémoire par adresse IP.

export function createRateLimiter({ windowMs = 60_000, maxRequests = 90, maxBuckets = 5000 } = {}) {
  const buckets = new Map();

  function prune(now) {
    if (buckets.size <= maxBuckets) return;
    for (const [k, entry] of buckets.entries()) {
      if (now >= entry.resetAt) buckets.delete(k);
    }
    if (buckets.size > maxBuckets) {
      const overflow = buckets.size - maxBuckets;
      let removed = 0;
      for (const k of buckets.keys()) {
        buckets.delete(k);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    const forwarded = req.headers?.['x-forwarded-for'];
    const rawIp =
      typeof forwarded === 'string' && forwarded.trim()
        ? forwarded.split(',')[0].trim()
        : req.ip || req.socket?.remoteAddress || 'unknown';
    const key = String(rawIp);
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      prune(now);
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (entry.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: 'Trop de requêtes. Veuillez patienter quelques secondes.',
      });
    }

    return next();
  };
}
