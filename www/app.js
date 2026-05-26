import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { initI18n, setLang, applyI18n, t, currentLang } from './i18n.js';

import { S } from './state.js';
import { updateSliderFill, updateAllSliderFills, updateSelectIcon, hideLoading } from './helpers.js';
import { setupLights, updateSunLight, updateShadowCasting, addGroundPlane, removeGroundPlane } from './lighting.js';
import { switchToOrtho, switchToPersp, setViewPreset, triggerCameraTransition, fitCameraToBox, fitCameraToObject, fitCameraToSelected, saveCustomView, renderNamedViewsUI } from './camera.js';
import { applySceneBackground, applyFileBackground, applyDisplayMode } from './display.js';
import { renderLayerUI, updateLayerVisibility } from './layers.js';
import { createAnnotationSprites } from './annotations.js';
import { saveSession, loadSession } from './session.js';
import { handleFile, clearCurrentModel } from './loaders.js';
import {
  deactivateAllTools, clearMeasurements, renderMeasurementListUI,
  spawnAngleWidget, handleWidgetPointerDown, handleWidgetPointerMove,
  handleWidgetPointerUp, updateTempDistanceLine, updateDistanceGhost,
  onCanvasClick, updateClippingPlane, setupClippingHelper
} from './tools.js';
import { onPointerDown, clearSelection, updatePropertiesPanel, addSelectionOutline } from './selection.js';

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
      c *= pow(2.0, uExposure);
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(lum), c, 1.0 + uSaturation);
      c.r += uTemperature * 0.15;
      c.g += uTemperature * 0.03;
      c.b -= uTemperature * 0.15;
      // Only clamp NEGATIVE values; preserve HDR (>1.0) so subsequent
      // tone mapping in OutputPass works correctly. Clamping to [0,1] here
      // would clip HDR values like scene.backgroundIntensity above 1.
      gl_FragColor = vec4(max(c, vec3(0.0)), tex.a);
    }
  `
};

// ── BVH acceleration ───────────────────────────────────────────────────────
import('three-mesh-bvh').then(mod => {
  THREE.Mesh.prototype.raycast = mod.acceleratedRaycast;
  THREE.BufferGeometry.prototype.computeBoundsTree = mod.computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = mod.disposeBoundsTree;
  S.bvhReady = true;
}).catch(() => console.warn('three-mesh-bvh not loaded'));

window.addEventListener('error', e => console.error('Uncaught:', e.message, e.filename, e.lineno));

// ── rhino3dm init ──────────────────────────────────────────────────────────
if (window.rhino3dm) {
  window.rhino3dm().then(rhino => { S.rhinoInstance = rhino; });
}

const rhinoLoader = new Rhino3dmLoader();
rhinoLoader.setLibraryPath('https://cdn.jsdelivr.net/npm/rhino3dm@8.17.0/');

const gltfLoader = new GLTFLoader();

// ── Bootstrap ─────────────────────────────────────────────────────────────
document.getElementById('loading')?.classList.remove('hidden');
initThemeSync();
init();
animate();

// ── init ───────────────────────────────────────────────────────────────────
function init() {
  const container = document.getElementById('canvas-container');

  S.scene = new THREE.Scene();
  S.scene.background = null;
  S.measurementGroup = new THREE.Group();
  S.raycaster = new THREE.Raycaster();
  S.mouse = new THREE.Vector2();
  S.clippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  S.perspCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10000);
  S.perspCamera.up.set(0, 0, 1);
  S.perspCamera.position.set(100, -100, 100);
  S.scene.add(S.perspCamera);

  S.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
  S.orthoCamera.up.set(0, 0, 1);
  S.scene.add(S.orthoCamera);

  S.camera = S.perspCamera;

  S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  S.renderer.setPixelRatio(window.devicePixelRatio);
  S.renderer.setSize(window.innerWidth, window.innerHeight);
  S.renderer.outputColorSpace = THREE.SRGBColorSpace;
  S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  S.renderer.shadowMap.enabled = true;
  S.renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(S.renderer.domElement);

  // EffectComposer with default RT (no MSAA — GTAOPass needs depth from RenderPass).
  // SMAA handles anti-aliasing later in the chain.
  S.composer = new EffectComposer(S.renderer);
  S.composer.addPass(new RenderPass(S.scene, S.camera));

  // GTAO — Ground Truth Ambient Occlusion, configured per three.js example
  // (https://threejs.org/examples/?q=ambient#webgl_postprocessing_gtao)
  S.gtaoPass = new GTAOPass(S.scene, S.camera, window.innerWidth, window.innerHeight);
  // OUTPUT.Default = scene blended with AO. OUTPUT.Denoise outputs AO only (debug).
  S.gtaoPass.output = GTAOPass.OUTPUT.Default;
  S.gtaoPass.enabled = false;
  S.gtaoPass.blendIntensity = 1.0;
  S.composer.addPass(S.gtaoPass);
  // Expose for runtime debugging in console
  window._gtao = S.gtaoPass;
  window._GTAO_OUTPUT = GTAOPass.OUTPUT;

  // Initialize GTAO parameters (default — overridden per mode in display.js).
  // screenSpaceRadius: false matches the three.js example setup.  The
  // world-space radius is set to a placeholder (1.0); display.js sets it to
  // 5% of the loaded model's bounding-box size so it scales automatically
  // from a 20 mm jewelry ring to a 50 m building.
  S.gtaoPass.updateGtaoMaterial({
    radius: 1.0, distanceExponent: 1.0, thickness: 20.0, scale: 1.0,
    samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false
  });
  S.gtaoPass.updatePdMaterial({
    lumaPhi: 10., depthPhi: 2., normalPhi: 3.,
    radius: 4., radiusExponent: 1., rings: 2., samples: 16
  });

  // SSAOPass — fallback / comparison. Added to the composer so we can enable it
  // per-mode. Starts disabled; ao-debug mode can toggle it to verify the
  // pipeline works while GTAOPass is being debugged.
  S.ssaoPass = new SSAOPass(S.scene, S.camera, window.innerWidth, window.innerHeight);
  S.ssaoPass.kernelRadius = 16;   // world-space radius (scaled in display.js)
  S.ssaoPass.minDistance  = 0.005;
  S.ssaoPass.maxDistance  = 0.1;
  S.ssaoPass.enabled = false;
  S.composer.addPass(S.ssaoPass);
  window._ssao = S.ssaoPass;

  // Outline pass for technical-mode silhouette (2px) — disabled by default.
  S.outlinePass = new OutlinePass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    S.scene, S.camera
  );
  S.outlinePass.edgeStrength      = 20.0;
  S.outlinePass.edgeGlow          = 0.0;
  S.outlinePass.edgeThickness     = 4.0;  // visibly thicker than 1px geometry edges
  S.outlinePass.pulsePeriod       = 0;
  S.outlinePass.visibleEdgeColor.set('#000000');
  S.outlinePass.hiddenEdgeColor.set('#000000');
  S.outlinePass.enabled = false;
  S.composer.addPass(S.outlinePass);

  S.cgPass = new ShaderPass(ColorGradingShader);
  S.composer.addPass(S.cgPass);

  // SMAA — software AA pass; secondary to the MSAA render target.
  // Helps smooth post-process artifacts (OutlinePass edges, etc) that MSAA misses.
  S.smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
  S.composer.addPass(S.smaaPass);

  S.composer.addPass(new OutputPass());

  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = true;
  S.controls.dampingFactor = 0.5;
  S.controls.autoRotateSpeed = 1.0;

  S.renderer.localClippingEnabled = true;
  S.scene.add(S.measurementGroup);

  S.raycaster.params.Line.threshold = 0.5;

  S.clippingTransformControls = new TransformControls(S.camera, S.renderer.domElement);
  S.clippingTransformControls.setSpace('local');
  S.clippingTransformControls.showX = true;
  S.clippingTransformControls.showY = true;
  S.clippingTransformControls.showZ = true;
  // v0.169: TransformControls extends Controls (not Object3D); add the helper root instead
  S.scene.add(S.clippingTransformControls.getHelper());

  S.clippingTransformControls.addEventListener('dragging-changed', (event) => {
    S.controls.enabled = !event.value;
  });

  S.clippingTransformControls.addEventListener('change', () => {
    if (S.clippingHelper && S.currentModel && S.clippingTransformControls.object) {
      const normal = S.clippingPlane.normal.clone().normalize();
      S.clippingPlane.constant = -normal.dot(S.clippingHelper.position);
    }
  });

  setupLights();

  const pmrem = new THREE.PMREMGenerator(S.renderer);
  pmrem.compileEquirectangularShader();

  const roomEnv = new RoomEnvironment();
  S.envMaps.studio = pmrem.fromScene(roomEnv).texture;
  roomEnv.dispose();

  S.envMaps.neutral = makeGradientEnv(pmrem, '#d8dde4', '#eef0f2', '#b0b8c4');
  S.envMaps.sky     = makeGradientEnv(pmrem, '#1e4a8a', '#6ab0e8', '#c4a870', '#3a2a10');
  S.envMaps.sunset  = makeGradientEnv(pmrem, '#0e0820', '#b83a10', '#f06020', '#e09030', '#0e0820');
  S.envMaps.night   = makeGradientEnv(pmrem, '#030610', '#071228', '#0a1a3a', '#030610');

  S.environmentMap = S.envMaps.studio;
  S.scene.environment = S.environmentMap;
  pmrem.dispose();

  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) {
    bgSel.value = 'solid';
    document.getElementById('picker-c1')?.classList.remove('hidden');
    document.getElementById('picker-c2')?.classList.add('hidden');
    document.getElementById('bg-radial-section')?.classList.add('hidden');
    document.querySelector('.env-preset-btn[data-preset="studio"]')?.classList.add('active');
  }

  initI18n();
  applyI18n();

  bindUI();
  updateAllSliderFills();
  window.addEventListener('resize', onWindowResize);

  // Apply env intensity initial value
  const slEnvInit = document.getElementById('sl-env-intensity');
  if (slEnvInit) S.scene.environmentIntensity = parseFloat(slEnvInit.value) || 1.0;

  hideLoading();
}

// ── Environment gradient helper ────────────────────────────────────────────
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

// ── UI bindings ────────────────────────────────────────────────────────────
let pointerDownTime = 0;
let pointerDownPos = new THREE.Vector2();

function bindUI() {
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
    const f = e.target.files[0]; if (f) handleFile(f, rhinoLoader, gltfLoader);
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

  // ── 1. Panel toggles ──
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
    if (!isOpen) leftPanel.classList.remove('hidden');
  });
  document.getElementById('btn-close-menu').addEventListener('click', () => {
    leftPanel.classList.add('hidden');
  });

  document.getElementById('btn-layer-panel')?.addEventListener('click', () => {
    const isOpen = layerRightPanel?.classList.contains('panel-open');
    closeAllPanels();
    if (!isOpen) layerRightPanel?.classList.add('panel-open');
  });
  document.getElementById('btn-close-layer-panel')?.addEventListener('click', () => {
    layerRightPanel?.classList.remove('panel-open');
  });

  document.getElementById('btn-settings-panel')?.addEventListener('click', () => {
    const isOpen = settingsRightPanel?.classList.contains('panel-open');
    closeAllPanels();
    if (!isOpen) settingsRightPanel?.classList.add('panel-open');
  });
  document.getElementById('btn-close-settings-panel')?.addEventListener('click', () => {
    settingsRightPanel?.classList.remove('panel-open');
  });

  // ── 2. File tab actions ──
  document.getElementById('btn-open-panel').addEventListener('click', () => { fileInput.click(); });
  document.getElementById('btn-save-panel').addEventListener('click', () => { saveSession(); });
  document.getElementById('btn-close-panel').addEventListener('click', () => { clearCurrentModel(); });
  document.getElementById('btn-capture-panel').addEventListener('click', () => {
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

    const origPixelRatio = S.renderer.getPixelRatio();
    const origBackground = S.scene.background;

    S.renderer.setSize(w, h);
    S.renderer.setPixelRatio(1);
    if (transparent) {
      S.scene.background = null;
      S.renderer.setClearColor(0x000000, 0);
    }
    S.renderer.render(S.scene, S.camera);
    const dataURL = S.renderer.domElement.toDataURL('image/png');
    S.renderer.setSize(window.innerWidth, window.innerHeight);
    S.renderer.setPixelRatio(origPixelRatio);
    S.scene.background = origBackground;
    if (transparent) S.renderer.setClearColor(0x000000, 0);

    const a = document.createElement('a');
    a.href = dataURL;
    a.download = (S.currentFileName || 'capture') + '.png';
    a.click();
    document.getElementById('capture-dialog').classList.add('hidden');
  });

  const saveGlbBtn = document.getElementById('btn-save-glb');
  if (saveGlbBtn) saveGlbBtn.addEventListener('click', () => exportGLB());

  // ── 3. Background color pickers ──
  const bgTypeSelect  = document.getElementById('bg-type-select');
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
    document.getElementById('picker-c1')?.classList.remove('hidden');
    document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid);
    document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4);
    document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4);
    const radialSection = document.getElementById('bg-radial-section');
    if (radialSection) radialSection.classList.toggle('hidden', !isRadial);
    applySceneBackground();
  });

  const radialSpread = document.getElementById('bg-radial-spread');
  if (radialSpread) {
    radialSpread.addEventListener('input', () => {
      const v = parseFloat(radialSpread.value);
      document.getElementById('bg-radial-spread-val').textContent = Math.round(v * 100) + '%';
      updateSliderFill(radialSpread);
      applySceneBackground();
    });
  }

  // ── Environment preset select ──
  const envPresetSel = document.getElementById('env-preset-select');
  if (envPresetSel) {
    envPresetSel.addEventListener('change', () => {
      S.currentEnvPreset = envPresetSel.value;
      const preset = S.envMaps[S.currentEnvPreset];
      if (preset) {
        S.environmentMap = preset;
        if (['arctic','rendered'].includes(S.currentMode)) {
          S.scene.environment = S.environmentMap;
        }
        // Also update background if HDR bg mode is active
        const bgSel = document.getElementById('bg-type-select');
        if (bgSel?.value === 'hdr') applySceneBackground();
      }
    });
  }

  // ── Environment light intensity ──
  const slEnvInt    = document.getElementById('sl-env-intensity');
  const slEnvIntVal = document.getElementById('sl-env-intensity-val');
  if (slEnvInt) {
    slEnvInt.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (slEnvIntVal) slEnvIntVal.textContent = v.toFixed(2);
      updateSliderFill(e.target);
      S.scene.environmentIntensity = v;
    });
    updateSliderFill(slEnvInt);
  }

  // Legacy button-based env presets (no-op if no such elements in HTML)
  document.querySelectorAll('.env-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.currentEnvPreset = btn.dataset.preset;
      document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (envPresetSel) envPresetSel.value = S.currentEnvPreset;
      const preset = S.envMaps[S.currentEnvPreset];
      if (preset) {
        S.environmentMap = preset;
        S.scene.environment = S.environmentMap;
        if (document.getElementById('bg-type-select')?.value === 'hdr') applySceneBackground();
      }
    });
  });

  // ── HDR file upload ──
  const hdrInput = document.getElementById('hdr-file-input');
  if (hdrInput) {
    hdrInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const rgbeLoader = new RGBELoader();
      const pmrem = new THREE.PMREMGenerator(S.renderer);
      pmrem.compileEquirectangularShader();
      rgbeLoader.load(url, texture => {
        URL.revokeObjectURL(url);
        const envTexture = pmrem.fromEquirectangular(texture).texture;
        texture.dispose();
        pmrem.dispose();
        if (S.envMaps['hdr-custom']) S.envMaps['hdr-custom'].dispose();
        S.envMaps['hdr-custom'] = envTexture;
        S.environmentMap = envTexture;
        S.currentEnvPreset = 'hdr-custom';
        if (['arctic','rendered'].includes(S.currentMode)) S.scene.environment = S.environmentMap;
        // Enable the custom-HDR option and select it
        const hdrOpt = document.getElementById('opt-hdr-custom');
        if (hdrOpt) { hdrOpt.disabled = false; hdrOpt.textContent = 'Custom HDR'; }
        const envSel = document.getElementById('env-preset-select');
        if (envSel) envSel.value = 'hdr-custom';
        // Also update background if HDR bg mode
        if (document.getElementById('bg-type-select')?.value === 'hdr') applySceneBackground();
        document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.env-preset-btn[data-preset="hdr-custom"]')?.classList.add('active');
      }, undefined, err => console.error('[HDR] load error', err));
    });
  }

  const bindBgInput = (input, swatch) => {
    if (!input || !swatch) return;
    input.addEventListener('input', () => {
      swatch.style.background = input.value;
      applySceneBackground();
    });
  };
  bindBgInput(bgPanelC1, bgSwatchC1);
  bindBgInput(bgPanelC2, bgSwatchC2);
  bindBgInput(bgPanelC3, bgSwatchC3);
  bindBgInput(bgPanelC4, bgSwatchC4);

  // ── 4. Visibility checkboxes ──
  document.getElementById('chk-edges-panel').addEventListener('change', () => applyDisplayMode());
  document.getElementById('chk-shadows-panel').addEventListener('change', e => {
    S.shadowsEnabled = e.target.checked;
    updateShadowCasting();
  });
  document.getElementById('chk-ground-panel').addEventListener('change', e => {
    S.groundEnabled = e.target.checked;
    if (S.groundEnabled && S.currentModel) {
      const box = new THREE.Box3().setFromObject(S.currentModel);
      addGroundPlane(box);
    } else {
      removeGroundPlane();
    }
  });
  document.getElementById('chk-annotations-panel').addEventListener('change', e => {
    if (S.annotationGroup) {
      S.annotationGroup.traverse(child => {
        if (child !== S.annotationGroup) child.visible = e.target.checked;
      });
    }
  });

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
  safeBindCheck('chk-edge',        'chk-edges-panel');
  safeBindCheck('chk-shadows',     'chk-shadows-panel');
  safeBindCheck('chk-ground',      'chk-ground-panel');
  safeBindCheck('chk-annotations', 'chk-annotations-panel');

  // ── 5. Lighting & damping sliders ──
  document.getElementById('sl-ambient-panel').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    document.getElementById('sl-ambient-val').textContent = val.toFixed(2);
    updateSliderFill(e.target);
    S.scene.traverse(child => {
      if (child.isAmbientLight) child.intensity = val;
    });
  });

  const chkSun       = document.getElementById('chk-sun-panel');
  const sunControls  = document.getElementById('sun-controls');
  const slAzimuth    = document.getElementById('sl-sun-azimuth');
  const slElevation  = document.getElementById('sl-sun-elevation');
  const slSunInt     = document.getElementById('sl-sun-intensity');

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
  slSunInt?.addEventListener('input', e => {
    document.getElementById('sl-sun-intensity-val').textContent = parseFloat(e.target.value).toFixed(2);
    updateSliderFill(e.target);
    updateSunLight();
  });
  if (slAzimuth)   updateSliderFill(slAzimuth);
  if (slElevation) updateSliderFill(slElevation);
  if (slSunInt)    updateSliderFill(slSunInt);

  document.getElementById('sl-damping-panel').addEventListener('input', e => {
    const friction = parseFloat(e.target.value);
    document.getElementById('sl-damping-val').textContent = friction.toFixed(2);
    updateSliderFill(e.target);
    S.controls.dampingFactor = 1.0 - friction;
    if (S.controls.dampingFactor < 0.005) S.controls.dampingFactor = 0.005;
  });

  // ── 6. Dropdowns ──
  const dropdowns = [
    { btnId: 'btn-mode-dropdown',      menuId: 'mode-dropdown'      },
    { btnId: 'btn-view-dropdown',      menuId: 'view-dropdown'      },
    { btnId: 'btn-turntable-dropdown', menuId: 'turntable-dropdown' },
    { btnId: 'btn-select-dropdown',    menuId: 'select-dropdown'    },
    { btnId: 'btn-tools-dropdown',     menuId: 'tools-dropdown'     }
  ];
  dropdowns.forEach(dd => {
    const btn  = document.getElementById(dd.btnId);
    const menu = document.getElementById(dd.menuId);
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        dropdowns.forEach(other => {
          document.getElementById(other.menuId)?.classList.add('hidden');
        });
        if (wasHidden) menu.classList.remove('hidden');
      });
    }
  });
  document.addEventListener('click', () => {
    dropdowns.forEach(dd => document.getElementById(dd.menuId)?.classList.add('hidden'));
  });

  document.getElementById('mode-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.getElementById('mode-dropdown').querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.currentMode = mode;
      applyDisplayMode();
      const label = btn.querySelector('span').textContent.split(' ')[0];
      const triggerBtn = document.getElementById('btn-mode-dropdown');
      triggerBtn.querySelector('span').textContent = label;
      triggerBtn.title = `Display Mode (${label})`;
    });
  });

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

  // Named view dialog
  const saveViewBtn  = document.getElementById('btn-save-named-view');
  const namedViewDlg = document.getElementById('named-view-dialog');
  const nameInput    = document.getElementById('input-named-view-name');

  const openNamedViewDialog = () => {
    if (!namedViewDlg) return;
    nameInput.value = '';
    namedViewDlg.classList.remove('hidden');
    document.getElementById('view-dropdown')?.classList.add('hidden');
    requestAnimationFrame(() => nameInput.focus());
  };
  const closeNamedViewDialog = () => namedViewDlg?.classList.add('hidden');
  const confirmNamedView = () => {
    const name = nameInput?.value.trim();
    if (name) saveCustomView(name);
    closeNamedViewDialog();
  };

  saveViewBtn?.addEventListener('click', (e) => { e.stopPropagation(); openNamedViewDialog(); });
  document.getElementById('btn-close-named-view-dialog')?.addEventListener('click', closeNamedViewDialog);
  document.getElementById('btn-cancel-named-view')?.addEventListener('click', closeNamedViewDialog);
  document.getElementById('btn-confirm-named-view')?.addEventListener('click', confirmNamedView);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmNamedView(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNamedViewDialog(); }
  });
  namedViewDlg?.addEventListener('click', (e) => { if (e.target === namedViewDlg) closeNamedViewDialog(); });

  document.getElementById('btn-zoom-extents-drop').addEventListener('click', () => {
    if (!S.currentModel) return;
    const box = new THREE.Box3();
    S.currentModel.traverse(child => {
      if (child.isMesh && child.visible &&
          child.name !== 'rhino-edges' && child.name !== 'rhino-outline' &&
          child.name !== 'selection-outline' && child.name !== 'ground-plane') {
        box.expandByObject(child);
      }
    });
    if (!box.isEmpty()) fitCameraToBox(box, true, true);
    else fitCameraToObject(S.currentModel, true, true);
    document.getElementById('view-dropdown')?.classList.add('hidden');
  });
  document.getElementById('btn-zoom-selected-drop').addEventListener('click', fitCameraToSelected);

  // ── Turntable ──
  let ttContinuous = false;
  const ttToggleBtn  = document.getElementById('btn-tt-toggle');
  const springSlider = document.getElementById('tt-spring-slider');
  const springVal    = document.getElementById('tt-spring-val');
  const ttDropdown   = document.getElementById('turntable-dropdown');
  const ttTriggerBtn = document.getElementById('btn-turntable-dropdown');

  // Prevent clicks INSIDE the turntable dropdown from closing it.
  // The global document click handler closes all dropdowns; stopping
  // propagation here ensures clicks on the toggle/slider don't close it.
  ttDropdown?.addEventListener('click', e => e.stopPropagation());

  const setTurntable = (on) => {
    ttContinuous = on;
    if (ttToggleBtn) {
      ttToggleBtn.classList.toggle('active', on);
      ttToggleBtn.textContent = on ? t('turntable.on') : t('turntable.off');
    }
    // Tint the toolbar Turn button when auto-rotate is active
    if (ttTriggerBtn) ttTriggerBtn.classList.toggle('active', on);
    if (!on) {
      // Turning off: reset slider and stop rotation
      springSlider.value = 0;
      springVal.textContent = '0.0';
      updateSliderFill(springSlider);
      S.controls.autoRotate = false;
      S.controls.autoRotateSpeed = 0;
    }
    // Turning on: keep current slider value — speed 0 means no rotation yet
  };
  ttToggleBtn?.addEventListener('click', () => {
    setTurntable(!ttContinuous);
    // Don't close dropdown on toggle — user needs speed slider
  });

  springSlider?.addEventListener('input', () => {
    const speed = parseFloat(springSlider.value);
    springVal.textContent = (speed >= 0 ? '+' : '') + speed.toFixed(1);
    updateSliderFill(springSlider);
    // Speed 0 always means no rotation, regardless of continuous state
    if (speed === 0) {
      S.controls.autoRotate = false;
      S.controls.autoRotateSpeed = 0;
    } else {
      S.controls.autoRotate = true;
      S.controls.autoRotateSpeed = speed * 4.0; // negative = counter-clockwise
    }
  });
  const resetSpringSlider = () => {
    // Continuous ON: keep the set speed (no spring-back)
    if (ttContinuous) return;
    // Continuous OFF: spring back to 0 and stop
    if (springSlider) { springSlider.value = 0; updateSliderFill(springSlider); }
    if (springVal) springVal.textContent = '0.0';
    S.controls.autoRotate = false;
    S.controls.autoRotateSpeed = 0;
  };
  springSlider?.addEventListener('pointerup',     resetSpringSlider);
  springSlider?.addEventListener('pointercancel', resetSpringSlider);
  springSlider?.addEventListener('change',        resetSpringSlider);

  // ── Select mode ──
  document.getElementById('select-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      S.selectMode = btn.dataset.select;
      document.getElementById('select-dropdown').querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const label = btn.querySelector('span').textContent.split(' ')[0];
      const triggerBtn = document.getElementById('btn-select-dropdown');
      triggerBtn.querySelector('span').textContent = `Select: ${label}`;
      triggerBtn.title = `Selection Mode (${label})`;
      updateSelectIcon(S.selectMode);
      if (S.selectMode === 'none') { clearSelection(); updatePropertiesPanel(); }
    });
  });

  // ── Show/hide ──
  document.getElementById('btn-show-all-drop').addEventListener('click', () => {
    S.hiddenObjects.forEach(obj => { obj.visible = true; });
    S.hiddenObjects.clear();
    updateLayerVisibility();
  });
  document.getElementById('btn-hide-selected-drop').addEventListener('click', () => {
    S.selectedObjects.forEach(child => { child.visible = false; S.hiddenObjects.add(child); });
    clearSelection();
    updatePropertiesPanel();
  });
  document.getElementById('btn-isolate-selected-drop').addEventListener('click', () => {
    if (!S.selectedObjects.length || !S.currentModel) return;
    S.currentModel.traverse(child => {
      if (child.isMesh && child.name !== 'rhino-edges' &&
          child.name !== 'rhino-outline' && child.name !== 'ground-plane') {
        if (!S.selectedObjects.includes(child)) {
          child.visible = false;
          S.hiddenObjects.add(child);
        }
      }
    });
    updatePropertiesPanel();
  });

  // ── 7. Tools ──
  document.getElementById('btn-tool-distance').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('tools-dropdown').classList.add('hidden');
    if (S.distanceToolState) {
      S.distanceToolState = null;
      if (S.distanceGhostSphere) {
        if (S.distanceGhostSphere.geometry) S.distanceGhostSphere.geometry.dispose();
        if (S.distanceGhostSphere.material) S.distanceGhostSphere.material.dispose();
        S.measurementGroup.remove(S.distanceGhostSphere);
        S.distanceGhostSphere = null;
      }
      document.getElementById('canvas-container').style.cursor = '';
      document.getElementById('btn-tool-distance').classList.remove('active');
      renderMeasurementListUI();
      return;
    }
    deactivateAllTools();
    S.distanceToolState = { points: [], spheres: [] };
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

  // Color Adjustment moved to Settings panel — no floating popup anymore

  const setupSafeClose = (btnId, callback) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      let triggered = false;
      const handler = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!triggered) {
          triggered = true;
          callback();
          setTimeout(() => { triggered = false; }, 300);
        }
      };
      btn.addEventListener('click',      handler);
      btn.addEventListener('pointerdown', handler);
      btn.addEventListener('touchstart',  handler, { passive: false });
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
  // Color panel removed — color adj is now inline in Settings
  document.getElementById('btn-measure-clear-all')?.addEventListener('click', () => clearMeasurements());
  setupSafeClose('btn-close-props', () => {
    document.getElementById('object-properties').classList.add('hidden');
    clearSelection();
  });

  // ── Draggable measurement panel ──
  ;(function() {
    const panel  = document.getElementById('measurement-list-panel');
    const handle = panel?.querySelector('.measure-drag-handle');
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup',     () => { dragging = false; });
    handle.addEventListener('pointercancel', () => { dragging = false; });
  })();

  // ── Draggable properties panel ──
  ;(function() {
    const panel  = document.getElementById('object-properties');
    const handle = document.getElementById('prop-drag-handle');
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;
    const onDown = e => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto';
    };
    const onUp = () => { dragging = false; };
    handle.addEventListener('pointerdown',   onDown);
    handle.addEventListener('pointermove',   onMove);
    handle.addEventListener('pointerup',     onUp);
    handle.addEventListener('pointercancel', onUp);
  })();

  // ── Layer toggle-all ──
  document.getElementById('btn-toggle-all-layers-panel')?.addEventListener('click', () => {
    const anyOff = S.parsedLayers.some(l => !l.visible);
    S.parsedLayers.forEach(l => l.visible = anyOff);
    renderLayerUI();
    updateLayerVisibility();
    createAnnotationSprites();
  });

  // ── 8. Clipping plane ──
  document.getElementById('chk-clipping-enable').addEventListener('change', e => {
    S.clippingEnabled = e.target.checked;
    S.renderer.clippingPlanes = S.clippingEnabled ? [S.clippingPlane] : [];
    if (S.clippingEnabled) {
      setupClippingHelper();
    } else {
      if (S.clippingTransformControls) {
        S.clippingTransformControls.detach();
        S.clippingTransformControls.getHelper().visible = false;
      }
      if (S.clippingHelper) { S.scene.remove(S.clippingHelper); S.clippingHelper = null; }
    }
  });

  // ── Draggable clipping panel ──
  ;(function() {
    const panel  = document.getElementById('clipping-panel');
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
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging=false; handle.style.cursor='grab'; });
  })();

  let clipAxis   = 'z';
  let clipFlipped = false;

  const applyClipAxisUI = () => {
    document.querySelectorAll('.clip-axis-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.axis === clipAxis);
    });
    const normals = {
      z:  [0,  180], zf: [0,    0],
      y:  [-90,  0], yf: [ 90,  0],
      x:  [0,  -90], xf: [0,   90]
    };
    const key = clipAxis + (clipFlipped ? 'f' : '');
    const [rx, ry] = normals[key];
    const rotXSlider = document.getElementById('clip-rot-x');
    const rotYSlider = document.getElementById('clip-rot-y');
    if (rotXSlider) rotXSlider.value = rx;
    if (rotYSlider) rotYSlider.value = ry;
    const cp = document.getElementById('clipping-panel');
    if (cp) { cp.dataset.rotX = rx; cp.dataset.rotY = ry; }
    updateClippingPlane();
  };

  document.querySelectorAll('.clip-axis-btn[data-axis]').forEach(btn => {
    btn.addEventListener('click', () => { clipAxis = btn.dataset.axis; applyClipAxisUI(); });
  });
  document.getElementById('btn-clip-flip')?.addEventListener('click', () => {
    clipFlipped = !clipFlipped;
    applyClipAxisUI();
  });

  // Clipping transform mode (translate / rotate)
  document.querySelectorAll('.clip-axis-btn[data-clip-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.clip-axis-btn[data-clip-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (S.clippingTransformControls) {
        S.clippingTransformControls.setMode(btn.dataset.clipMode);
      }
    });
  });

  // ── 9. Object search (live) ──
  const findInput = document.getElementById('find-search-input');
  const findBtn   = document.getElementById('btn-find-search');
  if (findInput) {
    findInput.addEventListener('input', () => {
      const query = findInput.value.trim();
      clearSelection();
      if (!S.currentModel || !query) { updatePropertiesPanel(); return; }
      S.currentModel.traverse(child => {
        if (!(child.isMesh || child.isLine || child.isLineSegments)) return;
        if (child.name === 'rhino-edges' || child.name === 'rhino-outline' ||
            child.name === 'selection-outline' || child.name === 'ground-plane') return;
        const name = child.userData?.attributes?.name || child.name || '';
        if (name.toLowerCase().includes(query.toLowerCase())) {
          S.selectedObjects.push(child);
          addSelectionOutline(child);
        }
      });
      updatePropertiesPanel();
    });
    findInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { findInput.value = ''; clearSelection(); updatePropertiesPanel(); }
    });
  }
  if (findBtn) findBtn.addEventListener('click', () => findInput?.dispatchEvent(new Event('input')));

  // ── 10. Color grading ──
  document.getElementById('btn-cg-reset').addEventListener('click', () => {
    ['exposure','contrast','saturation','temperature'].forEach(k => {
      const slider = document.getElementById('cg-' + k);
      if (slider) {
        slider.value = 0;
        document.getElementById('cg-' + k + '-val').textContent = '0.0';
        S.cgPass.uniforms['u' + k.charAt(0).toUpperCase() + k.slice(1)].value = 0;
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
        S.cgPass.uniforms[uniform].value = v;
        updateSliderFill(e.target);
      });
    }
  });

  // Color panel removed — color adjustment is now inline in Settings

  // ── 11. Canvas pointer events ──
  S.renderer.domElement.addEventListener('pointerdown', (e) => {
    pointerDownTime = performance.now();
    pointerDownPos.set(e.clientX, e.clientY);
    handleWidgetPointerDown(e);
  });
  S.renderer.domElement.addEventListener('pointermove', (e) => {
    handleWidgetPointerMove(e);
    updateTempDistanceLine(e);
    updateDistanceGhost(e);
  });
  S.renderer.domElement.addEventListener('pointerup', (e) => {
    handleWidgetPointerUp();
    const timeDiff = performance.now() - pointerDownTime;
    const dist = pointerDownPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY));
    const isClick = timeDiff < 500 && dist < 12;
    if (isClick) {
      const anyPanelOpen =
        !leftPanel.classList.contains('hidden') ||
        layerRightPanel?.classList.contains('panel-open') ||
        settingsRightPanel?.classList.contains('panel-open');
      if (anyPanelOpen) { closeAllPanels(); return; }
      document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
      if (S.distanceToolState) {
        onCanvasClick(e);
      } else {
        onPointerDown(e);
      }
    }
  });

  // ── Camera projection toggle ──
  const projSelect = document.getElementById('select-projection');
  if (projSelect) {
    projSelect.value = (S.camera === S.orthoCamera) ? 'parallel' : 'perspective';
    projSelect.addEventListener('change', () => {
      if (projSelect.value === 'parallel') switchToOrtho();
      else switchToPersp();
    });
  }

  // ── Camera FOV ──
  const fovSlider = document.getElementById('sl-camera-fov');
  const fovValEl  = document.getElementById('sl-camera-fov-val');
  if (fovSlider) {
    fovSlider.addEventListener('input', () => {
      const fov = parseInt(fovSlider.value);
      if (fovValEl) fovValEl.textContent = fov + '°';
      S.perspCamera.fov = fov;
      S.perspCamera.updateProjectionMatrix();
      updateSliderFill(fovSlider);
    });
  }

  // ── Language ──
  const langSel = document.getElementById('lang-select');
  if (langSel) {
    langSel.value = currentLang;
    langSel.addEventListener('change', () => setLang(langSel.value));
  }

  // ── Theme ──
  const themeSel = document.getElementById('theme-select');
  if (themeSel) {
    themeSel.value = S.currentTheme;
    themeSel.addEventListener('change', () => applyTheme(themeSel.value));
  }

  // ── Drag & drop ──
  window.addEventListener('dragenter', e => e.preventDefault());
  window.addEventListener('dragover',  e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files?.length > 0) {
      const f = files[0];
      if (f.name.toLowerCase().endsWith('.rhinoview')) loadSession(f);
      else handleFile(f, rhinoLoader, gltfLoader);
    }
  });
}

// ── Core render loop ───────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  if (S.cameraTransition) {
    const now     = performance.now();
    const elapsed = now - S.cameraTransition.startTime;
    let t = Math.min(1.0, elapsed / S.cameraTransition.duration);
    const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    S.camera.position.lerpVectors(S.cameraTransition.startPos,    S.cameraTransition.endPos,    easeT);
    S.controls.target.lerpVectors(S.cameraTransition.startTarget, S.cameraTransition.endTarget, easeT);
    S.camera.up.lerpVectors(S.cameraTransition.startUp, S.cameraTransition.endUp, easeT);
    S.camera.up.normalize();
    if (t >= 1.0) {
      S.cameraTransition = null;
      if (S.pendingOrthoSwitch) { S.pendingOrthoSwitch = false; switchToOrtho(); }
    }
  }
  S.controls.update();
  S.composer.render();
}

// ── Window resize ──────────────────────────────────────────────────────────
function onWindowResize() {
  const aspect = window.innerWidth / window.innerHeight;
  S.perspCamera.aspect = aspect;
  S.perspCamera.updateProjectionMatrix();
  if (S.camera.isOrthographicCamera) {
    const half = S.camera.top;
    S.camera.left  = -half * aspect;
    S.camera.right =  half * aspect;
    S.camera.updateProjectionMatrix();
  }
  S.renderer.setSize(window.innerWidth, window.innerHeight);
  S.composer.setSize(window.innerWidth, window.innerHeight);
  if (S.outlinePass?.setSize) S.outlinePass.setSize(window.innerWidth, window.innerHeight);
  if (S.smaaPass?.setSize)    S.smaaPass.setSize(window.innerWidth, window.innerHeight);
  if (S.gtaoPass?.setSize)    S.gtaoPass.setSize(window.innerWidth, window.innerHeight);
  if (S.ssaoPass?.setSize)    S.ssaoPass.setSize(window.innerWidth, window.innerHeight);
}

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  S.currentTheme = theme;
  localStorage.setItem(S.THEME_KEY, theme);
  const root = document.documentElement;
  const isLight = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  if (isLight) {
    root.setAttribute('data-theme', 'light');
    document.body.classList.add('light-theme');
    document.body.classList.remove('dark-theme');
  } else {
    root.setAttribute('data-theme', 'dark');
    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');
  }
  const themeSel = document.getElementById('theme-select');
  if (themeSel) themeSel.value = theme;
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (S.currentTheme === 'system') applyTheme('system');
});

function initThemeSync() {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
  applyTheme(S.currentTheme);

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
      const p  = document.getElementById('bg-panel-' + id);
      if (sw && p) sw.style.background = p.value;
    });
    if (S.scene) applySceneBackground();
  };

  const isLightInitial = S.currentTheme === 'light' ||
    (S.currentTheme === 'system' && mediaQuery.matches);
  updateBgColors(isLightInitial);

  const updateTheme = (e) => {
    if (S.currentTheme === 'system') { applyTheme('system'); updateBgColors(e.matches); }
  };
  if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', updateTheme);
  else if (mediaQuery.addListener)  mediaQuery.addListener(updateTheme);
}

// ── GLB export ─────────────────────────────────────────────────────────────
function exportGLB() {
  if (!S.currentModel) { alert('No model loaded.'); return; }
  applyDisplayMode();

  const toHide = [];
  S.currentModel.traverse(child => {
    if (child.name === 'rhino-outline' || child.name === 'selection-outline' ||
        child.name === 'rhino-edges'   || child.name === 'ground-plane') {
      if (child.visible) { toHide.push(child); child.visible = false; }
    }
  });

  const exporter = new GLTFExporter();
  exporter.parse(
    S.currentModel,
    (gltf) => {
      toHide.forEach(c => { c.visible = true; });
      const blob = new Blob([gltf], { type: 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = (S.currentFileName?.replace(/\.[^.]+$/, '') || 'model') + '.glb';
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

// ── Object search (results panel) ─────────────────────────────────────────
function searchObjects(query) {
  const container = document.getElementById('find-results-container');
  if (!container) return;
  container.innerHTML = '';

  if (!S.currentModel) {
    container.innerHTML = '<span class="dropdown-empty-msg">No model loaded</span>';
    return;
  }
  if (!query || query.trim() === '') {
    container.innerHTML = '<span class="dropdown-empty-msg">Enter object name...</span>';
    return;
  }

  const matches = [];
  S.currentModel.traverse(child => {
    if (child.isMesh && child.name !== 'rhino-edges' &&
        child.name !== 'rhino-outline' && child.name !== 'ground-plane') {
      const name = child.userData?.attributes?.name || child.name || '';
      if (name.toLowerCase().includes(query.toLowerCase())) matches.push(child);
    }
  });

  if (matches.length === 0) {
    container.innerHTML = '<span class="dropdown-empty-msg" style="padding:10px 0;">No matching objects found</span>';
    return;
  }

  matches.forEach(obj => {
    const name  = obj.userData?.attributes?.name || obj.name || 'Unnamed Mesh';
    const layer = S.parsedLayers.find(l => l.index === obj.userData?.attributes?.layerIndex);
    const btn   = document.createElement('button');
    btn.className = 'dropdown-item';
    btn.style.cssText = 'width:100%;padding:6px 8px;background:var(--surface-hi);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:4px;color:var(--text)';
    btn.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:2px;font-size:0.75rem;text-align:left;">
        <span style="font-weight:600;">${name}</span>
        <span style="color:var(--text-2);font-size:0.65rem;">Layer: ${layer?.name ?? '—'}</span>
      </div>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
      S.selectedObjects.push(obj);
      addSelectionOutline(obj);
      fitCameraToObject(obj, true);
      updatePropertiesPanel();
    });
    container.appendChild(btn);
  });
}
