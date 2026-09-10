// Drakon object identity that accompanies a Share snapshot. The value comes
// from the plug-in's custom Rhino object type, never from a material name.
export const DRAKON_VIEWER_OBJECT_TYPE_KEY = 'DkViewerObjectType';

const GEM_TYPES = new Set([
  'gem',
  'cabochon',
  'mixedgem',
  'gemcreator',
  'trapezoidcut'
]);

export function isDrakonGemType(value) {
  return GEM_TYPES.has(String(value ?? '').replace(/[\s_-]/g, '').toLowerCase());
}

// rhino3dm has returned user strings as both an array of key/value tuples and
// as an object across releases, so accept either form.
export function readRhinoUserString(attributes, key) {
  try {
    const direct = attributes?.getUserString?.(key);
    if (typeof direct === 'string' && direct) return direct;
  } catch {}

  try {
    const raw = attributes?.getUserStrings?.();
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const entryKey = String(entry?.key ?? entry?.[0] ?? '');
        if (entryKey === key) return String(entry?.value ?? entry?.[1] ?? '');
      }
    } else if (raw && typeof raw === 'object' && raw[key] != null) {
      return String(raw[key]);
    }
  } catch {}

  return null;
}
