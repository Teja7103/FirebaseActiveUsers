const express = require('express');
const path = require('path');
const screenshotRoutes = require('./routes/screenshot.routes');
const authRoutes = require('./routes/auth.routes');
const browserService = require('./services/browser.service');
const screenshotService = require('./services/screenshot.service');
const { log } = require('./utils/logger');
const config = require('./config');
const { requireAdmin } = require('./middleware/auth.middleware');
const { rateLimiter } = require('./middleware/rateLimiter');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (req, res) => {
  const browserAvailable = browserService.isBrowserAvailable();
  const lastCapture = screenshotService.getLastCaptureMeta();
  res.json({
    status: 'ok',
    browser: browserAvailable ? 'available' : 'unavailable',
    firebase: { dashboardUrl: config.firebase.dashboardUrl },
    lastCapture,
  });
});

app.get('/auth/status', async (req, res) => {
  const status = await require('./services/auth.service').getAuthStatus();
  res.json({
    authenticated: status.authenticated === true,
    reason: status.reason || null,
    source: status.source || null,
  });
});

app.post('/auth/start', requireAdmin, rateLimiter, async (req, res) => {
  const authService = require('./services/auth.service');
  try {
    const result = await authService.startAuthentication();
    log('info', 'Admin triggered Google re-authentication');
    res.json(result);
  } catch (err) {
    log('error', 'Admin Google re-authentication failed', { error: err.message });
    res.status(500).json({ error: 'AUTH_START_FAILED', message: err.message });
  }
});

app.use('/auth', authRoutes);
app.use('/screenshot', screenshotRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found.' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('error', 'Unhandled error', { error: err.message });
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
});

async function start() {
  // Best-effort restore of an encrypted session backup on boot.
  try {
    const fs = require('fs');
    const path = require('path');
    const authStatePath = path.resolve(process.cwd(), config.browser.authStateFile);
    if (!fs.existsSync(authStatePath) && config.security.sessionBackupPassphrase) {
      const { restoreAuthState } = require('./services/sessionBackup.service');
      restoreAuthState(config.security.sessionBackupPassphrase, authStatePath);
    }
  } catch (_) { /* best-effort */ }

  const server = app.listen(config.port, () => {
    log('info', `Firebase Active Users Screenshot service listening on port ${config.port}`);
  });

  const shutdown = async () => {
    log('info', 'Shutting down...');
    const { closeBrowserContext } = require('./services/browser.service');
    await closeBrowserContext();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

module.exports = { app, start };

start();
