// cloud/index.js — common adapter that turns a cloud (url, fileName) into
// the same File-object flow used by local picker + drag/drop.
//
// All provider modules (google-drive.js, onedrive.js, dropbox.js) converge
// on loadFromCloud(); handleFile()/loadSession() stay untouched.

import { handleFile } from '../loaders.js';
import { loadSession } from '../session.js';
import { showLoading, hideLoading } from '../helpers.js';
import { SUPPORTED_EXTENSIONS } from './config.js';
import { t } from '../i18n.js';

export { SUPPORTED_EXTENSIONS };

// Dynamically inject a <script> once. Subsequent calls resolve immediately.
const _scriptCache = new Map();
export function loadScriptOnce(src, attrs = {}) {
  if (_scriptCache.has(src)) return _scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded === '1') { resolve(); return; }
    const el = existing || document.createElement('script');
    el.src = src;
    el.async = true;
    el.defer = true;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.addEventListener('load', () => { el.dataset.loaded = '1'; resolve(); });
    el.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
    if (!existing) document.head.appendChild(el);
  });
  _scriptCache.set(src, p);
  return p;
}

export function isSupportedFileName(name) {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Core entry point. Takes a pre-signed URL or an auth-required URL + headers,
// downloads into memory, wraps as File, and dispatches to the existing
// handleFile() / loadSession() pipelines.
//
// loaders: { rhinoLoader, gltfLoader } — same instances bound in app.js.
export async function loadFromCloud({ url, fileName, headers = {}, loaders }) {
  if (!fileName) throw new Error('loadFromCloud: fileName required');
  if (!isSupportedFileName(fileName)) {
    alert(`${t('cloud.unsupported_format')}${fileName}\n${t('cloud.supported_formats')}${SUPPORTED_EXTENSIONS.join(', ')}`);
    return;
  }

  showLoading('Loading…');
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const file = new File([buf], fileName);

    // handleFile() owns its own showLoading() cycle; hide ours before handoff
    // so the new "Reading file…" overlay replaces "Loading…" cleanly.
    hideLoading();

    if (fileName.toLowerCase().endsWith('.rhv')) {
      await loadSession(file);
    } else {
      await handleFile(file, loaders.rhinoLoader, loaders.gltfLoader);
    }
  } catch (err) {
    hideLoading();
    console.error('[cloud] load failed', err);
    alert(`${t('cloud.load_failed')}\n${err.message}`);
  }
}
