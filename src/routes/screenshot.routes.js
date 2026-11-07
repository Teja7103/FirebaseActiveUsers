const express = require('express');
const router = express.Router();
const screenshotService = require('../services/screenshot.service');
const { requireScreenshotToken } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimiter');
const { log } = require('../utils/logger');
const { AuthRequiredError, BrowserUnavailableError, ScreenshotError } = screenshotService;

router.get('/active-users', requireScreenshotToken, rateLimiter, async (req, res) => {
  try {
    const result = await screenshotService.captureActiveUsersScreenshot();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Screenshot-Cache', result.cached ? 'HIT' : 'MISS');
    if (result.capturedAt) res.setHeader('X-Last-Capture', String(result.capturedAt));
    log('info', 'Screenshot captured', { cached: result.cached });
    res.status(200).send(result.buffer);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return res.status(401).json({
        error: 'GOOGLE_AUTH_REQUIRED',
        message: 'Your Google session appears to have expired. Please re-authenticate.',
      });
    }
    if (err instanceof BrowserUnavailableError) {
      return res.status(503).json({
        error: 'BROWSER_UNAVAILABLE',
        message: 'Browser is temporarily unavailable.',
      });
    }
    if (err instanceof ScreenshotError) {
      return res.status(500).json({
        error: 'SCREENSHOT_FAILED',
        message: err.message,
      });
    }
    return res.status(500).json({ error: 'SCREENSHOT_FAILED', message: 'Unexpected error during screenshot capture.' });
  }
});

module.exports = router;
module.exports.rateLimiter = rateLimiter;
