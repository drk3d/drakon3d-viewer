import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode } from './display.js';

// ── Pointer hit-test / selection ─────────────────────────────────────────────

export function onPointerDown(event) {
  if (!S.currentModel || S.selectMode === 'none') return;

  if (S.clippingTransformControls && S.clippingTransformControls.getHelper().visible && S.clippingTransformControls.object) {
    const tmpMouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    S.raycaster.setFromCamera(tmpMouse, S.camera);
    const gHits = S.raycaster.intersectObjects(S.clippingTransformControls.getHelper().children, true);
    if (gHits.length > 0) return;
  }

  // Block selection when dragging arc rotation handles
  if (S.clippingArcDrag) return;

  S.mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);

  const allHits = S.raycaster.intersectObject(S.currentModel, true);
  const hit = allHits.find(i =>
    (i.object.isMesh || i.object.isLine || i.object.isLineSegments)
    && i.object.name !== 'rhino-edges'
    && i.object.name !== 'rhino-outline'
    && i.object.name !== 'selection-outline'
    && i.object.name !== 'ground-plane'
    && i.object.visible);

  const multi = S.selectMode === 'multi' || event.shiftKey || event.ctrlKey || event.metaKey;

  if (hit) {
    const obj = hit.object;
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
  updatePropertiesPanel();
}

// ── Selection outline (BackSide silhouette highlight) ─────────────────────────

export function addSelectionOutline(mesh) {
  clearSelectionOutline(mesh);

  if (mesh.isLine || mesh.isLineSegments) {
    const mat = new THREE.LineBasicMaterial({
      color: 0x22aaff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9
    });
    const outline = mesh.isLineSegments
      ? new THREE.LineSegments(mesh.geometry, mat)
      : new THREE.Line(mesh.geometry, mat);
    outline.name = 'selection-outline';
    outline.renderOrder = 999;
    mesh.add(outline);
    return;
  }

  const mat = new THREE.MeshBasicMaterial({
    color: 0x22aaff, side: THREE.BackSide,
    depthTest: true, depthWrite: false, transparent: true, opacity: 1.0
  });
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = 'selection-outline';
  outline.renderOrder = 999;

  const s = 1.018;
  const bbox = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
  const center = bbox.getCenter(new THREE.Vector3());
  outline.position.copy(center.multiplyScalar(1 - s));
  outline.scale.setScalar(s);

  mesh.add(outline);
}

export function clearSelectionOutline(mesh) {
  const existing = mesh.getObjectByName('selection-outline');
  if (existing) { existing.material.dispose(); mesh.remove(existing); }
}

export function clearSelection() {
  S.selectedObjects.forEach(o => clearSelectionOutline(o));
  S.selectedObjects = [];
}

// ── Properties panel ──────────────────────────────────────────────────────────

export function updatePropertiesPanel() {
  const panel = document.getElementById('object-properties');
  if (!S.selectedObjects.length) { panel.classList.add('hidden'); return; }

  if (S.selectedObjects.length > 1) {
    document.getElementById('prop-content').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:8px 0">
        <b>${S.selectedObjects.length} objects selected</b><br><br>
        <div style="display:flex;gap:8px;justify-content:center">
          <button id="btn-clear-selection" class="text-btn">Clear</button>
          <button id="btn-hide-selected" class="text-btn">Hide</button>
        </div>
      </div>`;
    document.getElementById('btn-clear-selection').addEventListener('click', () => {
      clearSelection(); updatePropertiesPanel();
    });
    document.getElementById('btn-hide-selected').addEventListener('click', () => {
      S.selectedObjects.forEach(child => {
        child.visible = false;
        S.hiddenObjects.add(child);
      });
      clearSelection();
      document.getElementById('object-properties').classList.add('hidden');
    });
    panel.classList.remove('hidden');
    return;
  }

  const obj   = S.selectedObjects[0];
  const attrs = obj.userData.attributes || {};
  const layer = S.parsedLayers.find(l => l.index === attrs.layerIndex);

  const shadedMat = obj.userData.shadedMaterial || obj.userData.originalMaterial;
  const objColorCustom = obj.userData.objectColorCustom;
  let objColorHex;
  if (objColorCustom) {
    objColorHex = objColorCustom;
  } else if (obj.userData.isColorByLayer && layer) {
    const lc = new THREE.Color(layer.color.r/255, layer.color.g/255, layer.color.b/255);
    if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.setHex(0xffffff);
    objColorHex = '#' + lc.getHexString();
  } else {
    objColorHex = '#' + (shadedMat?.color?.getHexString() ?? 'ffffff');
  }

  const isRendered = S.currentMode === 'rendered';
  const orig = isRendered
    ? (obj.userData.renderedMaterial || obj.userData.originalMaterial)
    : (obj.userData.shadedMaterial   || obj.userData.originalMaterial);
  const custom      = obj.userData.customMaterial || {};
  const matColor    = custom.color      ?? ('#' + (orig?.color?.getHexString() ?? 'ffffff'));
  const matRoughness = custom.roughness ?? (orig?.roughness ?? 0.5);
  const matMetalness = custom.metalness ?? (orig?.metalness ?? 0.0);
  const matOpacity   = custom.opacity   ?? (orig?.opacity   ?? 1.0);
  const hasCustom    = !!obj.userData.customMaterial;

  document.getElementById('prop-content').innerHTML = `
    <div class="prop-label">Name</div><div class="prop-value">${attrs.name || 'Unnamed'}</div>
    <div class="prop-label">Layer</div><div class="prop-value">${layer?.name ?? '—'}</div>
    <div class="mat-divider"></div>
    <div class="mat-section-title">Object Color <span style="font-size:0.68rem;opacity:0.6">(Shaded)</span></div>
    <div class="mat-editor">
      <div class="mat-row">
        <span class="mat-label">ByLayer</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="prop-bylayer-toggle" ${obj.userData.isColorByLayer ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--primary);">
          <span style="font-size:0.65rem;color:var(--text-2)">${obj.userData.isColorByLayer ? 'On' : 'Off'}</span>
        </label>
      </div>
      <div class="mat-row">
        <span class="mat-label">Color</span>
        <input type="text" id="prop-object-color" class="layer-color-picker-input" data-coloris value="${objColorHex}" inputmode="none"
               style="width:14px; height:14px; border-radius:3px; border:1px solid rgba(255,255,255,0.18); cursor:pointer;
                      background:${objColorHex}; color:transparent; outline:none; flex-shrink:0; box-sizing:border-box; font-size:0; caret-color:transparent;">
      </div>
    </div>
    <div class="mat-divider"></div>
    <div class="mat-section-title">Material${hasCustom ? ' <span style="font-size:0.68rem;color:var(--accent)">(overridden)</span>' : ''} <span style="font-size:0.68rem;opacity:0.6">(Rendered)</span></div>
    <div class="mat-editor">
      <div class="mat-row">
        <span class="mat-label">Color</span>
        <input type="text" id="mat-color" class="layer-color-picker-input" data-coloris value="${matColor}" inputmode="none"
               style="width:14px; height:14px; border-radius:3px; border:1px solid rgba(255,255,255,0.18); cursor:pointer;
                      background:${matColor}; color:transparent; outline:none; flex-shrink:0; box-sizing:border-box; font-size:0; caret-color:transparent;">
      </div>
      <div class="mat-row">
        <span class="mat-label">Roughness</span>
        <input type="range" id="mat-roughness" min="0" max="1" step="0.01" value="${matRoughness.toFixed(2)}" style="flex:1">
        <span class="mat-val" id="mat-roughness-val">${matRoughness.toFixed(2)}</span>
      </div>
      <div class="mat-row">
        <span class="mat-label">Metalness</span>
        <input type="range" id="mat-metalness" min="0" max="1" step="0.01" value="${matMetalness.toFixed(2)}" style="flex:1">
        <span class="mat-val" id="mat-metalness-val">${matMetalness.toFixed(2)}</span>
      </div>
      <div class="mat-row">
        <span class="mat-label">Opacity</span>
        <input type="range" id="mat-opacity" min="0" max="1" step="0.01" value="${matOpacity.toFixed(2)}" style="flex:1">
        <span class="mat-val" id="mat-opacity-val">${matOpacity.toFixed(2)}</span>
      </div>
      <div class="mat-footer">
        <button id="btn-mat-reset" class="text-btn" style="font-size:0.74rem"${hasCustom ? '' : ' disabled'}>Reset</button>
      </div>
    </div>`;

  document.getElementById('prop-bylayer-toggle')?.addEventListener('change', e => {
    obj.userData.isColorByLayer = e.target.checked;
    const label = e.target.nextElementSibling;
    if (label) label.textContent = e.target.checked ? 'On' : 'Off';
    if (e.target.checked) {
      const layerForObj = S.parsedLayers.find(l => l.index === (obj.userData.attributes?.layerIndex));
      if (layerForObj) {
        const lc = new THREE.Color(layerForObj.color.r/255, layerForObj.color.g/255, layerForObj.color.b/255);
        if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.setHex(0xffffff);
        if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.copy(lc);
        obj.userData.objectColorCustom = undefined;
        const picker = document.getElementById('prop-object-color');
        if (picker) {
          const hex = '#' + lc.getHexString();
          picker.value = hex;
          const wrapper = picker.parentNode;
          if (wrapper && wrapper.classList.contains('clr-field')) {
            wrapper.style.color = hex;
          }
        }
      }
    } else {
      const current = '#' + (obj.userData.shadedMaterial?.color?.getHexString() || 'cccccc');
      obj.userData.objectColorCustom = current;
    }
    applyDisplayMode();
  });

  document.getElementById('prop-object-color').addEventListener('input', e => {
    obj.userData.objectColorCustom = e.target.value;
    obj.userData.isColorByLayer = false;
    const toggle = document.getElementById('prop-bylayer-toggle');
    if (toggle) { toggle.checked = false; const lbl = toggle.nextElementSibling; if (lbl) lbl.textContent = 'Off'; }
    if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.set(e.target.value);
    
    // Update visual background color of parent clr-field wrapper
    const wrapper = e.target.parentNode;
    if (wrapper && wrapper.classList.contains('clr-field')) {
      wrapper.style.color = e.target.value;
    }
    
    applyDisplayMode();
  });

  document.getElementById('mat-color').addEventListener('input', e => {
    ensureCustomMaterial(obj);
    obj.userData.customMaterial.color = e.target.value;
    
    // Update visual background color of parent clr-field wrapper
    const wrapper = e.target.parentNode;
    if (wrapper && wrapper.classList.contains('clr-field')) {
      wrapper.style.color = e.target.value;
    }
    
    applyDisplayMode();
  });
  document.getElementById('mat-roughness').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    document.getElementById('mat-roughness-val').textContent = v.toFixed(2);
    ensureCustomMaterial(obj);
    obj.userData.customMaterial.roughness = v;
    applyDisplayMode();
  });
  document.getElementById('mat-metalness').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    document.getElementById('mat-metalness-val').textContent = v.toFixed(2);
    ensureCustomMaterial(obj);
    obj.userData.customMaterial.metalness = v;
    applyDisplayMode();
  });
  document.getElementById('mat-opacity').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    document.getElementById('mat-opacity-val').textContent = v.toFixed(2);
    ensureCustomMaterial(obj);
    obj.userData.customMaterial.opacity = v;
    applyDisplayMode();
  });
  document.getElementById('btn-mat-reset').addEventListener('click', () => {
    obj.userData.customMaterial = null;
    applyDisplayMode();
    updatePropertiesPanel();
  });

  // Call Coloris wrapping handler to bind touch-reliable buttons dynamically for properties panel
  if (window.Coloris) {
    Coloris.wrap('.layer-color-picker-input');
  }

  const hideBtn = document.createElement('button');
  hideBtn.id = 'btn-hide-single';
  hideBtn.className = 'text-btn';
  hideBtn.style.cssText = 'grid-column:1/-1;font-size:0.74rem;margin-top:6px';
  hideBtn.textContent = 'Hide Object';
  hideBtn.addEventListener('click', () => {
    obj.visible = false;
    S.hiddenObjects.add(obj);
    clearSelection();
    document.getElementById('object-properties').classList.add('hidden');
  });
  document.getElementById('prop-content').appendChild(hideBtn);

  panel.classList.remove('hidden');
}

// ── Custom material helper ────────────────────────────────────────────────────

export function ensureCustomMaterial(obj) {
  if (!obj.userData.customMaterial) {
    const isRendered = S.currentMode === 'rendered';
    const orig = isRendered
      ? (obj.userData.renderedMaterial || obj.userData.originalMaterial)
      : (obj.userData.shadedMaterial   || obj.userData.originalMaterial);
    obj.userData.customMaterial = {
      color:     '#' + (orig?.color?.getHexString() ?? 'ffffff'),
      roughness: orig?.roughness ?? 0.5,
      metalness: orig?.metalness ?? 0.0,
      opacity:   orig?.opacity   ?? 1.0
    };
  }
}
