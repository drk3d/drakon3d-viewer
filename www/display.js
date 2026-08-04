import * as THREE from 'three';
import { S } from './state.js';
import { setupLights, updateGroundAppearance, applyFileSunSettings } from './lighting.js';
import { isPageVisuallyDark } from './helpers.js';

// ── Skybox sphere for rendered mode (bypasses tone mapping) ─────────────────
// In rendered mode with ACES tone mapping, scene.background color gets compressed.
// We add a huge BackSide sphere with toneMapped:false that bypasses the tone
// mapping pipeline, so the user-set bg color shows exactly. For other modes,
// scene.background is used directly (no ACES → no compression issue).

// Stub — bg skybox idea reverted. Background still uses scene.background.
// In rendered mode with ACES, white bg compresses to ~86% (light gray).
// Acceptable trade-off for PBR quality.
export function updateBgSkybox() {
  // No-op for now. May reintroduce a proper skybox approach later.
  const sky = S.scene?.getObjectByName('bg-skybox') || S.camera?.getObjectByName('bg-skybox');
  if (sky) {
    sky.geometry?.dispose();
    sky.material?.dispose();
    sky.parent?.remove(sky);
  }
}

export function applySceneBackground() {
  if (S.scene) {
    const bgType = document.getElementById('bg-type-select')?.value || 'solid';
    if (bgType === 'hdr') {
      S.scene.backgroundIntensity = S.scene.environmentIntensity !== null ? S.scene.environmentIntensity : 1.0;
    } else {
      S.scene.backgroundIntensity = 1.0;
    }
  }

  if (S.currentMode === 'technical') { 
    S.scene.background = new THREE.Color(0xffffff); 
    return; 
  }

  const bgType = document.getElementById('bg-type-select')?.value || 'solid';

  // HDR environment as background — uses the same PMREMGenerator texture
  // that drives IBL, so reflections and background match perfectly.
  if (bgType === 'hdr') {
    if (S.environmentMap) {
      S.scene.background = S.environmentMap;
      S.scene.backgroundBlurriness = 0;
    }
    updateBgSkybox();
    return;
  }

  const c1 = document.getElementById('bg-panel-c1')?.value || '#ffffff';
  const c2 = document.getElementById('bg-panel-c2')?.value || '#e0e0e0';

  if (S.bgTexture) { S.bgTexture.dispose(); S.bgTexture = null; }

  if (bgType === 'solid') {
    S.scene.background = new THREE.Color(c1);

  } else if (bgType === 'gradient2') {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 256;
    const ctx  = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    S.bgTexture = new THREE.CanvasTexture(canvas);
    S.bgTexture.mapping = THREE.UVMapping;
    S.scene.background = S.bgTexture;

  } else if (bgType === 'radial') {
    const spread = parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5);
    const size   = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx    = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.72;
    const innerR = outerR * (1.0 - spread);
    const grad   = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = c2;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    S.bgTexture = new THREE.CanvasTexture(canvas);
    S.bgTexture.minFilter = THREE.LinearFilter;
    S.bgTexture.magFilter = THREE.LinearFilter;
    S.scene.background = S.bgTexture;

  } else if (bgType === 'gradient4') {
    const c3 = document.getElementById('bg-panel-c3')?.value || '#2d3748';
    const c4 = document.getElementById('bg-panel-c4')?.value || '#1a202c';
    const hexToRgb = (hex) => {
      const num = parseInt(hex.slice(1), 16);
      return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    };
    const rgb1 = hexToRgb(c1), rgb2 = hexToRgb(c2);
    const rgb3 = hexToRgb(c3), rgb4 = hexToRgb(c4);
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx     = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const data    = imgData.data;
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1), invV = 1.0 - v;
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1), invU = 1.0 - u;
        const w1 = invU * invV, w2 = u * invV, w3 = invU * v, w4 = u * v;
        const idx = (y * size + x) * 4;
        data[idx]   = Math.round(rgb1.r * w1 + rgb2.r * w2 + rgb3.r * w3 + rgb4.r * w4);
        data[idx+1] = Math.round(rgb1.g * w1 + rgb2.g * w2 + rgb3.g * w3 + rgb4.g * w4);
        data[idx+2] = Math.round(rgb1.b * w1 + rgb2.b * w2 + rgb3.b * w3 + rgb4.b * w4);
        data[idx+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    S.bgTexture = new THREE.CanvasTexture(canvas);
    S.bgTexture.minFilter = THREE.LinearFilter;
    S.bgTexture.magFilter = THREE.LinearFilter;
    S.scene.background = S.bgTexture;
  }

  // Update skybox to reflect new bg color (rendered mode only)
  updateBgSkybox();

}

export function applyFileBackground() {
  const bgSel    = document.getElementById('bg-type-select');
  const c1Input  = document.getElementById('bg-panel-c1');
  const c2Input  = document.getElementById('bg-panel-c2');
  const c3Input  = document.getElementById('bg-panel-c3');
  const c4Input  = document.getElementById('bg-panel-c4');
  if (!bgSel) return;

  // bg type — driven by S.fileDefaultBgStyle (loaders.js sets it from
  // rs.backgroundStyle enum, with 4-corner upgrade if RDK XML carries one).
  let newType = 'solid';
  const styleStr = String(S.fileDefaultBgStyle || '').toLowerCase();
  if (styleStr === 'gradient4')      newType = 'gradient4';
  else if (styleStr === 'gradient2') newType = 'gradient2';
  else if (styleStr === 'solid')     newType = 'solid';
  else if (styleStr.includes('gradient')) newType = 'gradient2';
  bgSel.value = newType;

  // Colors — already stored as sRGB hex strings in state (no THREE.Color round-trip).
  const isDark = isPageVisuallyDark();
  const defaults = isDark
    ? { c1: '#24252a', c2: '#1b1c20', c3: '#2d3748', c4: '#1a202c' }
    : { c1: '#ffffff', c2: '#e0e0e0', c3: '#d6dae0', c4: '#bfc4cc' };

  // For gradient4, prefer 4 explicit corners. Map TL→c1, TR→c2, BL→c3, BR→c4
  // (matches the bilinear-weight layout in applySceneBackground's gradient4 branch).
  const hex1 = (newType === 'gradient4' ? S.fileBackgroundColorTL : S.fileBackgroundColorTop)    || defaults.c1;
  const hex2 = (newType === 'gradient4' ? S.fileBackgroundColorTR : S.fileBackgroundColorBottom) || defaults.c2;
  const hex3 = (newType === 'gradient4' ? S.fileBackgroundColorBL : null) || defaults.c3;
  const hex4 = (newType === 'gradient4' ? S.fileBackgroundColorBR : null) || defaults.c4;

  updateColorPickerInput(c1Input, hex1);
  updateColorPickerInput(c2Input, hex2);
  updateColorPickerInput(c3Input, hex3);
  updateColorPickerInput(c4Input, hex4);

  const isSolid  = newType === 'solid';
  const isRadial = newType === 'radial';
  const isGrad4  = newType === 'gradient4';
  document.getElementById('picker-c1')?.classList.remove('hidden');
  document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid);
  document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('bg-radial-section')?.classList.toggle('hidden', !isRadial);

  // Apply file sun settings (on/off, azimuth, elevation, intensity) as well
  try {
    applyFileSunSettings();
  } catch (err) {
    console.warn('[display] applyFileSunSettings err:', err);
  }
}

function updateColorPickerInput(inputEl, hex) {
  if (!inputEl) return;
  inputEl.value = hex;
  const wrapper = inputEl.parentNode;
  if (wrapper && wrapper.classList.contains('clr-field')) {
    wrapper.style.color = hex;
    const btn = wrapper.querySelector('button');
    if (btn) btn.style.backgroundColor = hex;
  }
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Display Modes ────────────────────────────────────────────────────────────

export function clearTechnicalOutlines() {
  if (!S.currentModel) return;
  S.currentModel.traverse(child => {
    if (!child.isMesh) return;
    const outline = child.getObjectByName('rhino-outline');
    if (outline) { outline.material.dispose(); child.remove(outline); }
  });
}

export function addTechnicalOutline(mesh) {
  // BackSide silhouette via uniform scale. Use a small factor so thin objects
  // (walls, plates) don't get overwhelmed by black bleed.
  // 1.03 scale → 3% bleed (e.g. 150mm on a 5m wall) is too much.
  // 1.005 scale → 0.5% bleed is barely visible but still gives a silhouette.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide,
    depthWrite: false
  });
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = 'rhino-outline';
  outline.renderOrder = 1;
  outline.scale.setScalar(1.005);
  mesh.add(outline);
}

export function applyDisplayMode() {
  if (!S.currentModel) return;

  clearTechnicalOutlines();
  setupLights();

  // OutlinePass: enable in technical mode, register all meshes for silhouette.
  if (S.outlinePass) {
    if (S.currentMode === 'technical') {
      S.outlinePass.enabled = true;
      const meshes = [];
      S.currentModel.traverse(c => {
        if (c.isMesh && c.name !== 'rhino-edges' && c.name !== 'rhino-outline'
            && c.name !== 'selection-outline' && c.name !== 'ground-plane') {
          meshes.push(c);
        }
      });
      S.outlinePass.selectedObjects = meshes;
    } else {
      S.outlinePass.enabled = false;
      S.outlinePass.selectedObjects = [];
    }
  }

  if (S.renderer) {
    // Set toneMapping to NoToneMapping across all modes to ensure background colors (like solid white #ffffff)
    // are rendered exactly as specified without dulling or compression, matching the exact color selection
    // and standard CAD/Rhino viewport rendering characteristics.
    S.renderer.toneMapping = THREE.NoToneMapping;
    S.renderer.toneMappingExposure = 1.0;
  }
  if (S.scene) {
    // Dynamically match the background intensity to the environment light intensity (HDR brightness) only if background mode is HDR
    const bgType = document.getElementById('bg-type-select')?.value || 'solid';
    if (bgType === 'hdr') {
      S.scene.backgroundIntensity = S.scene.environmentIntensity !== null ? S.scene.environmentIntensity : 1.0;
    } else {
      S.scene.backgroundIntensity = 1.0;
    }
  }

  // Manage a skybox sphere that bypasses tone mapping so user-set background
  // color appears exactly as intended even in rendered (ACES) mode.
  updateBgSkybox();

  // Environment map (skylight) — Arch + Rendered use it for AO + reflections.
  // Shaded/Wireframe/Technical: no env (flat/specific look).
  if (['arctic', 'rendered'].includes(S.currentMode) && S.environmentMap) {
    S.scene.environment = S.environmentMap;
  } else {
    S.scene.environment = null;
  }

  // Shadow control by mode:
  // - shaded/arctic/rendered: shadows if sun enabled
  // - wireframe/technical: NO shadows (clean look)
  const modeWantsShadows = ['shaded', 'arctic', 'rendered'].includes(S.currentMode);
  if (S.sunLight) {
    S.sunLight.castShadow = modeWantsShadows && S.shadowsEnabled;
    if (modeWantsShadows && S.shadowsEnabled) {
      // Dispose stale shadow map so THREE.js generates a fresh one next frame.
      // Without this, switching shaded→arctic keeps a stale/invalid shadow map
      // and shadows don't reappear until the sun is re-toggled.
      if (S.sunLight.shadow.map) { S.sunLight.shadow.map.dispose(); S.sunLight.shadow.map = null; }
      S.sunLight.shadow.camera.updateProjectionMatrix();
    }
  }
  S.currentModel.traverse(c => {
    if (c.isMesh) {
      c.castShadow    = modeWantsShadows && S.shadowsEnabled;
      c.receiveShadow = modeWantsShadows && S.shadowsEnabled;
    }
  });

  if (S.ssaoPass) S.ssaoPass.enabled = false;
  if (S.gtaoPass) S.gtaoPass.enabled = false;

  // GTAO — world-space radius computed from the model bbox makes AO scale-
  // invariant: 5% of the largest dimension gives the same visual density for
  // a 20 mm jewelry ring and a 50 m building (same ratio the three.js example
  // uses: radius ~0.25 on ~5-unit objects).
  // screenSpaceRadius: false matches the three.js example and avoids the
  // shader path that was producing AO = 1.0 everywhere when true was set.

  const pdParams = {
    lumaPhi: 10.0, depthPhi: 2.0, normalPhi: 3.0,
    radius: 4.0, radiusExponent: 1.0, rings: 2.0, samples: 16
  };

  // 5 % of the model's longest axis — same proportional radius as the three.js
  // GTAO example scene (0.25 unit radius on ~5 unit objects).
  let aoRadiusWS = 1.0;
  if (S.currentModel) {
    const _b = new THREE.Box3();
    S.currentModel.traverse(c => {
      if (c.isMesh && !['rhino-edges','rhino-outline','selection-outline','ground-plane'].includes(c.name))
        _b.expandByObject(c);
    });
    if (!_b.isEmpty()) {
      const _sz = _b.getSize(new THREE.Vector3());
      const _d  = Math.max(_sz.x, _sz.y, _sz.z);
      if (_d > 0) aoRadiusWS = _d * 0.05;
    }
  }

  // thickness must scale with the model. In the GTAO shader:
  //   if (abs(viewDelta.z) < thickness) → accept occluder
  // three.js example uses thickness=1.0 because 1 unit ≈ 1 m there, so 1.0 = 1 m tolerance.
  // Our models are in mm → thickness=1.0 = 1 mm → rejects every real occluder
  // (ring prong 15 mm above band, wall corner 200-2000 mm depth delta, etc.) → AO = 1.0.
  // Fix: scale to model size. 20× radius = ~100% of model bbox, safely covers all adjacent
  // surfaces while staying far below the background (which sits at far = dist × 50).
  const gtaoParams = {
    radius:            aoRadiusWS,          // 5 % of model size (world-space)
    distanceExponent:  1.0,
    thickness:         aoRadiusWS * 20.0,  // scale with model — was 1.0 (only 1 mm!)
    scale:             1.0,
    samples:           16,
    distanceFallOff:   1.0,
    screenSpaceRadius: false               // world-space mode — matches three.js example
  };

  switch (S.currentMode) {
    case 'arctic':
      if (S.gtaoPass) {
        S.gtaoPass.output         = 0; // OUTPUT.Default — blend AO with scene
        S.gtaoPass.enabled        = true;
        // blend formula: mix(white, AO, intensity) then MultiplyBlend onto scene.
        // intensity > 1 clamps AO < (1 - 1/intensity) to pure black — avoid this.
        // three.js example slider max is 1.0.
        // Read from the AO slider so the user-facing control actually controls
        // GTAO. Falls back to the mode default if the slider is missing.
        S.gtaoPass.blendIntensity = parseFloat(
          document.getElementById('sl-ao-intensity')?.value
          ?? S.modeSettings?.arctic?.aoIntensity ?? 0.7
        );
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;

    case 'rendered':
      if (S.gtaoPass) {
        S.gtaoPass.output         = 0;
        S.gtaoPass.enabled        = true;
        S.gtaoPass.blendIntensity = parseFloat(
          document.getElementById('sl-ao-intensity')?.value
          ?? S.modeSettings?.rendered?.aoIntensity ?? 0.4
        );
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;


  }

  applySceneBackground();
  if (S.currentMode === 'technical')
    S.scene.background = new THREE.Color(0xffffff);

  updateGroundAppearance();

  const edgeOverlay = document.getElementById('chk-edges-panel')?.checked ?? true;

  S.currentModel.traverse(child => {
    if (!((child.isMesh || child.isLine) && child.userData.originalMaterial)) return;
    if (child.name === 'rhino-outline') return;
    if (child.name === 'selection-outline') return;
    child.renderOrder = 0;

    // Helper: raw color from layer/object (PRESERVES black/white, with automatic theme inversion).
    // In dark mode, pure black/very dark curves map to white. In light mode, pure white/very light curves map to black.
    const childAttrs = child.userData.attributes || {};
    const childLayer = S.parsedLayers.find(l => l.index === childAttrs.layerIndex);
    const rawColor = () => {
      if (child.userData.objectColorCustom) {
        return new THREE.Color(child.userData.objectColorCustom);
      }
      
      const getColorSourceValue = (cs) => {
        if (cs === undefined || cs === null) return 0; // Default to ByLayer
        if (typeof cs === 'number') return cs;
        if (typeof cs === 'object' && typeof cs.value === 'number') return cs.value;
        return 0;
      };
      const csVal = getColorSourceValue(childAttrs.colorSource);
      const isByObject = csVal === 1;
      const isByMaterial = csVal === 2;

      const oc = childAttrs.objectColor;
      const out = new THREE.Color(0, 0, 0);
      // Rhino layer/object colors are sRGB. Pass SRGBColorSpace so r169's
      // ColorManagement converts to linear before storing — otherwise values
      // are stored raw and curves/edges render with a hue shift (e.g. cyan
      // #00cdff → too-blue because G channel reads ~0.61 instead of ~0.39).
      if (isByMaterial && child.material?.color) {
        out.copy(child.material.color);
      } else if (isByObject && oc) {
        out.setRGB(oc.r / 255, oc.g / 255, oc.b / 255, THREE.SRGBColorSpace);
      } else if (childLayer?.color) {
        const lc = childLayer.color;
        out.setRGB((lc.r ?? lc.R ?? 0) / 255, (lc.g ?? lc.G ?? 0) / 255, (lc.b ?? lc.B ?? 0) / 255, THREE.SRGBColorSpace);
      } else if (oc && ((oc.r ?? 0) > 0 || (oc.g ?? 0) > 0 || (oc.b ?? 0) > 0)) {
        // Fallback: objectColor stores the layer color redundantly in Rhino for ByLayer objects.
        // Use it when the layer lookup fails (e.g., index mismatch between cleanDoc and original doc).
        out.setRGB(oc.r / 255, oc.g / 255, oc.b / 255, THREE.SRGBColorSpace);
      }

      // Curves keep their Rhino-original color — no black↔white flip based
      // on UI theme. Scene background mirrors the 3dm file, so the file's
      // intended color is what the user should see.
      return out;
    };

    if (child.isLine) {
      const modeSettings = S.modeSettings[S.currentMode] || {};
      const modeAllowsCurves = modeSettings.curves !== false;
      // Also respect layer visibility — don't show curves on hidden layers
      const curveLayerVis = childLayer ? childLayer.visible : true;
      const curveObjVis = !S.hiddenObjects?.has(child);
      // Rhino per-object hidden state (3DMLoader applies layer visibility only).
      // S.revealHidden ("Show All") overrides it to reveal file-author-hidden.
      const curveRhinoVis = S.revealHidden || child.userData?.attributes?.visible !== false;
      child.visible = modeAllowsCurves && curveLayerVis && curveObjVis && curveRhinoVis;

      // Ensure the line has its own unique cloned material from originalMaterial,
      // so modifying its color does not affect other lines sharing the material.
      if (child.userData.originalMaterial) {
        if (child.material !== child.userData.originalMaterial) {
          child.material = child.userData.originalMaterial;
        }
      }

      // THREE.js 3DM loader may create LineBasicMaterial with vertexColors:true,
      // which overrides material.color entirely. Disable vertex colors so our
      // rawColor() value is actually applied.
      if (child.material && child.material.vertexColors) {
        child.material.vertexColors = false;
        child.material.needsUpdate = true;
      }
      child.material.color.copy(rawColor());
      return;
    }

    const orig  = child.userData.originalMaterial;
    const edges = child.getObjectByName('rhino-edges');
    if (edges) edges.renderOrder = 0;

    switch (S.currentMode) {

      case 'wireframe': {
        // Wireframe mode always shows edges over depth-only (invisible) faces,
        // regardless of the edge-overlay panel toggle — that toggle only governs
        // optional edge overlay in the OTHER shaded modes. Previously, with the
        // panel off, wireframe fell back to a solid shaded render (and the edge
        // geometry was never built at load), so the model looked shaded.
        child.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
        let wfEdges = edges;
        if (!wfEdges && child.isMesh && child.geometry) {
          // Built on demand when edges weren't generated at load time.
          addEdges(child);
          wfEdges = child.getObjectByName('rhino-edges');
        }
        if (wfEdges) {
          wfEdges.visible = true;
          // Use raw color which has automatic theme inversion for black/white lines
          wfEdges.material.color.copy(rawColor());
        }
        break;
      }

      case 'shaded': {
        const base = child.userData.shadedMaterial || orig;
        const m = base.clone();
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.roughness = 0.85; m.metalness = 0.05;
        // Two-sided faces — match Rhino's shaded viewport so open surfaces and
        // the inside of non-solid polysurfaces stay visible from behind.
        m.side = THREE.DoubleSide;
        if (child.userData.objectColorCustom !== undefined) m.color?.set(child.userData.objectColorCustom);
        m.needsUpdate = true;
        child.material = m;
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 1;
          edges.material.depthWrite = false;
        }
        break;
      }

      case 'arctic': {
        // Architecture: near-white surfaces + env-map IBL + sun shadows.
        const m = new THREE.MeshStandardMaterial({
          color: 0xf0f0f0, roughness: 0.95, metalness: 0.0,
          side: THREE.DoubleSide
        });
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        // Rely on scene.environment instead of explicit envMap so HDR changes apply.
        // 0.4 keeps IBL contribution modest — supplemental lights add the rest.
        m.envMapIntensity = 0.4;
        child.material = m;
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 1;
          edges.material.depthWrite = false;
        }
        break;
      }

      case 'rendered': {
        const base = child.userData.renderedMaterial || orig;
        // 3DMLoader builds a MeshPhysicalMaterial with ior≈1.7 (from Rhino's
        // reflectivity) and specularIntensity=0.5. Those Physical-only terms
        // shift the BRDF away from a standard PBR look — cyan surfaces pick
        // up extra fresnel and end up reading too saturated/blue vs. Rhino's
        // own renderer. Our UI only exposes color/roughness/metalness/opacity,
        // so downgrade to MeshStandardMaterial and copy just those four; this
        // matches what Rhino's Rendered viewport draws for a Physically Based
        // material with no clearcoat/sheen/transmission.
        let m;
        if (base.isMeshPhysicalMaterial) {
          m = new THREE.MeshStandardMaterial({
            color:       base.color?.clone() ?? new THREE.Color(0xffffff),
            roughness:   base.roughness ?? 0.5,
            metalness:   base.metalness ?? 0.0,
            opacity:     base.opacity   ?? 1.0,
            transparent: !!base.transparent,
            depthWrite:  base.depthWrite ?? true,
            side:        base.side ?? THREE.FrontSide,
            map:         base.map ?? null,
            normalMap:   base.normalMap ?? null,
            emissive:    base.emissive?.clone() ?? new THREE.Color(0x000000),
            emissiveIntensity: base.emissiveIntensity ?? 1.0
          });
        } else {
          m = base.clone();
        }
        if (child.userData.materialColor) m.color.copy(child.userData.materialColor);
        if (m.roughness !== undefined && m.roughness < 0.05) m.roughness = 0.4;
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        // Don't set m.envMap directly — that overrides scene.environment and prevents
        // HDR changes from taking effect. envMapIntensity controls strength.
        m.envMap = null;
        m.envMapIntensity = 1.0;
        // Resolve effective custom material:
        // Priority: object-level customMaterial > layer customMaterial (when ByLayer) > none
        let effectiveCustom = child.userData.customMaterial;
        if (!effectiveCustom && child.userData.isMaterialByLayer) {
          const childLayerIdx = (child.userData.attributes || {}).layerIndex ?? 0;
          const childLayer = S.parsedLayers.find(l => l.index === childLayerIdx);
          if (childLayer?.customMaterial) effectiveCustom = childLayer.customMaterial;
        }
        applyCustomToMaterial(m, effectiveCustom);
        m.needsUpdate = true;
        child.material = m;
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          // renderOrder=1 + depthWrite:false ensures lines always draw on top
          // of face geometry, preventing fragmentation from z-fighting.
          edges.renderOrder = 1;
          edges.material.depthWrite = false;
        }
        break;
      }

      case 'technical': {
        child.renderOrder = 0;
        const orig = child.userData.originalMaterial;
        const isTransparent = orig?.transparent && (orig?.opacity ?? 1) < 0.95;
        if (isTransparent) {
          child.material = new THREE.MeshBasicMaterial({
            color: 0xffffff, side: THREE.DoubleSide,
            transparent: true, opacity: 0.08,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
            depthWrite: false
          });
        } else {
          child.material = new THREE.MeshBasicMaterial({
            color: 0xffffff, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
          });
        }
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 2;
          edges.material.depthWrite = false;
        }
        break;
      }

    }
  });

  // ── Sync the display mode dropdown button UI dynamically ──
  const dropdown = document.getElementById('mode-dropdown');
  if (dropdown) {
    const activeItem = dropdown.querySelector(`.dropdown-item[data-mode="${S.currentMode}"]`);
    if (activeItem) {
      // Keep dropdown active classes in sync
      dropdown.querySelectorAll('.dropdown-item').forEach(b => b.classList.toggle('active', b === activeItem));
      // Update top trigger button label & title
      const triggerBtn = document.getElementById('btn-mode-dropdown');
      if (triggerBtn) {
        const label = activeItem.querySelector('span').textContent.split(' ')[0];
        const triggerLabel = triggerBtn.querySelector('span');
        if (triggerLabel) triggerLabel.textContent = label;
        triggerBtn.title = `Display Mode (${label})`;
        
        // Clone and swap the active mode's SVG icon onto the trigger button
        const svg = activeItem.querySelector('svg').cloneNode(true);
        const oldSvg = triggerBtn.querySelector('svg');
        if (oldSvg) {
          triggerBtn.replaceChild(svg, oldSvg);
        }
      }
    }
  }
}

// ── Material Utilities ───────────────────────────────────────────────────────

export function fixMaterialTransparency(mat) {
  if (!mat) return;
  if (mat.opacity !== undefined && mat.opacity < 0.99) {
    mat.transparent = true;
    mat.depthWrite  = false;
  }
}

// Rhino object types whose tessellation has no topological edges to find.
//
// A Rhino Mesh has no Brep edges — its "edges" are just its triangulation, so a
// dihedral-angle pass over an imported tree or a scanned terrain produces noise
// rather than an outline. SubD is smooth for the same reason. Skipping them is
// both better looking and dramatically cheaper: on a sample architectural model
// they were 96% of the triangles while being none of the geometry a user would
// want outlined.
const NO_TOPOLOGY_EDGE_TYPES = new Set(['Mesh', 'SubD', 'PointSet', 'PointCloud']);

/**
 * Whether dihedral edge extraction is worth running on this mesh.
 *
 * An absent objectType means the geometry did not come from a .3dm at all (STL,
 * 3MF, GLB, STEP/IGES via OCCT). Those are mesh-only formats where EdgesGeometry
 * is the only possible edge source, so they stay eligible — the exclusion is
 * specifically about Rhino objects that *have* a topological alternative.
 */
export function isEdgeEligible(mesh) {
  const type = mesh?.userData?.objectType ?? mesh?.userData?.attributes?.objectType;
  return !(type && NO_TOPOLOGY_EDGE_TYPES.has(type));
}

export function addEdges(mesh, thresholdAngle) {
  if (!mesh || !mesh.isMesh || mesh.isLine || !mesh.geometry) return;
  // Guard here as well as at the call sites: addEdges is reached from load,
  // display-mode changes and the angle slider, and a Mesh object must never
  // acquire dihedral edges through any of them.
  if (!isEdgeEligible(mesh)) return;

  // Skip if mesh is part of annotations
  let isAnn = false;
  let p = mesh.parent;
  while (p) {
    if (p.name === 'annotations-group') { isAnn = true; break; }
    p = p.parent;
  }
  if (isAnn) return;

  const angle = typeof thresholdAngle === 'number' ? thresholdAngle : (S.edgeThresholdAngle ?? 30);
  const eg   = new THREE.EdgesGeometry(mesh.geometry, angle);
  const line = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x000000 }));
  line.name = 'rhino-edges';
  mesh.add(line);
}

export function recreateAllEdges(thresholdAngle) {
  if (thresholdAngle !== undefined) {
    S.edgeThresholdAngle = thresholdAngle;
  }
  const angle = S.edgeThresholdAngle ?? 30;
  if (!S.scene) return;

  // The file's edges came from Brep topology, so they are exact and have no
  // dihedral threshold to re-apply. Rebuilding would replace them with a coarser
  // approximation derived from the tessellated mesh — and pay the extraction cost
  // the precomputed edges exist to avoid.
  if (S.edgesPrecomputed) return;

  S.scene.traverse(child => {
    if (child.isMesh && !['rhino-edges', 'rhino-outline', 'selection-outline', 'ground-plane'].includes(child.name)) {
      // Skip if child is part of annotations OR the measurement group.
      // Building EdgesGeometry on every measurement sphere on every slider
      // change is wasteful and triggers a side effect in three.js where
      // opaque depthTest:false meshes stop rendering after the subsequent
      // applyDisplayMode() — see issue history.
      let skip = false;
      let p = child.parent;
      while (p) {
        if (p.name === 'annotations-group' || p === S.measurementGroup) {
          skip = true; break;
        }
        p = p.parent;
      }
      if (skip) return;

      const oldEdges = child.getObjectByName('rhino-edges');
      if (oldEdges) {
        child.remove(oldEdges);
        oldEdges.geometry?.dispose();
        if (oldEdges.material) {
          if (Array.isArray(oldEdges.material)) {
            oldEdges.material.forEach(m => m.dispose());
          } else {
            oldEdges.material.dispose();
          }
        }
      }
      addEdges(child, angle);
    }
  });

  applyDisplayMode();
}

export function applyLayerColorsToModel(model) {
  if (!S.parsedLayers.length) return;
  model.traverse(child => {
    if (child.name === 'rhino-edges' || child.name === 'rhino-outline' || child.name === 'selection-outline') return;
    if ((!child.isMesh && !child.isLine) || !child.userData.originalMaterial) return;
    const attrs = child.userData.attributes || {};
    if (child.userData.isColorByLayer) {
      const layer = S.parsedLayers.find(l => l.index === attrs.layerIndex);
      if (layer?.color) {
        const lc = layer.color;
        // Build via hex string so r169 ColorManagement applies sRGB→linear
        // conversion. The 3-arg `new Color(r,g,b)` form routes through setRGB
        // which stores raw values (linear), causing a visible hue shift.
        const hex = '#' + [
          lc.r ?? lc.R ?? 0,
          lc.g ?? lc.G ?? 0,
          lc.b ?? lc.B ?? 0
        ].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
        const col = new THREE.Color().set(hex);
        
        if (!child.isLine) {
          // Mesh black → white safety mapping (mode-independent): a pitch-black
          // shaded mesh receives no lighting and reads as invisible blobs, so we
          // promote it to white. This is unrelated to UI theme.
          if (col.r < 0.08 && col.g < 0.08 && col.b < 0.08) {
            col.setHex(0xffffff);
          }
        }
        // Curves keep their Rhino-original color — no black↔white flip based
        // on UI theme.
        
        if (child.isLine) {
          if (child.userData.originalMaterial && child.material !== child.userData.originalMaterial) {
            child.material = child.userData.originalMaterial;
          }
          // Update line color directly
          child.material.color.copy(col);
          if (child.userData.originalMaterial) child.userData.originalMaterial.color.copy(col);
        } else {
          child.userData.originalMaterial.color.copy(col);
          if (child.userData.shadedMaterial) child.userData.shadedMaterial.color.copy(col);
        }
      }
    }
  });
}

export function applyCustomToMaterial(mat, custom) {
  if (!custom || !mat) return;
  if (custom.color     !== undefined) mat.color?.set(custom.color);
  if (custom.roughness !== undefined && mat.roughness !== undefined) mat.roughness = custom.roughness;
  if (custom.metalness !== undefined && mat.metalness !== undefined) mat.metalness = custom.metalness;
  if (custom.opacity   !== undefined) {
    mat.opacity     = custom.opacity;
    mat.transparent = custom.opacity < 0.999;
    mat.depthWrite  = custom.opacity >= 0.999;
  }
  if (custom.mapTexture !== undefined) {
    if (custom.mapTexture === null) {
      mat.map = null;
    } else if (custom.mapTexture.isTexture) {
      mat.map = custom.mapTexture;
    }
  }
  mat.needsUpdate = true;
}
