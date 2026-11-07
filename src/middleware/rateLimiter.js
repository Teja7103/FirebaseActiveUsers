const config = require('../config');

// Simple in-memory fixed-window rate limiter (per IP).
const hits = new Map();

function rateLimiter(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  let entry = hits.get(key);
  if (!entry || now - entry.start >= config.security.rateLimit.windowMs) {
    entry = { start: now, count: 0 };
    hits.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > config.security.rateLimit.max) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.start + config.security.rateLimit.windowMs - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many screenshot requests. Please try again later.' });
  }
  next();
}

module.exports = { rateLimiter };
