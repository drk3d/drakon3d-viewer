import * as THREE from 'three';
import { S } from './state.js';
import { t } from './i18n.js';

// ── Tool deactivation ─────────────────────────────────────────────────────────

export function deactivateAllTools() {
  if (window.deactivateClippingHelper) {
    window.deactivateClippingHelper();
  }

  if (S.distanceToolState) {
    if (S.distanceToolState.spheres) {
      S.distanceToolState.spheres.forEach(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        S.measurementGroup.remove(o);
      });
    }
    if (S.distanceToolState.tempLine)      S.measurementGroup.remove(S.distanceToolState.tempLine);
    if (S.distanceToolState.tempBillboard) S.measurementGroup.remove(S.distanceToolState.tempBillboard);
    S.distanceToolState = null;
  }
  if (S.angleToolState) {
    if (S.angleToolState.spheres) {
      S.angleToolState.spheres.forEach(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        S.measurementGroup.remove(o);
      });
    }
    if (S.angleToolState.tempLine)      S.measurementGroup.remove(S.angleToolState.tempLine);
    if (S.angleToolState.tempArc)       S.measurementGroup.remove(S.angleToolState.tempArc);
    if (S.angleToolState.tempBillboard) S.measurementGroup.remove(S.angleToolState.tempBillboard);
    S.angleToolState = null;
  }
  if (S.distanceGhostSphere) {
    if (S.distanceGhostSphere.geometry) S.distanceGhostSphere.geometry.dispose();
    if (S.distanceGhostSphere.material) S.distanceGhostSphere.material.dispose();
    S.measurementGroup.remove(S.distanceGhostSphere);
    S.distanceGhostSphere = null;
  }
  document.getElementById('canvas-container').style.cursor = '';

  if (S.angleWidget) {
    S.scene.remove(S.angleWidget.group);
    S.angleWidget.handles.forEach(h => { h.geometry.dispose(); h.material.dispose(); });
    S.angleWidget.lines.geometry.dispose();
    S.angleWidget.lines.material.dispose();
    S.angleWidget = null;
  }
  S.draggedHandle = null;
  S.controls.enabled = true;

  if (S.gumballActive) {
    S.gumballActive = false;
    document.getElementById('btn-gumball')?.classList.remove('active');
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
      S.gumballArcHandles = [];
    }
    S.gumballArcDrag = null;
    if (S.gumballHelper) {
      S.arcOverlayScene.remove(S.gumballHelper);
      S.gumballHelper = null;
    }
  }

  // Clipping plane is INTENTIONALLY left alone here — it's a toggle that
  // coexists with other tools. To turn it off, click its toolbar button again.
  document.getElementById('find-panel')?.classList.add('hidden');
  document.getElementById('btn-tool-find')?.classList.remove('active');
  document.getElementById('btn-tool-distance')?.classList.remove('active');
  document.getElementById('btn-tool-angle')?.classList.remove('active');
  syncMeasurementTabsUI();

  if (S.clippingToggleOn) {
    setupClippingHelper();
  }

  window.updateToolsDropdownActiveState?.();
}

// ── Measurements ──────────────────────────────────────────────────────────────

export function clearMeasurements() {
  while (S.measurementGroup.children.length > 0) {
    const child = S.measurementGroup.children[0];
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
    S.measurementGroup.remove(child);
  }
  S.completedMeasurements = [];
  renderMeasurementListUI();
}

export function cancelCurrentInProgressMeasurement() {
  if (S.distanceToolState) {
    if (S.distanceToolState.spheres) {
      S.distanceToolState.spheres.forEach(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        S.measurementGroup.remove(o);
      });
    }
    if (S.distanceToolState.tempLine)      S.measurementGroup.remove(S.distanceToolState.tempLine);
    if (S.distanceToolState.tempBillboard) S.measurementGroup.remove(S.distanceToolState.tempBillboard);
    S.distanceToolState.points = [];
    S.distanceToolState.spheres = [];
    S.distanceToolState.tempLine = null;
    S.distanceToolState.tempBillboard = null;
  }
  if (S.angleToolState) {
    if (S.angleToolState.spheres) {
      S.angleToolState.spheres.forEach(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        S.measurementGroup.remove(o);
      });
    }
    if (S.angleToolState.tempLine)      S.measurementGroup.remove(S.angleToolState.tempLine);
    if (S.angleToolState.tempArc)       S.measurementGroup.remove(S.angleToolState.tempArc);
    if (S.angleToolState.tempBillboard) S.measurementGroup.remove(S.angleToolState.tempBillboard);
    S.angleToolState.points = [];
    S.angleToolState.spheres = [];
    S.angleToolState.tempLine = null;
    S.angleToolState.tempArc = null;
    S.angleToolState.tempBillboard = null;
  }
  if (S.distanceGhostSphere) S.distanceGhostSphere.visible = false;
  renderMeasurementListUI();
}

export function deleteMeasurement(id) {
  const idx = S.completedMeasurements.findIndex(m => m.id === id);
  if (idx === -1) return;
  const m = S.completedMeasurements[idx];
  m.objects.forEach(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(mat => mat.dispose());
      else o.material.dispose();
    }
    S.measurementGroup.remove(o);
  });
  S.completedMeasurements.splice(idx, 1);
  renderMeasurementListUI();
}

export function syncMeasurementTabsUI() {
  const tabDist = document.getElementById('btn-measure-tab-dist');
  const tabAngle = document.getElementById('btn-measure-tab-angle');
  const btnDist = document.getElementById('btn-tool-distance');
  const btnAngle = document.getElementById('btn-tool-angle');

  if (tabDist && tabAngle && btnDist && btnAngle) {
    if (S.distanceToolState) {
      tabDist.classList.add('active');
      tabAngle.classList.remove('active');
      btnDist.classList.add('active');
      btnAngle.classList.remove('active');
    } else if (S.angleToolState) {
      tabDist.classList.remove('active');
      tabAngle.classList.add('active');
      btnDist.classList.remove('active');
      btnAngle.classList.add('active');
    } else {
      tabDist.classList.remove('active');
      tabAngle.classList.remove('active');
      btnDist.classList.remove('active');
      btnAngle.classList.remove('active');
    }
  }
}

export function renderMeasurementListUI() {
  const panel = document.getElementById('measurement-list-panel');
  if (!panel) return;
  if (!S.distanceToolState && !S.angleToolState && S.completedMeasurements.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  syncMeasurementTabsUI();

  // Update hint text dynamically based on active tool state!
  const hintEl = panel.querySelector('.measure-list-hint');
  if (hintEl) {
    const cancelBtnHTML = ` <button id="btn-cancel-measure" class="text-btn active" style="margin:0 0 0 8px; font-size:0.63rem; padding:1px 5px; background:rgba(239,68,68,0.12); color:#ef4444; border:1px solid rgba(239,68,68,0.25); border-radius:4px; cursor:pointer; font-weight:600; display:inline-flex; align-items:center;">${t('common.cancel')}</button>`;
    if (S.distanceToolState) {
      const pts = S.distanceToolState.points.length;
      if (pts === 0) hintEl.innerHTML = "<span>Click to place start point</span>";
      else if (pts === 1) hintEl.innerHTML = `<span>Click to place end point</span>${cancelBtnHTML}`;
    } else if (S.angleToolState) {
      const pts = S.angleToolState.points.length;
      if (pts === 0) hintEl.innerHTML = "<span>Click to place Angle Vertex (Center)</span>";
      else if (pts === 1) hintEl.innerHTML = `<span>Click to place Reference Point 1</span>${cancelBtnHTML}`;
      else if (pts === 2) hintEl.innerHTML = `<span>Click to place Reference Point 2</span>${cancelBtnHTML}`;
    } else {
      hintEl.innerHTML = "<span>Activate a tool to start measuring</span>";
    }

    const cancelBtn = hintEl.querySelector('#btn-cancel-measure');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelCurrentInProgressMeasurement();
      });
    }
  }

  const list = panel.querySelector('#measurement-list-items');
  if (!list) return;
  list.innerHTML = '';
  S.completedMeasurements.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'measure-row';
    const isAngle = m.type === 'angle';
    const valText = isAngle ? `${m.angle.toFixed(1)}°` : `${m.dist.toFixed(2)} mm`;
    const labelText = isAngle ? `Angle` : `Dist`;
    row.innerHTML = `
      <span class="measure-idx" style="background:${isAngle ? '#ef4444' : '#10b981'}; color:#ffffff; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:50%; font-size:0.65rem; margin-right:4px;">${i + 1}</span>
      <span class="measure-label" style="font-size:0.68rem; color:var(--text-2); margin-right:8px; font-weight:500;">${labelText}</span>
      <span class="measure-val" style="flex:1; font-weight:600;">${valText}</span>
      <button class="measure-del-btn" data-id="${m.id}" title="Delete">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.measure-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteMeasurement(Number(btn.dataset.id));
    });
  });
}

function makeMeasurementBillboard(text, position) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width = 160; canvas.height = 52;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(4, 4, 152, 44, 8);
  else ctx.rect(4, 4, 152, 44);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.fillStyle   = '#ffffff';
  ctx.font        = "bold 18px 'Inter', sans-serif";
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 80, 26);
  const texture  = new THREE.CanvasTexture(canvas);
  const mat      = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite   = new THREE.Sprite(mat);
  sprite.castShadow = false;
  sprite.receiveShadow = false;
  sprite.position.copy(position);
  const modelSize = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length()
    : 100;
  const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;
  sprite.scale.set(modelSize * 0.08 * scaleMult, modelSize * 0.026 * scaleMult, 1);
  sprite.userData = { type: 'billboard', baseScaleX: modelSize * 0.08, baseScaleY: modelSize * 0.026 };
  return sprite;
}

// ── Angle widget ──────────────────────────────────────────────────────────────

export function spawnAngleWidget() {
  if (!S.currentModel) return;
  const box    = new THREE.Box3().setFromObject(S.currentModel);
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const radius = size.length() * 0.003;

  const g   = new THREE.Group();
  g.name    = 'angle-widget-group';
  const geo = new THREE.SphereGeometry(radius, 16, 16);
  const hCenter = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false, depthWrite: false }));
  const hA      = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false, depthWrite: false }));
  const hB      = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false, depthWrite: false }));

  hCenter.position.copy(center);
  hA.position.set(center.x + size.x * 0.2, center.y, center.z);
  hB.position.set(center.x, center.y + size.y * 0.2, center.z);
  
  const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;
  hCenter.userData = { role: 'center', type: 'sphere' };
  hA.userData      = { role: 'ptA', type: 'sphere' };
  hB.userData      = { role: 'ptB', type: 'sphere' };
  hCenter.scale.setScalar(scaleMult);
  hA.scale.setScalar(scaleMult);
  hB.scale.setScalar(scaleMult);
  g.add(hCenter, hA, hB);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xff6600, linewidth: 2, depthTest: false, depthWrite: false });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    hA.position, hCenter.position, hCenter.position, hB.position
  ]);
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.castShadow = false;
  lines.receiveShadow = false;
  lines.renderOrder = 999;
  g.add(lines);

  S.scene.add(g);
  S.angleWidget = { group: g, handles: [hCenter, hA, hB], lines, center: hCenter.position, ptA: hA.position, ptB: hB.position, billboard: null };
  updateAngleWidget();
}

export function updateAngleWidget() {
  if (!S.angleWidget) return;
  S.angleWidget.lines.geometry.setFromPoints([
    S.angleWidget.ptA, S.angleWidget.center,
    S.angleWidget.center, S.angleWidget.ptB
  ]);
  const vA       = new THREE.Vector3().subVectors(S.angleWidget.ptA, S.angleWidget.center).normalize();
  const vB       = new THREE.Vector3().subVectors(S.angleWidget.ptB, S.angleWidget.center).normalize();
  const cosTheta = vA.dot(vB);
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, cosTheta))) * (180 / Math.PI);
  if (S.angleWidget.billboard) S.angleWidget.group.remove(S.angleWidget.billboard);
  const text = `${angleDeg.toFixed(1)}°`;
  const modelSize = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length()
    : 100;
  const billboardPos = S.angleWidget.center.clone().add(new THREE.Vector3(0, 0, modelSize * 0.03));
  S.angleWidget.billboard = makeMeasurementBillboard(text, billboardPos);
  S.angleWidget.group.add(S.angleWidget.billboard);
}

export function handleWidgetPointerDown(event) {
  if (!S.angleWidget) return;
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObjects(S.angleWidget.handles);
  if (intersects.length > 0) {
    S.controls.enabled = false;
    S.draggedHandle    = intersects[0].object;
  }
}

export function handleWidgetPointerMove(event) {
  if (!S.angleWidget || !S.draggedHandle) return;
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const role = S.draggedHandle.userData.role;

  if (role !== 'center' && S.currentModel) {
    const modelHits = S.raycaster.intersectObject(S.currentModel, true);
    const modelHit  = modelHits.find(i => i.object.isMesh
      && !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));
    if (modelHit) {
      let snapPt = modelHit.point.clone();
      const snapEnabled = document.getElementById('chk-measure-snap')?.checked ?? true;
      if (snapEnabled && modelHit.object.geometry?.attributes.position && modelHit.faceIndex !== undefined) {
        const geom    = modelHit.object.geometry;
        const posAttr = geom.attributes.position;
        const localPt = modelHit.object.worldToLocal(snapPt.clone());
        let minDist = Infinity;
        const checkV = (idx) => {
          const v = new THREE.Vector3(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));
          const d = v.distanceTo(localPt);
          if (d < minDist) { minDist = d; snapPt.copy(modelHit.object.localToWorld(v)); }
        };
        const fi = modelHit.faceIndex * 3;
        if (geom.index) {
          checkV(geom.index.getX(fi)); checkV(geom.index.getX(fi+1)); checkV(geom.index.getX(fi+2));
        } else {
          checkV(fi); checkV(fi+1); checkV(fi+2);
        }
        const modelSize = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length();
        if (minDist > modelSize * 0.015) snapPt.copy(modelHit.point);
      }
      S.draggedHandle.position.copy(snapPt);
      if (role === 'ptA') S.angleWidget.ptA.copy(snapPt);
      else if (role === 'ptB') S.angleWidget.ptB.copy(snapPt);
      updateAngleWidget();
      return;
    }
  }

  const camDir = new THREE.Vector3();
  S.camera.getWorldDirection(camDir);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.clone().negate(), S.angleWidget.center);
  const targetPt = new THREE.Vector3();
  if (S.raycaster.ray.intersectPlane(plane, targetPt)) {
    S.draggedHandle.position.copy(targetPt);
    if (role === 'center') {
      const disp = new THREE.Vector3().subVectors(targetPt, S.angleWidget.center);
      S.angleWidget.ptA.add(disp);
      S.angleWidget.ptB.add(disp);
      S.angleWidget.handles[1].position.copy(S.angleWidget.ptA);
      S.angleWidget.handles[2].position.copy(S.angleWidget.ptB);
    } else if (role === 'ptA') {
      S.angleWidget.ptA.copy(targetPt);
    } else if (role === 'ptB') {
      S.angleWidget.ptB.copy(targetPt);
    }
    updateAngleWidget();
  }
}

export function handleWidgetPointerUp() {
  if (S.draggedHandle) {
    S.draggedHandle    = null;
    S.controls.enabled = true;
  }
}

// ── Snapping math helper ──────────────────────────────────────────────────────

export function snapToVertex(hit) {
  let p = hit.point.clone();
  const snapEnabled = document.getElementById('chk-measure-snap')?.checked ?? true;
  if (!snapEnabled) return p;

  if (hit.object.geometry?.attributes.position && hit.faceIndex !== undefined) {
    const geom    = hit.object.geometry;
    const posAttr = geom.attributes.position;
    const localPt = hit.object.worldToLocal(p.clone());
    let minDist = Infinity, snapPt = localPt.clone();
    const checkVert = (idx) => {
      const v = new THREE.Vector3(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));
      const d = v.distanceTo(localPt);
      if (d < minDist) { minDist = d; snapPt.copy(v); }
    };
    const fi = hit.faceIndex * 3;
    if (geom.index) {
      checkVert(geom.index.getX(fi));
      checkVert(geom.index.getX(fi+1));
      checkVert(geom.index.getX(fi+2));
    } else {
      checkVert(fi); checkVert(fi+1); checkVert(fi+2);
    }
    const worldSnap = hit.object.localToWorld(snapPt.clone());
    const size = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());
    if (worldSnap.distanceTo(p) < size.length() * 0.015) p.copy(worldSnap);
  }
  return p;
}

// ── Distance tool helpers ─────────────────────────────────────────────────────

export function updateTempDistanceLine(event) {
  if (!S.distanceToolState || S.distanceToolState.points.length !== 1) return;
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObject(S.currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));
  if (hit) {
    const p1 = S.distanceToolState.points[0];
    const p2 = snapToVertex(hit);
    if (S.distanceToolState.tempLine)      S.measurementGroup.remove(S.distanceToolState.tempLine);
    if (S.distanceToolState.tempBillboard) S.measurementGroup.remove(S.distanceToolState.tempBillboard);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2, depthTest: false, depthWrite: false });
    const line    = new THREE.Line(lineGeo, lineMat);
    line.castShadow = false;
    line.receiveShadow = false;
    S.distanceToolState.tempLine = line;
    S.measurementGroup.add(line);
    const dist      = p1.distanceTo(p2);
    const billboard = makeMeasurementBillboard(`${dist.toFixed(2)} mm`, p1.clone().add(p2).multiplyScalar(0.5));
    S.distanceToolState.tempBillboard = billboard;
    S.measurementGroup.add(billboard);
  }
}

export function updateDistanceGhost(event) {
  if (!S.distanceToolState || !S.currentModel) {
    if (S.distanceGhostSphere) {
      S.measurementGroup.remove(S.distanceGhostSphere);
      S.distanceGhostSphere = null;
    }
    return;
  }
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObject(S.currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));
  if (hit) {
    const p = snapToVertex(hit);
    if (!S.distanceGhostSphere) {
      const size = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());
      const r    = size.length() * 0.003;
      const geo  = new THREE.SphereGeometry(r, 12, 12);
      const mat  = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false });
      S.distanceGhostSphere = new THREE.Mesh(geo, mat);
      S.distanceGhostSphere.castShadow = false;
      S.distanceGhostSphere.receiveShadow = false;
      S.distanceGhostSphere.name = 'distance-ghost';
      S.distanceGhostSphere.userData = { type: 'sphere' };
      const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;
      S.distanceGhostSphere.scale.setScalar(scaleMult);
      S.measurementGroup.add(S.distanceGhostSphere);
    }
    S.distanceGhostSphere.visible = true;
    S.distanceGhostSphere.position.copy(p);
  } else if (S.distanceGhostSphere) {
    S.distanceGhostSphere.visible = false;
  }
}

// ── Angle tool helpers ────────────────────────────────────────────────────────

export function updateTempAngleWidget(event) {
  if (!S.angleToolState || !S.currentModel) return;
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObject(S.currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));

  const clickIdx = S.angleToolState.points.length;
  if (clickIdx === 0) return;

  if (hit) {
    const cursorPt = snapToVertex(hit);

    if (clickIdx === 1) {
      // Hovering Reference 1 after placing Center (Vertex)
      const p1 = S.angleToolState.points[0];
      const p2 = cursorPt;

      if (S.angleToolState.tempLine) S.measurementGroup.remove(S.angleToolState.tempLine);
      if (S.angleToolState.tempArc) S.measurementGroup.remove(S.angleToolState.tempArc);
      if (S.angleToolState.tempBillboard) S.measurementGroup.remove(S.angleToolState.tempBillboard);

      const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.Line(lineGeo, lineMat);
      line.castShadow = false; line.receiveShadow = false;
      S.angleToolState.tempLine = line;
      S.measurementGroup.add(line);
    } else if (clickIdx === 2) {
      // Hovering Reference 2 after placing Center and Reference 1
      const C = S.angleToolState.points[0];
      const P1 = S.angleToolState.points[1];
      const P2 = cursorPt;

      if (S.angleToolState.tempLine) S.measurementGroup.remove(S.angleToolState.tempLine);
      if (S.angleToolState.tempArc) S.measurementGroup.remove(S.angleToolState.tempArc);
      if (S.angleToolState.tempBillboard) S.measurementGroup.remove(S.angleToolState.tempBillboard);

      const lineGeo = new THREE.BufferGeometry().setFromPoints([P1, C, C, P2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.LineSegments(lineGeo, lineMat);
      line.castShadow = false; line.receiveShadow = false;
      S.angleToolState.tempLine = line;
      S.measurementGroup.add(line);

      // Angle math & Arc line drawing
      const v1 = new THREE.Vector3().subVectors(P1, C);
      const v2 = new THREE.Vector3().subVectors(P2, C);
      const d1 = v1.length();
      const d2 = v2.length();
      if (d1 > 0.0001 && d2 > 0.0001) {
        const v1_norm = v1.clone().normalize();
        const v2_norm = v2.clone().normalize();
        const cosTheta = v1_norm.dot(v2_norm);
        const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
        const angleDeg = theta * (180 / Math.PI);

        if (theta > 0.001) {
          let normal = new THREE.Vector3().crossVectors(v1_norm, v2_norm).normalize();
          if (normal.lengthSq() < 0.0001) {
            normal.set(0, 1, 0).cross(v1_norm).normalize();
            if (normal.lengthSq() < 0.0001) normal.set(1, 0, 0).cross(v1_norm).normalize();
          }
          const xAxis = v1_norm.clone();
          const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
          const arcRadius = Math.min(d1, d2) * 0.25;
          const arcPoints = [];
          const segments = 32;
          for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * theta;
            const x = arcRadius * Math.cos(t);
            const y = arcRadius * Math.sin(t);
            const pt = C.clone().addScaledVector(xAxis, x).addScaledVector(yAxis, y);
            arcPoints.push(pt);
          }
          const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
          const arcMat = new THREE.LineBasicMaterial({ color: 0xff6600, linewidth: 2.5, depthTest: false, depthWrite: false });
          const arcLine = new THREE.Line(arcGeo, arcMat);
          arcLine.castShadow = false; arcLine.receiveShadow = false;
          S.angleToolState.tempArc = arcLine;
          S.measurementGroup.add(arcLine);

          // Billboard positioned elegantly at the bisector
          const modelSize = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length();
          const halfTheta = theta / 2;
          const offsetDist = arcRadius + modelSize * 0.02;
          const xBisect = offsetDist * Math.cos(halfTheta);
          const yBisect = offsetDist * Math.sin(halfTheta);
          const billboardPos = C.clone().addScaledVector(xAxis, xBisect).addScaledVector(yAxis, yBisect);

          const billboard = makeMeasurementBillboard(`${angleDeg.toFixed(1)}°`, billboardPos);
          S.angleToolState.tempBillboard = billboard;
          S.measurementGroup.add(billboard);
        }
      }
    }
  }
}

export function updateAngleGhost(event) {
  if (!S.angleToolState || !S.currentModel) {
    if (S.distanceGhostSphere) {
      S.measurementGroup.remove(S.distanceGhostSphere);
      S.distanceGhostSphere = null;
    }
    return;
  }
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObject(S.currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));
  if (hit) {
    const p = snapToVertex(hit);
    if (!S.distanceGhostSphere) {
      const size = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());
      const r    = size.length() * 0.003;
      const geo  = new THREE.SphereGeometry(r, 12, 12);
      const mat  = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false });
      S.distanceGhostSphere = new THREE.Mesh(geo, mat);
      S.distanceGhostSphere.castShadow = false;
      S.distanceGhostSphere.receiveShadow = false;
      S.distanceGhostSphere.name = 'distance-ghost';
      S.distanceGhostSphere.userData = { type: 'sphere' };
      const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;
      S.distanceGhostSphere.scale.setScalar(scaleMult);
      S.measurementGroup.add(S.distanceGhostSphere);
    }
    // Update color depending on click step!
    const stepColors = [0xef4444, 0x10b981, 0x3b82f6];
    const clickIdx = S.angleToolState.points.length;
    S.distanceGhostSphere.material.color.setHex(stepColors[clickIdx]);
    S.distanceGhostSphere.visible = true;
    S.distanceGhostSphere.position.copy(p);
  } else if (S.distanceGhostSphere) {
    S.distanceGhostSphere.visible = false;
  }
}

// ── Core Canvas Click router ──────────────────────────────────────────────────

export function onCanvasClick(event) {
  if (!S.distanceToolState && !S.angleToolState) return;
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObject(S.currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));
  if (!hit) return;

  const p = snapToVertex(hit);
  const size = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());

  if (S.distanceToolState) {
    // --- Distance Tool Logic ---
    const sphereGeo = new THREE.SphereGeometry(size.length() * 0.003, 16, 16);
    const sphere = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false, depthWrite: false }));
    sphere.castShadow = false; sphere.receiveShadow = false;
    sphere.position.copy(p);
    sphere.userData = { type: 'sphere' };
    const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;
    sphere.scale.setScalar(scaleMult);
    S.measurementGroup.add(sphere);
    S.distanceToolState.points.push(p);
    S.distanceToolState.spheres = S.distanceToolState.spheres || [];
    S.distanceToolState.spheres.push(sphere);

    if (S.distanceToolState.points.length === 2) {
      const p1 = S.distanceToolState.points[0];
      const p2 = S.distanceToolState.points[1];
      if (S.distanceToolState.tempLine) S.measurementGroup.remove(S.distanceToolState.tempLine);
      if (S.distanceToolState.tempBillboard) S.measurementGroup.remove(S.distanceToolState.tempBillboard);

      const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.Line(lineGeo, lineMat);
      line.castShadow = false; line.receiveShadow = false;
      S.measurementGroup.add(line);

      const dist = p1.distanceTo(p2);
      const billboard = makeMeasurementBillboard(`${dist.toFixed(2)} mm`, p1.clone().add(p2).multiplyScalar(0.5));
      S.measurementGroup.add(billboard);

      S.completedMeasurements.push({
        id: Date.now(),
        type: 'distance',
        p1: p1.clone(), p2: p2.clone(),
        dist,
        objects: [...(S.distanceToolState.spheres || []), line, billboard]
      });
      S.distanceToolState.points = [];
      S.distanceToolState.spheres = [];
      S.distanceToolState.tempLine = null;
      S.distanceToolState.tempBillboard = null;
      renderMeasurementListUI();
    }
  } else if (S.angleToolState) {
    // --- Angle Tool Logic ---
    // Colors for sequential clicking:
    // Pt 0 (Center): Red (0xef4444)
    // Pt 1 (Ref 1): Green (0x10b981)
    // Pt 2 (Ref 2): Blue (0x3b82f6)
    const stepColors = [0xef4444, 0x10b981, 0x3b82f6];
    const clickIdx = S.angleToolState.points.length;
    const sphereGeo = new THREE.SphereGeometry(size.length() * 0.003, 16, 16);
    const sphere = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: stepColors[clickIdx], depthTest: false, depthWrite: false }));
    sphere.castShadow = false; sphere.receiveShadow = false;
    sphere.position.copy(p);
    sphere.userData = { type: 'sphere' };
    const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;
    sphere.scale.setScalar(scaleMult);
    S.measurementGroup.add(sphere);

    S.angleToolState.points.push(p);
    S.angleToolState.spheres = S.angleToolState.spheres || [];
    S.angleToolState.spheres.push(sphere);
    renderMeasurementListUI(); // Trigger UI hint update!

    if (S.angleToolState.points.length === 3) {
      const C = S.angleToolState.points[0];
      const P1 = S.angleToolState.points[1];
      const P2 = S.angleToolState.points[2];

      if (S.angleToolState.tempLine) S.measurementGroup.remove(S.angleToolState.tempLine);
      if (S.angleToolState.tempArc) S.measurementGroup.remove(S.angleToolState.tempArc);
      if (S.angleToolState.tempBillboard) S.measurementGroup.remove(S.angleToolState.tempBillboard);

      // Create permanent lines
      const lineGeo = new THREE.BufferGeometry().setFromPoints([P1, C, C, P2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.LineSegments(lineGeo, lineMat);
      line.castShadow = false; line.receiveShadow = false;
      S.measurementGroup.add(line);

      // Calculate angle and arc
      const v1 = new THREE.Vector3().subVectors(P1, C);
      const v2 = new THREE.Vector3().subVectors(P2, C);
      const d1 = v1.length();
      const d2 = v2.length();
      let angleDeg = 0;
      let arcLine = null;
      let billboard = null;

      if (d1 > 0.0001 && d2 > 0.0001) {
        const v1_norm = v1.clone().normalize();
        const v2_norm = v2.clone().normalize();
        const cosTheta = v1_norm.dot(v2_norm);
        const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
        angleDeg = theta * (180 / Math.PI);

        if (theta > 0.001) {
          let normal = new THREE.Vector3().crossVectors(v1_norm, v2_norm).normalize();
          if (normal.lengthSq() < 0.0001) {
            normal.set(0, 1, 0).cross(v1_norm).normalize();
            if (normal.lengthSq() < 0.0001) normal.set(1, 0, 0).cross(v1_norm).normalize();
          }
          const xAxis = v1_norm.clone();
          const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
          const arcRadius = Math.min(d1, d2) * 0.25;
          const arcPoints = [];
          const segments = 32;
          for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * theta;
            const x = arcRadius * Math.cos(t);
            const y = arcRadius * Math.sin(t);
            const pt = C.clone().addScaledVector(xAxis, x).addScaledVector(yAxis, y);
            arcPoints.push(pt);
          }
          const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
          const arcMat = new THREE.LineBasicMaterial({ color: 0xff6600, linewidth: 2.5, depthTest: false, depthWrite: false });
          arcLine = new THREE.Line(arcGeo, arcMat);
          arcLine.castShadow = false; arcLine.receiveShadow = false;
          S.measurementGroup.add(arcLine);

          // Billboard at the bisector
          const halfTheta = theta / 2;
          const offsetDist = arcRadius + size.length() * 0.02;
          const xBisect = offsetDist * Math.cos(halfTheta);
          const yBisect = offsetDist * Math.sin(halfTheta);
          const billboardPos = C.clone().addScaledVector(xAxis, xBisect).addScaledVector(yAxis, yBisect);

          billboard = makeMeasurementBillboard(`${angleDeg.toFixed(1)}°`, billboardPos);
          S.measurementGroup.add(billboard);
        }
      }

      const mObjects = [...(S.angleToolState.spheres || []), line];
      if (arcLine) mObjects.push(arcLine);
      if (billboard) mObjects.push(billboard);

      S.completedMeasurements.push({
        id: Date.now(),
        type: 'angle',
        center: C.clone(),
        p1: P1.clone(),
        p2: P2.clone(),
        angle: angleDeg,
        objects: mObjects
      });

      S.angleToolState.points = [];
      S.angleToolState.spheres = [];
      S.angleToolState.tempLine = null;
      S.angleToolState.tempArc = null;
      S.angleToolState.tempBillboard = null;
      renderMeasurementListUI();
    }
  }
}

// ── Clipping plane ────────────────────────────────────────────────────────────

export function updateClippingPlane() {
  if (!S.currentModel) return;

  if (S.clippingPosition && S.clippingQuaternion) {
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(S.clippingQuaternion).normalize();
    if (S.clipFlipped) normal.negate();
    S.clippingPlane.normal.copy(normal);
    S.clippingPlane.constant = -normal.dot(S.clippingPosition);
    updateClippingHelperPose();
    return;
  }

  const height = parseFloat(document.getElementById('clip-height')?.value ?? 0);
  const cp     = document.getElementById('clipping-panel');
  const rotXDeg = parseFloat(cp?.dataset.rotX ?? document.getElementById('clip-rot-x')?.value ?? 0);
  const rotYDeg = parseFloat(cp?.dataset.rotY ?? document.getElementById('clip-rot-y')?.value ?? 0);
  const rotX = rotXDeg * Math.PI / 180;
  const rotY = rotYDeg * Math.PI / 180;
  const normal = new THREE.Vector3(0, 0, -1);
  normal.applyAxisAngle(new THREE.Vector3(1, 0, 0), rotX);
  normal.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  normal.normalize();
  S.clippingPlane.normal.copy(normal);
  const box      = new THREE.Box3().setFromObject(S.currentModel);
  const center   = box.getCenter(new THREE.Vector3());
  const targetPt = center.clone().addScaledVector(normal, height);
  S.clippingPlane.constant = -normal.dot(targetPt);

  // Update stored pose
  if (!S.clippingPosition) S.clippingPosition = new THREE.Vector3();
  S.clippingPosition.copy(targetPt);

  if (!S.clippingQuaternion) S.clippingQuaternion = new THREE.Quaternion();
  S.clippingQuaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

  updateClippingHelperPose();
}

export function setupClippingHelper() {
  if (S.clippingTransformControls) S.clippingTransformControls.detach();

  // Remove old arc handles from the overlay scene
  S.clippingArcHandles.forEach(h => {
    S.arcOverlayScene.remove(h.mesh);
    S.arcOverlayScene.remove(h.hitMesh);
    h.mesh.geometry.dispose();
    h.mesh.material.dispose();
    h.hitMesh.geometry.dispose();
    h.hitMesh.material.dispose();
  });
  S.clippingArcHandles = [];
  S.clippingArcDrag = null;

  if (S.clippingHelper) { S.arcOverlayScene.remove(S.clippingHelper); S.clippingHelper = null; }
  S.clippingBaseQuaternion = null;
  if (!S.clippingEnabled) return;

  const size = (S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length() * 0.65
    : 50) * 0.60;

  // Build clipping plane grid (white/light blue grid)
  const div = 5, pts = [];
  for (let i = -div; i <= div; i++) {
    const t = (i / div) * size;
    pts.push(-size, t, 0, size, t, 0);
    pts.push(t, -size, 0, t, size, 0);
  }
  const b = size;
  pts.push(-b,-b,0, b,-b,0, b,-b,0, b,b,0, b,b,0, -b,b,0, -b,b,0, -b,-b,0);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x4da6ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.65
  });
  S.clippingHelper = new THREE.LineSegments(geo, mat);
  S.clippingHelper.renderOrder = 999;

  S.arcOverlayScene.add(S.clippingHelper);

  // Arc handles are added directly to S.scene to avoid being cut by clipping planes
  buildClippingArcHandles(size);

  updateClippingHelperPose();

  if (S.clippingTransformControls) {
    S.clippingTransformControls.attach(S.clippingHelper);
    S.clippingTransformControls.getHelper().visible = true;
  }
}

// Creates quarter-circle (90°) arc handle tubes directly from parametric equations.
// Positioned in the NEGATIVE quadrant (opposite the translate arrows).
//   X arc → YZ plane, from -Y to -Z
//   Y arc → XZ plane, from -X to -Z
//   Z arc → XY plane, from -X to -Y
export function buildClippingArcHandles(size) {
  const arcRadius = 10.0;           // robust unit base radius
  const arcTube   = 0.20;           // thicker tube (2% of radius) to prevent sub-pixel thinning
  const pathSegs  = 32;            // path smoothness
  const tubeSegs  = 6;             // cross-section roundness

  // Parametric arc curve — computes points directly, no quaternion rotation needed
  class ArcCurve extends THREE.Curve {
    constructor(axis, r) { super(); this.axis = axis; this.r = r; }
    getPoint(t) {
      const a = (Math.PI / 2) * t; // 0 → π/2
      const r = this.r;
      if (this.axis === 'x') {
        // YZ plane: -Y direction at t=0, -Z direction at t=1
        return new THREE.Vector3(0,  -r * Math.cos(a), -r * Math.sin(a));
      } else if (this.axis === 'y') {
        // XZ plane: -X direction at t=0, -Z direction at t=1
        return new THREE.Vector3(-r * Math.cos(a),  0, -r * Math.sin(a));
      } else {
        // XY plane: -X direction at t=0, -Y direction at t=1
        return new THREE.Vector3(-r * Math.cos(a), -r * Math.sin(a),  0);
      }
    }
  }

  const axes = [
    { axis: 'x', color: 0xff3b30 },  // Red   — rotates clipping plane around local X
    { axis: 'y', color: 0x34c759 },  // Green — rotates clipping plane around local Y
    { axis: 'z', color: 0x007aff }   // Blue  — rotates clipping plane around local Z
  ];

  axes.forEach(cfg => {
    const curve = new ArcCurve(cfg.axis, arcRadius);

    // ── Visible tube ──────────────────────────────────────────────────────────
    const arcGeo = new THREE.TubeGeometry(curve, pathSegs, arcTube, tubeSegs, false);
    const arcMat = new THREE.MeshBasicMaterial({
      color: cfg.color,
      depthTest: false, depthWrite: false,
      transparent: true, opacity: 0.92,
      side: THREE.DoubleSide
    });
    const arcMesh = new THREE.Mesh(arcGeo, arcMat);
    arcMesh.castShadow    = false;
    arcMesh.receiveShadow = false;
    arcMesh.renderOrder   = 1000;
    arcMesh.userData.clipArcAxis = cfg.axis;

    // ── Invisible fat hit-area (same curve, larger tube) ─────────────────────
    const hitGeo = new THREE.TubeGeometry(curve, pathSegs, arcRadius * 0.12, tubeSegs, false);
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0,
      depthTest: false, depthWrite: false,
      side: THREE.DoubleSide
    });
    const hitMesh = new THREE.Mesh(hitGeo, hitMat);
    hitMesh.castShadow    = false;
    hitMesh.receiveShadow = false;
    hitMesh.renderOrder   = 1001;
    hitMesh.userData.clipArcAxis    = cfg.axis;
    hitMesh.userData.isArcHitArea   = true;

    // Add to the arc overlay scene — rendered separately with NO clipping planes
    S.arcOverlayScene.add(arcMesh);
    S.arcOverlayScene.add(hitMesh);
    S.clippingArcHandles.push({ mesh: arcMesh, hitMesh, axis: cfg.axis });
  });
}

export function updateClippingHelperPose() {
  if (!S.clippingHelper) return;

  if (S.clippingQuaternion) {
    S.clippingHelper.quaternion.copy(S.clippingQuaternion);
  } else {
    const normal = S.clippingPlane.normal.clone().normalize();
    S.clippingHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  }

  if (!S.clippingBaseQuaternion) {
    S.clippingBaseQuaternion = S.clippingHelper.quaternion.clone();
  }

  if (S.clippingPosition) {
    S.clippingHelper.position.copy(S.clippingPosition);
  } else {
    const normal = S.clippingPlane.normal.clone().normalize();
    const d = -S.clippingPlane.constant;
    S.clippingHelper.position.copy(normal.clone().multiplyScalar(d));
  }

  // Sync arc handles: they live in scene-space to avoid clipping, so copy world transform
  S.clippingHelper.updateMatrixWorld(true);
  S.clippingArcHandles.forEach(h => {
    h.mesh.position.copy(S.clippingHelper.position);
    h.mesh.quaternion.copy(S.clippingHelper.quaternion);
    h.hitMesh.position.copy(S.clippingHelper.position);
    h.hitMesh.quaternion.copy(S.clippingHelper.quaternion);
  });
}

export function reconstructMeasurements(measurements) {
  clearMeasurements();
  if (!measurements || !S.currentModel) return;
  measurements.forEach(m => {
    const isAngle = m.type === 'angle';
    const size = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());
    const r = size.length() * 0.003;
    const sphereGeo = new THREE.SphereGeometry(r, 16, 16);

    if (isAngle) {
      if (!m.center) return; // safety check
      const C = new THREE.Vector3(...m.center);
      const P1 = new THREE.Vector3(...m.p1);
      const P2 = new THREE.Vector3(...m.p2);

      const stepColors = [0xef4444, 0x10b981, 0x3b82f6];
      const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;

      const sphereC = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: stepColors[0], depthTest: false, depthWrite: false }));
      sphereC.castShadow = false; sphereC.receiveShadow = false;
      sphereC.position.copy(C);
      sphereC.userData = { type: 'sphere' };
      sphereC.scale.setScalar(scaleMult);
      S.measurementGroup.add(sphereC);

      const sphereP1 = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: stepColors[1], depthTest: false, depthWrite: false }));
      sphereP1.castShadow = false; sphereP1.receiveShadow = false;
      sphereP1.position.copy(P1);
      sphereP1.userData = { type: 'sphere' };
      sphereP1.scale.setScalar(scaleMult);
      S.measurementGroup.add(sphereP1);

      const sphereP2 = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: stepColors[2], depthTest: false, depthWrite: false }));
      sphereP2.castShadow = false; sphereP2.receiveShadow = false;
      sphereP2.position.copy(P2);
      sphereP2.userData = { type: 'sphere' };
      sphereP2.scale.setScalar(scaleMult);
      S.measurementGroup.add(sphereP2);

      const lineGeo = new THREE.BufferGeometry().setFromPoints([P1, C, C, P2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.LineSegments(lineGeo, lineMat);
      line.castShadow = false; line.receiveShadow = false;
      S.measurementGroup.add(line);

      const v1 = new THREE.Vector3().subVectors(P1, C);
      const v2 = new THREE.Vector3().subVectors(P2, C);
      const d1 = v1.length();
      const d2 = v2.length();
      let angleDeg = m.angle !== undefined ? m.angle : 0;
      let arcLine = null;
      let billboard = null;

      if (d1 > 0.0001 && d2 > 0.0001) {
        const v1_norm = v1.clone().normalize();
        const v2_norm = v2.clone().normalize();
        const cosTheta = v1_norm.dot(v2_norm);
        const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
        if (m.angle === undefined) {
          angleDeg = theta * (180 / Math.PI);
        }

        if (theta > 0.001) {
          let normal = new THREE.Vector3().crossVectors(v1_norm, v2_norm).normalize();
          if (normal.lengthSq() < 0.0001) {
            normal.set(0, 1, 0).cross(v1_norm).normalize();
            if (normal.lengthSq() < 0.0001) normal.set(1, 0, 0).cross(v1_norm).normalize();
          }
          const xAxis = v1_norm.clone();
          const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
          const arcRadius = Math.min(d1, d2) * 0.25;
          const arcPoints = [];
          const segments = 32;
          for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * theta;
            const x = arcRadius * Math.cos(t);
            const y = arcRadius * Math.sin(t);
            const pt = C.clone().addScaledVector(xAxis, x).addScaledVector(yAxis, y);
            arcPoints.push(pt);
          }
          const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
          const arcMat = new THREE.LineBasicMaterial({ color: 0xff6600, linewidth: 2.5, depthTest: false, depthWrite: false });
          arcLine = new THREE.Line(arcGeo, arcMat);
          arcLine.castShadow = false; arcLine.receiveShadow = false;
          S.measurementGroup.add(arcLine);

          const halfTheta = theta / 2;
          const offsetDist = arcRadius + size.length() * 0.02;
          const xBisect = offsetDist * Math.cos(halfTheta);
          const yBisect = offsetDist * Math.sin(halfTheta);
          const billboardPos = C.clone().addScaledVector(xAxis, xBisect).addScaledVector(yAxis, yBisect);

          billboard = makeMeasurementBillboard(`${angleDeg.toFixed(1)}°`, billboardPos);
          S.measurementGroup.add(billboard);
        }
      }

      const mObjects = [sphereC, sphereP1, sphereP2, line];
      if (arcLine) mObjects.push(arcLine);
      if (billboard) mObjects.push(billboard);

      S.completedMeasurements.push({
        id: m.id,
        type: 'angle',
        center: C,
        p1: P1,
        p2: P2,
        angle: angleDeg,
        objects: mObjects
      });

    } else {
      const p1 = new THREE.Vector3(...m.p1);
      const p2 = new THREE.Vector3(...m.p2);

      const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;

      const sphere1 = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false, depthWrite: false }));
      sphere1.castShadow = false;
      sphere1.receiveShadow = false;
      sphere1.position.copy(p1);
      sphere1.userData = { type: 'sphere' };
      sphere1.scale.setScalar(scaleMult);
      S.measurementGroup.add(sphere1);
      
      const sphere2 = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false, depthWrite: false }));
      sphere2.castShadow = false;
      sphere2.receiveShadow = false;
      sphere2.position.copy(p2);
      sphere2.userData = { type: 'sphere' };
      sphere2.scale.setScalar(scaleMult);
      S.measurementGroup.add(sphere2);

      const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2, depthTest: false, depthWrite: false });
      const line = new THREE.Line(lineGeo, lineMat);
      line.castShadow = false;
      line.receiveShadow = false;
      S.measurementGroup.add(line);

      const dist = m.dist !== undefined ? m.dist : p1.distanceTo(p2);

      const billboard = makeMeasurementBillboard(`${dist.toFixed(2)} mm`, p1.clone().add(p2).multiplyScalar(0.5));
      S.measurementGroup.add(billboard);

      S.completedMeasurements.push({
        id: m.id,
        type: 'distance',
        p1: p1,
        p2: p2,
        dist: dist,
        objects: [sphere1, sphere2, line, billboard]
      });
    }
  });
  renderMeasurementListUI();
}

export function updateMeasurementScales() {
  const scaleMult = S.measurementScale !== undefined ? S.measurementScale : 1.0;

  // 1. Scale objects in measurementGroup
  if (S.measurementGroup) {
    S.measurementGroup.traverse(obj => {
      if (obj.userData) {
        if (obj.userData.type === 'billboard') {
          obj.scale.set(obj.userData.baseScaleX * scaleMult, obj.userData.baseScaleY * scaleMult, 1);
        } else if (obj.userData.type === 'sphere') {
          obj.scale.setScalar(scaleMult);
        }
      }
    });
  }

  // 2. Scale objects in angleWidget if active
  if (S.angleWidget && S.angleWidget.group) {
    S.angleWidget.group.traverse(obj => {
      if (obj.userData) {
        if (obj.userData.type === 'billboard') {
          obj.scale.set(obj.userData.baseScaleX * scaleMult, obj.userData.baseScaleY * scaleMult, 1);
        } else if (obj.userData.type === 'sphere') {
          obj.scale.setScalar(scaleMult);
        }
      }
    });
  }
}

window.setupClippingHelper = setupClippingHelper;
