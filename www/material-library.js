import { S } from './state.js';
import { applyDisplayMode } from './display.js';
import { showToast } from './helpers.js';

// First Drakon catalogue set. The physical values were read from the supplied
// materials.rhv library; Zircon is intentionally absent because its source
// sample is hidden. Gem presets are added once their matching UI icons arrive.
// `colorLinear` preserves the exact GLB/RHV PBR base-colour factor rather than
// round-tripping it through an sRGB hex value.
export const METAL_PRESETS = [
  {
    id: 'yellow-gold-18k', name: 'Yellow Gold 18K', icon: 'assets/materials/yellow-gold-18k.png',
    colorLinear: [0.89626936, 0.63075716, 0.27889429], metalness: 1, roughness: 0.15
  },
  {
    id: 'white-gold-18k', name: 'White Gold 18K', icon: 'assets/materials/white-gold-18k.png',
    colorLinear: [0.54572446, 0.54572446, 0.54572446], metalness: 1, roughness: 0.15
  },
  {
    id: 'rose-gold-18k', name: 'Rose Gold 18K', icon: 'assets/materials/rose-gold-18k.png',
    colorLinear: [0.89626935, 0.49102085, 0.27889426], metalness: 1, roughness: 0.15
  },
  {
    id: 'silver-925', name: 'Silver 925', icon: 'assets/materials/silver-925.png',
    colorLinear: [0.61720656, 0.62396039, 0.59720179], metalness: 1, roughness: 0.15
  },
  {
    id: 'platinum-950', name: 'Platinum 950', icon: 'assets/materials/platinum-950.png',
    colorLinear: [0.4677838, 0.4677838, 0.4677838], metalness: 1, roughness: 0.15
  },
  {
    id: 'palladium-18k', name: 'Palladium 18K', icon: 'assets/materials/palladium-18k.png',
    colorLinear: [0.4677838, 0.4677838, 0.4677838], metalness: 1, roughness: 0.15
  }
];

const METAL_NAME_PATTERN = /\b(?:gold|silver|platinum|palladium|steel|titanium|brass|bronze|copper)\b/i;

function isModelMesh(object) {
  return object?.isMesh
    && object.name !== 'rhino-edges'
    && object.name !== 'rhino-outline'
    && object.name !== 'selection-outline'
    && object.name !== 'ground-plane';
}

function materialNamesFor(object) {
  const layerIndex = object.userData?.attributes?.layerIndex ?? 0;
  const layer = S.parsedLayers.find(entry => entry.index === layerIndex);
  return [
    object.userData?.customMaterial?.name,
    object.userData?.rhinoObjectMaterial?.name,
    object.userData?.originalMaterial?.name,
    object.userData?.renderedMaterial?.name,
    layer?.customMaterial?.name,
    layer?.originalCustomMaterial?.name
  ].filter(Boolean);
}

function isDetectedMetal(object) {
  if (object.userData?.customMaterial?.materialCategory === 'metal') return true;
  if (materialNamesFor(object).some(name => METAL_NAME_PATTERN.test(name))) return true;

  // Imported models occasionally omit a material name. Their PBR metalness is
  // still a safe fallback: transparent stones and ordinary coloured materials
  // do not report themselves as near-full metal.
  const metalness = Math.max(
    Number(object.userData?.rhinoObjectMaterial?.metalness ?? 0),
    Number(object.userData?.originalMaterial?.metalness ?? 0),
    Number(object.userData?.renderedMaterial?.metalness ?? 0)
  );
  return metalness >= 0.85;
}

function makeMetalOverride(preset) {
  return {
    name: preset.name,
    materialCategory: 'metal',
    colorLinear: [...preset.colorLinear],
    metalness: preset.metalness,
    roughness: preset.roughness,
    opacity: 1,
    transmission: 0,
    clearcoat: 0,
    mapTexture: null,
    clearTextureMaps: true
  };
}

export function applyMetalPreset(presetId) {
  const preset = METAL_PRESETS.find(entry => entry.id === presetId);
  if (!preset || !S.currentModel) {
    showToast('Open a model to apply a material.');
    return;
  }

  const selectedMeshes = S.selectedObjects.filter(isModelMesh);
  const targets = selectedMeshes.length > 0 ? selectedMeshes : [];
  if (targets.length === 0) {
    S.currentModel.traverse(object => {
      if (isModelMesh(object) && isDetectedMetal(object)) targets.push(object);
    });
  }

  if (targets.length === 0) {
    showToast('No metal objects detected. Select objects to apply this material.');
    return;
  }

  for (const object of targets) object.userData.customMaterial = makeMetalOverride(preset);
  applyDisplayMode();
  showToast(`${preset.name} applied to ${targets.length} object${targets.length === 1 ? '' : 's'}.`);
}

export function renderMaterialsPanel() {
  const grid = document.getElementById('metal-material-grid');
  if (!grid) return;
  grid.replaceChildren();

  for (const preset of METAL_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'material-preset-btn';
    button.title = `Apply ${preset.name}`;
    button.dataset.materialPreset = preset.id;
    button.innerHTML = `<img src="${preset.icon}" alt="" draggable="false"><span>${preset.name}</span>`;
    button.addEventListener('click', () => applyMetalPreset(preset.id));
    grid.appendChild(button);
  }
}
