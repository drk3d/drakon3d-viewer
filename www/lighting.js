import * as THREE from 'three';
import { S } from './state.js';

export function setupLights() {
  S.scene.children.slice().forEach(c => {
    if (!c.isLight) return;
    if (c === S.sunLight) return;
    if (S.sunLight && c === S.sunLight.target) return;
    S.scene.remove(c);
  });
  S.camera.children.slice().forEach(c => { if (c.isLight) S.camera.remove(c); });

  const keyPos = new THREE.Vector3(-0.8, -0.6, 1.5).normalize();

  switch (S.currentMode) {
    case 'shaded':
    case 'wireframe': {
      // Shaded: just enough light to read form, NO skylight/shadows.
      // Three directional lights from different angles give consistent surface tone
      // without strong directional shading or environment effects.
      const ambInt = parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.55);
      const keyInt = parseFloat(document.getElementById('sl-key-panel')?.value ?? 1.4);
      S.scene.add(new THREE.AmbientLight(0xffffff, ambInt * 0.9));
      const key = new THREE.DirectionalLight(0xffffff, keyInt * 0.7);
      key.position.copy(keyPos);
      S.scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, keyInt * 0.35);
      fill.position.set(0.8, 0.6, 0.5).normalize();
      S.scene.add(fill);
      const back = new THREE.DirectionalLight(0xffffff, keyInt * 0.2);
      back.position.set(0, -1, -0.5).normalize();
      S.scene.add(back);
      break;
    }
    case 'arctic': {
      // Env map (set in display.js) is the main ambient source — keep supplemental
      // lights weak so the model doesn't wash out.  A tiny ambient prevents
      // pitch-black back-faces; the key gives subtle form definition.
      S.scene.add(new THREE.AmbientLight(0xffffff, 0.08));
      const key = new THREE.DirectionalLight(0xffffff, 0.45);
      key.position.copy(keyPos);
      S.scene.add(key);
      break;
    }
    case 'rendered': {
      // Env map provides realistic ambient; sun handled separately.
      S.scene.add(new THREE.AmbientLight(0xffffff, 0.12));
      const key = new THREE.DirectionalLight(0xfff8f0, 0.65);
      key.position.copy(keyPos);
      S.scene.add(key);
      break;
    }
    case 'technical':
      S.scene.add(new THREE.AmbientLight(0xffffff, 1.25));
      break;
  }
}

export function updateSunLight() {
  const chk     = document.getElementById('chk-sun-panel');
  const enabled = chk?.checked ?? false;

  if (S.sunLight) {
    S.scene.remove(S.sunLight.target);
    S.scene.remove(S.sunLight);
  }

  if (!enabled) {
    S.sunLight = null;
    updateGroundAppearance();
    return;
  }

  if (!S.sunLight) {
    S.sunLight = new THREE.DirectionalLight(0xffffff, 1.8);
    S.sunLight.name = 'sun-light';
  }

  // Apply sun intensity from UI slider (defaults to 1.8 if missing)
  const sunInt = parseFloat(document.getElementById('sl-sun-intensity')?.value ?? 1.8);
  S.sunLight.intensity = isNaN(sunInt) ? 1.8 : sunInt;

  // Keep sun white across all modes — warm yellow in shaded/rendered made
  // the whole model look yellowed.
  S.sunLight.color.setHex(0xffffff);

  const center = S.modelShadowDims?.center || new THREE.Vector3(0, 0, 0);
  const maxDim = S.modelShadowDims?.maxDim || 100;

  const modeWantsShadows = ['shaded', 'arctic', 'rendered'].includes(S.currentMode);
  S.sunLight.castShadow = S.shadowsEnabled && modeWantsShadows;
  S.sunLight.shadow.mapSize.set(2048, 2048);
  S.sunLight.shadow.bias       = -0.0005;         // prevent shadow acne
  S.sunLight.shadow.normalBias =  maxDim * 0.001; // scale with model size
  S.sunLight.shadow.camera.near   = maxDim * 0.01;
  S.sunLight.shadow.camera.far    = maxDim * 10;
  const h = maxDim * 3;
  S.sunLight.shadow.camera.left   = -h;
  S.sunLight.shadow.camera.right  =  h;
  S.sunLight.shadow.camera.top    =  h;
  S.sunLight.shadow.camera.bottom = -h;

  const azimuthDeg   = parseFloat(document.getElementById('sl-sun-azimuth')?.value   ?? 135);
  const elevationDeg = parseFloat(document.getElementById('sl-sun-elevation')?.value  ?? 45);
  const az  = azimuthDeg   * Math.PI / 180;
  const el  = elevationDeg * Math.PI / 180;
  const dist = maxDim * 2;

  S.sunLight.position.set(
    center.x + dist * Math.cos(el) * Math.sin(az),
    center.y + dist * Math.cos(el) * Math.cos(az),
    center.z + dist * Math.sin(el)
  );
  S.sunLight.target.position.copy(center);

  S.scene.add(S.sunLight.target);
  S.scene.add(S.sunLight);

  if (S.sunLight.shadow.map) { S.sunLight.shadow.map.dispose(); S.sunLight.shadow.map = null; }
  S.sunLight.shadow.camera.updateProjectionMatrix();
  // Sync model castShadow state and ground receiveShadow together.
  updateShadowCasting();
}

export function setupModelShadowFrustum(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  S.modelShadowDims = { center, maxDim };
  updateSunLight();
}

export function updateShadowCasting() {
  const modeWantsShadows = ['shaded', 'arctic', 'rendered'].includes(S.currentMode);
  if (S.sunLight) {
    S.sunLight.castShadow = S.shadowsEnabled && modeWantsShadows;
    if (S.sunLight.shadow.map) { S.sunLight.shadow.map.dispose(); S.sunLight.shadow.map = null; }
  }
  if (!S.currentModel) return;
  S.currentModel.traverse(child => {
    if (child.isMesh) {
      child.castShadow    = S.shadowsEnabled && modeWantsShadows;
      child.receiveShadow = S.shadowsEnabled && modeWantsShadows;
    }
  });
  if (S.groundMesh) updateGroundAppearance();
}

export function updateGroundAppearance() {
  if (!S.groundMesh) return;
  const modeWantsShadows = ['shaded', 'arctic', 'rendered'].includes(S.currentMode);
  const hasShadowCaster  = S.sunLight !== null && S.shadowsEnabled && modeWantsShadows;
  const useAmbientShadow = S.sunLight === null  && S.shadowsEnabled && modeWantsShadows;
  const maxDim       = S.modelShadowDims?.maxDim ?? 100;
  const modeUsesSSAO = S.currentMode === 'arctic' || S.currentMode === 'rendered';

  S.groundMesh.material.dispose();

  if (S.currentMode === 'arctic') {
    if (hasShadowCaster) {
      // Use ShadowMaterial to overlay a clean shadow on the background,
      // avoiding the overexposure/clamping issue in Arctic mode where toneMapping is disabled.
      S.groundMesh.material = new THREE.ShadowMaterial({ opacity: 0.35, transparent: true });
      S.groundMesh.receiveShadow = true;
    } else {
      // MeshStandard picks up IBL (scene.environment) like the model objects do,
      // so the ground stays white instead of appearing dark under the weak direct lights.
      const groundMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 1.0, metalness: 0.0,
        envMapIntensity: 0.4
      });
      S.groundMesh.material = groundMat;
      S.groundMesh.receiveShadow = false;
    }
  } else if (hasShadowCaster) {
    S.groundMesh.material = new THREE.ShadowMaterial({ opacity: 0.35, transparent: true });
    S.groundMesh.receiveShadow = true;
    if (!modeUsesSSAO) S.ssaoPass.enabled = false;
  } else if (useAmbientShadow) {
    S.groundMesh.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, opacity: 0.1, transparent: true,
      roughness: 1.0, metalness: 0.0
    });
    S.groundMesh.receiveShadow = false;
    if (!modeUsesSSAO) {
      S.ssaoPass.enabled     = true;
      S.ssaoPass.kernelRadius = 16;
      S.ssaoPass.minDistance  = maxDim * 0.0005;
      S.ssaoPass.maxDistance  = maxDim * 0.05;
    }
  } else {
    S.groundMesh.material = new THREE.ShadowMaterial({ opacity: 0.35, transparent: true });
    S.groundMesh.receiveShadow = false;
    if (!modeUsesSSAO) S.ssaoPass.enabled = false;
  }
}

export function addGroundPlane(box) {
  removeGroundPlane();
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const span   = Math.max(size.x, size.y) * 5;
  const geo    = new THREE.PlaneGeometry(span, span);
  S.groundMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  S.groundMesh.position.set(center.x, center.y, box.min.z - Math.max(0.005, maxDim * 0.005));
  S.groundMesh.name = 'ground-plane';
  S.scene.add(S.groundMesh);
  updateGroundAppearance();
}

export function removeGroundPlane() {
  if (S.groundMesh) {
    S.groundMesh.geometry.dispose();
    S.groundMesh.material.dispose();
    S.scene.remove(S.groundMesh);
    S.groundMesh = null;
  }
}
