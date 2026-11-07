const authStatusEl = document.getElementById('auth-status');
const reauthSection = document.getElementById('reauth-section');
const captureBtn = document.getElementById('capture-btn');
const preview = document.getElementById('preview');
const lastCaptureEl = document.getElementById('last-capture');
const errorEl = document.getElementById('error');
const apiTokenInput = document.getElementById('api-token');
const adminTokenInput = document.getElementById('admin-token');
const startAuthBtn = document.getElementById('start-auth-btn');

let authToken = localStorage.getItem('screenshot_api_token') || '';

apiTokenInput.value = authToken;
adminTokenInput.value = localStorage.getItem('admin_token') || '';

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}
function clearError() {
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
}

function renderAuthStatus(status) {
  if (status.authenticated) {
    authStatusEl.innerHTML = '<div class="ok">✅ Authenticated</div>';
    reauthSection.classList.add('hidden');
  } else {
    authStatusEl.innerHTML = '<div class="warn">❌ Not authenticated</div>';
    if (status.reason) authStatusEl.innerHTML += `<div class="reason">Reason: ${status.reason}</div>`;
    reauthSection.classList.remove('hidden');
  }
}

async function refreshAuthStatus() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    renderAuthStatus(data);
  } catch (e) {
    authStatusEl.innerHTML = '<div class="error">Failed to load auth status.</div>';
  }
}

async function capture() {
  clearError();
  captureBtn.disabled = true;
  try {
    const res = await fetch('/screenshot/active-users', {
      headers: { Authorization: `Bearer ${apiTokenInput.value.trim()}` },
    });
    if (res.status === 401) {
      showError('Not authorized. Please provide a valid API access token. If your Google session expired, use re-authentication.');
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.message || `Capture failed with status ${res.status}`);
      return;
    }
    const blob = await res.blob();
    preview.src = URL.createObjectURL(blob);
    const lastCapture = res.headers.get('X-Last-Capture');
    lastCaptureEl.textContent = lastCapture ? new Date(lastCapture).toISOString() : new Date().toISOString();
  } catch (e) {
    showError(`Capture failed: ${e.message}`);
  } finally {
    captureBtn.disabled = false;
  }
}

captureBtn.addEventListener('click', async () => {
  const token = apiTokenInput.value.trim();
  if (!token) { showError('API access token is required for screenshot capture.'); return; }
  localStorage.setItem('screenshot_api_token', token);
  await capture();
});

startAuthBtn.addEventListener('click', async () => {
  const token = adminTokenInput.value.trim();
  if (!token) { showError('Admin token is required for re-authentication.'); return; }
  localStorage.setItem('admin_token', token);
  try {
    const res = await fetch('/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showError(data.message || 'Re-authentication failed'); return; }
    await refreshAuthStatus();
  } catch (e) { showError(`Re-auth failed: ${e.message}`); }
});

refreshAuthStatus();
