const { chromium } = require('playwright');
const config = require('../config');
const { log } = require('../utils/logger');

let contextPromise = null;

/**
 * Lazily creates and memoizes a Playwright browser context backed by the
 * persistent browser profile (cookies survive restarts).
 */
function getBrowserContext() {
  if (!contextPromise) {
    contextPromise = chromium
      .launchPersistentContext(config.browser.profileDir, {
        headless: config.browser.headless,
        viewport: config.browser.viewport,
        args: [
          '--disable-field-trial-config',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-back-forward-cache',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-extensions-with-background-pages',
          '--disable-component-update',
          '--no-default-browser-check',
          '--disable-default-apps',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding,ThirdPartyStoragePartitioning,LensOverlay,PlzDedicatedWorker',
          '--allow-pre-commit-input',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--no-first-run',
          '--enable-automation',
          '--password-store=basic',
          '--use-mock-keychain',
          '--no-service-autorun',
          '--export-tagged-pdf',
          '--disable-search-engine-choice-screen',
          '--unsafely-disable-devtools-self-xss-warnings',
          '--enable-use-zoom-for-dsf=false',
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1440,900',
        ],
      })
      .then((ctx) => {
        log('info', 'Browser context ready', { profileDir: config.browser.profileDir });
        return ctx;
      })
      .catch((err) => {
        contextPromise = null; // allow retry on next call
        throw err;
      });
  }
  return contextPromise;
}

/**
 * Launches a fresh (headed-capable) browser context for interactive flows
 * such as /auth/start. Does not touch the shared context.
 */
async function launchContextForAuth() {
  return chromium.launchPersistentContext(config.browser.profileDir, {
    headless: false,
    viewport: config.browser.viewport,
    args: [
      '--disable-field-trial-config',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-back-forward-cache',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-component-update',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding,ThirdPartyStoragePartitioning,LensOverlay,PlzDedicatedWorker',
      '--allow-pre-commit-input',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--no-first-run',
      '--enable-automation',
      '--password-store=basic',
      '--use-mock-keychain',
      '--no-service-autorun',
      '--export-tagged-pdf',
      '--disable-search-engine-choice-screen',
      '--unsafely-disable-devtools-self-xss-warnings',
      '--enable-use-zoom-for-dsf=false',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
    ],
  });
}

async function closeBrowserContext() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  if (ctx) {
    try { await ctx.close(); } catch (_) { /* ignore */ }
  }
}

function isBrowserAvailable() {
  try {
    const exe = chromium.executablePath();
    // Headless chromium needs a runtime; existence check is enough for health.
    return Boolean(exe);
  } catch (_) {
    return false;
  }
}

module.exports = { getBrowserContext, launchContextForAuth, closeBrowserContext, isBrowserAvailable };
