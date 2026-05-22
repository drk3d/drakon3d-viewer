import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { initI18n, setLang, applyI18n, t, currentLang } from './i18n.js';

// ── Color Grading Shader ───────────────────────────────────────────────────
const ColorGradingShader = {
  uniforms: {
    tDiffuse:     { value: null },
    uExposure:    { value: 0.0 },
    uContrast:    { value: 0.0 },
    uSaturation:  { value: 0.0 },
    uTemperature: { value: 0.0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      // Exposure (EV: +1 = ×2 brightness)
      c *= pow(2.0, uExposure);
      // Contrast  (pivot at 0.5)
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;
      // Saturation
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(lum), c, 1.0 + uSaturation);
      // Temperature  (warm +R−B / cool −R+B)
      c.r += uTemperature * 0.15;
      c.g += uTemperature * 0.03;
      c.b -= uTemperature * 0.15;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }
  `
};

let bvhReady = false;
import('three-mesh-bvh').then(mod => {
  THREE.Mesh.prototype.raycast = mod.acceleratedRaycast;
  THREE.BufferGeometry.prototype.computeBoundsTree = mod.computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = mod.disposeBoundsTree;
  bvhReady = true;
}).catch(() => console.warn('three-mesh-bvh not loaded'));

window.addEventListener('error', e => console.error('Uncaught:', e.message, e.filename, e.lineno));

// ── State ──────────────────────────────────────────────────────────────────
let scene, camera, renderer, controls;
let perspCamera, orthoCamera;
let currentModel = null;
let currentMode = 'shaded';
let environmentMap = null;
const envMaps = {};
let currentEnvPreset = 'studio';   // 'studio' | 'neutral' | 'sky' | 'sunset' | 'night' | 'hdr-custom'
let envAsBackground = false;       // show HDR/env as scene background too
let parsedLayers = [];
let layerNodeByIndex = {};   // populated by renderLayerUI; used for cascade visibility
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let rhinoInstance = null;
let rhinoBackgroundColor = null;
let fileDefaultBgStyle = null;    // 'solid' | 'gradient' | 'environment' from 3DM renderSettings
let customBackgroundColor = null;
let composer, ssaoPass, cgPass;
let selectedObjects = [];
let selectMode = 'single';   // 'none' | 'single' | 'multi'
let settingsOpen = false;
let turntableActive = false;
let turntableSpeed = 1.0;
let turntableDir   = 1;       // 1 = CW, -1 = CCW
let sunLight    = null;          // Single directional light: visual sun + shadow caster
let modelShadowDims = null;      // { center: Vector3, maxDim: number } — set on model load
let groundMesh = null;
let shadowsEnabled = false;
let groundEnabled = false;
let hiddenObjects = new Set();
let currentFileName = '';
const isLightMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
let bgGradient = false;
let bgColorTop = isLightMode ? '#f2f2f5' : '#2a2b2f';
let bgColorBot = isLightMode ? '#dcdce2' : '#18181c';
let bgTexture = null;
let parsedAnnotations = [];
let annotationGroup = null;
let parsed3dmFileInfo = null;  // stores 3DM file metadata: author, date, notes

let parsedNamedViews = [];
let cameraTransition = null;
let pendingOrthoSwitch = false;   // restore ortho after view-preset transition
let distanceToolState = null;
let distanceGhostSphere = null;
let completedMeasurements = [];   // { id, p1, p2, dist, objects:[] }
let measurementGroup = new THREE.Group();
let angleWidget = null;
let draggedHandle = null;
let clippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
let clippingHelper = null;
let clippingTransformControls = null;
let clippingEnabled = false;

// ── Theme State (must be before initThemeSync call) ────────────────────────
const THEME_KEY = 'byrhinoview_theme';
let currentTheme = localStorage.getItem(THEME_KEY) || 'system';

// ── DOM refs ───────────────────────────────────────────────────────────────
const loadingEl       = document.getElementById('loading');
const loadingTextEl   = document.getElementById('loading-text');
const progressBarEl   = document.getElementById('progress-bar');
const modelInfoEl     = document.getElementById('file-info-content') || document.getElementById('model-info');
const fileNameEl      = document.getElementById('file-name-text');
const emptyStateEl    = document.getElementById('empty-state');
const settingsPanelEl = document.getElementById('settings-panel');

// ── rhino3dm init ──────────────────────────────────────────────────────────
if (window.rhino3dm) {
  window.rhino3dm().then(rhino => { rhinoInstance = rhino; });
}

const rhinoLoader = new Rhino3dmLoader();
rhinoLoader.setLibraryPath('https://cdn.jsdelivr.net/npm/rhino3dm@8.0.1/');

const gltfLoader = new GLTFLoader();

// ── Bootstrap ─────────────────────────────────────────────────────────────
loadingEl.classList.remove('hidden');
initThemeSync();
init();
animate();

// ── Loading helpers ────────────────────────────────────────────────────────
function setProgress(pct) { progressBarEl.style.width = pct + '%'; }

function showLoading(text = 'Loading…') {
  loadingTextEl.textContent = text;
  setProgress(0);
  loadingEl.classList.remove('hidden');
}

function hideLoading() {
  setProgress(100);
  loadingEl.classList.add('hidden');
}

function setFileName(name) {
  fileNameEl.textContent = name;
  fileNameEl.classList.toggle('loaded', !!name && name !== 'Open a 3DM file…');
  // Auto-close the left panel when a model is successfully loaded
  if (name && name !== 'Open a 3DM file…') {
    document.getElementById('left-panel')?.classList.add('hidden');
  }
  currentFileName = (name && name !== 'Open a 3DM file…') ? name.replace(/\.[^.]+$/, '') : '';
}

function showModelInfo(model, fileSize) {
  let triangles = 0, meshCount = 0;
  model.traverse(child => {
    if (child.isMesh && child.geometry) {
      meshCount++;
      const g = child.geometry;
      triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  const triStr = triangles >= 1e6
    ? (triangles / 1e6).toFixed(1) + 'M tri'
    : triangles >= 1e3
      ? Math.round(triangles / 1e3) + 'K tri'
      : triangles + ' tri';
  const szStr = fileSize >= 1048576
    ? (fileSize / 1048576).toFixed(1) + ' MB'
    : Math.round(fileSize / 1024) + ' KB';
  if (modelInfoEl) {
    // If we have 3DM file metadata, show it richly
    if (parsed3dmFileInfo) {
      const fi = parsed3dmFileInfo;
      let lines = [];
      if (fi.applicationName) lines.push(`App: ${fi.applicationName}`);
      if (fi.createdBy)       lines.push(`Author: ${fi.createdBy}`);
      if (fi.created)         lines.push(`Created: ${fi.created}`);
      if (fi.lastEditedBy)    lines.push(`Edited by: ${fi.lastEditedBy}`);
      if (fi.lastEdited)      lines.push(`Modified: ${fi.lastEdited}`);
      if (fi.notes && fi.notes.trim()) lines.push(`Notes: ${fi.notes.trim()}`);
      lines.push(`${meshCount} meshes · ${triStr} · ${szStr}`);
      modelInfoEl.innerHTML = lines.map(l => `<div class="file-info-row">${l}</div>`).join('');
    } else {
      modelInfoEl.textContent = `${meshCount} meshes · ${triStr} · ${szStr}`;
    }
    modelInfoEl.classList.remove('hidden');
  }
}

// ── Slider fill-track helper ───────────────────────────────────────────────
/**
 * Sets the CSS --fill custom property so the filled-track gradient reflects
 * the current slider value.  Call on init and on every 'input' event.
 */
function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const val = parseFloat(el.value) || 0;
  const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
  el.style.setProperty('--fill', `${pct}%`);
}

/** Refresh fill on every range input in the document. */
function updateAllSliderFills() {
  document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
}

// ── init ───────────────────────────────────────────────────────────────────
function init() {
  const container = document.getElementById('canvas-container');

  scene = new THREE.Scene();
  scene.background = null; // empty state에서는 투명하게 하여 CSS --bg 배경색이 드러나게 함

  perspCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10000);
  perspCamera.up.set(0, 0, 1);
  perspCamera.position.set(100, -100, 100);
  scene.add(perspCamera);

  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
  orthoCamera.up.set(0, 0, 1);
  scene.add(orthoCamera);

  camera = perspCamera;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
  ssaoPass.kernelRadius = 16;
  ssaoPass.minDistance = 0.005;
  ssaoPass.maxDistance = 0.1;
  ssaoPass.enabled = false;
  composer.addPass(ssaoPass);

  cgPass = new ShaderPass(ColorGradingShader);
  composer.addPass(cgPass);
  composer.addPass(new OutputPass());

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.5;
  controls.autoRotateSpeed = 1.0;

  renderer.localClippingEnabled = true;
  scene.add(measurementGroup);

  // Set Line Raycast Threshold
  raycaster.params.Line.threshold = 0.5;

  // Initialize Clipping Gumball (TransformControls)
  clippingTransformControls = new TransformControls(camera, renderer.domElement);
  clippingTransformControls.setSpace('local');
  clippingTransformControls.showX = true;
  clippingTransformControls.showY = true;
  clippingTransformControls.showZ = true;
  scene.add(clippingTransformControls);

  clippingTransformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
  });

  clippingTransformControls.addEventListener('change', () => {
    if (clippingHelper && currentModel && clippingTransformControls.object) {
      const normal = clippingPlane.normal.clone().normalize();
      clippingPlane.constant = -normal.dot(clippingHelper.position);
    }
  });

  setupLights();

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  // Studio: RoomEnvironment base + supplemented by directional lighting in setupLights
  const roomEnv = new RoomEnvironment();
  envMaps.studio = pmrem.fromScene(roomEnv).texture;
  roomEnv.dispose();

  // Gradient-based environments (improved contrast)
  envMaps.neutral = makeGradientEnv(pmrem, '#d8dde4', '#eef0f2', '#b0b8c4');
  envMaps.sky     = makeGradientEnv(pmrem, '#1e4a8a', '#6ab0e8', '#c4a870', '#3a2a10');
  envMaps.sunset  = makeGradientEnv(pmrem, '#0e0820', '#b83a10', '#f06020', '#e09030', '#0e0820');
  envMaps.night   = makeGradientEnv(pmrem, '#030610', '#071228', '#0a1a3a', '#030610');

  environmentMap = envMaps.studio;
  scene.environment = environmentMap;  // HDR Studio on by default
  pmrem.dispose();

  // Default background: Solid, colour pickers visible
  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) {
    bgSel.value = 'solid';
    document.getElementById('picker-c1')?.classList.remove('hidden');
    document.getElementById('picker-c2')?.classList.add('hidden');      // hidden for solid (1-colour)
    document.getElementById('bg-radial-section')?.classList.add('hidden');
    document.querySelector('.env-preset-btn[data-preset="studio"]')?.classList.add('active');
  }

  // Initialise i18n (restores saved language preference, auto-detects from browser)
  initI18n();
  applyI18n();

  bindUI();
  updateAllSliderFills();
  window.addEventListener('resize', onWindowResize);
  hideLoading();
}

// ── Background helper ──────────────────────────────────────────────────────
function applySceneBackground() {
  if (currentMode === 'technical') { scene.background = new THREE.Color(0xffffff); return; }

  const bgType = document.getElementById('bg-type-select')?.value || 'solid';
  const c1 = document.getElementById('bg-panel-c1')?.value || '#2a2b2f';
  const c2 = document.getElementById('bg-panel-c2')?.value || '#18181c';

  if (bgTexture) { bgTexture.dispose(); bgTexture = null; }

  if (bgType === 'solid') {
    scene.background = new THREE.Color(c1);

  } else if (bgType === 'gradient2') {
    // Linear top→bottom gradient
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    bgTexture = new THREE.CanvasTexture(canvas);
    bgTexture.mapping = THREE.UVMapping;
    scene.background = bgTexture;

  } else if (bgType === 'radial') {
    // Radial gradient: inner color → outer color, spread controlled by slider
    const spread = parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5);
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.72;
    const innerR = outerR * (1.0 - spread);
    const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    grad.addColorStop(0, c1);   // inner colour
    grad.addColorStop(1, c2);   // outer colour
    ctx.fillStyle = c2;         // fill entire canvas with outer first
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    bgTexture = new THREE.CanvasTexture(canvas);
    bgTexture.minFilter = THREE.LinearFilter;
    bgTexture.magFilter = THREE.LinearFilter;
    scene.background = bgTexture;

  } else if (bgType === 'gradient4') {
    const c3 = document.getElementById('bg-panel-c3')?.value || '#2d3748';
    const c4 = document.getElementById('bg-panel-c4')?.value || '#1a202c';
    
    // Parse hex to RGB
    const hexToRgb = (hex) => {
      const num = parseInt(hex.slice(1), 16);
      return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255
      };
    };
    
    const rgb1 = hexToRgb(c1);
    const rgb2 = hexToRgb(c2);
    const rgb3 = hexToRgb(c3);
    const rgb4 = hexToRgb(c4);
    
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;
    
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1);
      const invV = 1.0 - v;
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1);
        const invU = 1.0 - u;
        
        // Bilinear interpolation weights
        const w1 = invU * invV;
        const w2 = u * invV;
        const w3 = invU * v;
        const w4 = u * v;
        
        const r = Math.round(rgb1.r * w1 + rgb2.r * w2 + rgb3.r * w3 + rgb4.r * w4);
        const g = Math.round(rgb1.g * w1 + rgb2.g * w2 + rgb3.g * w3 + rgb4.g * w4);
        const b = Math.round(rgb1.b * w1 + rgb2.b * w2 + rgb3.b * w3 + rgb4.b * w4);
        
        const idx = (y * size + x) * 4;
        data[idx]     = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    bgTexture = new THREE.CanvasTexture(canvas);
    bgTexture.minFilter = THREE.LinearFilter;
    bgTexture.magFilter = THREE.LinearFilter;
    scene.background = bgTexture;
  }
}

// ── Apply background from loaded file's renderSettings ────────────────────
// Called after a 3DM file finishes loading; sets the bg-type-select dropdown
// and colour pickers to match the file's own render background settings.
function applyFileBackground() {
  const bgSel   = document.getElementById('bg-type-select');
  const c1Input  = document.getElementById('bg-panel-c1');
  const c1Swatch = document.getElementById('bg-panel-swatch-c1');
  if (!bgSel) return;

  // Map Rhino backgroundStyle enum → our dropdown value
  // Rhino values: 0/SolidColor → solid, 1/Gradient → gradient2, 2/Environment → solid fallback
  let newType = 'solid';
  if (fileDefaultBgStyle !== null && fileDefaultBgStyle !== undefined) {
    const s = String(fileDefaultBgStyle).toLowerCase();
    if (s === '1' || s.includes('gradient')) newType = 'gradient2';
    // Environment (2) / Wallpaper (3) → leave as solid; IBL is always on anyway
  }
  bgSel.value = newType;

  // Fill colour pickers with the file's background colour
  if (rhinoBackgroundColor && c1Input) {
    const hex = '#' + rhinoBackgroundColor.getHexString();
    c1Input.value = hex;
    if (c1Swatch) c1Swatch.style.background = hex;
  }

  // Sync picker visibility
  const isSolid  = newType === 'solid';
  const isRadial = newType === 'radial';
  const isGrad4  = newType === 'gradient4';
  document.getElementById('picker-c1')?.classList.remove('hidden');
  document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid);
  document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('bg-radial-section')?.classList.toggle('hidden', !isRadial);
}

// ── Projection helpers (module-level so setViewPreset can call them) ───────
function switchToOrtho() {
  const dist   = perspCamera.position.distanceTo(controls.target);
  const h      = dist * Math.tan(perspCamera.fov * Math.PI / 360);
  const aspect = window.innerWidth / window.innerHeight;
  orthoCamera.left   = -h * aspect;
  orthoCamera.right  =  h * aspect;
  orthoCamera.top    =  h;
  orthoCamera.bottom = -h;
  orthoCamera.near   = -100000;
  orthoCamera.far    =  100000;
  orthoCamera.position.copy(perspCamera.position);
  orthoCamera.quaternion.copy(perspCamera.quaternion);
  orthoCamera.up.copy(perspCamera.up);
  orthoCamera.updateProjectionMatrix();
  camera = orthoCamera;
  controls.object = camera;
  if (composer?.passes[0]) composer.passes[0].camera = camera;
  if (composer?.passes[1]) composer.passes[1].camera = camera;
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'parallel';
  controls.update();
}

function switchToPersp() {
  camera = perspCamera;
  controls.object = camera;
  if (composer?.passes[0]) composer.passes[0].camera = camera;
  if (composer?.passes[1]) composer.passes[1].camera = camera;
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'perspective';
  controls.update();
}

// ── View presets ───────────────────────────────────────────────────────────
function setViewPreset(preset) {
  const box = currentModel ? new THREE.Box3().setFromObject(currentModel) : null;
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
  const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(100, 100, 100);
  const maxDim = Math.max(size.x, size.y, size.z) || 100;
  const dist = maxDim * 2.2;
  
  let targetPos = new THREE.Vector3();
  let targetUp = new THREE.Vector3(0, 0, 1);
  
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

function triggerCameraTransition(pos, target, up) {
  const endPos = pos instanceof THREE.Vector3 ? pos.clone() : new THREE.Vector3().fromArray(pos);
  const endTarget = target instanceof THREE.Vector3 ? target.clone() : new THREE.Vector3().fromArray(target);
  const endUp = up instanceof THREE.Vector3 ? up.clone() : new THREE.Vector3().fromArray(up);
  
  // Remember ortho state — we'll restore it after the transition
  pendingOrthoSwitch = (camera === orthoCamera);

  // Always animate with perspCamera (smoother, then re-derive ortho frustum at end)
  if (camera === orthoCamera) {
    perspCamera.position.copy(orthoCamera.position);
    perspCamera.quaternion.copy(orthoCamera.quaternion);
    perspCamera.up.copy(orthoCamera.up);
    camera = perspCamera;
    controls.object = camera;
    if (composer?.passes[0]) composer.passes[0].camera = camera;
    if (composer?.passes[1]) composer.passes[1].camera = camera;
  }

  cameraTransition = {
    startTime: performance.now(),
    duration: 1200, 
    startPos: camera.position.clone(),
    endPos: endPos,
    startTarget: controls.target.clone(),
    endTarget: endTarget,
    startUp: camera.up.clone(),
    endUp: endUp
  };
}

// ── File handle persistence (folder memory) ────────────────────────────────
async function openPrefsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rhinoview-prefs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveLastFileHandle(handle) {
  try { const db = await openPrefsDB(); db.transaction('handles','readwrite').objectStore('handles').put(handle,'lastFile'); } catch{}
}
async function loadLastFileHandle() {
  try {
    const db = await openPrefsDB();
    return await new Promise(r => { const req = db.transaction('handles','readonly').objectStore('handles').get('lastFile'); req.onsuccess = () => r(req.result ?? null); req.onerror = () => r(null); });
  } catch { return null; }
}

// ── Session save/load ──────────────────────────────────────────────────────
function getObjectKey(obj) {
  const a = obj.userData.attributes || {};
  return (a.name || 'obj') + '_L' + (a.layerIndex ?? 0);
}

function saveSession() {
  const settings = {
    displayMode: currentMode,
    shadowsEnabled: shadowsEnabled,
    groundEnabled: groundEnabled,
    edgeOverlay: document.getElementById('chk-edges-panel')?.checked ?? true,
    annotationsEnabled: document.getElementById('chk-annotations-panel')?.checked ?? true,
    sunLightEnabled: document.getElementById('chk-sun-panel')?.checked ?? false,
    sunAzimuth: parseFloat(document.getElementById('sl-sun-azimuth')?.value ?? 135),
    sunElevation: parseFloat(document.getElementById('sl-sun-elevation')?.value ?? 45),
    ambientIntensity: parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.35),
    cameraFov: parseFloat(document.getElementById('sl-camera-fov')?.value ?? 45),
    dampingFactor: parseFloat(document.getElementById('sl-damping-panel')?.value ?? 0.5),
    bgType: document.getElementById('bg-type-select')?.value || 'solid',
    bgC1: document.getElementById('bg-panel-c1')?.value || '#2a2b2f',
    bgC2: document.getElementById('bg-panel-c2')?.value || '#18181c',
    bgC3: document.getElementById('bg-panel-c3')?.value || '#2d3748',
    bgC4: document.getElementById('bg-panel-c4')?.value || '#1a202c',
    bgRadialSpread: parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5),
    colorGrading: {
      exposure: parseFloat(document.getElementById('cg-exposure')?.value ?? 0),
      contrast: parseFloat(document.getElementById('cg-contrast')?.value ?? 0),
      saturation: parseFloat(document.getElementById('cg-saturation')?.value ?? 0),
      temperature: parseFloat(document.getElementById('cg-temperature')?.value ?? 0)
    }
  };

  const data = {
    version: 2,
    displayMode: currentMode,
    settings: settings,
    customMaterials: {},
    hiddenKeys: []
  };

  if (currentModel) {
    currentModel.traverse(child => {
      if (!child.isMesh || !child.userData.originalMaterial) return;
      if (child.name === 'rhino-outline' || child.name === 'rhino-edges' || child.name === 'selection-outline') return;
      const key = getObjectKey(child);
      if (child.userData.customMaterial) data.customMaterials[key] = { ...child.userData.customMaterial };
      if (!child.visible) data.hiddenKeys.push(key);
    });
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (currentFileName || 'scene') + '.rhinoview';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadSession(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    
    // First, reset all settings to defaults so that any old state is cleared out before applying the session!
    resetSettingsToDefault();

    if (data.settings) {
      const s = data.settings;
      
      currentMode = s.displayMode || 'shaded';
      shadowsEnabled = s.shadowsEnabled ?? false;
      groundEnabled = s.groundEnabled ?? false;
      
      const setCheck = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
          el.checked = val;
          el.dispatchEvent(new Event('change'));
        }
      };
      
      setCheck('chk-edges-panel', s.edgeOverlay ?? true);
      setCheck('chk-annotations-panel', s.annotationsEnabled ?? true);
      setCheck('chk-ground-panel', groundEnabled);
      setCheck('chk-shadows-panel', shadowsEnabled);
      setCheck('chk-sun-panel', s.sunLightEnabled ?? false);
      
      const setSlider = (id, valElId, val, formatType = 'float') => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          updateSliderFill(el);
          const valEl = document.getElementById(valElId);
          if (valEl) {
            if (formatType === 'percent') {
              valEl.textContent = Math.round(val * 100) + '%';
            } else if (formatType === 'degree') {
              valEl.textContent = Math.round(val) + '°';
            } else {
              valEl.textContent = parseFloat(val).toFixed(2);
            }
          }
          el.dispatchEvent(new Event('input')); 
        }
      };
      
      setSlider('sl-ambient-panel', 'sl-ambient-val', s.ambientIntensity, 'float');
      setSlider('sl-sun-azimuth', 'sl-sun-azimuth-val', s.sunAzimuth, 'degree');
      setSlider('sl-sun-elevation', 'sl-sun-elevation-val', s.sunElevation, 'degree');
      setSlider('sl-camera-fov', 'sl-camera-fov-val', s.cameraFov, 'degree');
      setSlider('sl-damping-panel', 'sl-damping-val', s.dampingFactor, 'float');
      
      const bgSel = document.getElementById('bg-type-select');
      if (bgSel && s.bgType) {
        bgSel.value = s.bgType;
      }
      
      const setBgColor = (id, swatchId, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          const swatch = document.getElementById(swatchId);
          if (swatch) swatch.style.background = val;
          el.dispatchEvent(new Event('input'));
        }
      };
      
      setBgColor('bg-panel-c1', 'bg-panel-swatch-c1', s.bgC1);
      setBgColor('bg-panel-c2', 'bg-panel-swatch-c2', s.bgC2);
      setBgColor('bg-panel-c3', 'bg-panel-swatch-c3', s.bgC3);
      setBgColor('bg-panel-c4', 'bg-panel-swatch-c4', s.bgC4);
      
      setSlider('bg-radial-spread', 'bg-radial-spread-val', s.bgRadialSpread, 'percent');
      
      // Explicitly trigger a change event on background type select to update panel pickers visibility
      if (bgSel) bgSel.dispatchEvent(new Event('change'));
      
      // Color grading restoration
      if (s.colorGrading) {
        const cg = s.colorGrading;
        const setCgSlider = (id, val) => {
          const el = document.getElementById(id);
          if (el && val !== undefined) {
            el.value = val;
            updateSliderFill(el);
            const valEl = document.getElementById(id + '-val');
            if (valEl) valEl.textContent = (val >= 0 ? '+' : '') + parseFloat(val).toFixed(2);
            el.dispatchEvent(new Event('input'));
          }
        };
        setCgSlider('cg-exposure', cg.exposure);
        setCgSlider('cg-contrast', cg.contrast);
        setCgSlider('cg-saturation', cg.saturation);
        setCgSlider('cg-temperature', cg.temperature);
      }
    } else {
      // Fallback compatibility with version 1 session files
      if (data.displayMode) {
        currentMode = data.displayMode;
      }
    }
    
    document.querySelectorAll('#mode-dropdown .dropdown-item').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === currentMode);
    });

    if (!currentModel) return;
    
    currentModel.traverse(child => {
      if (!child.isMesh || !child.userData.originalMaterial) return;
      if (child.name === 'rhino-outline' || child.name === 'rhino-edges' || child.name === 'selection-outline') return;
      const key = getObjectKey(child);
      
      if (data.hiddenKeys && data.hiddenKeys.includes(key)) {
        child.visible = false;
        hiddenObjects.add(child);
      } else {
        child.visible = true;
      }
      
      if (data.customMaterials && data.customMaterials[key]) {
        child.userData.customMaterial = { ...data.customMaterials[key] };
      } else {
        delete child.userData.customMaterial;
      }
    });
    
    applyDisplayMode();
  } catch (e) {
    console.error('Session load failed', e);
    alert('Failed to load session file.');
  }
}

let pointerDownTime = 0;
let pointerDownPos = new THREE.Vector2();

// ── UI bindings ────────────────────────────────────────────────────────────
function bindUI() {
  // Dynamically create file inputs to guarantee existence
  let fileInput = document.getElementById('file-upload');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'file-upload';
    fileInput.style.display = 'none';
    fileInput.accept = '.3dm,.glb,.gltf,.stp,.step,.iges,.igs,.stl,.3mf';
    document.body.appendChild(fileInput);
  }
  fileInput.addEventListener('change', e => {
    const f = e.target.files[0]; if (f) handleFile(f);
  });

  let sessionInput = document.getElementById('session-upload');
  if (!sessionInput) {
    sessionInput = document.createElement('input');
    sessionInput.type = 'file';
    sessionInput.id = 'session-upload';
    sessionInput.style.display = 'none';
    sessionInput.accept = '.rhinoview';
    document.body.appendChild(sessionInput);
  }
  sessionInput.addEventListener('change', async e => {
    const f = e.target.files[0]; if (f) { await loadSession(f); }
    e.target.value = '';
  });

  // ── 1. Sliding panel toggles ──
  const leftPanel = document.getElementById('left-panel');
  const layerRightPanel = document.getElementById('layer-right-panel');
  const settingsRightPanel = document.getElementById('settings-right-panel');

  function closeAllPanels() {
    leftPanel.classList.add('hidden');
    layerRightPanel?.classList.remove('panel-open');
    settingsRightPanel?.classList.remove('panel-open');
  }

  document.getElementById('btn-file').addEventListener('click', () => {
    const isOpen = !leftPanel.classList.contains('hidden');
    closeAllPanels();
    if (!isOpen) {
      leftPanel.classList.remove('hidden');
    }
  });
  document.getElementById('btn-close-menu').addEventListener('click', () => {
    leftPanel.classList.add('hidden');
  });

  document.getElementById('btn-layer-panel')?.addEventListener('click', () => {
    const isOpen = layerRightPanel?.classList.contains('panel-open');
    closeAllPanels();
    if (!isOpen) {
      layerRightPanel?.classList.add('panel-open');
    }
  });
  document.getElementById('btn-close-layer-panel')?.addEventListener('click', () => {
    layerRightPanel?.classList.remove('panel-open');
  });

  document.getElementById('btn-settings-panel')?.addEventListener('click', () => {
    const isOpen = settingsRightPanel?.classList.contains('panel-open');
    closeAllPanels();
    if (!isOpen) {
      settingsRightPanel?.classList.add('panel-open');
    }
  });
  document.getElementById('btn-close-settings-panel')?.addEventListener('click', () => {
    settingsRightPanel?.classList.remove('panel-open');
  });

  // ── 2. File Tab Actions ──
  document.getElementById('btn-open-panel').addEventListener('click', () => {
    fileInput.click();
  });
  document.getElementById('btn-save-panel').addEventListener('click', () => {
    saveSession();
  });
  document.getElementById('btn-close-panel').addEventListener('click', () => {
    clearCurrentModel();
  });
  document.getElementById('btn-capture-panel').addEventListener('click', () => {
    // Set default W/H from current viewport
    document.getElementById('capture-w').value = window.innerWidth;
    document.getElementById('capture-h').value = window.innerHeight;
    document.getElementById('capture-size-select').value = '1';
    document.getElementById('capture-dialog').classList.remove('hidden');
    leftPanel.classList.add('hidden');
  });

  document.getElementById('btn-close-capture-dialog')?.addEventListener('click', () => {
    document.getElementById('capture-dialog').classList.add('hidden');
  });

  document.getElementById('capture-size-select')?.addEventListener('change', e => {
    const scale = parseInt(e.target.value);
    document.getElementById('capture-w').value = Math.round(window.innerWidth * scale);
    document.getElementById('capture-h').value = Math.round(window.innerHeight * scale);
  });

  document.getElementById('btn-capture-confirm')?.addEventListener('click', () => {
    const transparent = document.getElementById('capture-transparent').checked;
    const w = parseInt(document.getElementById('capture-w').value) || window.innerWidth;
    const h = parseInt(document.getElementById('capture-h').value) || window.innerHeight;

    // Save current state
    const origPixelRatio = renderer.getPixelRatio();
    const origBackground = scene.background;

    // Apply capture settings
    renderer.setSize(w, h);
    renderer.setPixelRatio(1);
    if (transparent) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }

    // Render
    renderer.render(scene, camera);

    // Get image
    const dataURL = renderer.domElement.toDataURL('image/png');

    // Restore
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(origPixelRatio);
    scene.background = origBackground;
    if (transparent) renderer.setClearColor(0x000000, 0);

    // Download
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = (currentFileName || 'capture') + '.png';
    a.click();

    document.getElementById('capture-dialog').classList.add('hidden');
  });

  // Save GLB
  const saveGlbBtn = document.getElementById('btn-save-glb');
  if (saveGlbBtn) {
    saveGlbBtn.addEventListener('click', () => exportGLB());
  }

  // ── 3. Background Color Picker Hooks ──
  const bgTypeSelect = document.getElementById('bg-type-select');
  const bgPanelC1 = document.getElementById('bg-panel-c1');
  const bgPanelC2 = document.getElementById('bg-panel-c2');
  const bgPanelC3 = document.getElementById('bg-panel-c3');
  const bgPanelC4 = document.getElementById('bg-panel-c4');

  const bgSwatchC1 = document.getElementById('bg-panel-swatch-c1');
  const bgSwatchC2 = document.getElementById('bg-panel-swatch-c2');
  const bgSwatchC3 = document.getElementById('bg-panel-swatch-c3');
  const bgSwatchC4 = document.getElementById('bg-panel-swatch-c4');

  bgTypeSelect?.addEventListener('change', () => {
    const val = bgTypeSelect.value;
    const isSolid  = val === 'solid';
    const isRadial = val === 'radial';
    const isGrad4  = val === 'gradient4';
    // picker-c1: always visible (every type needs at least one colour)
    document.getElementById('picker-c1')?.classList.remove('hidden');
    // picker-c2: visible for gradient2, radial, gradient4
    document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid);
    document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4);
    document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4);
    const radialSection = document.getElementById('bg-radial-section');
    if (radialSection) radialSection.classList.toggle('hidden', !isRadial);
    applySceneBackground();
  });

  // Radial spread slider
  const radialSpread = document.getElementById('bg-radial-spread');
  if (radialSpread) {
    radialSpread.addEventListener('input', () => {
      const v = parseFloat(radialSpread.value);
      document.getElementById('bg-radial-spread-val').textContent = Math.round(v * 100) + '%';
      updateSliderFill(radialSpread);
      applySceneBackground();
    });
  }

  // ── Environment Preset Buttons ──
  document.querySelectorAll('.env-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentEnvPreset = btn.dataset.preset;
      document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = envMaps[currentEnvPreset];
      if (preset) {
        environmentMap = preset;
        scene.environment = environmentMap;   // always apply IBL regardless of bg type
      }
    });
  });

  // ── HDR File Upload ──
  const hdrInput = document.getElementById('hdr-file-input');
  if (hdrInput) {
    hdrInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const rgbeLoader = new RGBELoader();
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      rgbeLoader.load(url, texture => {
        URL.revokeObjectURL(url);
        const envTexture = pmrem.fromEquirectangular(texture).texture;
        texture.dispose();
        pmrem.dispose();
        if (envMaps['hdr-custom']) envMaps['hdr-custom'].dispose();
        envMaps['hdr-custom'] = envTexture;
        environmentMap = envTexture;
        currentEnvPreset = 'hdr-custom';
        scene.environment = environmentMap;   // always apply IBL regardless of bg type
        // Mark custom btn active
        document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
        const customBtn = document.querySelector('.env-preset-btn[data-preset="hdr-custom"]');
        if (customBtn) customBtn.classList.add('active');
      }, undefined, err => console.error('[HDR] load error', err));
    });
  }

  const bindBgInput = (input, swatch) => {
    if (!input || !swatch) return;   // element may not exist in current HTML
    input.addEventListener('input', () => {
      swatch.style.background = input.value;
      applySceneBackground();
    });
  };
  bindBgInput(bgPanelC1, bgSwatchC1);
  bindBgInput(bgPanelC2, bgSwatchC2);
  bindBgInput(bgPanelC3, bgSwatchC3);   // optional (not in current HTML)
  bindBgInput(bgPanelC4, bgSwatchC4);   // optional (not in current HTML)

  // ── 4. Visibility Chekboxes (Left panel settings) ──
  document.getElementById('chk-edges-panel').addEventListener('change', () => applyDisplayMode());
  document.getElementById('chk-shadows-panel').addEventListener('change', e => {
    shadowsEnabled = e.target.checked;
    updateShadowCasting();
  });
  document.getElementById('chk-ground-panel').addEventListener('change', e => {
    groundEnabled = e.target.checked;
    if (groundEnabled && currentModel) {
      const box = new THREE.Box3().setFromObject(currentModel);
      addGroundPlane(box);
    } else {
      removeGroundPlane();
    }
  });
  document.getElementById('chk-annotations-panel').addEventListener('change', e => {
    if (annotationGroup) {
      annotationGroup.traverse(child => {
        if (child !== annotationGroup) child.visible = e.target.checked;
      });
    }
  });

  // Sync original settings panel checks if they exist in DOM
  const safeBindCheck = (id, targetId) => {
    const original = document.getElementById(id);
    const panelChk = document.getElementById(targetId);
    if (original && panelChk) {
      original.addEventListener('change', () => {
        panelChk.checked = original.checked;
        panelChk.dispatchEvent(new Event('change'));
      });
      panelChk.addEventListener('change', () => {
        original.checked = panelChk.checked;
      });
    }
  };
  safeBindCheck('chk-edge', 'chk-edges-panel');
  safeBindCheck('chk-shadows', 'chk-shadows-panel');
  safeBindCheck('chk-ground', 'chk-ground-panel');
  safeBindCheck('chk-annotations', 'chk-annotations-panel');

  // ── 5. Lighting & Damping Sliders ──
  document.getElementById('sl-ambient-panel').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    document.getElementById('sl-ambient-val').textContent = val.toFixed(2);
    updateSliderFill(e.target);
    scene.traverse(child => {
      if (child.isAmbientLight) child.intensity = val;
    });
  });

  // ── Sun light controls ──
  const chkSun      = document.getElementById('chk-sun-panel');
  const sunControls = document.getElementById('sun-controls');
  const slAzimuth   = document.getElementById('sl-sun-azimuth');
  const slElevation = document.getElementById('sl-sun-elevation');

  chkSun?.addEventListener('change', () => {
    sunControls?.classList.toggle('hidden', !chkSun.checked);
    updateSunLight();
  });

  slAzimuth?.addEventListener('input', e => {
    document.getElementById('sl-sun-azimuth-val').textContent = Math.round(e.target.value) + '°';
    updateSliderFill(e.target);
    updateSunLight();
  });
  slElevation?.addEventListener('input', e => {
    document.getElementById('sl-sun-elevation-val').textContent = Math.round(e.target.value) + '°';
    updateSliderFill(e.target);
    updateSunLight();
  });

  // Init slider fills for sun
  if (slAzimuth)   updateSliderFill(slAzimuth);
  if (slElevation) updateSliderFill(slElevation);

  document.getElementById('sl-damping-panel').addEventListener('input', e => {
    const friction = parseFloat(e.target.value);
    document.getElementById('sl-damping-val').textContent = friction.toFixed(2);
    updateSliderFill(e.target);
    controls.dampingFactor = 1.0 - friction;
    if (controls.dampingFactor < 0.005) controls.dampingFactor = 0.005;
  });

  // ── 6. Top-Bar Dropdowns (View/Zoom/Show merged into view-dropdown) ──
  const dropdowns = [
    { btnId: 'btn-mode-dropdown',      menuId: 'mode-dropdown'      },
    { btnId: 'btn-view-dropdown',      menuId: 'view-dropdown'      },
    { btnId: 'btn-turntable-dropdown', menuId: 'turntable-dropdown' },
    { btnId: 'btn-select-dropdown',    menuId: 'select-dropdown'    },
    { btnId: 'btn-tools-dropdown',     menuId: 'tools-dropdown'     }
  ];

  dropdowns.forEach(dd => {
    const btn = document.getElementById(dd.btnId);
    const menu = document.getElementById(dd.menuId);
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        dropdowns.forEach(other => {
          const otherMenu = document.getElementById(other.menuId);
          if (otherMenu) otherMenu.classList.add('hidden');
        });
        if (wasHidden) menu.classList.remove('hidden');
      });
    }
  });

  document.addEventListener('click', () => {
    dropdowns.forEach(dd => {
      const menu = document.getElementById(dd.menuId);
      if (menu) menu.classList.add('hidden');
    });
  });

  // Mode Dropdown items
  document.getElementById('mode-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.getElementById('mode-dropdown').querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = mode;
      applyDisplayMode();
      
      const label = btn.querySelector('span').textContent.split(' ')[0];
      const triggerBtn = document.getElementById('btn-mode-dropdown');
      triggerBtn.querySelector('span').textContent = label;
      triggerBtn.title = `Display Mode (${label})`;
    });
  });

  // View Dropdown items
  document.getElementById('view-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    if (btn.dataset.view) {
      btn.addEventListener('click', () => {
        setViewPreset(btn.dataset.view);
        const label = btn.querySelector('span').textContent.split(' ')[0];
        const triggerBtn = document.getElementById('btn-view-dropdown');
        triggerBtn.querySelector('span').textContent = label;
        triggerBtn.title = `View Preset (${label})`;
      });
    }
  });

  // Save custom named view — modal dialog
  const saveViewBtn  = document.getElementById('btn-save-named-view');
  const namedViewDlg = document.getElementById('named-view-dialog');
  const nameInput    = document.getElementById('input-named-view-name');

  function openNamedViewDialog() {
    if (!namedViewDlg) return;
    nameInput.value = '';
    namedViewDlg.classList.remove('hidden');
    // Close the view dropdown so it doesn't interfere
    document.getElementById('view-dropdown')?.classList.add('hidden');
    // Focus input on next frame (after display)
    requestAnimationFrame(() => nameInput.focus());
  }

  function closeNamedViewDialog() {
    namedViewDlg?.classList.add('hidden');
  }

  function confirmNamedView() {
    const name = nameInput?.value.trim();
    if (name) { saveCustomView(name); }
    closeNamedViewDialog();
  }

  saveViewBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openNamedViewDialog();
  });

  document.getElementById('btn-close-named-view-dialog')?.addEventListener('click', closeNamedViewDialog);
  document.getElementById('btn-cancel-named-view')?.addEventListener('click', closeNamedViewDialog);
  document.getElementById('btn-confirm-named-view')?.addEventListener('click', confirmNamedView);

  // Confirm on Enter, close on Escape
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmNamedView(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNamedViewDialog(); }
  });

  // Click on overlay backdrop → close
  namedViewDlg?.addEventListener('click', (e) => {
    if (e.target === namedViewDlg) closeNamedViewDialog();
  });


  // Zoom dropdown
  document.getElementById('btn-zoom-extents-drop').addEventListener('click', () => {
    if (!currentModel) return;
    const box = new THREE.Box3();
    currentModel.traverse(child => {
      if (child.isMesh && child.visible &&
          child.name !== 'rhino-edges' &&
          child.name !== 'rhino-outline' &&
          child.name !== 'selection-outline' &&
          child.name !== 'ground-plane') {
        box.expandByObject(child);
      }
    });
    if (!box.isEmpty()) fitCameraToBox(box, true, true);   // animated (preserve view angle)
    else fitCameraToObject(currentModel, true, true);
    document.getElementById('view-dropdown')?.classList.add('hidden');
  });
  document.getElementById('btn-zoom-selected-drop').addEventListener('click', fitCameraToSelected);

  // ── Turntable: continuous-rotation toggle + spring-speed nudge ──
  let ttContinuous = false;          // persistent auto-rotate state
  let ttBaseSpeed  = 2.0;            // speed used when toggle is ON

  const ttToggleBtn  = document.getElementById('btn-tt-toggle');
  const springSlider = document.getElementById('tt-spring-slider');
  const springVal    = document.getElementById('tt-spring-val');

  function setTurntable(on) {
    ttContinuous = on;
    controls.autoRotate = on;
    controls.autoRotateSpeed = on ? ttBaseSpeed : 0;
    if (ttToggleBtn) {
      ttToggleBtn.classList.toggle('active', on);
      ttToggleBtn.textContent = on ? t('turntable.on') : t('turntable.off');
    }
  }

  ttToggleBtn?.addEventListener('click', () => setTurntable(!ttContinuous));

  // Spring joystick: temporarily adjusts speed while dragged; restores on release
  springSlider.addEventListener('input', () => {
    const speed = parseFloat(springSlider.value);
    springVal.textContent = (speed >= 0 ? '+' : '') + speed.toFixed(1);
    updateSliderFill(springSlider);
    if (speed === 0) {
      // Only stop if toggle is off
      if (!ttContinuous) { controls.autoRotate = false; controls.autoRotateSpeed = 0; }
      else               { controls.autoRotate = true;  controls.autoRotateSpeed = ttBaseSpeed; }
    } else {
      controls.autoRotate = true;
      controls.autoRotateSpeed = speed * 4.0;
    }
  });

  const resetSpringSlider = () => {
    springSlider.value = 0;
    springVal.textContent = '0.0';
    updateSliderFill(springSlider);
    // Restore continuous-rotate state after spring is released
    controls.autoRotate      = ttContinuous;
    controls.autoRotateSpeed = ttContinuous ? ttBaseSpeed : 0;
  };
  springSlider.addEventListener('pointerup',     resetSpringSlider);
  springSlider.addEventListener('pointercancel', resetSpringSlider);
  springSlider.addEventListener('change',        resetSpringSlider);

  // Select dropdown items
  document.getElementById('select-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      selectMode = btn.dataset.select;
      document.getElementById('select-dropdown').querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const label = btn.querySelector('span').textContent.split(' ')[0];
      const triggerBtn = document.getElementById('btn-select-dropdown');
      triggerBtn.querySelector('span').textContent = `Select: ${label}`;
      triggerBtn.title = `Selection Mode (${label})`;
      updateSelectIcon(selectMode);
      if (selectMode === 'none') {
        clearSelection();
        updatePropertiesPanel();
      }
    });
  });

  // Show dropdown items
  document.getElementById('btn-show-all-drop').addEventListener('click', () => {
    hiddenObjects.forEach(obj => { obj.visible = true; });
    hiddenObjects.clear();
    updateLayerVisibility();
  });
  document.getElementById('btn-hide-selected-drop').addEventListener('click', () => {
    selectedObjects.forEach(child => {
      child.visible = false;
      hiddenObjects.add(child);
    });
    clearSelection();
    updatePropertiesPanel();
  });
  document.getElementById('btn-isolate-selected-drop').addEventListener('click', () => {
    if (!selectedObjects.length) return;
    if (!currentModel) return;
    currentModel.traverse(child => {
      if (child.isMesh && child.name !== 'rhino-edges' && child.name !== 'rhino-outline' && child.name !== 'ground-plane') {
        if (!selectedObjects.includes(child)) {
          child.visible = false;
          hiddenObjects.add(child);
        }
      }
    });
    updatePropertiesPanel();
  });

  // ── 7. Interactive Tools Dropdown Triggers ──
  document.getElementById('btn-tool-distance').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('tools-dropdown').classList.add('hidden');
    if (distanceToolState) {
      // Tool already active — toggle off (keeps existing measurements visible)
      distanceToolState = null;
      if (distanceGhostSphere) {
        if (distanceGhostSphere.geometry) distanceGhostSphere.geometry.dispose();
        if (distanceGhostSphere.material) distanceGhostSphere.material.dispose();
        measurementGroup.remove(distanceGhostSphere);
        distanceGhostSphere = null;
      }
      document.getElementById('canvas-container').style.cursor = '';
      document.getElementById('btn-tool-distance').classList.remove('active');
      renderMeasurementListUI();
      return;
    }
    // Activate: keep existing completedMeasurements intact, just start a new session
    deactivateAllTools();
    distanceToolState = { points: [], spheres: [] };
    document.getElementById('btn-tool-distance').classList.add('active');
    document.getElementById('canvas-container').style.cursor = 'crosshair';
    renderMeasurementListUI();
  });

  document.getElementById('btn-tool-angle').addEventListener('click', (e) => {
    e.stopPropagation();
    deactivateAllTools();
    document.getElementById('btn-tool-angle').classList.add('active');
    spawnAngleWidget();
    document.getElementById('tools-dropdown').classList.add('hidden');
  });

  document.getElementById('btn-tool-clipping').addEventListener('click', (e) => {
    e.stopPropagation();
    deactivateAllTools();
    document.getElementById('clipping-panel').classList.remove('hidden');
    document.getElementById('btn-tool-clipping').classList.add('active');
    document.getElementById('tools-dropdown').classList.add('hidden');
  });

  document.getElementById('btn-tool-find').addEventListener('click', (e) => {
    e.stopPropagation();
    deactivateAllTools();
    document.getElementById('find-panel').classList.remove('hidden');
    document.getElementById('btn-tool-find').classList.add('active');
    document.getElementById('tools-dropdown').classList.add('hidden');
  });

  document.getElementById('btn-tool-colorgrade').addEventListener('click', (e) => {
    e.stopPropagation();
    deactivateAllTools();
    document.getElementById('color-panel').classList.remove('hidden');
    document.getElementById('btn-tool-colorgrade').classList.add('active');
    document.getElementById('tools-dropdown').classList.add('hidden');
  });

  const setupSafeClose = (btnId, callback) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      let triggered = false;
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!triggered) {
          triggered = true;
          callback();
          setTimeout(() => { triggered = false; }, 300);
        }
      };
      btn.addEventListener('click', handler);
      btn.addEventListener('pointerdown', handler);
      btn.addEventListener('touchstart', handler, { passive: false });
    }
  };

  setupSafeClose('btn-close-clipping', () => {
    document.getElementById('clipping-panel').classList.add('hidden');
    document.getElementById('btn-tool-clipping').classList.remove('active');
  });
  setupSafeClose('btn-close-find', () => {
    document.getElementById('find-panel').classList.add('hidden');
    document.getElementById('btn-tool-find').classList.remove('active');
  });
  setupSafeClose('btn-close-color', () => {
    document.getElementById('color-panel').classList.add('hidden');
    document.getElementById('btn-tool-colorgrade').classList.remove('active');
  });
  document.getElementById('btn-measure-clear-all')?.addEventListener('click', () => {
    clearMeasurements();
  });

  setupSafeClose('btn-close-props', () => {
    document.getElementById('object-properties').classList.add('hidden');
    clearSelection();
  });

  // ── Draggable Properties Panel ──
  ;(function() {
    const panel  = document.getElementById('object-properties');
    const handle = document.getElementById('prop-drag-handle');
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;

    const onDown = e => {
      if (e.target.closest('button')) return;   // let close-btn click through
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left  = x + 'px';
      panel.style.top   = y + 'px';
      panel.style.right = 'auto';  // detach from right anchor after first drag
    };
    const onUp = () => { dragging = false; };

    handle.addEventListener('pointerdown',   onDown);
    handle.addEventListener('pointermove',   onMove);
    handle.addEventListener('pointerup',     onUp);
    handle.addEventListener('pointercancel', onUp);
  })();

  // Layer section Toggle All button
  const toggleAllLayersPanelEl = document.getElementById('btn-toggle-all-layers-panel');
  if (toggleAllLayersPanelEl) {
    toggleAllLayersPanelEl.addEventListener('click', () => {
      const anyOff = parsedLayers.some(l => !l.visible);
      parsedLayers.forEach(l => l.visible = anyOff);
      renderLayerUI();
      updateLayerVisibility();
      createAnnotationSprites();
    });
  }

  // ── 8. Clipping Plane Controls ──
  // clip-rot-x / clip-rot-y removed from HTML — axis is now set via axis+flip buttons

  document.getElementById('chk-clipping-enable').addEventListener('change', e => {
    clippingEnabled = e.target.checked;
    renderer.clippingPlanes = clippingEnabled ? [clippingPlane] : [];
    if (clippingEnabled) setupClippingHelper();
    else {
      if (clippingTransformControls) { clippingTransformControls.detach(); clippingTransformControls.visible = false; }
      if (clippingHelper) { scene.remove(clippingHelper); clippingHelper = null; }
    }
  });

  // ── Draggable Clipping Panel ──
  ;(function() {
    const panel = document.getElementById('clipping-panel');
    const handle = panel?.querySelector('.cg-header');
    if (!panel || !handle) return;
    let ox=0, oy=0, dragging=false;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button,input,select')) return;
      dragging=true; handle.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      handle.style.cursor = 'grabbing';
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging=false; handle.style.cursor='grab'; });
  })();

  // ── Clipping: current axis state ──
  let clipAxis   = 'z';   // 'x' | 'y' | 'z'
  let clipFlipped = false; // false = positive side, true = flipped

  function applyClipAxisUI() {
    // Axis buttons active state
    document.querySelectorAll('.clip-axis-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.axis === clipAxis);
    });
    // Derive rot-x / rot-y from axis + flip
    // Normal directions: Z→(0,0,1), Y→(0,1,0), X→(1,0,0)
    // rot-x / rot-y map for updateClippingPlane's Euler rotation logic
    const normals = {
      z:  [0,  180], // +Z
      zf: [0,    0], // −Z
      y:  [-90,  0], // +Y
      yf: [ 90,  0], // −Y
      x:  [0,  -90], // +X
      xf: [0,   90], // −X
    };
    const key = clipAxis + (clipFlipped ? 'f' : '');
    const [rx, ry] = normals[key];
    const rotXSlider = document.getElementById('clip-rot-x');
    const rotYSlider = document.getElementById('clip-rot-y');
    // rot sliders may not exist in new simplified HTML — use hidden vars
    if (rotXSlider) { rotXSlider.value = rx; }
    if (rotYSlider) { rotYSlider.value = ry; }
    // Store as data attrs for updateClippingPlane to read
    const cp = document.getElementById('clipping-panel');
    if (cp) { cp.dataset.rotX = rx; cp.dataset.rotY = ry; }
    updateClippingPlane();
  }

  document.querySelectorAll('.clip-axis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      clipAxis = btn.dataset.axis;
      applyClipAxisUI();
    });
  });

  document.getElementById('btn-clip-flip')?.addEventListener('click', () => {
    clipFlipped = !clipFlipped;
    applyClipAxisUI();
  });

  // ── 9. Object Search — Real-time live selection ──
  const findInput = document.getElementById('find-search-input');
  const findBtn   = document.getElementById('btn-find-search');
  if (findInput) {
    findInput.addEventListener('input', () => {
      const query = findInput.value.trim();
      clearSelection();
      if (!currentModel || !query) { updatePropertiesPanel(); return; }
      currentModel.traverse(child => {
        if (!(child.isMesh || child.isLine || child.isLineSegments)) return;
        if (child.name === 'rhino-edges' || child.name === 'rhino-outline'
            || child.name === 'selection-outline' || child.name === 'ground-plane') return;
        const name = child.userData?.attributes?.name || child.name || '';
        if (name.toLowerCase().includes(query.toLowerCase())) {
          selectedObjects.push(child);
          addSelectionOutline(child);
        }
      });
      updatePropertiesPanel();
    });
    // Keep old keydown + button working as fallback
    findInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { findInput.value = ''; clearSelection(); updatePropertiesPanel(); }
    });
  }
  if (findBtn) {
    findBtn.addEventListener('click', () => {
      if (findInput) findInput.dispatchEvent(new Event('input'));
    });
  }


  // ── 10. Floating Color Grading resetting and sliders ──
  const cgPanel = document.getElementById('color-panel');
  document.getElementById('btn-cg-reset').addEventListener('click', () => {
    ['exposure','contrast','saturation','temperature'].forEach(k => {
      const slider = document.getElementById('cg-' + k);
      if (slider) {
        slider.value = 0;
        document.getElementById('cg-' + k + '-val').textContent = '0.0';
        cgPass.uniforms['u' + k.charAt(0).toUpperCase() + k.slice(1)].value = 0;
      }
    });
  });
  const cgSliders = [
    { id: 'cg-exposure',    uniform: 'uExposure'    },
    { id: 'cg-contrast',    uniform: 'uContrast'    },
    { id: 'cg-saturation',  uniform: 'uSaturation'  },
    { id: 'cg-temperature', uniform: 'uTemperature' }
  ];
  cgSliders.forEach(({ id, uniform }) => {
    const slider = document.getElementById(id);
    if (slider) {
      slider.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        document.getElementById(id + '-val').textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
        cgPass.uniforms[uniform].value = v;
        updateSliderFill(e.target);
      });
    }
  });

  // ── Draggable Color Adjustment Panel ──
  ;(function() {
    const panel = document.getElementById('color-panel');
    const handle = panel?.querySelector('.cg-header');
    if (!panel || !handle) return;
    let ox=0, oy=0, dragging=false;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button,input,select')) return;
      dragging=true; handle.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      handle.style.cursor = 'grabbing';
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging=false; handle.style.cursor='grab'; });
  })();

  // ── 11. Core Pointer Interactions on Canvas (Click vs Rotate / Drag) ──
  renderer.domElement.addEventListener('pointerdown', (e) => {
    pointerDownTime = performance.now();
    pointerDownPos.set(e.clientX, e.clientY);
    handleWidgetPointerDown(e);
  });
  
  renderer.domElement.addEventListener('pointermove', (e) => {
    handleWidgetPointerMove(e);
    updateTempDistanceLine(e);
    updateDistanceGhost(e);
  });
  
  renderer.domElement.addEventListener('pointerup', (e) => {
    handleWidgetPointerUp();

    const timeDiff = performance.now() - pointerDownTime;
    const dist = pointerDownPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY));
    const isClick = timeDiff < 500 && dist < 12;

    if (isClick) {
      // Close all side panels when clicking on the 3D viewport
      const anyPanelOpen =
        !leftPanel.classList.contains('hidden') ||
        layerRightPanel?.classList.contains('panel-open') ||
        settingsRightPanel?.classList.contains('panel-open');
      if (anyPanelOpen) {
        closeAllPanels();
        return; // consume this click — don't also select an object
      }

      // Close any open dropdown menus on viewport click
      document.querySelectorAll('.dropdown-menu:not(.hidden)')
        .forEach(m => m.classList.add('hidden'));

      if (distanceToolState) {
        onCanvasClick(e);
      } else {
        onPointerDown(e);
      }
    }
  });

  // ── Camera: Perspective / Parallel (Orthographic) projection toggle ──
  const projSelect = document.getElementById('select-projection');
  if (projSelect) {
    projSelect.value = (camera === orthoCamera) ? 'parallel' : 'perspective';
    projSelect.addEventListener('change', () => {
      if (projSelect.value === 'parallel') {
        switchToOrtho();
      } else {
        switchToPersp();
      }
    });
  }

  // ── Camera: FOV slider ──
  const fovSlider = document.getElementById('sl-camera-fov');
  const fovValEl  = document.getElementById('sl-camera-fov-val');
  if (fovSlider) {
    fovSlider.addEventListener('input', () => {
      const fov = parseInt(fovSlider.value);
      if (fovValEl) fovValEl.textContent = fov + '°';
      perspCamera.fov = fov;
      perspCamera.updateProjectionMatrix();
      updateSliderFill(fovSlider);
    });
  }

  // ── Language Selector ──
  const langSel = document.getElementById('lang-select');
  if (langSel) {
    // currentLang is a live ES module binding — reflects what initI18n() set
    langSel.value = currentLang;
    langSel.addEventListener('change', () => {
      setLang(langSel.value);
    });
  }

  // ── Theme Selector ──
  const themeSel = document.getElementById('theme-select');
  if (themeSel) {
    themeSel.value = currentTheme;
    themeSel.addEventListener('change', () => {
      applyTheme(themeSel.value);
    });
  }

  // ── Drag & Drop support ──
  window.addEventListener('dragenter', e => {
    e.preventDefault();
  });
  window.addEventListener('dragover', e => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const f = files[0];
      if (f.name.toLowerCase().endsWith('.rhinoview')) {
        loadSession(f);
      } else {
        handleFile(f);
      }
    }
  });
}

// ── Interactive Tools Helper Functions ─────────────────────────────────────
function deactivateAllTools() {
  if (distanceToolState) {
    // Remove in-progress (incomplete) measurement spheres only
    if (distanceToolState.spheres) {
      distanceToolState.spheres.forEach(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        measurementGroup.remove(o);
      });
    }
    if (distanceToolState.tempLine)      { measurementGroup.remove(distanceToolState.tempLine); }
    if (distanceToolState.tempBillboard) { measurementGroup.remove(distanceToolState.tempBillboard); }
    distanceToolState = null;
  }
  if (distanceGhostSphere) {
    if (distanceGhostSphere.geometry) distanceGhostSphere.geometry.dispose();
    if (distanceGhostSphere.material) distanceGhostSphere.material.dispose();
    measurementGroup.remove(distanceGhostSphere);
    distanceGhostSphere = null;
  }
  document.getElementById('canvas-container').style.cursor = '';
  // Keep completedMeasurements visible — clearMeasurements() only called explicitly
  
  if (angleWidget) {
    scene.remove(angleWidget.group);
    angleWidget.handles.forEach(h => {
      h.geometry.dispose();
      h.material.dispose();
    });
    angleWidget.lines.geometry.dispose();
    angleWidget.lines.material.dispose();
    angleWidget = null;
  }
  draggedHandle = null;
  controls.enabled = true;
  
  document.getElementById('clipping-panel').classList.add('hidden');
  document.getElementById('btn-tool-clipping').classList.remove('active');
  
  document.getElementById('find-panel').classList.add('hidden');
  document.getElementById('btn-tool-find').classList.remove('active');
  
  document.getElementById('color-panel').classList.add('hidden');
  document.getElementById('btn-tool-colorgrade').classList.remove('active');
  
  document.getElementById('btn-tool-distance').classList.remove('active');
  document.getElementById('btn-tool-angle').classList.remove('active');
}

function clearMeasurements() {
  while (measurementGroup.children.length > 0) {
    const child = measurementGroup.children[0];
    if (child.geometry) child.geometry.dispose();
    if (child.material) { if (Array.isArray(child.material)) child.material.forEach(m=>m.dispose()); else child.material.dispose(); }
    measurementGroup.remove(child);
  }
  completedMeasurements = [];
  renderMeasurementListUI();
}

function deleteMeasurement(id) {
  const idx = completedMeasurements.findIndex(m => m.id === id);
  if (idx === -1) return;
  const m = completedMeasurements[idx];
  m.objects.forEach(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (Array.isArray(o.material)) o.material.forEach(mat=>mat.dispose()); else o.material.dispose(); }
    measurementGroup.remove(o);
  });
  completedMeasurements.splice(idx, 1);
  renderMeasurementListUI();
}

function renderMeasurementListUI() {
  const panel = document.getElementById('measurement-list-panel');
  if (!panel) return;

  if (!distanceToolState || completedMeasurements.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  const list = panel.querySelector('#measurement-list-items');
  if (!list) return;
  list.innerHTML = '';

  completedMeasurements.forEach((m, i) => {
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
  const ctx = canvas.getContext('2d');
  canvas.width = 160;
  canvas.height = 52;

  // Semi-transparent black background with rounded corners
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(4, 4, 152, 44, 8);
  } else {
    ctx.rect(4, 4, 152, 44);
  }
  ctx.fill();

  // Subtle white border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // White text
  ctx.fillStyle = '#ffffff';
  ctx.font = "bold 18px 'Inter', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 80, 26);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(position);

  const modelSize = currentModel ? new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3()).length() : 100;
  sprite.scale.set(modelSize * 0.08, modelSize * 0.026, 1);
  return sprite;
}

function spawnAngleWidget() {
  if (!currentModel) return;
  const box = new THREE.Box3().setFromObject(currentModel);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // Unified radius: matches distance tool sphere size
  const radius = size.length() * 0.008;
  
  const g = new THREE.Group();
  g.name = 'angle-widget-group';
  
  const geo = new THREE.SphereGeometry(radius, 16, 16);
  const hCenter = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false })); 
  const hA = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x10b981, depthTest: false }));      
  const hB = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false }));      
  
  hCenter.position.copy(center);
  hA.position.set(center.x + size.x * 0.2, center.y, center.z);
  hB.position.set(center.x, center.y + size.y * 0.2, center.z);
  
  hCenter.userData = { role: 'center' };
  hA.userData = { role: 'ptA' };
  hB.userData = { role: 'ptB' };
  
  g.add(hCenter);
  g.add(hA);
  g.add(hB);
  
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2, depthTest: false });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    hA.position, hCenter.position,
    hCenter.position, hB.position
  ]);
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  g.add(lines);
  
  scene.add(g);
  
  angleWidget = {
    group: g,
    handles: [hCenter, hA, hB],
    lines: lines,
    center: hCenter.position,
    ptA: hA.position,
    ptB: hB.position,
    billboard: null
  };
  updateAngleWidget();
}

function updateAngleWidget() {
  if (!angleWidget) return;
  const pts = [
    angleWidget.ptA, angleWidget.center,
    angleWidget.center, angleWidget.ptB
  ];
  angleWidget.lines.geometry.setFromPoints(pts);
  
  const vA = new THREE.Vector3().subVectors(angleWidget.ptA, angleWidget.center).normalize();
  const vB = new THREE.Vector3().subVectors(angleWidget.ptB, angleWidget.center).normalize();
  const cosTheta = vA.dot(vB);
  const angleRad = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  const angleDeg = angleRad * (180 / Math.PI);
  
  if (angleWidget.billboard) angleWidget.group.remove(angleWidget.billboard);
  const text = `${angleDeg.toFixed(1)}°`;
  const size = currentModel ? new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3()).length() : 100;
  const billboardPos = angleWidget.center.clone().add(new THREE.Vector3(0, 0, size * 0.03));
  angleWidget.billboard = makeMeasurementBillboard(text, billboardPos);
  angleWidget.group.add(angleWidget.billboard);
}

function handleWidgetPointerDown(event) {
  if (!angleWidget) return;
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  
  const intersects = raycaster.intersectObjects(angleWidget.handles);
  if (intersects.length > 0) {
    controls.enabled = false;
    draggedHandle = intersects[0].object;
  }
}

function handleWidgetPointerMove(event) {
  if (!angleWidget || !draggedHandle) return;
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  
  const role = draggedHandle.userData.role;
  
  // For ptA / ptB handles: try snapping to model vertex first
  if (role !== 'center' && currentModel) {
    const modelHits = raycaster.intersectObject(currentModel, true);
    const modelHit = modelHits.find(i => i.object.isMesh
      && i.object.name !== 'ground-plane'
      && i.object.name !== 'rhino-edges'
      && i.object.name !== 'rhino-outline'
      && i.object.name !== 'selection-outline');
    if (modelHit) {
      let snapPt = modelHit.point.clone();
      // Snap to nearest vertex on the hit face
      if (modelHit.object.geometry && modelHit.object.geometry.attributes.position && modelHit.faceIndex !== undefined) {
        const geom = modelHit.object.geometry;
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
        const modelSize = new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3()).length();
        if (minDist > modelSize * 0.05) snapPt.copy(modelHit.point); // fallback if vertex too far
      }
      draggedHandle.position.copy(snapPt);
      if (role === 'ptA') angleWidget.ptA.copy(snapPt);
      else if (role === 'ptB') angleWidget.ptB.copy(snapPt);
      updateAngleWidget();
      return;
    }
  }

  // Fallback: use a plane perpendicular to the camera view direction
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const planeNormal = camDir.clone().negate();
  const plane = new THREE.Plane();
  plane.setFromNormalAndCoplanarPoint(planeNormal, angleWidget.center);
  const targetPt = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, targetPt)) {
    draggedHandle.position.copy(targetPt);
    if (role === 'center') {
      const disp = new THREE.Vector3().subVectors(targetPt, angleWidget.center);
      angleWidget.ptA.add(disp);
      angleWidget.ptB.add(disp);
      angleWidget.handles[1].position.copy(angleWidget.ptA);
      angleWidget.handles[2].position.copy(angleWidget.ptB);
    } else if (role === 'ptA') {
      angleWidget.ptA.copy(targetPt);
    } else if (role === 'ptB') {
      angleWidget.ptB.copy(targetPt);
    }
    updateAngleWidget();
  }
}

function handleWidgetPointerUp() {
  if (draggedHandle) {
    draggedHandle = null;
    controls.enabled = true;
  }
}

function updateTempDistanceLine(event) {
  if (distanceToolState && distanceToolState.points.length === 1) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    
    const intersects = raycaster.intersectObject(currentModel, true);
    const hit = intersects.find(i => i.object.isMesh && i.object.name !== 'ground-plane' && i.object.name !== 'rhino-edges' && i.object.name !== 'rhino-outline' && i.object.name !== 'selection-outline');
    if (hit) {
      const p1 = distanceToolState.points[0];
      const p2 = hit.point;
      
      if (distanceToolState.tempLine) measurementGroup.remove(distanceToolState.tempLine);
      if (distanceToolState.tempBillboard) measurementGroup.remove(distanceToolState.tempBillboard);
      
      const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const lineMat = new THREE.LineDashedMaterial({ color: 0x10b981, dashSize: 0.5, gapSize: 0.25 });
      const line = new THREE.Line(lineGeo, lineMat);
      line.computeLineDistances();
      distanceToolState.tempLine = line;
      measurementGroup.add(line);
      
      const dist = p1.distanceTo(p2);
      const billboard = makeMeasurementBillboard(`${dist.toFixed(2)} mm`, p1.clone().add(p2).multiplyScalar(0.5));
      distanceToolState.tempBillboard = billboard;
      measurementGroup.add(billboard);
    }
  }
}

function updateDistanceGhost(event) {
  if (!distanceToolState || !currentModel) {
    if (distanceGhostSphere) {
      measurementGroup.remove(distanceGhostSphere);
      distanceGhostSphere = null;
    }
    return;
  }

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(currentModel, true);
  const hit = intersects.find(i => i.object.isMesh &&
    i.object.name !== 'ground-plane' &&
    i.object.name !== 'rhino-edges' &&
    i.object.name !== 'rhino-outline' &&
    i.object.name !== 'selection-outline');

  if (hit) {
    const p = hit.point.clone();
    if (!distanceGhostSphere) {
      const size = new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3());
      const r = size.length() * 0.007;
      const geo = new THREE.SphereGeometry(r, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.5 });
      distanceGhostSphere = new THREE.Mesh(geo, mat);
      distanceGhostSphere.name = 'distance-ghost';
      measurementGroup.add(distanceGhostSphere);
    }
    distanceGhostSphere.visible = true;
    distanceGhostSphere.position.copy(p);
  } else {
    if (distanceGhostSphere) distanceGhostSphere.visible = false;
  }
}

function onCanvasClick(event) {
  if (distanceToolState) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    
    const intersects = raycaster.intersectObject(currentModel, true);
    const hit = intersects.find(i => i.object.isMesh && i.object.name !== 'ground-plane' && i.object.name !== 'rhino-edges' && i.object.name !== 'rhino-outline' && i.object.name !== 'selection-outline');
    if (hit) {
      const p = hit.point.clone();
      
      if (hit.object.geometry && hit.object.geometry.attributes.position) {
        const geom = hit.object.geometry;
        const posAttr = geom.attributes.position;
        const localPt = hit.object.worldToLocal(p.clone());
        let minDist = Infinity;
        let snapPt = localPt.clone();
        
        // hit.faceIndex = face index in the geometry (Three.js r139+)
        // hit.index was the old (wrong) property — it is always undefined for mesh intersections
        const faceIndex = hit.faceIndex;
        if (faceIndex !== undefined && faceIndex !== null) {
          const checkVert = (idx) => {
            const vx = posAttr.getX(idx);
            const vy = posAttr.getY(idx);
            const vz = posAttr.getZ(idx);
            const v = new THREE.Vector3(vx, vy, vz);
            const d = v.distanceTo(localPt);
            if (d < minDist) {
              minDist = d;
              snapPt.copy(v);
            }
          };
          if (geom.index) {
            const triIdx = faceIndex * 3;
            checkVert(geom.index.getX(triIdx));
            checkVert(geom.index.getX(triIdx + 1));
            checkVert(geom.index.getX(triIdx + 2));
          } else {
            checkVert(faceIndex * 3);
            checkVert(faceIndex * 3 + 1);
            checkVert(faceIndex * 3 + 2);
          }
          const worldSnap = hit.object.localToWorld(snapPt.clone());
          const size = new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3());
          if (worldSnap.distanceTo(p) < size.length() * 0.05) {
            p.copy(worldSnap);
          }
        }
      }
      
      const size = new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3());
      const sphereGeo = new THREE.SphereGeometry(size.length() * 0.008, 16, 16);
      const sphere = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x10b981 }));
      sphere.position.copy(p);
      measurementGroup.add(sphere);
      distanceToolState.points.push(p);
      distanceToolState.spheres = distanceToolState.spheres || [];
      distanceToolState.spheres.push(sphere);

      if (distanceToolState.points.length === 2) {
        const p1 = distanceToolState.points[0];
        const p2 = distanceToolState.points[1];

        // Remove temp preview objects
        if (distanceToolState.tempLine)      { measurementGroup.remove(distanceToolState.tempLine); }
        if (distanceToolState.tempBillboard) { measurementGroup.remove(distanceToolState.tempBillboard); }

        const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
        const lineMat = new THREE.LineDashedMaterial({ color: 0x10b981, dashSize: 1, gapSize: 0.5 });
        const line = new THREE.Line(lineGeo, lineMat);
        line.computeLineDistances();
        measurementGroup.add(line);

        const dist = p1.distanceTo(p2);
        const billboard = makeMeasurementBillboard(`${dist.toFixed(2)} mm`, p1.clone().add(p2).multiplyScalar(0.5));
        measurementGroup.add(billboard);

        // Store in completedMeasurements for individual delete
        completedMeasurements.push({
          id: Date.now(),
          p1: p1.clone(), p2: p2.clone(),
          dist,
          objects: [...(distanceToolState.spheres || []), line, billboard]
        });

        // Reset for next measurement (tool stays active)
        distanceToolState.points  = [];
        distanceToolState.spheres = [];
        distanceToolState.tempLine      = null;
        distanceToolState.tempBillboard = null;

        renderMeasurementListUI();
      }
    }
  }
}


// ── Custom Named Views (localStorage) ─────────────────────────────────────
function _customViewKey() {
  const base = currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : '__default__';
  return `rhino_custom_views_${base}`;
}
function getCustomViews() {
  try { return JSON.parse(localStorage.getItem(_customViewKey()) || '[]'); } catch { return []; }
}
function saveCustomView(name) {
  if (!name || !controls) return;
  const views = getCustomViews();
  views.push({
    name,
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray()
  });
  localStorage.setItem(_customViewKey(), JSON.stringify(views));
  renderNamedViewsUI();
}
function deleteCustomView(name) {
  const views = getCustomViews().filter(v => v.name !== name);
  localStorage.setItem(_customViewKey(), JSON.stringify(views));
  renderNamedViewsUI();
}

function renderNamedViewsUI() {
  const container = document.getElementById('named-views-list');
  if (!container) return;
  container.innerHTML = '';

  const rhinoViews  = parsedNamedViews || [];
  const customViews = getCustomViews();
  const allViews = [...rhinoViews, ...customViews.map(v => ({ ...v, isCustom: true }))];

  if (!allViews.length) {
    container.innerHTML = '<span class="dropdown-empty-msg" data-i18n="view.no_named">No named views</span>';
    return;
  }
  allViews.forEach(nv => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const btn = document.createElement('button');
    btn.className = 'dropdown-item';
    btn.style.flex = '1';
    btn.innerHTML = `<span>${nv.name}</span>`;
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
      del.className = 'icon-btn sm';
      del.title = 'Delete view';
      del.style.cssText = 'padding:3px 5px;flex-shrink:0;color:var(--text-2);';
      del.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><polyline points="2 4 14 4"/><path d="M6 4V3h4v1M5 4l.5 9h5l.5-9"/></svg>`;
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteCustomView(nv.name); });
      row.appendChild(del);
    }
    container.appendChild(row);
  });
}


function updateClippingPlane() {
  if (!currentModel) return;
  // Height is now controlled by the gumball; use 0 as default when no slider present
  const height = parseFloat(document.getElementById('clip-height')?.value ?? 0);
  // Rotation is driven by the axis+flip buttons, stored as data attrs on the panel.
  const cp = document.getElementById('clipping-panel');
  const rotXDeg = parseFloat(cp?.dataset.rotX ?? document.getElementById('clip-rot-x')?.value ?? 0);
  const rotYDeg = parseFloat(cp?.dataset.rotY ?? document.getElementById('clip-rot-y')?.value ?? 0);
  const rotX = rotXDeg * Math.PI / 180;
  const rotY = rotYDeg * Math.PI / 180;
  
  const normal = new THREE.Vector3(0, 0, -1);
  normal.applyAxisAngle(new THREE.Vector3(1, 0, 0), rotX);
  normal.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  normal.normalize();
  clippingPlane.normal.copy(normal);
  
  const box = new THREE.Box3().setFromObject(currentModel);
  const center = box.getCenter(new THREE.Vector3());
  const targetPt = center.clone().addScaledVector(normal, height);
  clippingPlane.constant = -normal.dot(targetPt);
  updateClippingHelperPose();
}

function setupClippingHelper() {
  // Detach gumball before destroying old helper
  if (clippingTransformControls) clippingTransformControls.detach();
  if (clippingHelper) { scene.remove(clippingHelper); clippingHelper = null; }
  if (!clippingEnabled) return;

  const size = currentModel
    ? new THREE.Box3().setFromObject(currentModel).getSize(new THREE.Vector3()).length() * 0.65
    : 50;

  // Build a grid of line segments in the local XZ plane (Y = 0)
  const div = 5;
  const pts = [];
  for (let i = -div; i <= div; i++) {
    const t = (i / div) * size;
    pts.push(-size, 0, t,  size, 0, t);   // rows (Z axis)
    pts.push( t, 0, -size,  t, 0,  size); // cols (X axis)
  }
  // Thicker outer border
  const b = size;
  pts.push(-b, 0, -b,  b, 0, -b,  b, 0, -b,  b, 0,  b,  b, 0,  b, -b, 0,  b, -b, 0,  b, -b, 0, -b);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xef4444,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.75
  });
  clippingHelper = new THREE.LineSegments(geo, mat);
  clippingHelper.renderOrder = 999;
  scene.add(clippingHelper);
  updateClippingHelperPose();

  // Attach TransformControls gumball to the clipping helper
  if (clippingTransformControls) {
    clippingTransformControls.attach(clippingHelper);
    clippingTransformControls.visible = true;
  }
}

function updateClippingHelperPose() {
  if (!clippingHelper) return;
  // Orient the XZ-plane grid so its Y+ axis aligns with the clipping plane normal
  const normal = clippingPlane.normal.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  clippingHelper.quaternion.setFromUnitVectors(up, normal);
  // Position: project origin onto the plane
  const d = -clippingPlane.constant;
  clippingHelper.position.copy(normal.clone().multiplyScalar(d));
}

function searchObjects(query) {
  const container = document.getElementById('find-results-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (!currentModel) {
    container.innerHTML = '<span class="dropdown-empty-msg">No model loaded</span>';
    return;
  }
  if (!query || query.trim() === '') {
    container.innerHTML = '<span class="dropdown-empty-msg">Enter object name...</span>';
    return;
  }
  
  const matches = [];
  currentModel.traverse(child => {
    if (child.isMesh && child.name !== 'rhino-edges' && child.name !== 'rhino-outline' && child.name !== 'ground-plane') {
      const name = child.userData?.attributes?.name || child.name || '';
      if (name.toLowerCase().includes(query.toLowerCase())) matches.push(child);
    }
  });
  
  if (matches.length === 0) {
    container.innerHTML = '<span class="dropdown-empty-msg" style="padding:10px 0;">No matching objects found</span>';
    return;
  }
  
  matches.forEach(obj => {
    const name = obj.userData?.attributes?.name || obj.name || 'Unnamed Mesh';
    const layer = parsedLayers.find(l => l.index === obj.userData?.attributes?.layerIndex);
    
    const btn = document.createElement('button');
    btn.className = 'dropdown-item';
    btn.style.width = '100%';
    btn.style.padding = '6px 8px';
    btn.style.background = 'var(--surface-hi)';
    btn.style.border = '1px solid var(--border)';
    btn.style.borderRadius = 'var(--r-sm)';
    btn.style.marginBottom = '4px';
    btn.style.color = 'var(--text)';
    
    btn.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:2px; font-size:0.75rem; text-align:left;">
        <span style="font-weight:600;">${name}</span>
        <span style="color:var(--text-2); font-size:0.65rem;">Layer: ${layer?.name ?? '—'}</span>
      </div>
    `;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
      selectedObjects.push(obj);
      addSelectionOutline(obj);
      fitCameraToObject(obj, true);
      updatePropertiesPanel();
    });
    container.appendChild(btn);
  });
}

// ── Environment presets ────────────────────────────────────────────────────
function makeGradientEnv(pmrem, top, mid, horizon, bottom) {
  const w = 512, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0,    top);
  grad.addColorStop(0.38, mid);
  grad.addColorStop(0.55, horizon ?? mid);
  grad.addColorStop(1,    bottom ?? top);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const envMap = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  return envMap;
}

// Update the select-mode button icon to reflect current mode
function updateSelectIcon(mode) {
  const btn = document.getElementById('btn-select-dropdown') || document.getElementById('btn-select-mode');
  if (!btn) return;
  const svg = btn.querySelector('svg');
  if (!svg) return;
  if (mode === 'none') {
    svg.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>';
  } else if (mode === 'single') {
    svg.innerHTML = '<path d="M5 3l4.5 15.5 2.5-6.5 6.5-2.5z"/><line x1="15.5" y1="15.5" x2="20" y2="20"/>';
  } else {
    svg.innerHTML = '<path d="M4 3l3.5 12 2-5 5-2z"/><line x1="18" y1="10" x2="22" y2="10"/><line x1="20" y1="8" x2="20" y2="12"/>';
  }
}

// ── Lights ─────────────────────────────────────────────────────────────────
function setupLights() {
  // Use scene.remove() so parent/children stay in sync — never replace array directly
  scene.children.slice().forEach(c => {
    if (!c.isLight) return;
    if (c === sunLight) return;               // preserve sun light (also shadow caster)
    if (sunLight && c === sunLight.target) return;
    scene.remove(c);
  });
  camera.children.slice().forEach(c => { if (c.isLight) camera.remove(c); });

  const keyPos = new THREE.Vector3(-0.8, -0.6, 1.5).normalize();

  switch (currentMode) {
    case 'shaded':
    case 'wireframe': {
      // Rhino-style shaded: sky ambient + strong key + fill
      const ambInt = parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.35);
      const keyInt = parseFloat(document.getElementById('sl-key-panel')?.value ?? 1.4);
      scene.add(new THREE.AmbientLight(0xffffff, ambInt));

      const key = new THREE.DirectionalLight(0xffffff, keyInt * 0.95);
      key.position.copy(keyPos);
      scene.add(key);

      const fill = new THREE.DirectionalLight(0xd9e8ff, keyInt * 0.25);
      fill.position.set(0.8, 0.6, 0.5).normalize();
      scene.add(fill);
      break;
    }
    case 'arctic': {
      // Art / Arch mode: soft hemisphere skylight + key light for shading
      scene.add(new THREE.AmbientLight(0xffffff, 0.25));
      
      // Hemisphere light to act as a sky/ground dome environment (completely neutral grey ground)
      const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 0.55);
      scene.add(hemi);

      // Pure white directional light for clean neutral shading
      const key = new THREE.DirectionalLight(0xffffff, 1.2);
      key.position.copy(keyPos);
      scene.add(key);
      break;
    }
    case 'rendered': {
      // Rendered uses env map primarily; supplement with directional key light
      scene.add(new THREE.AmbientLight(0xffffff, 0.15));
      
      const key = new THREE.DirectionalLight(0xfff8f0, 0.85);
      key.position.copy(keyPos);
      scene.add(key);
      break;
    }
    case 'technical':
      // Sketch mode: uniform full ambient light for flat white hand-drawn look
      scene.add(new THREE.AmbientLight(0xffffff, 1.25));
      break;
  }
}

// ── Sun light (visual sun + shadow caster, unified) ───────────────────────
function updateSunLight() {
  const chk     = document.getElementById('chk-sun-panel');
  const enabled = chk?.checked ?? false;

  // Clean remove first — avoids stale parent/children references
  if (sunLight) {
    scene.remove(sunLight.target);
    scene.remove(sunLight);
  }

  if (!enabled) {
    sunLight = null;
    updateGroundAppearance();
    return;
  }

  if (!sunLight) {
    sunLight = new THREE.DirectionalLight(0xffffff, 1.8);
    sunLight.name = 'sun-light';
  }

  // Dynamically update sunlight color based on mode to prevent warm tints in Arctic/Technical modes
  if (currentMode === 'arctic' || currentMode === 'technical') {
    sunLight.color.setHex(0xffffff);
  } else {
    sunLight.color.setHex(0xfff4e0);
  }

  // ── Shadow camera frustum (depends on loaded model size) ────────────────
  const center = modelShadowDims?.center || new THREE.Vector3(0, 0, 0);
  const maxDim = modelShadowDims?.maxDim || 100;

  sunLight.castShadow = shadowsEnabled;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = maxDim * 0.01;
  sunLight.shadow.camera.far  = maxDim * 10;
  const h = maxDim * 3;    // ground plane spans maxDim*5, frustum must cover it
  sunLight.shadow.camera.left   = -h;
  sunLight.shadow.camera.right  =  h;
  sunLight.shadow.camera.top    =  h;
  sunLight.shadow.camera.bottom = -h;

  // ── Position from azimuth / elevation around model center ──────────────
  const azimuthDeg   = parseFloat(document.getElementById('sl-sun-azimuth')?.value   ?? 135);
  const elevationDeg = parseFloat(document.getElementById('sl-sun-elevation')?.value  ?? 45);
  const az  = azimuthDeg   * Math.PI / 180;
  const el  = elevationDeg * Math.PI / 180;
  const dist = maxDim * 2;

  // Scene is Z-up (Rhino coordinate system): elevation maps to Z, not Y
  sunLight.position.set(
    center.x + dist * Math.cos(el) * Math.sin(az),   // X: horizontal east/west
    center.y + dist * Math.cos(el) * Math.cos(az),   // Y: horizontal north/south
    center.z + dist * Math.sin(el)                    // Z: vertical (up in this scene)
  );
  sunLight.target.position.copy(center);

  // Re-add target then light so direction is computed in world space
  scene.add(sunLight.target);
  scene.add(sunLight);

  // Force shadow map refresh on next frame
  if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
  sunLight.shadow.camera.updateProjectionMatrix();
  updateGroundAppearance();
}

// ── Per-model shadow frustum setup (called on model load) ─────────────────
function setupModelShadowFrustum(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  modelShadowDims = { center, maxDim };
  // Rebuild sun light with new frustum + correct position relative to model
  updateSunLight();
}

function updateShadowCasting() {
  if (sunLight) {
    sunLight.castShadow = shadowsEnabled;
    if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
  }
  if (!currentModel) return;
  currentModel.traverse(child => {
    if (child.isMesh) {
      child.castShadow   = shadowsEnabled;
      child.receiveShadow = shadowsEnabled;
    }
  });
  if (groundMesh) updateGroundAppearance();
}

// ── Ground appearance (material + SSAO) based on sun/shadow/mode state ──────
function updateGroundAppearance() {
  if (!groundMesh) return;
  const hasShadowCaster  = sunLight !== null && shadowsEnabled;
  const useAmbientShadow = sunLight === null  && shadowsEnabled;
  const maxDim      = modelShadowDims?.maxDim ?? 100;
  const modeUsesSSAO = currentMode === 'arctic' || currentMode === 'rendered';

  groundMesh.material.dispose();

  if (currentMode === 'arctic') {
    groundMesh.material = new THREE.MeshStandardMaterial({
      color: 0xf5f5f5, roughness: 1.0, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2
    });
    groundMesh.receiveShadow = hasShadowCaster;
  } else if (hasShadowCaster) {
    // Sun ON + Shadows ON → clean directional shadow only
    groundMesh.material = new THREE.ShadowMaterial({ opacity: 0.35, transparent: true });
    groundMesh.receiveShadow = true;
    if (!modeUsesSSAO) ssaoPass.enabled = false;
  } else if (useAmbientShadow) {
    // Sun OFF + Shadows ON → subtle surface so SSAO contact shadows are visible
    groundMesh.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, opacity: 0.1, transparent: true,
      roughness: 1.0, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2
    });
    groundMesh.receiveShadow = false;
    if (!modeUsesSSAO) {
      ssaoPass.enabled = true;
      ssaoPass.kernelRadius = 16;
      ssaoPass.minDistance  = maxDim * 0.0005;
      ssaoPass.maxDistance  = maxDim * 0.05;
    }
  } else {
    // Shadows OFF → fully invisible ground
    groundMesh.material = new THREE.ShadowMaterial({ opacity: 0.35, transparent: true });
    groundMesh.receiveShadow = false;
    if (!modeUsesSSAO) ssaoPass.enabled = false;
  }
}

// ── Ground plane (feature 8) ───────────────────────────────────────────────
function addGroundPlane(box) {
  removeGroundPlane();
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const span   = Math.max(size.x, size.y) * 5;
  const geo    = new THREE.PlaneGeometry(span, span);
  groundMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  groundMesh.position.set(center.x, center.y, box.min.z - 0.001);
  groundMesh.name = 'ground-plane';
  scene.add(groundMesh);
  updateGroundAppearance();
}

function removeGroundPlane() {
  if (groundMesh) {
    groundMesh.geometry.dispose();
    groundMesh.material.dispose();
    scene.remove(groundMesh);
    groundMesh = null;
  }
}

// Dynamic loader for occt-import-js
async function loadOCCT() {
  if (window.occtimportjs) return window.occtimportjs;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/occt-import-js.js';
    script.onload = () => resolve(window.occtimportjs);
    script.onerror = () => reject(new Error('Failed to load occt-import-js script'));
    document.head.appendChild(script);
  });
}

async function loadCADFile(file, isSTEP, extractEdges) {
  try {
    showLoading(isSTEP ? 'Parsing STEP file…' : 'Parsing IGES file…');
    parsedLayers = [];
    renderLayerUI();
    modelInfoEl?.classList.add('hidden');

    setProgress(20);
    const occtimportjsFn = await loadOCCT();
    setProgress(40);
    
    const occt = await occtimportjsFn({
      locateFile: (name) => `https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/${name}`
    });
    setProgress(60);

    const arrayBuffer = await file.arrayBuffer();
    const u8Array = new Uint8Array(arrayBuffer);
    
    let result;
    if (isSTEP) {
      result = occt.ReadStepFile(u8Array);
    } else {
      result = occt.ReadIgesFile(u8Array);
    }

    if (!result || !result.success) {
      throw new Error(isSTEP ? 'STEP parsing failed' : 'IGES parsing failed');
    }

    setProgress(80);
    const group = new THREE.Group();
    group.name = file.name;

    for (let resultMesh of result.meshes) {
      const geometry = new THREE.BufferGeometry();
      
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(resultMesh.attributes.position.array, 3));
      
      if (resultMesh.attributes.normal) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(resultMesh.attributes.normal.array, 3));
      } else {
        geometry.computeVertexNormals();
      }
      
      if (resultMesh.index) {
        geometry.setIndex(new THREE.Uint32BufferAttribute(resultMesh.index.array, 1));
      }
      
      let color = 0xcccccc;
      if (resultMesh.color) {
        const r = Math.round(resultMesh.color[0] * 255);
        const g = Math.round(resultMesh.color[1] * 255);
        const b = Math.round(resultMesh.color[2] * 255);
        color = (r << 16) | (g << 8) | b;
      }
      
      const material = new THREE.MeshStandardMaterial({
        color: color,
        roughness: 0.5,
        metalness: 0.2
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = resultMesh.name || 'CAD_Mesh';
      mesh.userData = {
        attributes: {
          name: mesh.name,
          layerIndex: 0
        }
      };
      group.add(mesh);
    }

    clearCurrentModel();
    currentModel = group;
    scene.add(currentModel);
    emptyStateEl.classList.add('hidden');
    postProcessModel(currentModel, extractEdges);
    fitCameraToObject(currentModel, false);
    const box = new THREE.Box3().setFromObject(currentModel);
    setupModelShadowFrustum(box);
    if (groundEnabled) addGroundPlane(box);
    applyDisplayMode();
    setFileName(file.name);
    showModelInfo(currentModel, file.size);
    hideLoading();
  } catch (err) {
    console.error(err);
    alert((isSTEP ? 'STEP' : 'IGES') + ' 파일 로드 실패: ' + err.message);
    hideLoading();
    emptyStateEl.classList.remove('hidden');
  }
}

async function loadSTLFile(file, extractEdges) {
  try {
    showLoading('Parsing STL file…');
    parsedLayers = [];
    renderLayerUI();
    modelInfoEl?.classList.add('hidden');

    setProgress(30);
    const loader = new STLLoader();
    const arrayBuffer = await file.arrayBuffer();
    setProgress(70);
    
    const geometry = loader.parse(arrayBuffer);
    const material = new THREE.MeshStandardMaterial({
      color: 0x90caf9,
      roughness: 0.4,
      metalness: 0.2
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = file.name;
    mesh.userData = {
      attributes: {
        name: file.name,
        layerIndex: 0
      }
    };
    
    const group = new THREE.Group();
    group.name = file.name;
    group.add(mesh);

    clearCurrentModel();
    currentModel = group;
    scene.add(currentModel);
    emptyStateEl.classList.add('hidden');
    postProcessModel(currentModel, extractEdges);
    fitCameraToObject(currentModel, false);
    const box = new THREE.Box3().setFromObject(currentModel);
    setupModelShadowFrustum(box);
    if (groundEnabled) addGroundPlane(box);
    applyDisplayMode();
    setFileName(file.name);
    showModelInfo(currentModel, file.size);
    hideLoading();
  } catch (err) {
    console.error(err);
    alert('STL 파일 로드 실패: ' + err.message);
    hideLoading();
    emptyStateEl.classList.remove('hidden');
  }
}

async function load3MFFile(file, extractEdges) {
  try {
    showLoading('Parsing 3MF file…');
    parsedLayers = [];
    renderLayerUI();
    modelInfoEl?.classList.add('hidden');

    setProgress(30);
    const loader = new ThreeMFLoader();
    const arrayBuffer = await file.arrayBuffer();
    setProgress(70);
    
    const group = loader.parse(arrayBuffer);
    group.name = file.name;
    group.traverse(child => {
      if (child.isMesh) {
        if (!child.name) child.name = '3MF Mesh';
        child.userData = {
          attributes: {
            name: child.name,
            layerIndex: 0
          }
        };
      }
    });

    clearCurrentModel();
    currentModel = group;
    scene.add(currentModel);
    emptyStateEl.classList.add('hidden');
    postProcessModel(currentModel, extractEdges);
    fitCameraToObject(currentModel, false);
    const box = new THREE.Box3().setFromObject(currentModel);
    setupModelShadowFrustum(box);
    if (groundEnabled) addGroundPlane(box);
    applyDisplayMode();
    setFileName(file.name);
    showModelInfo(currentModel, file.size);
    hideLoading();
  } catch (err) {
    console.error(err);
    alert('3MF 파일 로드 실패: ' + err.message);
    hideLoading();
    emptyStateEl.classList.remove('hidden');
  }
}

// ── 3DM SubD Preprocessing & Annotation Extraction ──────────────────────
async function preprocess3dm(file, skipLayerParse) {
  parsedAnnotations = [];
  parsed3dmFileInfo = null;
  let fileData = file;

  if (!rhinoInstance) return file;

  try {
    loadingTextEl.textContent = 'Preprocessing model…';
    setProgress(10);
    const buf = await file.arrayBuffer();
    const doc = rhinoInstance.File3dm.fromByteArray(new Uint8Array(buf));
    if (!doc) return file;

    // Safe instanceof: avoids TypeError when class is undefined in WASM
    const safeInst = (obj, cls) => !!(cls && (obj instanceof cls));

    // ── 1. Layer / render settings ─────────────────────────────────────
    if (!skipLayerParse) {
      try {
        const rs = doc.settings()?.renderSettings;
        rhinoBackgroundColor = rs?.backgroundColor
          ? new THREE.Color(rs.backgroundColor.r / 255, rs.backgroundColor.g / 255, rs.backgroundColor.b / 255)
          : null;
        // Store background style for file_default mode ('SolidColor'|'Gradient'|'Environment'|null)
        fileDefaultBgStyle = rs?.backgroundStyle ?? null;
      } catch(e) { rhinoBackgroundColor = null; fileDefaultBgStyle = null; }

      // ── 3DM File info (author, dates, notes) ─────────────────────────
      try {
        const fi = doc.applicationDetails;
        if (fi) {
          const fmtDate = (d) => {
            if (!d) return null;
            try {
              // rhino3dm returns date as { year, month, day, hour, minute, second } or a JS Date
              if (typeof d.getFullYear === 'function') {
                return d.toLocaleDateString();
              }
              if (d.year) return `${d.year}-${String(d.month ?? 1).padStart(2,'0')}-${String(d.day ?? 1).padStart(2,'0')}`;
            } catch(de) {}
            return String(d);
          };
          parsed3dmFileInfo = {
            applicationName: fi.applicationName || fi.ProductName || null,
            createdBy:       fi.createdBy       || fi.CreatedBy   || null,
            created:         fmtDate(fi.created  || fi.Created)   || null,
            lastEditedBy:    fi.lastEditedBy    || fi.LastEditedBy|| null,
            lastEdited:      fmtDate(fi.lastEdited || fi.LastEdited) || null,
            notes:           doc.notes          || doc.Notes      || null
          };
          // Remove null entries
          Object.keys(parsed3dmFileInfo).forEach(k => { if (!parsed3dmFileInfo[k]) delete parsed3dmFileInfo[k]; });
          if (Object.keys(parsed3dmFileInfo).length === 0) parsed3dmFileInfo = null;
          console.log('[pre] 3DM file info:', parsed3dmFileInfo);
        }
      } catch(fe) { console.warn('[pre] file info err:', fe); }

      parsedLayers = [];
      try {
        const layers = doc.layers();
        for (let i = 0; i < layers.count; i++) {
          const l = layers.get(i);
          parsedLayers.push({
            index:            l.layerIndex ?? i,
            // fullPath = "Parent::Child" format in rhino3dm.js; fall back to .name
            name:             (l.fullPath && l.fullPath.trim()) ? l.fullPath.trim() : (l.name || `Layer ${i}`),
            color:            l.color,
            visible:          l.visible,
            // parentLayerIndex is -1 when no parent; some WASM builds return undefined
            parentLayerIndex: (typeof l.parentLayerIndex === 'number' && l.parentLayerIndex >= 0)
                              ? l.parentLayerIndex : -1
          });
          l.delete();
        }
      } catch(e) { console.warn('[pre] layer parse err:', e); }
      renderLayerUI();

      parsedNamedViews = [];
      try {
        const views = doc.views();
        for (let i = 0; i < views.count; i++) {
          const v = views.get(i);
          const loc = v.cameraLocation;
          const up = v.cameraUp;
          const target = v.cameraTarget;
          parsedNamedViews.push({
            name: v.name || `Named View ${i}`,
            position: [loc.x ?? loc[0] ?? 0, loc.y ?? loc[1] ?? 0, loc.z ?? loc[2] ?? 0],
            up: [up.x ?? up[0] ?? 0, up.y ?? up[1] ?? 1, up.z ?? up[2] ?? 0],
            target: [target.x ?? target[0] ?? 0, target.y ?? target[1] ?? 0, target.z ?? target[2] ?? 0]
          });
          v.delete();
        }
        views.delete();
      } catch(e) { console.warn('[pre] named views parse err:', e); }
    } else {
      parsedLayers = [];
      renderLayerUI();
      parsedNamedViews = [];
    }

    // ── 2. Build a clean new document (guarantees SubD removal) ─────────
    // We CANNOT reliably delete objects from a File3dm table in rhino3dm WASM,
    // so instead we rebuild the document from scratch, copying all safe objects.
    const cleanDoc = new rhinoInstance.File3dm();

    // Copy layers into cleanDoc so layer indices still match
    try {
      const srcLayers = doc.layers();
      for (let i = 0; i < srcLayers.count; i++) {
        const l = srcLayers.get(i);
        try { cleanDoc.layers().add(l.name, l.color); } catch(e) {}
        l.delete();
      }
    } catch(e) { console.warn('[pre] layer copy err:', e); }

    const objects = doc.objects();
    const count   = objects.count;
    let hasSubD       = false;
    let hasAnnotation = false;

    for (let i = 0; i < count; i++) {
      let modelObj = null, geom = null, attr = null;
      try {
        modelObj = objects.get(i);
        if (!modelObj) continue;
        geom = modelObj.geometry();
        attr = modelObj.attributes();
        if (!geom) continue;

        const geomName = geom.constructor.name;

        // ── A. SubD → convert to Mesh ─────────────────────────────────
        if (safeInst(geom, rhinoInstance.SubD) || geomName === 'SubD') {
          hasSubD = true;
          try {
            let meshGeom = null;
            let tempSubd = geom.duplicate();
            try {
              // Subdivide 3 times for a smooth representation using proper rhino3dm API (expects 1 argument: level)
              tempSubd.subdivide(3);
              meshGeom = rhinoInstance.Mesh.createFromSubDControlNet(tempSubd);
              if (meshGeom) console.log('[pre] SubD subdivided (3 levels) and meshed successfully ✓');
            } catch(subdErr) {
              console.warn('[pre] SubD subdivision failed, falling back to control net:', subdErr.message);
              meshGeom = rhinoInstance.Mesh.createFromSubDControlNet(geom);
            }
            if (tempSubd) tempSubd.delete();

            if (meshGeom) {
              attr ? cleanDoc.objects().addMesh(meshGeom, attr)
                   : cleanDoc.objects().addMesh(meshGeom);
              meshGeom.delete();
            } else {
              console.warn('[pre] SubD: all meshing methods failed — object dropped');
            }
          } catch(e) { console.warn('[pre] SubD conversion err:', e.message); }
          // Original SubD NOT added to cleanDoc → effectively removed


        // ── B. TextDot (billboard annotation) ─────────────────────────
        } else if (safeInst(geom, rhinoInstance.TextDot) || geomName === 'TextDot') {
          hasAnnotation = true;
          try {
            const textVal = typeof geom.text === 'string' ? geom.text : '';
            let origin = [0, 0, 0];
            try {
              const bbox = geom.getBoundingBox();
              if (bbox && bbox.isValid) {
                origin = [bbox.center[0], bbox.center[1], bbox.center[2]];
              }
            } catch(e) {}
            try {
              if (geom.point) {
                const pt = geom.point;
                origin = [pt.x ?? pt[0] ?? origin[0], pt.y ?? pt[1] ?? origin[1], pt.z ?? pt[2] ?? origin[2]];
              }
            } catch(ptErr) {}
            parsedAnnotations.push({ type: 'TextDot', text: textVal, position: origin, layerIndex: attr?.layerIndex ?? 0 });
            console.log('[pre] TextDot:', textVal, origin);
          } catch(e) { console.warn('[pre] TextDot err:', e.message); }
          // TextDot NOT added to cleanDoc (rendered as sprite separately)

        // ── C. Text / Dimension / Leader / any AnnotationBase subclass ─
        // rhinoInstance.TextEntity === undefined  →  use geomName only!
        // rhinoInstance.Dimension  === undefined  →  use geomName only!
        } else if (
          safeInst(geom, rhinoInstance.AnnotationBase) ||
          geomName === 'TextEntity' || geomName === 'Text' ||
          geomName === 'Dimension'  || geomName.includes('Dimension') ||
          geomName === 'Leader'     || geomName.includes('Annotation')
        ) {
          hasAnnotation = true;
          try {
            const getText = (g) => {
              if (!g) return '';
              try {
                if (typeof g.plainText === 'string') return g.plainText;
                if (typeof g.plainText === 'function') { try { return g.plainText(); } catch(e) {} }
                if (typeof g.text === 'string') return g.text;
                if (typeof g.text === 'function') { try { return g.text(); } catch(e) {} }
                if (typeof g.richText === 'string') return g.richText;
                if (typeof g.richText === 'function') { try { return g.richText(); } catch(e) {} }
                if (typeof g.numericValue === 'number') return g.numericValue.toFixed(2);
                if (typeof g.numericValue === 'function') { try { return g.numericValue().toFixed(2); } catch(e) {} }
              } catch(getTextErr) {}
              return '';
            };
            const getPt = (val, def) => {
              if (!val) return def;
              if (Array.isArray(val)) return [val[0] ?? def[0], val[1] ?? def[1], val[2] ?? def[2]];
              return [val.x ?? val[0] ?? def[0], val.y ?? val[1] ?? def[1], val.z ?? val[2] ?? def[2]];
            };

            let textVal = getText(geom);
            if (!textVal || textVal.trim() === '') {
              textVal = geomName; // fallback name
            }

            let origin = [0,0,0], xAxis = [1,0,0], yAxis = [0,1,0], zAxis = [0,0,1];
            try {
              const bbox = geom.getBoundingBox();
              if (bbox && bbox.isValid) {
                origin = [bbox.center[0], bbox.center[1], bbox.center[2]];
              }
            } catch (bboxErr) {
              console.warn('[pre] Annotation bounding box failed:', bboxErr.message);
            }
            
            let pln = null;
            try {
              pln = geom.plane;
            } catch (plnErr) {
              console.warn('[pre] Annotation plane access failed:', plnErr.message);
            }
            
            let loc = null;
            if (!pln) {
              try {
                loc = geom.location;
              } catch (locErr) {
                console.warn('[pre] Annotation location access failed:', locErr.message);
              }
            }

            if (pln) {
              try { origin = getPt(pln.origin, origin); } catch(e) {}
              try { xAxis  = getPt(pln.xAxis, xAxis); } catch(e) {}
              try { yAxis  = getPt(pln.yAxis, yAxis); } catch(e) {}
              try { zAxis  = getPt(pln.zAxis, zAxis); } catch(e) {}
            } else if (loc) {
              try { origin = getPt(loc, origin); } catch(e) {}
            }
            // Try to extract dimension endpoints for LinearDimension
            let pt1 = null, pt2 = null;
            if (geomName.includes('Dimension')) {
              const tryPt = (g, ...props) => {
                for (const p of props) {
                  try {
                    const v = g[p];
                    if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
                  } catch(e) {}
                }
                return null;
              };
              pt1 = tryPt(geom, 'defPt1', 'point1', 'startPoint', 'arrowPt1');
              pt2 = tryPt(geom, 'defPt2', 'point2', 'endPoint',   'arrowPt2');
            }
            parsedAnnotations.push({ type: 'Text', geomType: geomName, text: textVal, position: origin, xAxis, yAxis, zAxis, pt1, pt2, layerIndex: attr?.layerIndex ?? 0 });
            console.log('[pre] Annotation', geomName, ':', textVal, origin);
          } catch(e) { console.warn('[pre] Annotation err:', e.message); }
          // Annotation NOT added to cleanDoc (rendered as plane mesh separately)

        // ── D. All other geometry → copy to cleanDoc as-is ─────────────
        } else {
          try {
            attr ? cleanDoc.objects().add(geom, attr)
                 : cleanDoc.objects().add(geom);
          } catch(e) { console.warn('[pre] add', geomName, 'err:', e.message); }
        }

      } catch(objErr) {
        console.warn('[pre] object', i, 'err:', objErr.message);
      } finally {
        try { if (geom)     geom.delete();     } catch(e) {}
        try { if (attr)     attr.delete();     } catch(e) {}
        try { if (modelObj) modelObj.delete(); } catch(e) {}
      }
    }

    // ── 3. Export clean doc or pass through original ─────────────────────
    if (hasSubD || hasAnnotation) {
      try {
        const newBytes = cleanDoc.toByteArray();
        fileData = new Blob([newBytes], { type: 'application/octet-stream' });
        console.log(`[pre] clean doc ready — SubD:${hasSubD} annotations:${parsedAnnotations.length}`);
      } catch(e) {
        console.error('[pre] export failed:', e);
        // fall back to original file
      }
    }
    // else: no changes needed — return original file as-is (faster)

    try { cleanDoc.delete(); } catch(e) {}
    try { doc.delete();      } catch(e) {}

  } catch (err) {
    console.error('[pre] outer error:', err);
  }

  return fileData;
}

// ── Annotation Drawing Helpers ──────────────────────────────────────────────
// Safe rounded rectangle drawing helper for HTML Canvas (compatible with older Android WebViews)
function drawRoundedRect(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }
}

function createAnnotationSprites() {
  if (annotationGroup) {
    if (annotationGroup.parent) {
      annotationGroup.parent.remove(annotationGroup);
    } else {
      scene.remove(annotationGroup);
    }
    annotationGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    annotationGroup = null;
  }

  if (!parsedAnnotations.length) return;

  // Calculate text scale based on current model bounding box
  const box = new THREE.Box3().setFromObject(currentModel);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 100;
  const textHeight = Math.max(maxDim * 0.025, 0.5);  // min 0.5 world units

  annotationGroup = new THREE.Group();
  annotationGroup.name = 'annotations-group';

  parsedAnnotations.forEach(ann => {
    try {
      const layer = parsedLayers.find(l => l.index === ann.layerIndex);
      const isVisible = layer ? layer.visible : true;
      let color = new THREE.Color(0xffffff);
      if (layer && layer.color) {
        color = new THREE.Color(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255);
      }

      let obj3d = null;
      const textVal = String(ann.text || '');
      const pos = ann.position || [0, 0, 0];

      if (ann.type === 'TextDot') {
        obj3d = makeTextDotSprite(textVal, color, textHeight);
        if (obj3d) {
          obj3d.position.set(pos[0], pos[1], pos[2]);
        }
      } else if (ann.geomType && (ann.geomType.includes('Dimension') || ann.geomType === 'Leader')) {
        // Dimension: show with ruler icon prefix and dimension-specific style
        obj3d = makeDimensionSprite(textVal, color, ann, textHeight);
      } else {
        // TextEntity and other text annotations
        obj3d = makeText3DPlaneMesh(textVal, color, ann, textHeight);
      }

      if (obj3d) {
        obj3d.userData = { layerIndex: ann.layerIndex };
        obj3d.visible = isVisible && (document.getElementById('chk-annotations-panel')?.checked ?? true);
        annotationGroup.add(obj3d);
      }
    } catch(err) {
      console.warn('[render] Failed to render individual annotation:', ann, err);
    }
  });

  if (currentModel) {
    currentModel.add(annotationGroup);
  } else {
    scene.add(annotationGroup);
  }
}

function makeTextDotSprite(text, layerColor, baseHeight) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const fontSize = 32;
  ctx.font = `600 ${fontSize}px 'Inter', -apple-system, sans-serif`;

  const textWidth = ctx.measureText(text).width;
  const paddingX = 24;
  const paddingY = 16;

  const canvasWidth = textWidth + paddingX * 2;
  const canvasHeight = fontSize + paddingY * 2;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  ctx.font = `600 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const radius = canvasHeight / 2;
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvasWidth, canvasHeight, radius);
  ctx.fillStyle = 'rgba(24, 24, 28, 0.88)';
  ctx.fill();

  ctx.lineWidth = 4;
  ctx.strokeStyle = `#${layerColor.getHexString()}`;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false
  });

  const sprite = new THREE.Sprite(material);

  // Scale sprite so its height equals baseHeight
  const aspect = canvasWidth / canvasHeight;
  sprite.scale.set(baseHeight * aspect, baseHeight, 1);

  return sprite;
}

function makeText3DPlaneMesh(text, layerColor, ann, baseHeight) {
  // Plain text with very subtle dark background — no border, just text
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const fontSize = 44;
  const font = `500 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.font = font;
  const textWidth = ctx.measureText(text).width;

  const padX = 14;
  const padY = 10;
  const canvasWidth  = Math.ceil(textWidth + padX * 2);
  const canvasHeight = Math.ceil(fontSize  + padY * 2);

  canvas.width  = canvasWidth;
  canvas.height = canvasHeight;

  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Very subtle semi-transparent background for legibility on any scene color
  const r = canvasHeight * 0.45;
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvasWidth, canvasHeight, r);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.fill();

  // White text with thin stroke for maximum legibility
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: true, depthWrite: false
  });

  const sprite = new THREE.Sprite(material);
  const aspect = canvasWidth / canvasHeight;
  sprite.scale.set(baseHeight * aspect * 1.1, baseHeight * 1.1, 1);

  const pos = ann.position || [0, 0, 0];
  sprite.position.set(pos[0], pos[1], pos[2]);
  return sprite;
}

// Dimension: build proper linear dimension geometry with extension lines, arrows, and text label
function makeDimensionSprite(text, layerColor, ann, baseHeight) {
  const group = new THREE.Group();
  const pos = ann.position || [0, 0, 0];

  // Dimension line color from layer
  const col = `#${layerColor.getHexString()}`;
  const lineColor = layerColor.clone();

  // ── Determine endpoints ──
  let p1, p2;
  if (ann.pt1 && ann.pt2) {
    p1 = new THREE.Vector3(...ann.pt1);
    p2 = new THREE.Vector3(...ann.pt2);
  } else {
    // Fallback: derive from origin + xAxis
    const origin  = new THREE.Vector3(...pos);
    const xDir    = new THREE.Vector3(...(ann.xAxis || [1, 0, 0])).normalize();
    const numVal  = parseFloat(text);
    const halfLen = (!isNaN(numVal) && numVal > 0) ? numVal * 0.5 : baseHeight * 3;
    p1 = origin.clone().addScaledVector(xDir, -halfLen);
    p2 = origin.clone().addScaledVector(xDir,  halfLen);
  }

  // Guard: if endpoints are the same, fall back to a simple label sprite
  if (p1.distanceTo(p2) < 1e-6) {
    const fallback = makeTextDotSprite(text, lineColor, baseHeight);
    if (fallback) fallback.position.set(pos[0], pos[1], pos[2]);
    return fallback;
  }

  const midPt  = p1.clone().add(p2).multiplyScalar(0.5);
  const dimDir = p2.clone().sub(p1).normalize();

  // Perpendicular direction (Y or Z, choose the one more perpendicular to dimDir)
  const worldUp = Math.abs(dimDir.dot(new THREE.Vector3(0, 1, 0))) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  let perpDir = new THREE.Vector3().crossVectors(dimDir, worldUp).normalize();
  if (perpDir.lengthSq() < 0.01) perpDir = new THREE.Vector3(0, 1, 0);

  const extLen    = baseHeight * 0.8;  // extension line length
  const extOffset = baseHeight * 0.15; // small gap from object
  const arrowSize = baseHeight * 0.35;

  // ── Line material ──
  const lineMat = new THREE.LineBasicMaterial({
    color: lineColor, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9
  });

  const addLine = (...pts) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, lineMat);
    line.renderOrder = 997;
    group.add(line);
  };

  // Extension line 1: from p1 outward along perpDir
  const e1start = p1.clone().addScaledVector(perpDir,  extOffset);
  const e1end   = p1.clone().addScaledVector(perpDir,  extLen);
  addLine(e1start, e1end);

  // Extension line 2: from p2 outward
  const e2start = p2.clone().addScaledVector(perpDir,  extOffset);
  const e2end   = p2.clone().addScaledVector(perpDir,  extLen);
  addLine(e2start, e2end);

  // Dimension line (connecting extension line tips)
  const dimLineStart = p1.clone().addScaledVector(perpDir, extLen);
  const dimLineEnd   = p2.clone().addScaledVector(perpDir, extLen);
  addLine(dimLineStart, dimLineEnd);

  // ── Arrowheads (tick marks) ──
  const addArrow = (tip, dir, size) => {
    const side = new THREE.Vector3().crossVectors(dir, perpDir).normalize();
    const pts = [
      tip.clone().addScaledVector(dir.clone().negate(), size).addScaledVector(side,  size * 0.4),
      tip.clone(),
      tip.clone().addScaledVector(dir.clone().negate(), size).addScaledVector(side, -size * 0.4)
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const arrow = new THREE.Line(geo, lineMat);
    arrow.renderOrder = 997;
    group.add(arrow);
  };
  addArrow(dimLineStart, dimDir.clone().negate(), arrowSize);
  addArrow(dimLineEnd,   dimDir.clone(),          arrowSize);

  // ── Text label sprite ──
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 40;
  const font = `700 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const padX = 16, padY = 10;
  canvas.width  = Math.ceil(tw + padX * 2);
  canvas.height = Math.ceil(fontSize + padY * 2);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Background pill
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, canvas.height / 2);
  ctx.fillStyle = 'rgba(10, 16, 32, 0.82)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.renderOrder = 998;
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(baseHeight * aspect * 1.1, baseHeight * 1.1, 1);
  // Position text above dimension line at midpoint
  sprite.position.copy(midPt.clone().addScaledVector(perpDir, extLen + baseHeight * 0.7));
  group.add(sprite);

  group.position.set(0, 0, 0);
  return group;
}

// ── Dynamic Settings Reset Helper ──────────────────────────────────────────
function resetSettingsToDefault() {
  currentMode = 'shaded';
  shadowsEnabled = false;
  groundEnabled = false;
  selectedObjects = [];
  hiddenObjects.clear();
  
  // Clear measurements
  clearMeasurements();
  
  // Clear selection
  clearSelection();
  
  // Sync dropdown UI
  document.querySelectorAll('#mode-dropdown .dropdown-item').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === 'shaded');
  });

  const setCheck = (id, val) => {
    const el = document.getElementById(id);
    if (el) {
      el.checked = val;
      el.dispatchEvent(new Event('change'));
    }
  };
  
  // Reset checkboxes
  setCheck('chk-edges-panel', true);
  setCheck('chk-annotations-panel', true);
  setCheck('chk-ground-panel', false);
  setCheck('chk-shadows-panel', false);
  setCheck('chk-sun-panel', false);
  setCheck('chk-clipping-enable', false);
  
  // Helper for range sliders
  const resetSlider = (id, valElId, val, formatType = 'float') => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      updateSliderFill(el);
      const valEl = document.getElementById(valElId);
      if (valEl) {
        if (formatType === 'percent') {
          valEl.textContent = Math.round(val * 100) + '%';
        } else if (formatType === 'degree') {
          valEl.textContent = Math.round(val) + '°';
        } else {
          valEl.textContent = parseFloat(val).toFixed(2);
        }
      }
      el.dispatchEvent(new Event('input'));
    }
  };
  
  // Reset range sliders
  resetSlider('sl-ambient-panel', 'sl-ambient-val', 0.35, 'float');
  resetSlider('sl-sun-azimuth', 'sl-sun-azimuth-val', 135, 'degree');
  resetSlider('sl-sun-elevation', 'sl-sun-elevation-val', 45, 'degree');
  resetSlider('sl-camera-fov', 'sl-camera-fov-val', 45, 'degree');
  resetSlider('sl-damping-panel', 'sl-damping-val', 0.5, 'float');
  resetSlider('bg-radial-spread', 'bg-radial-spread-val', 0.5, 'percent');
  
  // Reset turntable if active
  const ttToggleBtn = document.getElementById('btn-tt-toggle');
  if (ttToggleBtn && ttToggleBtn.classList.contains('active')) {
    ttToggleBtn.click();
  }
  const springSlider = document.getElementById('tt-spring-slider');
  if (springSlider) {
    springSlider.value = 0;
    updateSliderFill(springSlider);
    const springVal = document.getElementById('tt-spring-val');
    if (springVal) springVal.textContent = '0.0';
  }
  
  // Reset color grading
  document.getElementById('btn-cg-reset')?.click();
  
  // Reset background colors to standard defaults
  const resetBgColor = (id, swatchId, val) => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      const swatch = document.getElementById(swatchId);
      if (swatch) swatch.style.background = val;
      el.dispatchEvent(new Event('input'));
    }
  };
  resetBgColor('bg-panel-c1', 'bg-panel-swatch-c1', '#2a2b2f');
  resetBgColor('bg-panel-c2', 'bg-panel-swatch-c2', '#18181c');
  resetBgColor('bg-panel-c3', 'bg-panel-swatch-c3', '#2d3748');
  resetBgColor('bg-panel-c4', 'bg-panel-swatch-c4', '#1a202c');
  
  // Reset background type
  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) {
    bgSel.value = 'solid';
    bgSel.dispatchEvent(new Event('change'));
  }

  // Reset camera projection to perspective
  switchToPersp();
}

// ── File upload ────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file) return;

  resetSettingsToDefault();

  showLoading('Reading file…');
  emptyStateEl.classList.add('hidden');

  const fileName  = file.name.toLowerCase();
  const isGLTF    = fileName.endsWith('.glb') || fileName.endsWith('.gltf');
  const extractEdges = document.getElementById('chk-edges-panel')?.checked ?? true;

  if (isGLTF) {
    parsedLayers = [];
    renderLayerUI();
    modelInfoEl?.classList.add('hidden');
    const url = URL.createObjectURL(file);
    gltfLoader.load(url,
      gltf => {
        URL.revokeObjectURL(url);
        clearCurrentModel();
        currentModel = gltf.scene;
        scene.add(currentModel);
        emptyStateEl.classList.add('hidden');
        postProcessModel(currentModel, extractEdges);
        fitCameraToObject(currentModel, false);
        const box = new THREE.Box3().setFromObject(currentModel);
        setupModelShadowFrustum(box);
        if (groundEnabled) addGroundPlane(box);
        applyDisplayMode();
        setFileName(file.name);
        showModelInfo(currentModel, file.size);
        hideLoading();
      },
      xhr => { if (xhr.total > 0) setProgress((xhr.loaded / xhr.total) * 90); },
      err => {
        console.error(err);
        alert('GLTF 파일 로드 실패');
        hideLoading();
        URL.revokeObjectURL(url);
        emptyStateEl.classList.remove('hidden');
      }
    );
    return;
  }

  if (fileName.endsWith('.stl')) {
    await loadSTLFile(file, extractEdges);
    return;
  }
  if (fileName.endsWith('.3mf')) {
    await load3MFFile(file, extractEdges);
    return;
  }
  if (fileName.endsWith('.stp') || fileName.endsWith('.step')) {
    await loadCADFile(file, true, extractEdges);
    return;
  }
  if (fileName.endsWith('.iges') || fileName.endsWith('.igs')) {
    await loadCADFile(file, false, extractEdges);
    return;
  }

  // ── 3DM ────────────────────────────────────────────────────────────────

  // Large file warning (feature 5)
  let skipLayerParse = false;
  if (file.size > 50 * 1024 * 1024) {
    const fullLoad = window.confirm(
      `큰 파일 (${(file.size / 1048576).toFixed(0)} MB)\n\n` +
      `[확인]  전체 로드 (레이어 포함, 느림)\n` +
      `[취소]  빠른 로드 (레이어 없음)`
    );
    skipLayerParse = !fullLoad;
  }

  // Stage 1+2: Preprocess (SubD → Mesh, extract annotations) then load with Rhino3dmLoader
  // preprocess3dm also extracts layer info and annotations in one pass
  const processedBlob = await preprocess3dm(file, skipLayerParse);

  loadingTextEl.textContent = 'Loading geometry…';
  setProgress(25);
  const url = URL.createObjectURL(processedBlob);

  rhinoLoader.load(
    url,
    object => {
      try {
        URL.revokeObjectURL(url);
        clearCurrentModel();
        currentModel = object;
        scene.add(currentModel);
        emptyStateEl.classList.add('hidden');
        postProcessModel(currentModel, extractEdges);
        applyLayerColorsToModel(currentModel);
        fitCameraToObject(currentModel, false);
        const box = new THREE.Box3().setFromObject(currentModel);
        setupModelShadowFrustum(box);
        if (groundEnabled) addGroundPlane(box);
        applyFileBackground();   // set bg type + colour from file's renderSettings
        applyDisplayMode();
        // Render annotations extracted during preprocessing
        createAnnotationSprites();
        renderNamedViewsUI();
        setFileName(file.name);
        showModelInfo(currentModel, file.size);
      } catch (postErr) {
        console.error('[load] post-processing crash:', postErr);
        alert('3DM 파일 처리 중 오류가 발생했습니다: ' + postErr.message);
        emptyStateEl.classList.remove('hidden');
      } finally {
        hideLoading();
      }
    },
    xhr => { if (xhr.total > 0) setProgress(25 + (xhr.loaded / xhr.total) * 70); },
    err => {
      console.error(err);
      alert('3DM 파일 로드 실패.\n라이노에서 "렌더링 메쉬만 저장" 옵션으로 파일 크기를 줄여 보세요.');
      hideLoading();
      URL.revokeObjectURL(url);
      emptyStateEl.classList.remove('hidden');
    }
  );
}

// Called after every model load to set up originalMaterial, edges, BVH, shadows
function postProcessModel(model, addEdgesFlag) {
  model.traverse(child => {
    if (!child.isMesh) return;
    if (child.material?.color) {
      const mc = child.material.color;
      if (mc.r < 0.02 && mc.g < 0.02 && mc.b < 0.02) child.material.color.setHex(0xffffff);
    }
    // Save the loader's original material colour BEFORE applyLayerColorsToModel overwrites it.
    // This is the Rhino material diffuse colour used in Rendered mode.
    if (child.material?.color) child.userData.materialColor = child.material.color.clone();
    fixMaterialTransparency(child.material);          // feature 9
    child.userData.originalMaterial = child.material.clone();
    fixMaterialTransparency(child.userData.originalMaterial);

    const attrs = child.userData.attributes || {};
    const layer = parsedLayers.find(l => l.index === attrs.layerIndex);

    // Determine if color source is ByLayer
    // Rhino objectColorSource: 0=ByLayer, 1=ByObject, 2=ByParent, 3=ByDisplay
    const colorSource = attrs.objectColorSource;
    const isByLayer = (colorSource === 0 || colorSource === undefined || colorSource === null);
    child.userData.isColorByLayer = isByLayer;
    child.userData.layerColor = layer ? new THREE.Color(layer.color.r/255, layer.color.g/255, layer.color.b/255) : null;

    // Initialize shadedMaterial based on Object color or Layer color
    const shadedColor = new THREE.Color();
    if (isByLayer && layer) {
      shadedColor.setRGB(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255);
    } else if (attrs.objectColor) {
      shadedColor.setRGB(attrs.objectColor.r / 255, attrs.objectColor.g / 255, attrs.objectColor.b / 255);
    } else if (layer) {
      shadedColor.setRGB(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255);
    } else if (child.material?.color) {
      shadedColor.copy(child.material.color);
    } else {
      shadedColor.setHex(0xffffff);
    }
    // Replace near-black colors with white for visibility
    if (shadedColor.r < 0.02 && shadedColor.g < 0.02 && shadedColor.b < 0.02) {
      shadedColor.setHex(0xffffff);
    }

    child.userData.shadedMaterial = new THREE.MeshStandardMaterial({
      color: shadedColor.clone(),
      roughness: 0.8,
      metalness: 0.0,
      transparent: !!child.material.transparent,
      opacity: child.material.opacity !== undefined ? child.material.opacity : 1.0,
      depthWrite: child.material.depthWrite !== undefined ? child.material.depthWrite : true
    });
    fixMaterialTransparency(child.userData.shadedMaterial);

    // Initialize renderedMaterial
    child.userData.renderedMaterial = child.material.clone();
    fixMaterialTransparency(child.userData.renderedMaterial);

    if (addEdgesFlag && child.geometry) addEdges(child);
    if (bvhReady && child.geometry) child.geometry.computeBoundsTree();
    child.castShadow   = shadowsEnabled;              // feature 7
    child.receiveShadow = shadowsEnabled;
  });
}

// Feature 9: fix transparent materials that Rhino3dmLoader may not mark correctly
function fixMaterialTransparency(mat) {
  if (!mat) return;
  if (mat.opacity !== undefined && mat.opacity < 0.99) {
    mat.transparent = true;
    mat.depthWrite  = false;
  }
}

// Feature 3: apply layer colors to "by layer" objects
function applyLayerColorsToModel(model) {
  if (!parsedLayers.length) return;
  model.traverse(child => {
    if (!child.isMesh || !child.userData.originalMaterial) return;
    const attrs = child.userData.attributes || {};
    if (child.userData.isColorByLayer) {
      const layer = parsedLayers.find(l => l.index === attrs.layerIndex);
      if (layer) {
        const { r, g, b } = layer.color;
        const col = new THREE.Color(r / 255, g / 255, b / 255);
        if (col.r < 0.02 && col.g < 0.02 && col.b < 0.02) col.setHex(0xffffff);
        child.userData.originalMaterial.color.copy(col);
        if (child.userData.shadedMaterial) {
          child.userData.shadedMaterial.color.copy(col);
        }
      }
    }
  });
}

function addEdges(mesh) {
  const eg   = new THREE.EdgesGeometry(mesh.geometry, 20);
  const line = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x000000 }));
  line.name = 'rhino-edges';
  mesh.add(line);
}

function clearCurrentModel() {
  if (!currentModel) return;
  clearSelection();
  clearTechnicalOutlines();
  currentModel.traverse(child => {
    if (child.name === 'rhino-outline') return;
    if (child.isMesh) {
      if (bvhReady) child.geometry?.disposeBoundsTree?.();
      child.geometry?.dispose();
      child.material?.dispose();
      child.userData.originalMaterial?.dispose();
      child.userData.shadedMaterial?.dispose();
      child.userData.renderedMaterial?.dispose();
      child.userData.customMaterial = null;
    }
    if (child.name === 'rhino-edges') {
      child.geometry?.dispose();
      child.material?.dispose();
    }
  });
  scene.remove(currentModel);
  currentModel = null;
  removeGroundPlane();
  clearSelection();
  hiddenObjects = new Set();
  // Remove annotation group
  if (annotationGroup) {
    annotationGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    });
    if (annotationGroup.parent) {
      annotationGroup.parent.remove(annotationGroup);
    } else {
      scene.remove(annotationGroup);
    }
    annotationGroup = null;
  }
  parsedAnnotations = [];
  parsed3dmFileInfo = null;
  rhinoBackgroundColor = null;
  fileDefaultBgStyle = null;
  // Reset bg-type-select to solid on model close
  const bgSelReset = document.getElementById('bg-type-select');
  if (bgSelReset) bgSelReset.value = 'solid';
  if (modelInfoEl) {
    modelInfoEl.innerHTML = '';
    modelInfoEl.textContent = 'No model loaded.';
    modelInfoEl.classList.remove('hidden');
  }
  setFileName('Open a 3DM file…');
  fileNameEl.classList.remove('loaded');
  emptyStateEl.classList.remove('hidden');
  scene.background = null; // empty state로 돌아갈 때 투명화
}

// ── Camera fit ─────────────────────────────────────────────────────────────
// animate=true  → smooth eased transition (buttons)
// animate=false → instant snap (initial model load, view preset)
function fitCameraToBox(box, preserveView = false, animate = false) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov    = camera.isPerspectiveCamera ? camera.fov : 45;
  const dist   = Math.abs(maxDim / 2 / Math.tan(fov * Math.PI / 360)) * 1.5;

  // Update near/far based on model scale so large buildings (mm units) are visible
  const minNear = Math.max(0.001, dist * 0.0005);
  const maxFar  = dist * 50;
  perspCamera.near = minNear;
  perspCamera.far  = maxFar;
  perspCamera.updateProjectionMatrix();
  if (orthoCamera) {
    orthoCamera.near = -maxFar;
    orthoCamera.far  =  maxFar;
    orthoCamera.updateProjectionMatrix();
  }

  let targetPos;
  if (preserveView) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    targetPos = center.clone().addScaledVector(dir, -dist);
  } else {
    targetPos = new THREE.Vector3(
      center.x + dist * 0.7,
      center.y - dist * 0.7,
      center.z + dist * 0.7
    );
  }

  if (animate) {
    triggerCameraTransition(targetPos.toArray(), center.toArray(), camera.up.toArray());
  } else {
    camera.position.copy(targetPos);
    if (!preserveView) camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
  }
}

function fitCameraToObject(obj, preserve, animate = false) {
  fitCameraToBox(new THREE.Box3().setFromObject(obj), preserve, animate);
}

function fitCameraToSelected() {
  if (!selectedObjects.length) return;
  const box = new THREE.Box3();
  selectedObjects.forEach(o => box.expandByObject(o));
  fitCameraToBox(box, true, true);   // always animated
}

// ── Display modes ──────────────────────────────────────────────────────────
function clearTechnicalOutlines() {
  if (!currentModel) return;
  currentModel.traverse(child => {
    if (!child.isMesh) return;
    const outline = child.getObjectByName('rhino-outline');
    if (outline) { outline.material.dispose(); child.remove(outline); }
  });
}

function addTechnicalOutline(mesh) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide,
    depthWrite: false  // outline must not pollute the depth buffer
  });
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = 'rhino-outline';
  outline.renderOrder = 1;  // after depth masks, before edges
  outline.scale.setScalar(1.03);  // 3% 확대 → 굵은 실루엣
  mesh.add(outline);
}

function applyDisplayMode() {
  if (!currentModel) return;

  clearTechnicalOutlines();
  setupLights();

  // Dynamic Tone Mapping: ACESFilmic only in Rendered mode; NoToneMapping in others to prevent greyed out white backgrounds
  if (renderer) {
    if (currentMode === 'rendered') {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    } else {
      renderer.toneMapping = THREE.NoToneMapping;
    }
  }

  // Environment map (IBL) is always on — independent of background type.
  // Wireframe/Shaded/Technical/Arctic modes use pure direct lights, not IBL.
  if (currentMode === 'wireframe' || currentMode === 'technical' || currentMode === 'shaded' || currentMode === 'arctic') {
    scene.environment = null;
  } else {
    if (environmentMap) scene.environment = environmentMap;
  }
  ssaoPass.enabled  = false;

  // SSAO per mode with dynamic radius scaling based on model dimensions
  const maxDim = modelShadowDims ? modelShadowDims.maxDim : 100;
  switch (currentMode) {
    case 'arctic':
      ssaoPass.enabled = true; 
      ssaoPass.kernelRadius = 16;
      ssaoPass.minDistance = maxDim * 0.0005; // 0.05% of model size for contact detail
      ssaoPass.maxDistance = maxDim * 0.05;   // 5% of model size for soft ambient shadow
      break;
    case 'rendered':
      ssaoPass.enabled = true; 
      ssaoPass.kernelRadius = 12;
      ssaoPass.minDistance = maxDim * 0.0005;
      ssaoPass.maxDistance = maxDim * 0.03;   // 3% of model size for ambient shadow
      break;
  }

  applySceneBackground();
  // Mode-specific background overrides
  if (currentMode === 'technical') {
    scene.background = new THREE.Color(0xffffff);
  }

  updateGroundAppearance();

  const edgeOverlay = document.getElementById('chk-edges-panel')?.checked ?? true;

  // Per-mesh material
  currentModel.traverse(child => {
    if (!(child.isMesh && child.userData.originalMaterial)) return;
    if (child.name === 'rhino-outline') return;
    if (child.name === 'selection-outline') return;
    // Reset render order (will be overridden in technical mode)
    child.renderOrder = 0;
    const orig  = child.userData.originalMaterial;
    const edges = child.getObjectByName('rhino-edges');
    if (edges) edges.renderOrder = 0;

    switch (currentMode) {

      case 'wireframe':
        if (edgeOverlay) {
          // True wireframe: invisible solid + colored edge lines
          child.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
        } else {
          // Edges off in wireframe → fall back to solid shaded so model stays visible
          const base = child.userData.shadedMaterial || orig;
          const m = base.clone();
          m.polygonOffset = true;
          m.polygonOffsetFactor = 1;
          m.polygonOffsetUnits = 1;
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
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
        
        // Enforce standard matte shaded material properties
        m.roughness = 0.85;
        m.metalness = 0.05;

        const custom = child.userData.customMaterial;
        if (custom && custom.color !== undefined) {
          m.color?.set(custom.color);
        }
        // Also apply objectColorCustom if set (direct swatch override)
        if (child.userData.objectColorCustom !== undefined) {
          m.color?.set(child.userData.objectColorCustom);
        }
        m.needsUpdate = true;
        child.material = m;
        // Edge checkbox controls visibility in Shaded
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
        }
        break;
      }


      case 'arctic': {
        const m = new THREE.MeshStandardMaterial({
          color: 0xf0f0f0, // Pure neutral light grey / off-white (no warm tint)
          roughness: 0.9,
          metalness: 0.0
        });
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
        child.material = m;
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
        }
        break;
      }

      case 'rendered': {
        const base = child.userData.renderedMaterial || orig;
        const m = base.clone();
        // Restore the Rhino material's own diffuse colour if materialColor was saved
        if (child.userData.materialColor) {
          m.color.copy(child.userData.materialColor);
        }
        if (m.roughness !== undefined && m.roughness < 0.05) m.roughness = 0.4;
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
        m.envMap = environmentMap;
        m.envMapIntensity = 0.9;
        applyCustomToMaterial(m, child.userData.customMaterial);
        m.needsUpdate = true;
        child.material = m;
        scene.environment = environmentMap;
        // Edge checkbox controls visibility in Rendered
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
        }
        break;
      }

      case 'technical':
        child.renderOrder = 0;
        child.material = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          side: THREE.FrontSide,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
        });
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 2;
          edges.material.depthWrite = false;
        }
        // Silhouette outline is always shown in technical mode regardless of edge toggle
        addTechnicalOutline(child);
        break;
    }
  });
}

// ── Selection ──────────────────────────────────────────────────────────────
function onPointerDown(event) {
  if (!currentModel || selectMode === 'none') return;

  // Bypass mesh selection when clicking the clipping gumball
  if (clippingTransformControls && clippingTransformControls.visible && clippingTransformControls.object) {
    const tmpMouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(tmpMouse, camera);
    const gHits = raycaster.intersectObjects(clippingTransformControls.children, true);
    if (gHits.length > 0) return;
  }

  mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // Merge mesh and line/curve hits
  const allHits = raycaster.intersectObject(currentModel, true);
  const hit = allHits.find(i =>
    (i.object.isMesh || i.object.isLine || i.object.isLineSegments)
    && i.object.name !== 'rhino-edges'
    && i.object.name !== 'rhino-outline'
    && i.object.name !== 'selection-outline'
    && i.object.name !== 'ground-plane'
    && i.object.visible);

  const multi = selectMode === 'multi' || event.shiftKey || event.ctrlKey || event.metaKey;

  if (hit) {
    const obj = hit.object;
    if (multi) {
      const idx = selectedObjects.indexOf(obj);
      if (idx > -1) {
        selectedObjects.splice(idx, 1);
        clearSelectionOutline(obj);
      } else {
        selectedObjects.push(obj);
        addSelectionOutline(obj);
      }
    } else {
      clearSelection();
      selectedObjects.push(obj);
      addSelectionOutline(obj);
    }
  } else {
    clearSelection();
  }
  updatePropertiesPanel();
}

// ── Selection Outline (BackSide silhouette highlight) ──────────────────────
function addSelectionOutline(mesh) {
  clearSelectionOutline(mesh);

  // For lines/curves: overlay a bright blue line on top (no BackSide trick possible)
  if (mesh.isLine || mesh.isLineSegments) {
    const mat = new THREE.LineBasicMaterial({
      color: 0x22aaff,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9
    });
    const outline = mesh.isLineSegments
      ? new THREE.LineSegments(mesh.geometry, mat)
      : new THREE.Line(mesh.geometry, mat);
    outline.name = 'selection-outline';
    outline.renderOrder = 999;
    mesh.add(outline);
    return;
  }

  // BackSide silhouette: the front face (rendered normally) occludes the
  // back-side mesh except at geometry edges where it peeks out — giving a
  // thin rim outline without painting the whole object blue.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x22aaff,
    side: THREE.BackSide,
    depthTest: true,          // keep depth test so front face hides the interior
    depthWrite: false,
    transparent: true,
    opacity: 1.0
  });
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = 'selection-outline';
  outline.renderOrder = 999;

  // Scale 1.018 — just enough to peek past the front face at edges only.
  const s = 1.018;
  const bbox = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
  const center = bbox.getCenter(new THREE.Vector3());
  outline.position.copy(center.multiplyScalar(1 - s));
  outline.scale.setScalar(s);

  mesh.add(outline);
}

function clearSelectionOutline(mesh) {
  const existing = mesh.getObjectByName('selection-outline');
  if (existing) { existing.material.dispose(); mesh.remove(existing); }
}

function clearSelection() {
  selectedObjects.forEach(o => clearSelectionOutline(o));
  selectedObjects = [];
}

function updatePropertiesPanel() {
  const panel = document.getElementById('object-properties');
  if (!selectedObjects.length) { panel.classList.add('hidden'); return; }

  if (selectedObjects.length > 1) {
    document.getElementById('prop-content').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:8px 0">
        <b>${selectedObjects.length} objects selected</b><br><br>
        <div style="display:flex;gap:8px;justify-content:center">
          <button id="btn-clear-selection" class="text-btn">Clear</button>
          <button id="btn-hide-selected" class="text-btn">Hide</button>
        </div>
      </div>`;
    document.getElementById('btn-clear-selection').addEventListener('click', () => {
      clearSelection(); updatePropertiesPanel();
    });
    document.getElementById('btn-hide-selected').addEventListener('click', () => {
      selectedObjects.forEach(child => {
        child.visible = false;
        hiddenObjects.add(child);
      });
      clearSelection();
      document.getElementById('object-properties').classList.add('hidden');
    });
    panel.classList.remove('hidden');
    return;
  }

  const obj   = selectedObjects[0];
  const attrs = obj.userData.attributes || {};
  const layer = parsedLayers.find(l => l.index === attrs.layerIndex);

  // Compute current object color (for shaded mode swatch)
  const shadedMat = obj.userData.shadedMaterial || obj.userData.originalMaterial;
  const objColorCustom = obj.userData.objectColorCustom;
  // If ByLayer and no custom override, use layer color for the picker
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

  const isRendered = currentMode === 'rendered';
  const orig = isRendered ? (obj.userData.renderedMaterial || obj.userData.originalMaterial) : (obj.userData.shadedMaterial || obj.userData.originalMaterial);
  const custom  = obj.userData.customMaterial || {};
  const matColor     = custom.color      ?? ('#' + (orig?.color?.getHexString() ?? 'ffffff'));
  const matRoughness = custom.roughness  ?? (orig?.roughness ?? 0.5);
  const matMetalness = custom.metalness  ?? (orig?.metalness ?? 0.0);
  const matOpacity   = custom.opacity    ?? (orig?.opacity   ?? 1.0);
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
        <input type="color" id="prop-object-color" value="${objColorHex}">
      </div>
    </div>
    <div class="mat-divider"></div>
    <div class="mat-section-title">Material${hasCustom ? ' <span style="font-size:0.68rem;color:var(--accent)">(overridden)</span>' : ''} <span style="font-size:0.68rem;opacity:0.6">(Rendered)</span></div>
    <div class="mat-editor">
      <div class="mat-row">
        <span class="mat-label">Color</span>
        <input type="color" id="mat-color" value="${matColor}">
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

  // ByLayer toggle
  document.getElementById('prop-bylayer-toggle')?.addEventListener('change', e => {
    obj.userData.isColorByLayer = e.target.checked;
    const label = e.target.nextElementSibling;
    if (label) label.textContent = e.target.checked ? 'On' : 'Off';

    if (e.target.checked) {
      // Switch to layer color
      const layerForObj = parsedLayers.find(l => l.index === (obj.userData.attributes?.layerIndex));
      if (layerForObj) {
        const lc = new THREE.Color(layerForObj.color.r/255, layerForObj.color.g/255, layerForObj.color.b/255);
        if (lc.r < 0.02 && lc.g < 0.02 && lc.b < 0.02) lc.setHex(0xffffff);
        if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.copy(lc);
        obj.userData.objectColorCustom = undefined;
        // Update color picker to reflect layer color
        const picker = document.getElementById('prop-object-color');
        if (picker) picker.value = '#' + lc.getHexString();
      }
    } else {
      // Use stored custom color or fallback to current
      const current = '#' + (obj.userData.shadedMaterial?.color?.getHexString() || 'cccccc');
      obj.userData.objectColorCustom = current;
    }
    applyDisplayMode();
  });

  // Object Color picker — affects shaded material color
  document.getElementById('prop-object-color').addEventListener('input', e => {
    obj.userData.objectColorCustom = e.target.value;
    obj.userData.isColorByLayer = false;
    const toggle = document.getElementById('prop-bylayer-toggle');
    if (toggle) { toggle.checked = false; const lbl = toggle.nextElementSibling; if (lbl) lbl.textContent = 'Off'; }
    // Update shadedMaterial directly
    if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.set(e.target.value);
    applyDisplayMode();
  });

  document.getElementById('mat-color').addEventListener('input', e => {
    ensureCustomMaterial(obj);
    obj.userData.customMaterial.color = e.target.value;
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


  // Hide selected object button
  const hideBtn = document.createElement('button');
  hideBtn.id = 'btn-hide-single';
  hideBtn.className = 'text-btn';
  hideBtn.style.cssText = 'grid-column:1/-1;font-size:0.74rem;margin-top:6px';
  hideBtn.textContent = 'Hide Object';
  hideBtn.addEventListener('click', () => {
    obj.visible = false;
    hiddenObjects.add(obj);
    clearSelection();
    document.getElementById('object-properties').classList.add('hidden');
  });
  document.getElementById('prop-content').appendChild(hideBtn);

  panel.classList.remove('hidden');
}

function ensureCustomMaterial(obj) {
  if (!obj.userData.customMaterial) {
    const isRendered = currentMode === 'rendered';
    const orig = isRendered ? (obj.userData.renderedMaterial || obj.userData.originalMaterial) : (obj.userData.shadedMaterial || obj.userData.originalMaterial);
    obj.userData.customMaterial = {
      color:     '#' + (orig?.color?.getHexString() ?? 'ffffff'),
      roughness: orig?.roughness ?? 0.5,
      metalness: orig?.metalness ?? 0.0,
      opacity:   orig?.opacity   ?? 1.0
    };
  }
}

function applyCustomToMaterial(mat, custom) {
  if (!custom || !mat) return;
  if (custom.color     !== undefined) mat.color?.set(custom.color);
  if (custom.roughness !== undefined && mat.roughness !== undefined) mat.roughness = custom.roughness;
  if (custom.metalness !== undefined && mat.metalness !== undefined) mat.metalness = custom.metalness;
  if (custom.opacity   !== undefined) {
    mat.opacity = custom.opacity;
    mat.transparent = custom.opacity < 0.999;
    mat.depthWrite  = custom.opacity >= 0.999;
  }
  mat.needsUpdate = true;
}

// ── Layer UI ───────────────────────────────────────────────────────────────
function renderLayerUI() {
  const list = document.getElementById('layer-list-panel') || document.getElementById('layer-list');
  if (!list) return;
  list.innerHTML = '';

  if (parsedLayers.length === 0) {
    list.innerHTML = '<span class="dropdown-empty-msg">No layers parsed</span>';
    return;
  }

  const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => {
    const hex = Math.min(255, Math.max(0, x)).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');

  // ── Build tree using parentLayerIndex (reliable; works even when names lack "::") ──
  // Each node: { layer, label, depth, children[] }
  const nodeByIndex = {};   // layerIndex → node
  const roots = [];

  // 1st pass: create all nodes
  parsedLayers.forEach(layer => {
    // Display label = last segment after "::" (or full name if no "::")
    const label = layer.name.includes('::')
      ? layer.name.split('::').pop()
      : layer.name;
    nodeByIndex[layer.index] = { layer, label, depth: 0, children: [] };
  });

  // 2nd pass: wire parent → child via parentLayerIndex
  parsedLayers.forEach(layer => {
    const node = nodeByIndex[layer.index];
    const parentIdx = layer.parentLayerIndex ?? -1;
    if (parentIdx >= 0 && nodeByIndex[parentIdx]) {
      nodeByIndex[parentIdx].children.push(node);
    } else {
      roots.push(node);
    }
  });

  // Fallback: if parentLayerIndex produced no hierarchy (all are roots),
  // try to infer parent-child from "::" in layer names  (e.g. "Layer 03::Default-0")
  if (roots.length === parsedLayers.length && parsedLayers.some(l => l.name.includes('::'))) {
    roots.length = 0;
    parsedLayers.forEach(l => { nodeByIndex[l.index].children = []; });

    // Build fullName → node map
    const nameToNode = {};
    parsedLayers.forEach(l => { nameToNode[l.name] = nodeByIndex[l.index]; });

    parsedLayers.forEach(layer => {
      const node = nodeByIndex[layer.index];
      const parts = layer.name.split('::');
      if (parts.length > 1) {
        const parentName = parts.slice(0, -1).join('::');
        const parentNode = nameToNode[parentName];
        if (parentNode && parentNode !== node) {
          parentNode.children.push(node);
          return;
        }
      }
      roots.push(node);
    });
  }

  // Export tree for cascade-visibility use outside renderLayerUI
  layerNodeByIndex = nodeByIndex;

  // 3rd pass: assign depth (BFS)
  const queue = roots.map(n => ({ node: n, depth: 0 }));
  while (queue.length) {
    const { node, depth } = queue.shift();
    node.depth = depth;
    node.children.forEach(c => queue.push({ node: c, depth: depth + 1 }));
  }

  // ── Render a single layer row + recurse into children ──
  function renderNode(node) {
    const { layer, label, depth, children } = node;
    const hexColor  = rgbToHex(layer.color.r, layer.color.g, layer.color.b);
    const visColor  = layer.visible ? 'var(--primary)' : 'var(--text-3)';
    const indentPx  = 8 + depth * 16;

    const div = document.createElement('div');
    div.className = 'layer-item';
    div.style.cssText = `
      display:flex; align-items:center; gap:6px;
      padding:4px 8px 4px ${indentPx}px;
      margin-bottom:2px;
      background:var(--surface-hi); border-radius:5px;
      border:1px solid var(--border);
    `;

    // Connector line for child layers
    if (depth > 0) {
      div.style.position = 'relative';
      const line = document.createElement('div');
      line.style.cssText = `
        position:absolute; left:${indentPx - 10}px; top:0; bottom:0;
        width:1px; background:rgba(255,255,255,0.1); pointer-events:none;
      `;
      div.appendChild(line);
    }

    div.innerHTML += `
      <div style="position:relative;width:14px;height:14px;border-radius:3px;
                  border:1px solid rgba(255,255,255,0.18);cursor:pointer;
                  background:${hexColor};flex-shrink:0;">
        <input type="color" class="layer-color-picker" data-index="${layer.index}" value="${hexColor}"
          style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;">
      </div>
      <input type="text" class="layer-rename-input" data-index="${layer.index}" value="${label}"
        style="background:transparent;border:none;border-bottom:1px solid transparent;
               color:var(--text);font-family:inherit;font-size:${depth > 0 ? '0.72' : '0.76'}rem;
               width:100%;padding:1px 2px;outline:none;transition:border-bottom 0.2s;"
        onfocus="this.style.borderBottom='1px solid var(--primary)'"
        onblur="this.style.borderBottom='1px solid transparent'">
      <button class="layer-toggle-btn icon-btn sm ${layer.visible ? 'active' : ''}"
        data-index="${layer.index}"
        style="color:${visColor};background:transparent;border:none;cursor:pointer;
               flex-shrink:0;width:22px;height:22px;" title="Toggle Visibility">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${layer.visible
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}
        </svg>
      </button>
    `;
    list.appendChild(div);

    // Recurse — depth is unlimited (sub-sub-layers supported)
    children.forEach(child => renderNode(child));
  }

  roots.forEach(node => renderNode(node));

  // Event bindings
  list.querySelectorAll('.layer-color-picker').forEach(picker => {
    picker.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.index);
      const hex = e.target.value;
      const layer = parsedLayers.find(l => l.index === idx);
      if (layer) {
        layer.color = { r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16), a: 255 };
        e.target.parentElement.style.background = hex;
        if (currentModel) { applyLayerColorsToModel(currentModel); applyDisplayMode(); }
        createAnnotationSprites();
      }
    });
  });

  list.querySelectorAll('.layer-rename-input').forEach(input => {
    input.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.index);
      const name = e.target.value.trim();
      const layer = parsedLayers.find(l => l.index === idx);
      if (layer && name) layer.name = name;
    });
  });

  list.querySelectorAll('.layer-toggle-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.currentTarget.dataset.index);
      const layer = parsedLayers.find(l => l.index === idx);
      if (layer) {
        layer.visible = !layer.visible;
        // Propagate visibility to all descendant layers.
        // Uses layerNodeByIndex (built by renderLayerUI) so it works whether the
        // hierarchy came from parentLayerIndex or the "::" name-based fallback.
        const setDescendants = (parentIdx, vis) => {
          const node = layerNodeByIndex[parentIdx];
          if (!node) return;
          node.children.forEach(childNode => {
            childNode.layer.visible = vis;
            setDescendants(childNode.layer.index, vis);
          });
        };
        setDescendants(layer.index, layer.visible);
        renderLayerUI();
        updateLayerVisibility();
        createAnnotationSprites();
      }
    });
  });
}

function updateLayerVisibility() {
  if (!currentModel) return;
  currentModel.traverse(child => {
    // Handle both meshes AND line-based objects (curves, edges stored as Line/LineSegments)
    const hasAttrs = child.userData && child.userData.attributes;
    const isRenderable = (child.isMesh || child.isLine || child.isLineSegments) &&
                         child.name !== 'rhino-edges' &&
                         child.name !== 'rhino-outline' &&
                         child.name !== 'ground-plane';
    if (isRenderable && hasAttrs) {
      const layer = parsedLayers.find(l => l.index === child.userData.attributes.layerIndex);
      if (layer) child.visible = layer.visible;
    }
  });
  // Also update annotation sprites by layer
  if (annotationGroup) {
    annotationGroup.children.forEach(child => {
      const lIdx = child.userData?.layerIndex;
      if (lIdx !== undefined) {
        const layer = parsedLayers.find(l => l.index === lIdx);
        if (layer) {
          const annotationsVisible = document.getElementById('chk-annotations-panel')?.checked ?? true;
          child.visible = layer.visible && annotationsVisible;
        }
      }
    });
  }
}

// ── Core loop ──────────────────────────────────────────────────────────────
function onWindowResize() {
  const aspect = window.innerWidth / window.innerHeight;
  perspCamera.aspect = aspect;
  perspCamera.updateProjectionMatrix();
  if (camera.isOrthographicCamera) {
    const half = camera.top;  // preserve current vertical half-size
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.updateProjectionMatrix();
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  if (cameraTransition) {
    const now = performance.now();
    const elapsed = now - cameraTransition.startTime;
    let t = Math.min(1.0, elapsed / cameraTransition.duration);
    const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(cameraTransition.startPos, cameraTransition.endPos, easeT);
    controls.target.lerpVectors(cameraTransition.startTarget, cameraTransition.endTarget, easeT);
    camera.up.lerpVectors(cameraTransition.startUp, cameraTransition.endUp, easeT);
    camera.up.normalize();
    if (t >= 1.0) {
      cameraTransition = null;
      if (pendingOrthoSwitch) { pendingOrthoSwitch = false; switchToOrtho(); }
    }
  }
  controls.update();
  composer.render();
}

// ── Theme Management ────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const root = document.documentElement;
  const isLight = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  if (isLight) {
    root.setAttribute('data-theme', 'light');
    document.body.classList.add('light-theme');
    document.body.classList.remove('dark-theme');
  } else {
    root.setAttribute('data-theme', 'dark');   // explicit — prevents @media light from bleeding in
    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');
  }
  // Update select state
  const themeSel = document.getElementById('theme-select');
  if (themeSel) {
    themeSel.value = theme;
  }
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentTheme === 'system') applyTheme('system');
});

function initThemeSync() {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

  // Apply theme (uses currentTheme already set from localStorage)
  applyTheme(currentTheme);

  const updateBgColors = (isLight) => {
    const p1 = document.getElementById('bg-panel-c1');
    const p2 = document.getElementById('bg-panel-c2');
    const p3 = document.getElementById('bg-panel-c3');
    const p4 = document.getElementById('bg-panel-c4');
    if (isLight) {
      if (p1 && (p1.value === '#2a2b2f' || p1.value === '#000000')) p1.value = '#ffffff';
      if (p2 && p2.value === '#18181c') p2.value = '#f3f4f6';
      if (p3 && p3.value === '#1e293b') p3.value = '#e5e7eb';
      if (p4 && p4.value === '#0f172a') p4.value = '#d1d5db';
    } else {
      if (p1 && p1.value === '#ffffff') p1.value = '#2a2b2f';
      if (p2 && p2.value === '#f3f4f6') p2.value = '#18181c';
      if (p3 && p3.value === '#e5e7eb') p3.value = '#1e293b';
      if (p4 && p4.value === '#d1d5db') p4.value = '#0f172a';
    }
    ['c1','c2','c3','c4'].forEach(id => {
      const sw = document.getElementById('bg-panel-swatch-' + id);
      const p = document.getElementById('bg-panel-' + id);
      if (sw && p) sw.style.background = p.value;
    });
    if (typeof applySceneBackground === 'function' && typeof scene !== 'undefined' && scene) {
      applySceneBackground();
    }
  };

  // Apply initial bg colors based on theme
  const isLightInitial = currentTheme === 'light' || (currentTheme === 'system' && mediaQuery.matches);
  updateBgColors(isLightInitial);

  // Real-time listener for changes in system color scheme
  const updateTheme = (e) => {
    if (currentTheme === 'system') {
      applyTheme('system');
      updateBgColors(e.matches);
    }
  };
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', updateTheme);
  } else if (mediaQuery.addListener) {
    mediaQuery.addListener(updateTheme);
  }
}

// ── GLB Exporter ────────────────────────────────────────────────────────────
function exportGLB() {
  if (!currentModel) { alert('No model loaded.'); return; }

  // Apply current display-mode materials before export
  applyDisplayMode();

  // Temporarily hide overlay/helper meshes
  const toHide = [];
  currentModel.traverse(child => {
    if (child.name === 'rhino-outline' || child.name === 'selection-outline' ||
        child.name === 'rhino-edges'   || child.name === 'ground-plane') {
      if (child.visible) { toHide.push(child); child.visible = false; }
    }
  });

  const exporter = new GLTFExporter();
  exporter.parse(
    currentModel,
    (gltf) => {
      // Restore visibility
      toHide.forEach(c => { c.visible = true; });

      const blob = new Blob([gltf], { type: 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = (currentFileName?.replace(/\.[^.]+$/, '') || 'model') + '.glb';
      a.click();
      URL.revokeObjectURL(url);
    },
    (err) => {
      toHide.forEach(c => { c.visible = true; });
      console.error('[GLB Export] error:', err);
      alert('GLB export failed. See console for details.');
    },
    { binary: true }
  );
}
