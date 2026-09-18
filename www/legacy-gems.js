// Recognition for jewellery plug-ins whose gem identity is kept in a Rhino
// geometry UserDictionary. rhino3dm.js preserves that binary data but does
// not expose the dictionary itself, so inspect only the stable dictionary keys
// used by the original plug-ins. No geometry or file data is changed.

const MATRIX_BLOCK_NAME = /(?:cabochon|pearl|diamond|simple|gem)_/i;

// This temporary Attribute User Text survives the Viewer preprocessor's block
// rebuild. It is never written back to the user's local .3dm.
export const LEGACY_GEM_USER_STRING_KEY = 'DkViewerLegacyGem';

function containsText(bytes, text) {
  if (!bytes?.length || !text) return false;
  const chars = Array.from(String(text), char => char.charCodeAt(0));

  // Rhino serialises dictionary keys as UTF-16LE. Keep the ASCII path too for
  // files written by a third-party archiver rather than Rhino itself.
  for (let start = 0; start <= bytes.length - chars.length; start++) {
    let match = true;
    for (let offset = 0; offset < chars.length; offset++) {
      if (bytes[start + offset] !== chars[offset]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  for (let start = 0; start <= bytes.length - chars.length * 2; start++) {
    let match = true;
    for (let offset = 0; offset < chars.length; offset++) {
      const byte = start + offset * 2;
      if (bytes[byte] !== chars[offset] || bytes[byte + 1] !== 0) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function utf16leBinaryString(text) {
  return Array.from(String(text), char => `${char}\0`).join('');
}

function encodedGeometryContains(geometry, markers) {
  try {
    const encoded = geometry?.encode?.();
    const binaryData = encoded?.data;
    if (typeof binaryData !== 'string' || !binaryData) return false;
    const bytes = atob(binaryData);
    return markers.every(marker => bytes.includes(marker) || bytes.includes(utf16leBinaryString(marker)));
  } catch {
    return false;
  }
}

/**
 * Checks the document once before per-object inspection, avoiding binary work
 * for normal Rhino documents that cannot contain one of these legacy gems.
 */
export function findLegacyGemSignals(bytes) {
  return {
    rhinoGold: containsText(bytes, 'isRhinoGoldGem') && containsText(bytes, 'gemTemplate'),
    drakonArchive: containsText(bytes, 'GemCut')
  };
}

/**
 * Matrix's converter treats these instance-definition names as gems. Keep the
 * same prefixes so an imported Matrix block is classified exactly as it is by
 * the Drakon conversion command.
 */
export function isMatrixGemBlockName(name) {
  return MATRIX_BLOCK_NAME.test(String(name || '').trim());
}

/**
 * Returns the source of a legacy gem carried by this geometry, or null.
 * RhinoGold's own converter requires both keys and a Mesh object; retaining
 * that constraint prevents unrelated RhinoGold geometry from becoming a gem.
 */
export function findLegacyGemGeometry(geometry, signals = {}) {
  const geometryType = geometry?.constructor?.name;
  if (signals.rhinoGold && geometryType === 'Mesh'
      && encodedGeometryContains(geometry, ['gemTemplate', 'isRhinoGoldGem'])) return 'rhino-gold';
  // Panther and earlier Drakon gems are identified by the same UserDictionary
  // entry that the desktop converter reads with TryGetInteger("GemCut").
  if (signals.drakonArchive && encodedGeometryContains(geometry, ['GemCut'])) return 'drakon-archive';
  return null;
}

export function isLegacyGem(object) {
  return Boolean(object?.userData?.legacyGem);
}
