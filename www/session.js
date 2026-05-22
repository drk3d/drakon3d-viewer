import { S } from './state.js';
import { applyDisplayMode } from './display.js';
import { switchToPersp } from './camera.js';
import { updateSliderFill } from './helpers.js';

// ── IndexedDB for last-used file handle ──────────────────────────────────────

export async function openPrefsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rhinoview-prefs', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function saveLastFileHandle(handle) {
  try {
    const db  = await openPrefsDB();
    const tx  = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'lastFile');
  } catch {}
}

export async function loadLastFileHandle() {
  try {
    const db = await openPrefsDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('handles').objectStore('handles').get('lastFile');
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  } catch { return null; }
}

// ── Object identity key (for session serialisation) ──────────────────────────

export function getObjectKey(obj) {
  const a = obj.userData.attributes || {};
  return (a.name || 'obj') + '_L' + (a.layerIndex ?? 0);
}

// ── Save session ─────────────────────────────────────────────────────────────

export function saveSession() {
  const settings = {
    displayMode:        S.currentMode,
    shadowsEnabled:     S.shadowsEnabled,
    groundEnabled:      S.groundEnabled,
    edgeOverlay:        document.getElementById('chk-edges-panel')?.checked ?? true,
    annotationsEnabled: document.getElementById('chk-annotations-panel')?.checked ?? true,
    sunLightEnabled:    document.getElementById('chk-sun-panel')?.checked ?? false,
    sunAzimuth:         parseFloat(document.getElementById('sl-sun-azimuth')?.value ?? 135),
    sunElevation:       parseFloat(document.getElementById('sl-sun-elevation')?.value ?? 45),
    ambientIntensity:   parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.5),
    cameraFov:          parseFloat(document.getElementById('sl-camera-fov')?.value ?? 45),
    dampingFactor:      parseFloat(document.getElementById('sl-damping-panel')?.value ?? 0.5),
    bgType:             document.getElementById('bg-type-select')?.value || 'solid',
    bgC1:               document.getElementById('bg-panel-c1')?.value || '#2a2b2f',
    bgC2:               document.getElementById('bg-panel-c2')?.value || '#18181c',
    bgC3:               document.getElementById('bg-panel-c3')?.value || '#2d3748',
    bgC4:               document.getElementById('bg-panel-c4')?.value || '#1a202c',
    bgRadialSpread:     parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5),
    colorGrading: {
      exposure:    parseFloat(document.getElementById('cg-exposure')?.value    ?? 0),
      contrast:    parseFloat(document.getElementById('cg-contrast')?.value    ?? 0),
      saturation:  parseFloat(document.getElementById('cg-saturation')?.value  ?? 0),
      temperature: parseFloat(document.getElementById('cg-temperature')?.value ?? 0)
    }
  };

  const data = { version: 2, displayMode: S.currentMode, settings, customMaterials: {}, hiddenKeys: [] };

  if (S.currentModel) {
    S.currentModel.traverse(child => {
      if (!child.isMesh || !child.userData.originalMaterial) return;
      if (['rhino-outline', 'rhino-edges', 'selection-outline'].includes(child.name)) return;
      const key = getObjectKey(child);
      if (child.userData.customMaterial) data.customMaterials[key] = { ...child.userData.customMaterial };
      if (!child.visible) data.hiddenKeys.push(key);
    });
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = (S.currentFileName || 'scene') + '.rhinoview';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Load session ─────────────────────────────────────────────────────────────

export async function loadSession(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    resetSettingsToDefault();

    if (data.settings) {
      const s = data.settings;

      S.currentMode    = s.displayMode    || 'shaded';
      S.shadowsEnabled = s.shadowsEnabled ?? false;
      S.groundEnabled  = s.groundEnabled  ?? false;

      const setCheck = (id, val) => {
        const el = document.getElementById(id);
        if (el) { el.checked = val; el.dispatchEvent(new Event('change')); }
      };

      setCheck('chk-edges-panel',       s.edgeOverlay       ?? true);
      setCheck('chk-annotations-panel', s.annotationsEnabled ?? true);
      setCheck('chk-ground-panel',      S.groundEnabled);
      setCheck('chk-shadows-panel',     S.shadowsEnabled);
      setCheck('chk-sun-panel',         s.sunLightEnabled   ?? false);

      const setSlider = (id, valElId, val, formatType = 'float') => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          updateSliderFill(el);
          const valEl = document.getElementById(valElId);
          if (valEl) {
            if (formatType === 'percent') valEl.textContent = Math.round(val * 100) + '%';
            else if (formatType === 'degree') valEl.textContent = Math.round(val) + '°';
            else valEl.textContent = parseFloat(val).toFixed(2);
          }
          el.dispatchEvent(new Event('input'));
        }
      };

      setSlider('sl-ambient-panel', 'sl-ambient-val',     s.ambientIntensity, 'float');
      setSlider('sl-sun-azimuth',   'sl-sun-azimuth-val', s.sunAzimuth,       'degree');
      setSlider('sl-sun-elevation', 'sl-sun-elevation-val', s.sunElevation,   'degree');
      setSlider('sl-camera-fov',    'sl-camera-fov-val',  s.cameraFov,        'degree');
      setSlider('sl-damping-panel', 'sl-damping-val',     s.dampingFactor,    'float');

      const bgSel = document.getElementById('bg-type-select');
      if (bgSel && s.bgType) bgSel.value = s.bgType;

      const setBgColor = (id, swatchId, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          const swatch = document.getElementById(swatchId);
          if (swatch) swatch.style.background = val;
          el.dispatchEvent(new Event('input'));
        }
      };

      setBgColor('bg-panel-c1', 'bg-panel-swatch-c1', s.bgC1);
      setBgColor('bg-panel-c2', 'bg-panel-swatch-c2', s.bgC2);
      setBgColor('bg-panel-c3', 'bg-panel-swatch-c3', s.bgC3);
      setBgColor('bg-panel-c4', 'bg-panel-swatch-c4', s.bgC4);
      setSlider('bg-radial-spread', 'bg-radial-spread-val', s.bgRadialSpread, 'percent');

      if (bgSel) bgSel.dispatchEvent(new Event('change'));

      if (s.colorGrading) {
        const cg = s.colorGrading;
        const setCgSlider = (id, val) => {
          const el = document.getElementById(id);
          if (el && val !== undefined) {
            el.value = val;
            updateSliderFill(el);
            const valEl = document.getElementById(id + '-val');
            if (valEl) valEl.textContent = (val >= 0 ? '+' : '') + parseFloat(val).toFixed(2);
            el.dispatchEvent(new Event('input'));
          }
        };
        setCgSlider('cg-exposure',    cg.exposure);
        setCgSlider('cg-contrast',    cg.contrast);
        setCgSlider('cg-saturation',  cg.saturation);
        setCgSlider('cg-temperature', cg.temperature);
      }
    } else {
      if (data.displayMode) S.currentMode = data.displayMode;
    }

    document.querySelectorAll('#mode-dropdown .dropdown-item').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === S.currentMode);
    });

    if (!S.currentModel) return;

    S.currentModel.traverse(child => {
      if (!child.isMesh || !child.userData.originalMaterial) return;
      if (['rhino-outline', 'rhino-edges', 'selection-outline'].includes(child.name)) return;
      const key = getObjectKey(child);
      if (data.hiddenKeys?.includes(key)) {
        child.visible = false;
        S.hiddenObjects.add(child);
      } else {
        child.visible = true;
      }
      if (data.customMaterials?.[key]) {
        child.userData.customMaterial = { ...data.customMaterials[key] };
      } else {
        delete child.userData.customMaterial;
      }
    });

    applyDisplayMode();
  } catch (e) {
    console.error('Session load failed', e);
    alert('Failed to load session file.');
  }
}

// ── Reset settings to defaults ───────────────────────────────────────────────
// Imported by both loadSession (above) and handleFile (in loaders.js).

export function resetSettingsToDefault() {
  S.currentMode    = 'shaded';
  S.shadowsEnabled = false;
  S.groundEnabled  = false;
  S.selectedObjects = [];
  S.hiddenObjects.clear();

  // Clear measurements (deferred import to avoid loading tools.js at module parse time)
  import('./tools.js').then(m => m.clearMeasurements()).catch(() => {});

  // Clear selection outlines
  import('./selection.js').then(m => m.clearSelection()).catch(() => {});

  document.querySelectorAll('#mode-dropdown .dropdown-item').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === 'shaded');
  });

  const setCheck = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.checked = val; el.dispatchEvent(new Event('change')); }
  };

  setCheck('chk-edges-panel',     true);
  setCheck('chk-annotations-panel', true);
  setCheck('chk-ground-panel',    false);
  setCheck('chk-shadows-panel',   false);
  setCheck('chk-sun-panel',       false);
  setCheck('chk-clipping-enable', false);

  const resetSlider = (id, valElId, val, formatType = 'float') => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      updateSliderFill(el);
      const valEl = document.getElementById(valElId);
      if (valEl) {
        if (formatType === 'percent') valEl.textContent = Math.round(val * 100) + '%';
        else if (formatType === 'degree') valEl.textContent = Math.round(val) + '°';
        else valEl.textContent = parseFloat(val).toFixed(2);
      }
      el.dispatchEvent(new Event('input'));
    }
  };

  resetSlider('sl-ambient-panel', 'sl-ambient-val',       0.5,  'float');
  resetSlider('sl-sun-azimuth',   'sl-sun-azimuth-val',   135,  'degree');
  resetSlider('sl-sun-elevation', 'sl-sun-elevation-val', 45,   'degree');
  resetSlider('sl-camera-fov',    'sl-camera-fov-val',    45,   'degree');
  resetSlider('sl-damping-panel', 'sl-damping-val',       0.5,  'float');
  resetSlider('bg-radial-spread', 'bg-radial-spread-val', 0.5,  'percent');

  const ttToggleBtn = document.getElementById('btn-tt-toggle');
  if (ttToggleBtn?.classList.contains('active')) ttToggleBtn.click();
  const springSlider = document.getElementById('tt-spring-slider');
  if (springSlider) {
    springSlider.value = 0;
    updateSliderFill(springSlider);
    const springVal = document.getElementById('tt-spring-val');
    if (springVal) springVal.textContent = '0.0';
  }

  document.getElementById('btn-cg-reset')?.click();

  const resetBgColor = (id, swatchId, val) => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      const swatch = document.getElementById(swatchId);
      if (swatch) swatch.style.background = val;
      el.dispatchEvent(new Event('input'));
    }
  };
  resetBgColor('bg-panel-c1', 'bg-panel-swatch-c1', '#2a2b2f');
  resetBgColor('bg-panel-c2', 'bg-panel-swatch-c2', '#18181c');
  resetBgColor('bg-panel-c3', 'bg-panel-swatch-c3', '#2d3748');
  resetBgColor('bg-panel-c4', 'bg-panel-swatch-c4', '#1a202c');

  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) { bgSel.value = 'solid'; bgSel.dispatchEvent(new Event('change')); }

  switchToPersp();
}
