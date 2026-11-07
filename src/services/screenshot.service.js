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

    // Find Active Users card on page or in iframe
    let targetCard = null;
    const startTime = Date.now();
    const timeoutMs = config.browser.cardWaitTimeout;

    while (Date.now() - startTime < timeoutMs) {
      // 1. Direct page search: container with "30 minutes" and realtime details
      try {
        const card = page
          .locator('ga-card, mat-card, section, div')
          .filter({ hasText: /active users in last 30 minutes|users in last 30 minutes/i })
          .filter({ hasText: /per minute|view realtime|top countries/i })
          .last();

        if (await card.isVisible({ timeout: 1000 }).catch(() => false)) {
          targetCard = card;
          log('info', 'Located Active Users card on main page');
          break;
        }
      } catch (_) {}

      // 2. Direct page search by title and ancestor
      try {
        const heading = page.getByText(/active users in last 30 minutes/i).first();
        if (await heading.isVisible({ timeout: 1000 }).catch(() => false)) {
          const ancestor = heading
            .locator('xpath=ancestor::*[contains(@class, "card") or contains(@class, "widget") or self::ga-card or self::mat-card][1]')
            .first();
          targetCard = (await ancestor.isVisible({ timeout: 500 }).catch(() => false)) ? ancestor : heading;
          log('info', 'Located Active Users card via heading ancestor on main page');
          break;
        }
      } catch (_) {}

      // 3. Search inside any iframes
      for (const frame of page.frames()) {
        try {
          const card = frame
            .locator('ga-card, mat-card, section, div')
            .filter({ hasText: /active users in last 30 minutes|users in last 30 minutes/i })
            .filter({ hasText: /per minute|view realtime|top countries/i })
            .last();

          if (await card.isVisible({ timeout: 500 }).catch(() => false)) {
            targetCard = card;
            log('info', 'Located Active Users card inside iframe');
            break;
          }
        } catch (_) {}

        try {
          const heading = frame.getByText(/active users in last 30 minutes/i).first();
          if (await heading.isVisible({ timeout: 500 }).catch(() => false)) {
            const ancestor = heading
              .locator('xpath=ancestor::*[contains(@class, "card") or contains(@class, "widget") or self::ga-card or self::mat-card][1]')
              .first();
            targetCard = (await ancestor.isVisible({ timeout: 500 }).catch(() => false)) ? ancestor : heading;
            break;
          }
        } catch (_) {}
      }
      if (targetCard) break;

      await page.waitForTimeout(1000);
    }

    if (!targetCard) {
      throw new Error('Active Users in last 30 minutes card was not found on the page within timeout.');
    }

    const buffer = await targetCard.screenshot();

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
