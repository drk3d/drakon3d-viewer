import { S } from './state.js';

// ── Loading UI ───────────────────────────────────────────────────────────────

export function setProgress(pct) {
  const el = document.getElementById('progress-bar');
  if (el) el.style.width = pct + '%';
}

export function showLoading(text = 'Loading…') {
  const loadingEl     = document.getElementById('loading');
  const loadingTextEl = document.getElementById('loading-text');
  if (loadingTextEl) loadingTextEl.textContent = text;
  setProgress(0);
  loadingEl?.classList.remove('hidden');
}

export function hideLoading() {
  setProgress(100);
  document.getElementById('loading')?.classList.add('hidden');
}

// ── Toast (non-blocking notification) ────────────────────────────────────────
// Lightweight info banner used for non-fatal notices (e.g. a 3dm file that
// carries geometry without render meshes). Auto-dismisses after `duration` ms;
// a close button lets the user dismiss early. Stacks multiple toasts vertically.
let _toastContainer = null;
export function showToast(message, { duration = 9000 } = {}) {
  if (!message) return;
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.id = 'toast-container';
    document.body.appendChild(_toastContainer);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';

  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '&times;';

  const dismiss = () => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback removal in case the transitionend never fires.
    setTimeout(() => toast.remove(), 400);
  };
  close.addEventListener('click', dismiss);

  toast.appendChild(text);
  toast.appendChild(close);
  _toastContainer.appendChild(toast);

  // Trigger the enter transition on the next frame.
  requestAnimationFrame(() => toast.classList.add('show'));
  if (duration > 0) setTimeout(dismiss, duration);
}

// ── Modal notice (blocking, single OK button) ────────────────────────────────
// Centered modal with a message and one confirm button. `onClose` fires on every
// dismissal path — OK button, Enter/Esc key, or backdrop click — so callers can
// run a single follow-up action (e.g. reload the page). Reuses the app's existing
// .modal-overlay / .modal-box styling.
export function showModal(message, { okLabel = 'OK', onClose = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box';
  box.style.maxWidth = '400px';

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.style.padding = '20px';

  const msg = document.createElement('p');
  msg.style.cssText = 'margin:0;font-size:0.82rem;line-height:1.55;color:var(--text);white-space:pre-line;';
  msg.textContent = message;

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px;';

  const ok = document.createElement('button');
  ok.className = 'panel-action-btn btn-primary';
  ok.style.cssText = 'font-size:0.78rem;padding:6px 22px;';
  ok.textContent = okLabel;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (typeof onClose === 'function') onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };

  ok.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  row.appendChild(ok);
  body.appendChild(msg);
  body.appendChild(row);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  ok.focus();
}

// ── Save to disk (folder picker on desktop Chromium, download elsewhere) ──────
// Acquire the sink SYNCHRONOUSLY inside the click handler — showSaveFilePicker
// requires an active user gesture, so call beginSave() *before* any slow blob
// production (GLB export, gzip). Then write the produced Blob via the returned
// sink. On Firefox/Safari/mobile (no File System Access API) it falls back to a
// classic <a download> to the browser's default location.
//
//   const sink = await beginSave({ suggestedName: 'model.glb', types: [...] });
//   if (!sink) return;                 // user cancelled the picker
//   const blob = await buildBlob();    // heavy work is fine here
//   await sink(blob);
//
// Ensure we hold read-write permission for a FileSystemFileHandle, prompting
// the user once if needed. Must be called within a user gesture when a prompt
// is required. Returns true if writable.
export async function ensureWritePermission(handle) {
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission?.(opts)) === 'granted') return true;
    if ((await handle.requestPermission?.(opts)) === 'granted') return true;
  } catch (e) {
    console.warn('[ensureWritePermission] failed:', e);
  }
  return false;
}

// Write a Blob to an open FileSystemFileHandle (overwrites its contents).
export async function writeBlobToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// Returns an async (blob) => void sink, or null if the user cancelled.
export async function beginSave({ suggestedName, types } = {}) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types });
      return async (blob) => {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      };
    } catch (err) {
      if (err && err.name === 'AbortError') return null; // user cancelled
      console.warn('[beginSave] showSaveFilePicker failed, falling back to download:', err);
    }
  }
  // Fallback: classic download to the browser's default location.
  return async (blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName || 'download';
    a.click();
    URL.revokeObjectURL(url);
  };
}

// ── File name display ────────────────────────────────────────────────────────

export function setFileName(name) {
  const fileNameEl = document.getElementById('file-name-text');
  if (!fileNameEl) return;
  fileNameEl.textContent = name;
  const isLoaded = !!name && name !== 'Open a 3DM file…';
  fileNameEl.classList.toggle('loaded', isLoaded);
  if (isLoaded) document.getElementById('left-panel')?.classList.add('hidden');
  S.currentFileName = isLoaded ? name.replace(/\.[^.]+$/, '') : '';
  S.currentFileNameWithExt = isLoaded ? name : '';
}

// ── Model info panel ─────────────────────────────────────────────────────────

export function showModelInfo(model, fileSize) {
  const modelInfoEl = document.getElementById('file-info-content') || document.getElementById('model-info');
  let triangles = 0, meshCount = 0;
  model.traverse(child => {
    if (child.isMesh && child.geometry) {
      meshCount++;
      const g = child.geometry;
      triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  const triStr = triangles >= 1e6
    ? (triangles / 1e6).toFixed(1) + 'M tri'
    : triangles >= 1e3
      ? Math.round(triangles / 1e3) + 'K tri'
      : triangles + ' tri';
  const szStr = fileSize >= 1048576
    ? (fileSize / 1048576).toFixed(1) + ' MB'
    : Math.round(fileSize / 1024) + ' KB';
  if (modelInfoEl) {
    let lines = [];
    if (S.currentFileNameWithExt) {
      lines.push(`File: ${S.currentFileNameWithExt}`);
    }
    lines.push(`Unit: ${S.modelUnit || 'Unknown'}`);
    lines.push(`Objects: ${meshCount} meshes (${triStr})`);
    lines.push(`File size: ${szStr}`);

    if (S.parsed3dmFileInfo) {
      const fi = S.parsed3dmFileInfo;
      if (fi.applicationName) lines.push(`App: ${fi.applicationName}`);
      if (fi.createdBy)       lines.push(`Author: ${fi.createdBy}`);
      if (fi.created)         lines.push(`Created: ${fi.created}`);
      if (fi.lastEditedBy)    lines.push(`Edited by: ${fi.lastEditedBy}`);
      if (fi.lastEdited)      lines.push(`Last edited: ${fi.lastEdited}`);
      if (fi.notes)           lines.push(`Notes: ${fi.notes}`);
    }
    modelInfoEl.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    modelInfoEl.classList.remove('hidden');
  }
}

// ── Slider helpers ───────────────────────────────────────────────────────────

export function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 1;
  const val = parseFloat(el.value);
  const pct = ((val - min) / (max - min)) * 100;
  el.style.setProperty('--fill', pct + '%');
}

export function updateAllSliderFills() {
  document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
}

// ── Select icon ──────────────────────────────────────────────────────────────

export function updateSelectIcon(mode) {
  const btn = document.getElementById('btn-select-dropdown');
  if (!btn) return;
  const iconSingle = btn.querySelector('.icon-select-single');
  const iconMulti  = btn.querySelector('.icon-select-multi');
  const iconNone   = btn.querySelector('.icon-select-none');
  if (iconSingle) iconSingle.style.display = mode === 'single' ? '' : 'none';
  if (iconMulti)  iconMulti.style.display  = mode === 'multi'  ? '' : 'none';
  if (iconNone)   iconNone.style.display   = mode === 'none'   ? '' : 'none';
}

export function isPageVisuallyDark() {
  try {
    const panel = document.getElementById('settings-right-panel') || document.body;
    if (panel) {
      const bg = window.getComputedStyle(panel).backgroundColor;
      const match = bg.match(/\d+/g);
      if (match && match.length >= 3) {
        const r = parseInt(match[0]);
        const g = parseInt(match[1]);
        const b = parseInt(match[2]);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness < 128;
      }
    }
  } catch (e) {
    console.warn('Failed to compute style brightness:', e);
  }
  return document.body.classList.contains('dark-theme') ||
         document.documentElement.getAttribute('data-theme') === 'dark' ||
         S.currentTheme === 'dark' ||
         (S.currentTheme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) ||
         (!document.body.classList.contains('light-theme') && document.documentElement.getAttribute('data-theme') !== 'light');
}

export function bindSliderDblClickInput(slider, valSpan, unitStr = '', onChangeCallback = null) {
  const sl = typeof slider === 'string' ? document.getElementById(slider) : slider;
  const sp = typeof valSpan === 'string' ? document.getElementById(valSpan) : valSpan;
  if (!sl || !sp) return;

  // Prevent multiple bindings
  if (sl.dataset.dblclickBound) return;
  sl.dataset.dblclickBound = 'true';

  const triggerInput = () => {
    if (sp.querySelector('.slider-inline-input')) return; // Already editing
    
    const min = parseFloat(sl.min) || 0;
    const max = parseFloat(sl.max) || 100;
    const step = parseFloat(sl.step) || 1;
    const currentVal = parseFloat(sl.value);

    // Create temporary input element
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'slider-inline-input';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = currentVal;
    
    // Style it inline to look premium and perfectly integrate into CAD UI
    input.style.width = '45px';
    input.style.background = 'var(--surface-hi)';
    input.style.border = '1px solid var(--border)';
    input.style.color = 'var(--text)';
    input.style.borderRadius = 'var(--r-sm)';
    input.style.fontSize = '0.75rem';
    input.style.padding = '2px 4px';
    input.style.outline = 'none';
    input.style.textAlign = 'right';
    input.style.marginLeft = '4px';
    input.style.fontFamily = 'inherit';

    const origDisplay = sp.style.display;
    sp.style.display = 'none';
    sp.parentNode.insertBefore(input, sp.nextSibling);

    input.focus();
    input.select();

    let committed = false;
    const commitValue = () => {
      if (committed) return;
      committed = true;
      
      let val = parseFloat(input.value);
      if (isNaN(val)) val = currentVal;
      
      // Clamp values
      val = Math.max(min, Math.min(max, val));
      
      sl.value = val;
      
      // Remove input & restore span
      input.remove();
      sp.style.display = origDisplay;
      
      // Format text
      if (unitStr === '°') {
        sp.textContent = Math.round(val) + unitStr;
      } else if (unitStr === '%') {
        sp.textContent = Math.round(val * 100) + unitStr;
      } else {
        sp.textContent = val.toFixed(2) + unitStr;
      }
      
      // Dispatch events to trigger 3D updates & History Push
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      sl.dispatchEvent(new Event('change', { bubbles: true }));

      // Callback if needed
      if (onChangeCallback) onChangeCallback(val);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitValue();
      } else if (e.key === 'Escape') {
        committed = true;
        input.remove();
        sp.style.display = origDisplay;
      }
    });

    input.addEventListener('blur', commitValue);
  };

  // Bind to dblclick for slider
  sl.addEventListener('dblclick', triggerInput);
  
  // Touchstart double tap detector for mobile
  let lastTap = 0;
  sl.addEventListener('touchstart', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      triggerInput();
    }
    lastTap = now;
  });

  // Bind to click/dblclick on span itself for extra convenience
  sp.style.cursor = 'pointer';
  sp.addEventListener('click', triggerInput);
}

