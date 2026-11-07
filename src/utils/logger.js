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
]);

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

function log(level, message, meta) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${meta ? ` ${JSON.stringify(redact(meta))}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = { log, redact };
