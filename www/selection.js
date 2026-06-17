import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode } from './display.js';
import { History } from './history.js';
import { bindSliderDblClickInput } from './helpers.js';

// ── Pointer hit-test / selection ─────────────────────────────────────────────

export function onPointerDown(event) {
  if (!S.currentModel || S.selectMode === 'none') return;

  if (S.clippingTransformControls && S.clippingTransformControls.getHelper().visible && S.clippingTransformControls.object) {
    if (S.clippingTransformControls.axis !== null) return;
    const tmpMouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    S.raycaster.setFromCamera(tmpMouse, S.camera);
    const gHits = S.raycaster.intersectObjects(S.clippingTransformControls.getHelper().children, true);
    const hasValidGizmoHit = gHits.some(hit => {
      let curr = hit.object;
      while (curr) {
        if (curr.name === 'X' || curr.name === 'Y' || curr.name === 'Z') return true;
        curr = curr.parent;
      }
      return false;
    });
    if (hasValidGizmoHit) return;
  }

  // Block selection when dragging arc rotation handles
  if (S.clippingArcDrag) return;

  if (S.gumballTransformControls && S.gumballTransformControls.getHelper().visible && S.gumballTransformControls.object) {
    if (S.gumballTransformControls.axis !== null) return;
    const tmpMouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    S.raycaster.setFromCamera(tmpMouse, S.camera);
    const gHits = S.raycaster.intersectObjects(S.gumballTransformControls.getHelper().children, true);
    
    const hasValidGizmoHit = gHits.some(hit => {
      let curr = hit.object;
      while (curr) {
        if (curr.name === 'X' || curr.name === 'Y' || curr.name === 'Z') return true;
        curr = curr.parent;
      }
      return false;
    });
    if (hasValidGizmoHit) return;
  }

  // Block selection when clicking or dragging custom gumball arc handles
  if (S.gumballArcDrag) return;
  if (S.gumballArcHandles && S.gumballArcHandles.length > 0) {
    const tmpMouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    S.raycaster.setFromCamera(tmpMouse, S.camera);
    const arcMeshes = [];
    S.gumballArcHandles.forEach(h => { arcMeshes.push(h.mesh, h.hitMesh); });
    const hits = S.raycaster.intersectObjects(arcMeshes, false);
    if (hits.length > 0) return;
  }

  S.mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);

  const targets = [];
  if (S.currentModel) targets.push(S.currentModel);
  if (S.annotationGroup && S.annotationGroup.parent !== S.currentModel) {
    targets.push(S.annotationGroup);
  }

  const allHits = S.raycaster.intersectObjects(targets, true);
  const hit = allHits.find(i =>
    (i.object.isMesh || i.object.isLine || i.object.isLineSegments || i.object.isSprite)
    && i.object.name !== 'rhino-edges'
    && i.object.name !== 'rhino-outline'
    && i.object.name !== 'selection-outline'
    && i.object.name !== 'ground-plane'
    && i.object.visible);

  const multi = S.selectMode === 'multi' || event.shiftKey || event.ctrlKey || event.metaKey;

  if (hit) {
    let obj = hit.object;
    
    // Resolve top-level annotation element if selected object is inside S.annotationGroup
    if (S.annotationGroup) {
      let curr = obj;
      while (curr && curr.parent) {
        if (curr.parent === S.annotationGroup) {
          obj = curr;
          break;
        }
        curr = curr.parent;
      }
    }

    if (multi) {
      const idx = S.selectedObjects.indexOf(obj);
      if (idx > -1) {
        S.selectedObjects.splice(idx, 1);
        clearSelectionOutline(obj);
      } else {
        S.selectedObjects.push(obj);
        addSelectionOutline(obj);
      }
    } else {
      clearSelection();
      S.selectedObjects.push(obj);
      addSelectionOutline(obj);
    }
  } else {
    clearSelection();
  }

  if (S.gumballActive) {
    document.getElementById('object-properties').classList.add('hidden');
    setupGumballHelper();
  } else {
    clearGumballHelper();
    updatePropertiesPanel();
  }
}

// ── Selection outline (BackSide silhouette highlight) ─────────────────────────

export function addSelectionOutline(mesh) {
  if (S.selectionOutlinePass) {
    S.selectionOutlinePass.selectedObjects = [...S.selectedObjects];
  }
  // Override color of non-meshes (lines, dimension groups) to Selection Color (#0066ff)
  // NOTE: Sprites (TextDots) are excluded — they use canvas textures so color.tint doesn't affect text contrast.
  if (mesh && (!mesh.isMesh || mesh.isLine || mesh.isLineSegments || (S.annotationGroup && mesh.parent === S.annotationGroup))) {
    const overrideColor = new THREE.Color('#0066ff');
    mesh.traverse(child => {
      // Skip Sprites: they render via canvas texture — tinting overwrites their auto-contrast text rendering
      if (child.isSprite) return;
      if (child.material && child.material.color) {
        if (!child.userData.selectionBackup) {
          child.userData.selectionBackup = {
            material: child.material,
            color: child.material.color.clone()
          };
        }
        child.material = child.material.clone();
        child.material.color.copy(overrideColor);
      }
    });
  }
}

export function clearSelectionOutline(mesh) {
  if (S.selectionOutlinePass) {
    S.selectionOutlinePass.selectedObjects = S.selectionOutlinePass.selectedObjects.filter(o => o !== mesh);
  }
  let changed = false;
  if (mesh) {
    mesh.traverse(child => {
      if (child.userData.selectionBackup) {
        // If color was customized, keep the unique cloned material so it no longer shares materials
        if (mesh.userData.objectColorCustom) {
          child.material.color.set(mesh.userData.objectColorCustom);
          child.userData.selectionBackup = null;
        } else {
          child.material = child.userData.selectionBackup.material;
          child.userData.selectionBackup = null;
        }
        changed = true;
      }
    });
  }
  if (changed) {
    applyDisplayMode();
  }
}

export function clearSelection() {
  let changed = false;
  S.selectedObjects.forEach(obj => {
    if (obj) {
      obj.traverse(child => {
        if (child.userData.selectionBackup) {
          // If color was customized, keep the unique cloned material so it no longer shares materials
          if (obj.userData.objectColorCustom) {
            child.material.color.set(obj.userData.objectColorCustom);
            child.userData.selectionBackup = null;
          } else {
            child.material = child.userData.selectionBackup.material;
            child.userData.selectionBackup = null;
          }
          changed = true;
        }
      });
    }
  });
  S.selectedObjects = [];
  if (S.selectionOutlinePass) {
    S.selectionOutlinePass.selectedObjects = [];
  }
  clearGumballHelper();
  if (changed) {
    applyDisplayMode();
  }
}

// ── Properties panel ──────────────────────────────────────────────────────────

let _activePropTab = 'props'; // 'props' | 'usertext'
let _utSortCol = null;        // null | 'key' | 'value'
let _utSortDir = 'asc';       // 'asc' | 'desc'

function _switchPropTab(tab) {
  _activePropTab = tab;
  document.getElementById('prop-tab-props')?.classList.toggle('active', tab === 'props');
  document.getElementById('prop-tab-usertext')?.classList.toggle('active', tab === 'usertext');
  updatePropertiesPanel();
}

function _bindPropTabs() {
  document.getElementById('prop-tab-props')?.addEventListener('click', () => _switchPropTab('props'));
  document.getElementById('prop-tab-usertext')?.addEventListener('click', () => _switchPropTab('usertext'));
}
_bindPropTabs();

function _getUserText(obj) {
  // Normalise whatever getUserStrings() returns into [{key, value}] pairs.
  // rhino3dm returns an array of [key, value] string-arrays;
  // Three.js stores the result directly so elements can be [k,v] arrays
  // or {key,value} objects depending on the version.
  function _normalise(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Array.isArray(raw)) {
      return raw
        .map(e => Array.isArray(e)
          ? { key: String(e[0] ?? ''), value: String(e[1] ?? '') }
          : { key: String(e.key ?? e[0] ?? ''), value: String(e.value ?? e[1] ?? '') })
        .filter(p => p.key);
    }
    // Plain object {key: value}
    return Object.entries(raw).map(([k, v]) => ({ key: k, value: String(v) }));
  }

  // Try THREE.js-parsed attributes first (populated by Rhino3dmLoader)
  const ut = obj.userData.attributes?.userStrings;
  const pairs = _normalise(ut);
  if (pairs.length > 0) return pairs;

  // Fallback: per-object data extracted during 3DM preprocess
  const id = obj.userData.attributes?.id;
  if (id && S._objUserTextById?.has(id)) return S._objUserTextById.get(id);
  return [];
}

export function updatePropertiesPanel() {
  const panel = document.getElementById('object-properties');
  if (!S.selectedObjects.length) { panel.classList.add('hidden'); return; }

  const isMulti = S.selectedObjects.length > 1;

  // ── Extract Name and Layer ───────────────────────────────────────────
  let displayName = 'Unnamed';
  if (isMulti) {
    let commonName = null;
    let nameSame = true;
    S.selectedObjects.forEach((o, i) => {
      const n = o.userData.attributes?.name || (o.userData.annIndex !== undefined ? (S.parsedAnnotations[o.userData.annIndex].type || 'Annotation') : 'Unnamed');
      if (i === 0) commonName = n;
      else if (commonName !== n) nameSame = false;
    });
    displayName = nameSame ? (commonName || 'Unnamed') : 'Various';
  } else {
    const obj = S.selectedObjects[0];
    displayName = obj.userData.attributes?.name || (obj.userData.annIndex !== undefined ? (S.parsedAnnotations[obj.userData.annIndex].type || 'Annotation') : 'Unnamed');
  }

  let displayLayer = '—';
  let layerIndex = -1;
  if (isMulti) {
    let commonLayerName = null;
    let layerSame = true;
    S.selectedObjects.forEach((o, i) => {
      const li = (o.userData.layerIndex !== undefined) ? o.userData.layerIndex : (o.userData.attributes?.layerIndex);
      const l = S.parsedLayers.find(pl => pl.index === li);
      const ln = l?.name ?? '—';
      if (i === 0) commonLayerName = ln;
      else if (commonLayerName !== ln) layerSame = false;
    });
    displayLayer = layerSame ? (commonLayerName || '—') : 'Various';
  } else {
    const obj = S.selectedObjects[0];
    layerIndex = (obj.userData.layerIndex !== undefined) ? obj.userData.layerIndex : (obj.userData.attributes?.layerIndex);
    const layer = S.parsedLayers.find(l => l.index === layerIndex);
    displayLayer = layer?.name ?? '—';
  }

  // ── Extract Object Color (Shaded) ────────────────────────────────────
  // r169's getHexString() ALREADY converts working-linear → sRGB internally
  // (defaults to SRGBColorSpace via ColorManagement.fromWorkingColorSpace).
  // A previous fix mistakenly added .convertLinearToSRGB() on top, producing
  // a DOUBLE conversion — linear 0.012 (#1c1c1c sRGB) was emitted as #5d5d5d.
  // That made the color picker show a much lighter value than the surface
  // actually rendered, and editing it then over-brightened the material.
  const linearToSRGBHex = (color) => color.getHexString();
  // toHexFromRGB255: build sRGB hex from 0–255 components and use .set() so
  // Three.js applies the correct sRGB→linear conversion when storing the colour.
  const toHexFrom255 = (r, g, b) =>
    '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

  const getObjColorHex = (o) => {
    const li = (o.userData.layerIndex !== undefined) ? o.userData.layerIndex : (o.userData.attributes?.layerIndex);
    const l = S.parsedLayers.find(pl => pl.index === li);
    if (o.userData.objectColorCustom) {
      return o.userData.objectColorCustom;
    } else if (o.userData.isColorByLayer && l) {
      const hex = toHexFrom255(l.color.r ?? l.color.R ?? 0, l.color.g ?? l.color.G ?? 0, l.color.b ?? l.color.B ?? 0);
      const lc = new THREE.Color().set(hex);
      if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.set('#ffffff');
      return '#' + linearToSRGBHex(lc);
    } else if (o.userData.annIndex !== undefined) {
      const ann = S.parsedAnnotations[o.userData.annIndex];
      let c = new THREE.Color(0xffffff);
      if (ann.objectColor) {
        c.set(toHexFrom255(ann.objectColor.r, ann.objectColor.g, ann.objectColor.b));
      } else if (l?.color) {
        c.set(toHexFrom255(l.color.r ?? l.color.R ?? 0, l.color.g ?? l.color.G ?? 0, l.color.b ?? l.color.B ?? 0));
      }
      return '#' + linearToSRGBHex(c);
    } else {
      const shadedMat = o.userData.shadedMaterial || o.userData.originalMaterial;
      const mc = shadedMat?.color ?? o.material?.color;
      return mc ? ('#' + linearToSRGBHex(mc)) : '#ffffff';
    }
  };

  let allByLayer = S.selectedObjects.every(o => o.userData.isColorByLayer);
  let hexSame = true;
  let commonHex = null;
  S.selectedObjects.forEach((o, i) => {
    const hex = getObjColorHex(o);
    if (i === 0) commonHex = hex;
    else if (commonHex !== hex) hexSame = false;
  });

  const objColorHex = hexSame ? commonHex : '#888888';
  const colorSwatchStyle = hexSame
    ? `background: ${objColorHex};`
    : `background: linear-gradient(135deg, #ff453a, #32d74b, #0a84ff);`;
  const swatchLabel = hexSame ? '' : '<span style="font-size:0.65rem;color:var(--text-3);margin-left:4px;">Various</span>';

  // ── HTML Construction ────────────────────────────────────────────────
  // ── User Text tab (early return) ─────────────────────────────────────
  if (_activePropTab === 'usertext') {
    const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    let pairs = _getUserText(S.selectedObjects[0]);

    // Apply sort
    if (_utSortCol && pairs.length > 1) {
      const col = _utSortCol;
      const dir = _utSortDir === 'asc' ? 1 : -1;
      pairs = [...pairs].sort((a, b) => dir * a[col].localeCompare(b[col], undefined, { sensitivity: 'base', numeric: true }));
    }

    // Column header with sort indicator
    const _thHtml = (col, label) => {
      const active = _utSortCol === col;
      const arrow = active ? (_utSortDir === 'asc' ? ' ▲' : ' ▼') : ' <span class="ut-sort-idle">⇅</span>';
      return `<th class="ut-sortable${active ? ' ut-sort-active' : ''}" data-col="${col}">${label}${arrow}</th>`;
    };

    let rows = pairs.length
      ? pairs.map(p => `<tr><td>${_esc(p.key)}</td><td>${_esc(p.value)}</td></tr>`).join('')
      : `<tr><td colspan="2" class="prop-usertext-empty">No user text</td></tr>`;

    let utHtml = `<div class="prop-usertext"><table class="prop-usertext-table">
      <thead><tr>${_thHtml('key','Key')}${_thHtml('value','Value')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
    if (isMulti) {
      utHtml = `<div style="text-align:center;padding:6px 0 4px;font-size:0.78rem;font-weight:600;color:var(--text-1);">${S.selectedObjects.length} objects selected</div>` + utHtml;
    }
    document.getElementById('prop-content').innerHTML = utHtml;

    // Bind sort header clicks
    document.querySelectorAll('#prop-content .ut-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (_utSortCol === col) {
          _utSortDir = _utSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _utSortCol = col;
          _utSortDir = 'asc';
        }
        updatePropertiesPanel();
      });
    });

    panel.classList.remove('hidden');
    return;
  }

  let htmlContent = '';
  if (isMulti) {
    htmlContent += `
      <div style="grid-column:1/-1;text-align:center;padding:4px 0 10px 0; border-bottom: 1px solid var(--border); margin-bottom: 8px;">
        <span style="font-size:0.78rem;font-weight:600;color:var(--text-1);">${S.selectedObjects.length} objects selected</span>
      </div>`;
  }

  htmlContent += `
    <div class="prop-label">Name</div><div class="prop-value">${displayName}</div>
    <div class="prop-label">Layer</div><div class="prop-value">${displayLayer}</div>
    <div class="mat-divider"></div>
    <div class="mat-section-title">Object Color <span style="font-size:0.68rem;opacity:0.6">(Shaded)</span></div>
    <div class="mat-editor">
      <div class="mat-row" style="align-items: center; justify-content: space-between;">
        <span class="mat-label">Color</span>
        <div style="display:flex;align-items:center;gap:12px;margin-left:auto;">
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;margin:0;">
            <input type="checkbox" id="prop-bylayer-toggle" ${allByLayer ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--primary);margin:0;">
            <span style="font-size:0.7rem;color:var(--text-2)">ByLayer</span>
          </label>
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="text" id="prop-object-color" class="layer-color-picker-input" data-coloris value="${objColorHex}" inputmode="none"
                   style="width:14px; height:14px; border-radius:3px; border:1px solid rgba(255,255,255,0.18); cursor:pointer;
                          ${colorSwatchStyle} color:transparent; outline:none; flex-shrink:0; box-sizing:border-box; font-size:0; caret-color:transparent;">
            ${swatchLabel}
          </div>
        </div>
      </div>
    </div>`;

  // ── Rendered Material (shown if at least one selected mesh) ──────────
  const showMaterial = S.selectedObjects.some(o => o.isMesh);
  const selectedMeshes = S.selectedObjects.filter(o => o.isMesh);

  if (showMaterial) {
    const getMeshRenderedColor = (o) => {
      const li = (o.userData.attributes?.layerIndex) ?? 0;
      const layer = S.parsedLayers.find(l => l.index === li);
      // Priority: object-level customMaterial > layer customMaterial (when ByLayer) > rendered/original material
      if (o.userData.customMaterial?.color) return o.userData.customMaterial.color;
      if (o.userData.isMaterialByLayer && !o.userData.customMaterial && layer?.customMaterial?.color) {
        return layer.customMaterial.color;
      }
      const orig = o.userData.renderedMaterial || o.userData.originalMaterial;
      return orig?.color ? ('#' + linearToSRGBHex(orig.color)) : '#ffffff';
    };

    let matHexSame = true;
    let commonMatHex = null;
    selectedMeshes.forEach((o, i) => {
      const hex = getMeshRenderedColor(o);
      if (i === 0) commonMatHex = hex;
      else if (commonMatHex !== hex) matHexSame = false;
    });

    const matColorHex = matHexSame ? commonMatHex : '#ffffff';
    const matColorSwatchStyle = matHexSame
      ? `background: ${matColorHex};`
      : `background: linear-gradient(135deg, #ff453a, #32d74b, #0a84ff);`;
    const matSwatchLabel = matHexSame ? '' : '<span style="font-size:0.65rem;color:var(--text-3);margin-left:4px;">Various</span>';

    const getMeshVal = (o, prop, def) => {
      const li = (o.userData.attributes?.layerIndex) ?? 0;
      const layer = S.parsedLayers.find(l => l.index === li);
      const orig = o.userData.renderedMaterial || o.userData.originalMaterial;
      // Priority: object customMaterial > layer customMaterial (ByLayer) > rendered/original
      if (o.userData.customMaterial && o.userData.customMaterial[prop] !== undefined) return o.userData.customMaterial[prop];
      if (o.userData.isMaterialByLayer && !o.userData.customMaterial && layer?.customMaterial?.[prop] !== undefined) return layer.customMaterial[prop];
      return orig?.[prop] ?? def;
    };


    const getCommonVal = (prop, def) => {
      let commonVal = null;
      let same = true;
      selectedMeshes.forEach((o, i) => {
        const v = getMeshVal(o, prop, def);
        if (i === 0) commonVal = v;
        else if (Math.abs(commonVal - v) > 1e-4) same = false;
      });
      return { same, val: same ? commonVal : 0.50 };
    };

    const commonRoughness = getCommonVal('roughness', 0.5);
    const commonMetalness = getCommonVal('metalness', 0.0);
    const commonOpacity   = getCommonVal('opacity', 1.0);

    const roughnessReadout = commonRoughness.same ? commonRoughness.val.toFixed(2) : 'Various';
    const metalnessReadout = commonMetalness.same ? commonMetalness.val.toFixed(2) : 'Various';
    const opacityReadout   = commonOpacity.same   ? commonOpacity.val.toFixed(2)   : 'Various';

    const getMeshTexName = (o) => {
      const orig = o.userData.renderedMaterial || o.userData.originalMaterial;
      const custom = o.userData.customMaterial || {};
      const map = custom.hasOwnProperty('mapTexture') ? custom.mapTexture : (orig?.map ?? null);
      return custom.mapName ?? (orig?.map?.name || (map ? 'Texture' : 'None'));
    };

    let commonTexName = null;
    let texSame = true;
    selectedMeshes.forEach((o, i) => {
      const tn = getMeshTexName(o);
      if (i === 0) commonTexName = tn;
      else if (commonTexName !== tn) texSame = false;
    });

    const displayTexName = texSame ? commonTexName : 'Various';
    const hasTex = texSame && commonTexName !== 'None' && commonTexName !== 'Various';
    const hasCustom = selectedMeshes.some(o => !!o.userData.customMaterial);
    // isMaterialByLayer: all selected meshes have no object-level customMaterial AND isMaterialByLayer flag
    const allMatByLayer = selectedMeshes.every(o => o.userData.isMaterialByLayer && !o.userData.customMaterial);

    htmlContent += `
      <div class="mat-divider"></div>
      <div class="mat-section-title">Material <span style="font-size:0.68rem;opacity:0.6">(Rendered)</span></div>
      <div class="mat-editor">
        <div class="mat-row" style="align-items: center; justify-content: space-between;">
          <span class="mat-label">Color</span>
          <div style="display:flex;align-items:center;gap:12px;margin-left:auto;">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;margin:0;">
              <input type="checkbox" id="prop-mat-bylayer-toggle" ${allMatByLayer ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--primary);margin:0;">
              <span style="font-size:0.7rem;color:var(--text-2)">ByLayer</span>
            </label>
            <div style="display:flex;align-items:center;gap:4px;">
              <input type="text" id="mat-color" class="layer-color-picker-input" data-coloris value="${matColorHex}" inputmode="none"
                     style="width:14px; height:14px; border-radius:3px; border:1px solid rgba(255,255,255,0.18); cursor:pointer;
                            ${matColorSwatchStyle} color:transparent; outline:none; flex-shrink:0; box-sizing:border-box; font-size:0; caret-color:transparent;">
              ${matSwatchLabel}
            </div>
          </div>
        </div>
        <div class="mat-row">
          <span class="mat-label">Roughness</span>
          <input type="range" id="mat-roughness" min="0" max="1" step="0.01" value="${commonRoughness.val.toFixed(2)}" style="flex:1">
          <span class="mat-val" id="mat-roughness-val">${roughnessReadout}</span>
        </div>
        <div class="mat-row">
          <span class="mat-label">Metalness</span>
          <input type="range" id="mat-metalness" min="0" max="1" step="0.01" value="${commonMetalness.val.toFixed(2)}" style="flex:1">
          <span class="mat-val" id="mat-metalness-val">${metalnessReadout}</span>
        </div>
        <div class="mat-row">
          <span class="mat-label">Opacity</span>
          <input type="range" id="mat-opacity" min="0" max="1" step="0.01" value="${commonOpacity.val.toFixed(2)}" style="flex:1">
          <span class="mat-val" id="mat-opacity-val">${opacityReadout}</span>
        </div>
        <div class="mat-row" style="align-items: center; gap: 8px;">
          <span class="mat-label">Texture</span>
          <div style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;">
            <button id="btn-mat-tex-upload" class="panel-action-btn" style="padding: 3px 8px; font-size: 0.68rem; margin: 0; background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; height: auto;">
              Upload
            </button>
            <input type="file" id="mat-tex-file-input" accept="image/*" style="display: none;">
            <span id="mat-tex-name" style="font-size: 0.65rem; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px;" title="${displayTexName}">
              ${displayTexName}
            </span>
            ${hasTex ? `
              <button id="btn-mat-tex-remove" style="background: none; border: none; color: var(--text-3); cursor: pointer; padding: 2px; display: inline-flex; align-items: center; margin-left: auto;">
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="mat-footer">
          <button id="btn-mat-reset" class="text-btn" style="font-size:0.74rem"${hasCustom ? '' : ' disabled'}>Reset</button>
        </div>
      </div>`;
  }

  // ── Transform Section ────────────────────────────────────────────────
  const modified = S.selectedObjects.some(isTransformModified);
  htmlContent += `
    <div class="mat-divider"></div>
    <div class="mat-section-title">Transform ${modified ? ' <span style="font-size:0.68rem;color:var(--accent)">(modified)</span>' : ''}</div>
    <div class="mat-editor">
      <div class="mat-row">
        <span class="mat-label">Status</span>
        <span id="prop-transform-status" style="font-size:0.68rem;color:${modified ? 'var(--accent)' : 'var(--text-3)'};font-weight:600;">
          ${modified ? 'Modified' : 'Original'}
        </span>
      </div>
      <div class="mat-footer" style="margin-top:8px;">
        <button id="btn-transform-reset" class="text-btn" style="font-size:0.74rem"${modified ? '' : ' disabled'}>Reset Transform</button>
      </div>
    </div>`;

  if (isMulti) {
    htmlContent += `
      <div class="mat-divider"></div>
      <div class="mat-editor" style="padding-top: 4px;">
        <div class="mat-footer">
          <button id="btn-clear-selection" class="text-btn" style="font-size:0.74rem;color:var(--text-3);">Clear Selection</button>
        </div>
      </div>`;
  }

  document.getElementById('prop-content').innerHTML = `<div class="prop-grid">${htmlContent}</div>`;

  // ── Bind Multi / Single Selection Listeners ──────────────────────────
  
  // Clear selection
  if (isMulti) {
    document.getElementById('btn-clear-selection')?.addEventListener('click', () => {
      clearSelection(); updatePropertiesPanel();
    });
  }

    document.getElementById('prop-bylayer-toggle')?.addEventListener('change', e => {
      const checked = e.target.checked;
      
      // Capture before state
      const beforeState = S.selectedObjects.map(obj => ({
        objectColorCustom: obj.userData.objectColorCustom,
        isColorByLayer: obj.userData.isColorByLayer
      }));
  
      S.selectedObjects.forEach(obj => {
      obj.userData.isColorByLayer = checked;
      const li = (obj.userData.layerIndex !== undefined) ? obj.userData.layerIndex : (obj.userData.attributes?.layerIndex);
      
      if (obj.userData.annIndex !== undefined) {
        const ann = S.parsedAnnotations[obj.userData.annIndex];
        ann.isColorByLayer = checked;
        if (checked) {
          ann.objectColorCustom = undefined;
          obj.userData.objectColorCustom = undefined;
        } else {
          ann.objectColorCustom = objColorHex;
          obj.userData.objectColorCustom = objColorHex;
        }
      } else {
        if (checked) {
          const l = S.parsedLayers.find(pl => pl.index === li);
          if (l) {
            const hexStr = '#' + [
              l.color?.r ?? l.color?.R ?? 120,
              l.color?.g ?? l.color?.G ?? 120,
              l.color?.b ?? l.color?.B ?? 120
            ].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
            const lc = new THREE.Color().set(hexStr);
            if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.set('#ffffff');
            if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.copy(lc);
            obj.traverse(child => {
              if (child.userData.selectionBackup) {
                child.userData.selectionBackup.color.copy(lc);
                if (child.userData.selectionBackup.material && child.userData.selectionBackup.material.color) {
                  child.userData.selectionBackup.material.color.copy(lc);
                }
              }
            });
            if (obj.material && !obj.userData.selectionBackup) obj.material.color.copy(lc);
            obj.userData.objectColorCustom = undefined;
          }
        } else {
          // Read the current linear-space colour and convert to sRGB hex for storage.
          const mc = obj.userData.shadedMaterial?.color ?? obj.material?.color;
          const current = mc ? ('#' + mc.getHexString()) : '#cccccc';
          obj.userData.objectColorCustom = current;
        }
      }
    });

    const afterState = S.selectedObjects.map(obj => ({
      objectColorCustom: obj.userData.objectColorCustom,
      isColorByLayer: obj.userData.isColorByLayer
    }));

    History.push({
      type: 'color',
      targets: [...S.selectedObjects],
      before: beforeState,
      after: afterState
    });

    if (S.selectedObjects.some(o => o.userData.annIndex !== undefined)) {
      import('./annotations.js').then(a => a.createAnnotationSprites());
    } else {
      applyDisplayMode();
    }
    updatePropertiesPanel();
  });

  // Object Color picker drag & finalize captures
  let objectColorBeforeState = null;
  document.getElementById('prop-object-color')?.addEventListener('input', e => {
    const val = e.target.value;
    
    if (!objectColorBeforeState) {
      objectColorBeforeState = S.selectedObjects.map(obj => ({
        objectColorCustom: obj.userData.objectColorCustom,
        isColorByLayer: obj.userData.isColorByLayer
      }));
    }
    
    S.selectedObjects.forEach(obj => {
      obj.userData.objectColorCustom = val;
      obj.userData.isColorByLayer = false;
      
      if (obj.userData.annIndex !== undefined) {
        const ann = S.parsedAnnotations[obj.userData.annIndex];
        ann.objectColorCustom = val;
        ann.isColorByLayer = false;
      } else {
        obj.traverse(child => {
          if (child.userData.selectionBackup) {
            child.userData.selectionBackup.color.set(val);
            if (child.userData.selectionBackup.material && child.userData.selectionBackup.material.color) {
              child.userData.selectionBackup.material.color.set(val);
            }
          }
        });
        if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.set(val);
        if (obj.material && !obj.userData.selectionBackup) obj.material.color.set(val);
      }
    });

    if (S.selectedObjects.some(o => o.userData.annIndex !== undefined)) {
      import('./annotations.js').then(a => a.createAnnotationSprites());
    } else {
      applyDisplayMode();
    }
    
    const wrapper = e.target.parentNode;
    if (wrapper && wrapper.classList.contains('clr-field')) {
      wrapper.style.color = val;
    }
    
    const toggle = document.getElementById('prop-bylayer-toggle');
    if (toggle) { toggle.checked = false; }
  });

  document.getElementById('prop-object-color')?.addEventListener('change', e => {
    const val = e.target.value;
    console.log('[Color Picker] change event triggered. Current objectColorBeforeState:', objectColorBeforeState);
    const beforeState = objectColorBeforeState || S.selectedObjects.map(obj => ({
      objectColorCustom: obj.userData.objectColorCustom,
      isColorByLayer: obj.userData.isColorByLayer
    }));
    
    const afterState = S.selectedObjects.map(obj => ({
      objectColorCustom: val,
      isColorByLayer: false
    }));
    
    console.log('[Color Picker] Pushing color change to History. beforeState:', beforeState, 'afterState:', afterState);
    History.push({
      type: 'color',
      targets: [...S.selectedObjects],
      before: beforeState,
      after: afterState
    });
    objectColorBeforeState = null;
  });

  // ── Material Editor Listeners ──────────────────────────────────────
  if (showMaterial) {
    const enableResetBtn = () => {
      const resetBtn = document.getElementById('btn-mat-reset');
      if (resetBtn) resetBtn.removeAttribute('disabled');
    };

    // Editing any material property promotes the object off ByLayer. ensureCustomMaterial()
    // already flips userData.isMaterialByLayer to false; this keeps the checkbox UI in sync.
    const unsetMatByLayerToggle = () => {
      const t = document.getElementById('prop-mat-bylayer-toggle');
      if (t) t.checked = false;
    };

    // Material ByLayer Toggle
    document.getElementById('prop-mat-bylayer-toggle')?.addEventListener('change', e => {
      const checked = e.target.checked;

      const beforeState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      selectedMeshes.forEach(obj => {
        const li = (obj.userData.attributes?.layerIndex) ?? 0;
        if (checked) {
          // Remove object-level override → fall back to layer material
          obj.userData.customMaterial = null;
          obj.userData.isMaterialByLayer = true;
        } else {
          // Promote the effective material to a custom override so user can edit
          const layer = S.parsedLayers.find(l => l.index === li);
          const orig = obj.userData.renderedMaterial || obj.userData.originalMaterial;
          const layerCm = layer?.customMaterial;
          obj.userData.isMaterialByLayer = false;
          obj.userData.customMaterial = {
            color:      layerCm?.color      ?? (orig?.color ? ('#' + orig.color.getHexString()) : '#cccccc'),
            roughness:  layerCm?.roughness  ?? orig?.roughness  ?? 0.5,
            metalness:  layerCm?.metalness  ?? orig?.metalness  ?? 0.0,
            opacity:    layerCm?.opacity    ?? orig?.opacity    ?? 1.0,
            mapTexture: layerCm?.mapTexture ?? orig?.map        ?? null,
            mapName:    layerCm?.mapName    ?? (orig?.map?.name || (orig?.map ? 'Texture' : 'None'))
          };
        }
      });

      const afterState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      History.push({
        type: 'material',
        targets: [...selectedMeshes],
        before: beforeState,
        after: afterState
      });

      applyDisplayMode();
      updatePropertiesPanel();
    });

    // Material Color drag & finalize captures
    let matColorBeforeState = null;
    document.getElementById('mat-color')?.addEventListener('input', e => {
      const val = e.target.value;

      if (!matColorBeforeState) {
        // Capture BEFORE ensureCustomMaterial() flips isMaterialByLayer → records the original ByLayer state.
        matColorBeforeState = selectedMeshes.map(obj => ({
          customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
          isMaterialByLayer: !!obj.userData.isMaterialByLayer
        }));
      }

      selectedMeshes.forEach(obj => {
        ensureCustomMaterial(obj);
        obj.userData.customMaterial.color = val;
      });
      const wrapper = e.target.parentNode;
      if (wrapper && wrapper.classList.contains('clr-field')) {
        wrapper.style.color = val;
      }
      unsetMatByLayerToggle();
      enableResetBtn();
      applyDisplayMode();
    });

    document.getElementById('mat-color')?.addEventListener('change', () => {
      const beforeState = matColorBeforeState || selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));
      const afterState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      History.push({
        type: 'material',
        targets: [...selectedMeshes],
        before: beforeState,
        after: afterState
      });
      matColorBeforeState = null;
    });

    // Roughness
    document.getElementById('mat-roughness')?.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById('mat-roughness-val').textContent = v.toFixed(2);
      selectedMeshes.forEach(obj => {
        ensureCustomMaterial(obj);
        obj.userData.customMaterial.roughness = v;
      });
      unsetMatByLayerToggle();
      enableResetBtn();
      applyDisplayMode();
    });

    // Metalness
    document.getElementById('mat-metalness')?.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById('mat-metalness-val').textContent = v.toFixed(2);
      selectedMeshes.forEach(obj => {
        ensureCustomMaterial(obj);
        obj.userData.customMaterial.metalness = v;
      });
      unsetMatByLayerToggle();
      enableResetBtn();
      applyDisplayMode();
    });

    // Opacity
    document.getElementById('mat-opacity')?.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById('mat-opacity-val').textContent = v.toFixed(2);
      selectedMeshes.forEach(obj => {
        ensureCustomMaterial(obj);
        obj.userData.customMaterial.opacity = v;
      });
      unsetMatByLayerToggle();
      enableResetBtn();
      applyDisplayMode();
    });

    // Bind grabs and changes to sliders
    const bindSliderCapture = (id) => {
      let beforeState = null;
      const sl = document.getElementById(id);
      if (!sl) return;
      const grab = () => {
        if (!beforeState) {
          // mousedown/touchstart fire before the input handler runs ensureCustomMaterial,
          // so this captures the original ByLayer state for correct undo.
          beforeState = selectedMeshes.map(obj => ({
            customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
            isMaterialByLayer: !!obj.userData.isMaterialByLayer
          }));
        }
      };
      sl.addEventListener('mousedown', grab);
      sl.addEventListener('touchstart', grab);
      sl.addEventListener('change', () => {
        const fallbackBefore = beforeState || selectedMeshes.map(obj => ({
          customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
          isMaterialByLayer: !!obj.userData.isMaterialByLayer
        }));
        const afterState = selectedMeshes.map(obj => ({
          customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
          isMaterialByLayer: !!obj.userData.isMaterialByLayer
        }));
        console.log('[Slider] Pushing slider change to History. beforeState:', fallbackBefore, 'afterState:', afterState);
        History.push({
          type: 'material',
          targets: [...selectedMeshes],
          before: fallbackBefore,
          after: afterState
        });
        beforeState = null;
      });
    };
    bindSliderCapture('mat-roughness');
    bindSliderCapture('mat-metalness');
    bindSliderCapture('mat-opacity');

    // Precise inline number input overlays
    bindSliderDblClickInput('mat-roughness', 'mat-roughness-val');
    bindSliderDblClickInput('mat-metalness', 'mat-metalness-val');
    bindSliderDblClickInput('mat-opacity', 'mat-opacity-val');

    // Texture Upload
    document.getElementById('btn-mat-tex-upload')?.addEventListener('click', () => {
      document.getElementById('mat-tex-file-input').click();
    });
    document.getElementById('mat-tex-file-input')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;

      const beforeState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      const url = URL.createObjectURL(file);
      new THREE.TextureLoader().load(url, texture => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;

        selectedMeshes.forEach(obj => {
          ensureCustomMaterial(obj);
          obj.userData.customMaterial.mapTexture = texture;
          obj.userData.customMaterial.mapName = file.name;
        });

        const afterState = selectedMeshes.map(obj => ({
          customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
          isMaterialByLayer: !!obj.userData.isMaterialByLayer
        }));

        History.push({
          type: 'material',
          targets: [...selectedMeshes],
          before: beforeState,
          after: afterState
        });
        
        enableResetBtn();
        applyDisplayMode();
        updatePropertiesPanel();
      });
    });

    // Texture Remove
    document.getElementById('btn-mat-tex-remove')?.addEventListener('click', () => {
      const beforeState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      selectedMeshes.forEach(obj => {
        ensureCustomMaterial(obj);
        obj.userData.customMaterial.mapTexture = null;
        obj.userData.customMaterial.mapName = 'None';
      });

      const afterState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      History.push({
        type: 'material',
        targets: [...selectedMeshes],
        before: beforeState,
        after: afterState
      });

      enableResetBtn();
      applyDisplayMode();
      updatePropertiesPanel();
    });

    // Material Reset
    document.getElementById('btn-mat-reset')?.addEventListener('click', () => {
      const beforeState = selectedMeshes.map(obj => ({
        customMaterial: obj.userData.customMaterial ? { ...obj.userData.customMaterial } : null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      selectedMeshes.forEach(obj => {
        obj.userData.customMaterial = null;
        // Restore the original Rhino MaterialSource flag if we captured it at load time;
        // otherwise default to false so the object keeps its renderedMaterial.
        obj.userData.isMaterialByLayer = !!obj.userData.originalIsMaterialByLayer;
      });

      const afterState = selectedMeshes.map(obj => ({
        customMaterial: null,
        isMaterialByLayer: !!obj.userData.isMaterialByLayer
      }));

      History.push({
        type: 'material',
        targets: [...selectedMeshes],
        before: beforeState,
        after: afterState
      });

      applyDisplayMode();
      updatePropertiesPanel();
    });
  }

  // ── Transform Reset Listener ─────────────────────────────────────────
  document.getElementById('btn-transform-reset')?.addEventListener('click', () => {
    const beforeState = S.selectedObjects.map(obj => ({
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone()
    }));

    S.selectedObjects.forEach(obj => {
      resetTransform(obj);
    });

    const afterState = S.selectedObjects.map(obj => ({
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone()
    }));

    History.push({
      type: 'transform',
      targets: [...S.selectedObjects],
      before: beforeState,
      after: afterState
    });

    setupGumballHelper();
    applyDisplayMode();
    updatePropertiesPanel();
  });

  if (window.Coloris) {
    Coloris.wrap('.layer-color-picker-input');
  }

  panel.classList.remove('hidden');
}

// ── Custom material helper ────────────────────────────────────────────────────

export function ensureCustomMaterial(obj) {
  if (!obj.userData.customMaterial) {
    const li = (obj.userData.attributes?.layerIndex) ?? 0;
    const layer = S.parsedLayers.find(l => l.index === li);
    const orig = obj.userData.renderedMaterial || obj.userData.originalMaterial;
    
    if (obj.userData.isMaterialByLayer && layer?.customMaterial) {
      const lcm = layer.customMaterial;
      obj.userData.customMaterial = {
        color:      lcm.color      ?? (orig?.color ? ('#' + orig.color.getHexString()) : '#ffffff'),
        roughness:  lcm.roughness  ?? orig?.roughness  ?? 0.5,
        metalness:  lcm.metalness  ?? orig?.metalness  ?? 0.0,
        opacity:    lcm.opacity    ?? orig?.opacity    ?? 1.0,
        mapTexture: lcm.mapTexture ?? orig?.map        ?? null,
        mapName:    lcm.mapName    ?? (orig?.map?.name || (orig?.map ? 'Texture' : 'None'))
      };
    } else {
      obj.userData.customMaterial = {
        color:      orig?.color ? ('#' + orig.color.getHexString()) : '#ffffff',
        roughness:  orig?.roughness ?? 0.5,
        metalness:  orig?.metalness ?? 0.0,
        opacity:    orig?.opacity   ?? 1.0,
        mapTexture: orig?.map ?? null,
        mapName:    orig?.map?.name || (orig?.map ? 'Texture' : 'None')
      };
    }
    obj.userData.isMaterialByLayer = false;
  }
}

// ── Gumball Helpers ────────────────────────────────────────────────────────────

export function setupGumballHelper() {
  if (S.gumballTransformControls) S.gumballTransformControls.detach();

  // Remove old arc handles
  if (S.gumballArcHandles) {
    S.gumballArcHandles.forEach(h => {
      S.arcOverlayScene.remove(h.mesh);
      S.arcOverlayScene.remove(h.hitMesh);
      h.mesh.geometry.dispose();
      h.mesh.material.dispose();
      h.hitMesh.geometry.dispose();
      h.hitMesh.material.dispose();
    });
  }
  S.gumballArcHandles = [];
  S.gumballArcDrag = null;

  if (S.gumballHelper) {
    S.arcOverlayScene.remove(S.gumballHelper);
    S.gumballHelper = null;
  }

  if (!S.gumballActive || S.selectedObjects.length === 0) return;

  // 1. Calculate combined bounding box of all selected objects to find the center
  const box = new THREE.Box3();
  S.selectedObjects.forEach(obj => {
    box.expandByObject(obj);
  });
  const center = box.getCenter(new THREE.Vector3());

  // 2. Create S.gumballHelper proxy at the center
  S.gumballHelper = new THREE.Group();
  S.gumballHelper.name = 'gumball-helper-proxy';
  S.gumballHelper.position.copy(center);
  
  // Set initial quaternion aligned with the first selected object (or default identity)
  if (S.selectedObjects.length === 1) {
    S.gumballHelper.quaternion.copy(S.selectedObjects[0].quaternion);
  } else {
    S.gumballHelper.quaternion.set(0, 0, 0, 1);
  }
  
  S.arcOverlayScene.add(S.gumballHelper);

  // 3. Build custom local rotation arcs
  // Determine appropriate size based on model size or bounding box size
  const modelSize = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length()
    : 100;
  const size = modelSize * 0.15; // Gumball size relative to overall model size

  buildGumballArcHandles(size);

  // Sync arc handles
  S.gumballHelper.updateMatrixWorld(true);
  S.gumballArcHandles.forEach(h => {
    h.mesh.position.copy(S.gumballHelper.position);
    h.mesh.quaternion.copy(S.gumballHelper.quaternion);
    h.hitMesh.position.copy(S.gumballHelper.position);
    h.hitMesh.quaternion.copy(S.gumballHelper.quaternion);
  });

  // 4. Attach S.gumballTransformControls to S.gumballHelper
  if (S.gumballTransformControls) {
    S.gumballTransformControls.size = 0.65;
    S.gumballTransformControls.attach(S.gumballHelper);
    S.gumballTransformControls.getHelper().visible = true;
  }
}

export function clearGumballHelper() {
  if (S.gumballTransformControls) {
    S.gumballTransformControls.detach();
    S.gumballTransformControls.getHelper().visible = false;
  }

  if (S.gumballArcHandles) {
    S.gumballArcHandles.forEach(h => {
      S.arcOverlayScene.remove(h.mesh);
      S.arcOverlayScene.remove(h.hitMesh);
      h.mesh.geometry.dispose();
      h.mesh.material.dispose();
      h.hitMesh.geometry.dispose();
      h.hitMesh.material.dispose();
    });
  }
  S.gumballArcHandles = [];
  S.gumballArcDrag = null;

  if (S.gumballHelper) {
    S.arcOverlayScene.remove(S.gumballHelper);
    S.gumballHelper = null;
  }
}

export function buildGumballArcHandles(size) {
  const arcRadius = 10.0;
  const arcTube = 0.20; // thicker tube (2% of radius) identical to clipping plane
  const pathSegs = 32;
  const tubeSegs = 6;

  class ArcCurve extends THREE.Curve {
    constructor(axis, r) { super(); this.axis = axis; this.r = r; }
    getPoint(t) {
      const a = (Math.PI / 2) * t; // 0 to 90 degrees
      const r = this.r;
      if (this.axis === 'x') {
        return new THREE.Vector3(0, -r * Math.cos(a), -r * Math.sin(a));
      } else if (this.axis === 'y') {
        return new THREE.Vector3(-r * Math.cos(a), 0, -r * Math.sin(a));
      } else {
        return new THREE.Vector3(-r * Math.cos(a), -r * Math.sin(a), 0);
      }
    }
  }

  const axes = [
    { axis: 'x', color: 0xff3b30 }, // Red
    { axis: 'y', color: 0x34c759 }, // Green
    { axis: 'z', color: 0x007aff }  // Blue
  ];

  axes.forEach(cfg => {
    const curve = new ArcCurve(cfg.axis, arcRadius);

    // Visible tube
    const arcGeo = new THREE.TubeGeometry(curve, pathSegs, arcTube, tubeSegs, false);
    const arcMat = new THREE.MeshBasicMaterial({
      color: cfg.color,
      depthTest: false, depthWrite: false,
      transparent: true, opacity: 0.92,
      side: THREE.DoubleSide
    });
    const arcMesh = new THREE.Mesh(arcGeo, arcMat);
    arcMesh.castShadow = false;
    arcMesh.receiveShadow = false;
    arcMesh.renderOrder = 1000;
    arcMesh.userData.gumballArcAxis = cfg.axis;

    // Hit area (same curve, larger tube)
    const hitGeo = new THREE.TubeGeometry(curve, pathSegs, arcRadius * 0.12, tubeSegs, false);
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0,
      depthTest: false, depthWrite: false,
      side: THREE.DoubleSide
    });
    const hitMesh = new THREE.Mesh(hitGeo, hitMat);
    hitMesh.castShadow = false;
    hitMesh.receiveShadow = false;
    hitMesh.renderOrder = 1001;
    hitMesh.userData.gumballArcAxis = cfg.axis;
    hitMesh.userData.isGumballArcHitArea = true;

    S.arcOverlayScene.add(arcMesh);
    S.arcOverlayScene.add(hitMesh);
    S.gumballArcHandles.push({ mesh: arcMesh, hitMesh, axis: cfg.axis });
  });
}

// ── Transform Snap & Reset Helpers ─────────────────────────────────────────────

export function ensureOriginalTransform(obj) {
  if (!obj.userData.originalTransform) {
    obj.userData.originalTransform = {
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone()
    };
  }
}

export function isTransformModified(obj) {
  if (!obj.userData.originalTransform) return false;
  const orig = obj.userData.originalTransform;
  const posDiff = obj.position.distanceTo(orig.position) > 1e-4;
  const quatDiff = obj.quaternion.angleTo(orig.quaternion) > 1e-4;
  const scaleDiff = obj.scale.distanceTo(orig.scale) > 1e-4;
  return posDiff || quatDiff || scaleDiff;
}

export function resetTransform(obj) {
  if (obj.userData.originalTransform) {
    obj.position.copy(obj.userData.originalTransform.position);
    obj.quaternion.copy(obj.userData.originalTransform.quaternion);
    obj.scale.copy(obj.userData.originalTransform.scale);
    obj.updateMatrixWorld(true);
  }
}
