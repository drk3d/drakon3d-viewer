import * as THREE from 'three';
import { S } from './state.js';
import { setupLights, updateGroundAppearance } from './lighting.js';

// ── Scene Background ─────────────────────────────────────────────────────────

export function applySceneBackground() {
  if (S.currentMode === 'technical') { S.scene.background = new THREE.Color(0xffffff); return; }

  const bgType = document.getElementById('bg-type-select')?.value || 'solid';
  const c1 = document.getElementById('bg-panel-c1')?.value || '#2a2b2f';
  const c2 = document.getElementById('bg-panel-c2')?.value || '#18181c';

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

  if (S.rhinoBackgroundColor && c1Input) {
    const hex = '#' + S.rhinoBackgroundColor.getHexString();
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
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide,
    depthWrite: false
  });
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = 'rhino-outline';
  outline.renderOrder = 1;
  outline.scale.setScalar(1.03);
  mesh.add(outline);
}

export function applyDisplayMode() {
  if (!S.currentModel) return;

  clearTechnicalOutlines();
  setupLights();

  if (S.renderer) {
    S.renderer.toneMapping = (S.currentMode === 'rendered')
      ? THREE.ACESFilmicToneMapping
      : THREE.NoToneMapping;
  }

  if (['wireframe', 'technical', 'shaded', 'arctic'].includes(S.currentMode)) {
    S.scene.environment = null;
  } else if (S.environmentMap) {
    S.scene.environment = S.environmentMap;
  }
  S.ssaoPass.enabled = false;

  const maxDim = S.modelShadowDims ? S.modelShadowDims.maxDim : 100;
  switch (S.currentMode) {
    case 'arctic':
      S.ssaoPass.enabled     = true;
      S.ssaoPass.kernelRadius = 16;
      S.ssaoPass.minDistance  = maxDim * 0.0005;
      S.ssaoPass.maxDistance  = maxDim * 0.05;
      break;
    case 'rendered':
      S.ssaoPass.enabled     = true;
      S.ssaoPass.kernelRadius = 12;
      S.ssaoPass.minDistance  = maxDim * 0.0005;
      S.ssaoPass.maxDistance  = maxDim * 0.03;
      break;
  }

  applySceneBackground();
  if (S.currentMode === 'technical') S.scene.background = new THREE.Color(0xffffff);

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

    switch (S.currentMode) {

      case 'wireframe':
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
          const base = child.userData.shadedMaterial || orig;
          edges.material.color.copy(base.color);
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
        if (edges) { edges.visible = edgeOverlay; edges.material.color.setHex(0x000000); }
        break;
      }

      case 'arctic': {
        const m = new THREE.MeshStandardMaterial({
          color: 0xf0f0f0, roughness: 0.9, metalness: 0.0
        });
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        child.material = m;
        if (edges) { edges.visible = edgeOverlay; edges.material.color.setHex(0x000000); }
        break;
      }

      case 'rendered': {
        const base = child.userData.renderedMaterial || orig;
        const m = base.clone();
        if (child.userData.materialColor) m.color.copy(child.userData.materialColor);
        if (m.roughness !== undefined && m.roughness < 0.05) m.roughness = 0.4;
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.envMap = S.environmentMap;
        m.envMapIntensity = 0.9;
        applyCustomToMaterial(m, child.userData.customMaterial);
        m.needsUpdate = true;
        child.material = m;
        S.scene.environment = S.environmentMap;
        if (edges) { edges.visible = edgeOverlay; edges.material.color.setHex(0x000000); }
        break;
      }

      case 'technical':
        child.renderOrder = 0;
        child.material = new THREE.MeshBasicMaterial({
          color: 0xffffff, side: THREE.FrontSide,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
        });
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 2;
          edges.material.depthWrite = false;
        }
        addTechnicalOutline(child);
        break;
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
      if (layer) {
        const { r, g, b } = layer.color;
        const col = new THREE.Color(r / 255, g / 255, b / 255);
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
