import * as THREE from 'three';
import { S } from './state.js';

export function switchToOrtho() {
  const dist   = S.perspCamera.position.distanceTo(S.controls.target);
  const h      = dist * Math.tan(S.perspCamera.fov * Math.PI / 360);
  const aspect = window.innerWidth / window.innerHeight;
  S.orthoCamera.left   = -h * aspect;
  S.orthoCamera.right  =  h * aspect;
  S.orthoCamera.top    =  h;
  S.orthoCamera.bottom = -h;
  S.orthoCamera.near   = -100000;
  S.orthoCamera.far    =  100000;
  S.orthoCamera.position.copy(S.perspCamera.position);
  S.orthoCamera.quaternion.copy(S.perspCamera.quaternion);
  S.orthoCamera.up.copy(S.perspCamera.up);
  S.orthoCamera.updateProjectionMatrix();
  S.camera = S.orthoCamera;
  S.controls.object = S.camera;
  if (S.composer?.passes[0]) S.composer.passes[0].camera = S.camera;
  if (S.composer?.passes[1]) S.composer.passes[1].camera = S.camera;
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'parallel';
  S.controls.update();
}

export function switchToPersp() {
  S.camera = S.perspCamera;
  S.controls.object = S.camera;
  if (S.composer?.passes[0]) S.composer.passes[0].camera = S.camera;
  if (S.composer?.passes[1]) S.composer.passes[1].camera = S.camera;
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'perspective';
  S.controls.update();
}

export function setViewPreset(preset) {
  const box    = S.currentModel ? new THREE.Box3().setFromObject(S.currentModel) : null;
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
  const size   = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(100, 100, 100);
  const maxDim = Math.max(size.x, size.y, size.z) || 100;
  const dist   = maxDim * 2.2;

  let targetPos = new THREE.Vector3();
  let targetUp  = new THREE.Vector3(0, 0, 1);

  if (preset === 'perspective') {
    targetPos.set(center.x + dist * 0.7, center.y - dist * 0.7, center.z + dist * 0.7);
    targetUp.set(0, 0, 1);
  } else if (preset === 'top') {
    targetPos.set(center.x, center.y, center.z + dist);
    targetUp.set(0, 1, 0);
  } else if (preset === 'front') {
    targetPos.set(center.x, center.y - dist, center.z);
    targetUp.set(0, 0, 1);
  } else if (preset === 'right') {
    targetPos.set(center.x + dist, center.y, center.z);
    targetUp.set(0, 0, 1);
  }

  triggerCameraTransition(targetPos, center, targetUp);

  document.querySelectorAll('#view-dropdown .dropdown-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === preset);
  });
}

export function triggerCameraTransition(pos, target, up) {
  const endPos    = pos    instanceof THREE.Vector3 ? pos.clone()    : new THREE.Vector3().fromArray(pos);
  const endTarget = target instanceof THREE.Vector3 ? target.clone() : new THREE.Vector3().fromArray(target);
  const endUp     = up     instanceof THREE.Vector3 ? up.clone()     : new THREE.Vector3().fromArray(up);

  S.pendingOrthoSwitch = (S.camera === S.orthoCamera);

  if (S.camera === S.orthoCamera) {
    S.perspCamera.position.copy(S.orthoCamera.position);
    S.perspCamera.quaternion.copy(S.orthoCamera.quaternion);
    S.perspCamera.up.copy(S.orthoCamera.up);
    S.camera = S.perspCamera;
    S.controls.object = S.camera;
    if (S.composer?.passes[0]) S.composer.passes[0].camera = S.camera;
    if (S.composer?.passes[1]) S.composer.passes[1].camera = S.camera;
  }

  S.cameraTransition = {
    startTime:   performance.now(),
    duration:    1200,
    startPos:    S.camera.position.clone(),
    endPos:      endPos,
    startTarget: S.controls.target.clone(),
    endTarget:   endTarget,
    startUp:     S.camera.up.clone(),
    endUp:       endUp
  };
}

export function fitCameraToBox(box, preserveView = false, animate = false) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov    = S.camera.isPerspectiveCamera ? S.camera.fov : 45;
  const dist   = Math.abs(maxDim / 2 / Math.tan(fov * Math.PI / 360)) * 1.5;

  const minNear = Math.max(0.001, dist * 0.0005);
  const maxFar  = dist * 50;
  S.perspCamera.near = minNear;
  S.perspCamera.far  = maxFar;
  S.perspCamera.updateProjectionMatrix();
  if (S.orthoCamera) {
    S.orthoCamera.near = -maxFar;
    S.orthoCamera.far  =  maxFar;
    S.orthoCamera.updateProjectionMatrix();
  }

  let targetPos;
  if (preserveView) {
    const dir = new THREE.Vector3();
    S.camera.getWorldDirection(dir);
    targetPos = center.clone().addScaledVector(dir, -dist);
  } else {
    targetPos = new THREE.Vector3(
      center.x + dist * 0.7,
      center.y - dist * 0.7,
      center.z + dist * 0.7
    );
  }

  if (animate) {
    triggerCameraTransition(targetPos.toArray(), center.toArray(), S.camera.up.toArray());
  } else {
    S.camera.position.copy(targetPos);
    if (!preserveView) S.camera.lookAt(center);
    S.controls.target.copy(center);
    S.controls.update();
  }
}

export function fitCameraToObject(obj, preserve, animate = false) {
  fitCameraToBox(new THREE.Box3().setFromObject(obj), preserve, animate);
}

export function fitCameraToSelected() {
  if (!S.selectedObjects.length) return;
  const box = new THREE.Box3();
  S.selectedObjects.forEach(o => box.expandByObject(o));
  fitCameraToBox(box, true, true);
}

// ── Custom / Named Views ──────────────────────────────────────────────────────

function _customViewKey() {
  const base = S.currentFileName ? S.currentFileName.replace(/\.[^.]+$/, '') : '__default__';
  return `rhino_custom_views_${base}`;
}

export function getCustomViews() {
  try { return JSON.parse(localStorage.getItem(_customViewKey()) || '[]'); } catch { return []; }
}

export function saveCustomView(name) {
  if (!name || !S.controls) return;
  const views = getCustomViews();
  views.push({
    name,
    position: S.camera.position.toArray(),
    target:   S.controls.target.toArray(),
    up:       S.camera.up.toArray()
  });
  localStorage.setItem(_customViewKey(), JSON.stringify(views));
  renderNamedViewsUI();
}

export function deleteCustomView(name) {
  const views = getCustomViews().filter(v => v.name !== name);
  localStorage.setItem(_customViewKey(), JSON.stringify(views));
  renderNamedViewsUI();
}

export function renderNamedViewsUI() {
  const container = document.getElementById('named-views-list');
  if (!container) return;
  container.innerHTML = '';

  const rhinoViews  = S.parsedNamedViews || [];
  const customViews = getCustomViews();
  const allViews    = [...rhinoViews, ...customViews.map(v => ({ ...v, isCustom: true }))];

  if (!allViews.length) {
    container.innerHTML = '<span class="dropdown-empty-msg" data-i18n="view.no_named">No named views</span>';
    return;
  }
  allViews.forEach(nv => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const btn = document.createElement('button');
    btn.className  = 'dropdown-item';
    btn.style.flex = '1';
    btn.innerHTML  = `<span>${nv.name}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pos = Array.isArray(nv.position) ? new THREE.Vector3(...nv.position) : nv.position;
      const tgt = Array.isArray(nv.target)   ? new THREE.Vector3(...nv.target)   : nv.target;
      const up  = Array.isArray(nv.up)       ? new THREE.Vector3(...nv.up)       : nv.up;
      triggerCameraTransition(pos, tgt, up);
      document.getElementById('view-dropdown').classList.add('hidden');
    });
    row.appendChild(btn);

    if (nv.isCustom) {
      const del = document.createElement('button');
      del.className  = 'icon-btn sm';
      del.title      = 'Delete view';
      del.style.cssText = 'padding:3px 5px;flex-shrink:0;color:var(--text-2);';
      del.innerHTML  = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><polyline points="2 4 14 4"/><path d="M6 4V3h4v1M5 4l.5 9h5l.5-9"/></svg>`;
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteCustomView(nv.name); });
      row.appendChild(del);
    }
    container.appendChild(row);
  });
}
