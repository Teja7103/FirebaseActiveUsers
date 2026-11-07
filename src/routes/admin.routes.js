const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const config = require('../config');
const authService = require('../services/auth.service');
const { requireAdmin } = require('../middleware/auth.middleware');
const {
  isAuthenticatedAdmin,
  setAdminSession,
  clearAdminSession,
  tokensMatch,
} = require('../middleware/adminSession.middleware');
const { rateLimiter } = require('../middleware/rateLimiter');
const { log } = require('../utils/logger');

const LOGIN_VIEW_PATH = path.join(__dirname, '..', 'views', 'admin', 'login.html');
const AUTH_VIEW_PATH = path.join(__dirname, '..', 'views', 'admin', 'auth.html');

/**
 * GET /admin/auth
 * Serves the mobile-friendly administrator authentication page.
 * If not authenticated, renders the admin sign-in form.
 */
router.get('/auth', (req, res) => {
  // If ?token= query parameter is provided and valid, establish session and redirect cleanly
  if (req.query && req.query.token) {
    if (tokensMatch(req.query.token, config.security.adminToken)) {
      setAdminSession(res, req);
      return res.redirect('/admin/auth');
    }
    return res.redirect('/admin/auth?error=invalid_token');
  }

  const authInfo = isAuthenticatedAdmin(req);
  if (authInfo.authenticated) {
    return res.sendFile(AUTH_VIEW_PATH);
  }

  return res.sendFile(LOGIN_VIEW_PATH);
});

/**
 * POST /admin/login
 * Validates admin token and sets the admin session cookie.
 */
router.post('/login', rateLimiter, (req, res) => {
  const token = req.body && (req.body.adminToken || req.body.token);
  if (!token || !tokensMatch(token, config.security.adminToken)) {
    if (req.is('json') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({
        error: 'ADMIN_UNAUTHORIZED',
        message: 'Invalid Admin Token. Please verify and try again.',
      });
    }
    return res.redirect('/admin/auth?error=invalid_token');
  }

  setAdminSession(res, req);
  log('info', 'Admin logged into /admin/auth session');

  if (req.is('json') || req.headers.accept?.includes('application/json')) {
    return res.json({ success: true, redirect: '/admin/auth' });
  }

  return res.redirect('/admin/auth');
});

/**
 * POST or GET /admin/logout
 * Clears the session cookie and redirects to /admin/auth.
 */
function handleLogout(req, res) {
  clearAdminSession(res, req);
  res.redirect('/admin/auth');
}
router.post('/logout', handleLogout);
router.get('/logout', handleLogout);

/**
 * GET /admin/live
 * Protected bearer redirect endpoint for the Browserless interactive live session.
 * Accessible only by the authenticated administrator.
 */
router.get('/live', requireAdmin, (req, res) => {
  const session = authService.getActiveSession();
  if (!session || !session.liveURL) {
    return res.status(404).send(
      '<h3>No active interactive Google login session.</h3><p><a href="/admin/auth">Go to /admin/auth</a> to start a session.</p>'
    );
  }

  // Redirect the administrator's tab directly to the Browserless liveURL
  return res.redirect(302, session.liveURL);
});

/* ========================================================
   Admin API Endpoints
   ======================================================== */

/**
 * GET /admin/api/status
 * Retrieves current centralized Google and Firebase authentication status.
 */
router.get('/api/status', requireAdmin, async (req, res) => {
  try {
    const status = await authService.getAuthStatus();
    res.json({
      ...status,
      dashboardUrl: config.firebase.dashboardUrl,
    });
  } catch (err) {
    res.status(500).json({ error: 'STATUS_ERROR', message: err.message });
  }
});

/**
 * POST /admin/api/session
 * Initiates remote interactive session on Browserless.
 */
router.post('/api/session', requireAdmin, rateLimiter, async (req, res) => {
  try {
    const result = await authService.startInteractiveSession();
    res.json(result);
  } catch (err) {
    log('error', 'Failed to start interactive authentication session', { error: err.message });
    res.status(500).json({
      error: 'SESSION_START_FAILED',
      message: err.message || 'Failed to start interactive browser session.',
    });
  }
});

/**
 * GET /admin/api/session/status
 * Checks status of the currently active interactive session.
 */
router.get('/api/session/status', requireAdmin, (req, res) => {
  const status = authService.getInteractiveSessionStatus();
  res.json(status);
});

/**
 * POST /admin/api/session/finish
 * Verifies that Google authentication has completed and Active Users card is visible.
 */
router.post('/api/session/finish', requireAdmin, rateLimiter, async (req, res) => {
  try {
    const result = await authService.finishInteractiveSession();
    res.json(result);
  } catch (err) {
    log('error', 'Interactive authentication finalization failed', { error: err.message });
    res.status(400).json({
      error: 'VERIFICATION_FAILED',
      message: err.message || 'Verification of Firebase Console access failed.',
    });
  }
});

/**
 * POST /admin/api/session/cancel
 * Cancels active interactive session.
 */
router.post('/api/session/cancel', requireAdmin, async (req, res) => {
  try {
    await authService.cancelInteractiveSession();
    res.json({ success: true, message: 'Session cancelled.' });
  } catch (err) {
    res.status(500).json({ error: 'CANCEL_FAILED', message: err.message });
  }
});

module.exports = router;
