import * as THREE from 'three';
import { S } from './state.js';
import { updateSliderFill } from './helpers.js';

export function setupLights() {
  S.scene.children.slice().forEach(c => {
    if (!c.isLight) return;
    if (c === S.sunLight) return;
    if (S.sunLight && c === S.sunLight.target) return;
    S.scene.remove(c);
  });
  S.camera.children.slice().forEach(c => { if (c.isLight) S.camera.remove(c); });

  const keyPos = new THREE.Vector3(-0.8, -0.6, 1.5).normalize();

  // Read the user-controlled ambient slider. We honor it directly (1:1) in
  // every mode so the value the user sees + saves is the value the scene
  // actually uses — preventing a previous "darker after reload" bug where
  // the slider read 1.15 but rendered mode held a hardcoded 0.12 internally.
  // The slider's input handler also rebuilds lights via setupLights() so
  // the two paths stay consistent.
  const ambSlider = parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.4);

  switch (S.currentMode) {
    case 'shaded':
    case 'wireframe': {
      // Shaded: just enough light to read form, NO skylight/shadows.
      // Three directional lights from different angles give consistent surface tone
      // without strong directional shading or environment effects.
      const keyInt = parseFloat(document.getElementById('sl-key-panel')?.value ?? 1.4);
      S.scene.add(new THREE.AmbientLight(0xffffff, ambSlider));
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
      // Env map (set in display.js) is the main ambient source — the ambient
      // light is just a back-face fill on top of IBL.
      S.scene.add(new THREE.AmbientLight(0xffffff, ambSlider));
      const key = new THREE.DirectionalLight(0xffffff, 0.45);
      key.position.copy(keyPos);
      S.scene.add(key);
      break;
    }
    case 'rendered': {
      // Env map provides realistic ambient; sun handled separately.
      S.scene.add(new THREE.AmbientLight(0xffffff, ambSlider));
      // HemisphereLight (sky-from-above + ground-from-below) fills shaded
      // surfaces so dark sides don't hue-shift. Three.js PBR diffuse uses
      // Lambertian /π normalisation, so a single directional light produces
      // only ~32% of baseColor at the lit face — shaded sides stay much dimmer
      // and bright dielectrics (cyan #00cdff, etc.) blue-shift because G falls
      // while B stays saturated. The hemispherical fill is directional
      // (top > bottom), so it preserves shading depth instead of flattening it.
      // App is Z-up — the "sky" direction is +Z.
      const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1.4);
      hemi.position.set(0, 0, 1);
      S.scene.add(hemi);
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
  // Tight orthographic shadow frustum: model diagonal half ≈ maxDim * √3/2 (~0.87),
  // so 0.9 covers every sun angle without slack. Looser frustums (e.g. ×3) starve
  // shadow-map texel density and produce acne when long lenses zoom in.
  const h = maxDim * 0.9;
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
  setupLights();
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

export function applyFileSunSettings() {
  const chkSun       = document.getElementById('chk-sun-panel');
  const sunControls  = document.getElementById('sun-controls');
  const slAzimuth    = document.getElementById('sl-sun-azimuth');
  const slElevation  = document.getElementById('sl-sun-elevation');
  const slSunInt     = document.getElementById('sl-sun-intensity');

  if (S.fileSunEnabled !== null && S.fileSunEnabled !== undefined) {
    if (chkSun) {
      chkSun.checked = S.fileSunEnabled;
      sunControls?.classList.toggle('hidden', !S.fileSunEnabled);
    }
  } else {
    if (chkSun) {
      chkSun.checked = false;
      sunControls?.classList.add('hidden');
    }
  }

  if (S.fileSunAzimuth !== null && S.fileSunAzimuth !== undefined) {
    if (slAzimuth) {
      slAzimuth.value = Math.round(S.fileSunAzimuth);
      const valText = document.getElementById('sl-sun-azimuth-val');
      if (valText) valText.textContent = Math.round(S.fileSunAzimuth) + '°';
      updateSliderFill(slAzimuth);
    }
  }

  if (S.fileSunElevation !== null && S.fileSunElevation !== undefined) {
    if (slElevation) {
      slElevation.value = Math.round(S.fileSunElevation);
      const valText = document.getElementById('sl-sun-elevation-val');
      if (valText) valText.textContent = Math.round(S.fileSunElevation) + '°';
      updateSliderFill(slElevation);
    }
  }

  if (S.fileSunIntensity !== null && S.fileSunIntensity !== undefined) {
    if (slSunInt) {
      slSunInt.value = S.fileSunIntensity;
      const valText = document.getElementById('sl-sun-intensity-val');
      if (valText) valText.textContent = parseFloat(S.fileSunIntensity).toFixed(2);
      updateSliderFill(slSunInt);
    }
  }

  updateSunLight();

  // Ground plane settings sync
  const chkGround = document.getElementById('chk-ground-panel');
  if (S.fileGroundEnabled !== null && S.fileGroundEnabled !== undefined) {
    S.groundEnabled = S.fileGroundEnabled;
    if (chkGround) {
      chkGround.checked = S.fileGroundEnabled;
      const chkGroundLinked = document.getElementById('chk-ground');
      if (chkGroundLinked) chkGroundLinked.checked = S.fileGroundEnabled;
    }
    if (S.modeSettings && S.modeSettings[S.currentMode]) {
      S.modeSettings[S.currentMode]['ground'] = S.fileGroundEnabled;
    }
    
    if (S.currentModel) {
      if (S.groundEnabled) {
        const box = new THREE.Box3().setFromObject(S.currentModel);
        addGroundPlane(box);
      } else {
        removeGroundPlane();
      }
    }
  }

  // Ambient + Environment intensity sync — both mirror Rhino's Skylight intensity.
  // loaders.js falls back to 1.0 on read failure, so we can rely on the values being set.
  applySliderValue('sl-ambient-panel',   'sl-ambient-val',       S.fileAmbientIntensity);
  applySliderValue('sl-env-intensity',   'sl-env-intensity-val', S.fileSkylightIntensity);

  if (S.scene && S.fileSkylightIntensity !== null && S.fileSkylightIntensity !== undefined) {
    const envVal = S.fileSkylightIntensity;
    S.scene.environmentIntensity = envVal;
    const bgType = document.getElementById('bg-type-select')?.value || 'solid';
    S.scene.backgroundIntensity = (bgType === 'hdr') ? envVal : 1.0;
  }

  // Refresh scene lights to apply new ambient values
  setupLights();
}

function applySliderValue(sliderId, valTextId, value) {
  if (value === null || value === undefined) return;
  const sl = document.getElementById(sliderId);
  if (!sl) return;
  sl.value = value;
  const valText = document.getElementById(valTextId);
  if (valText) valText.textContent = parseFloat(value).toFixed(2);
  updateSliderFill(sl);
}
