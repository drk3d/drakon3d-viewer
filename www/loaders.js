import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode, applyFileBackground, applyLayerColorsToModel,
         addEdges, fixMaterialTransparency, clearTechnicalOutlines } from './display.js';
import { setupModelShadowFrustum, addGroundPlane, removeGroundPlane } from './lighting.js';
import { fitCameraToObject } from './camera.js';
import { renderLayerUI, updateLayerVisibility } from './layers.js?v=1.2.88';
import { createAnnotationSprites } from './annotations.js';
import { renderNamedViewsUI } from './camera.js';
import { resetSettingsToDefault } from './session.js';
import { showLoading, hideLoading, setProgress, setFileName, showModelInfo } from './helpers.js';
import { setToolbarModelState } from './app.js?v=1.2.88';

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
    const result      = isSTEP ? occt.ReadStepFile(u8Array, {}) : occt.ReadIgesFile(u8Array, {});

    if (!result?.success) throw new Error(isSTEP ? 'STEP parsing failed' : 'IGES parsing failed');

    // Parse actual raw IGES text to retrieve levels and Name properties
    const levelNames = new Map();
    const deLevels = [];
    if (!isSTEP) {
      try {
        const text = await file.text();
        const lines = text.split(/\r?\n/);
        
        // 1. Separate D (Directory Entry) and flattening P (Parameter Data) lines
        const deLines = [];
        let cleanText = "";
        for (const line of lines) {
          const trimmed = line.trimEnd();
          const match = trimmed.match(/([SGPDT])\s*\d+\s*$/);
          if (match) {
            const section = match[1];
            const dataPart = trimmed.substring(0, match.index).padEnd(72, ' ');
            if (section === 'D') {
              deLines.push(dataPart);
            } else if (section === 'P') {
              cleanText += dataPart;
            }
          } else {
            cleanText += line;
          }
        }
        
        // 2. Find 406 Form 2 name properties: 406, 2, <level>, <len>H<name>
        const regex = /406\s*,\s*2\s*,\s*(\d+)\s*,\s*(\d+)H([^,;]+)/g;
        let match;
        while ((match = regex.exec(cleanText)) !== null) {
          const lvl = parseInt(match[1]);
          const name = match[3].trim();
          levelNames.set(lvl, name);
        }
        
        // 3. Parse DE section for independent geometry levels
        const nonGeomTypes = new Set([124, 304, 306, 308, 310, 312, 314, 402, 404, 406, 408, 410, 412, 414, 416, 418, 420]);
        for (let i = 0; i < deLines.length; i += 2) {
          const line1 = deLines[i];
          if (!line1) break;
          
          const typeStr = line1.substring(0, 8).trim();
          const entityType = parseInt(typeStr);
          
          // Columns 49-56 of Line 1: Status Number
          const statusStr = line1.substring(48, 56);
          // Columns 51-52: Subordinate Entity Switch (index 2-3 of statusStr)
          const subSwitch = statusStr.length >= 4 ? statusStr.substring(2, 4).trim() : '00';
          const isIndependent = (subSwitch === '00' || subSwitch === '0' || subSwitch === '');
          
          if (!nonGeomTypes.has(entityType) && isIndependent) {
            // Columns 33-40: Level number (Field 5) - Corrected column mapping!
            const lvlStr = line1.substring(32, 40).trim();
            const level = lvlStr ? parseInt(lvlStr) : 0;
            deLevels.push(level);
          }
        }
        console.log(`Parsed ${deLevels.length} independent geometry levels from IGES DE section.`);
      } catch (e) {
        console.warn('Failed to parse IGES levels from text:', e);
      }
    }

    setProgress(80);

    // Parse assembly hierarchy and build layers
    S.parsedLayers = [];
    let layerCounter = 0;
    let igesNodeCounter = 0;
    const meshLayerIndices = new Array(result.meshes.length).fill(0);
    const premiumPalette = [
      { r: 79,  g: 70,  b: 229 }, // Indigo
      { r: 16,  g: 185, b: 129 }, // Emerald
      { r: 245, g: 158, b: 11  }, // Amber
      { r: 239, g: 68,  b: 68  }, // Rose
      { r: 6,   g: 182, b: 212 }, // Cyan
      { r: 139, g: 92,  b: 246 }, // Violet
      { r: 236, g: 72,  b: 153 }, // Pink
      { r: 249, g: 115, b: 22  }, // Orange
      { r: 34,  g: 197, b: 94  }, // Green
      { r: 59,  g: 130, b: 246 }  // Blue
    ];

    const layerPathMap = new Map(); // fullLayerName -> layerIndex

    function traverseNode(node, parentLayerIdx = -1, path = "") {
      let nodeName = node.name || 'Default';
      let lvl = -1;

      // 1. Determine level and nodeName for IGES level mapping
      if (!isSTEP && deLevels.length > 0) {
        // IGES 독립 기하 엔티티들은 루트 바로 밑의 탑레벨 자식 노드들과 1:1로 대응됩니다.
        if (parentLayerIdx === -1) {
          lvl = deLevels[igesNodeCounter] ?? 0;
          igesNodeCounter++;
        } else {
          // 자식 노드들은 부모 노드의 Level을 그대로 물려받아 사용합니다.
          lvl = parentLayerIdx;
        }
        
        nodeName = levelNames.get(lvl) || (lvl === 0 ? 'Default' : `Layer ${String(lvl).padStart(2, '0')}`);
      } else {
        // STEP or fallback IGES without deLevels
        if (!isSTEP && nodeName.includes('(')) {
          const lvlMatch = nodeName.match(/\((\d+)\)/);
          if (lvlMatch) {
            const tempLvl = parseInt(lvlMatch[1]);
            if (levelNames.has(tempLvl)) {
              nodeName = levelNames.get(tempLvl);
            } else if (tempLvl === 0) {
              nodeName = 'Default';
            } else {
              nodeName = `Layer ${String(tempLvl).padStart(2, '0')}`;
            }
          }
        }
      }

      const fullLayerName = path ? `${path}::${nodeName}` : nodeName;
      
      let currentLayerIndex;
      if (layerPathMap.has(fullLayerName)) {
        currentLayerIndex = layerPathMap.get(fullLayerName);
      } else {
        // When doing IGES level mapping, use the actual Level number (lvl) as the index directly
        currentLayerIndex = (!isSTEP && deLevels.length > 0) ? lvl : layerCounter++;
        layerPathMap.set(fullLayerName, currentLayerIndex);
        
        let layerColor = premiumPalette[Math.abs(currentLayerIndex) % premiumPalette.length];
        if (node.meshes && node.meshes.length > 0) {
          for (const mIdx of node.meshes) {
            const meshObj = result.meshes[mIdx];
            if (meshObj && meshObj.color) {
              layerColor = {
                r: Math.round(meshObj.color[0] * 255),
                g: Math.round(meshObj.color[1] * 255),
                b: Math.round(meshObj.color[2] * 255),
                a: 255
              };
              break;
            }
          }
        }

        S.parsedLayers.push({
          index:            currentLayerIndex,
          name:             fullLayerName,
          color:            layerColor,
          visible:          true,
          parentLayerIndex: parentLayerIdx
        });
      }

      if (node.meshes) {
        for (const mIdx of node.meshes) {
          meshLayerIndices[mIdx] = currentLayerIndex;
          if (result.meshes[mIdx] && !result.meshes[mIdx].name) {
            result.meshes[mIdx].name = node.name || '';
          }
        }
      }

      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          traverseNode(child, currentLayerIndex, fullLayerName);
        }
      }
    }

    if (result.root) {
      const rootChildren = result.root.children || [];
      const rootMeshes = result.root.meshes || [];
      
      if (rootChildren.length > 0) {
        if (rootMeshes.length > 0) {
          const rootName = result.root.name || 'Root';
          traverseNode({ name: rootName, meshes: rootMeshes }, -1, "");
        }
        for (const child of rootChildren) {
          traverseNode(child, -1, "");
        }
      } else {
        traverseNode(result.root, -1, "");
      }
    } else {
      S.parsedLayers.push({
        index:            0,
        name:             'CAD_Layer',
        color:            { r: 120, g: 120, b: 120, a: 255 },
        visible:          true,
        parentLayerIndex: -1
      });
    }

    // Sort parsed layers by index to maintain neat ordering (Default/0, 1, 2...)
    if (!isSTEP) {
      S.parsedLayers.sort((a, b) => a.index - b.index);
    }

    // Refresh layer UI panel
    renderLayerUI();

    const group = new THREE.Group();
    group.name  = file.name;

    for (let i = 0; i < result.meshes.length; i++) {
      const resultMesh = result.meshes[i];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(resultMesh.attributes.position.array, 3));
      if (resultMesh.attributes.normal) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(resultMesh.attributes.normal.array, 3));
      } else {
        geometry.computeVertexNormals();
      }
      if (resultMesh.index) geometry.setIndex(new THREE.Uint32BufferAttribute(resultMesh.index.array, 1));

      const layerIdx = meshLayerIndices[i] ?? 0;
      const layer = S.parsedLayers.find(l => l.index === layerIdx);

      let color = 0xcccccc;
      if (resultMesh.color) {
        const r = Math.round(resultMesh.color[0] * 255);
        const g = Math.round(resultMesh.color[1] * 255);
        const b = Math.round(resultMesh.color[2] * 255);
        color = (r << 16) | (g << 8) | b;
      } else if (layer) {
        color = (layer.color.r << 16) | (layer.color.g << 8) | layer.color.b;
      }

      // Check if this geometry represents a 3D curve or wireframe element
      const hasNormals = resultMesh.attributes && resultMesh.attributes.normal && resultMesh.attributes.normal.array && resultMesh.attributes.normal.array.length > 0;
      const isCurve = !hasNormals || (resultMesh.name && (
        resultMesh.name.toLowerCase().includes('crv') || 
        resultMesh.name.toLowerCase().includes('curve') || 
        resultMesh.name.toLowerCase().includes('line') ||
        resultMesh.name.toLowerCase().includes('bscrv')
      ));

      let mesh;
      if (isCurve) {
        const lineMat = new THREE.LineBasicMaterial({
          color: color,
          linewidth: 2,
          depthWrite: true
        });
        if (resultMesh.index) {
          mesh = new THREE.LineSegments(geometry, lineMat);
        } else {
          mesh = new THREE.Line(geometry, lineMat);
        }
        mesh.isLine = true; // Mark as Line for display.js
      } else {
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 });
        mesh = new THREE.Mesh(geometry, material);
      }

      mesh.name      = resultMesh.name || 'CAD_Mesh';
      mesh.userData  = { attributes: { name: mesh.name, layerIndex: layerIdx } };
      group.add(mesh);
    }

    clearCurrentModel();
    S.currentModel = group;
    S.scene.add(S.currentModel);
    document.getElementById('empty-state')?.classList.add('hidden');
    setToolbarModelState(true);
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
    setToolbarModelState(true);
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
    setToolbarModelState(true);
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
  S._objLayerById = new Map();
  let fileData = file;

  // Wait up to 6 s for the rhino3dm WASM to finish initializing.
  // Without this, files opened at startup (before WASM resolves) skip
  // SubD conversion and annotation extraction entirely.
  if (!S.rhinoInstance) {
    await new Promise(resolve => {
      let waited = 0;
      const check = setInterval(() => {
        waited += 100;
        if (S.rhinoInstance || waited >= 6000) { clearInterval(check); resolve(); }
      }, 100);
    });
  }
  if (!S.rhinoInstance) return file;

  try {
    const loadingTextEl = document.getElementById('loading-text');
    if (loadingTextEl) loadingTextEl.textContent = 'Preprocessing model…';
    setProgress(10);
    const buf = await file.arrayBuffer();
    const doc = S.rhinoInstance.File3dm.fromByteArray(new Uint8Array(buf));
    if (!doc) return file;

    const safeInst = (obj, cls) => !!(cls && (obj instanceof cls));

    // ── Dimension styles ─────────────────────────────────────────────────
    // rhino3dm@8.17 exposes textHeight but NOT dimensionScale (RhinoCommon has it,
    // js bindings don't). Per-object scale override is similarly unavailable.
    // We extract what we can; effective size will be computed with a baseH floor.
    const dimStylesById = {};
    try {
      const dsTable = doc.dimstyles();
      const dsCount = dsTable?.count ?? 0;
      for (let i = 0; i < dsCount; i++) {
        const ds = dsTable.get(i);
        if (ds) {
          try {
            dimStylesById[ds.id] = {
              name:       ds.name,
              textHeight: ds.textHeight ?? 1.0
            };
          } catch {}
          try { ds.delete(); } catch {}
        }
      }
      try { dsTable.delete(); } catch {}
    } catch {}

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
            index:            l.index ?? l.layerIndex ?? i,
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
        const safePt = (v, dx = 0, dy = 0, dz = 0) => {
          if (!v) return [dx, dy, dz];
          return [
            v.X ?? v.x ?? v[0] ?? dx,
            v.Y ?? v.y ?? v[1] ?? dy,
            v.Z ?? v.z ?? v[2] ?? dz
          ];
        };
        for (let i = 0; i < views.count; i++) {
          const v   = views.get(i);
          const loc = v.cameraLocation;
          const up  = v.cameraUp;
          const tgt = v.cameraTarget;
          S.parsedNamedViews.push({
            name:     v.name || `Named View ${i}`,
            position: safePt(loc),
            up:       safePt(up, 0, 1, 0),
            target:   safePt(tgt)
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

    // Helper: extract per-object color override
    // In rhino3dm WASM, attr.colorSource is an Object (enum proxy), not a number,
    // so we can't reliably check for "ByObject" source. Instead, accept any
    // non-pure-black objectColor as an override (pure black = default unset value).
    const getObjectColor = (a) => {
      try {
        if (!a) return null;
        const c = a.objectColor;
        if (!c) return null;
        const r = c.r ?? 0, g = c.g ?? 0, b = c.b ?? 0;
        // Pure black {0,0,0} is rhino3dm's default-unset return; treat as no override
        if (r === 0 && g === 0 && b === 0) return null;
        return { r, g, b };
      } catch { return null; }
    };

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

        // Store original layerIndex by object UUID — cleanDoc.add() loses this mapping
        try {
          const id = attr?.id;
          const li = attr?.layerIndex;
          if (id && typeof li === 'number') {
            S._objLayerById = S._objLayerById || new Map();
            S._objLayerById.set(id, li);
          }
        } catch {}

        const geomName = geom.constructor.name;

        const geomNameLc = geomName.toLowerCase();
        const isSubD = safeInst(geom, S.rhinoInstance.SubD)
          || geomName === 'SubD'
          || geomNameLc.includes('subd');
        const isTextDot = safeInst(geom, S.rhinoInstance.TextDot)
          || geomName === 'TextDot'
          || geomNameLc.includes('textdot');
        const isAnnotation = (
          safeInst(geom, S.rhinoInstance.AnnotationBase)
          || geomName === 'TextEntity' || geomName === 'Text'
          || geomName === 'Dimension'  || geomNameLc.includes('dimension')
          || geomNameLc.startsWith('dim')   // DimLinear, DimAngular, DimRadial, DimOrdinate …
          || geomName === 'Leader'     || geomNameLc.includes('annotation')
          || geomNameLc.includes('leader')
        );

        if (isSubD) {
          hasSubD = true;
          try {
            let meshGeom = null;
            let tempSubd = null;
            const M = S.rhinoInstance.Mesh;
            // Mirror what THREE.js 3DMLoader does: subdivide(3) then createFromSubDControlNet(geom, false)
            try {
              tempSubd = geom.duplicate();
              tempSubd.subdivide(3);
              meshGeom = M.createFromSubDControlNet(tempSubd, false);
            } catch {
              // subdivide unavailable or failed — try control net of original as last resort
              try { meshGeom = M.createFromSubDControlNet && M.createFromSubDControlNet(geom, false); } catch {}
            }
            if (tempSubd) { try { tempSubd.delete(); } catch {} }
            if (meshGeom) {
              try {
                attr ? cleanDoc.objects().addMesh(meshGeom, attr) : cleanDoc.objects().addMesh(meshGeom);
              } catch (ae) { console.warn('[pre] SubD addMesh err:', ae.message); }
              try { meshGeom.delete(); } catch {}
            } else {
              // All conversions failed — pass SubD through so THREE.js loader can attempt it
              console.warn('[pre] SubD mesh conversion failed, passing through raw SubD');
              try {
                attr ? cleanDoc.objects().add(geom, attr) : cleanDoc.objects().add(geom);
              } catch (ae) { console.warn('[pre] SubD add err:', ae.message); }
            }
          } catch (e) { console.warn('[pre] SubD err:', e.message); }

        } else if (isTextDot) {
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
                origin = [
                  pt.X ?? pt.x ?? pt[0] ?? origin[0],
                  pt.Y ?? pt.y ?? pt[1] ?? origin[1],
                  pt.Z ?? pt.z ?? pt[2] ?? origin[2]
                ];
              }
            } catch {}
            S.parsedAnnotations.push({ type: 'TextDot', text: textVal, position: origin, layerIndex: attr?.layerIndex ?? 0, objectColor: getObjectColor(attr) });
          } catch (e) { console.warn('[pre] TextDot err:', e.message); }

        } else if (isAnnotation) {
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
              const d = def || [0, 0, 0];
              if (Array.isArray(val)) return [val[0] ?? d[0], val[1] ?? d[1], val[2] ?? d[2]];
              // rhino3dm 8.17 Point3d uses UPPERCASE X/Y/Z — also support lowercase for safety
              return [
                val.X ?? val.x ?? val[0] ?? d[0],
                val.Y ?? val.y ?? val[1] ?? d[1],
                val.Z ?? val.z ?? val[2] ?? d[2]
              ];
            };

            let textVal = getText(geom) || geomName;
            let origin = [0,0,0], xAxis = [1,0,0], yAxis = [0,1,0], zAxis = [0,0,1];
            const isNonZero = (p) => p && (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) > 1e-6);
            // Extract Rhino text height (in model units)
            let textHeight = null;
            try {
              const h = geom.textHeight ?? geom.height ?? geom.fontHeight;
              if (typeof h === 'number' && h > 0) textHeight = h;
              else if (typeof h === 'function') { const v = h(); if (v > 0) textHeight = v; }
            } catch {}
            // Detect if this is a dimension annotation.
            let isDimension = geomName.includes('Dimension');
            if (!isDimension && textVal) {
              const t = String(textVal).trim();
              if (/^-?\d+(\.\d+)?(\s*[a-zA-Z'"]*)?$/.test(t) && /\d/.test(t)) {
                isDimension = true;
              }
            }

            // ── Plane and points (rhino3dm 8.17+ exposes these directly) ──
            // DimLinear and Text both expose .plane; DimLinear also exposes .points
            // with { defpt1, defpt2, arrowpt1, arrowpt2, dimline, textpt }.
            let dimPoints = null;
            try {
              const pl = geom.plane;
              if (pl) {
                const o = getPt(pl.origin, null);
                if (isNonZero(o)) origin = o;
                const x = getPt(pl.xAxis, null);
                if (isNonZero(x)) xAxis = x;
                const y = getPt(pl.yAxis, null);
                if (isNonZero(y)) yAxis = y;
                const z = getPt(pl.zAxis, null);
                if (isNonZero(z)) zAxis = z;
              }
            } catch {}
            try {
              const pts = geom.points;
              if (pts) {
                dimPoints = {
                  defpt1:   getPt(pts.defpt1,   null),
                  defpt2:   getPt(pts.defpt2,   null),
                  arrowpt1: getPt(pts.arrowpt1, null),
                  arrowpt2: getPt(pts.arrowpt2, null),
                  dimline:  getPt(pts.dimline,  null),
                  textpt:   getPt(pts.textpt,   null)
                };
              }
            } catch {}

            // Pick the most precise textHeight available.
            // rhino3dm.js doesn't expose DimensionScale (per-style or per-object),
            // so we use the raw dimstyle textHeight. annotations.js will apply
            // a baseH-relative floor so text stays visible in larger models.
            let styleTextHeight = null;
            try {
              const styleId = geom.dimensionStyleId;
              const style   = styleId ? dimStylesById[styleId] : null;
              if (style) styleTextHeight = style.textHeight || null;
            } catch {}
            const baseTextHeight = textHeight ?? styleTextHeight ?? 1.0;

            S.parsedAnnotations.push({
              type: 'Text',
              geomType: geomName,
              isDimension,
              text: textVal,
              position: origin,
              xAxis, yAxis, zAxis,
              textHeight: baseTextHeight,
              dimPoints,
              objectColor: getObjectColor(attr),
              layerIndex: attr?.layerIndex ?? 0
            });
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
    if (child.name === 'rhino-edges' || child.name === 'rhino-outline' || child.name === 'selection-outline' || child.name === 'ground-plane') return;

    // ── Layer index synchronization for all CAD objects (including curves) ──
    if (child.userData && child.userData.attributes) {
      const attrs = child.userData.attributes;
      let realLayerIndex = attrs.layerIndex;
      try {
        if (S._objLayerById && attrs.id) {
          const li = S._objLayerById.get(attrs.id);
          if (typeof li === 'number') realLayerIndex = li;
        }
      } catch {}
      attrs.layerIndex = realLayerIndex;
    }

    if (!child.isMesh && !child.isLine) return;

    if (child.material?.color) {
      const mc = child.material.color;
      if (mc.r < 0.02 && mc.g < 0.02 && mc.b < 0.02) child.material.color.setHex(0xffffff);
    }
    if (child.material?.color) child.userData.materialColor = child.material.color.clone();
    fixMaterialTransparency(child.material);
    child.userData.originalMaterial = child.material.clone();
    fixMaterialTransparency(child.userData.originalMaterial);

    const attrs = child.userData.attributes || {};
    const realLayerIndex = attrs.layerIndex ?? 0;
    const layer = S.parsedLayers.find(l => l.index === realLayerIndex);
    const oc = attrs.objectColor;
    const hasOverrideColor = oc && (
      (oc.r ?? oc.R ?? 0) > 0 || (oc.g ?? oc.G ?? 0) > 0 || (oc.b ?? oc.B ?? 0) > 0
    );
    const isByLayer = !hasOverrideColor;
    child.userData.isColorByLayer = isByLayer;
    child.userData.layerColor = layer?.color
      ? new THREE.Color(
          (layer.color.r ?? layer.color.R ?? 0) / 255,
          (layer.color.g ?? layer.color.G ?? 0) / 255,
          (layer.color.b ?? layer.color.B ?? 0) / 255
        )
      : null;

    // Helper: extract RGB from Color object (handles both {r,g,b} and {R,G,B})
    const colRGB = (c) => c && {
      r: (c.r ?? c.R ?? 0) / 255,
      g: (c.g ?? c.G ?? 0) / 255,
      b: (c.b ?? c.B ?? 0) / 255
    };
    const shadedColor = new THREE.Color();
    if (isByLayer && layer?.color) {
      const lc = colRGB(layer.color);
      shadedColor.setRGB(lc.r, lc.g, lc.b);
    } else if (oc) {
      const c = colRGB(oc);
      shadedColor.setRGB(c.r, c.g, c.b);
    } else if (layer?.color) {
      const lc = colRGB(layer.color);
      shadedColor.setRGB(lc.r, lc.g, lc.b);
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

    if (addEdgesFlag && child.geometry && child.isMesh && !child.isLine) addEdges(child);
    if (S.bvhReady && child.geometry) child.geometry.computeBoundsTree();
    child.castShadow    = S.shadowsEnabled;
    child.receiveShadow = S.shadowsEnabled;
  });
}

// ── Clear / dispose current model ─────────────────────────────────────────────

export function clearCurrentModel() {
  if (!S.currentModel) return;
  // Clear selection outlines (dynamic import avoids circular at parse time)
  import('./selection.js?v=1.2.88').then(m => m.clearSelection()).catch(() => {});
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
  setToolbarModelState(false);
  S.scene.background = null;
}

// ── Main file dispatch ────────────────────────────────────────────────────────

export async function handleFile(file, rhinoLoader, gltfLoader) {
  if (!file) return;

  const fileName = file.name.toLowerCase();
  const supportedExtensions = ['.3dm', '.glb', '.gltf', '.stl', '.3mf', '.stp', '.step', '.iges', '.igs', '.rhinoview'];
  const hasValidExt = supportedExtensions.some(ext => fileName.endsWith(ext));
  if (!hasValidExt) {
    alert('지원되지 않는 파일 형식입니다.\n지원 포맷: .3dm, .glb, .gltf, .stl, .3mf, .stp, .step, .iges, .igs, .rhinoview');
    return;
  }

  resetSettingsToDefault();
  clearCurrentModel();
  showLoading('Reading file…');
  document.getElementById('empty-state')?.classList.add('hidden');

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
        setToolbarModelState(true);
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
        setToolbarModelState(true);
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

export async function loadGeometryFromGLB(glbBuffer, fileName, fileSize) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(glbBuffer, '', resolve, reject);
  });

  clearCurrentModel();
  S.currentModel = gltf.scene;
  S.scene.add(S.currentModel);
  document.getElementById('empty-state')?.classList.add('hidden');
  setToolbarModelState(true);
  
  const extractEdges = document.getElementById('chk-edges-panel')?.checked ?? true;
  postProcessModel(S.currentModel, extractEdges);
  fitCameraToObject(S.currentModel, false);
  const box = new THREE.Box3().setFromObject(S.currentModel);
  setupModelShadowFrustum(box);
  if (S.groundEnabled) addGroundPlane(box);
  applyDisplayMode();
  setFileName(fileName);
  showModelInfo(S.currentModel, fileSize);
}
