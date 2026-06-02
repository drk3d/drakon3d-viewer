const isLightMode = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

// Single shared mutable state object — imported as `S` in every module.
// All module-level let variables from the original app.js live here.
// THREE objects (Group, Raycaster, etc.) are initialized in app.js init()
// to guarantee they share the same THREE module instance.
export const S = {
  // ── Core Three.js ────────────────────────────────────────────────────────
  scene:        null,
  camera:       null,
  renderer:     null,
  controls:     null,
  perspCamera:  null,
  orthoCamera:  null,

  // ── Post-processing ──────────────────────────────────────────────────────
  composer: null,
  ssaoPass: null,
  cgPass:   null,

  // ── Scene objects ────────────────────────────────────────────────────────
  currentModel:    null,
  currentMode:     'shaded',
  measurementGroup: null,

  // ── Environment ──────────────────────────────────────────────────────────
  environmentMap:    null,
  envMaps:           {},
  currentEnvPreset:  'studio',
  envAsBackground:   false,
  hdrRotation:       0,

  // ── Layers ───────────────────────────────────────────────────────────────
  parsedLayers:    [],
  layerNodeByIndex: {},

  // ── Interaction ──────────────────────────────────────────────────────────
  raycaster: null,
  mouse:     null,

  // ── Rhino native data ────────────────────────────────────────────────────
  rhinoInstance:       null,
  rhinoBackgroundColor: null,
  fileDefaultBgStyle:  null,
  customBackgroundColor: null,
  parsedAnnotations:   [],
  annotationGroup:     null,
  parsed3dmFileInfo:   null,
  parsedNamedViews:    [],

  // ── Selection ────────────────────────────────────────────────────────────
  selectedObjects: [],
  selectMode:      'single',

  // ── UI state ─────────────────────────────────────────────────────────────
  settingsOpen: false,

  // ── Turntable ────────────────────────────────────────────────────────────
  turntableActive: false,
  turntableSpeed:  1.0,
  turntableDir:    1,

  // ── Lighting / shadows / ground ──────────────────────────────────────────
  sunLight:         null,
  modelShadowDims:  null,
  groundMesh:       null,
  shadowsEnabled:   true,
  groundEnabled:    false,

  // ── Hidden objects ───────────────────────────────────────────────────────
  hiddenObjects: new Set(),

  // ── File / session ───────────────────────────────────────────────────────
  currentFileName: '',
  currentFileNameWithExt: '',
  modelUnit: 'Unknown',

  // ── Background ───────────────────────────────────────────────────────────
  bgGradient:  false,
  bgColorTop:  isLightMode ? '#f2f2f5' : '#2a2b2f',
  bgColorBot:  isLightMode ? '#dcdce2' : '#18181c',
  bgTexture:   null,

  // ── Camera transition ────────────────────────────────────────────────────
  cameraTransition:  null,
  pendingOrthoSwitch: false,

  // ── Measurement tool ─────────────────────────────────────────────────────
  distanceToolState:     null,
  angleToolState:        null,
  distanceGhostSphere:   null,
  completedMeasurements: [],
  angleWidget:    null,
  draggedHandle:  null,
  annotationScale:       1.0,

  // ── Clipping ─────────────────────────────────────────────────────────────
  clippingPlane:             null,
  clippingHelper:            null,
  clippingTransformControls: null,
  clippingArcHandles:        [],   // Array of {mesh, hitMesh, axis: 'x'|'y'|'z'} for custom rotation arcs
  clippingArcDrag: null,           // Active drag state: {axis, startAngle, startQuat}
  arcOverlayScene: null,           // Separate scene for arc handles — rendered without clipping planes
  clippingEnabled:           false,
  clippingBaseQuaternion:    null,
  clipAxis:                  'z',
  clipFlipped:               false,

  // ── Gumball ──────────────────────────────────────────────────────────────
  gumballActive:             false,
  gumballTransformControls:  null,
  gumballHelper:             null,
  gumballArcHandles:         [],   // Array of {mesh, hitMesh, axis: 'x'|'y'|'z'} for custom rotation arcs
  gumballArcDrag:            null, // Active drag state: {axis, startAngle, startQuat, startPositions, startQuats}

  // ── BVH ──────────────────────────────────────────────────────────────────
  bvhReady: false,

  // ── Theme ────────────────────────────────────────────────────────────────
  THEME_KEY:    'byrhinoview_theme',
  currentTheme: (() => {
    try {
      return localStorage.getItem('byrhinoview_theme') || 'system';
    } catch (e) {
      return 'system';
    }
  })(),
};
