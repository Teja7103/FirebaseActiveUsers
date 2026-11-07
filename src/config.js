require('dotenv').config();
const path = require('path');

const resolved = (p) => path.resolve(process.cwd(), p);

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  firebase: {
    dashboardUrl:
      process.env.FIREBASE_DASHBOARD_URL ||
      'https://console.firebase.google.com/project/YOUR_PROJECT_ID/analytics',
  },

  browser: {
    profileDir: process.env.BROWSER_PROFILE_DIR
      ? resolved(process.env.BROWSER_PROFILE_DIR)
      : resolved('./browser-profile'),
    authStateFile:
      process.env.GOOGLE_AUTH_STATE_FILE || './google-auth-state.json',
    headless: (process.env.BROWSER_HEADLESS || 'true') === 'true',
    viewport: {
      width: parseInt(process.env.VIEWPORT_WIDTH || '1440', 10),
      height: parseInt(process.env.VIEWPORT_HEIGHT || '900', 10),
    },
    navigationTimeout: parseInt(process.env.NAVIGATION_TIMEOUT || '60000', 10),
    cardWaitTimeout: parseInt(process.env.CARD_WAIT_TIMEOUT || '150000', 10),
    cardSelector:
      process.env.ACTIVE_USERS_CARD_SELECTOR || 'ga-card[data-guidedhelpid="realtime"]',
    cardText: process.env.ACTIVE_USERS_CARD_TEXT || 'Active users in last 30 minutes',
  },

  auth: {
    loginTimeoutSeconds: parseInt(process.env.LOGIN_WAIT_SECONDS || '180', 10),
  },

  security: {
    screenshotApiToken: process.env.SCREENSHOT_API_TOKEN || '',
    adminToken: process.env.ADMIN_TOKEN || '',
    sessionBackupPassphrase: process.env.SESSION_BACKUP_PASSPHRASE || '',
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      max: parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
    },
  },
};
