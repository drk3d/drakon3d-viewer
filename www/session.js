import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode, applyCustomToMaterial } from './display.js';
import { switchToPersp, getCustomViews } from './camera.js';
import { updateSliderFill, isPageVisuallyDark } from './helpers.js';
import { History } from './history.js';

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

// (No GLB-level mesh compression. We tried meshopt FILTER/QUANTIZE and Draco;
// FILTER gave ~0 reduction, QUANTIZE + gltf-transform collapsed geometry on
// round-trip, and Draco's browser encoder couldn't be loaded via CDN with the
// current setup. So we keep only the gzip wrap below — browser-native, fast,
// and the only step actually saving bytes on the GLB binary right now.
// Real geometry compression will require a proper bundled Draco WASM build.)

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
      edgeThresholdAngle: parseFloat(document.getElementById('sl-edge-angle')?.value ?? 30),
      annotationsEnabled: document.getElementById('chk-annotations-panel')?.checked ?? true,
      sunLightEnabled:    document.getElementById('chk-sun-panel')?.checked ?? false,
      sunAzimuth:         parseFloat(document.getElementById('sl-sun-azimuth')?.value ?? 135),
      sunElevation:       parseFloat(document.getElementById('sl-sun-elevation')?.value ?? 45),
      sunIntensity:       parseFloat(document.getElementById('sl-sun-intensity')?.value ?? 1.8),
      ambientIntensity:   parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.4),
      aoIntensity:        parseFloat(document.getElementById('sl-ao-intensity')?.value ?? 0.40),
      cameraFov:          parseFloat(document.getElementById('sl-camera-fov')?.value ?? 45),
      dampingFactor:      parseFloat(document.getElementById('sl-damping-panel')?.value ?? 0.5),
      envIntensity:       parseFloat(document.getElementById('sl-env-intensity')?.value ?? 1.00),
      measurementScale:   parseFloat(document.getElementById('sl-measure-scale')?.value ?? 1.0),
      annotationScale:    parseFloat(document.getElementById('sl-annotation-scale')?.value ?? 1.0),
      hdrRotation:        parseInt(document.getElementById('sl-hdr-rotation')?.value ?? 59),
      envPreset:          document.getElementById('env-preset-select')?.value || 'studio',
      bgType:             document.getElementById('bg-type-select')?.value || 'solid',
      bgC1:               document.getElementById('bg-panel-c1')?.value || '#2a2b2f',
      bgC2:               document.getElementById('bg-panel-c2')?.value || '#18181c',
      bgC3:               document.getElementById('bg-panel-c3')?.value || '#2d3748',
      bgC4:               document.getElementById('bg-panel-c4')?.value || '#1a202c',
      bgRadialSpread:     parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5),
      modelUnit:          S.modelUnit,
      
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

    const measurements = S.completedMeasurements.map(m => {
      const saved = {
        id:   m.id,
        type: m.type || 'distance',
        p1:   [m.p1.x, m.p1.y, m.p1.z],
        p2:   [m.p2.x, m.p2.y, m.p2.z]
      };
      if (m.type === 'angle') {
        saved.center = [m.center.x, m.center.y, m.center.z];
        saved.angle = m.angle;
      } else {
        saved.dist = m.dist;
      }
      return saved;
    });

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
      parsedAnnotations:   S.parsedAnnotations || [],
      completedMeasurements: measurements,
      customHdrData:       S.customHdrData || null,
      customHdrName:       S.customHdrName || null
    };

    const activeMaterials = new Map();

    // Temporarily hide UI outlines and apply Rendered/Custom PBR materials during GLB export
    S.currentModel.traverse(child => {
      if (['rhino-outline', 'selection-outline', 'rhino-edges', 'ground-plane'].includes(child.name)) {
        if (child.visible) { toHide.push(child); child.visible = false; }
        return;
      }
      if (child.isMesh && child.userData.originalMaterial) {
        const key = getObjectKey(child);
        if (child.userData.customMaterial) data.customMaterials[key] = { ...child.userData.customMaterial };
        if (!child.visible) data.hiddenKeys.push(key);

        // Keep track of active material to restore later
        activeMaterials.set(child, child.material);

        // Temporarily apply Rendered-mode material (with custom overrides) so they get exported in GLB
        const base = child.userData.renderedMaterial || child.userData.originalMaterial;
        const m = base.clone();
        if (child.userData.materialColor) m.color.copy(child.userData.materialColor);
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.envMap = null;
        m.envMapIntensity = 1.0;

        applyCustomToMaterial(m, child.userData.customMaterial);
        child.material = m;
      }
    });

    // Exclude annotations group from GLB export so they aren't baked as static outline-prone meshes
    const annGroup = S.annotationGroup;
    const annParent = annGroup?.parent;
    if (annGroup && annParent) {
      annParent.remove(annGroup);
    }

    const restoreSessionState = () => {
      // Restore annotations parent
      if (annGroup && annParent && !annGroup.parent) {
        annParent.add(annGroup);
      }
      // Restore meshes materials
      activeMaterials.forEach((mat, mesh) => {
        mesh.material = mat;
      });
      // Restore outlines visibility
      toHide.forEach(c => { c.visible = true; });
    };

    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    exporter.parse(
      S.currentModel,
      async (glbBuffer) => {
        try {
          restoreSessionState();

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

          // Copy GLB binary payload (no extra compression — see comment block
          // above compressGlbWithDraco/Meshopt discussion in this file).
          uint8.set(new Uint8Array(glbBuffer), 12 + jsonBytes.byteLength);

          // Gzip the whole RV3D container. Loaders auto-detect compression via
          // the gzip magic (0x1f 0x8b).
          let finalBuffer = combinedBuffer;
          if (typeof CompressionStream === 'function') {
            try {
              const cs = new CompressionStream('gzip');
              const writer = cs.writable.getWriter();
              writer.write(new Uint8Array(combinedBuffer));
              writer.close();
              finalBuffer = await new Response(cs.readable).arrayBuffer();
            } catch (gzipErr) {
              console.warn('[Session Export] gzip failed, saving uncompressed:', gzipErr);
              finalBuffer = combinedBuffer;
            }
          }

          console.log('[Session Export] sizes (bytes):', {
            raw_glb: glbBuffer.byteLength,
            after_gzip: finalBuffer.byteLength,
          });

          const blob = new Blob([finalBuffer], { type: 'application/octet-stream' });
          let finalName = customFileName || S.currentFileName || 'scene';
          if (finalName.toLowerCase().endsWith('.rhv')) finalName = finalName.slice(0, -4);
          const fullFileName = finalName + '.rhv';

          if (window.Capacitor && window.Capacitor.isPluginAvailable('FileOpener')) {
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = async () => {
              const base64Data = reader.result;
              try {
                await window.Capacitor.Plugins.FileOpener.saveFile({
                  base64Data: base64Data,
                  fileName: fullFileName,
                  mimeType: 'application/octet-stream'
                });
                alert('Session saved to Downloads folder!');
              } catch (err) {
                console.error('[Capacitor Save] Failed to save session:', err);
                alert('Failed to save session: ' + err);
              }
            };
          } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fullFileName;
            a.click();
            URL.revokeObjectURL(a.href);
          }

          if (customFileName) {
            const { setFileName } = await import('./helpers.js');
            setFileName(finalName + '.rhv');
          }

          hideLoading();
        } catch (callbackErr) {
          restoreSessionState();
          console.error('[Session Export] Callback error:', callbackErr);
          alert('Failed to save session file: ' + callbackErr.message);
          hideLoading();
        }
      },
      (err) => {
        restoreSessionState();
        console.error('[Session Export] GLB export failed:', err);
        alert('Failed to pack geometry into session file.');
        hideLoading();
      },
      { binary: true }
    );
  } catch (err) {
    if (annGroup && annParent && !annGroup.parent) {
      annParent.add(annGroup);
    }
    activeMaterials.forEach((mat, mesh) => {
      mesh.material = mat;
    });
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

  // Suppress history recording for the duration of restore — dispatched
  // input/change events during settings playback would otherwise fill the
  // undo stack with the entire session reload, drowning the user's history.
  History.suppress = true;
  try {
    let arrayBuffer = await file.arrayBuffer();

    // Auto-detect gzip wrapper (magic 0x1f 0x8b). .rhv files are gzip-wrapped
    // around the RV3D container for a 3–5× size reduction.
    if (arrayBuffer.byteLength >= 2) {
      const head = new Uint8Array(arrayBuffer, 0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b && typeof DecompressionStream === 'function') {
        try {
          const ds = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          writer.write(new Uint8Array(arrayBuffer));
          writer.close();
          arrayBuffer = await new Response(ds.readable).arrayBuffer();
        } catch (gunzipErr) {
          console.warn('[Session Load] gunzip failed, treating as raw:', gunzipErr);
        }
      }
    }

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

      // Restore parsedLayers early so that postProcessModel (called inside loadGeometryFromGLB)
      // can resolve the correct layer colors for shadedMaterial and other color checks.
      if (data.parsedLayers) {
        S.parsedLayers = data.parsedLayers;
      }

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

    // 1.5. Restore custom HDR if embedded
    if (data.customHdrData) {
      S.customHdrData = data.customHdrData;
      S.customHdrName = data.customHdrName || 'Custom HDR';
      
      try {
        const { RGBELoader } = await import('three/addons/loaders/RGBELoader.js');
        const res = await fetch("data:application/octet-stream;base64," + data.customHdrData);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        
        await new Promise((resolve, reject) => {
          const rgbeLoader = new RGBELoader();
          const pmrem = new THREE.PMREMGenerator(S.renderer);
          pmrem.compileEquirectangularShader();
          
          rgbeLoader.load(url, texture => {
            URL.revokeObjectURL(url);
            const envTexture = pmrem.fromEquirectangular(texture).texture;
            texture.dispose();
            pmrem.dispose();
            
            if (S.envMaps['hdr-custom']) S.envMaps['hdr-custom'].dispose();
            S.envMaps['hdr-custom'] = envTexture;
            
            // Enable the custom-HDR option and select it
            const hdrOpt = document.getElementById('opt-hdr-custom');
            if (hdrOpt) { 
              hdrOpt.disabled = false; 
              hdrOpt.textContent = S.customHdrName; 
            }
            resolve();
          }, undefined, reject);
        });
      } catch (hdrErr) {
        console.error('[Session Import] Failed to restore custom HDR:', hdrErr);
      }
    }

    // 2. Restore settings
    if (data.settings) {
      const s = data.settings;

      S.currentMode    = s.displayMode    || 'shaded';
      S.shadowsEnabled = s.shadowsEnabled ?? true;
      S.groundEnabled  = s.groundEnabled  ?? false;
      S.modelUnit      = s.modelUnit       || 'Unknown';

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
            else if (formatType === 'xScale') valEl.textContent = parseFloat(val).toFixed(1) + 'x';
            else valEl.textContent = parseFloat(val).toFixed(2);
          }
          el.dispatchEvent(new Event('input'));
        }
      };

      // Restore env preset
      if (s.envPreset) {
        const envSel = document.getElementById('env-preset-select');
        if (envSel) {
          const hasPreset = S.envMaps && S.envMaps[s.envPreset];
          if (hasPreset) {
            envSel.value = s.envPreset;
          } else {
            console.warn(`[Session Import] Environment preset '${s.envPreset}' is not loaded. Falling back to default 'studio'.`);
            envSel.value = 'studio';
          }
          envSel.dispatchEvent(new Event('change'));
        }
      }
      setSlider('sl-env-intensity', 'sl-env-intensity-val', s.envIntensity ?? 1.0, 'float');
      setSlider('sl-measure-scale', 'sl-measure-scale-val', s.measurementScale ?? s.annotationScale ?? 1.0, 'xScale');
      setSlider('sl-annotation-scale', 'sl-annotation-scale-val', s.annotationScale ?? 1.0, 'xScale');
      setSlider('sl-hdr-rotation', 'sl-hdr-rotation-val', s.hdrRotation ?? 0, 'degree');
      setSlider('sl-ambient-panel', 'sl-ambient-val',     s.ambientIntensity, 'float');
      setSlider('sl-ao-intensity',  'sl-ao-intensity-val', s.aoIntensity ?? (S.modeSettings[S.currentMode]?.aoIntensity ?? 0.40), 'float');
      setSlider('sl-sun-intensity', 'sl-sun-intensity-val', s.sunIntensity ?? 1.8, 'float');
      setSlider('sl-sun-azimuth',   'sl-sun-azimuth-val', s.sunAzimuth,       'degree');
      setSlider('sl-sun-elevation', 'sl-sun-elevation-val', s.sunElevation,   'degree');
      setSlider('sl-camera-fov',    'sl-camera-fov-val',  s.cameraFov,        'degree');
      setSlider('sl-damping-panel', 'sl-damping-val',     s.dampingFactor,    'float');

      if (s.edgeThresholdAngle !== undefined) {
        S.edgeThresholdAngle = s.edgeThresholdAngle;
      }
      setSlider('sl-edge-angle', 'sl-edge-angle-val', S.edgeThresholdAngle ?? 30, 'degree');

      const bgSel = document.getElementById('bg-type-select');
      if (bgSel && s.bgType) bgSel.value = s.bgType;

      const setBgColor = (id, swatchId, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          const swatch = document.getElementById(swatchId);
          if (swatch) swatch.style.background = val;
          const wrapper = el.parentNode;
          if (wrapper && wrapper.classList.contains('clr-field')) {
            wrapper.style.color = val;
            const btn = wrapper.querySelector('button');
            if (btn) btn.style.backgroundColor = val;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
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
        // Mark as already-initialized so future toggle off/on preserves this
        // restored position instead of re-running the default-position logic.
        S.clippingHasBeenInitialized = true;
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
      const { renderLayerUI, updateLayerVisibility } = await import('./layers.js');
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
      try {
        localStorage.setItem(`rhino_custom_views_${base}`, JSON.stringify(data.namedViews));
      } catch (e) {
        console.warn('Failed to save session views to localStorage:', e);
      }
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
          if (child.userData.customMaterial.mapTexture !== null && child.userData.customMaterial.mapTexture !== undefined) {
            const orig = child.userData.renderedMaterial || child.userData.originalMaterial;
            if (orig && orig.map) {
              child.userData.customMaterial.mapTexture = orig.map;
            } else {
              child.userData.customMaterial.mapTexture = null;
            }
          }
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

    // 8.5. Restore annotations
    if (data.parsedAnnotations) {
      S.parsedAnnotations = data.parsedAnnotations;
      const { createAnnotationSprites } = await import('./annotations.js');
      await createAnnotationSprites();
    }

    // Sync display mode dropdown UI
    const dropdown = document.getElementById('mode-dropdown');
    if (dropdown) {
      const activeItem = dropdown.querySelector(`.dropdown-item[data-mode="${S.currentMode}"]`);
      if (activeItem) {
        dropdown.querySelectorAll('.dropdown-item').forEach(b => b.classList.toggle('active', b === activeItem));
        const triggerBtn = document.getElementById('btn-mode-dropdown');
        if (triggerBtn) {
          const label = activeItem.querySelector('span').textContent.split(' ')[0];
          const triggerLabel = triggerBtn.querySelector('span');
          if (triggerLabel) triggerLabel.textContent = label;
          triggerBtn.title = `Display Mode (${label})`;
          const svg = activeItem.querySelector('svg').cloneNode(true);
          const oldSvg = triggerBtn.querySelector('svg');
          if (oldSvg) triggerBtn.replaceChild(svg, oldSvg);
        }
      }
    }

    // Sync AO Intensity slider row visibility
    const slAoInt = document.getElementById('sl-ao-intensity');
    const aoSliderRow = slAoInt?.closest('.slider-row');
    const settings = S.modeSettings[S.currentMode];
    if (settings && settings.aoIntensity !== undefined) {
      if (aoSliderRow) aoSliderRow.classList.remove('hidden');
    } else {
      if (aoSliderRow) aoSliderRow.classList.add('hidden');
    }

    applyDisplayMode();
    hideLoading();
  } catch (e) {
    console.error('Session load failed', e);
    alert('Failed to load session file.');
    hideLoading();
  } finally {
    History.suppress = false;
    // Drop anything that snuck in via History.clear in clearCurrentModel;
    // the restored session represents a fresh starting point for undo/redo.
    History.clear();
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

  // Reset per-mode visibility settings
  S.modeSettings = {
    wireframe: { edges: true, curves: true, ground: false, shadows: false, annotations: true },
    shaded: { edges: true, curves: true, ground: false, shadows: true, annotations: true },
    arctic: { edges: false, curves: false, ground: true, shadows: true, annotations: true, aoIntensity: 0.70 },
    rendered: { edges: false, curves: false, ground: true, shadows: true, annotations: true, aoIntensity: 0.40 },
    technical: { edges: true, curves: true, ground: false, shadows: false, annotations: true }
  };

  // Clear custom HDR state
  S.customHdrData = null;
  S.customHdrName = null;
  const hdrOpt = document.getElementById('opt-hdr-custom');
  if (hdrOpt) {
    hdrOpt.disabled = true;
    hdrOpt.textContent = 'No Custom HDR';
  }

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
        else if (formatType === 'xScale') valEl.textContent = parseFloat(val).toFixed(1) + 'x';
        else valEl.textContent = parseFloat(val).toFixed(2);
      }
      el.dispatchEvent(new Event('input'));
    }
  };

  resetSlider('sl-env-intensity', 'sl-env-intensity-val', 1.00,  'float');
  resetSlider('sl-measure-scale', 'sl-measure-scale-val', 1.0,  'xScale');
  resetSlider('sl-annotation-scale', 'sl-annotation-scale-val', 1.0, 'xScale');
  resetSlider('sl-hdr-rotation', 'sl-hdr-rotation-val', 59,    'degree');
  resetSlider('sl-ambient-panel', 'sl-ambient-val',       0.55,  'float');
  resetSlider('sl-sun-intensity', 'sl-sun-intensity-val', 1.8,  'float');
  resetSlider('sl-sun-azimuth',   'sl-sun-azimuth-val',   135,  'degree');
  resetSlider('sl-sun-elevation', 'sl-sun-elevation-val', 45,   'degree');
  resetSlider('sl-camera-fov',    'sl-camera-fov-val',    45,   'degree');
  resetSlider('sl-damping-panel', 'sl-damping-val',       0.5,  'float');
  resetSlider('bg-radial-spread', 'bg-radial-spread-val', 0.5,  'percent');
  resetSlider('sl-edge-angle',    'sl-edge-angle-val',    30,   'degree');
  S.edgeThresholdAngle = 30;

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

  const isDark = isPageVisuallyDark();

  const defaultBg  = isDark ? '#24252a' : '#ffffff';
  const defaultBg2 = isDark ? '#1c1d22' : '#f3f4f6';
  const defaultBg3 = isDark ? '#1e293b' : '#e5e7eb';
  const defaultBg4 = isDark ? '#0f172a' : '#d1d5db';

  const resetBgColor = (id, swatchId, val) => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      const swatch = document.getElementById(swatchId);
      if (swatch) swatch.style.background = val;
      const wrapper = el.parentNode;
      if (wrapper && wrapper.classList.contains('clr-field')) {
        wrapper.style.color = val;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  resetBgColor('bg-panel-c1', 'bg-panel-swatch-c1', defaultBg);
  resetBgColor('bg-panel-c2', 'bg-panel-swatch-c2', defaultBg2);
  resetBgColor('bg-panel-c3', 'bg-panel-swatch-c3', defaultBg3);
  resetBgColor('bg-panel-c4', 'bg-panel-swatch-c4', defaultBg4);

  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) { bgSel.value = 'solid'; bgSel.dispatchEvent(new Event('change')); }

  switchToPersp();
}
