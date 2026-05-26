import * as THREE from 'three';
import { S } from './state.js';
import { setupLights, updateGroundAppearance } from './lighting.js';

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

// ── Scene Background ─────────────────────────────────────────────────────────

export function applySceneBackground() {
  if (S.currentMode === 'technical') { S.scene.background = new THREE.Color(0xffffff); return; }

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
  const c1Swatch = document.getElementById('bg-panel-swatch-c1');
  if (!bgSel) return;

  let newType = 'solid';
  if (S.fileDefaultBgStyle !== null && S.fileDefaultBgStyle !== undefined) {
    const s = String(S.fileDefaultBgStyle).toLowerCase();
    if (s === '1' || s.includes('gradient')) newType = 'gradient2';
  }
  bgSel.value = newType;

  // S.rhinoBackgroundColor comes from renderSettings (Rhino's *render* background),
  // NOT the viewport background — Rhino's render default is black, viewport is white.
  // Only apply if the color is meaningfully light (luminance > 5%); otherwise
  // fall back to white which matches the typical Rhino viewport appearance.
  if (c1Input) {
    let hex = '#ffffff'; // default: white (matches Rhino viewport default)
    if (S.rhinoBackgroundColor) {
      const c   = S.rhinoBackgroundColor;
      const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
      if (lum > 0.05) hex = '#' + c.getHexString();
    }
    c1Input.value = hex;
    if (c1Swatch) c1Swatch.style.background = hex;
  }

  const isSolid  = newType === 'solid';
  const isRadial = newType === 'radial';
  const isGrad4  = newType === 'gradient4';
  document.getElementById('picker-c1')?.classList.remove('hidden');
  document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid);
  document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('bg-radial-section')?.classList.toggle('hidden', !isRadial);
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
    // ACES for rendered mode (filmic PBR look). Background is rendered via
    // a separate skybox sphere with toneMapped:false so it bypasses ACES
    // compression and shows the user's exact color.
    S.renderer.toneMapping = (S.currentMode === 'rendered')
      ? THREE.ACESFilmicToneMapping
      : THREE.NoToneMapping;
    S.renderer.toneMappingExposure = 1.0;
  }
  if (S.scene) S.scene.backgroundIntensity = 1.0;

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
  // - shaded/wireframe/technical: NO shadows (clean look)
  // - arctic/rendered: shadows if sun enabled
  const modeWantsShadows = ['arctic', 'rendered'].includes(S.currentMode);
  if (S.sunLight) S.sunLight.castShadow = modeWantsShadows && S.shadowsEnabled;
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
        S.gtaoPass.blendIntensity = 0.85;
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;

    case 'rendered':
      if (S.gtaoPass) {
        S.gtaoPass.output         = 0;
        S.gtaoPass.enabled        = true;
        S.gtaoPass.blendIntensity = 0.65;
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;

    // ── AO Debug: GTAOPass output=4 (raw AO buffer).
    // Dark corners/crevices = AO is computing correctly.
    // All white = GTAOPass AO shader still not producing occlusion.
    // White material on the model + white background makes AO shadows clearly visible.
    case 'ao-debug':
      if (S.gtaoPass) {
        S.gtaoPass.output         = 4; // OUTPUT.AO — raw AO buffer diagnostic
        S.gtaoPass.enabled        = true;
        S.gtaoPass.blendIntensity = 1.0;
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;
  }

  applySceneBackground();
  if (S.currentMode === 'technical' || S.currentMode === 'ao-debug')
    S.scene.background = new THREE.Color(0xffffff);

  updateGroundAppearance();

  const edgeOverlay = document.getElementById('chk-edges-panel')?.checked ?? true;

  S.currentModel.traverse(child => {
    if (!(child.isMesh && child.userData.originalMaterial)) return;
    if (child.name === 'rhino-outline') return;
    if (child.name === 'selection-outline') return;
    child.renderOrder = 0;
    const orig  = child.userData.originalMaterial;
    const edges = child.getObjectByName('rhino-edges');
    if (edges) edges.renderOrder = 0;

    // Helper: raw color from layer/object (PRESERVES black, no auto-white).
    // Used by wireframe mode where the user expects black-on-black if specified.
    const childAttrs = child.userData.attributes || {};
    const childLayer = S.parsedLayers.find(l => l.index === childAttrs.layerIndex);
    const rawColor = () => {
      const oc = childAttrs.objectColor;
      const hasOverride = oc && ((oc.r ?? 0) > 0 || (oc.g ?? 0) > 0 || (oc.b ?? 0) > 0);
      const out = new THREE.Color(0, 0, 0);
      if (hasOverride) {
        out.setRGB(oc.r / 255, oc.g / 255, oc.b / 255);
      } else if (childLayer?.color) {
        const lc = childLayer.color;
        out.setRGB((lc.r ?? lc.R ?? 0) / 255, (lc.g ?? lc.G ?? 0) / 255, (lc.b ?? lc.B ?? 0) / 255);
      }
      return out;
    };

    switch (S.currentMode) {

      case 'wireframe':
        // Hide faces by writing only to depth buffer (transparent front face)
        if (edgeOverlay) {
          child.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
        } else {
          const base = child.userData.shadedMaterial || orig;
          const m = base.clone();
          m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
          child.material = m;
        }
        if (edges) {
          edges.visible = edgeOverlay;
          // Use raw color so black layer/object stays black in wireframe
          edges.material.color.copy(rawColor());
        }
        break;

      case 'shaded': {
        const base = child.userData.shadedMaterial || orig;
        const m = base.clone();
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.roughness = 0.85; m.metalness = 0.05;
        const custom = child.userData.customMaterial;
        if (custom?.color !== undefined) m.color?.set(custom.color);
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
          color: 0xf0f0f0, roughness: 0.95, metalness: 0.0
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
        const m = base.clone();
        if (child.userData.materialColor) m.color.copy(child.userData.materialColor);
        if (m.roughness !== undefined && m.roughness < 0.05) m.roughness = 0.4;
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        // Don't set m.envMap directly — that overrides scene.environment and prevents
        // HDR changes from taking effect. envMapIntensity controls strength.
        m.envMap = null;
        m.envMapIntensity = 1.0;
        applyCustomToMaterial(m, child.userData.customMaterial);
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

      // AO debug: white surfaces so we can read the AO shadow map clearly.
      // GTAOPass output=4 overlays the raw AO buffer — dark = occluded, white = open.
      case 'ao-debug': {
        child.material = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 1.0, metalness: 0.0,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
        });
        if (edges) edges.visible = false; // hide edges — irrelevant for AO debug
        break;
      }
    }
  });
}

// ── Material Utilities ───────────────────────────────────────────────────────

export function fixMaterialTransparency(mat) {
  if (!mat) return;
  if (mat.opacity !== undefined && mat.opacity < 0.99) {
    mat.transparent = true;
    mat.depthWrite  = false;
  }
}

export function addEdges(mesh) {
  const eg   = new THREE.EdgesGeometry(mesh.geometry, 20);
  const line = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x000000 }));
  line.name = 'rhino-edges';
  mesh.add(line);
}

export function applyLayerColorsToModel(model) {
  if (!S.parsedLayers.length) return;
  model.traverse(child => {
    if (!child.isMesh || !child.userData.originalMaterial) return;
    const attrs = child.userData.attributes || {};
    if (child.userData.isColorByLayer) {
      const layer = S.parsedLayers.find(l => l.index === attrs.layerIndex);
      if (layer?.color) {
        const lc = layer.color;
        const col = new THREE.Color(
          (lc.r ?? lc.R ?? 0) / 255,
          (lc.g ?? lc.G ?? 0) / 255,
          (lc.b ?? lc.B ?? 0) / 255
        );
        if (col.r < 0.02 && col.g < 0.02 && col.b < 0.02) col.setHex(0xffffff);
        child.userData.originalMaterial.color.copy(col);
        if (child.userData.shadedMaterial) child.userData.shadedMaterial.color.copy(col);
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
  mat.needsUpdate = true;
}
