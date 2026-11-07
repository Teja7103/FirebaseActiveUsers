const { getBrowserContext, launchContextForAuth, closeBrowserContext } = require('./browser.service');
const config = require('../config');
const { log } = require('../utils/logger');
const { backupAuthState } = require('./sessionBackup.service');
const fs = require('fs');

const GOOGLE_AUTH_ORIGIN = 'https://accounts.google.com/';

function isOnGoogleAuthFlow(url) {
  const u = new URL(url);
  const p = u.pathname;
  const isAuthPath = p.includes('/signin') || p.includes('/o/oauth') || p.includes('/passport');
  const isAccountsRoot =
    (u.hostname === 'accounts.google.com' || u.hostname === 'google.com') && (p === '/' || p === '');
  return isAuthPath || isAccountsRoot;
}

/**
 * Lightweight check: does the persisted Google session look authenticated?
 * Uses the shared persistent browser context (if already running).
 */
async function getAuthStatus() {
  try {
    const ctx = await getBrowserContext();
    const page = await ctx.newPage();
    try {
      await page.goto(GOOGLE_AUTH_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 15000 });
      let authenticated = false;
      try {
        await page.waitForURL((url) => !isOnGoogleAuthFlow(url), { timeout: 12000 });
        authenticated = true;
      } catch (_) {
        authenticated = false;
      }
      await page.close();
      return { authenticated, source: 'persistent-context' };
    } catch (err) {
      return { authenticated: false, reason: 'BROWSER_ERROR', message: err.message };
    }
  } catch (err) {
    return { authenticated: false, reason: 'BROWSER_UNAVAILABLE', message: 'Browser could not be launched.' };
  }
}

/**
 * Interactive re-authentication flow. Launches a headed persistent context,
 * waits for the user to complete Google sign-in + MFA, persists the state.
 */
async function startAuthentication() {
  const { closeBrowserContext, getBrowserContext } = require('./browser.service');
  await closeBrowserContext();
  const context = await launchContextForAuth();
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(GOOGLE_AUTH_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const timeoutMs = (config.auth.loginTimeoutSeconds + 30) * 1000;
    await page.waitForURL((url) => !isOnGoogleAuthFlow(url), { timeout: timeoutMs });
    const stateFile = require('path').resolve(process.cwd(), config.browser.authStateFile);
    await context.storageState({ path: stateFile });
    await context.close();
    // Keep an encrypted backup of the session state.
    if (config.security.sessionBackupPassphrase) {
      try { backupAuthState(stateFile ? fs.readFileSync(stateFile, 'utf8') : '{}', config.security.sessionBackupPassphrase); } catch (_) { /* backup is best-effort */ }
    }
    // Reopen the shared context for subsequent screenshot operations.
    await getBrowserContext();
    return { authenticated: true, savedState: stateFile };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

module.exports = { getAuthStatus, startAuthentication };
