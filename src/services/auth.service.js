const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const browserService = require('./browser.service');
const { log } = require('../utils/logger');
const { backupAuthState } = require('./sessionBackup.service');

const GOOGLE_AUTH_ORIGIN = 'https://accounts.google.com/';

let activeSession = null;
let lastAuthState = {
  authenticated: null,
  verifiedAt: null,
  reason: null,
  source: null,
};

function isOnGoogleAuthFlow(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = u.pathname;
    const isAuthPath =
      p.includes('/signin') ||
      p.includes('/o/oauth') ||
      p.includes('/passport') ||
      p.includes('/ServiceLogin') ||
      p.includes('/v3/signin');
    const isAccountsRoot =
      (u.hostname === 'accounts.google.com' || u.hostname === 'google.com') &&
      (p === '/' || p === '');
    return isAuthPath || isAccountsRoot;
  } catch (_) {
    return false;
  }
}

/**
 * Checks current Google & Firebase Console authentication status.
 */
async function getAuthStatus() {
  // If an interactive session is currently in progress, report status
  if (activeSession && activeSession.status === 'ready') {
    return {
      authenticated: Boolean(lastAuthState.authenticated),
      sessionInProgress: true,
      sessionExpiresAt: activeSession.expiresAt,
      verifiedAt: lastAuthState.verifiedAt,
      reason: lastAuthState.reason,
    };
  }

  // Check if state file exists
  const statePath = path.resolve(process.cwd(), config.browser.authStateFile);
  const stateFileExists = fs.existsSync(statePath);

  if (lastAuthState.authenticated !== null) {
    return {
      authenticated: lastAuthState.authenticated,
      verifiedAt: lastAuthState.verifiedAt,
      reason: lastAuthState.reason,
      sessionInProgress: false,
      stateFileExists,
    };
  }

  // If state file exists but unverified in memory, do a quick check
  if (stateFileExists) {
    return {
      authenticated: true,
      verifiedAt: lastAuthState.verifiedAt,
      reason: 'STATE_FILE_PRESENT',
      sessionInProgress: false,
      stateFileExists: true,
    };
  }

  return {
    authenticated: false,
    verifiedAt: null,
    reason: 'NOT_AUTHENTICATED',
    sessionInProgress: false,
    stateFileExists: false,
  };
}

/**
 * Marks session as expired (e.g. when screenshot encounters login screen).
 */
function markAuthExpired(reason = 'SESSION_EXPIRED') {
  lastAuthState = {
    authenticated: false,
    verifiedAt: null,
    reason,
    source: null,
  };
  log('warn', 'Centralized Google authentication session marked as expired', { reason });
}

/**
 * Initiates an administrator interactive authentication session.
 */
async function startInteractiveSession() {
  // If an active session is already running and valid, return it
  if (activeSession && activeSession.status === 'ready' && Date.now() < activeSession.expiresAt) {
    log('info', 'Reusing active interactive authentication session');
    return {
      sessionId: activeSession.id,
      interactiveUrl: '/admin/live',
      expiresIn: Math.max(1, Math.round((activeSession.expiresAt - Date.now()) / 1000)),
      isRemote: activeSession.isRemote,
    };
  }

  // Cancel any stale session
  await cancelInteractiveSession();

  log('info', 'Starting new administrator interactive authentication session');
  const interactiveData = await browserService.createInteractivePage();
  const { page, cdp, liveURL, liveURLId, timeout, isRemote } = interactiveData;

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + timeout;

  // Navigate the interactive page to Google sign-in
  await page.goto(GOOGLE_AUTH_ORIGIN, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  const sessionObj = {
    id: sessionId,
    status: 'ready',
    createdAt: now,
    expiresAt,
    page,
    cdp,
    liveURL,
    liveURLId,
    isRemote,
    timeoutHandle: null,
  };

  // Set timeout to auto-close live link and clean up if administrator abandons
  sessionObj.timeoutHandle = setTimeout(async () => {
    if (activeSession && activeSession.id === sessionId) {
      log('warn', 'Interactive session timed out without finalization');
      await cancelInteractiveSession();
    }
  }, timeout);

  activeSession = sessionObj;

  return {
    sessionId,
    interactiveUrl: '/admin/live',
    expiresIn: Math.round(timeout / 1000),
    isRemote,
  };
}

/**
 * Retrieves the currently active interactive session (for /admin/live redirection).
 */
function getActiveSession() {
  if (!activeSession) return null;
  if (Date.now() > activeSession.expiresAt) {
    cancelInteractiveSession().catch(() => {});
    return null;
  }
  return activeSession;
}

/**
 * Retrieves sanitized interactive session status for UI polling.
 */
function getInteractiveSessionStatus() {
  if (!activeSession) {
    return { active: false };
  }

  const isExpired = Date.now() > activeSession.expiresAt;
  if (isExpired && activeSession.status === 'ready') {
    activeSession.status = 'expired';
  }

  return {
    active: activeSession.status === 'ready' || activeSession.status === 'verifying',
    status: activeSession.status,
    createdAt: new Date(activeSession.createdAt).toISOString(),
    expiresAt: new Date(activeSession.expiresAt).toISOString(),
    expiresIn: Math.max(0, Math.round((activeSession.expiresAt - Date.now()) / 1000)),
    isRemote: activeSession.isRemote,
    error: activeSession.error || null,
  };
}

/**
 * Cancels and cleans up the active interactive session.
 */
async function cancelInteractiveSession() {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;

  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
  }

  if (session.cdp && session.liveURLId) {
    await browserService.closeLiveURL(session.cdp, session.liveURLId);
  }

  if (session.page) {
    try {
      await session.page.close();
    } catch (_) { /* ignore */ }
  }
}

/**
 * Finalizes Google authentication:
 * 1. Revokes the interactive live URL bearer link immediately.
 * 2. Verifies Google sign-in is complete.
 * 3. Navigates to Firebase Console Analytics dashboard.
 * 4. Confirms that the Active Users card is visible and accessible.
 * 5. Saves storageState and encrypted backup.
 * 6. Marks centralized session as authenticated.
 */
async function finishInteractiveSession() {
  if (!activeSession) {
    throw new Error('No interactive authentication session is currently active. Please click "Start Google Authentication".');
  }

  const session = activeSession;
  session.status = 'verifying';

  // 1. Revoke the interactive live URL immediately so viewer link is disabled
  if (session.cdp && session.liveURLId) {
    await browserService.closeLiveURL(session.cdp, session.liveURLId);
  }

  const page = session.page;
  if (!page || page.isClosed()) {
    activeSession = null;
    throw new Error('Interactive browser page was closed before verification could complete.');
  }

  try {
    log('info', 'Verifying Google authentication completion on remote browser...');

    // Check if still on Google Sign-In URL
    const currentUrl = page.url();
    if (isOnGoogleAuthFlow(currentUrl)) {
      // Give a brief 5-second grace window in case the last redirect is finishing
      try {
        await page.waitForURL((url) => !isOnGoogleAuthFlow(url), { timeout: 5000 });
      } catch (_) {
        session.status = 'ready'; // allow user to continue or retry
        session.error = 'Google sign-in is not finished. Please complete password and MFA.';
        throw new Error('Google sign-in was not completed. The browser is still on the Google authentication page.');
      }
    }

    log('info', 'Navigating to Firebase Console dashboard for verification', {
      url: config.firebase.dashboardUrl,
    });

    await page.goto(config.firebase.dashboardUrl, {
      waitUntil: 'load',
      timeout: config.browser.navigationTimeout,
    });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // Allow background SSO handshakes to complete
    if (page.url().includes('accounts.google.com') && !page.url().includes('/signin') && !page.url().includes('/ServiceLogin')) {
      await page.waitForURL((url) => !url.href.includes('accounts.google.com'), { timeout: 15000 }).catch(() => {});
    }

    log('info', 'Page reached during verification', {
      currentUrl: page.url(),
      title: await page.title().catch(() => ''),
    });

    // Check if page redirected back to Google sign-in
    const afterNavUrl = page.url();
    if (isOnGoogleAuthFlow(afterNavUrl)) {
      session.status = 'ready';
      session.error = 'Firebase rejected session and redirected back to Google sign-in.';
      throw new Error('Firebase redirected to Google login. The signed-in account does not have access or session expired.');
    }

    // Locate Active Users card on page or in iframe
    log('info', 'Verifying Active Users card visibility in Firebase Console...');
    let cardFound = false;
    const startTime = Date.now();
    const timeoutMs = Math.min(config.browser.cardWaitTimeout, 45000);

    while (Date.now() - startTime < timeoutMs) {
      // 1a. Precise data-attribute (most reliable)
      try {
        const realtimeCard = page.locator('[data-guidedhelpid="realtime"]').first();
        if (await realtimeCard.isVisible({ timeout: 1500 }).catch(() => false)) {
          cardFound = true;
          log('info', 'Verified Active Users card via data-guidedhelpid=realtime');
        }
      } catch (_) {}
      if (cardFound) break;

      // 1b. Exact heading text (innermost element, avoids giant ancestors)
      try {
        const textEl = page.getByText(/ACTIVE USERS IN LAST 30 MINUTES/i).first();
        if (await textEl.isVisible({ timeout: 1500 }).catch(() => false)) {
          cardFound = true;
          log('info', 'Verified Active Users card via heading text');
        }
      } catch (_) {}
      if (cardFound) break;

      // 1c. Narrower text search on small elements only
      try {
        const els = page.locator('h2, h3, h4, span, p').filter({ hasText: /30 minutes/i });
        const count = await els.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = els.nth(i);
          if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
            const bbox = await el.boundingBox().catch(() => null);
            if (bbox && bbox.width < 1000) {
              cardFound = true;
              log('info', 'Verified Active Users card via narrow 30-minutes text');
              break;
            }
          }
        }
      } catch (_) {}
      if (cardFound) break;

      // 2. Search inside frames
      for (const frame of page.frames()) {
        try {
          const frameEl = frame.getByText(/30 minutes/i).first();
          if (await frameEl.isVisible({ timeout: 500 }).catch(() => false)) {
            cardFound = true;
            log('info', 'Verified Active Users card inside frame');
            break;
          }
        } catch (_) {}
      }
      if (cardFound) break;

      await page.waitForTimeout(1000);
    }

    if (!cardFound) {
      session.status = 'ready';
      session.error = 'Firebase Console loaded, but the Active Users card was not found.';
      throw new Error('Firebase Console loaded, but the Active Users card could not be found. Ensure the authenticated account has Firebase Analytics viewer permissions.');
    }

    // Save storage state to disk and memory cache
    const stateData = await page.context().storageState();
    browserService.setStorageState(stateData);

    // Encrypted backup
    if (config.security.sessionBackupPassphrase) {
      try {
        const jsonContent = typeof stateData === 'string' ? stateData : JSON.stringify(stateData);
        backupAuthState(jsonContent, config.security.sessionBackupPassphrase);
        log('info', 'Encrypted backup of session state created');
      } catch (backupErr) {
        log('warn', 'Session state backup failed (non-critical)', { error: backupErr.message });
      }
    }

    // Mark shared session as authenticated
    lastAuthState = {
      authenticated: true,
      verifiedAt: new Date().toISOString(),
      reason: null,
      source: 'verified_remote_session',
    };

    // Close the temporary verification page; shared context stays alive!
    await page.close().catch(() => {});
    if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
    activeSession = null;

    log('info', 'Centralized Google authentication completed and verified successfully');
    return {
      success: true,
      authenticated: true,
      verifiedAt: lastAuthState.verifiedAt,
      message: 'Google authentication verified and Active Users card located successfully.',
    };
  } catch (err) {
    log('error', 'Authentication verification failed', { error: err.message });
    throw err;
  }
}

/**
 * Backwards compatibility for legacy scripts.
 */
async function startAuthentication() {
  return startInteractiveSession();
}

module.exports = {
  getAuthStatus,
  markAuthExpired,
  startInteractiveSession,
  getActiveSession,
  getInteractiveSessionStatus,
  finishInteractiveSession,
  cancelInteractiveSession,
  startAuthentication,
};
