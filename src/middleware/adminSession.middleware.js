const crypto = require('crypto');
const config = require('../config');

const COOKIE_NAME = 'admin_session';
const CSRF_COOKIE_NAME = 'admin_csrf';

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies = {};
  header.split(';').forEach((part) => {
    const [name, ...rest] = part.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  });
  return cookies;
}

function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const hmac = crypto
    .createHmac('sha256', config.admin.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${hmac}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, hmac] = parts;
  const expectedHmac = crypto
    .createHmac('sha256', config.admin.sessionSecret)
    .update(payload)
    .digest('base64url');

  const hmacBuf = Buffer.from(hmac);
  const expectedBuf = Buffer.from(expectedHmac);
  if (hmacBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(hmacBuf, expectedBuf)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function isRequestSecure(req) {
  return (
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production'
  );
}

function setAdminSession(res, req) {
  const exp = Date.now() + config.admin.sessionMaxAgeMs;
  const sessionToken = signSession({ authenticated: true, exp });
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const secureFlag = isRequestSecure(req) ? '; Secure' : '';

  // HttpOnly session cookie
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${sessionToken}; Path=/; Max-Age=${Math.floor(
      config.admin.sessionMaxAgeMs / 1000
    )}; HttpOnly; SameSite=Lax${secureFlag}`,
    `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/; Max-Age=${Math.floor(
      config.admin.sessionMaxAgeMs / 1000
    )}; SameSite=Lax${secureFlag}`,
  ]);

  return { sessionToken, csrfToken };
}

function clearAdminSession(res, req) {
  const secureFlag = isRequestSecure(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`,
    `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secureFlag}`,
  ]);
}

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Checks if the request is authenticated by Admin token (header or cookie).
 */
function isAuthenticatedAdmin(req) {
  // 1. Direct Bearer or x-admin-token
  const header = req.headers.authorization || '';
  const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const directToken = bearerToken || req.headers['x-admin-token'];
  if (directToken && tokensMatch(directToken, config.security.adminToken)) {
    return { authenticated: true, method: 'token' };
  }

  // 2. Query param ?token=...
  if (req.query && req.query.token && tokensMatch(req.query.token, config.security.adminToken)) {
    return { authenticated: true, method: 'query_token' };
  }

  // 3. Admin session cookie
  const cookies = parseCookies(req);
  const session = verifySession(cookies[COOKIE_NAME]);
  if (session && session.authenticated) {
    return { authenticated: true, method: 'cookie', csrfExpected: cookies[CSRF_COOKIE_NAME] };
  }

  return { authenticated: false };
}

/**
 * Validates CSRF token if authenticated via session cookie for state-changing requests.
 */
function validateCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  const authInfo = isAuthenticatedAdmin(req);
  if (!authInfo.authenticated) {
    return res.status(401).json({ error: 'ADMIN_UNAUTHORIZED', message: 'Missing or invalid admin credentials.' });
  }

  // If authenticated via token header, CSRF check is not needed (custom headers protect against browser cross-site forgery)
  if (authInfo.method === 'token') {
    return next();
  }

  // For cookie authentication, check CSRF header or body
  const csrfHeader = req.headers['x-csrf-token'];
  const csrfBody = req.body && req.body._csrf;
  const providedCsrf = csrfHeader || csrfBody;

  if (!providedCsrf || !authInfo.csrfExpected || !tokensMatch(providedCsrf, authInfo.csrfExpected)) {
    return res.status(403).json({
      error: 'CSRF_VALIDATION_FAILED',
      message: 'CSRF token is missing or invalid. Please refresh the page and try again.',
    });
  }

  next();
}

module.exports = {
  parseCookies,
  setAdminSession,
  clearAdminSession,
  isAuthenticatedAdmin,
  validateCsrf,
  tokensMatch,
};
