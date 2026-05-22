import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode, applyFileBackground, applyLayerColorsToModel,
         addEdges, fixMaterialTransparency, clearTechnicalOutlines } from './display.js';
import { setupModelShadowFrustum, addGroundPlane, removeGroundPlane } from './lighting.js';
import { fitCameraToObject } from './camera.js';
import { renderLayerUI, updateLayerVisibility } from './layers.js';
import { createAnnotationSprites } from './annotations.js';
import { renderNamedViewsUI } from './camera.js';
import { resetSettingsToDefault } from './session.js';
import { showLoading, hideLoading, setProgress, setFileName, showModelInfo } from './helpers.js';

// ── Dynamic OCCT loader ───────────────────────────────────────────────────────

export async function loadOCCT() {
  if (window.occtimportjs) return window.occtimportjs;
  return new Promise((resolve, reject) => {
    const script   = document.createElement('script');
    script.src     = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/occt-import-js.js';
    script.onload  = () => resolve(window.occtimportjs);
    script.onerror = () => reject(new Error('Failed to load occt-import-js script'));
    document.head.appendChild(script);
  });
}

// ── STEP / IGES loader ────────────────────────────────────────────────────────

export async function loadCADFile(file, isSTEP, extractEdges) {
  try {
    showLoading(isSTEP ? 'Parsing STEP file…' : 'Parsing IGES file…');
    S.parsedLayers = [];
    renderLayerUI();
    document.getElementById('file-info-content')?.classList.add('hidden');

    setProgress(20);
    const occtimportjsFn = await loadOCCT();
    setProgress(40);
    const occt = await occtimportjsFn({
      locateFile: (name) => `https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/${name}`
    });
    setProgress(60);

    const arrayBuffer = await file.arrayBuffer();
    const u8Array     = new Uint8Array(arrayBuffer);
    const result      = isSTEP ? occt.ReadStepFile(u8Array) : occt.ReadIgesFile(u8Array);

    if (!result?.success) throw new Error(isSTEP ? 'STEP parsing failed' : 'IGES parsing failed');

    setProgress(80);
    const group = new THREE.Group();
    group.name  = file.name;

    for (const resultMesh of result.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(resultMesh.attributes.position.array, 3));
      if (resultMesh.attributes.normal) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(resultMesh.attributes.normal.array, 3));
      } else {
        geometry.computeVertexNormals();
      }
      if (resultMesh.index) geometry.setIndex(new THREE.Uint32BufferAttribute(resultMesh.index.array, 1));

      let color = 0xcccccc;
      if (resultMesh.color) {
        const r = Math.round(resultMesh.color[0] * 255);
        const g = Math.round(resultMesh.color[1] * 255);
        const b = Math.round(resultMesh.color[2] * 255);
        color = (r << 16) | (g << 8) | b;
      }
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 });
      const mesh     = new THREE.Mesh(geometry, material);
      mesh.name      = resultMesh.name || 'CAD_Mesh';
      mesh.userData  = { attributes: { name: mesh.name, layerIndex: 0 } };
      group.add(mesh);
    }

    clearCurrentModel();
    S.currentModel = group;
    S.scene.add(S.currentModel);
    document.getElementById('empty-state')?.classList.add('hidden');
    postProcessModel(S.currentModel, extractEdges);
    fitCameraToObject(S.currentModel, false);
    const box = new THREE.Box3().setFromObject(S.currentModel);
    setupModelShadowFrustum(box);
    if (S.groundEnabled) addGroundPlane(box);
    applyDisplayMode();
    setFileName(file.name);
    showModelInfo(S.currentModel, file.size);
    hideLoading();
  } catch (err) {
    console.error(err);
    alert(err.message || 'CAD file load failed');
    hideLoading();
    document.getElementById('empty-state')?.classList.remove('hidden');
  }
}

// ── STL loader ────────────────────────────────────────────────────────────────

export async function loadSTLFile(file, extractEdges) {
  try {
    showLoading('Parsing STL file…');
    S.parsedLayers = [];
    renderLayerUI();
    document.getElementById('file-info-content')?.classList.add('hidden');

    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    const loader  = new STLLoader();
    const buf     = await file.arrayBuffer();
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0.1 });
    const mesh     = new THREE.Mesh(geometry, material);
    mesh.name      = file.name;
    mesh.userData  = { attributes: { name: file.name, layerIndex: 0 } };

    const group = new THREE.Group();
    group.name  = file.name;
    group.add(mesh);

    clearCurrentModel();
    S.currentModel = group;
    S.scene.add(S.currentModel);
    document.getElementById('empty-state')?.classList.add('hidden');
    postProcessModel(S.currentModel, extractEdges);
    fitCameraToObject(S.currentModel, false);
    const box = new THREE.Box3().setFromObject(S.currentModel);
    setupModelShadowFrustum(box);
    if (S.groundEnabled) addGroundPlane(box);
    applyDisplayMode();
    setFileName(file.name);
    showModelInfo(S.currentModel, file.size);
    hideLoading();
  } catch (err) {
    console.error(err);
    alert('STL load failed: ' + err.message);
    hideLoading();
    document.getElementById('empty-state')?.classList.remove('hidden');
  }
}

// ── 3MF loader ────────────────────────────────────────────────────────────────

export async function load3MFFile(file, extractEdges) {
  try {
    showLoading('Parsing 3MF file…');
    S.parsedLayers = [];
    renderLayerUI();
    document.getElementById('file-info-content')?.classList.add('hidden');

    const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
    const loader = new ThreeMFLoader();
    const buf    = await file.arrayBuffer();

    const group = await new Promise((resolve, reject) => {
      loader.parse(buf, resolve, reject);
    });

    clearCurrentModel();
    S.currentModel = group;
    S.scene.add(S.currentModel);
    document.getElementById('empty-state')?.classList.add('hidden');
    postProcessModel(S.currentModel, extractEdges);
    fitCameraToObject(S.currentModel, false);
    const box = new THREE.Box3().setFromObject(S.currentModel);
    setupModelShadowFrustum(box);
    if (S.groundEnabled) addGroundPlane(box);
    applyDisplayMode();
    setFileName(file.name);
    showModelInfo(S.currentModel, file.size);
    hideLoading();
  } catch (err) {
    console.error(err);
    alert('3MF load failed: ' + err.message);
    hideLoading();
    document.getElementById('empty-state')?.classList.remove('hidden');
  }
}

// ── 3DM preprocessor (SubD → Mesh, extract annotations, layers) ──────────────

export async function preprocess3dm(file, skipLayerParse) {
  S.parsedAnnotations = [];
  S.parsed3dmFileInfo = null;
  let fileData = file;

  if (!S.rhinoInstance) return file;

  try {
    const loadingTextEl = document.getElementById('loading-text');
    if (loadingTextEl) loadingTextEl.textContent = 'Preprocessing model…';
    setProgress(10);
    const buf = await file.arrayBuffer();
    const doc = S.rhinoInstance.File3dm.fromByteArray(new Uint8Array(buf));
    if (!doc) return file;

    const safeInst = (obj, cls) => !!(cls && (obj instanceof cls));

    // ── Layer / render settings ───────────────────────────────────────────
    if (!skipLayerParse) {
      try {
        const rs = doc.settings()?.renderSettings;
        S.rhinoBackgroundColor = rs?.backgroundColor
          ? new THREE.Color(rs.backgroundColor.r / 255, rs.backgroundColor.g / 255, rs.backgroundColor.b / 255)
          : null;
        S.fileDefaultBgStyle = rs?.backgroundStyle ?? null;
      } catch { S.rhinoBackgroundColor = null; S.fileDefaultBgStyle = null; }

      try {
        const fi = doc.applicationDetails;
        if (fi) {
          const fmtDate = (d) => {
            if (!d) return null;
            try {
              if (typeof d.getFullYear === 'function') return d.toLocaleDateString();
              if (d.year) return `${d.year}-${String(d.month ?? 1).padStart(2,'0')}-${String(d.day ?? 1).padStart(2,'0')}`;
            } catch {}
            return String(d);
          };
          S.parsed3dmFileInfo = {
            applicationName: fi.applicationName || fi.ProductName || null,
            createdBy:       fi.createdBy       || fi.CreatedBy   || null,
            created:         fmtDate(fi.created  || fi.Created)   || null,
            lastEditedBy:    fi.lastEditedBy    || fi.LastEditedBy || null,
            lastEdited:      fmtDate(fi.lastEdited || fi.LastEdited) || null,
            notes:           doc.notes          || doc.Notes      || null
          };
          Object.keys(S.parsed3dmFileInfo).forEach(k => { if (!S.parsed3dmFileInfo[k]) delete S.parsed3dmFileInfo[k]; });
          if (!Object.keys(S.parsed3dmFileInfo).length) S.parsed3dmFileInfo = null;
        }
      } catch (fe) { console.warn('[pre] file info err:', fe); }

      S.parsedLayers = [];
      try {
        const layers = doc.layers();
        for (let i = 0; i < layers.count; i++) {
          const l = layers.get(i);
          S.parsedLayers.push({
            index:            l.layerIndex ?? i,
            name:             (l.fullPath?.trim()) ? l.fullPath.trim() : (l.name || `Layer ${i}`),
            color:            l.color,
            visible:          l.visible,
            parentLayerIndex: (typeof l.parentLayerIndex === 'number' && l.parentLayerIndex >= 0)
                              ? l.parentLayerIndex : -1
          });
          l.delete();
        }
      } catch (e) { console.warn('[pre] layer parse err:', e); }
      renderLayerUI();

      S.parsedNamedViews = [];
      try {
        const views = doc.views();
        for (let i = 0; i < views.count; i++) {
          const v   = views.get(i);
          const loc = v.cameraLocation;
          const up  = v.cameraUp;
          const tgt = v.cameraTarget;
          S.parsedNamedViews.push({
            name:     v.name || `Named View ${i}`,
            position: [loc.x ?? loc[0] ?? 0, loc.y ?? loc[1] ?? 0, loc.z ?? loc[2] ?? 0],
            up:       [up.x  ?? up[0]  ?? 0, up.y  ?? up[1]  ?? 1, up.z  ?? up[2]  ?? 0],
            target:   [tgt.x ?? tgt[0] ?? 0, tgt.y ?? tgt[1] ?? 0, tgt.z ?? tgt[2] ?? 0]
          });
          v.delete();
        }
        views.delete();
      } catch (e) { console.warn('[pre] named views err:', e); }
    } else {
      S.parsedLayers = [];
      renderLayerUI();
      S.parsedNamedViews = [];
    }

    // ── Build clean document (SubD removal, annotation extraction) ────────
    const cleanDoc = new S.rhinoInstance.File3dm();

    try {
      const srcLayers = doc.layers();
      for (let i = 0; i < srcLayers.count; i++) {
        const l = srcLayers.get(i);
        try { cleanDoc.layers().add(l.name, l.color); } catch {}
        l.delete();
      }
    } catch (e) { console.warn('[pre] layer copy err:', e); }

    const objects = doc.objects();
    const count   = objects.count;
    let hasSubD = false, hasAnnotation = false;

    for (let i = 0; i < count; i++) {
      let modelObj = null, geom = null, attr = null;
      try {
        modelObj = objects.get(i);
        if (!modelObj) continue;
        geom = modelObj.geometry();
        attr = modelObj.attributes();
        if (!geom) continue;

        const geomName = geom.constructor.name;

        if (safeInst(geom, S.rhinoInstance.SubD) || geomName === 'SubD') {
          hasSubD = true;
          try {
            let meshGeom = null;
            let tempSubd = geom.duplicate();
            try {
              tempSubd.subdivide(3);
              meshGeom = S.rhinoInstance.Mesh.createFromSubDControlNet(tempSubd);
            } catch {
              meshGeom = S.rhinoInstance.Mesh.createFromSubDControlNet(geom);
            }
            if (tempSubd) tempSubd.delete();
            if (meshGeom) {
              attr ? cleanDoc.objects().addMesh(meshGeom, attr) : cleanDoc.objects().addMesh(meshGeom);
              meshGeom.delete();
            }
          } catch (e) { console.warn('[pre] SubD err:', e.message); }

        } else if (safeInst(geom, S.rhinoInstance.TextDot) || geomName === 'TextDot') {
          hasAnnotation = true;
          try {
            const textVal = typeof geom.text === 'string' ? geom.text : '';
            let origin = [0, 0, 0];
            try {
              const bbox = geom.getBoundingBox();
              if (bbox?.isValid) origin = [bbox.center[0], bbox.center[1], bbox.center[2]];
            } catch {}
            try {
              if (geom.point) {
                const pt = geom.point;
                origin = [pt.x ?? pt[0] ?? origin[0], pt.y ?? pt[1] ?? origin[1], pt.z ?? pt[2] ?? origin[2]];
              }
            } catch {}
            S.parsedAnnotations.push({ type: 'TextDot', text: textVal, position: origin, layerIndex: attr?.layerIndex ?? 0 });
          } catch (e) { console.warn('[pre] TextDot err:', e.message); }

        } else if (
          safeInst(geom, S.rhinoInstance.AnnotationBase) ||
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
                if (typeof g.plainText === 'function') { try { return g.plainText(); } catch {} }
                if (typeof g.text === 'string') return g.text;
                if (typeof g.text === 'function') { try { return g.text(); } catch {} }
                if (typeof g.richText === 'string') return g.richText;
                if (typeof g.numericValue === 'number') return g.numericValue.toFixed(2);
              } catch {}
              return '';
            };
            const getPt = (val, def) => {
              if (!val) return def;
              if (Array.isArray(val)) return [val[0] ?? def[0], val[1] ?? def[1], val[2] ?? def[2]];
              return [val.x ?? val[0] ?? def[0], val.y ?? val[1] ?? def[1], val.z ?? val[2] ?? def[2]];
            };

            let textVal = getText(geom) || geomName;
            let origin = [0,0,0], xAxis = [1,0,0];
            try {
              const bbox = geom.getBoundingBox();
              if (bbox?.isValid) origin = [bbox.center[0], bbox.center[1], bbox.center[2]];
            } catch {}
            let pln = null;
            try { pln = geom.plane; } catch {}
            let loc = null;
            if (!pln) { try { loc = geom.location; } catch {} }
            if (pln) {
              try { origin = getPt(pln.origin, origin); } catch {}
              try { xAxis  = getPt(pln.xAxis,  xAxis);  } catch {}
            } else if (loc) {
              try { origin = getPt(loc, origin); } catch {}
            }
            let pt1 = null, pt2 = null;
            if (geomName.includes('Dimension')) {
              const tryPt = (g, ...props) => {
                for (const p of props) {
                  try {
                    const v = g[p];
                    if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
                  } catch {}
                }
                return null;
              };
              pt1 = tryPt(geom, 'defPt1', 'point1', 'startPoint', 'arrowPt1');
              pt2 = tryPt(geom, 'defPt2', 'point2', 'endPoint',   'arrowPt2');
            }
            S.parsedAnnotations.push({ type: 'Text', geomType: geomName, text: textVal, position: origin, xAxis, pt1, pt2, layerIndex: attr?.layerIndex ?? 0 });
          } catch (e) { console.warn('[pre] Annotation err:', e.message); }

        } else {
          try {
            attr ? cleanDoc.objects().add(geom, attr) : cleanDoc.objects().add(geom);
          } catch (e) { console.warn('[pre] add', geomName, 'err:', e.message); }
        }
      } catch (objErr) {
        console.warn('[pre] object', i, 'err:', objErr.message);
      } finally {
        try { if (geom)     geom.delete();     } catch {}
        try { if (attr)     attr.delete();     } catch {}
        try { if (modelObj) modelObj.delete(); } catch {}
      }
    }

    if (hasSubD || hasAnnotation) {
      try {
        const newBytes = cleanDoc.toByteArray();
        fileData = new Blob([newBytes], { type: 'application/octet-stream' });
      } catch (e) { console.error('[pre] export failed:', e); }
    }

    try { cleanDoc.delete(); } catch {}
    try { doc.delete();      } catch {}
  } catch (err) {
    console.error('[pre] outer error:', err);
  }

  return fileData;
}

// ── Model post-processing (called after every load) ───────────────────────────

export function postProcessModel(model, addEdgesFlag) {
  model.traverse(child => {
    if (!child.isMesh) return;
    if (child.material?.color) {
      const mc = child.material.color;
      if (mc.r < 0.02 && mc.g < 0.02 && mc.b < 0.02) child.material.color.setHex(0xffffff);
    }
    if (child.material?.color) child.userData.materialColor = child.material.color.clone();
    fixMaterialTransparency(child.material);
    child.userData.originalMaterial = child.material.clone();
    fixMaterialTransparency(child.userData.originalMaterial);

    const attrs = child.userData.attributes || {};
    const layer = S.parsedLayers.find(l => l.index === attrs.layerIndex);
    const colorSource = attrs.objectColorSource;
    const isByLayer   = (colorSource === 0 || colorSource === undefined || colorSource === null);
    child.userData.isColorByLayer = isByLayer;
    child.userData.layerColor     = layer
      ? new THREE.Color(layer.color.r/255, layer.color.g/255, layer.color.b/255)
      : null;

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
    if (shadedColor.r < 0.02 && shadedColor.g < 0.02 && shadedColor.b < 0.02) shadedColor.setHex(0xffffff);

    child.userData.shadedMaterial = new THREE.MeshStandardMaterial({
      color:      shadedColor.clone(),
      roughness:  0.8,
      metalness:  0.0,
      transparent: !!child.material.transparent,
      opacity:    child.material.opacity    ?? 1.0,
      depthWrite: child.material.depthWrite ?? true
    });
    fixMaterialTransparency(child.userData.shadedMaterial);

    child.userData.renderedMaterial = child.material.clone();
    fixMaterialTransparency(child.userData.renderedMaterial);

    if (addEdgesFlag && child.geometry) addEdges(child);
    if (S.bvhReady && child.geometry) child.geometry.computeBoundsTree();
    child.castShadow    = S.shadowsEnabled;
    child.receiveShadow = S.shadowsEnabled;
  });
}

// ── Clear / dispose current model ─────────────────────────────────────────────

export function clearCurrentModel() {
  if (!S.currentModel) return;
  // Clear selection outlines (dynamic import avoids circular at parse time)
  import('./selection.js').then(m => m.clearSelection()).catch(() => {});
  clearTechnicalOutlines();
  S.currentModel.traverse(child => {
    if (child.name === 'rhino-outline') return;
    if (child.isMesh) {
      if (S.bvhReady) child.geometry?.disposeBoundsTree?.();
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
  S.scene.remove(S.currentModel);
  S.currentModel = null;
  removeGroundPlane();

  S.hiddenObjects = new Set();

  if (S.annotationGroup) {
    S.annotationGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    });
    if (S.annotationGroup.parent) S.annotationGroup.parent.remove(S.annotationGroup);
    else S.scene.remove(S.annotationGroup);
    S.annotationGroup = null;
  }
  S.parsedAnnotations    = [];
  S.parsed3dmFileInfo    = null;
  S.rhinoBackgroundColor = null;
  S.fileDefaultBgStyle   = null;

  const bgSelReset = document.getElementById('bg-type-select');
  if (bgSelReset) bgSelReset.value = 'solid';

  const modelInfoEl = document.getElementById('file-info-content') || document.getElementById('model-info');
  if (modelInfoEl) {
    modelInfoEl.textContent = 'No model loaded.';
    modelInfoEl.classList.remove('hidden');
  }
  setFileName('Open a 3DM file…');
  document.getElementById('file-name-text')?.classList.remove('loaded');
  document.getElementById('empty-state')?.classList.remove('hidden');
  S.scene.background = null;
}

// ── Main file dispatch ────────────────────────────────────────────────────────

export async function handleFile(file, rhinoLoader, gltfLoader) {
  if (!file) return;

  resetSettingsToDefault();
  showLoading('Reading file…');
  document.getElementById('empty-state')?.classList.add('hidden');

  const fileName    = file.name.toLowerCase();
  const extractEdges = document.getElementById('chk-edges-panel')?.checked ?? true;

  if (fileName.endsWith('.glb') || fileName.endsWith('.gltf')) {
    S.parsedLayers = [];
    renderLayerUI();
    document.getElementById('file-info-content')?.classList.add('hidden');
    const url = URL.createObjectURL(file);
    gltfLoader.load(url,
      gltf => {
        URL.revokeObjectURL(url);
        clearCurrentModel();
        S.currentModel = gltf.scene;
        S.scene.add(S.currentModel);
        document.getElementById('empty-state')?.classList.add('hidden');
        postProcessModel(S.currentModel, extractEdges);
        fitCameraToObject(S.currentModel, false);
        const box = new THREE.Box3().setFromObject(S.currentModel);
        setupModelShadowFrustum(box);
        if (S.groundEnabled) addGroundPlane(box);
        applyDisplayMode();
        setFileName(file.name);
        showModelInfo(S.currentModel, file.size);
        hideLoading();
      },
      xhr => { if (xhr.total > 0) setProgress((xhr.loaded / xhr.total) * 90); },
      err => {
        console.error(err);
        alert('GLTF 파일 로드 실패');
        hideLoading();
        URL.revokeObjectURL(url);
        document.getElementById('empty-state')?.classList.remove('hidden');
      }
    );
    return;
  }

  if (fileName.endsWith('.stl')) { await loadSTLFile(file, extractEdges); return; }
  if (fileName.endsWith('.3mf')) { await load3MFFile(file, extractEdges); return; }
  if (fileName.endsWith('.stp') || fileName.endsWith('.step')) {
    await loadCADFile(file, true, extractEdges); return;
  }
  if (fileName.endsWith('.iges') || fileName.endsWith('.igs')) {
    await loadCADFile(file, false, extractEdges); return;
  }

  // ── 3DM ──────────────────────────────────────────────────────────────────
  let skipLayerParse = false;
  if (file.size > 50 * 1024 * 1024) {
    const fullLoad = window.confirm(
      `큰 파일 (${(file.size / 1048576).toFixed(0)} MB)\n\n` +
      `[확인]  전체 로드 (레이어 포함, 느림)\n` +
      `[취소]  빠른 로드 (레이어 없음)`
    );
    skipLayerParse = !fullLoad;
  }

  const processedBlob = await preprocess3dm(file, skipLayerParse);

  const loadingTextEl = document.getElementById('loading-text');
  if (loadingTextEl) loadingTextEl.textContent = 'Loading geometry…';
  setProgress(25);
  const url = URL.createObjectURL(processedBlob);

  rhinoLoader.load(
    url,
    object => {
      try {
        URL.revokeObjectURL(url);
        clearCurrentModel();
        S.currentModel = object;
        S.scene.add(S.currentModel);
        document.getElementById('empty-state')?.classList.add('hidden');
        postProcessModel(S.currentModel, extractEdges);
        applyLayerColorsToModel(S.currentModel);
        fitCameraToObject(S.currentModel, false);
        const box = new THREE.Box3().setFromObject(S.currentModel);
        setupModelShadowFrustum(box);
        if (S.groundEnabled) addGroundPlane(box);
        applyFileBackground();
        applyDisplayMode();
        createAnnotationSprites();
        renderNamedViewsUI();
        setFileName(file.name);
        showModelInfo(S.currentModel, file.size);
      } catch (postErr) {
        console.error('[load] post-processing crash:', postErr);
        alert('3DM 파일 처리 중 오류가 발생했습니다: ' + postErr.message);
        document.getElementById('empty-state')?.classList.remove('hidden');
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
      document.getElementById('empty-state')?.classList.remove('hidden');
    }
  );
}
