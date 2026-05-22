import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { S } from './state.js';

// ── Font (lazy singleton) ─────────────────────────────────────────────────────

let _fontCache   = null;
let _fontPromise = null;

function loadFont() {
  if (_fontCache)   return Promise.resolve(_fontCache);
  if (_fontPromise) return _fontPromise;
  _fontPromise = new Promise(resolve => {
    new FontLoader().load(
      'https://unpkg.com/three@0.169.0/examples/fonts/helvetiker_regular.typeface.json',
      font => { _fontCache = font; resolve(font); },
      undefined,
      ()   => { console.warn('[annotations] font load failed, using sprite fallback'); resolve(null); }
    );
  });
  return _fontPromise;
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

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

// ── Main export ───────────────────────────────────────────────────────────────

export async function createAnnotationSprites() {
  // Clean up existing group
  if (S.annotationGroup) {
    if (S.annotationGroup.parent) {
      S.annotationGroup.parent.remove(S.annotationGroup);
    } else {
      S.scene.remove(S.annotationGroup);
    }
    S.annotationGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    });
    S.annotationGroup = null;
  }

  if (!S.parsedAnnotations.length) return;

  const box     = new THREE.Box3().setFromObject(S.currentModel);
  const size    = box.getSize(new THREE.Vector3());
  const maxDim  = Math.max(size.x, size.y, size.z) || 100;
  const baseHeight = Math.max(maxDim * 0.025, 0.5);

  // Pre-load font for Text annotations
  const font = await loadFont();

  S.annotationGroup = new THREE.Group();
  S.annotationGroup.name = 'annotations-group';

  const annotationsVisible = document.getElementById('chk-annotations-panel')?.checked ?? true;

  S.parsedAnnotations.forEach(ann => {
    try {
      const layer     = S.parsedLayers.find(l => l.index === ann.layerIndex);
      const isVisible = layer ? layer.visible : true;

      // Resolve color: objectColor first, then layer color, then white
      let color = new THREE.Color(0xffffff);
      if (ann.objectColor) {
        color = new THREE.Color(
          ann.objectColor.r / 255,
          ann.objectColor.g / 255,
          ann.objectColor.b / 255
        );
      } else if (layer?.color) {
        color = new THREE.Color(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255);
      }

      let obj3d = null;
      const textVal = String(ann.text || '');
      const pos     = ann.position || [0, 0, 0];

      if (ann.type === 'TextDot') {
        obj3d = makeTextDotSprite(textVal, color, baseHeight);
        if (obj3d) obj3d.position.set(pos[0], pos[1], pos[2]);

      } else if (ann.geomType && (ann.geomType.includes('Dimension') || ann.geomType === 'Leader')) {
        obj3d = makeDimensionSprite(textVal, color, ann, baseHeight);

      } else {
        // TextEntity / Text — use actual 3D font if available
        obj3d = font
          ? makeTextShapeMesh(textVal, color, ann, baseHeight, font)
          : makeText3DPlaneMesh(textVal, color, ann, baseHeight);
      }

      if (obj3d) {
        obj3d.userData = { layerIndex: ann.layerIndex };
        obj3d.visible  = isVisible && annotationsVisible;
        S.annotationGroup.add(obj3d);
      }
    } catch (err) {
      console.warn('[annotations] Failed to render:', ann, err);
    }
  });

  if (S.currentModel) {
    S.currentModel.add(S.annotationGroup);
  } else {
    S.scene.add(S.annotationGroup);
  }
}

// ── TextDot sprite ────────────────────────────────────────────────────────────

function makeTextDotSprite(text, layerColor, baseHeight) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  const fontSize = 32;
  ctx.font = `600 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  const textWidth  = ctx.measureText(text).width;
  const paddingX   = 24, paddingY = 16;
  const canvasWidth  = textWidth + paddingX * 2;
  const canvasHeight = fontSize  + paddingY * 2;
  canvas.width  = canvasWidth;
  canvas.height = canvasHeight;
  ctx.font = `600 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';
  const radius = canvasHeight / 2;
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvasWidth, canvasHeight, radius);
  // Background: use layerColor (which already incorporates objectColor from caller)
  const bgHex = layerColor.getHexString();
  ctx.fillStyle = `#${bgHex}`;
  ctx.fill();
  // Dark text for light backgrounds, white for dark
  const lum = layerColor.r * 0.299 + layerColor.g * 0.587 + layerColor.b * 0.114;
  ctx.fillStyle = lum > 0.5 ? '#111111' : '#ffffff';
  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: false, depthTest: true, depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  const aspect = canvasWidth / canvasHeight;
  sprite.scale.set(baseHeight * aspect, baseHeight, 1);
  return sprite;
}

// ── Text shape mesh (FontLoader + ShapeGeometry) ──────────────────────────────

function makeTextShapeMesh(text, color, ann, baseHeight, font) {
  // Use Rhino textHeight (model units) if available, else fall back to baseHeight
  const textH = (ann.textHeight && ann.textHeight > 0) ? ann.textHeight : baseHeight;

  // Build geometry per line (handle newlines)
  const lines     = String(text).split(/\r?\n/);
  const group     = new THREE.Group();
  const lineGap   = textH * 1.2;

  lines.forEach((line, li) => {
    if (!line.trim()) return;
    let shapes;
    try { shapes = font.generateShapes(line, textH); }
    catch { return; }

    const geometry = new THREE.ShapeGeometry(shapes);
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 997;
    // Offset each line downward (Rhino text grows upward from origin)
    mesh.position.y = -li * lineGap;
    group.add(mesh);
  });

  if (!group.children.length) return null;

  // Apply Rhino plane: xAxis = text-right, yAxis = text-up
  const pos  = ann.position || [0, 0, 0];
  const xDir = new THREE.Vector3(...(ann.xAxis || [1, 0, 0])).normalize();
  const yDir = new THREE.Vector3(...(ann.yAxis || [0, 1, 0])).normalize();
  // Ensure orthogonality and compute normal
  const zDir = new THREE.Vector3().crossVectors(xDir, yDir).normalize();
  if (zDir.lengthSq() < 0.001) zDir.set(0, 0, 1);

  // ShapeGeometry is in XY plane (THREE +X = right, +Y = up)
  // We need: THREE +X → xDir, THREE +Y → yDir, THREE +Z → zDir
  const rotMat = new THREE.Matrix4().makeBasis(xDir, yDir, zDir);
  group.quaternion.setFromRotationMatrix(rotMat);
  group.position.set(pos[0], pos[1], pos[2]);

  return group;
}

// ── Text sprite fallback (used when font unavailable) ─────────────────────────

function makeText3DPlaneMesh(text, layerColor, ann, baseHeight) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  const fontSize = 44;
  const font   = `500 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.font = font;
  const textWidth   = ctx.measureText(text).width;
  const padX = 14, padY = 10;
  const canvasWidth  = Math.ceil(textWidth + padX * 2);
  const canvasHeight = Math.ceil(fontSize  + padY * 2);
  canvas.width  = canvasWidth;
  canvas.height = canvasHeight;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  const r = canvasHeight * 0.45;
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvasWidth, canvasHeight, r);
  ctx.fillStyle = 'rgba(24, 24, 28, 0.92)';
  ctx.fill();
  ctx.fillStyle = '#' + layerColor.getHexString();
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

// ── Dimension sprite ──────────────────────────────────────────────────────────

function makeDimensionSprite(text, layerColor, ann, baseHeight) {
  const group = new THREE.Group();
  const pos   = ann.position || [0, 0, 0];
  const col   = `#${layerColor.getHexString()}`;
  const lineColor = layerColor.clone();

  let p1, p2;
  if (ann.pt1 && ann.pt2) {
    p1 = new THREE.Vector3(...ann.pt1);
    p2 = new THREE.Vector3(...ann.pt2);
  } else {
    const origin  = new THREE.Vector3(...pos);
    const xDir    = new THREE.Vector3(...(ann.xAxis || [1, 0, 0])).normalize();
    const numVal  = parseFloat(text);
    const halfLen = (!isNaN(numVal) && numVal > 0) ? numVal * 0.5 : baseHeight * 3;
    p1 = origin.clone().addScaledVector(xDir, -halfLen);
    p2 = origin.clone().addScaledVector(xDir,  halfLen);
  }

  if (p1.distanceTo(p2) < 1e-6) {
    const fallback = makeTextDotSprite(text, lineColor, baseHeight);
    if (fallback) fallback.position.set(pos[0], pos[1], pos[2]);
    return fallback;
  }

  const midPt  = p1.clone().add(p2).multiplyScalar(0.5);
  const dimDir = p2.clone().sub(p1).normalize();
  const worldUp = Math.abs(dimDir.dot(new THREE.Vector3(0, 1, 0))) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  let perpDir = new THREE.Vector3().crossVectors(dimDir, worldUp).normalize();
  if (perpDir.lengthSq() < 0.01) perpDir = new THREE.Vector3(0, 1, 0);

  const extLen    = baseHeight * 0.8;
  const extOffset = baseHeight * 0.15;
  const arrowSize = baseHeight * 0.35;
  const lineMat   = new THREE.LineBasicMaterial({
    color: lineColor, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9
  });

  const addLine = (...pts) => {
    const geo  = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, lineMat);
    line.renderOrder = 997;
    group.add(line);
  };

  addLine(
    p1.clone().addScaledVector(perpDir, extOffset),
    p1.clone().addScaledVector(perpDir, extLen)
  );
  addLine(
    p2.clone().addScaledVector(perpDir, extOffset),
    p2.clone().addScaledVector(perpDir, extLen)
  );
  const dimLineStart = p1.clone().addScaledVector(perpDir, extLen);
  const dimLineEnd   = p2.clone().addScaledVector(perpDir, extLen);
  addLine(dimLineStart, dimLineEnd);

  const addArrow = (tip, dir, size) => {
    const side = new THREE.Vector3().crossVectors(dir, perpDir).normalize();
    const pts  = [
      tip.clone().addScaledVector(dir.clone().negate(), size).addScaledVector(side,  size * 0.4),
      tip.clone(),
      tip.clone().addScaledVector(dir.clone().negate(), size).addScaledVector(side, -size * 0.4)
    ];
    const geo   = new THREE.BufferGeometry().setFromPoints(pts);
    const arrow = new THREE.Line(geo, lineMat);
    arrow.renderOrder = 997;
    group.add(arrow);
  };
  addArrow(dimLineStart, dimDir.clone().negate(), arrowSize);
  addArrow(dimLineEnd,   dimDir.clone(),          arrowSize);

  const canvas  = document.createElement('canvas');
  const ctx     = canvas.getContext('2d');
  const fontSize = 40;
  const fontStr = `700 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.font = fontStr;
  const tw = ctx.measureText(text).width;
  const padX = 16, padY = 10;
  canvas.width  = Math.ceil(tw + padX * 2);
  canvas.height = Math.ceil(fontSize + padY * 2);
  ctx.font = fontStr;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, canvas.height / 2);
  ctx.fillStyle = 'rgba(10, 16, 32, 0.92)';
  ctx.fill();
  ctx.lineWidth   = 2;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex      = new THREE.CanvasTexture(canvas);
  tex.minFilter  = THREE.LinearFilter;
  tex.magFilter  = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite    = new THREE.Sprite(spriteMat);
  sprite.renderOrder = 998;
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(baseHeight * aspect * 1.1, baseHeight * 1.1, 1);
  sprite.position.copy(midPt.clone().addScaledVector(perpDir, extLen + baseHeight * 0.7));
  group.add(sprite);

  group.position.set(0, 0, 0);
  return group;
}
