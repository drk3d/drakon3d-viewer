// cloud/google-drive.js — Google Drive integration via GIS + Picker API.
//
// Flow:
//   1. Lazy-load gapi (for Picker) and gsi/client (for OAuth token).
//   2. Request an access token (drive.file scope).
//   3. Show Google Picker filtered by SUPPORTED_EXTENSIONS.
//   4. fetch files.get?alt=media with Authorization: Bearer <token>.
//   5. Hand off ArrayBuffer to common loadFromCloud().

import { loadFromCloud, loadScriptOnce, SUPPORTED_EXTENSIONS } from './index.js';
import {
  GOOGLE_CLIENT_ID, GOOGLE_API_KEY, GOOGLE_SCOPES, isConfigured,
} from './config.js';
import { t } from '../i18n.js';

const GAPI_SRC = 'https://apis.google.com/js/api.js';
const GIS_SRC  = 'https://accounts.google.com/gsi/client';

let _tokenClient = null;
let _pickerLoaded = false;
let _accessToken = null;

async function ensureGapi() {
  await loadScriptOnce(GAPI_SRC);
  await new Promise((resolve, reject) => {
    gapi.load('picker', { callback: resolve, onerror: reject });
  });
  _pickerLoaded = true;
}

async function ensureGis() {
  await loadScriptOnce(GIS_SRC);
  if (_tokenClient) return;
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: () => {},  // overwritten per request
  });
}

function requestToken({ forceConsent = false } = {}) {
  return new Promise((resolve, reject) => {
    _tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      _accessToken = resp.access_token;
      resolve(resp.access_token);
    };
    _tokenClient.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
  });
}

function showPicker(token) {
  return new Promise((resolve, reject) => {
    // MIME types of supported formats are too varied/unstandardized
    // (CAD formats often arrive as application/octet-stream). Use a
    // generic view and filter client-side by extension.
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(google.picker.DocsViewMode.LIST);

    const picker = new google.picker.PickerBuilder()
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setAppId(GOOGLE_CLIENT_ID.split('-')[0])
      .addView(view)
      .setTitle('Select a 3D model file')
      .setCallback((data) => {
        const action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.PICKED) {
          const doc = data[google.picker.Response.DOCUMENTS][0];
          resolve({ id: doc.id, name: doc.name });
        } else if (action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Firefox's "Enhanced Tracking Protection" blocks the third-party cookies
// that Google Picker's iframe (docs.google.com) needs to function. We can't
// fix this from JS — only the user can adjust browser settings. Show a one-
// time informational notice when running on Firefox so users know what to
// do if the picker fails.
function isFirefox() {
  return /firefox/i.test(navigator.userAgent);
}

function maybeShowFirefoxNotice() {
  const KEY = 'drakon3d_fx_gdrive_notice_v1';
  if (!isFirefox() || localStorage.getItem(KEY)) return true;
  const proceed = confirm(t('cloud.fx_notice'));
  if (proceed) localStorage.setItem(KEY, '1');
  return proceed;
}

export async function pickAndLoad(loaders) {
  if (!isConfigured('google')) {
    alert(t('cloud.gdrive_not_configured'));
    return;
  }
  if (!maybeShowFirefoxNotice()) return;
  try {
    await Promise.all([ensureGapi(), ensureGis()]);
    const token = await requestToken();
    const picked = await showPicker(token);
    if (!picked) return;

    const lower = picked.name.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
      alert(t('cloud.unsupported_format') + picked.name);
      return;
    }

    await loadFromCloud({
      url: `https://www.googleapis.com/drive/v3/files/${picked.id}?alt=media`,
      fileName: picked.name,
      headers: { Authorization: `Bearer ${token}` },
      loaders,
    });
  } catch (err) {
    console.error('[google-drive] picker failed', err);
    alert(`${t('cloud.gdrive_failed')}\n${err.message}`);
  }
}
