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
  const btn = document.getElementById('btn-select');
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

