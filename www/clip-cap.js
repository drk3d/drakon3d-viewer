import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { S } from './state.js';

// ── Clipping Section Cap (Stencil Buffer Method) ───────────────────────────────
//
// All meshes live in arcOverlayScene so the stencil writes and reads happen in
// the SAME renderer.render() call — required for the stencil buffer to persist
// between the writer (stencil mesh) and the reader (cap plane).
//
// renderOrder within arcOverlayScene:
//  -1    depth mesh    (kept solid, depthWrite only — so the cap can be occluded)
//   0    stencil meshes (back +1 / front −1, colorWrite=false — depth complexity)
//   1    cap plane     (NotEqualStencilFunc + depthTest — fills the cross-section)
//   999+ gizmos        (arc handles, helper — unchanged)
//
// The animate loop calls renderer.clearStencil() AND clearDepth() right before
// rendering the overlay so both masks are rebuilt fresh each frame.
//
// The depth pre-pass is what makes the section behave correctly from BOTH sides:
// when the camera is on the kept side, the solid sits in front of the section
// plane and must occlude it (otherwise the green bleeds through the model).
//
// NOTE the cap plane must be CENTERED ON THE MODEL and sized to cover it — the
// model can sit far from the world origin, so a plane anchored at the origin
// would miss it entirely.

let _depthMesh        = null; // kept-solid depth-only pre-pass
let _stencilMesh      = null; // stencil writer — back faces (increment)
let _stencilMeshFront = null; // stencil writer — front faces (decrement)
let _mergedGeo   = null; // merged position-only geometry (world space)
let _modelCenter = null; // THREE.Vector3 — model bbox center (for plane placement)

// A section cap only makes sense for 3D VOLUMES. The one thing that genuinely
// breaks the back/front stencil count is a FLAT open surface (ground plane,
// terrain, single panel): all its faces share one orientation, so they fill the
// whole plane (and break on clip-flip). We must NOT use a watertight test here —
// Rhino meshes are routinely "unwelded" (split vertices at smoothing creases) so
// a perfectly solid puzzle piece reports thousands of boundary edges, yet the
// back/front count renders it correctly anyway. Instead we exclude only meshes
// whose geometry is essentially PLANAR (one bbox dimension ≈ 0). Real solids —
// even imperfect/unwelded ones — keep all three dimensions and pass.
function _isFlatSurface(geo) {
  const pos = geo.attributes?.position;
  if (!pos) return true;                          // no geometry → skip
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ex = bb.max.x - bb.min.x;
  const ey = bb.max.y - bb.min.y;
  const ez = bb.max.z - bb.min.z;
  const maxE = Math.max(ex, ey, ez);
  const minE = Math.min(ex, ey, ez);
  if (maxE <= 0) return true;
  return minE <= maxE * 0.01;                     // thinnest dimension < 1% of largest → flat
}

export function buildClippingCap() {
  destroyClippingCap();
  if (!S.currentModel || !S.clippingPlane || !S.arcOverlayScene) return;

  // ── 1. Collect lean (position-only) geometries in world space ──────────────
  const geos = [];
  S.currentModel.traverse(mesh => {
    if (!mesh.isMesh) return;
    if (mesh.userData.type === 'note-marker') return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.length > 0 && mats.every(m => m?.transparent && (m?.opacity ?? 1) < 0.5)) return;
    const srcGeo = mesh.geometry;
    if (!srcGeo?.attributes?.position) return;
    if (_isFlatSurface(srcGeo)) return;  // skip flat open surfaces (ground/terrain/panels)

    mesh.updateWorldMatrix(true, false);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', srcGeo.attributes.position.clone());
    if (srcGeo.index) g.setIndex(srcGeo.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    geos.push(g);
  });

  if (geos.length === 0) return;

  const merged = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  if (!merged) return;
  _mergedGeo = merged;

  // Model size → cap plane placement & size
  const box = new THREE.Box3().setFromObject(S.currentModel);
  _modelCenter = box.getCenter(new THREE.Vector3());
  const diameter = box.getSize(new THREE.Vector3()).length(); // bounding-sphere diameter
  const planeSize = diameter * 1.5;

  // ── 2. Stencil meshes (back/front Increment/Decrement — depth-complexity) ──
  // We count back-faces (+1) minus front-faces (−1) along each ray (depthTest
  // off → count ALL faces). For a closed solid the clip removes the near cap of
  // faces, leaving an unbalanced count inside the section. This signed count
  // handles OVERLAPPING / ABUTTING solids correctly (e.g. interlocking puzzle
  // pieces): the depth-complexity stays non-zero where the cut is inside any
  // solid. The INVERT/parity method fails here — coincident faces at shared
  // seams cancel, making the section flicker as the plane sweeps through them.
  // NotEqual 0 catches both +N and −N (wrapped to 255), so it reads correctly
  // from either side of the cut.
  const twinOpts = {
    colorWrite: false, depthWrite: false, depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    clippingPlanes: [S.clippingPlane],  // material-level clip; renderer clip is [] in overlay
  };
  _stencilMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    ...twinOpts, side: THREE.BackSide,
    stencilFail: THREE.IncrementWrapStencilOp,
    stencilZFail: THREE.IncrementWrapStencilOp,
    stencilZPass: THREE.IncrementWrapStencilOp,
  }));
  _stencilMesh.renderOrder = 0;
  _stencilMesh.frustumCulled = false;

  _stencilMeshFront = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    ...twinOpts, side: THREE.FrontSide,
    stencilFail: THREE.DecrementWrapStencilOp,
    stencilZFail: THREE.DecrementWrapStencilOp,
    stencilZPass: THREE.DecrementWrapStencilOp,
  }));
  _stencilMeshFront.renderOrder = 0;
  _stencilMeshFront.frustumCulled = false;

  S.arcOverlayScene.add(_stencilMesh, _stencilMeshFront);

  // ── 3. Depth pre-pass — writes the kept solid's depth (no color, no stencil)
  // so the cap plane can be occluded by geometry in front of it.
  // polygonOffset pushes this depth slightly AWAY from the camera: the solid
  // faces right at the cut are coincident with the cap plane, so without the
  // bias they z-fight and the solid speckles through the fill. With the bias the
  // cap reliably wins at the cut, while geometry clearly in front (kept-side
  // view) still occludes it.
  _depthMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true, depthTest: true,
    side: THREE.DoubleSide,
    clippingPlanes: [S.clippingPlane],
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  }));
  _depthMesh.renderOrder = -1;
  _depthMesh.frustumCulled = false;
  S.arcOverlayScene.add(_depthMesh);

  // ── 4. Cap plane ───────────────────────────────────────────────────────────
  S.capMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeSize, planeSize),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(S.clippingCapColor || '#000000'),
      side: THREE.DoubleSide,
      depthWrite: false, depthTest: true,   // occluded by the kept solid (depth pre-pass)
      depthFunc: THREE.LessEqualDepth,
      stencilWrite: true,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilRef: 0,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,  // reset stencil to 0 as the cap draws
    })
  );
  S.capMesh.renderOrder = 1;
  S.capMesh.frustumCulled = false;
  S.arcOverlayScene.add(S.capMesh);

  updateClippingCapPose();
}

export function destroyClippingCap() {
  if (_stencilMesh) {
    S.arcOverlayScene?.remove(_stencilMesh);
    _stencilMesh.material?.dispose();
    _stencilMesh = null;
  }
  if (_stencilMeshFront) {
    S.arcOverlayScene?.remove(_stencilMeshFront);
    _stencilMeshFront.material?.dispose();
    _stencilMeshFront = null;
  }
  if (_depthMesh) {
    S.arcOverlayScene?.remove(_depthMesh);
    _depthMesh.material?.dispose();
    _depthMesh = null;
  }
  if (_mergedGeo) { _mergedGeo.dispose(); _mergedGeo = null; }
  if (S.capMesh) {
    S.arcOverlayScene?.remove(S.capMesh);
    S.capMesh.geometry?.dispose();
    S.capMesh.material?.dispose();
    S.capMesh = null;
  }
  _modelCenter = null;
}

export function updateClippingCapPose() {
  if (!S.capMesh || !S.clippingPlane || !_modelCenter) return;
  const n = S.clippingPlane.normal;
  // Anchor the plane at the MODEL CENTER projected onto the clipping plane,
  // not at the world-origin foot point (the model may be far from the origin).
  const dist = n.dot(_modelCenter) + S.clippingPlane.constant; // signed distance
  S.capMesh.position.copy(_modelCenter).addScaledVector(n, -dist);
  S.capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
}

export function setClippingCapEnabled(enabled) {
  S.clippingCapEnabled = enabled;
  if (enabled && S.clippingEnabled) {
    buildClippingCap();
  } else {
    destroyClippingCap();
  }
}

export function setClippingCapColor(hexColor) {
  S.clippingCapColor = hexColor;
  if (S.capMesh?.material) {
    S.capMesh.material.color.set(hexColor);
    S.capMesh.material.needsUpdate = true;
  }
}
