const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const { requireAdmin } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimiter');
const { log } = require('../utils/logger');

router.get('/status', async (req, res) => {
  const status = await authService.getAuthStatus();
  res.json({
    authenticated: status.authenticated === true,
    reason: status.reason || null,
    source: status.source || null,
  });
});

router.post('/start', requireAdmin, rateLimiter, async (req, res) => {
  try {
    const result = await authService.startAuthentication();
    log('info', 'Admin triggered Google re-authentication');
    res.json(result);
  } catch (err) {
    log('error', 'Admin Google re-authentication failed', { error: err.message });
    res.status(500).json({ error: 'AUTH_START_FAILED', message: err.message });
  }
});

module.exports = router;
module.exports.rateLimiter = rateLimiter;
