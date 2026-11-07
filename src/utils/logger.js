// Lightweight console logger that redacts sensitive keys from metadata objects.

const SENSITIVE_KEYS = new Set([
  'cookie',
  'cookies',
  'authorization',
  'auth',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'state',
  'credential',
  'liveURL',
  'liveUrl',
  'liveURLId',
  'interactiveUrl',
  'adminToken',
  'admin_token',
  'sessionBackupPassphrase',
  'csrfToken',
  'wsEndpoint',
]);

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  // Redact token/key/secret query parameters in URLs
  return str.replace(/([?&](?:token|key|secret|password)=)[^&]+/gi, '$1[REDACTED]');
}

function redact(value) {
  if (value === null || typeof value !== 'object') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

function log(level, message, meta) {
  const safeMessage = sanitizeString(message);
  const line = `[${new Date().toISOString()}] [${level}] ${safeMessage}${meta ? ` ${JSON.stringify(redact(meta))}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = { log, redact };
