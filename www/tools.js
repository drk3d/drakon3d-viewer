import * as THREE from 'three';
import { S } from './state.js';

// ── Tool deactivation ─────────────────────────────────────────────────────────

export function deactivateAllTools() {
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

  document.getElementById('clipping-panel')?.classList.add('hidden');
  document.getElementById('btn-tool-clipping')?.classList.remove('active');
  document.getElementById('find-panel')?.classList.add('hidden');
  document.getElementById('btn-tool-find')?.classList.remove('active');
  document.getElementById('color-panel')?.classList.add('hidden');
  document.getElementById('btn-tool-colorgrade')?.classList.remove('active');
  document.getElementById('btn-tool-distance')?.classList.remove('active');
  document.getElementById('btn-tool-angle')?.classList.remove('active');
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

export function renderMeasurementListUI() {
  const panel = document.getElementById('measurement-list-panel');
  if (!panel) return;
  if (!S.distanceToolState || S.completedMeasurements.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const list = panel.querySelector('#measurement-list-items');
  if (!list) return;
  list.innerHTML = '';
  S.completedMeasurements.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'measure-row';
    row.innerHTML = `
      <span class="measure-idx">${i + 1}</span>
      <span class="measure-val">${m.dist.toFixed(2)} mm</span>
      <button class="measure-del-btn" data-id="${m.id}" title="삭제">
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
  const mat      = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite   = new THREE.Sprite(mat);
  sprite.position.copy(position);
  const modelSize = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length()
    : 100;
  sprite.scale.set(modelSize * 0.08, modelSize * 0.026, 1);
  return sprite;
}

// ── Angle widget ──────────────────────────────────────────────────────────────

export function spawnAngleWidget() {
  if (!S.currentModel) return;
  const box    = new THREE.Box3().setFromObject(S.currentModel);
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const radius = size.length() * 0.008;

  const g   = new THREE.Group();
  g.name    = 'angle-widget-group';
  const geo = new THREE.SphereGeometry(radius, 16, 16);
  const hCenter = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false }));
  const hA      = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false }));
  const hB      = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false }));

  hCenter.position.copy(center);
  hA.position.set(center.x + size.x * 0.2, center.y, center.z);
  hB.position.set(center.x, center.y + size.y * 0.2, center.z);
  hCenter.userData = { role: 'center' };
  hA.userData      = { role: 'ptA' };
  hB.userData      = { role: 'ptB' };
  g.add(hCenter, hA, hB);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2, depthTest: false });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    hA.position, hCenter.position, hCenter.position, hB.position
  ]);
  const lines = new THREE.LineSegments(lineGeo, lineMat);
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
      if (modelHit.object.geometry?.attributes.position && modelHit.faceIndex !== undefined) {
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
        if (minDist > modelSize * 0.05) snapPt.copy(modelHit.point);
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
    const p2 = hit.point;
    if (S.distanceToolState.tempLine)      S.measurementGroup.remove(S.distanceToolState.tempLine);
    if (S.distanceToolState.tempBillboard) S.measurementGroup.remove(S.distanceToolState.tempBillboard);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const lineMat = new THREE.LineDashedMaterial({ color: 0x10b981, dashSize: 0.5, gapSize: 0.25 });
    const line    = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
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
    const p = hit.point.clone();
    if (!S.distanceGhostSphere) {
      const size = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());
      const r    = size.length() * 0.007;
      const geo  = new THREE.SphereGeometry(r, 12, 12);
      const mat  = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.5 });
      S.distanceGhostSphere = new THREE.Mesh(geo, mat);
      S.distanceGhostSphere.name = 'distance-ghost';
      S.measurementGroup.add(S.distanceGhostSphere);
    }
    S.distanceGhostSphere.visible = true;
    S.distanceGhostSphere.position.copy(p);
  } else if (S.distanceGhostSphere) {
    S.distanceGhostSphere.visible = false;
  }
}

export function onCanvasClick(event) {
  if (!S.distanceToolState) return;
  S.mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
  S.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  S.raycaster.setFromCamera(S.mouse, S.camera);
  const intersects = S.raycaster.intersectObject(S.currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    !['ground-plane', 'rhino-edges', 'rhino-outline', 'selection-outline'].includes(i.object.name));
  if (!hit) return;

  let p = hit.point.clone();
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
    if (worldSnap.distanceTo(p) < size.length() * 0.05) p.copy(worldSnap);
  }

  const size     = new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3());
  const sphereGeo = new THREE.SphereGeometry(size.length() * 0.008, 16, 16);
  const sphere    = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x10b981 }));
  sphere.position.copy(p);
  S.measurementGroup.add(sphere);
  S.distanceToolState.points.push(p);
  S.distanceToolState.spheres = S.distanceToolState.spheres || [];
  S.distanceToolState.spheres.push(sphere);

  if (S.distanceToolState.points.length === 2) {
    const p1 = S.distanceToolState.points[0];
    const p2 = S.distanceToolState.points[1];
    if (S.distanceToolState.tempLine)      S.measurementGroup.remove(S.distanceToolState.tempLine);
    if (S.distanceToolState.tempBillboard) S.measurementGroup.remove(S.distanceToolState.tempBillboard);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const lineMat = new THREE.LineDashedMaterial({ color: 0x10b981, dashSize: 1, gapSize: 0.5 });
    const line    = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    S.measurementGroup.add(line);

    const dist      = p1.distanceTo(p2);
    const billboard = makeMeasurementBillboard(`${dist.toFixed(2)} mm`, p1.clone().add(p2).multiplyScalar(0.5));
    S.measurementGroup.add(billboard);

    S.completedMeasurements.push({
      id:      Date.now(),
      p1:      p1.clone(), p2: p2.clone(),
      dist,
      objects: [...(S.distanceToolState.spheres || []), line, billboard]
    });
    S.distanceToolState.points       = [];
    S.distanceToolState.spheres      = [];
    S.distanceToolState.tempLine     = null;
    S.distanceToolState.tempBillboard = null;
    renderMeasurementListUI();
  }
}

// ── Clipping plane ────────────────────────────────────────────────────────────

export function updateClippingPlane() {
  if (!S.currentModel) return;
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
  updateClippingHelperPose();
}

export function setupClippingHelper() {
  if (S.clippingTransformControls) S.clippingTransformControls.detach();
  if (S.clippingHelper) { S.scene.remove(S.clippingHelper); S.clippingHelper = null; }
  if (!S.clippingEnabled) return;

  const size = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length() * 0.65
    : 50;
  const div = 5, pts = [];
  for (let i = -div; i <= div; i++) {
    const t = (i / div) * size;
    pts.push(-size, 0, t, size, 0, t);
    pts.push(t, 0, -size, t, 0, size);
  }
  const b = size;
  pts.push(-b,0,-b, b,0,-b, b,0,-b, b,0,b, b,0,b, -b,0,b, -b,0,b, -b,0,-b);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xef4444, depthTest: false, depthWrite: false, transparent: true, opacity: 0.75
  });
  S.clippingHelper = new THREE.LineSegments(geo, mat);
  S.clippingHelper.renderOrder = 999;
  S.scene.add(S.clippingHelper);
  updateClippingHelperPose();

  if (S.clippingTransformControls) {
    S.clippingTransformControls.attach(S.clippingHelper);
    S.clippingTransformControls.getHelper().visible = true;
  }
}

export function updateClippingHelperPose() {
  if (!S.clippingHelper) return;
  const normal = S.clippingPlane.normal.clone().normalize();
  S.clippingHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  const d = -S.clippingPlane.constant;
  S.clippingHelper.position.copy(normal.clone().multiplyScalar(d));
}
