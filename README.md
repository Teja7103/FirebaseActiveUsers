# Firebase Active Users Screenshot Service

Captures the **actual screenshot** of the **Firebase Console → Analytics Dashboard → Active Users in Last 30 Minutes** card via Playwright + Chromium, and serves it as PNG through a small Express API.

> This is **not** a data-integration project and does **not** use Firebase Analytics APIs.
> It drives a real (authenticated) browser through the real Firebase Console UI and screenshots the real card.

## Current status

- **Phase 1 – Local browser automation:** ✅ Done (manual Google login → Firebase → card capture → PNG saved)
- **Phase 2 – API:** ✅ Done (`/health`, `/auth/status`, `POST /auth/start`, `GET /screenshot/active-users`, `GET /`)
- **Phase 3 – Frontend:** ✅ Done (auth status, capture button, preview, last capture, errors, reauth)
- **Phase 4 – Security:** ✅ Done (API token, admin token, rate limiting, redaction, no debug endpoints)
- **Phase 5 – Deployment:** 🚧 Docker file ready, Blitz deployment notes below.

## Tech stack

- Node.js 20
- Express 4
- Playwright 1.49 + Chromium
- Vanilla HTML/CSS/JS frontend served by Express

## Architecture

```
src/
  server.js              Express app entry + wiring
  config.js              env-based configuration
  routes/
    auth.routes.js       GET /auth/status, POST /auth/start
    screenshot.routes.js GET /screenshot/active-users
  services/
    browser.service.js   lazy Playwright persistent context singleton
    auth.service.js      auth status + interactive re-auth
    screenshot.service.js capture + in-memory cache + mutex
  middleware/
    auth.middleware.js   API token + admin token guards
    rateLimiter.js       simple in-memory rate limiter
  utils/
    logger.js             console logger with sensitive-key redaction
public/
  index.html / styles.css / app.js
scripts/
  authenticate.js        Phase 1 manual auth + capture script
browser-profile/         persistent Chromium profile (gitignored)
google-auth-state.json  storage state (gitignored)
screenshots/             captured PNGs (gitignored)
```

### Browser flow

1. Playwright launches Chromium with a **persistent profile** (`BROWSER_PROFILE_DIR`, default `./browser-profile`).
2. Session is established once via manual Google sign-in + MFA (or re-auth via `POST /auth/start`).
3. Screenshot capture reuses the **same context** (singleton) and navigates to the Firebase dashboard.
4. The Firebase Analytics dashboard renders inside an **iframe** (`analytics.google.com`), so the card is located via a frame locator.
5. Card locator: `ga-card[data-guidedhelpid="realtime"]` (discovered from the real Firebase DOM; configurable via `ACTIVE_USERS_CARD_SELECTOR`).

### Concurrency / caching

- Screenshot operations are **serialized** (single promise-chain mutex) — one capture at a time.
- Last successful capture is kept in memory and reused (marked `X-Screenshot-Cache: HIT`) if the live capture fails.

## Getting started

```bash
npm install
npx playwright install chromium
cp .env.example .env
# edit .env: FIREBASE_DASHBOARD_URL, SCREENSHOT_API_TOKEN, ADMIN_TOKEN, etc.
npm run auth        # Phase 1: manual Google login + screenshot
npm start          # Phase 2: API server on :3000
```

Open http://localhost:3000/ for the dashboard UI, or call the API directly.

## Configuration (.env)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `FIREBASE_DASHBOARD_URL` | `https://console.firebase.google.com/project/YOUR_PROJECT_ID/analytics` | Firebase dashboard URL |
| `ACTIVE_USERS_CARD_SELECTOR` | `ga-card[data-guidedhelpid="realtime"]` | Card CSS selector |
| `ACTIVE_USERS_CARD_TEXT` | `Active users in last 30 minutes` | Card text fallback |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1440` / `900` | Screenshot viewport |
| `NAVIGATION_TIMEOUT` | `60000` | Navigation timeout ms |
| `CARD_WAIT_TIMEOUT` | `150000` | Card wait timeout ms |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent browser profile dir |
| `GOOGLE_AUTH_STATE_FILE` | `./google-auth-state.json` | Storage state file |
| `BROWSER_HEADLESS` | `true` | Browser headless mode (false for local manual flows) |
| `LOGIN_WAIT_SECONDS` | `180` | Manual login wait seconds |
| `SCREENSHOT_API_TOKEN` | – | Bearer token for screenshot endpoints |
| `ADMIN_TOKEN` | – | Token for `POST /auth/start` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `30` / `60000` | Screenshot rate limit |

## API endpoints

### `GET /health`
```json
{ "status": "ok", "browser": "available", "firebase": { "dashboardUrl": "..." }, "lastCapture": { "lastCaptureAt": null, "hasCachedCapture": false } }
```

### `GET /auth/status`
```json
{ "authenticated": true, "reason": null, "source": "persistent-context" }
```
Returns only whether the session appears authenticated — never exposes cookies/tokens.

### `POST /auth/start` 🔒 admin
Headers: `Authorization: Bearer <ADMIN_TOKEN>`.
Launches headed Chromium with the persistent profile, waits for manual Google sign-in/MFA, saves storage state.

### `GET /screenshot/active-users` 🔒
Headers: `Authorization: Bearer <SCREENSHOT_API_TOKEN>`.
- Success: `200` with `Content-Type: image/png`, body = PNG bytes, headers `X-Screenshot-Cache: MISS|HIT`, `X-Last-Capture: <ISO>`.
- Auth failure: `401` `{ "error": "GOOGLE_AUTH_REQUIRED", ... }`
- Capture failure (no cached): `500` `{ "error": "SCREENSHOT_FAILED", ... }`

### `GET /`
Serves the simple dashboard UI (auth status, capture button, preview, last capture time, errors, reauth instructions).

## Security

- Application-level access token (`SCREENSHOT_API_TOKEN`) for screenshot endpoints (Bearer).
- Admin token (`ADMIN_TOKEN`) for administrative operations (`POST /auth/start`).
- Timing-safe token comparison.
- Rate limiting on screenshot + auth-start endpoints (default 30 req/min per IP).
- No browser debugging endpoints exposed publicly.
- Logger redacts sensitive keys (cookies/tokens/etc.).
- No credentials in code; browser profile & storage state gitignored.

## Deployment notes (Blitz.cloud)

- Blitz free plan: 512 MB reserved memory (shared), apps sleep after 15 min idle, kept folders are **not** backed up on free plan (only databases). Browser profile persistence across deploys is therefore not guaranteed on free tier — use Pro or re-auth after redeploys.
- Chromium memory footprint (~300–500 MB) must fit within the container; keep `BROWSER_HEADLESS=true` in production.
- Docker image must be `linux/amd64`, public, and declare a port (we use `EXPOSE 3000`).
- Blitz picks the port from `EXPOSE` — ensure the app listens on `PORT` (default 3000).

## Manual Google login (Phase 1 flow)

1. `npm run auth` → headed Chromium opens at `https://accounts.google.com/`.
2. Sign in with your Google account, complete MFA.
3. Script detects completion, saves storage state, navigates to Firebase dashboard, captures card → `screenshots/active-users.png`.

## Troubleshooting

- `SingletonLock: File exists` → kill other Chromium instances / server before running scripts.
- Auth redirects → session expired → re-auth via `POST /auth/start` or re-run `npm run auth`.
- Card not found → check `ACTIVE_USERS_CARD_SELECTOR` / `ACTIVE_USERS_CARD_TEXT`; card lives inside the analytics iframe.

## Important disclaimers

- Do not attempt to bypass Google CAPTCHA/MFA/security checks.
- Do not share Google credentials; browser profile + storage state must never be committed.
- The primary success criterion: request a screenshot via API/UI and receive the actual Active Users card PNG from your Firebase Console without sharing your Google account with others.
