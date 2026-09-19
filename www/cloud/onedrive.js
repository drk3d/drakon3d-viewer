// cloud/onedrive.js — OneDrive integration via MSAL.js (PKCE) + Microsoft
// Graph API. Replaces the legacy OneDrive.js v7.2 SDK whose internal popup
// auth flow breaks under modern browsers' COOP policy (window.opener=null).
//
// Flow:
//   1. MSAL.js handles OAuth 2.0 with PKCE — modern, COOP-compatible.
//   2. After sign-in we get a Graph API access token (Files.Read scope).
//   3. We render our own file browser UI (folder tree, list, navigation).
//   4. Selected file is downloaded via `GET /me/drive/items/{id}/content`
//      and handed to loadFromCloud().

import { loadFromCloud, loadScriptOnce, SUPPORTED_EXTENSIONS } from './index.js';
import { ONEDRIVE_CLIENT_ID, isConfigured } from './config.js';
import { showLoading, hideLoading } from '../helpers.js';
import { t } from '../i18n.js';

const MSAL_SRC   = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@3/lib/msal-browser.min.js';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES     = ['Files.Read', 'User.Read'];

let _msal = null;
let _account = null;

async function ensureMsal() {
  await loadScriptOnce(MSAL_SRC);
  if (_msal) return _msal;

  // PWA scope path (parent of /cloud/) — must match a registered Entra
  // SPA Redirect URI exactly.
  const redirectUri = new URL('../', import.meta.url).href;

  _msal = new msal.PublicClientApplication({
    auth: {
      clientId: ONEDRIVE_CLIENT_ID,
      authority: 'https://login.microsoftonline.com/common',
      redirectUri,
    },
    cache: {
      cacheLocation: 'localStorage',
    },
  });
  await _msal.initialize();

  const existing = _msal.getAllAccounts();
  if (existing.length > 0) {
    _account = existing[0];
    _msal.setActiveAccount(_account);
  }
  return _msal;
}

async function signIn() {
  const m = await ensureMsal();
  if (_account) return _account;
  const result = await m.loginPopup({ scopes: SCOPES, prompt: 'select_account' });
  _account = result.account;
  m.setActiveAccount(_account);
  return _account;
}

async function getAccessToken() {
  const m = await ensureMsal();
  if (!_account) await signIn();
  try {
    const r = await m.acquireTokenSilent({ scopes: SCOPES, account: _account });
    return r.accessToken;
  } catch (err) {
    const r = await m.acquireTokenPopup({ scopes: SCOPES, account: _account });
    return r.accessToken;
  }
}

async function listChildren(token, folderId) {
  const path = folderId === 'root'
    ? '/me/drive/root/children'
    : `/me/drive/items/${folderId}/children`;
  const url = `${GRAPH_BASE}${path}?$top=200&$select=id,name,folder,file,size,parentReference,webUrl`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return data.value;
}

function isSupportedFile(name) {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function formatSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, s = bytes;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(s < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ─── File browser modal ────────────────────────────────────────────────────
function showFileBrowser(token) {
  return new Promise((resolve) => {
    // Build DOM
    const overlay = document.createElement('div');
    overlay.className = 'cloud-modal-overlay';
    overlay.innerHTML = `
      <div class="cloud-modal" role="dialog" aria-modal="true">
        <div class="cloud-modal-header">
          <span class="cloud-modal-title">OneDrive</span>
          <button class="cloud-modal-close" aria-label="Close">×</button>
        </div>
        <div class="cloud-breadcrumb"></div>
        <div class="cloud-list" tabindex="0"></div>
        <div class="cloud-modal-footer">
          <button class="cloud-btn cloud-btn-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('.cloud-list');
    const crumbEl = overlay.querySelector('.cloud-breadcrumb');

    // Folder navigation stack: [{ id, name }]
    const stack = [{ id: 'root', name: 'OneDrive' }];

    function renderBreadcrumb() {
      crumbEl.innerHTML = '';
      stack.forEach((node, idx) => {
        const b = document.createElement('button');
        b.className = 'cloud-crumb';
        b.textContent = node.name;
        b.addEventListener('click', () => {
          stack.length = idx + 1;
          loadAndRender();
        });
        crumbEl.appendChild(b);
        if (idx < stack.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'cloud-crumb-sep';
          sep.textContent = '›';
          crumbEl.appendChild(sep);
        }
      });
    }

    async function loadAndRender() {
      renderBreadcrumb();
      listEl.innerHTML = '<div class="cloud-loading">Loading…</div>';
      try {
        const current = stack[stack.length - 1];
        const items = await listChildren(token, current.id);
        listEl.innerHTML = '';

        const folders = items.filter(i => i.folder);
        const files   = items.filter(i => i.file && isSupportedFile(i.name));

        if (folders.length === 0 && files.length === 0) {
          listEl.innerHTML = '<div class="cloud-empty">No supported files in this folder.</div>';
          return;
        }

        for (const f of folders) {
          const row = document.createElement('div');
          row.className = 'cloud-row cloud-row-folder';
          row.innerHTML = `
            <svg class="cloud-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            <span class="cloud-row-name">${f.name}</span>
            <span class="cloud-row-meta">${f.folder.childCount || ''} items</span>
          `;
          row.addEventListener('click', () => {
            stack.push({ id: f.id, name: f.name });
            loadAndRender();
          });
          listEl.appendChild(row);
        }
        for (const f of files) {
          const row = document.createElement('div');
          row.className = 'cloud-row cloud-row-file';
          row.innerHTML = `
            <svg class="cloud-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="cloud-row-name">${f.name}</span>
            <span class="cloud-row-meta">${formatSize(f.size)}</span>
          `;
          row.addEventListener('click', () => {
            cleanup();
            resolve({ id: f.id, name: f.name });
          });
          listEl.appendChild(row);
        }
      } catch (err) {
        listEl.innerHTML = `<div class="cloud-empty">Error: ${err.message}</div>`;
      }
    }

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function cancel() {
      cleanup();
      resolve(null);
    }
    function onKey(e) {
      if (e.key === 'Escape') cancel();
    }

    overlay.querySelector('.cloud-modal-close').addEventListener('click', cancel);
    overlay.querySelector('.cloud-btn-cancel').addEventListener('click', cancel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
    document.addEventListener('keydown', onKey);

    loadAndRender();
  });
}

export async function pickAndLoad(loaders) {
  if (!isConfigured('onedrive')) {
    alert(t('cloud.onedrive_not_configured'));
    return;
  }
  try {
    showLoading('Loading…');
    await signIn();
    const token = await getAccessToken();
    hideLoading();

    const picked = await showFileBrowser(token);
    if (!picked) return;

    await loadFromCloud({
      url: `${GRAPH_BASE}/me/drive/items/${picked.id}/content`,
      fileName: picked.name,
      headers: { Authorization: `Bearer ${token}` },
      loaders,
    });
  } catch (err) {
    hideLoading();
    console.error('[onedrive] failed', err);
    alert(`${t('cloud.onedrive_failed')}\n${err.message}`);
  }
}
