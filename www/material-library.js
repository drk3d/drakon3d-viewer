import { S } from './state.js';
import { applyDisplayMode } from './display.js';
import { showToast } from './helpers.js';
import { History } from './history.js';

// Drakon catalogue presets. Physical values come from the supplied
// materials.rhv library; Zircon is intentionally absent because its source
// sample is hidden. `colorLinear` preserves authored GLB/RHV PBR values rather
// than round-tripping them through an sRGB hex value.
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

const gemIcon = (name) => `assets/materials/gems/${name}.png`;

// The faceted stones are intentionally named exactly as their Drakon/Rhino
// materials. That lets display.js recognise them and replace the temporary PBR
// material with the Viewer-owned refraction shader. Opaque/texture-like stones
// stay on the regular PBR path instead.
export const GEM_PRESETS = [
  { id: 'diamond', name: 'Diamond', icon: gemIcon('diamond'), colorLinear: [0.89626935, 0.89626935, 0.89626935], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'almandite-violet', name: 'Almandite Violet', icon: gemIcon('almandite-violet'), color: '#CF398F', roughness: 0, opacity: 0.65, faceted: true },
  { id: 'amethyst', name: 'Amethyst', icon: gemIcon('amethyst'), color: '#9678B6', roughness: 0, opacity: 0.85, faceted: true },
  { id: 'aquamarine', name: 'Aquamarine', icon: gemIcon('aquamarine'), color: '#66CDCA', roughness: 0, opacity: 0.85, faceted: true },
  { id: 'aventurine-blue', name: 'Aventurine Blue', icon: gemIcon('aventurine-blue'), colorLinear: [0.02028856, 0.1746474, 0.29613827], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'aventurine', name: 'Aventurine', icon: gemIcon('aventurine'), colorLinear: [0.63075714, 0.79129794, 0.29613827], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'chalcedony-green', name: 'Chalcedony Green', icon: gemIcon('chalcedony-green'), colorLinear: [0.05126946, 0.30946892, 0.14702727], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'chalcedony', name: 'Chalcedony', icon: gemIcon('chalcedony'), colorLinear: [0.18447499, 0.30054379, 0.41788507], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'citrine', name: 'Citrine', icon: gemIcon('citrine'), colorLinear: [0.56471151, 0.28314874, 0.03560131], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'diamond-black', name: 'Diamond Black', icon: gemIcon('diamond-black'), colorLinear: [0.08437621, 0.08437621, 0.08437621], roughness: 0, opacity: 0.99, faceted: true },
  { id: 'diamond-cognac', name: 'Diamond Cognac', icon: gemIcon('diamond-cognac'), color: '#E4CA7A', roughness: 0, opacity: 0.65, faceted: true },
  { id: 'emerald', name: 'Emerald', icon: gemIcon('emerald'), colorLinear: [0.08021982, 0.57758044, 0.18782077], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'garnet-rhodolite', name: 'Garnet Rhodolite', icon: gemIcon('garnet-rhodolite'), colorLinear: [0.14702727, 0.03189603, 0.03560131], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'garnet', name: 'Garnet', icon: gemIcon('garnet'), colorLinear: [0.33245154, 0.02624122, 0.03560131], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'hiddenite-green', name: 'Hiddenite Green', icon: gemIcon('hiddenite-green'), color: '#529557', roughness: 0, opacity: 0.85, faceted: true },
  { id: 'hiddenite-yellow', name: 'Hiddenite Yellow', icon: gemIcon('hiddenite-yellow'), color: '#F8D65C', roughness: 0, opacity: 0.85, faceted: true },
  { id: 'kunzite-light-violet', name: 'Kunzite Light-Violet', icon: gemIcon('kunzite-light-violet'), colorLinear: [0.26225066, 0.06301002, 0.45078578], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'kunzite-pink-violet', name: 'Kunzite Pink Violet', icon: gemIcon('kunzite-pink-violet'), colorLinear: [0.39157248, 0.07227185, 0.19806932], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'precious-beryl-yellow-green', name: 'Precious Beryl Yellow Green', icon: gemIcon('precious-beryl-yellow-green'), color: '#83A700', roughness: 0, opacity: 0.85, faceted: true },
  { id: 'quartz-rose', name: 'Quartz Rose', icon: gemIcon('quartz-rose'), colorLinear: [0.74540421, 0.30946892, 0.53947949], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'quartz-smokey', name: 'Quartz Smokey', icon: gemIcon('quartz-smokey'), colorLinear: [0.45641102, 0.27467731, 0.14702727], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'ruby', name: 'Ruby', icon: gemIcon('ruby'), colorLinear: [0.74540421, 0.00560539, 0.11443537], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'sapphire', name: 'Sapphire', icon: gemIcon('sapphire'), colorLinear: [0.00477695, 0.08437621, 0.49102085], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'topaz-blue', name: 'Topaz Blue', icon: gemIcon('topaz-blue'), colorLinear: [0.02028856, 0.1746474, 0.29613827], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'topaz-orange', name: 'Topaz Orange', icon: gemIcon('topaz-orange'), colorLinear: [0.40197778, 0.13013648, 0.00477695], roughness: 0, opacity: 0.85, faceted: true },
  { id: 'tourmaline-pink', name: 'Tourmaline Pink', icon: gemIcon('tourmaline-pink'), color: '#9B4A71', roughness: 0, opacity: 0.84, faceted: true },

  { id: 'jade', name: 'Jade', icon: gemIcon('jade'), colorLinear: [0.12213877, 0.1714411, 0.06301002], roughness: 0.55, clearcoat: 0.67, ior: 1.43902438 },
  { id: 'lapis-lazuli', name: 'Lapis Lazuli', icon: gemIcon('lapis-lazuli'), color: '#273C78', roughness: 0.12, clearcoat: 0.38, ior: 2.33333333 },
  { id: 'malachite', name: 'Malachite', icon: gemIcon('malachite'), color: '#2B765D', roughness: 0.12, clearcoat: 0.24, ior: 2.33333333 },
  { id: 'opal-black', name: 'Opal Black', icon: gemIcon('opal-black'), colorLinear: [0.04666509, 0.06847817, 0.04231141], roughness: 0.5, clearcoat: 0.25, ior: 1.5 },
  { id: 'opal-white', name: 'Opal White', icon: gemIcon('opal-white'), colorLinear: [0.33245154, 0.45078578, 0.4735315], roughness: 0.55, clearcoat: 0.83, ior: 1.43902438 },
  { id: 'pearl-black', name: 'Pearl Black', icon: gemIcon('pearl-black'), colorLinear: [0.01161225, 0.01520851, 0.01161225], roughness: 0.55, clearcoat: 0.55, ior: 1.43902438 },
  { id: 'pearl', name: 'Pearl', icon: gemIcon('pearl'), color: '#EEEAE3', roughness: 0.2, clearcoat: 0.86, ior: 1.43902438 },
  { id: 'turquoise', name: 'Turquoise', icon: gemIcon('turquoise'), color: '#4CBBC2', roughness: 0.15, clearcoat: 0.32, ior: 2.33333333 }
];

const CATALOGUE_PRESETS = [...METAL_PRESETS, ...GEM_PRESETS];

const METAL_NAME_PATTERN = /\b(?:gold|silver|platinum|palladium|steel|titanium|brass|bronze|copper)\b/i;
const GEM_NAME_PATTERN = /\b(?:almandite|amethyst|aquamarine|aventurine|chalcedony|citrine|diamond|emerald|garnet|hiddenite|jade|kunzite|lapis\s+lazuli|malachite|opal|pearl|precious\s+beryl|quartz|ruby|sapphire|topaz|tourmaline|turquoise)\b/i;

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

function isDetectedGem(object) {
  return object.userData?.customMaterial?.materialCategory === 'gem'
    || materialNamesFor(object).some(name => GEM_NAME_PATTERN.test(name));
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

function makeGemOverride(preset) {
  return {
    name: preset.name,
    materialCategory: 'gem',
    ...(Array.isArray(preset.colorLinear)
      ? { colorLinear: [...preset.colorLinear] }
      : { color: preset.color }),
    metalness: 0,
    roughness: preset.roughness,
    opacity: preset.opacity ?? 1,
    transmission: 0,
    ...(preset.ior ? { ior: preset.ior } : {}),
    ...(preset.clearcoat ? { clearcoat: preset.clearcoat } : {}),
    mapTexture: null,
    clearTextureMaps: true
  };
}

function cloneCustomMaterial(material) {
  if (!material) return null;
  const copy = { ...material };
  if (Array.isArray(material.colorLinear)) copy.colorLinear = [...material.colorLinear];
  return copy;
}

function captureMaterialStates(targets) {
  return targets.map(object => ({
    customMaterial: cloneCustomMaterial(object.userData.customMaterial),
    isMaterialByLayer: !!object.userData.isMaterialByLayer
  }));
}

function applyObjectMaterialPreset(targets, makeOverride) {
  const before = captureMaterialStates(targets);
  for (const object of targets) {
    object.userData.customMaterial = makeOverride();
    object.userData.isMaterialByLayer = false;
  }
  const after = captureMaterialStates(targets);
  History.push({ type: 'material', targets: [...targets], before, after });
}

function normaliseMaterialName(name) {
  return String(name || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    // Drakon/Rhino display materials may carry implementation/form suffixes.
    // They identify the rendering path or cut, not a different catalogue gem.
    .replace(/(?:\s+(?:ray\s*traced|cabochon))+$/, '');
}

/**
 * Returns a fresh Viewer material override for a recognised Rhino material
 * name. This is deliberately non-mutating: a later user-applied material is
 * still an object override and Undo can return to the original named preset.
 */
export function catalogueMaterialOverrideFromNames(...names) {
  for (const name of names) {
    const normalised = normaliseMaterialName(name);
    if (!normalised) continue;

    // Zircon has no catalogue swatch yet, so it intentionally follows the
    // Diamond material. Every Pearl family member uses Pearl except the
    // dedicated Pearl Black material.
    if (/\bzircon\b/.test(normalised)) {
      return makeGemOverride(GEM_PRESETS.find(preset => preset.id === 'diamond'));
    }
    if (/\bpearl\b/.test(normalised)) {
      const pearlId = /\bpearl\s+black\b/.test(normalised) ? 'pearl-black' : 'pearl';
      return makeGemOverride(GEM_PRESETS.find(preset => preset.id === pearlId));
    }

    const preset = CATALOGUE_PRESETS.find(entry => normaliseMaterialName(entry.name) === normalised);
    if (preset) {
      return METAL_PRESETS.includes(preset)
        ? makeMetalOverride(preset)
        : makeGemOverride(preset);
    }
  }
  return null;
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

  applyObjectMaterialPreset(targets, () => makeMetalOverride(preset));
  applyDisplayMode();
  showToast(`${preset.name} applied to ${targets.length} object${targets.length === 1 ? '' : 's'}.`);
}

export function applyGemPreset(presetId) {
  const preset = GEM_PRESETS.find(entry => entry.id === presetId);
  if (!preset || !S.currentModel) {
    showToast('Open a model to apply a material.');
    return;
  }

  const selectedMeshes = S.selectedObjects.filter(isModelMesh);
  const targets = selectedMeshes.length > 0 ? selectedMeshes : [];
  if (targets.length === 0) {
    S.currentModel.traverse(object => {
      if (isModelMesh(object) && isDetectedGem(object)) targets.push(object);
    });
  }

  if (targets.length === 0) {
    showToast('No gem objects detected. Select objects to apply this material.');
    return;
  }

  applyObjectMaterialPreset(targets, () => makeGemOverride(preset));
  applyDisplayMode();
  showToast(`${preset.name} applied to ${targets.length} object${targets.length === 1 ? '' : 's'}.`);
}

function renderPresetGrid(gridId, presets, applyPreset) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.replaceChildren();

  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'material-preset-btn';
    button.title = `Apply ${preset.name}`;
    button.dataset.materialPreset = preset.id;
    button.innerHTML = `<img src="${preset.icon}" alt="" draggable="false"><span>${preset.name}</span>`;
    button.addEventListener('click', () => applyPreset(preset.id));
    grid.appendChild(button);
  }
}

export function renderMaterialsPanel() {
  renderPresetGrid('metal-material-grid', METAL_PRESETS, applyMetalPreset);
  renderPresetGrid('gem-material-grid', GEM_PRESETS, applyGemPreset);
}
