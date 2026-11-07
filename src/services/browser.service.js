const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log } = require('../utils/logger');

let sharedBrowser = null;
let sharedContext = null;
let contextPromise = null;
let cachedStorageState = null;

function getStorageState() {
  if (cachedStorageState) return cachedStorageState;
  try {
    const stateFile = path.resolve(process.cwd(), config.browser.authStateFile);
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      cachedStorageState = JSON.parse(raw);
      return cachedStorageState;
    }
  } catch (err) {
    log('warn', 'Failed to read storage state from file', { error: err.message });
  }
  return null;
}

function setStorageState(state) {
  cachedStorageState = state;
  try {
    const stateFile = path.resolve(process.cwd(), config.browser.authStateFile);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const content = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
    fs.writeFileSync(stateFile, content, 'utf8');
    log('info', 'Updated storageState saved to disk and memory cache');
  } catch (err) {
    log('warn', 'Failed to write storage state to disk', { error: err.message });
  }
}

const DEFAULT_CHROME_ARGS = [
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
  '--window-size=1440,900',
];

/**
 * Checks if Browserless remote connection is configured via env.
 */
function isBrowserlessConfigured() {
  return Boolean(config.browserless.wsEndpoint || config.browserless.url);
}

/**
 * Resolves the WebSocket endpoint for Browserless.
 */
function getBrowserlessWsEndpoint() {
  if (config.browserless.wsEndpoint) {
    return config.browserless.wsEndpoint.trim();
  }
  if (config.browserless.url) {
    let u = config.browserless.url.trim();
    if (u.startsWith('https://')) {
      u = 'wss://' + u.slice(8);
    } else if (u.startsWith('http://')) {
      u = 'ws://' + u.slice(7);
    } else if (!u.startsWith('wss://') && !u.startsWith('ws://')) {
      u = 'wss://' + u;
    }
    // Append token if configured and not present in url query
    if (config.browserless.token && !u.includes('token=')) {
      const sep = u.includes('?') ? '&' : '?';
      u = `${u}${sep}token=${encodeURIComponent(config.browserless.token)}`;
    }
    // Append keepalive timeout (10 minutes) if not configured
    if (!u.includes('timeout=')) {
      const sep = u.includes('?') ? '&' : '?';
      u = `${u}${sep}timeout=600000`;
    }
    return u;
  }
  return null;
}

/**
 * Rewrites the Browserless live URL if a public hostname is configured.
 */
function resolvePublicLiveUrl(rawLiveUrl) {
  if (!rawLiveUrl) return null;
  if (!config.browserless.publicUrl) return rawLiveUrl;
  try {
    const rawParsed = new URL(rawLiveUrl);
    const pubParsed = new URL(config.browserless.publicUrl);
    rawParsed.protocol = pubParsed.protocol;
    rawParsed.host = pubParsed.host;
    rawParsed.port = pubParsed.port;
    return rawParsed.toString();
  } catch (_) {
    return rawLiveUrl;
  }
}

/**
 * Hydrates cookies from the persisted storage state file into the browser context.
 */
async function hydrateCookiesFromStateFile(ctx) {
  try {
    const stateFile = path.resolve(process.cwd(), config.browser.authStateFile);
    if (fs.existsSync(stateFile)) {
      const stateContent = fs.readFileSync(stateFile, 'utf8');
      const stateData = JSON.parse(stateContent);
      if (Array.isArray(stateData.cookies) && stateData.cookies.length > 0) {
        await ctx.addCookies(stateData.cookies);
        log('info', `Hydrated ${stateData.cookies.length} cookies from storage state file into context`);
      }
    }
  } catch (err) {
    log('warn', 'Failed to hydrate cookies from storage state file', { error: err.message });
  }
}

/**
 * Lazily connects to or launches the centralized shared browser context.
 * Reuses the single authenticated session across all requests.
 */
async function getBrowserContext() {
  if (sharedContext) {
    return sharedContext;
  }

  if (!contextPromise) {
    contextPromise = (async () => {
      const wsEndpoint = getBrowserlessWsEndpoint();
      if (wsEndpoint) {
        log('info', 'Connecting to remote Browserless instance via CDP');
        const browser = await chromium.connectOverCDP(wsEndpoint, {
          timeout: config.browser.navigationTimeout,
        });
        sharedBrowser = browser;

        browser.on('disconnected', () => {
          log('warn', 'Remote Browserless connection disconnected. Resetting context reference.');
          sharedBrowser = null;
          sharedContext = null;
          contextPromise = null;
        });

        // Initialize a new browser context with full storageState (both cookies AND localStorage)
        const state = getStorageState();
        const ctxOptions = {
          viewport: config.browser.viewport,
        };
        if (state) {
          ctxOptions.storageState = state;
          log('info', 'Initialized Browserless context with persistent storageState (cookies & localStorage)');
        }

        const ctx = await browser.newContext(ctxOptions);
        ctx.on('close', () => {
          log('info', 'Shared Browserless context closed. Clearing reference.');
          sharedContext = null;
        });

        sharedContext = ctx;
        log('info', 'Remote Browserless context ready for screenshot operations');
        return ctx;
      }

      // Fallback: Local persistent Chromium context
      log('info', 'Launching local Chromium persistent context', { profileDir: config.browser.profileDir });
      fs.mkdirSync(config.browser.profileDir, { recursive: true });
      const ctx = await chromium.launchPersistentContext(config.browser.profileDir, {
        headless: config.browser.headless,
        viewport: config.browser.viewport,
        args: DEFAULT_CHROME_ARGS,
      });

      ctx.on('close', () => {
        log('warn', 'Local browser context closed. Resetting context reference.');
        sharedContext = null;
        contextPromise = null;
      });

      await hydrateCookiesFromStateFile(ctx);
      sharedContext = ctx;
      log('info', 'Local browser context ready');
      return ctx;
    })().catch((err) => {
      sharedBrowser = null;
      sharedContext = null;
      contextPromise = null;
      throw err;
    });
  }

  return contextPromise;
}

/**
 * Creates an interactive page for administrator Google authentication.
 * Uses Browserless.liveURL over CDP when running with Browserless.
 */
async function createInteractivePage() {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  let cdp = null;
  let liveURL = null;
  let liveURLId = null;
  let liveTimeout = config.browserless.liveTimeoutMs;

  const isRemote = isBrowserlessConfigured();

  if (isRemote) {
    try {
      cdp = typeof page.createCDPSession === 'function'
        ? await page.createCDPSession()
        : await ctx.newCDPSession(page);

      const liveRes = await cdp.send('Browserless.liveURL', {
        interactable: true,
        timeout: config.browserless.liveTimeoutMs,
        quality: 80,
        resizable: true,
        showBrowserInterface: true,
        instructions:
          'Sign in to Google with your administrator account, complete MFA / 2FA, then return to the admin portal.',
      });

      liveURL = resolvePublicLiveUrl(liveRes.liveURL);
      liveURLId = liveRes.liveURLId;
      if (liveRes.timeout) liveTimeout = liveRes.timeout;
      log('info', 'Browserless interactive live URL minted');
    } catch (err) {
      log('error', 'Failed to generate Browserless liveURL via CDP', { error: err.message });
      await page.close().catch(() => {});
      throw new Error(`Browserless Live URL generation failed: ${err.message}`);
    }
  }

  return {
    page,
    cdp,
    liveURL,
    liveURLId,
    timeout: liveTimeout,
    isRemote,
  };
}

/**
 * Revokes or closes an active Browserless live URL via CDP.
 */
async function closeLiveURL(cdp, liveURLId) {
  if (!cdp || !liveURLId) return;
  try {
    await cdp.send('Browserless.closeLiveURL', { liveURLId });
    log('info', 'Browserless live URL revoked');
  } catch (err) {
    log('warn', 'Could not revoke live URL via CDP (may have already closed or timed out)', {
      error: err.message,
    });
  }
}

/**
 * Shuts down browser context and connections cleanly.
 */
async function closeBrowserContext() {
  if (sharedContext) {
    try {
      await sharedContext.close();
    } catch (_) { /* ignore */ }
    sharedContext = null;
  }
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch (_) { /* ignore */ }
    sharedBrowser = null;
  }
  contextPromise = null;
}

/**
 * Backwards compatible launch for legacy auth scripts.
 */
async function launchContextForAuth() {
  return getBrowserContext();
}

/**
 * Checks if browser runtime is available (either Browserless or local Chromium).
 */
function isBrowserAvailable() {
  if (isBrowserlessConfigured()) {
    return true;
  }
  try {
    const exe = chromium.executablePath();
    return Boolean(exe);
  } catch (_) {
    return false;
  }
}

module.exports = {
  getBrowserContext,
  createInteractivePage,
  closeLiveURL,
  closeBrowserContext,
  launchContextForAuth,
  isBrowserAvailable,
  isBrowserlessConfigured,
  getBrowserlessWsEndpoint,
  resolvePublicLiveUrl,
  getStorageState,
  setStorageState,
};
