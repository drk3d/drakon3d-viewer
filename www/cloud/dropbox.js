// cloud/dropbox.js — Dropbox integration via Chooser (dropins.js).
//
// Chooser with linkType:'direct' returns a 4-hour pre-signed URL that
// supports CORS. No auth header needed.

import { loadFromCloud, loadScriptOnce, SUPPORTED_EXTENSIONS } from './index.js';
import { DROPBOX_APP_KEY, isConfigured } from './config.js';
import { t } from '../i18n.js';

const DROPBOX_SRC = 'https://www.dropbox.com/static/api/2/dropins.js';

async function ensureDropbox() {
  // dropins.js requires the app key via a data-attribute on the <script> tag.
  if (window.Dropbox) return;
  const existing = document.getElementById('dropboxjs');
  if (existing && window.Dropbox) return;
  if (!existing) {
    const el = document.createElement('script');
    el.src = DROPBOX_SRC;
    el.id = 'dropboxjs';
    el.async = true;
    el.defer = true;
    el.setAttribute('data-app-key', DROPBOX_APP_KEY);
    document.head.appendChild(el);
    await new Promise((resolve, reject) => {
      el.addEventListener('load', resolve);
      el.addEventListener('error', () => reject(new Error('Failed to load dropins.js')));
    });
  } else {
    await loadScriptOnce(DROPBOX_SRC);
  }
}

export async function pickAndLoad(loaders) {
  if (!isConfigured('dropbox')) {
    alert(t('cloud.dropbox_not_configured'));
    return;
  }
  try {
    await ensureDropbox();

    Dropbox.choose({
      linkType: 'direct',       // pre-signed URL, no auth header required
      multiselect: false,
      extensions: SUPPORTED_EXTENSIONS,
      success: async (files) => {
        const f = files[0];
        if (!f) return;
        await loadFromCloud({
          url: f.link,
          fileName: f.name,
          loaders,
        });
      },
      cancel: () => {},
    });
  } catch (err) {
    console.error('[dropbox] init failed', err);
    alert(`${t('cloud.dropbox_failed')}\n${err.message}`);
  }
}
