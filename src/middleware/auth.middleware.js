const crypto = require('crypto');
const config = require('../config');

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Protects screenshot endpoints with the application-level access token.
 * Expected header: Authorization: Bearer <SCREENSHOT_API_TOKEN>
 */
function requireScreenshotToken(req, res, next) {
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-access-token'];
  if (!provided || !tokensMatch(provided, config.security.screenshotApiToken)) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid API access token.',
    });
  }
  next();
}

/**
 * Protects administrative operations (e.g. POST /auth/start) with the admin token.
 * Expected header: Authorization: Bearer <ADMIN_TOKEN> (or x-admin-token).
 */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-admin-token'];
  if (!provided || !tokensMatch(provided, config.security.adminToken)) {
    return res.status(401).json({
      error: 'ADMIN_UNAUTHORIZED',
      message: 'Missing or invalid admin token.',
    });
  }
  next();
}

module.exports = { requireScreenshotToken, requireAdmin };
