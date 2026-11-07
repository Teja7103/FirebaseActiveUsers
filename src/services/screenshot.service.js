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

    log('info', 'Page reached for capture', {
      currentUrl: page.url(),
      title: await page.title().catch(() => ''),
    });

    while (Date.now() - startTime < timeoutMs) {
      // Strategy: find the SMALLEST visible element that contains "30 minutes"
      // then walk up to its nearest card/widget ancestor with a reasonable bounding box.
      // This avoids matching huge ancestor containers that swallow the whole page.

      // 1a. Try the precise ga-card realtime data-attribute (most reliable)
      try {
        const realtimeCard = page.locator('[data-guidedhelpid="realtime"]').first();
        if (await realtimeCard.isVisible({ timeout: 1500 }).catch(() => false)) {
          targetCard = realtimeCard;
          log('info', 'Located Active Users card via data-guidedhelpid=realtime');
        }
      } catch (_) {}
      if (targetCard) break;

      // 1b. Find text leaf, then walk up to find a card-sized ancestor
      try {
        // getByText finds the innermost element with the text
        const textEl = page.getByText(/ACTIVE USERS IN LAST 30 MINUTES/i).first();
        if (await textEl.isVisible({ timeout: 1500 }).catch(() => false)) {
          // Walk up XPath to find nearest element >= 200px wide and >= 150px tall
          // that is smaller than the viewport width (excludes full-page containers)
          const cardAncestor = textEl.locator(
            'xpath=ancestor-or-self::*[self::ga-card or self::mat-card or ' +
            'contains(concat(" ",normalize-space(@class)," ")," card ") or ' +
            'contains(concat(" ",normalize-space(@class)," ")," widget ")][1]'
          ).first();
          if (await cardAncestor.isVisible({ timeout: 500 }).catch(() => false)) {
            const bbox = await cardAncestor.boundingBox().catch(() => null);
            if (bbox && bbox.width >= 150 && bbox.height >= 120 && bbox.width < 1200) {
              targetCard = cardAncestor;
              log('info', 'Located Active Users card via text ancestor walk', { w: bbox.width, h: bbox.height });
            }
          }
          if (!targetCard) {
            // Fallback: use the text element's parent (one level up)
            const parentEl = textEl.locator('xpath=..').first();
            const pbox = await parentEl.boundingBox().catch(() => null);
            if (pbox && pbox.width >= 150 && pbox.height >= 50) {
              targetCard = parentEl;
              log('info', 'Located Active Users card via text parent');
            } else {
              targetCard = textEl;
              log('info', 'Using text element itself as card target');
            }
          }
        }
      } catch (_) {}
      if (targetCard) break;

      // 1c. Broader "30 minutes" text search — find smallest matching element
      try {
        const els = page.locator('h2, h3, h4, span, p, div.card-title, div.metric-label')
          .filter({ hasText: /30 minutes/i });
        const count = await els.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = els.nth(i);
          if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
            const bbox = await el.boundingBox().catch(() => null);
            if (bbox && bbox.width < 1000) { // skip full-width containers
              // Walk up to card ancestor
              const cardAncestor = el.locator(
                'xpath=ancestor-or-self::*[self::ga-card or self::mat-card or ' +
                'contains(concat(" ",normalize-space(@class)," ")," card ")][1]'
              ).first();
              if (await cardAncestor.isVisible({ timeout: 300 }).catch(() => false)) {
                const cbox = await cardAncestor.boundingBox().catch(() => null);
                if (cbox && cbox.width >= 150 && cbox.width < 1200) {
                  targetCard = cardAncestor;
                  log('info', 'Located Active Users card via broader search', { w: cbox.width, h: cbox.height });
                  break;
                }
              }
              targetCard = el;
              log('info', 'Using 30-minutes label element as target');
              break;
            }
          }
        }
      } catch (_) {}
      if (targetCard) break;

      // 2. Search inside frames
      for (const frame of page.frames()) {
        try {
          const frameEl = frame.getByText(/30 minutes/i).first();
          if (await frameEl.isVisible({ timeout: 500 }).catch(() => false)) {
            const box = frameEl.locator('xpath=ancestor-or-self::*[contains(@class, "card") or self::ga-card][1]').first();
            targetCard = (await box.isVisible({ timeout: 500 }).catch(() => false)) ? box : frameEl;
            log('info', 'Located Active Users card inside frame');
            break;
          }
        } catch (_) {}
      }
      if (targetCard) break;

      await page.waitForTimeout(1500);
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
