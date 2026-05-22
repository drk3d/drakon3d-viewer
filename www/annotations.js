import * as THREE from 'three';
import { S } from './state.js';

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

export function createAnnotationSprites() {
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
  const textHeight = Math.max(maxDim * 0.025, 0.5);

  S.annotationGroup = new THREE.Group();
  S.annotationGroup.name = 'annotations-group';

  S.parsedAnnotations.forEach(ann => {
    try {
      const layer     = S.parsedLayers.find(l => l.index === ann.layerIndex);
      const isVisible = layer ? layer.visible : true;
      let color = new THREE.Color(0xffffff);
      if (layer?.color) {
        color = new THREE.Color(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255);
      }

      let obj3d = null;
      const textVal = String(ann.text || '');
      const pos     = ann.position || [0, 0, 0];

      if (ann.type === 'TextDot') {
        obj3d = makeTextDotSprite(textVal, color, textHeight);
        if (obj3d) obj3d.position.set(pos[0], pos[1], pos[2]);
      } else if (ann.geomType && (ann.geomType.includes('Dimension') || ann.geomType === 'Leader')) {
        obj3d = makeDimensionSprite(textVal, color, ann, textHeight);
      } else {
        obj3d = makeText3DPlaneMesh(textVal, color, ann, textHeight);
      }

      if (obj3d) {
        obj3d.userData = { layerIndex: ann.layerIndex };
        obj3d.visible  = isVisible && (document.getElementById('chk-annotations-panel')?.checked ?? true);
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
  ctx.fillStyle = 'rgba(24, 24, 28, 0.88)';
  ctx.fill();
  ctx.lineWidth   = 4;
  ctx.strokeStyle = `#${layerColor.getHexString()}`;
  ctx.stroke();
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
  sprite.scale.set(baseHeight * aspect, baseHeight, 1);
  return sprite;
}

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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.fill();
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
  const font    = `700 ${fontSize}px 'Inter', -apple-system, sans-serif`;
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const padX = 16, padY = 10;
  canvas.width  = Math.ceil(tw + padX * 2);
  canvas.height = Math.ceil(fontSize + padY * 2);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, canvas.height / 2);
  ctx.fillStyle = 'rgba(10, 16, 32, 0.82)';
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
