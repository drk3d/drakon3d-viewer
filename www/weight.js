import { S } from './state.js';
import { t } from './i18n.js?v=drakon-1.6';
import { GEM_PRESETS, METAL_PRESETS } from './material-library.js?v=drakon-2.2';
import { isLegacyGem } from './legacy-gems.js';

// Densities are sourced from Drakon's Factory .rmtl materials. The Viewer
// receives only the Rhino material name from a .3dm, so this catalogue bridges
// that name to Drakon's calculation: grams = volume(mm³) * density / 1000.
const WEIGHT_MATERIALS = [
  ['Metal', 'Palladium 18K', 14.62], ['Metal', 'Platinum 950', 21.40],
  ['Metal', 'Rhodium', 12.44], ['Metal', 'Rose Gold 10K', 11.59],
  ['Metal', 'Rose Gold 14K', 13.26], ['Metal', 'Rose Gold 18K', 15.02],
  ['Metal', 'Silver 925', 10.35],
  ['Metal', 'White Gold 10K', 11.07],
  ['Metal', 'White Gold 14K', 12.61], ['Metal', 'White Gold 18K', 15.66],
  ['Metal', 'Yellow Gold 10K', 11.57], ['Metal', 'Yellow Gold 14K', 13.07],
  ['Metal', 'Yellow Gold 18K', 15.53],
  ['Metal', 'Yellow Gold 19.25K', 15.40],
  ['Metal', 'Yellow Gold 22K', 17.70],
  ['Gem', 'Almandite Violet', 3.90], ['Gem', 'Amethyst', 2.65],
  ['Gem', 'Aquamarine', 2.74], ['Gem', 'Aventurine', 2.64],
  ['Gem', 'Aventurine Blue', 2.64], ['Gem', 'Chalcedony', 2.60],
  ['Gem', 'Chalcedony Green', 2.60], ['Gem', 'Citrine', 2.65],
  ['Gem', 'Diamond', 3.52], ['Gem', 'Diamond Black', 3.52],
  ['Gem', 'Diamond Cognac', 3.52], ['Gem', 'Emerald', 2.70],
  ['Gem', 'Garnet', 4.00], ['Gem', 'Garnet Rhodolite', 3.84],
  ['Gem', 'Hiddenite Green', 3.15], ['Gem', 'Hiddenite Yellow', 3.15],
  ['Gem', 'Jade', 3.38], ['Gem', 'Kunzite Light-Violet', 3.15],
  ['Gem', 'Kunzite Pink Violet', 3.15], ['Gem', 'Lapis Lazuli', 2.70],
  ['Gem', 'Malachite', 3.90], ['Gem', 'Opal Black', 2.00],
  ['Gem', 'Opal White', 2.00], ['Gem', 'Pearl Black', 2.70],
  ['Gem', 'Pearl Golden', 2.70], ['Gem', 'Pearl Gray', 2.70],
  ['Gem', 'Pearl Lab', 2.70], ['Gem', 'Pearl Pink', 2.70],
  ['Gem', 'Pearl White', 2.70], ['Gem', 'Precious Beryl Yellow Green', 3.70],
  ['Gem', 'Quartz Rose', 2.65], ['Gem', 'Quartz Smokey', 2.65],
  ['Gem', 'Ruby', 3.97], ['Gem', 'Sapphire', 3.95],
  ['Gem', 'Topaz Blue', 3.50], ['Gem', 'Topaz Orange', 3.50],
  ['Gem', 'Tourmaline Pink', 3.00], ['Gem', 'Turquoise', 2.70],
  ['Gem', 'Zircon', 4.00]
].map(([category, name, density]) => ({ category, name, density }));

function normaliseMaterialName(name) {
  return String(name || '')
    .trim().toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    // These suffixes describe only the render/cut/finish variant. They have
    // the same density and must aggregate under the base material in Weight.
    .replace(/(?:\s+(?:ray\s*traced|cabochon|sand\s*blast(?:ed)?))+$/, '');
}

const MATERIAL_BY_NAME = new Map(
  WEIGHT_MATERIALS.map(material => [normaliseMaterialName(material.name), material])
);

function isModelMesh(object) {
  return object?.isMesh && !['rhino-edges', 'rhino-outline', 'selection-outline', 'ground-plane'].includes(object.name);
}

function isEffectivelyVisible(object) {
  for (let current = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

function materialNamesFor(object) {
  const layer = S.parsedLayers.find(entry => entry.index === (object.userData?.attributes?.layerIndex ?? 0));
  return [
    object.userData?.customMaterial?.name,
    object.userData?.rhinoObjectMaterial?.name,
    object.userData?.originalMaterial?.name,
    object.userData?.renderedMaterial?.name,
    layer?.customMaterial?.name,
    layer?.originalCustomMaterial?.name
  ].filter(Boolean);
}

function materialForObject(object) {
  for (const name of materialNamesFor(object)) {
    const material = MATERIAL_BY_NAME.get(normaliseMaterialName(name));
    if (material) return material;
  }
  // Legacy gems with no named Rhino material (notably RhinoGold) are rendered
  // as Diamond by the Viewer, so use the same density for the Weight panel.
  if (isLegacyGem(object)) return MATERIAL_BY_NAME.get('diamond') || null;
  return null;
}

function unitToMillimetres(unit) {
  const value = String(unit || '').trim().toLocaleLowerCase();
  if (!value || value === 'unknown' || value.includes('millimeter')) return 1;
  if (value.includes('micron')) return 0.001;
  if (value.includes('centimeter')) return 10;
  if (value.includes('meter')) return 1000;
  if (value.includes('kilometer')) return 1000000;
  if (value === 'in' || value.includes('inch')) return 25.4;
  if (value === 'ft' || value.includes('foot') || value.includes('feet')) return 304.8;
  if (value === 'yd' || value.includes('yard')) return 914.4;
  return 1;
}

function vertexKey(position, index) {
  return [position.getX(index), position.getY(index), position.getZ(index)]
    .map(value => Math.round(value * 1e6)).join(',');
}

function addEdge(edges, first, second) {
  const key = first < second ? `${first}|${second}` : `${second}|${first}`;
  edges.set(key, (edges.get(key) || 0) + 1);
}

function closedMeshVolumeInModelUnits(mesh) {
  const geometry = mesh.geometry;
  const position = geometry?.getAttribute?.('position');
  if (!position || position.count < 3) return 0;

  const index = geometry.getIndex?.();
  const available = index ? index.count : position.count;
  const start = Math.max(0, Math.min(available, geometry.drawRange?.start || 0));
  const drawn = geometry.drawRange?.count;
  const count = Math.max(0, Math.min(available - start, Number.isFinite(drawn) ? drawn : available - start));
  const end = start + count - (count % 3);
  const edges = new Map();
  let signedVolume = 0;
  let triangles = 0;
  const at = offset => index ? index.getX(offset) : offset;

  for (let offset = start; offset < end; offset += 3) {
    const ia = at(offset), ib = at(offset + 1), ic = at(offset + 2);
    const a = vertexKey(position, ia), b = vertexKey(position, ib), c = vertexKey(position, ic);
    if (a === b || b === c || c === a) continue;
    addEdge(edges, a, b); addEdge(edges, b, c); addEdge(edges, c, a);
    signedVolume += (
      position.getX(ia) * (position.getY(ib) * position.getZ(ic) - position.getZ(ib) * position.getY(ic))
      - position.getY(ia) * (position.getX(ib) * position.getZ(ic) - position.getZ(ib) * position.getX(ic))
      + position.getZ(ia) * (position.getX(ib) * position.getY(ic) - position.getY(ib) * position.getX(ic))
    ) / 6;
    triangles += 1;
  }

  if (triangles < 4 || ![...edges.values()].every(edgeCount => edgeCount === 2)) return 0;
  mesh.updateWorldMatrix(true, false);
  return Math.abs(signedVolume * mesh.matrixWorld.determinant());
}

function iconForMaterial(material) {
  const normalised = normaliseMaterialName(material.name);
  const presets = [...METAL_PRESETS, ...GEM_PRESETS];
  const exact = presets.find(preset => normaliseMaterialName(preset.name) === normalised);
  if (exact) return exact.icon;
  const fallbacks = [
    [/\bzircon\b/, 'diamond'], [/\bpearl\s+black\b/, 'pearl-black'], [/\bpearl\b/, 'pearl'],
    [/\byellow gold\b/, 'yellow-gold-18k'], [/\bwhite gold\b/, 'white-gold-18k'],
    [/\brose gold\b/, 'rose-gold-18k'], [/\bsilver\b/, 'silver-925'],
    [/\b(?:platinum|rhodium)\b/, 'platinum-950'], [/\bpalladium\b/, 'palladium-18k']
  ];
  for (const [pattern, id] of fallbacks) {
    if (pattern.test(normalised)) return presets.find(preset => preset.id === id)?.icon || '';
  }
  return material.category === 'Gem'
    ? GEM_PRESETS.find(preset => preset.id === 'diamond')?.icon || ''
    : METAL_PRESETS.find(preset => preset.id === 'yellow-gold-18k')?.icon || '';
}

export function getWeightRows(objects = null) {
  const targets = objects?.length
    ? objects.filter(isModelMesh)
    : (() => {
        const all = [];
        // With no selection, Weight represents exactly what the user can see.
        // Walk ancestors as well because an entire layer/group can be hidden.
        S.currentModel?.traverse(object => {
          if (isModelMesh(object) && isEffectivelyVisible(object)) all.push(object);
        });
        return all;
      })();
  const unitScale = unitToMillimetres(S.modelUnit);
  const totals = new Map();
  for (const object of targets) {
    const material = materialForObject(object);
    if (!material) continue;
    const volumeMm3 = closedMeshVolumeInModelUnits(object) * unitScale ** 3;
    if (!(volumeMm3 > 0)) continue;
    const grams = volumeMm3 * material.density / 1000;
    const entry = totals.get(material.name) || { ...material, grams: 0, icon: iconForMaterial(material) };
    entry.grams += grams;
    totals.set(material.name, entry);
  }
  return [...totals.values()].map(entry => ({
    ...entry,
    value: entry.category === 'Gem' ? entry.grams * 5 : entry.grams,
    unit: entry.category === 'Gem' ? 'ct' : 'g'
  })).sort((left, right) => {
    const categoryOrder = { Metal: 0, Gem: 1 };
    const categoryDifference = (categoryOrder[left.category] ?? 2) - (categoryOrder[right.category] ?? 2);
    return categoryDifference || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

export function renderWeightPanel(container, objects = S.selectedObjects) {
  if (!container) return;
  container.replaceChildren();
  const hasSelection = objects?.length > 0;
  const scope = document.createElement('p');
  scope.className = 'weight-scope';
  scope.textContent = hasSelection ? t('weight.selection') : t('weight.document');
  container.appendChild(scope);
  if (!S.currentModel) {
    const empty = document.createElement('p');
    empty.className = 'prop-materials-empty';
    empty.textContent = t('weight.no_model');
    container.appendChild(empty);
    return;
  }
  const rows = getWeightRows(objects);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'prop-materials-empty';
    empty.textContent = t('weight.none');
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'weight-list';
  const formatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'weight-row';
    const icon = document.createElement('img');
    icon.className = 'weight-material-icon';
    icon.src = row.icon; icon.alt = ''; icon.draggable = false;
    icon.addEventListener('error', () => { icon.hidden = true; }, { once: true });
    const name = document.createElement('span');
    name.className = 'weight-material-name'; name.textContent = row.name;
    const value = document.createElement('span');
    value.className = 'weight-material-value'; value.textContent = `${formatter.format(row.value)} ${row.unit}`;
    item.append(icon, name, value);
    list.appendChild(item);
  }
  container.appendChild(list);
}
