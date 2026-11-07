require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- Phase 1 configuration (override via .env) ---
const USER_DATA_DIR = path.resolve(__dirname, '..', 'browser-profile');
const AUTH_STATE_FILE = path.resolve(__dirname, '..', 'google-auth-state.json');
const FIREBASE_DASHBOARD_URL =
  process.env.FIREBASE_DASHBOARD_URL ||
  'https://console.firebase.google.com/project/YOUR_PROJECT_ID/analytics';
const CARD_TEXT = process.env.ACTIVE_USERS_CARD_TEXT || 'Active Users';
const CARD_SELECTOR = process.env.ACTIVE_USERS_CARD_SELECTOR || 'ga-card[data-guidedhelpid="realtime"]';
const CARD_WAIT_TIMEOUT = parseInt(process.env.CARD_WAIT_TIMEOUT || '150000', 10);
const LOGIN_TIMEOUT_MS = (parseInt(process.env.LOGIN_WAIT_SECONDS || '180', 10) + 30) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.resolve(__dirname, '../screenshots'), { recursive: true });

  console.log('Launching Chromium with persistent profile at:', USER_DATA_DIR);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: parseInt(process.env.VIEWPORT_WIDTH || '1440', 10), height: parseInt(process.env.VIEWPORT_HEIGHT || '900', 10) },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser:error]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));

  console.log('Opening Google sign-in page...');
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  console.log(`\n>>> Waiting up to ${parseInt(process.env.LOGIN_WAIT_SECONDS || '180', 10) + 30}s for manual Google sign-in / MFA <<<`);
  console.log('>>> A Chromium window should be open. Sign in with your Google account.');
  console.log('>>> Complete MFA if prompted. Then this script will continue automatically.\n');

  // Wait until we are no longer on the Google sign-in / OAuth flow page.
  const isOnGoogleAuthFlow = (u) => {
    const url = new URL(u.href);
    const p = url.pathname;
    const isAuthPath = p.includes('/signin') || p.includes('/o/oauth') || p.includes('/passport');
    const isAccountsRoot =
      (url.hostname === 'accounts.google.com' || url.hostname === 'google.com') &&
      (p === '/' || p === '');
    return isAuthPath || isAccountsRoot;
  };

  try {
    await page.waitForURL((url) => !isOnGoogleAuthFlow(url), { timeout: LOGIN_TIMEOUT_MS });
  } catch (err) {
    console.error('Timed out waiting for Google sign-in. Aborting without saving state.');
    await context.close();
    process.exit(1);
  }

  await context.storageState({ path: AUTH_STATE_FILE });
  console.log('Google session state saved to:', AUTH_STATE_FILE);

  console.log('Navigating to Firebase Console dashboard:', FIREBASE_DASHBOARD_URL);
  await page.goto(FIREBASE_DASHBOARD_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  console.log('Current page URL after navigation:', page.url());

  // The Firebase Analytics dashboard renders inside an iframe (analytics.google.com),
  // so locate the card within that frame.
  const frame = page.frameLocator('iframe').first();
  const card = frame.locator(CARD_SELECTOR);
  try {
    await card.waitFor({ state: 'visible', timeout: CARD_WAIT_TIMEOUT });
    console.log('Active Users card located.');

    await card.screenshot({ path: path.resolve(__dirname, '../screenshots/active-users.png') });
    console.log('Screenshot saved to: screenshots/active-users.png');
    await context.close();
    process.exit(0);
  } catch (err) {
    // Fallback: text-based locator for the realtime card title.
    console.log('CSS card locator failed, trying text-based locator...');
    const textCard = frame.getByText('Active users in last 30 minutes', { exact: false }).first();
    try {
      await textCard.waitFor({ state: 'visible', timeout: 30000 });
      await textCard.screenshot({ path: path.resolve(__dirname, '../screenshots/active-users.png') });
      console.log('Screenshot saved via text locator: screenshots/active-users.png');
      await context.close();
      process.exit(0);
    } catch (err2) {
      console.error('Could not locate the Active Users card within timeout. Screenshot not saved.');
      console.error(err.message);
      console.error(err2.message);
      console.error('Page URL at failure:', page.url());
      console.error('Page title at failure:', await page.title());
      const gaCards = await frame.locator('ga-card').count();
      console.log('ga-card count in frame on page:', gaCards);
      const bodyText = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '(unavailable)');
      console.log('BODY TEXT (first 3000 chars):\n', bodyText.slice(0, 3000));
    }
  }

  await context.close();
  process.exit(0);
})();
