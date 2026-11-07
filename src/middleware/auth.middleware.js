const crypto = require('crypto');
const config = require('../config');
const { isAuthenticatedAdmin, validateCsrf, tokensMatch } = require('./adminSession.middleware');

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
 * Protects administrative operations with the admin token or admin session.
 * Supports:
 * - Authorization: Bearer <ADMIN_TOKEN>
 * - x-admin-token: <ADMIN_TOKEN>
 * - Admin session cookie (from browser login)
 */
function requireAdmin(req, res, next) {
  const authInfo = isAuthenticatedAdmin(req);
  if (!authInfo.authenticated) {
    return res.status(401).json({
      error: 'ADMIN_UNAUTHORIZED',
      message: 'Missing or invalid admin credentials.',
    });
  }

  // If authenticated via cookie, apply CSRF validation on mutating actions
  if (authInfo.method === 'cookie') {
    return validateCsrf(req, res, next);
  }

  next();
}

module.exports = { requireScreenshotToken, requireAdmin, tokensMatch };
