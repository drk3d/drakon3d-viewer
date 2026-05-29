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

  if (S.gumballTransformControls && S.gumballTransformControls.getHelper().visible && S.gumballTransformControls.object) {
    const tmpMouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    S.raycaster.setFromCamera(tmpMouse, S.camera);
    const gHits = S.raycaster.intersectObjects(S.gumballTransformControls.getHelper().children, true);
    
    // Filter to only count hits on the actual visible handle axes ('X', 'Y', or 'Z')
    // and NOT the large invisible helper planes that span the entire screen.
    const hasValidGizmoHit = gHits.some(hit => {
      let name = hit.object.name;
      let curr = hit.object;
      while (curr && !name) {
        curr = curr.parent;
        if (curr) name = curr.name;
      }
      return name === 'X' || name === 'Y' || name === 'Z';
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

export function updatePropertiesPanel() {
  const panel = document.getElementById('object-properties');
  if (!S.selectedObjects.length) { panel.classList.add('hidden'); return; }

  if (S.selectedObjects.length > 1) {
    document.getElementById('prop-content').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:8px 0">
        <b>${S.selectedObjects.length} objects selected</b><br><br>
        <div style="display:flex;gap:8px;justify-content:center">
          <button id="btn-clear-selection" class="text-btn">Clear Selection</button>
        </div>
      </div>`;
    document.getElementById('btn-clear-selection').addEventListener('click', () => {
      clearSelection(); updatePropertiesPanel();
    });
    panel.classList.remove('hidden');
    return;
  }

  const obj   = S.selectedObjects[0];
  const attrs = obj.userData.attributes || {};
  const layerIndex = (obj.userData.layerIndex !== undefined) ? obj.userData.layerIndex : attrs.layerIndex;
  const layer = S.parsedLayers.find(l => l.index === layerIndex);

  const objColorCustom = obj.userData.objectColorCustom;
  let objColorHex;
  const isColorByLayer = obj.userData.isColorByLayer;
  if (objColorCustom) {
    objColorHex = objColorCustom;
  } else if (isColorByLayer && layer) {
    const lc = new THREE.Color(layer.color.r/255, layer.color.g/255, layer.color.b/255);
    if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.setHex(0xffffff);
    objColorHex = '#' + lc.getHexString();
  } else if (obj.userData.annIndex !== undefined) {
    const ann = S.parsedAnnotations[obj.userData.annIndex];
    let c = new THREE.Color(0xffffff);
    if (ann.objectColor) {
      c.setRGB(ann.objectColor.r/255, ann.objectColor.g/255, ann.objectColor.b/255);
    } else if (layer?.color) {
      c.setRGB(layer.color.r/255, layer.color.g/255, layer.color.b/255);
    }
    objColorHex = '#' + c.getHexString();
  } else {
    const shadedMat = obj.userData.shadedMaterial || obj.userData.originalMaterial;
    objColorHex = '#' + (shadedMat?.color?.getHexString() ?? obj.material?.color?.getHexString() ?? 'ffffff');
  }

  const showMaterial = obj.isMesh;

  let htmlContent = `
    <div class="prop-label">Name</div><div class="prop-value">${attrs.name || (obj.userData.annIndex !== undefined ? (S.parsedAnnotations[obj.userData.annIndex].type || 'Annotation') : 'Unnamed')}</div>
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
    </div>`;

  if (showMaterial) {
    const orig = obj.userData.renderedMaterial || obj.userData.originalMaterial;
    const custom      = obj.userData.customMaterial || {};
    const matColor    = custom.color      ?? ('#' + (orig?.color?.getHexString() ?? 'ffffff'));
    const matRoughness = custom.roughness ?? (orig?.roughness ?? 0.5);
    const matMetalness = custom.metalness ?? (orig?.metalness ?? 0.0);
    const matOpacity   = custom.opacity   ?? (orig?.opacity   ?? 1.0);
    const hasCustom    = !!obj.userData.customMaterial;
    const mapTexture   = custom.hasOwnProperty('mapTexture') ? custom.mapTexture : (orig?.map ?? null);
    const hasTex       = !!mapTexture;
    const texName      = custom.mapName ?? (orig?.map?.name || (orig?.map ? 'Texture' : 'None'));

    htmlContent += `
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
        <div class="mat-row" style="align-items: center; gap: 8px;">
          <span class="mat-label">Texture</span>
          <div style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;">
            <button id="btn-mat-tex-upload" class="panel-action-btn" style="padding: 3px 8px; font-size: 0.68rem; margin: 0; background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; height: auto;">
              Upload
            </button>
            <input type="file" id="mat-tex-file-input" accept="image/*" style="display: none;">
            <span id="mat-tex-name" style="font-size: 0.65rem; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px;" title="${texName}">
              ${texName}
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

  document.getElementById('prop-content').innerHTML = htmlContent;

  document.getElementById('prop-bylayer-toggle')?.addEventListener('change', e => {
    obj.userData.isColorByLayer = e.target.checked;
    const label = e.target.nextElementSibling;
    if (label) label.textContent = e.target.checked ? 'On' : 'Off';
    
    if (obj.userData.annIndex !== undefined) {
      const ann = S.parsedAnnotations[obj.userData.annIndex];
      ann.isColorByLayer = e.target.checked;
      if (e.target.checked) {
        ann.objectColorCustom = undefined;
        obj.userData.objectColorCustom = undefined;
      } else {
        const current = objColorHex;
        ann.objectColorCustom = current;
        obj.userData.objectColorCustom = current;
      }
      import('./annotations.js').then(a => a.createAnnotationSprites());
    } else {
      if (e.target.checked) {
        const layerForObj = S.parsedLayers.find(l => l.index === layerIndex);
        if (layerForObj) {
          const lc = new THREE.Color(layerForObj.color.r/255, layerForObj.color.g/255, layerForObj.color.b/255);
          if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.setHex(0xffffff);
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
        const current = '#' + (obj.userData.shadedMaterial?.color?.getHexString() || obj.material?.color?.getHexString() || 'cccccc');
        obj.userData.objectColorCustom = current;
      }
      applyDisplayMode();
    }
  });

  document.getElementById('prop-object-color').addEventListener('input', e => {
    const val = e.target.value;
    obj.userData.objectColorCustom = val;
    obj.userData.isColorByLayer = false;
    const toggle = document.getElementById('prop-bylayer-toggle');
    if (toggle) { toggle.checked = false; const lbl = toggle.nextElementSibling; if (lbl) lbl.textContent = 'Off'; }
    
    if (obj.userData.annIndex !== undefined) {
      const ann = S.parsedAnnotations[obj.userData.annIndex];
      ann.objectColorCustom = val;
      ann.isColorByLayer = false;
      import('./annotations.js').then(a => a.createAnnotationSprites());
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
      applyDisplayMode();
    }
    
    const wrapper = e.target.parentNode;
    if (wrapper && wrapper.classList.contains('clr-field')) {
      wrapper.style.color = val;
    }
  });

  if (showMaterial) {
    const enableResetBtn = () => {
      const resetBtn = document.getElementById('btn-mat-reset');
      if (resetBtn) resetBtn.removeAttribute('disabled');
    };

    document.getElementById('mat-color').addEventListener('input', e => {
      ensureCustomMaterial(obj);
      obj.userData.customMaterial.color = e.target.value;
      
      const wrapper = e.target.parentNode;
      if (wrapper && wrapper.classList.contains('clr-field')) {
        wrapper.style.color = e.target.value;
      }
      
      enableResetBtn();
      applyDisplayMode();
    });
    document.getElementById('mat-roughness').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById('mat-roughness-val').textContent = v.toFixed(2);
      ensureCustomMaterial(obj);
      obj.userData.customMaterial.roughness = v;
      enableResetBtn();
      applyDisplayMode();
    });
    document.getElementById('mat-metalness').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById('mat-metalness-val').textContent = v.toFixed(2);
      ensureCustomMaterial(obj);
      obj.userData.customMaterial.metalness = v;
      enableResetBtn();
      applyDisplayMode();
    });
    document.getElementById('mat-opacity').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      document.getElementById('mat-opacity-val').textContent = v.toFixed(2);
      ensureCustomMaterial(obj);
      obj.userData.customMaterial.opacity = v;
      enableResetBtn();
      applyDisplayMode();
    });
    document.getElementById('btn-mat-tex-upload').addEventListener('click', () => {
      document.getElementById('mat-tex-file-input').click();
    });
    document.getElementById('mat-tex-file-input').addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      new THREE.TextureLoader().load(url, texture => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        
        ensureCustomMaterial(obj);
        obj.userData.customMaterial.mapTexture = texture;
        obj.userData.customMaterial.mapName = file.name;
        
        enableResetBtn();
        applyDisplayMode();
        updatePropertiesPanel();
      });
    });
    document.getElementById('btn-mat-tex-remove')?.addEventListener('click', () => {
      ensureCustomMaterial(obj);
      obj.userData.customMaterial.mapTexture = null;
      obj.userData.customMaterial.mapName = 'None';
      enableResetBtn();
      applyDisplayMode();
      updatePropertiesPanel();
    });
    document.getElementById('btn-mat-reset').addEventListener('click', () => {
      obj.userData.customMaterial = null;
      applyDisplayMode();
      updatePropertiesPanel();
    });
  }

  if (window.Coloris) {
    Coloris.wrap('.layer-color-picker-input');
  }

  panel.classList.remove('hidden');
}

// ── Custom material helper ────────────────────────────────────────────────────

export function ensureCustomMaterial(obj) {
  if (!obj.userData.customMaterial) {
    const orig = obj.userData.renderedMaterial || obj.userData.originalMaterial;
    obj.userData.customMaterial = {
      color:      '#' + (orig?.color?.getHexString() ?? 'ffffff'),
      roughness:  orig?.roughness ?? 0.5,
      metalness:  orig?.metalness ?? 0.0,
      opacity:    orig?.opacity   ?? 1.0,
      mapTexture: orig?.map ?? null,
      mapName:    orig?.map?.name || (orig?.map ? 'Texture' : 'None')
    };
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
