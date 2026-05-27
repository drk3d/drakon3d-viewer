import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode } from './display.js';
import { switchToPersp, getCustomViews } from './camera.js';
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

export async function saveSession(customFileName = null) {
  if (!S.currentModel) {
    alert('No model loaded to save.');
    return;
  }

  const { showLoading, hideLoading } = await import('./helpers.js');
  showLoading('Saving session file…');

  const toHide = [];
  try {
    const settings = {
      displayMode:        S.currentMode,
      shadowsEnabled:     S.shadowsEnabled,
      groundEnabled:      S.groundEnabled,
      edgeOverlay:        document.getElementById('chk-edges-panel')?.checked ?? true,
      annotationsEnabled: document.getElementById('chk-annotations-panel')?.checked ?? true,
      sunLightEnabled:    document.getElementById('chk-sun-panel')?.checked ?? false,
      sunAzimuth:         parseFloat(document.getElementById('sl-sun-azimuth')?.value ?? 135),
      sunElevation:       parseFloat(document.getElementById('sl-sun-elevation')?.value ?? 45),
      sunIntensity:       parseFloat(document.getElementById('sl-sun-intensity')?.value ?? 1.8),
      ambientIntensity:   parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.5),
      cameraFov:          parseFloat(document.getElementById('sl-camera-fov')?.value ?? 45),
      dampingFactor:      parseFloat(document.getElementById('sl-damping-panel')?.value ?? 0.5),
      envIntensity:       parseFloat(document.getElementById('sl-env-intensity')?.value ?? 1.0),
      envPreset:          document.getElementById('env-preset-select')?.value || 'studio',
      bgType:             document.getElementById('bg-type-select')?.value || 'solid',
      bgC1:               document.getElementById('bg-panel-c1')?.value || '#2a2b2f',
      bgC2:               document.getElementById('bg-panel-c2')?.value || '#18181c',
      bgC3:               document.getElementById('bg-panel-c3')?.value || '#2d3748',
      bgC4:               document.getElementById('bg-panel-c4')?.value || '#1a202c',
      bgRadialSpread:     parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5),
      
      // Clipping Plane Settings
      clippingEnabled:    S.clippingEnabled,
      clippingHeight:     parseFloat(document.getElementById('clip-height')?.value ?? 0),
      clippingRotX:       parseFloat(document.getElementById('clipping-panel')?.dataset.rotX ?? 0),
      clippingRotY:       parseFloat(document.getElementById('clipping-panel')?.dataset.rotY ?? 180),
      clippingMode:       document.querySelector('.clip-axis-btn[data-clip-mode].active')?.dataset.clipMode ?? 'translate',
      clippingAxis:       document.querySelector('.clip-axis-btn[data-axis].active')?.dataset.axis ?? 'z',

      colorGrading: {
        exposure:    parseFloat(document.getElementById('cg-exposure')?.value    ?? 0),
        contrast:    parseFloat(document.getElementById('cg-contrast')?.value    ?? 0),
        saturation:  parseFloat(document.getElementById('cg-saturation')?.value  ?? 0),
        temperature: parseFloat(document.getElementById('cg-temperature')?.value ?? 0)
      }
    };

    const cameraState = {
      position:   S.camera.position.toArray(),
      target:     S.controls.target.toArray(),
      up:         S.camera.up.toArray(),
      projection: S.camera.isOrthographicCamera ? 'parallel' : 'perspective'
    };

    const measurements = S.completedMeasurements.map(m => ({
      id:   m.id,
      p1:   [m.p1.x, m.p1.y, m.p1.z],
      p2:   [m.p2.x, m.p2.y, m.p2.z],
      dist: m.dist
    }));

    const data = {
      version:             3, // version 3 includes unified geometry and annotations
      displayMode:         S.currentMode,
      settings,
      cameraState,
      customMaterials:     {},
      hiddenKeys:          [],
      namedViews:          getCustomViews(),
      rhinoNamedViews:     S.parsedNamedViews || [],
      parsedLayers:        S.parsedLayers || [],
      completedMeasurements: measurements
    };

    // Temporarily hide UI outlines during GLB export
    S.currentModel.traverse(child => {
      if (['rhino-outline', 'selection-outline', 'rhino-edges', 'ground-plane'].includes(child.name)) {
        if (child.visible) { toHide.push(child); child.visible = false; }
        return;
      }
      if (child.isMesh && child.userData.originalMaterial) {
        const key = getObjectKey(child);
        if (child.userData.customMaterial) data.customMaterials[key] = { ...child.userData.customMaterial };
        if (!child.visible) data.hiddenKeys.push(key);
      }
    });

    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    exporter.parse(
      S.currentModel,
      async (glbBuffer) => {
        try {
          toHide.forEach(c => { c.visible = true; });

          // Serialize metadata to UTF-8
          const jsonStr = JSON.stringify(data);
          const jsonBytes = new TextEncoder().encode(jsonStr);

          // Binary Package Layout:
          // 1. Magic Bytes (4 bytes): "RV3D"
          // 2. Version (4 bytes): 1 (uint32)
          // 3. JSON Length (4 bytes): json length (uint32)
          // 4. JSON UTF-8 Payload (jsonBytes.byteLength bytes)
          // 5. GLB Binary Payload (glbBuffer.byteLength bytes)
          const totalLength = 4 + 4 + 4 + jsonBytes.byteLength + glbBuffer.byteLength;
          const combinedBuffer = new ArrayBuffer(totalLength);
          const view = new DataView(combinedBuffer);
          const uint8 = new Uint8Array(combinedBuffer);

          // Magic "RV3D" (0x52, 0x56, 0x33, 0x44)
          view.setUint8(0, 0x52);
          view.setUint8(1, 0x56);
          view.setUint8(2, 0x33);
          view.setUint8(3, 0x44);

          // Version = 1
          view.setUint32(4, 1, true);

          // JSON Length
          view.setUint32(8, jsonBytes.byteLength, true);

          // Copy JSON payload
          uint8.set(jsonBytes, 12);

          // Copy GLB payload
          uint8.set(new Uint8Array(glbBuffer), 12 + jsonBytes.byteLength);

          const blob = new Blob([combinedBuffer], { type: 'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          let finalName = customFileName || S.currentFileName || 'scene';
          if (finalName.toLowerCase().endsWith('.rhinoview')) {
            finalName = finalName.slice(0, -10);
          }
          a.download = finalName + '.rhinoview';
          a.click();
          URL.revokeObjectURL(a.href);

          if (customFileName) {
            const { setFileName } = await import('./helpers.js');
            setFileName(finalName + '.rhinoview');
          }

          hideLoading();
        } catch (callbackErr) {
          toHide.forEach(c => { c.visible = true; });
          console.error('[Session Export] Callback error:', callbackErr);
          alert('Failed to save session file: ' + callbackErr.message);
          hideLoading();
        }
      },
      (err) => {
        toHide.forEach(c => { c.visible = true; });
        console.error('[Session Export] GLB export failed:', err);
        alert('Failed to pack geometry into session file.');
        hideLoading();
      },
      { binary: true }
    );
  } catch (err) {
    toHide.forEach(c => { c.visible = true; });
    console.error('[Session Export] error:', err);
    alert('Failed to save session file: ' + err.message);
    hideLoading();
  }
}

// ── Load session ─────────────────────────────────────────────────────────────

export async function loadSession(file) {
  const { showLoading, hideLoading } = await import('./helpers.js');
  showLoading('Loading session file…');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const view = new DataView(arrayBuffer);

    // Check magic bytes
    let isBinaryPackage = false;
    if (arrayBuffer.byteLength >= 12) {
      const magic0 = view.getUint8(0);
      const magic1 = view.getUint8(1);
      const magic2 = view.getUint8(2);
      const magic3 = view.getUint8(3);
      if (magic0 === 0x52 && magic1 === 0x56 && magic2 === 0x33 && magic3 === 0x44) {
        isBinaryPackage = true;
      }
    }

    let data;
    let glbBuffer = null;

    if (isBinaryPackage) {
      const version = view.getUint32(4, true);
      const jsonLength = view.getUint32(8, true);

      const jsonBytes = new Uint8Array(arrayBuffer, 12, jsonLength);
      const jsonStr = new TextDecoder().decode(jsonBytes);
      data = JSON.parse(jsonStr);

      const glbStart = 12 + jsonLength;
      glbBuffer = arrayBuffer.slice(glbStart);

      // 1. Load the packed geometry first
      const { loadGeometryFromGLB } = await import('./loaders.js');
      await loadGeometryFromGLB(glbBuffer, file.name, glbBuffer.byteLength);
    } else {
      // Legacy JSON-only session file
      resetSettingsToDefault();
      const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
      data = JSON.parse(text);
    }

    // 2. Restore settings
    if (data.settings) {
      const s = data.settings;

      S.currentMode    = s.displayMode    || 'shaded';
      S.shadowsEnabled = s.shadowsEnabled ?? true;
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

      // Restore env preset
      if (s.envPreset) {
        const envSel = document.getElementById('env-preset-select');
        if (envSel) { envSel.value = s.envPreset; envSel.dispatchEvent(new Event('change')); }
      }
      setSlider('sl-env-intensity', 'sl-env-intensity-val', s.envIntensity ?? 1.0, 'float');
      setSlider('sl-ambient-panel', 'sl-ambient-val',     s.ambientIntensity, 'float');
      setSlider('sl-sun-intensity', 'sl-sun-intensity-val', s.sunIntensity ?? 1.8, 'float');
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

      // Restore Clipping Plane
      if (s.clippingEnabled !== undefined) {
        setCheck('chk-clipping-enable', s.clippingEnabled);
        setSlider('clip-height', 'clip-height-val', s.clippingHeight ?? 0, 'float');
        
        const cp = document.getElementById('clipping-panel');
        if (cp) {
          cp.dataset.rotX = s.clippingRotX ?? 0;
          cp.dataset.rotY = s.clippingRotY ?? 180;
        }

        // Mode (translate / rotate)
        if (s.clippingMode) {
          document.querySelectorAll('.clip-axis-btn[data-clip-mode]').forEach(b => {
            b.classList.toggle('active', b.dataset.clipMode === s.clippingMode);
          });
          if (S.clippingTransformControls) S.clippingTransformControls.setMode(s.clippingMode);
        }

        // Axis (x / y / z)
        if (s.clippingAxis) {
          document.querySelectorAll('.clip-axis-btn[data-axis]').forEach(b => {
            b.classList.toggle('active', b.dataset.axis === s.clippingAxis);
          });
        }
        
        const { updateClippingPlane, setupClippingHelper } = await import('./tools.js');
        updateClippingPlane();
        if (s.clippingEnabled) {
          S.renderer.clippingPlanes = [S.clippingPlane];
          setupClippingHelper();
          document.getElementById('clipping-panel')?.classList.remove('hidden');
          document.getElementById('btn-tool-clipping')?.classList.add('active');
        } else {
          S.renderer.clippingPlanes = [];
          document.getElementById('clipping-panel')?.classList.add('hidden');
          document.getElementById('btn-tool-clipping')?.classList.remove('active');
        }
      }

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

    // 3. Restore CAD layers
    if (data.parsedLayers) {
      S.parsedLayers = data.parsedLayers;
      const { renderLayerUI, updateLayerVisibility } = await import('./layers.js?v=1.2.87');
      renderLayerUI();
      updateLayerVisibility();
    }

    // 4. Restore Rhino named views
    if (data.rhinoNamedViews) {
      S.parsedNamedViews = data.rhinoNamedViews;
    }

    // 5. Restore custom named views
    if (data.namedViews) {
      const base = file.name.replace(/\.[^.]+$/, '');
      localStorage.setItem(`rhino_custom_views_${base}`, JSON.stringify(data.namedViews));
      const { renderNamedViewsUI } = await import('./camera.js');
      renderNamedViewsUI();
    }

    // 6. Restore hidden items and custom materials
    if (S.currentModel) {
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
    }

    // 7. Restore completed measurements
    if (data.completedMeasurements) {
      const { reconstructMeasurements } = await import('./tools.js');
      reconstructMeasurements(data.completedMeasurements);
    }

    // 8. Restore camera state
    if (data.cameraState) {
      const cs = data.cameraState;
      const pos = new THREE.Vector3(...cs.position);
      const tgt = new THREE.Vector3(...cs.target);
      const up  = new THREE.Vector3(...cs.up);

      S.perspCamera.position.copy(pos);
      S.controls.target.copy(tgt);
      S.perspCamera.up.copy(up);
      S.perspCamera.updateProjectionMatrix();

      if (S.orthoCamera) {
        S.orthoCamera.position.copy(pos);
        S.orthoCamera.up.copy(up);
        S.orthoCamera.updateProjectionMatrix();
      }

      if (cs.projection === 'parallel') {
        const { switchToOrtho } = await import('./camera.js');
        switchToOrtho();
      } else {
        const { switchToPersp } = await import('./camera.js');
        switchToPersp();
      }

      S.controls.update();
    }

    document.querySelectorAll('#mode-dropdown .dropdown-item').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === S.currentMode);
    });

    applyDisplayMode();
    hideLoading();
  } catch (e) {
    console.error('Session load failed', e);
    alert('Failed to load session file.');
    hideLoading();
  }
}

// ── Reset settings to defaults ───────────────────────────────────────────────
// Imported by both loadSession (above) and handleFile (in loaders.js).

export function resetSettingsToDefault() {
  S.currentMode    = 'shaded';
  S.shadowsEnabled = true;
  S.groundEnabled  = false;
  S.selectedObjects = [];
  S.hiddenObjects.clear();

  // Clear measurements (deferred import to avoid loading tools.js at module parse time)
  import('./tools.js').then(m => m.clearMeasurements()).catch(() => {});

  // Clear selection outlines
  import('./selection.js?v=1.2.87').then(m => m.clearSelection()).catch(() => {});

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
  setCheck('chk-shadows-panel',   true);
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

  resetSlider('sl-env-intensity', 'sl-env-intensity-val', 1.0,  'float');
  resetSlider('sl-ambient-panel', 'sl-ambient-val',       0.5,  'float');
  resetSlider('sl-sun-intensity', 'sl-sun-intensity-val', 1.8,  'float');
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
  resetBgColor('bg-panel-c1', 'bg-panel-swatch-c1', '#ffffff');
  resetBgColor('bg-panel-c2', 'bg-panel-swatch-c2', '#e0e0e0');
  resetBgColor('bg-panel-c3', 'bg-panel-swatch-c3', '#f0f0f0');
  resetBgColor('bg-panel-c4', 'bg-panel-swatch-c4', '#cccccc');

  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) { bgSel.value = 'solid'; bgSel.dispatchEvent(new Event('change')); }

  switchToPersp();
}
