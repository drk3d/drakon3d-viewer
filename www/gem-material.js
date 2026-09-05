import * as THREE from 'three';
import {
  MeshBVH,
  MeshBVHUniformStruct,
  SAH,
  shaderStructs,
  shaderIntersectFunction
} from 'three-mesh-bvh';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// Drakon gemstone refraction material
//
// Adapted from the MeshRefractionMaterial project by N8Programs, distributed
// by pmndrs/drei under the MIT License.  The original implementation and its
// attribution are available at:
// https://github.com/pmndrs/drei/blob/master/src/materials/MeshRefractionMaterial.tsx
//
// MIT License
// Copyright (c) 2020 react-spring
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: the above copyright
// notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
// THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// This Viewer-specific version is plain Three.js (no React dependency), uses
// the reference demo's CC0 Venice Sunset HDR with an offline lightbox fallback,
// and deliberately applies only to explicitly named gemstone materials. A gem
// needs a closed, faceted render mesh: its internal BVH is what lets the shader
// trace rays through the stone instead of behaving like ordinary glass.

// Initial Drakon catalogue: faceted, transparent stones only. Opaque, milky,
// chatoyant or layered stones (Pearl, Opal, Malachite, Jade and Lapis Lazuli)
// deliberately stay on the regular Rhino/PBR material path.
const GEMSTONE_PATTERN = /\b(?:almandite|amethyst|aquamarine|aventurine|chalcedony|citrine|diamond|emerald|garnet|hiddenite|kunzite|precious\s+beryl|quartz|ruby|sapphire|topaz)\b/i;

const GEM_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying mat4 vModelMatrixInverse;

  void main() {
    mat4 worldTransform = modelMatrix;

    #ifdef USE_INSTANCING
      worldTransform = modelMatrix * instanceMatrix;
    #endif

    vModelMatrixInverse = inverse( worldTransform );
    vWorldPosition = ( worldTransform * vec4( position, 1.0 ) ).xyz;
    vWorldNormal = normalize( mat3( transpose( vModelMatrixInverse ) ) * normal );
    gl_Position = projectionMatrix * viewMatrix * worldTransform * vec4( position, 1.0 );
  }
`;

const GEM_FRAGMENT_SHADER = /* glsl */ `
  precision highp isampler2D;
  precision highp usampler2D;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying mat4 vModelMatrixInverse;

  ${shaderStructs}
  ${shaderIntersectFunction}

  uniform sampler2D envMap;
  uniform BVH bvh;
  uniform float bounces;
  uniform float ior;
  uniform float aberrationStrength;
  uniform vec3 color;
  uniform mat4 modelMatrix;

  #include <common>

  // Trace a ray from the camera, refracting it into the gem and reflecting it
  // at internal facets until it exits. A no-hit guard leaves malformed/open
  // meshes readable instead of producing black pixels.
  vec3 totalInternalReflection(
    vec3 rayOrigin,
    vec3 rayDirection,
    vec3 normal,
    float refractionIndex,
    mat4 modelMatrixInverse
  ) {
    rayDirection = refract( rayDirection, normal, 1.0 / refractionIndex );
    rayOrigin = vWorldPosition + rayDirection * 0.001;

    rayOrigin = ( modelMatrixInverse * vec4( rayOrigin, 1.0 ) ).xyz;
    rayDirection = normalize( ( modelMatrixInverse * vec4( rayDirection, 0.0 ) ).xyz );

    for ( float bounce = 0.0; bounce < 3.0; bounce ++ ) {
      if ( bounce >= bounces ) break;

      uvec4 faceIndices = uvec4( 0u );
      vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
      vec3 barycoord = vec3( 0.0 );
      float side = 1.0;
      float distanceToFace = 0.0;

      bvhIntersectFirstHit(
        bvh,
        rayOrigin,
        rayDirection,
        faceIndices,
        faceNormal,
        barycoord,
        side,
        distanceToFace
      );

      if ( distanceToFace <= 0.000001 ) break;

      vec3 hitPosition = rayOrigin + rayDirection * max( distanceToFace - 0.001, 0.0 );
      vec3 exitDirection = refract( rayDirection, faceNormal, refractionIndex );

      if ( length( exitDirection ) > 0.0 ) {
        rayDirection = exitDirection;
        break;
      }

      rayDirection = reflect( rayDirection, faceNormal );
      rayOrigin = hitPosition + rayDirection * 0.01;
    }

    return normalize( ( modelMatrix * vec4( rayDirection, 0.0 ) ).xyz );
  }

  vec3 sampleEnvironment( vec3 direction ) {
    return texture( envMap, equirectUv( direction ) ).rgb;
  }

  void main() {
    vec3 rayOrigin = cameraPosition;
    vec3 incomingRay = normalize( vWorldPosition - cameraPosition );
    vec3 greenRay = totalInternalReflection(
      rayOrigin,
      incomingRay,
      vWorldNormal,
      max( ior, 1.0 ),
      vModelMatrixInverse
    );

    // Match the reference implementation's full chromatic refraction. Red,
    // green and blue use slightly different IOR values and each ray is traced
    // through the stone; simple UV offsets were faster but visibly flatter.
    vec3 redRay = totalInternalReflection(
      rayOrigin,
      incomingRay,
      vWorldNormal,
      max( ior * ( 1.0 - aberrationStrength ), 1.0 ),
      vModelMatrixInverse
    );
    vec3 blueRay = totalInternalReflection(
      rayOrigin,
      incomingRay,
      vWorldNormal,
      max( ior * ( 1.0 + aberrationStrength ), 1.0 ),
      vModelMatrixInverse
    );
    vec3 refractedColor = vec3(
      sampleEnvironment( redRay ).r,
      sampleEnvironment( greenRay ).g,
      sampleEnvironment( blueRay ).b
    );

    gl_FragColor = vec4( refractedColor * color, 1.0 );

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const gemBvhByGeometry = new WeakMap();
const liveGemMaterials = new Set();
let gemEnvironment = null;
let referenceEnvironmentPromise = null;

/**
 * Returns the first explicitly named stone in a list of material names.
 * The Viewer does not guess from colour, so yellow gold or coloured plastics
 * can never accidentally become refractive gems.
 */
export function gemstoneKindFromNames(...names) {
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const match = name.trim().match(GEMSTONE_PATTERN);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function getGemBvh(geometry) {
  let resource = gemBvhByGeometry.get(geometry);
  if (resource) return resource;

  // Do not build on the render geometry itself: MeshBVH may reorder its index
  // buffer, while the Viewer still needs that original topology for edges and
  // selection. A de-indexed clone also gives one watertight BVH root per stone.
  const bvhGeometry = geometry.index
    ? geometry.clone().toNonIndexed()
    : geometry.clone();
  const bvh = new MeshBVH(bvhGeometry, { strategy: SAH, maxLeafTris: 1 });
  const uniform = new MeshBVHUniformStruct();
  uniform.updateFrom(bvh);
  resource = { uniform, references: 0 };
  gemBvhByGeometry.set(geometry, resource);
  return resource;
}

function createGemEnvironment() {
  // A compact linear-HDR lightbox baked into the Viewer. The large softboxes
  // supply the bright, coloured reflections that make a cut stone readable;
  // using this fixed map avoids each Rhino material depending on an external
  // HDR file or on the current background setting.
  const width = 512;
  const height = 256;
  const pixels = new Float32Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const floor = Math.max(0, (v - 0.5) / 0.5);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const wall = 0.025 + floor * 0.18;
      pixels[i] = wall;
      pixels[i + 1] = wall;
      pixels[i + 2] = wall * 1.08;
      pixels[i + 3] = 1;
    }
  }

  const addSoftbox = (cx, cy, rx, ry, r, g, b, intensity) => {
    const minX = Math.max(0, Math.floor(cx - rx));
    const maxX = Math.min(width - 1, Math.ceil(cx + rx));
    const minY = Math.max(0, Math.floor(cy - ry));
    const maxY = Math.min(height - 1, Math.ceil(cy + ry));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d >= 1) continue;
        const glow = Math.pow(1 - d, 2) * intensity;
        const i = (y * width + x) * 4;
        pixels[i] += r * glow;
        pixels[i + 1] += g * glow;
        pixels[i + 2] += b * glow;
      }
    }
  };

  addSoftbox(width * 0.22, height * 0.30, 68, 48, 1.0, 0.92, 0.78, 9.0);
  addSoftbox(width * 0.74, height * 0.28, 58, 72, 0.68, 0.82, 1.0, 8.0);
  addSoftbox(width * 0.50, height * 0.10, 126, 20, 1.0, 1.0, 1.0, 6.0);
  addSoftbox(width * 0.53, height * 0.62, 180, 22, 1.0, 0.82, 0.60, 3.0);

  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function getGemEnvironment() {
  if (!gemEnvironment) {
    gemEnvironment = createGemEnvironment();
    loadReferenceEnvironment();
  }
  return gemEnvironment;
}

function loadReferenceEnvironment() {
  if (referenceEnvironmentPromise) return referenceEnvironmentPromise;

  // This is the same CC0 Venice Sunset HDR used by the three-mesh-bvh diamond
  // reference. It is hosted with the Viewer so rendering never depends on a
  // third-party server; the generated lightbox above remains an instant/offline
  // fallback while the 1K HDR is loading.
  referenceEnvironmentPromise = new RGBELoader()
    .loadAsync('./assets/venice_sunset_1k.hdr')
    .then(texture => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;

      const previousEnvironment = gemEnvironment;
      gemEnvironment = texture;
      for (const material of liveGemMaterials) {
        material.uniforms.envMap.value = texture;
        material.uniformsNeedUpdate = true;
      }
      if (previousEnvironment && previousEnvironment !== texture) {
        previousEnvironment.dispose();
      }
      return texture;
    })
    .catch(error => {
      console.warn('[gem] Reference HDR could not be loaded; using the built-in lightbox.', error);
      return gemEnvironment;
    });

  return referenceEnvironmentPromise;
}

/**
 * Builds the Viewer-owned refraction material for one named gem. The Rhino
 * material's working-space colour remains the tint, so ruby/sapphire/etc.
 * keep their authored appearance while gaining the same internal optics.
 */
export function createGemstoneMaterial({ mesh, sourceMaterial, kind, renderer }) {
  if (!mesh?.geometry?.attributes?.position || mesh.geometry.attributes.position.count < 12) return null;
  if (!renderer?.capabilities?.isWebGL2) return null;

  let resource;
  try {
    resource = getGemBvh(mesh.geometry);
  } catch (error) {
    console.warn(`[gem] ${kind} BVH could not be built; using the Rhino material instead.`, error);
    return null;
  }

  const material = new THREE.ShaderMaterial({
    name: `Drakon ${kind} Gemstone`,
    uniforms: {
      envMap: { value: getGemEnvironment() },
      bvh: { value: resource.uniform },
      bounces: { value: 3.0 },
      // Diamond's measured IOR is ~2.417. The same baseline looks convincing
      // for the coloured faceted stones in this first shared shader.
      ior: { value: 2.417 },
      aberrationStrength: { value: 0.01 },
      color: { value: sourceMaterial?.color?.clone?.() || new THREE.Color(0xffffff) }
    },
    vertexShader: GEM_VERTEX_SHADER,
    fragmentShader: GEM_FRAGMENT_SHADER,
    side: THREE.FrontSide,
    depthWrite: true,
    transparent: false,
    toneMapped: true
  });

  material.userData.__drakonGemMaterial = true;
  material.userData.gemstoneKind = kind;
  liveGemMaterials.add(material);
  resource.references++;

  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    liveGemMaterials.delete(material);
    resource.references--;
    if (resource.references <= 0) {
      resource.uniform.dispose();
      gemBvhByGeometry.delete(mesh.geometry);
    }
  });

  return material;
}
