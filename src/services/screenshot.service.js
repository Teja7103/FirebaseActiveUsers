const config = require('../config');
const { getBrowserContext, closeBrowserContext } = require('./browser.service');
const { log } = require('../utils/logger');

class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthRequiredError';
    this.statusCode = 401;
  }
}

class ScreenshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenshotError';
    this.statusCode = 500;
  }
}

class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.statusCode = 503;
  }
}

let cacheBuffer = null;
let cacheCapturedAt = null;

// Serialize screenshot operations: only one Playwright capture at a time.
let queue = Promise.resolve();
function enqueue(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function captureOnce() {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(config.firebase.dashboardUrl, {
      waitUntil: 'load',
      timeout: config.browser.navigationTimeout,
    });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // If redirected to Google accounts for an SSO handshake, allow it up to 15s to return to Firebase Console
    if (page.url().includes('accounts.google.com') && !page.url().includes('/signin') && !page.url().includes('/ServiceLogin')) {
      await page.waitForURL((url) => !url.href.includes('accounts.google.com'), { timeout: 15000 }).catch(() => {});
    }

    const currentUrl = page.url();
    const isLoginPage =
      currentUrl.includes('/signin') ||
      currentUrl.includes('/ServiceLogin') ||
      currentUrl.includes('/v3/signin') ||
      currentUrl.includes('/InteractiveLogin');

    if (isLoginPage) {
      try {
        require('./auth.service').markAuthExpired('FIREBASE_REDIRECT_TO_GOOGLE');
      } catch (_) { /* ignore */ }
      throw new AuthRequiredError(
        'Firebase session has expired. Please re-authenticate via /admin/auth.'
      );
    }

    const frame = page.frameLocator('iframe').first();
    const card = frame.locator(config.browser.cardSelector);
    let buffer;
    try {
      await card.waitFor({ state: 'visible', timeout: config.browser.cardWaitTimeout });
      buffer = await card.screenshot();
    } catch (selectorErr) {
      // Fallback text locator matching authenticate.js
      const textCard = frame.getByText(config.browser.cardText, { exact: false }).first();
      await textCard.waitFor({ state: 'visible', timeout: 30000 });
      buffer = await textCard.screenshot();
    }

    cacheBuffer = buffer;
    cacheCapturedAt = new Date().toISOString();
    return { buffer, cached: false, capturedAt: cacheCapturedAt };
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    throw new ScreenshotError(`Failed to capture Firebase Active Users card: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) { /* ignore */ }
  }
}

/**
 * Captures the latest screenshot. Falls back to the last successful capture
 * (marked as cached) when the live capture fails (e.g. transient browser issue).
 */
async function captureActiveUsersScreenshot() {
  return enqueue(async () => {
    try {
      const result = await captureOnce();
      return result;
    } catch (err) {
      if (cacheBuffer) {
        return {
          buffer: cacheBuffer,
          cached: true,
          capturedAt: cacheCapturedAt,
          error: err.message,
        };
      }
      throw err;
    }
  });
}

function getLastCaptureMeta() {
  return { lastCaptureAt: cacheCapturedAt, hasCachedCapture: Boolean(cacheBuffer) };
}

function resetCache() {
  cacheBuffer = null;
  cacheCapturedAt = null;
}

module.exports = { captureActiveUsersScreenshot, getLastCaptureMeta, resetCache, AuthRequiredError, ScreenshotError, BrowserUnavailableError };
