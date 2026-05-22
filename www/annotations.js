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
      () => { console.warn('[annotations] font load failed'); resolve(null); }
    );
  });
  return _fontPromise;
}

// ── Canvas helper ─────────────────────────────────────────────────────────────

function drawRoundedRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function createAnnotationSprites() {
  if (S.annotationGroup) {
    if (S.annotationGroup.parent) S.annotationGroup.parent.remove(S.annotationGroup);
    else S.scene.remove(S.annotationGroup);
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

  const box      = new THREE.Box3().setFromObject(S.currentModel);
  const size     = box.getSize(new THREE.Vector3());
  const maxDim   = Math.max(size.x, size.y, size.z) || 100;
  const baseH    = Math.max(maxDim * 0.025, 0.5);

  const font = await loadFont();

  S.annotationGroup = new THREE.Group();
  S.annotationGroup.name = 'annotations-group';

  const annVisible = document.getElementById('chk-annotations-panel')?.checked ?? true;

  S.parsedAnnotations.forEach(ann => {
    try {
      const layer     = S.parsedLayers.find(l => l.index === ann.layerIndex);
      const isVisible = layer ? layer.visible : true;

      // Resolve color: objectColor > layerColor > white
      let color = new THREE.Color(0xffffff);
      if (ann.objectColor) {
        color.setRGB(ann.objectColor.r / 255, ann.objectColor.g / 255, ann.objectColor.b / 255);
      } else if (layer?.color) {
        color.setRGB(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255);
      }

      const textVal = String(ann.text || '');
      let obj3d = null;

      if (ann.type === 'TextDot') {
        obj3d = makeTextDot(textVal, color, baseH);
        if (obj3d) obj3d.position.set(...(ann.position || [0, 0, 0]));

      } else if (ann.geomType &&
                 (ann.geomType.includes('Dimension') || ann.geomType === 'Leader')) {
        obj3d = makeDimension(textVal, color, ann, baseH, font);

      } else {
        // TextEntity / plain Text
        obj3d = font
          ? makeTextMesh(textVal, color, ann, baseH, font)
          : makeTextSprite(textVal, color, ann, baseH);
      }

      if (obj3d) {
        obj3d.userData = { layerIndex: ann.layerIndex };
        obj3d.visible  = isVisible && annVisible;
        S.annotationGroup.add(obj3d);
      }
    } catch (err) {
      console.warn('[annotations] render failed:', ann, err);
    }
  });

  if (S.currentModel) S.currentModel.add(S.annotationGroup);
  else S.scene.add(S.annotationGroup);
}

// ── TextDot ───────────────────────────────────────────────────────────────────
// Rounded-pill sprite, background = objectColor/layerColor, auto-contrast text

function makeTextDot(text, bgColor, baseH) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  const fs = 32;
  ctx.font = `700 ${fs}px 'Inter', -apple-system, sans-serif`;
  const tw = ctx.measureText(text).width;
  const px = 22, py = 14;
  const cw = Math.ceil(tw + px * 2);
  const ch = Math.ceil(fs + py * 2);
  canvas.width  = cw;
  canvas.height = ch;

  ctx.clearRect(0, 0, cw, ch);          // transparent corners → enables round shape
  ctx.font = `700 ${fs}px 'Inter', -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';

  // Pill background
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, cw, ch, ch / 2);
  ctx.fillStyle = `#${bgColor.getHexString()}`;
  ctx.fill();

  // Auto-contrast text
  const lum = bgColor.r * 0.299 + bgColor.g * 0.587 + bgColor.b * 0.114;
  ctx.fillStyle = lum > 0.55 ? '#111111' : '#ffffff';
  ctx.fillText(text, cw / 2, ch / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;

  // transparent: true is REQUIRED so rounded corners aren't filled as rectangle
  const mat  = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const spr  = new THREE.Sprite(mat);
  spr.renderOrder = 998;
  spr.scale.set(baseH * (cw / ch), baseH, 1);
  return spr;
}

// ── Text mesh (FontLoader + ShapeGeometry) ────────────────────────────────────
// Placed in the Rhino annotation plane: xAxis=right, yAxis=up

function makeTextMesh(text, color, ann, baseH, font, centerX = false) {
  const textH  = (ann.textHeight && ann.textHeight > 0) ? ann.textHeight : baseH;
  const lines  = String(text).split(/\r?\n/);
  const lineGap = textH * 1.25;
  const group  = new THREE.Group();

  lines.forEach((line, li) => {
    if (!line.trim()) return;
    let shapes;
    try { shapes = font.generateShapes(line, textH); }
    catch { return; }

    const geo = new THREE.ShapeGeometry(shapes);
    geo.computeBoundingBox();

    if (centerX) {
      const bb = geo.boundingBox;
      geo.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
    }

    const mat  = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 997;
    mesh.position.y = -li * lineGap;
    group.add(mesh);
  });

  if (!group.children.length) return null;

  // Apply Rhino plane
  const pos  = ann.position || [0, 0, 0];
  const xDir = new THREE.Vector3(...(ann.xAxis || [1, 0, 0])).normalize();
  const yDir = ann.yAxis
    ? new THREE.Vector3(...ann.yAxis).normalize()
    : _perpToX(xDir);
  const zDir = new THREE.Vector3().crossVectors(xDir, yDir).normalize();
  if (zDir.lengthSq() < 0.001) zDir.set(0, 0, 1);

  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xDir, yDir, zDir));
  group.position.set(pos[0], pos[1], pos[2]);
  return group;
}

// ── Text sprite fallback (no font) ────────────────────────────────────────────

function makeTextSprite(text, color, ann, baseH) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  const fs = 44;
  ctx.font = `500 ${fs}px 'Inter', -apple-system, sans-serif`;
  const tw = ctx.measureText(text).width;
  const px = 14, py = 10;
  const cw = Math.ceil(tw + px * 2);
  const ch = Math.ceil(fs + py * 2);
  canvas.width = cw; canvas.height = ch;
  ctx.font = `500 ${fs}px 'Inter', -apple-system, sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.clearRect(0, 0, cw, ch);
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, cw, ch, ch * 0.45);
  ctx.fillStyle = 'rgba(24,24,28,0.92)'; ctx.fill();
  ctx.fillStyle = `#${color.getHexString()}`;
  ctx.fillText(text, cw / 2, ch / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const spr = new THREE.Sprite(mat);
  spr.renderOrder = 997;
  spr.scale.set(baseH * (cw / ch) * 1.1, baseH * 1.1, 1);
  const pos = ann.position || [0, 0, 0];
  spr.position.set(pos[0], pos[1], pos[2]);
  return spr;
}

// ── Dimension ─────────────────────────────────────────────────────────────────
// Draws: dimension line + arrowheads + oriented text (3D font or sprite)

function makeDimension(text, color, ann, baseH, font) {
  const pos  = ann.position || [0, 0, 0];

  // Annotation plane axes
  const xDir = new THREE.Vector3(...(ann.xAxis || [1, 0, 0])).normalize();
  const yDir = ann.yAxis
    ? new THREE.Vector3(...ann.yAxis).normalize()
    : _perpToX(xDir);

  // ── Dimension endpoints ─────────────────────────────────────────────────────
  // pt1/pt2 from Rhino = the measured points on the geometry.
  // If they came back as [0,0,0] (default unset), treat as missing.
  let p1 = null, p2 = null;
  if (ann.pt1 && ann.pt2) {
    const tp1 = new THREE.Vector3(...ann.pt1);
    const tp2 = new THREE.Vector3(...ann.pt2);
    if (tp1.distanceTo(tp2) > 1e-3) { p1 = tp1; p2 = tp2; }
  }
  if (!p1) {
    // Estimate from origin + numeric value along xDir
    const origin = new THREE.Vector3(...pos);
    const numVal  = parseFloat(text);
    const halfLen = (!isNaN(numVal) && numVal > 0) ? numVal * 0.5 : baseH * 3;
    p1 = origin.clone().addScaledVector(xDir, -halfLen);
    p2 = origin.clone().addScaledVector(xDir,  halfLen);
  }

  if (p1.distanceTo(p2) < 1e-6) {
    // Truly degenerate — just render text
    return font
      ? makeTextMesh(text, color, ann, baseH, font)
      : makeTextSprite(text, color, ann, baseH);
  }

  const group   = new THREE.Group();
  const dimDir  = p2.clone().sub(p1).normalize();
  const arrowSz = Math.min(baseH * 0.45, p1.distanceTo(p2) * 0.07);

  const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false });

  const addSeg = (a, b) => {
    const geo  = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, lineMat);
    line.renderOrder = 997;
    group.add(line);
  };

  // ── Main dimension line ─────────────────────────────────────────────────────
  addSeg(p1, p2);

  // ── Arrowheads (V shape in annotation plane) ────────────────────────────────
  const addArrow = (tip, outDir) => {
    // outDir = direction the arrow points away from dimension center
    const back = outDir.clone().negate().multiplyScalar(arrowSz);
    const w1 = tip.clone().add(back).addScaledVector(yDir,  arrowSz * 0.35);
    const w2 = tip.clone().add(back).addScaledVector(yDir, -arrowSz * 0.35);
    const geo   = new THREE.BufferGeometry().setFromPoints([w1, tip, w2]);
    const arrow = new THREE.Line(geo, lineMat);
    arrow.renderOrder = 997;
    group.add(arrow);
  };
  addArrow(p1, dimDir.clone().negate()); // at p1, pointing away from p2
  addArrow(p2, dimDir.clone());          // at p2, pointing away from p1

  // ── Extension lines (when measured points differ from dim line) ─────────────
  if (ann.pt1 && ann.pt2) {
    // p1/p2 are measured points; dimension line is offset by yDir
    // (This branch only runs if pt1/pt2 were valid non-zero)
    const extLen = baseH * 0.6;
    const extStart1 = p1.clone().addScaledVector(yDir,  baseH * 0.12);
    const extEnd1   = p1.clone().addScaledVector(yDir,  extLen);
    const extStart2 = p2.clone().addScaledVector(yDir,  baseH * 0.12);
    const extEnd2   = p2.clone().addScaledVector(yDir,  extLen);
    addSeg(extStart1, extEnd1);
    addSeg(extStart2, extEnd2);
    // Redraw dimension line at the extended position
    addSeg(
      p1.clone().addScaledVector(yDir, extLen),
      p2.clone().addScaledVector(yDir, extLen)
    );
  }

  // ── Text: at annotation origin, oriented along dimension ────────────────────
  const textPos = new THREE.Vector3(...pos);
  const textH   = (ann.textHeight && ann.textHeight > 0) ? ann.textHeight : baseH * 0.7;

  if (font) {
    try {
      const shapes = font.generateShapes(text, textH);
      const geo    = new THREE.ShapeGeometry(shapes);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      // Center horizontally and vertically on the annotation origin
      geo.translate(
        -(bb.min.x + bb.max.x) / 2,
        -(bb.min.y + bb.max.y) / 2,
        0
      );
      const mat  = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 998;
      // Orient: xDir = along dimension, yDir = perpendicular (up for text)
      const zDir = new THREE.Vector3().crossVectors(dimDir, yDir).normalize();
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dimDir, yDir, zDir));
      mesh.position.copy(textPos);
      group.add(mesh);
    } catch (e) {
      console.warn('[dim text]', e);
    }
  } else {
    const spr = _makeLabelSprite(text, color, textH * 2);
    spr.position.copy(textPos);
    group.add(spr);
  }

  return group;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _perpToX(xDir) {
  const worldUp = Math.abs(xDir.dot(new THREE.Vector3(0, 1, 0))) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  const p = new THREE.Vector3().crossVectors(xDir, worldUp).normalize();
  return p.lengthSq() > 0.001 ? p : new THREE.Vector3(0, 1, 0);
}

function _makeLabelSprite(text, color, fontSize) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  const fs = fontSize ?? 40;
  ctx.font = `700 ${fs}px sans-serif`;
  const tw = ctx.measureText(text).width;
  const px = 12, py = 8;
  canvas.width  = Math.ceil(tw + px * 2);
  canvas.height = Math.ceil(fs + py * 2);
  ctx.font = `700 ${fs}px sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = `#${color.getHexString()}`;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex  = new THREE.CanvasTexture(canvas);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  const mat  = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const spr  = new THREE.Sprite(mat);
  spr.renderOrder = 998;
  const baseH = fs / 40;  // normalise
  spr.scale.set(baseH * (canvas.width / canvas.height), baseH, 1);
  return spr;
}
