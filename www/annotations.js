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

      // Resolve color: objectColor > layerColor > black
      // Use the color as-is — black stays black, white stays white
      let color = new THREE.Color(0x000000);
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

      } else if (ann.isDimension && ann.dimPoints) {
        // Accurate dimension rendering using rhino3dm 8.17+ points data:
        // { defpt1, defpt2, arrowpt1, arrowpt2, dimline, textpt }
        obj3d = makeDimensionAccurate(textVal, color, ann, baseH, font);

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

  // Put all annotation objects on layer 1 so AO passes (which restrict the
  // camera to layer 0) don't include them in depth/normal G-buffer computation.
  S.annotationGroup.traverse(obj => obj.layers.set(1));

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

  // Auto-contrast calculation for outline & text color
  const lum = bgColor.r * 0.299 + bgColor.g * 0.587 + bgColor.b * 0.114;

  // Pill background (inset slightly to leave space for crisp stroke)
  ctx.beginPath();
  drawRoundedRect(ctx, 1.5, 1.5, cw - 3, ch - 3, (ch - 3) / 2);
  ctx.fillStyle = `#${bgColor.getHexString()}`;
  ctx.fill();

  // Thin high-fidelity outline border matching Rhino
  ctx.lineWidth = 3;
  ctx.strokeStyle = lum > 0.55 ? '#000000' : '#ffffff';
  ctx.stroke();

  // Auto-contrast text
  ctx.fillStyle = lum > 0.55 ? '#000000' : '#ffffff';
  ctx.fillText(text, cw / 2, ch / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;

  // transparent: true is REQUIRED so rounded corners aren't filled as rectangle
  // depthTest: false keeps TextDots always in front of all geometry
  const mat  = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const spr  = new THREE.Sprite(mat);
  spr.renderOrder = 998;
  spr.scale.set(baseH * (cw / ch), baseH, 1);
  return spr;
}

// ── Text mesh (FontLoader + ShapeGeometry) ────────────────────────────────────
// Placed in the Rhino annotation plane: xAxis=right, yAxis=up

function makeTextMesh(text, color, ann, baseH, font, centerX = false) {
  // baseH-relative floor: in models where Rhino's textHeight (e.g. 3.5mm) is
  // too small to read, scale up. rhino3dm.js does not expose DimensionScale.
  const textH  = Math.max(ann.textHeight || 0, baseH * 0.5);
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

    const mat  = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: true, depthWrite: false });
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

// Accurate dimension rendering using rhino3dm 8.17+ points data.
// dimPoints = { defpt1, defpt2, arrowpt1, arrowpt2, dimline, textpt }
//   - defpt1/defpt2: the actual measured points on the geometry
//   - arrowpt1/arrowpt2: dim line endpoints where arrows sit
//   - dimline: a point on the dimension line (often the midpoint)
//   - textpt: text insertion point
function makeDimensionAccurate(text, color, ann, baseH, font) {
  const dp = ann.dimPoints;
  if (!dp || !dp.arrowpt1 || !dp.arrowpt2) {
    return makeDimension(text, color, ann, baseH, font);
  }

  const a1 = new THREE.Vector3(...dp.arrowpt1);
  const a2 = new THREE.Vector3(...dp.arrowpt2);
  if (a1.distanceTo(a2) < 1e-6) return null;

  const dimDir = a2.clone().sub(a1).normalize();
  const planeY = ann.yAxis ? new THREE.Vector3(...ann.yAxis).normalize() : _perpToX(dimDir);
  let yDir = planeY.clone().sub(dimDir.clone().multiplyScalar(planeY.dot(dimDir))).normalize();
  if (!isFinite(yDir.lengthSq()) || yDir.lengthSq() < 0.01) yDir = _perpToX(dimDir);
  const zDir = new THREE.Vector3().crossVectors(dimDir, yDir).normalize();

  const group = new THREE.Group();
  // depthTest:true so dimension lines hide behind solid geometry (not see-through)
  const lineMat = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });
  const addSeg = (a, b) => {
    const geo  = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, lineMat);
    line.renderOrder = 997;
    group.add(line);
  };

  // ── Main dimension line: arrowpt1 → arrowpt2 ──
  addSeg(a1, a2);

  // ── Extension lines: from measured points (defpt1/defpt2) to dim line endpoints ──
  if (dp.defpt1) {
    const d1 = new THREE.Vector3(...dp.defpt1);
    if (d1.distanceTo(a1) > 1e-3) {
      // Small gap from measured point + small extension past the dim line
      const dir1 = a1.clone().sub(d1).normalize();
      const gap  = baseH * 0.15;
      const past = baseH * 0.4;
      addSeg(
        d1.clone().addScaledVector(dir1, gap),
        a1.clone().addScaledVector(dir1, past)
      );
    }
  }
  if (dp.defpt2) {
    const d2 = new THREE.Vector3(...dp.defpt2);
    if (d2.distanceTo(a2) > 1e-3) {
      const dir2 = a2.clone().sub(d2).normalize();
      const gap  = baseH * 0.15;
      const past = baseH * 0.4;
      addSeg(
        d2.clone().addScaledVector(dir2, gap),
        a2.clone().addScaledVector(dir2, past)
      );
    }
  }

  // ── Arrowheads (V shape, pointing inward along dim line) ──
  // Size based on textHeight (so it scales with dimension style)
  const arrowSz = (ann.textHeight ?? baseH * 0.7) * 1.2;
  const addArrow = (tip, inward) => {
    // inward = unit vector pointing from tip toward dim center
    const back = inward.clone().multiplyScalar(arrowSz);
    const w1 = tip.clone().add(back).addScaledVector(yDir,  arrowSz * 0.35);
    const w2 = tip.clone().add(back).addScaledVector(yDir, -arrowSz * 0.35);
    const geo   = new THREE.BufferGeometry().setFromPoints([w1, tip, w2]);
    const arrow = new THREE.Line(geo, lineMat);
    arrow.renderOrder = 997;
    group.add(arrow);
  };
  addArrow(a1, dimDir);                       // at a1, V wings open back toward a2
  addArrow(a2, dimDir.clone().negate());      // at a2, V wings open back toward a1

  // ── Text at dim line midpoint (sprite — always faces camera) ──
  // We use a Sprite (same as TextDot) so dimension text always reads correctly
  // regardless of viewing angle. Mesh-based text appears mirrored from the back.
  const textH = Math.max(ann.textHeight || 0, baseH * 0.5);
  const textPos = a1.clone().add(a2).multiplyScalar(0.5);
  textPos.addScaledVector(yDir, textH * 0.6);
  const spr = _makeDimTextSprite(text, color, textH);
  spr.position.copy(textPos);
  group.add(spr);

  return group;
}

function makeDimension(text, color, ann, baseH, font) {
  const pos  = ann.position || [0, 0, 0];

  // Annotation plane axes
  const xDir = new THREE.Vector3(...(ann.xAxis || [1, 0, 0])).normalize();
  const yDir = ann.yAxis
    ? new THREE.Vector3(...ann.yAxis).normalize()
    : _perpToX(xDir);

  // ── Dimension endpoints ─────────────────────────────────────────────────────
  // pt1/pt2 from Rhino = the measured points on the geometry.
  // rhino3dm WASM doesn't expose these, so we estimate from bbox extents.
  let p1 = null, p2 = null;
  if (ann.pt1 && ann.pt2) {
    const tp1 = new THREE.Vector3(...ann.pt1);
    const tp2 = new THREE.Vector3(...ann.pt2);
    if (tp1.distanceTo(tp2) > 1e-3) { p1 = tp1; p2 = tp2; }
  }
  if (!p1 && ann.bboxMin && ann.bboxMax) {
    // The bbox of a Rhino LinearDimension is an axis-aligned rectangle spanning:
    //   - the dim line itself (along the longest bbox axis = dimDir)
    //   - the extension lines (perpendicular, along the next-longest axis = perpDir)
    // The dim line lies at ONE perpendicular edge of the bbox; the measured object
    // (cylinder, square edge, etc.) lies at the OPPOSITE perpendicular edge.
    // Rhino convention: dim line is placed on the side AWAY from the model body.
    const bbMin   = new THREE.Vector3(...ann.bboxMin);
    const bbMax   = new THREE.Vector3(...ann.bboxMax);
    const bbSize  = bbMax.clone().sub(bbMin);

    // Pick dimDir = longest bbox axis, perpDir = next-longest perpendicular axis
    const sizes = [
      { axis: new THREE.Vector3(1, 0, 0), len: bbSize.x },
      { axis: new THREE.Vector3(0, 1, 0), len: bbSize.y },
      { axis: new THREE.Vector3(0, 0, 1), len: bbSize.z }
    ];
    sizes.sort((a, b) => b.len - a.len);
    const dimDir2  = sizes[0].axis;
    const perpDir2 = sizes[1].axis;
    const dimLen   = sizes[0].len;
    const perpLen  = sizes[1].len;

    // Determine which perpendicular edge is the dim line side.
    // Heuristic: the edge farther from the model bounding box center.
    let dimLineSign = +1;
    try {
      if (S.currentModel) {
        const modelBox = new THREE.Box3().setFromObject(S.currentModel);
        const modelCtr = modelBox.getCenter(new THREE.Vector3());
        const annCtr   = bbMin.clone().add(bbMax).multiplyScalar(0.5);
        const edgePlus  = annCtr.clone().addScaledVector(perpDir2,  perpLen * 0.5);
        const edgeMinus = annCtr.clone().addScaledVector(perpDir2, -perpLen * 0.5);
        // Dim line is at the edge FARTHER from the model center
        dimLineSign = (edgePlus.distanceTo(modelCtr) > edgeMinus.distanceTo(modelCtr)) ? +1 : -1;
      }
    } catch {}

    // Compute dim line endpoints: at bbox corner on the chosen perpendicular side,
    // extending along dimDir for the full bbox extent.
    const annCtr = bbMin.clone().add(bbMax).multiplyScalar(0.5);
    const dimLinePerpPos = annCtr.clone().addScaledVector(perpDir2, perpLen * 0.5 * dimLineSign);

    p1 = dimLinePerpPos.clone().addScaledVector(dimDir2, -dimLen * 0.5);
    p2 = dimLinePerpPos.clone().addScaledVector(dimDir2,  dimLen * 0.5);

    // Pass the "extension direction" (perpDir2 pointing AWAY from dim line, toward measured object)
    // for use by the extension lines code below.
    ann._extDir   = perpDir2.clone().multiplyScalar(-dimLineSign);
    ann._extLen   = perpLen;

    xDir.copy(dimDir2);
    yDir.copy(perpDir2.clone().multiplyScalar(-dimLineSign)); // points toward measured object
  }
  if (!p1) {
    // Last-resort fallback: estimate from origin + numeric value along xDir
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

  const lineMat = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });

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

  // ── Extension lines ─────────────────────────────────────────────────────────
  // Extension lines run from each dim line endpoint (p1, p2) perpendicular to
  // the dim line, reaching to the measured object. yDir was set above to point
  // FROM dim line TOWARD the measured object. Length = bbox perpendicular extent.
  const extLen = ann._extLen ?? Math.max(baseH * 2.5, p1.distanceTo(p2) * 0.12);
  addSeg(p1.clone(), p1.clone().addScaledVector(yDir, extLen));
  addSeg(p2.clone(), p2.clone().addScaledVector(yDir, extLen));

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
      const mat  = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: true, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 998;
      // Orient: text reads along the dimension line direction (Rhino default).
      // makeBasis(xLocal, yLocal, zLocal): text reading dir = xLocal, text-up = yLocal.
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

// ── Dimension/Text label as Sprite (always faces camera) ────────────────────
// modelH = desired text height in world (model) units.
function _makeDimTextSprite(text, color, modelH) {
  const fsPx   = 64;  // canvas font size (px) — fixed for crisp rendering
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  ctx.font = `500 ${fsPx}px 'Inter', -apple-system, sans-serif`;
  const tw  = ctx.measureText(text).width;
  const pad = 6;
  const cw  = Math.ceil(tw + pad * 2);
  const ch  = Math.ceil(fsPx + pad * 2);
  canvas.width  = cw;
  canvas.height = ch;
  // Resizing the canvas resets the ctx state — re-set font.
  ctx.font = `500 ${fsPx}px 'Inter', -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = `#${color.getHexString()}`;
  ctx.fillText(text, cw / 2, ch / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  // depthTest:true so the dim text hides behind geometry (not see-through)
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false
  });
  const spr = new THREE.Sprite(mat);
  spr.renderOrder = 998;
  // Scale: map fsPx (the actual text height) → modelH world units.
  // The whole canvas (including pad) is taller than fsPx, so scale accordingly.
  const worldH = modelH * (ch / fsPx);
  spr.scale.set(worldH * (cw / ch), worldH, 1);
  return spr;
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
  const mat  = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const spr  = new THREE.Sprite(mat);
  spr.renderOrder = 998;
  const baseH = fs / 40;  // normalise
  spr.scale.set(baseH * (canvas.width / canvas.height), baseH, 1);
  return spr;
}
