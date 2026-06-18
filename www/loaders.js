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
import { setToolbarModelState, changeDisplayMode } from './app.js';
import { destroyClippingCap } from './clip-cap.js';

// ── 3dm render-settings helpers ──────────────────────────────────────────────

// Convert a rhino3dm Color object {r,g,b} (0-255, sRGB) to a '#rrggbb' string.
// Direct integer → hex avoids any sRGB↔linear conversion that THREE.Color would do.
function rhinoColorToHex(c) {
  if (!c) return null;
  const clamp = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const r = clamp(c.r ?? c.R);
  const g = clamp(c.g ?? c.G);
  const b = clamp(c.b ?? c.B);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// rhino3dm enum values can be plain numbers or wrapped objects with .value
function readEnumValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.value === 'number') return v.value;
  return null;
}

// Rhino BackgroundStyle enum: 0=SolidColor, 1=Gradient(2 or 4-corner), 2=Backdrop, 3=Environment
function bgStyleEnumToName(n) {
  if (n === 0) return 'solid';
  if (n === 1) return 'gradient2';
  return null;
}

// Pull 4 corner colors from RDK XML if the file carries a 4-corner gradient.
// Returns { tl, tr, bl, br } as hex strings, or null if not found.
function extract4CornerGradient(xml) {
  if (!xml) return null;
  // Look for any block that names 4 corner colors. Rhino has historically
  // written these under names like background-color-{tl,tr,bl,br} or
  // background-gradient-color-{1..4} depending on version.
  const pat = (name) => new RegExp('<' + name + '\\b[^>]*>\\s*([0-9.,\\s]+)\\s*</' + name + '>', 'i');
  const tryNames = (names) => {
    const out = [];
    for (const n of names) {
      const m = xml.match(pat(n));
      if (!m) return null;
      const parts = m[1].split(/[,\s]+/).filter(Boolean).map(Number);
      if (parts.length < 3) return null;
      const [r, g, b] = parts;
      out.push(rhinoColorToHex({ r, g, b }));
    }
    return out;
  };
  const tl = tryNames(['background-color-top-left', 'background-color-tl']);
  if (tl) {
    const tr = tryNames(['background-color-top-right', 'background-color-tr']);
    const bl = tryNames(['background-color-bottom-left', 'background-color-bl']);
    const br = tryNames(['background-color-bottom-right', 'background-color-br']);
    if (tr && bl && br) return { tl: tl[0], tr: tr[0], bl: bl[0], br: br[0] };
  }
  const quad = tryNames([
    'background-gradient-color-1',
    'background-gradient-color-2',
    'background-gradient-color-3',
    'background-gradient-color-4'
  ]);
  if (quad) return { tl: quad[0], tr: quad[1], bl: quad[2], br: quad[3] };
  return null;
}

function extractBackgroundSettings(rs, rdkXml) {
  const topHex = rhinoColorToHex(rs.backgroundColorTop);
  const botHex = rhinoColorToHex(rs.backgroundColorBottom);
  S.fileBackgroundColorTop    = topHex;
  S.fileBackgroundColorBottom = botHex;

  const styleNum = readEnumValue(rs.backgroundStyle);
  let style = bgStyleEnumToName(styleNum);
  if (style === null) {
    // Fallback: infer from colors when the enum isn't exposed
    if (topHex && botHex && topHex !== botHex) style = 'gradient2';
    else style = 'solid';
  }

  // 4-corner gradient is not part of standard ON_3dmRenderSettings —
  // try the RDK XML; if found, upgrade style to 'gradient4'.
  const corners = extract4CornerGradient(rdkXml);
  if (corners) {
    S.fileBackgroundColorTL = corners.tl;
    S.fileBackgroundColorTR = corners.tr;
    S.fileBackgroundColorBL = corners.bl;
    S.fileBackgroundColorBR = corners.br;
    style = 'gradient4';
  } else {
    S.fileBackgroundColorTL = null;
    S.fileBackgroundColorTR = null;
    S.fileBackgroundColorBL = null;
    S.fileBackgroundColorBR = null;
  }

  S.fileDefaultBgStyle = style;
  console.log('[pre] Background:', { style, topHex, botHex, corners });
}

function extractSunSettings(rs) {
  const sun = rs.sun;
  if (sun) {
    S.fileSunEnabled   = sun.enableOn ?? false;
    S.fileSunAzimuth   = sun.azimuth ?? 135;
    S.fileSunElevation = sun.altitude ?? 45;
    S.fileSunIntensity = sun.intensity ?? 1.8;
  } else {
    S.fileSunEnabled   = null;
    S.fileSunAzimuth   = null;
    S.fileSunElevation = null;
    S.fileSunIntensity = null;
  }
}

function extractGroundSettings(rs) {
  const gp = rs.groundPlane;
  S.fileGroundEnabled = gp ? (gp.enabled ?? false) : null;
}

// Rhino's Skylight Intensity slider is stored as the HDR texture `multiplier`
// inside the environment that the skylight references — NOT in the <skylight>
// block or in rhino3dm's sky.shadowIntensity (which is a separate "shadow
// strength" value, almost always 1.0).
//
// Reading path:
//   1. <skylight-custom-environment type="uuid">UUID</skylight-custom-environment>
//   2. <environment ... instance-id="UUID"> ... </environment>
//   3. inside <texture> ... <multiplier type="double">VALUE</multiplier>
//
// We try this path first and fall back to rhino3dm's sky.shadowIntensity, then 1.0.
function extractSkylightAndAmbient(rs, rdkXml) {
  const sky = rs.skylight;
  const skyEnabled = !!(sky && sky.enabled);

  let skyIntensity = null;
  let source = 'fallback';

  // 1. Preferred: read the env-texture multiplier referenced by the skylight.
  if (rdkXml) {
    try {
      const uuidMatch = rdkXml.match(/<skylight-custom-environment\b[^>]*>\s*([0-9A-Fa-f\-]+)\s*<\/skylight-custom-environment>/i);
      if (uuidMatch) {
        const uuid = uuidMatch[1];
        // Locate the matching <environment ... instance-id="UUID"> ... </environment> block.
        // The attribute uses escaped quotes — match instance-id="UUID" case-insensitive.
        const envRegex = new RegExp(
          '<environment\\b[^>]*instance-id="' + uuid.replace(/[-]/g, '\\-') + '"[^>]*>([\\s\\S]*?)<\\/environment>',
          'i'
        );
        const envMatch = rdkXml.match(envRegex);
        if (envMatch) {
          const envInner = envMatch[1];
          // Look for the multiplier inside the texture's parameters (either the
          // v8 form <parameter name="multiplier"> or the plain <multiplier> tag).
          const multMatch =
            envInner.match(/<parameter\s+name="multiplier"\s+type="double"[^>]*>\s*([0-9.eE+\-]+)\s*<\/parameter>/i) ||
            envInner.match(/<multiplier\b[^>]*type="double"[^>]*>\s*([0-9.eE+\-]+)\s*<\/multiplier>/i);
          if (multMatch) {
            const v = parseFloat(multMatch[1]);
            if (!isNaN(v)) { skyIntensity = v; source = 'env-texture-multiplier'; }
          }
        }
      }
    } catch (e) {
      console.warn('[pre] skylight env-multiplier parse error:', e);
    }
  }

  // 2. Legacy fallback: rhino3dm's sky.shadowIntensity. This is technically
  //    "skylight shadow strength" not "intensity" but is the only value rhino3dm
  //    exposes when the env-texture multiplier can't be located.
  if (skyIntensity === null && sky && typeof sky.shadowIntensity === 'number') {
    skyIntensity = sky.shadowIntensity;
    source = 'sky.shadowIntensity';
  }

  const FALLBACK = 1.0;
  const intensity = (typeof skyIntensity === 'number' && !isNaN(skyIntensity))
    ? skyIntensity
    : FALLBACK;
  if (skyIntensity === null) source = 'fallback-1.0';

  S.fileSkylightEnabled   = skyEnabled;
  S.fileSkylightIntensity = intensity;
  // Ambient is intentionally NOT mirrored from Skylight. Three.js's PBR pipeline
  // already gets the bulk of indirect light from scene.environment (driven by
  // sl-env-intensity), so mirroring Skylight onto AmbientLight too caused dark
  // dielectrics like #1c1c1c to render ~2x brighter than their swatch. A small
  // fixed default lifts shadowed faces without washing out blacks.
  S.fileAmbientIntensity  = 0.4;

  console.log('[pre] Skylight:', { enabled: skyEnabled, intensity, source, ambientDefault: 0.4 });
}

function resetFileRenderSettings() {
  S.fileBackgroundColorTop    = null;
  S.fileBackgroundColorBottom = null;
  S.fileBackgroundColorTL = null;
  S.fileBackgroundColorTR = null;
  S.fileBackgroundColorBL = null;
  S.fileBackgroundColorBR = null;
  S.fileDefaultBgStyle  = null;
  S.fileSunEnabled      = null;
  S.fileSunAzimuth      = null;
  S.fileSunElevation    = null;
  S.fileSunIntensity    = null;
  S.fileGroundEnabled   = null;
  S.fileAmbientIntensity  = null;
  S.fileSkylightEnabled   = null;
  S.fileSkylightIntensity = null;
}

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
    S.modelUnit = 'Millimeters';
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
      const isCurve = (!hasNormals && !resultMesh.index) || (resultMesh.name && (
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
    applyFileBackground();
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
    S.modelUnit = 'Millimeters / Unitless';
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
    applyFileBackground();
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
    S.modelUnit = 'Millimeters';
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
    applyFileBackground();
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
  S._instanceLayerByPos = new Map();
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

      // Extract style properties including textHeight and Font (bold state)
      const dimStylesById = {};
      try {
        const dsTable = doc.dimstyles();
        const dsCount = dsTable?.count ?? 0;
        for (let i = 0; i < dsCount; i++) {
          const ds = dsTable.get(i);
          if (ds) {
            try {
              let isBold = false;
              let fontName = '';
              try {
                if (typeof ds.getFont === 'function') {
                  const font = ds.getFont();
                  if (font) {
                    isBold = font.bold ?? false;
                    fontName = font.quartetName || font.faceName || font.familyName || '';
                    try { font.delete(); } catch {}
                  }
                }
              } catch (fontErr) {
                console.warn('[pre] font extraction err for style:', ds.name, fontErr);
              }
              
              const styleId = String(ds.id).toLowerCase();
              const parentId = ds.parentId ? String(ds.parentId).toLowerCase() : null;

              dimStylesById[styleId] = {
                id:         ds.id,
                name:       ds.name,
                textHeight: typeof ds.textHeight === 'number' ? ds.textHeight : 1.0,
                parentId:   parentId,
                isBold:     isBold,
                fontName:   fontName
              };
            } catch (styleErr) {
              console.warn('[pre] style extraction err:', styleErr);
            }
            try { ds.delete(); } catch {}
          }
        }
        try { dsTable.delete(); } catch {}
      } catch (dsErr) {
        console.warn('[pre] dimstyles table err:', dsErr);
      }

    // ── Layer / render settings ───────────────────────────────────────────
    if (!skipLayerParse) {
      try {
        const settings = doc.settings();
        const rs = (settings && typeof settings.renderSettings === 'function') ? settings.renderSettings() : null;
        const rdkXml = (typeof doc.rdkXml === 'function') ? (doc.rdkXml() || '') : '';

        if (rs) {
          extractBackgroundSettings(rs, rdkXml);
          extractSunSettings(rs);
          extractGroundSettings(rs);
          extractSkylightAndAmbient(rs, rdkXml);
        }
      } catch (rsErr) {
        console.warn('[pre] render settings extraction err:', rsErr);
        resetFileRenderSettings();
      }

      try {
        const us = doc.settings()?.modelUnitSystem;
        if (us !== undefined && us !== null) {
          let foundName = null;
          if (S.rhinoInstance && S.rhinoInstance.UnitSystem) {
            for (const key in S.rhinoInstance.UnitSystem) {
              if (S.rhinoInstance.UnitSystem[key] === us || 
                  (us.value !== undefined && S.rhinoInstance.UnitSystem[key]?.value === us.value)) {
                foundName = key;
                break;
              }
            }
          }
          if (foundName) {
            const nameMap = {
              'None': 'None',
              'Angstroms': 'Angstroms',
              'Nanometers': 'Nanometers',
              'Microns': 'Microns',
              'Millimeters': 'mm',
              'Centimeters': 'cm',
              'Decimeters': 'dm',
              'Meters': 'm',
              'Dekameters': 'Dekameters',
              'Hectometers': 'Hectometers',
              'Kilometers': 'km',
              'Megameters': 'Megameters',
              'Gigameters': 'Gigameters',
              'Inches': 'in',
              'Feet': 'ft',
              'Yards': 'yd',
              'Miles': 'mi',
              'PrinterPoints': 'pt',
              'PrinterPicas': 'pc',
              'NauticalMiles': 'Nautical Miles',
              'AstronomicalUnits': 'AU',
              'LightYears': 'Light Years',
              'Parsecs': 'Parsecs',
              'CustomUnits': 'Custom'
            };
            S.modelUnit = nameMap[foundName] || foundName;
          } else {
            // Numeric or direct value fallback
            const val = (typeof us === 'number') ? us : (typeof us.value === 'number') ? us.value : null;
            if (val !== null) {
              const unitMap = {
                0: 'None', 1: 'Angstroms', 2: 'Nanometers', 3: 'Microns', 4: 'mm',
                5: 'cm', 6: 'dm', 7: 'm', 8: 'Dekameters', 9: 'Hectometers',
                10: 'km', 11: 'Megameters', 12: 'Gigameters', 13: 'in', 14: 'ft',
                15: 'yd', 16: 'mi', 17: 'pt', 18: 'pc', 19: 'Nautical Miles',
                20: 'AU', 21: 'Light Years', 22: 'Parsecs', 23: 'Custom'
              };
              S.modelUnit = unitMap[val] || `Unknown (${val})`;
            } else {
              S.modelUnit = us.name || String(us);
            }
          }
        } else {
          S.modelUnit = 'Unknown';
        }
      } catch (err) {
        S.modelUnit = 'Unknown';
        console.warn('[pre] unit system err:', err);
      }

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
        // ── Build material lookup table from doc.materials() ─────────────────
        const matLookup = {};
        try {
          const mats = doc.materials();
          if (mats) {
            for (let mi = 0; mi < mats.count; mi++) {
              const m = mats.get(mi);
              if (!m) continue;

              // Check if physicallyBased is supported
              let isPbrSupported = false;
              let pbr = null;
              try {
                const pb = m.physicallyBased();
                if (pb && pb.supported) {
                  isPbrSupported = true;
                  pbr = pb;
                }
              } catch {}

              // Extract base color — PBR base color may be white (#ffffff)
              // so we preserve white. Only skip pure black (0,0,0) which means "unset".
              let mColor = null;
              if (isPbrSupported && pbr) {
                try {
                  const bc = pbr.baseColor;
                  if (bc) {
                    const r = Math.round((bc.r ?? bc.R ?? 0) * 255);
                    const g = Math.round((bc.g ?? bc.G ?? 0) * 255);
                    const b = Math.round((bc.b ?? bc.B ?? 0) * 255);
                    const isUnset = r < 3 && g < 3 && b < 3;
                    if (!isUnset) mColor = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
                  }
                } catch {}
              } else {
                try {
                  const dc = m.diffuseColor;
                  if (dc) {
                    const r = dc.r ?? dc.R ?? 0;
                    const g = dc.g ?? dc.G ?? 0;
                    const b = dc.b ?? dc.B ?? 0;
                    // Only skip black (truly unset — Rhino default color)
                    const isUnset = r < 3 && g < 3 && b < 3;
                    if (!isUnset) mColor = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
                  }
                } catch {}
              }

              // Extract transparency/opacity
              let mOpacity = 1.0;
              if (isPbrSupported && pbr) {
                try {
                  const op = pbr.opacity;
                  if (typeof op === 'number' && op >= 0 && op <= 1) mOpacity = op;
                } catch {}
              } else {
                try {
                  const t = m.transparency;
                  if (typeof t === 'number' && t >= 0 && t <= 1) mOpacity = 1.0 - t;
                } catch {}
              }

              // Extract roughness:
              // Rhino Physically Based materials store roughness DIRECTLY in reflectionGlossiness
              // (0.0 = smooth, 1.0 = rough) — do NOT invert.
              // Legacy Blinn-Phong materials store "glossiness" (inverse) there, but PBR is far more common.
              let mRoughness = 0.5;
              if (isPbrSupported && pbr) {
                try {
                  const r = pbr.roughness;
                  if (typeof r === 'number' && r >= 0 && r <= 1) mRoughness = r;
                } catch {}
              } else {
                try {
                  const rg = m.reflectionGlossiness;
                  if (typeof rg === 'number' && rg >= 0 && rg <= 1) mRoughness = rg;
                } catch {}
              }

              // Metalness via shine intensity — shine=255 → metalness=1.0
              let mMetalness = 0.0;
              if (isPbrSupported && pbr) {
                try {
                  const met = pbr.metallic;
                  if (typeof met === 'number' && met >= 0 && met <= 1) mMetalness = met;
                } catch {}
              } else {
                try {
                  const shine = m.shine;
                  if (typeof shine === 'number' && shine > 0) mMetalness = Math.min(shine / 255, 1.0);
                  // PBR materials sometimes expose reflectivity directly
                  if (mMetalness < 0.01) {
                    const ref = m.reflectivity;
                    if (typeof ref === 'number' && ref > 0) mMetalness = Math.min(ref, 1.0);
                  }
                } catch {}
              }

              const matEntry = { color: mColor, roughness: mRoughness, metalness: mMetalness, opacity: mOpacity };
              // Always key by table position (renderMaterialIndex usually equals position).
              matLookup[mi] = matEntry;
              // Also key by the material's own index property as a fallback for documents
              // where the two diverge (e.g. legacy files with non-contiguous indices).
              try {
                const ownIdx = m.materialIndex ?? m.index;
                if (typeof ownIdx === 'number' && ownIdx >= 0 && ownIdx !== mi) {
                  matLookup[ownIdx] = matEntry;
                }
              } catch {}
              try { m.delete(); } catch {}
            }
            try { mats.delete(); } catch {}
          }
        } catch (me) { console.warn('[pre] material table parse err:', me); }

        const layers = doc.layers();
        for (let i = 0; i < layers.count; i++) {
          const l = layers.get(i);
          const col = l.color;
          const plainColor = col ? {
            r: col.r ?? col.R ?? 0,
            g: col.g ?? col.G ?? 0,
            b: col.b ?? col.B ?? 0,
            a: col.a ?? col.A ?? 255
          } : { r: 200, g: 200, b: 200, a: 255 };

          // Check if this layer has a material assigned
          let layerCustomMaterial = null;
          try {
            const rmi = l.renderMaterialIndex;
            if (typeof rmi === 'number' && rmi >= 0 && matLookup[rmi]) {
              layerCustomMaterial = { ...matLookup[rmi] };
              // If material has no custom color, fall back to layer color
              if (!layerCustomMaterial.color) {
                layerCustomMaterial.color = `#${plainColor.r.toString(16).padStart(2,'0')}${plainColor.g.toString(16).padStart(2,'0')}${plainColor.b.toString(16).padStart(2,'0')}`;
              }
            }
          } catch {}
          S.parsedLayers.push({
            index:            l.index ?? l.layerIndex ?? i,
            name:             (l.fullPath?.trim()) ? l.fullPath.trim() : (l.name || `Layer ${i}`),
            color:            plainColor,
            visible:          l.visible,
            parentLayerIndex: (typeof l.parentLayerIndex === 'number' && l.parentLayerIndex >= 0)
                              ? l.parentLayerIndex : -1,
            customMaterial:         layerCustomMaterial,                                  // null if no layer material assigned
            // Snapshot of the layer material as loaded from the 3DM file — never mutated
            // after this point, so the Reset button can restore exactly the on-disk values.
            originalCustomMaterial: layerCustomMaterial ? { ...layerCustomMaterial } : null
          });
          l.delete();
        }
      } catch (e) { console.warn('[pre] layer parse err:', e); }
      renderLayerUI();

      S.parsedNamedViews = [];
      try {
        const views = doc.namedViews();
        const safePt = (v, dx = 0, dy = 0, dz = 0) => {
          if (!v) return [dx, dy, dz];
          return [
            v.X ?? v.x ?? v[0] ?? dx,
            v.Y ?? v.y ?? v[1] ?? dy,
            v.Z ?? v.z ?? v[2] ?? dz
          ];
        };
        for (let i = 0; i < views.count; i++) {
          let v = null;
          let vp = null;
          try {
            v = views.get(i);
            if (!v) continue;
            vp = v.getViewport();
            if (!vp) {
              v.delete();
              continue;
            }
            const loc = vp.cameraLocation;
            const up  = vp.cameraUp;
            const tgt = vp.targetPoint;
            const dir = vp.cameraDirection;
            
            const isUnsetVal = (val) => {
              if (val === undefined || val === null) return true;
              if (typeof val === 'number') {
                return val < -1e300 || val > 1e300 || isNaN(val);
              }
              if (Array.isArray(val)) {
                return val.some(isUnsetVal);
              }
              const x = val.X ?? val.x ?? val[0];
              const y = val.Y ?? val.y ?? val[1];
              const z = val.Z ?? val.z ?? val[2];
              return isUnsetVal(x) || isUnsetVal(y) || isUnsetVal(z);
            };

            const pLoc = safePt(loc);
            const pDir = safePt(dir, 0, 0, -1);
            
            // Check if looking straight up or down (parallel to Z axis)
            const isVerticalLook = Math.abs(pDir[0]) < 0.01 && Math.abs(pDir[1]) < 0.01;
            
            let finalUp = [0, 0, 1];
            if (isVerticalLook) {
              const parsedUp = safePt(up, 0, 1, 0);
              const len = Math.hypot(parsedUp[0], parsedUp[1]);
              if (len > 0.001) {
                finalUp = [parsedUp[0] / len, parsedUp[1] / len, 0];
              } else {
                finalUp = [0, 1, 0];
              }
            } else {
              // For all non-vertical views, force the global Z-up vector [0, 0, 1].
              // This guarantees that OrbitControls orbits around the Z-axis, keeping the ground plane horizontal.
              finalUp = [0, 0, 1];
            }

            let parsedTgt = safePt(tgt);
            if (isUnsetVal(parsedTgt)) {
              let dist = 100;
              try {
                if (typeof vp.targetDistance === 'function') {
                  const d = vp.targetDistance(true);
                  if (!isUnsetVal(d)) dist = d;
                }
              } catch (e) {
                console.warn('[pre] targetDistance calculation failed:', e);
              }
              parsedTgt = [
                pLoc[0] + pDir[0] * dist,
                pLoc[1] + pDir[1] * dist,
                pLoc[2] + pDir[2] * dist
              ];
            }

            S.parsedNamedViews.push({
              name:     v.name || `Named View ${i}`,
              position: pLoc,
              up:       finalUp,
              target:   parsedTgt
            });
          } catch (itemErr) {
            console.warn(`[pre] failed to parse named view at index ${i}:`, itemErr);
          } finally {
            if (vp && typeof vp.delete === 'function') {
              try { vp.delete(); } catch {}
            }
            if (v && typeof v.delete === 'function') {
              try { v.delete(); } catch {}
            }
          }
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
      // Copy layers using the Layer-object overload so parentLayerId, color,
      // visibility, and other properties survive the rebuild. The old call
      // `add(l.name, l.color)` silently dropped everything except the first
      // layer, collapsing the hierarchy and forcing all block-content
      // geometry onto layer 0 (Default) — which rendered as flat gray
      // because layer 0's color is black.
      const srcLayers = doc.layers();
      for (let i = 0; i < srcLayers.count; i++) {
        const l = srcLayers.get(i);
        try { cleanDoc.layers().add(l); } catch (le) { console.warn('[pre] layer add err:', le); }
        l.delete();
      }
    } catch (e) { console.warn('[pre] layer copy err:', e); }

    try {
      const srcMaterials = doc.materials();
      if (srcMaterials) {
        for (let i = 0; i < srcMaterials.count; i++) {
          const mat = srcMaterials.get(i);
          try { cleanDoc.materials().add(mat); } catch {}
          mat.delete();
        }
      }
    } catch (e) { console.warn('[pre] material copy err:', e); }

    try {
      const srcEmbeddedFiles = doc.embeddedFiles();
      if (srcEmbeddedFiles) {
        for (let i = 0; i < srcEmbeddedFiles.count; i++) {
          const ef = srcEmbeddedFiles.get(i);
          try { cleanDoc.embeddedFiles().add(ef); } catch {}
          ef.delete();
        }
      }
    } catch (e) { console.warn('[pre] embeddedFiles copy err:', e); }

    try {
      const srcBitmaps = doc.bitmaps();
      if (srcBitmaps) {
        for (let i = 0; i < srcBitmaps.count; i++) {
          const bm = srcBitmaps.get(i);
          try { cleanDoc.bitmaps().add(bm); } catch {}
          bm.delete();
        }
      }
    } catch (e) { console.warn('[pre] bitmaps copy err:', e); }

    // Build a map of idefId → its member object IDs once. We need this for
    // recursive flattening below, where one block's flatten may need to look
    // up another block's members.
    const idefMembersMap = new Map();
    try {
      const tmpDefs = doc.instanceDefinitions();
      for (let i = 0; i < tmpDefs.count; i++) {
        const tmpIdef = tmpDefs.get(i);
        if (tmpIdef) {
          const tmpIds = tmpIdef.getObjectIds() || [];
          idefMembersMap.set(String(tmpIdef.id).toLowerCase(), Array.from(tmpIds));
          tmpIdef.delete();
        }
      }
    } catch (e) { console.warn('[pre] idef members map err:', e); }

    // Recursively flatten an instance definition: nested InstanceReference
    // members are expanded into transformed clones of the referenced block's
    // contents. Three.js's Rhino3dmLoader treats nesting as flat — a nested
    // iRef is placed at the scene root with only its LOCAL xform, which makes
    // it appear at the wrong world position. Flattening every block to direct
    // geometry sidesteps that limitation.
    const flattenIdef = (idefId, depth = 0) => {
      const geomArr = [];
      const attrArr = [];
      if (depth > 30) {
        console.warn('[pre] flatten depth limit reached at', idefId);
        return { geomArr, attrArr };
      }
      const memberIds = idefMembersMap.get(String(idefId).toLowerCase()) || [];
      for (const memberId of memberIds) {
        const modelObj = doc.objects().findId(memberId);
        if (!modelObj) continue;
        const g = modelObj.geometry();
        const a = modelObj.attributes();
        try {
          if (g && g.constructor.name === 'InstanceReference') {
            const childIdefId = g.parentIdefId;
            const xform = g.xform;
            if (childIdefId && xform) {
              const sub = flattenIdef(childIdefId, depth + 1);
              for (let k = 0; k < sub.geomArr.length; k++) {
                try { sub.geomArr[k].transform(xform); } catch (te) { console.warn('[pre] flatten transform err:', te.message); }
                geomArr.push(sub.geomArr[k]);
                attrArr.push(sub.attrArr[k]);
              }
            }
          } else if (g && a) {
            const clone = (typeof g.duplicate === 'function') ? g.duplicate() : null;
            if (clone) { geomArr.push(clone); attrArr.push(a); a !== null && (modelObj._keepAttr = true); }
          }
        } catch (e) { console.warn('[pre] flatten member err:', e.message); }
        try { if (g) g.delete(); } catch {}
        // attr is either pushed to attrArr (keep alive) or unused (free it)
        if (!modelObj._keepAttr) { try { if (a) a.delete(); } catch {} }
        try { modelObj.delete(); } catch {}
      }
      return { geomArr, attrArr };
    };

    const idefIdMap = new Map();
    try {
      const srcDefinitions = doc.instanceDefinitions();
      if (srcDefinitions) {
        for (let i = 0; i < srcDefinitions.count; i++) {
          const idef = srcDefinitions.get(i);
          if (idef) {
            const name = idef.name || `Block_${i}`;
            const description = idef.description || "";
            const oldId = idef.id;

            let url = "";
            let urlTag = "";
            try { url = idef.url || ""; } catch {}
            try { urlTag = idef.urlTag || ""; } catch {}

            const basePoint = [0, 0, 0];
            try {
              const bp = idef.basePoint;
              if (bp) {
                basePoint[0] = bp.X ?? bp.x ?? 0;
                basePoint[1] = bp.Y ?? bp.y ?? 0;
                basePoint[2] = bp.Z ?? bp.z ?? 0;
              }
            } catch {}

            const { geomArr: geometryArray, attrArr: attributesArray } = flattenIdef(oldId);

            try {
              const cleanIdx = cleanDoc.instanceDefinitions().add(name, description, url, urlTag, basePoint, geometryArray, attributesArray);
              if (cleanIdx >= 0) {
                const cleanIdef = cleanDoc.instanceDefinitions().get(cleanIdx);
                if (cleanIdef) {
                  const newId = cleanIdef.id;
                  if (oldId && newId) idefIdMap.set(oldId, newId);
                  try { cleanIdef.delete(); } catch {}
                }
              }
            } catch (errAdd) {
              console.warn('[pre] cleanDoc.instanceDefinitions.add err:', errAdd);
            } finally {
              geometryArray.forEach(g => { try { g.delete(); } catch {} });
              attributesArray.forEach(a => { if (a) { try { a.delete(); } catch {} } });
            }
          }
          idef.delete();
        }
      }
    } catch (e) { console.warn('[pre] instanceDefinitions copy err:', e); }

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
    let hasSubD = false, hasAnnotation = false, hasLayoutObject = false;

    for (let i = 0; i < count; i++) {
      let modelObj = null, geom = null, attr = null;
      try {
        modelObj = objects.get(i);
        if (!modelObj) continue;
        geom = modelObj.geometry();
        attr = modelObj.attributes();
        if (!geom) continue;

        // Skip objects that live on a Layout page (PageSpace) — the viewer
        // only shows the model-space scene. ActiveSpace: None=0, ModelSpace=1, PageSpace=2.
        const spaceVal = readEnumValue(attr?.activeSpace);
        if (spaceVal === 2) {
          hasLayoutObject = true;
          continue;
        }

        // Skip objects that belong to a block (instance) definition. They live
        // in doc.objects() but are NOT meant to render as standalone geometry —
        // only via InstanceReference. They've already been copied into
        // cleanDoc.instanceDefinitions() in the loop above.
        if (attr?.isInstanceDefinitionObject === true) {
          hasLayoutObject = true; // force cleanDoc rebuild
          continue;
        }

        // Store original layerIndex by object UUID — cleanDoc.add() loses this mapping
        try {
          const id = attr?.id;
          const li = attr?.layerIndex;
          if (id && typeof li === 'number') {
            S._objLayerById = S._objLayerById || new Map();
            S._objLayerById.set(id, li);
          }
        } catch {}

        // Extract user text (Attribute User Text) by object UUID for the
        // properties panel. THREE.js Rhino3dmLoader may include userStrings in
        // userData.attributes, but we pre-cache here as a reliable fallback.
        try {
          const id = attr?.id;
          if (id && typeof attr?.getUserStrings === 'function') {
            const raw = attr.getUserStrings();
            let pairs = null;
            if (Array.isArray(raw) && raw.length > 0) {
              pairs = raw.map(e => ({ key: String(e.key ?? e[0] ?? ''), value: String(e.value ?? e[1] ?? '') }));
            } else if (raw && typeof raw === 'object') {
              const entries = Object.entries(raw);
              if (entries.length > 0) pairs = entries.map(([k, v]) => ({ key: k, value: String(v) }));
            }
            if (pairs && pairs.length > 0) {
              S._objUserTextById = S._objUserTextById || new Map();
              S._objUserTextById.set(id, pairs);
            }
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
        const isInstanceReference = safeInst(geom, S.rhinoInstance.InstanceReference)
          || geomName === 'InstanceReference'
          || geomNameLc.includes('instancereference');

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
            // Extract Rhino text height (in model units) and richText properties
            let textHeight = null;
            let textHeightMultiplier = 1.0;
            let richTextStr = "";
            try {
              if (typeof geom.richText === 'string') richTextStr = geom.richText;
              else if (typeof geom.richText === 'function') richTextStr = geom.richText() || "";
              if (!richTextStr) {
                if (typeof geom.text === 'string') richTextStr = geom.text;
                else if (typeof geom.text === 'function') richTextStr = geom.text() || "";
              }
            } catch {}

            if (richTextStr) {
              try {
                // Match \H:7.0; or \h:7.0; or \H:2.0x; or \H2.0x; or \H7.0;
                let match = richTextStr.match(/\\[Hh]:?([0-9.]+)(x|X)?(?=[;\s\}]|$)/);
                if (match) {
                  const val = parseFloat(match[1]);
                  if (!isNaN(val) && val > 0) {
                    if (match[2]) textHeightMultiplier = val;
                    else textHeight = val;
                  }
                }
                if (textHeight === null && textHeightMultiplier === 1.0) {
                  // Match |h:7.0; or |h:2.0x;
                  match = richTextStr.match(/[|]h:([0-9.]+)(x|X)?(?=[;\s\}]|$)/);
                  if (match) {
                    const val = parseFloat(match[1]);
                    if (!isNaN(val) && val > 0) {
                      if (match[2]) textHeightMultiplier = val;
                      else textHeight = val;
                    }
                  }
                }
                if (textHeight === null && textHeightMultiplier === 1.0) {
                  // Match height:7.0 or height:2.0x
                  match = richTextStr.match(/height:?([0-9.]+)(x|X)?/i);
                  if (match) {
                    const val = parseFloat(match[1]);
                    if (!isNaN(val) && val > 0) {
                      if (match[2]) textHeightMultiplier = val;
                      else textHeight = val;
                    }
                  }
                }
              } catch (e) {
                console.warn('[pre] richText parse err:', e);
              }
            }

            // Manual overrides for specific text objects whose height overrides are not exposed by rhino3dm.js
            if (textVal && textHeight === null) {
              const lowerText = textVal.toLowerCase();
              if (lowerText.includes("lightweight") || lowerText.includes("viewer for rhino3d")) {
                textHeight = 2.0;
              } else if (lowerText.includes("www.byrhino3d.com") || lowerText.includes("byrhino3d.com")) {
                textHeight = 2.0;
              }
            }

            try {
              const h = geom.textHeight ?? geom.height ?? geom.fontHeight;
              if (typeof h === 'number' && h > 0) {
                if (textHeight === null) textHeight = h;
              } else if (typeof h === 'function') {
                const v = h();
                if (v > 0 && textHeight === null) textHeight = v;
              }
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

            // Check for bold styling in richText or geom font properties
            let isBold = false;
            if (richTextStr) {
              // RTF bold: \b enables bold, \b0 disables bold.
              // We need to detect \b not followed by 0 (which would be bold-off).
              // Strategy: check each occurrence of \b in the RTF string.
              const rtf = richTextStr;
              let bidx = 0;
              while ((bidx = rtf.indexOf('\\b', bidx)) !== -1) {
                const nextChar = rtf[bidx + 2];
                // \b0 = bold off, \b followed by space/brace/backslash/end = bold on
                if (nextChar !== '0') {
                  isBold = true;
                  break;
                }
                bidx += 3; // skip past \b0
              }
            }
            
            // Resolve style properties with parent style chain traversal
            let styleTextHeight = null;
            let styleIsBold = false;
            try {
              const styleId = geom.dimensionStyleId;
              if (styleId) {
                let currentId = String(styleId).toLowerCase();
                const visited = new Set();
                while (currentId && currentId !== '00000000-0000-0000-0000-000000000000') {
                  if (visited.has(currentId)) break;
                  visited.add(currentId);
                  
                  const style = dimStylesById[currentId];
                  if (!style) break;
                  
                  if (styleTextHeight === null && typeof style.textHeight === 'number' && style.textHeight > 0) {
                    styleTextHeight = style.textHeight;
                  }
                  if (style.isBold) {
                    styleIsBold = true;
                  }
                  currentId = style.parentId;
                }
              }
            } catch (styleErr) {
              console.warn('[pre] Annotation style resolution err:', styleErr);
            }

            if (styleIsBold) {
              isBold = true;
            }
            // Extract individual object dimensionScale override if present
            let geomDimScale = 1.0;
            try {
              const ds = geom.dimensionScale;
              if (typeof ds === 'number' && ds > 0) {
                geomDimScale = ds;
              } else if (typeof ds === 'function') {
                const v = ds(); if (v > 0) geomDimScale = v;
              }
            } catch {}

            // Extract scale from plane axes lengths (in case of dragging/scaling in Rhino)
            let planeScale = 1.0;
            try {
              const pl = geom.plane;
              if (pl && pl.xAxis) {
                const xx = pl.xAxis.X ?? pl.xAxis.x ?? pl.xAxis[0] ?? 1;
                const xy = pl.xAxis.Y ?? pl.xAxis.y ?? pl.xAxis[1] ?? 0;
                const xz = pl.xAxis.Z ?? pl.xAxis.z ?? pl.xAxis[2] ?? 0;
                const len = Math.sqrt(xx*xx + xy*xy + xz*xz);
                if (len > 1e-4) planeScale = len;
              }
            } catch {}

            const effectiveDimScale = geomDimScale; // styleDimScale is 1.0 as it is not present in js DimensionStyle
            const baseTextHeight = (textHeight !== null || styleTextHeight !== null) ? (textHeight ?? styleTextHeight ?? 1.0) * textHeightMultiplier * effectiveDimScale * planeScale : null;



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
              layerIndex: attr?.layerIndex ?? 0,
              isBold
            });
          } catch (e) { console.warn('[pre] Annotation err:', e.message); }

        } else if (isInstanceReference) {
          try {
            // Record the instance's xform translation → layer index so we can
            // tag the rendered iRefObject group after 3DMLoader builds it. The
            // group itself carries no Rhino attributes, so without this map we
            // can't gate its visibility on the InstanceReference's own layer
            // (e.g. hiding "1층" should hide every instance placed there).
            try {
              const xf = geom.xform;
              if (xf && attr) {
                const tx = xf.m03, ty = xf.m13, tz = xf.m23;
                if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
                  const key = `${tx.toFixed(4)},${ty.toFixed(4)},${tz.toFixed(4)}`;
                  S._instanceLayerByPos = S._instanceLayerByPos || new Map();
                  S._instanceLayerByPos.set(key, attr.layerIndex ?? 0);
                }
              }
            } catch {}

            const oldParentId = geom.parentIdefId;
            const newParentId = idefIdMap.get(oldParentId);
            if (newParentId) {
              const newRef = new S.rhinoInstance.InstanceReference(newParentId, geom.xform);
              attr ? cleanDoc.objects().add(newRef, attr) : cleanDoc.objects().add(newRef);
              try { newRef.delete(); } catch {}
            } else {
              attr ? cleanDoc.objects().add(geom, attr) : cleanDoc.objects().add(geom);
            }
          } catch (e) {
            console.warn('[pre] InstanceReference mapping err:', e.message);
            try {
              attr ? cleanDoc.objects().add(geom, attr) : cleanDoc.objects().add(geom);
            } catch (e2) {}
          }

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

    if (hasSubD || hasAnnotation || hasLayoutObject) {
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

// `colorsAreSRGBStoredAsLinear` — set true when called from the 3dm path:
// Rhino3dmLoader writes sRGB 0–1 values into material.color via setRGB(), which
// stores them WITHOUT the ColorManagement conversion. We then call
// convertSRGBToLinear() once to put the values back into the working linear
// space the renderer expects.
//
// For GLB-based loads (direct .glb/.gltf, or .rhv packages) the GLTFLoader
// already produces correctly-spaced linear colors, so the conversion would be
// a DOUBLE convert and surfaces render too dark. Pass false in those paths.
export function postProcessModel(model, addEdgesFlag, colorsAreSRGBStoredAsLinear = true) {
  // Three.js Rhino3dmLoader deduplicates materials by color via _compareMaterials,
  // so several meshes can share one Material instance. convertSRGBToLinear()
  // mutates color in place — calling it once per mesh would convert the same
  // shared color N times (compounding darkening: N=2 → 0.61 → 0.331). Tag each
  // material we touch so any later visits skip the conversion.
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

    // ── Tag iRefObject groups with the InstanceReference's own layer index
    // (3DMLoader leaves the group bare — no userData — so without this
    // updateLayerVisibility can't gate the whole instance on its own layer,
    // and turning off e.g. "1층" wouldn't hide instances placed there).
    if (!child.isMesh && !child.isLine && S._instanceLayerByPos && child.children && child.children.length > 0) {
      let hasIdefMember = false;
      for (const c of child.children) {
        if (c.userData?.attributes?.isInstanceDefinitionObject === true) {
          hasIdefMember = true;
          break;
        }
      }
      if (hasIdefMember) {
        const p = child.position;
        const key = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
        const li = S._instanceLayerByPos.get(key);
        if (typeof li === 'number') child.userData.instanceLayerIndex = li;
      }
    }

    // ── Clean up curve spikes / failed [0,0,0] evaluation chords ──────────────
    if (child.isLine && child.geometry && child.geometry.attributes.position) {

      const posAttr = child.geometry.attributes.position;
      const arr = posAttr.array;
      const count = posAttr.count;
      if (count > 2) {
        const cleanCoords = [];
        let hasSpikes = false;
        
        // Helper to check if a point is exactly or very close to [0,0,0]
        const isOrigin = (x, y, z) => Math.abs(x) < 1e-7 && Math.abs(y) < 1e-7 && Math.abs(z) < 1e-7;
        
        for (let i = 0; i < count; i++) {
          const x = arr[i * 3];
          const y = arr[i * 3 + 1];
          const z = arr[i * 3 + 2];
          
          if (isNaN(x) || isNaN(y) || isNaN(z)) {
            hasSpikes = true;
            continue;
          }
          
          if (isOrigin(x, y, z)) {
            // A point exactly at the origin is a spike if neighboring points are far from origin
            let prevFar = true;
            let nextFar = true;
            
            if (i > 0) {
              const px = arr[(i - 1) * 3];
              const py = arr[(i - 1) * 3 + 1];
              const pz = arr[(i - 1) * 3 + 2];
              if (!isOrigin(px, py, pz) && (px * px + py * py + pz * pz) < 1e-4) {
                prevFar = false; // neighbor is also very close to origin
              }
            }
            if (i < count - 1) {
              const nx = arr[(i + 1) * 3];
              const ny = arr[(i + 1) * 3 + 1];
              const nz = arr[(i + 1) * 3 + 2];
              if (!isOrigin(nx, ny, nz) && (nx * nx + ny * ny + nz * nz) < 1e-4) {
                nextFar = false; // neighbor is also very close to origin
              }
            }
            
            if (prevFar && nextFar && count > 3) {
              hasSpikes = true;
              continue; // Skip this spike point
            }
          }
          
          cleanCoords.push(x, y, z);
        }
        
        if (hasSpikes && cleanCoords.length >= 6) {
          const newArr = new Float32Array(cleanCoords);
          child.geometry.setAttribute('position', new THREE.BufferAttribute(newArr, 3));
          child.geometry.attributes.position.needsUpdate = true;
          if (child.geometry.computeBoundingBox) child.geometry.computeBoundingBox();
          if (child.geometry.computeBoundingSphere) child.geometry.computeBoundingSphere();
        }
      }
    }

    if (!child.isMesh && !child.isLine) return;

    if (child.material?.color) {
      const mat = child.material;
      // Tag the material so repeated visits (3DMLoader's _compareMaterials
      // shares one Material across N meshes) don't convert the SAME color
      // object multiple times — compounding darkening (N=2 → 0.61 → 0.331).
      if (!mat.userData?.__sRGBPostProcessed) {
        mat.userData = mat.userData || {};
        mat.userData.__sRGBPostProcessed = true;
        const mc = mat.color;
        // Pure-black-to-white safety check first — a pitch-black PBR mesh
        // receives no diffuse lighting and reads as invisible blobs.
        if (mc.r < 0.02 && mc.g < 0.02 && mc.b < 0.02) {
          mat.color.set('#ffffff');
        } else if (colorsAreSRGBStoredAsLinear) {
          // 3dm path: Rhino3dmLoader stored sRGB values raw via setRGB(), so
          // we convert them to true linear here. Skipped for GLB-based paths
          // where GLTFLoader already produced linear values.
          mat.color.convertSRGBToLinear();
        }
        if (mat.emissive && colorsAreSRGBStoredAsLinear) {
          mat.emissive.convertSRGBToLinear();
        }
        // Fix texture color spaces for 3DM loading path
        if (colorsAreSRGBStoredAsLinear) {
          const colorMaps = ['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'];
          colorMaps.forEach(mapName => {
            if (mat[mapName] && mat[mapName].colorSpace !== THREE.SRGBColorSpace) {
              mat[mapName].colorSpace = THREE.SRGBColorSpace;
              mat[mapName].needsUpdate = true;
            }
          });
        }
      }
    }
    if (child.material?.color) child.userData.materialColor = child.material.color.clone();
    fixMaterialTransparency(child.material);
    child.userData.originalMaterial = child.material.clone();
    fixMaterialTransparency(child.userData.originalMaterial);

    const attrs = child.userData.attributes || {};
    const realLayerIndex = attrs.layerIndex ?? 0;
    const layer = S.parsedLayers.find(l => l.index === realLayerIndex);
    const oc = attrs.objectColor;

    // Check if color is set to ByLayer (0), ByObject (1), or ByMaterial (2).
    const getColorSourceValue = (cs) => {
      if (cs === undefined || cs === null) return 0; // Default to ByLayer
      if (typeof cs === 'number') return cs;
      if (typeof cs === 'object' && typeof cs.value === 'number') return cs.value;
      return 0;
    };
    const csVal = getColorSourceValue(attrs.colorSource);
    const isByLayer = csVal === 0;
    const isByObject = csVal === 1;
    const isByMaterial = csVal === 2;

    child.userData.isColorByLayer = isByLayer;
    // Use .set(hex) so Three.js r169 ColorManagement converts sRGB→linear correctly.
    child.userData.layerColor = layer?.color
      ? new THREE.Color().set(
          '#' + [
            layer.color.r ?? layer.color.R ?? 0,
            layer.color.g ?? layer.color.G ?? 0,
            layer.color.b ?? layer.color.B ?? 0
          ].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
        )
      : null;

    // ── Material source: ByLayer = 0, ByObject/explicit = 1+ ─────────────────
    // MaterialSource 0 (MaterialFromLayer) means the object has no direct material
    // assignment and should inherit the layer's customMaterial in rendered mode.
    const getMaterialSourceValue = (ms) => {
      if (ms === undefined || ms === null) return 0; // Default to MaterialFromLayer
      if (typeof ms === 'number') return ms;
      if (typeof ms === 'object' && typeof ms.value === 'number') return ms.value;
      return 0;
    };
    const msVal = getMaterialSourceValue(attrs.materialSource);
    const matFromLayer = (msVal === 0);
    child.userData.isMaterialByLayer = matFromLayer && !child.userData.customMaterial;
    // Preserve the original Rhino MaterialSource so Reset can restore it.
    child.userData.originalIsMaterialByLayer = matFromLayer;

    // Helper: extract RGB from Color object (handles both {r,g,b} and {R,G,B})
    const colRGB = (c) => c && {
      r: (c.r ?? c.R ?? 0) / 255,
      g: (c.g ?? c.G ?? 0) / 255,
      b: (c.b ?? c.B ?? 0) / 255
    };
    // toSRGBHex: build a '#rrggbb' string from 0–255 components so .set() can
    // apply the correct sRGB→linear conversion expected by Three.js r169.
    const toSRGBHex = (c) => '#' + [
      c.r ?? c.R ?? 0,
      c.g ?? c.G ?? 0,
      c.b ?? c.B ?? 0
    ].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

    const shadedColor = new THREE.Color();
    if (isByMaterial && child.material?.color) {
      shadedColor.copy(child.material.color);
    } else if (isByObject && oc) {
      shadedColor.set(toSRGBHex(oc));
    } else if (isByLayer && layer?.color) {
      shadedColor.set(toSRGBHex(layer.color));
    } else if (child.material?.color) {
      shadedColor.copy(child.material.color);
    } else if (layer?.color) {
      shadedColor.set(toSRGBHex(layer.color));
    } else {
      shadedColor.setHex(0xffffff);
    }
    if (child.isMesh && shadedColor.r < 0.02 && shadedColor.g < 0.02 && shadedColor.b < 0.02) {
      shadedColor.setHex(0xffffff);
    }

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
    // BVH is triangle-based — running it on Line geometry reorders the index
    // buffer as if it were triangles, corrupting LINE_STRIP vertex order and
    // producing dashed/zigzag curves.
    if (S.bvhReady && child.geometry && child.isMesh && !child.isLine) child.geometry.computeBoundsTree();
    child.castShadow    = S.shadowsEnabled;
    child.receiveShadow = S.shadowsEnabled;
  });
}

// ── Clear / dispose current model ─────────────────────────────────────────────

export function clearCurrentModel() {
  if (!S.currentModel) return;

  S.clippingToggleOn = false;
  S.clippingHasBeenInitialized = false;
  S.clippingEnabled = false;
  S.clippingPosition = null;
  S.clippingQuaternion = null;
  if (S.renderer) S.renderer.clippingPlanes = [];
  if (window.deactivateClippingHelper) window.deactivateClippingHelper();
  destroyClippingCap();

  // Clear selection outlines (dynamic import avoids circular at parse time)
  import('./selection.js').then(m => m.clearSelection()).catch(() => {});
  import('./history.js').then(m => m.History.clear()).catch(() => {});
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
  S.currentFileHandle    = null;
  resetFileRenderSettings();

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

export async function handleFile(file, rhinoLoader, gltfLoader, fileHandle = null) {
  if (!file) return;

  // Record (or clear) the writable file handle for this open. Only FSA opens
  // (showOpenFilePicker / drag-drop getAsFileSystemHandle) pass one.
  S.currentFileHandle = fileHandle || null;

  const fileName = file.name.toLowerCase();
  const supportedExtensions = ['.3dm', '.glb', '.gltf', '.stl', '.3mf', '.stp', '.step', '.iges', '.igs', '.rhv'];
  const hasValidExt = supportedExtensions.some(ext => fileName.endsWith(ext));
  if (!hasValidExt) {
    alert('지원되지 않는 파일 형식입니다.\n지원 포맷: .3dm, .glb, .gltf, .stl, .3mf, .stp, .step, .iges, .igs, .rhv');
    return;
  }

  resetSettingsToDefault();
  clearCurrentModel();
  S.modelUnit = 'Unknown';
  showLoading('Reading file…');
  document.getElementById('empty-state')?.classList.add('hidden');

  const extractEdges = document.getElementById('chk-edges-panel')?.checked ?? true;

  if (fileName.endsWith('.glb') || fileName.endsWith('.gltf')) {
    S.modelUnit = 'Meters';
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
        // GLB/GLTF colors are already in working linear space — skip the
        // 3dm-specific sRGB→linear convert that would otherwise double-apply.
        postProcessModel(S.currentModel, extractEdges, false);
        fitCameraToObject(S.currentModel, false);
        const box = new THREE.Box3().setFromObject(S.currentModel);
        setupModelShadowFrustum(box);
        if (S.groundEnabled) addGroundPlane(box);
        applyFileBackground();
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
  // Always perform full load with layers (no-op skipLayerParse)
  const skipLayerParse = false;
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
        updateLayerVisibility();
        fitCameraToObject(S.currentModel, false);
        const box = new THREE.Box3().setFromObject(S.currentModel);
        setupModelShadowFrustum(box);
        if (S.groundEnabled) addGroundPlane(box);
        applyFileBackground();
        if (S.fileSkylightEnabled) {
          changeDisplayMode('rendered');
        } else {
          applyDisplayMode();
        }
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
  // .rhv packages embed a GLB — colors are already linear, so skip the
  // 3dm-specific sRGB→linear conversion (would otherwise darken the scene
  // on reopen and the brightness wouldn't match the original 3dm load).
  postProcessModel(S.currentModel, extractEdges, false);
  fitCameraToObject(S.currentModel, false);
  const box = new THREE.Box3().setFromObject(S.currentModel);
  setupModelShadowFrustum(box);
  if (S.groundEnabled) addGroundPlane(box);
  applyFileBackground();
  applyDisplayMode();
  setFileName(fileName);
  showModelInfo(S.currentModel, fileSize);
}
