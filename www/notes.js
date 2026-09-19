// notes.js — pin-marker notes anchored to model surface points.
//
// Architecture mirrors the distance/angle tools in tools.js:
//   • S.noteToolState toggles the active tool (set/cleared by activateNoteTool)
//   • The canvas click router (tools.js → onCanvasClick) calls placeNote() when
//     the note tool is active.
//   • Each note is a S.notes[] entry. Its 3D marker is a sprite added to
//     S.measurementGroup (shares the AO-excluded Layer 1 setup).
//   • Click on a marker opens an HTML bubble (Phase 3); list lives in the File
//     panel (Phase 4); persistence in session save/load (Phase 5).
//
// This file owns: tool activation, marker creation, public CRUD for notes.

import * as THREE from 'three';
import { S } from './state.js';
import { t } from './i18n.js';

// Inline SVG template — explicit width/height (Chromium refuses to upload
// viewBox-only SVG <img> elements as WebGL textures, which Firefox accepts).
// Kept on one line so the data: URI has no raw newlines either.
const PIN_SVG_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80"><path d="M32 4 C18 4 8 14 8 28 c0 18 24 46 24 46 s24 -28 24 -46 c0 -14 -10 -24 -24 -24 z" fill="__COLOR__" stroke="#000" stroke-width="3" stroke-linejoin="round"/><circle cx="32" cy="28" r="7" fill="white" stroke="#000" stroke-width="2.5"/></svg>`;

// Rasterise the SVG once per colour through an offscreen canvas, then wrap
// the canvas in a CanvasTexture. CanvasTexture has stable cross-browser
// upload semantics — TextureLoader on an SVG <img> works in Firefox but
// frequently lands as a blank texture in Chromium (Chrome/Edge/Android
// WebView), making the pin invisible even though the sprite exists.
const _textureCache = new Map();
const PIN_PX_W = 128;                          // pin texture resolution
const PIN_PX_H = Math.round(PIN_PX_W * 80 / 64);
function pinTexture(hexColor) {
  const key = hexColor.toLowerCase();
  if (_textureCache.has(key)) return _textureCache.get(key);

  const canvas = document.createElement('canvas');
  canvas.width  = PIN_PX_W;
  canvas.height = PIN_PX_H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearMipmapLinearFilter;
  tex.magFilter  = THREE.LinearFilter;
  tex.generateMipmaps = true;

  const svg = PIN_SVG_TEMPLATE.replace('__COLOR__', hexColor);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    tex.needsUpdate = true;
  };
  img.src = url;

  _textureCache.set(key, tex);
  return tex;
}

/**
 * Build a pin marker sprite sized in world units (sizeAttenuation:true) so it
 * scales with the camera the same way measurement spheres do. The base scale
 * is derived from the model bounding box and then multiplied by the live
 * measurementScale slider so users have a single knob.
 */
function buildPinSprite(color, position) {
  const mat = new THREE.SpriteMaterial({
    map: pinTexture(color),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const sprite = new THREE.Sprite(mat);
  // Measurement spheres use size.length()*0.003 as their radius; pin diameter
  // here is ~0.012 of model length (a touch wider than a meas point so it
  // reads as a pin, not a dot). Pin aspect ratio is 64:80 from the SVG.
  const modelSize = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length()
    : 100;
  const base = modelSize * 0.012;
  const scaleMult = S.measurementScale ?? 1.0;
  sprite.scale.set(base * scaleMult, base * 1.25 * scaleMult, 1);
  // Pivot the sprite so its TIP (bottom-center) is at `position` — same way a
  // real map pin is anchored. Three.js Sprite has a `center` property in [0,1].
  sprite.center.set(0.5, 0);
  sprite.position.copy(position);
  sprite.userData = { type: 'note-marker', baseScale: base };
  sprite.castShadow = false;
  sprite.receiveShadow = false;
  return sprite;
}

/**
 * Re-apply the measurementScale slider value to every pin's scale. Called
 * from the slider handler so notes track the same Text Size knob users
 * already use for measurements.
 */
export function refreshAllNoteScales() {
  const mult = S.measurementScale ?? 1.0;
  for (const n of S.notes) {
    const base = n.marker?.userData?.baseScale;
    if (!base || !n.marker) continue;
    n.marker.scale.set(base * mult, base * 1.25 * mult, 1);
  }
}

// ── Tool activation ────────────────────────────────────────────────────────

export function activateNoteTool() {
  // Deactivate other tools first (mirrors how distance/angle handlers work in
  // tools.js — they exit each other via deactivateAllMeasurementTools()).
  if (typeof window._deactivateMeasurementTools === 'function') {
    window._deactivateMeasurementTools();
  }
  S.noteToolState = { active: true };
  document.body.style.cursor = 'crosshair';
  document.getElementById('btn-tool-note')?.classList.add('active');
}

export function deactivateNoteTool() {
  S.noteToolState = null;
  document.body.style.cursor = '';
  document.getElementById('btn-tool-note')?.classList.remove('active');
}

// ── Marker placement (called by the canvas click router) ───────────────────

/**
 * Create a note at the given world-space position.
 * Returns the note entry (without marker added to scene until renderMarker
 * is called). Currently both happen here for simplicity — Phase 2 follow-up
 * will prompt for text before attaching the marker.
 */
export function createNote(position, text = '', color = S.noteDefaultColor) {
  const sprite = buildPinSprite(color, position);
  S.measurementGroup.add(sprite);

  const note = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    position: [position.x, position.y, position.z],
    text,
    color,
    createdAt: new Date().toISOString(),
    marker: sprite,
  };
  S.notes.push(note);
  return note;
}

export function deleteNote(id) {
  const idx = S.notes.findIndex(n => n.id === id);
  if (idx < 0) return;
  const note = S.notes[idx];
  if (note.marker) {
    S.measurementGroup.remove(note.marker);
    note.marker.material?.dispose?.();
    // texture is shared via pinTexture cache — don't dispose
  }
  S.notes.splice(idx, 1);
  if (S.noteActiveId === id) S.noteActiveId = null;
}

export function updateNote(id, { text, color } = {}) {
  const note = S.notes.find(n => n.id === id);
  if (!note) return;
  if (typeof text === 'string') note.text = text;
  if (typeof color === 'string' && color !== note.color) {
    note.color = color;
    // Swap the sprite texture to the new color
    if (note.marker?.material) {
      note.marker.material.map = pinTexture(color);
      note.marker.material.needsUpdate = true;
    }
  }
}

export function clearAllNotes() {
  for (const n of S.notes.slice()) deleteNote(n.id);
}

// ── Text input dialog (used by both "create" and "edit" flows) ─────────────

const PRESET_COLORS = ['#fbbf24', '#ef4444', '#10b981', '#3b82f6', '#a855f7', '#ec4899', '#64748b'];

/**
 * Modal dialog returning { text, color } on save, or null on cancel.
 * If `existing` is provided, prefills its text/color and the dialog acts as
 * an edit form.
 */
export function openNoteDialog(existing = null) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'note-dialog-overlay';
    const initText  = existing?.text ?? '';
    const initColor = existing?.color ?? S.noteDefaultColor;

    overlay.innerHTML = `
      <div class="note-dialog" role="dialog" aria-modal="true">
        <div class="note-dialog-header">
          <span class="note-dialog-title">${existing ? t('note.edit_title') : t('note.new')}</span>
          <button class="note-dialog-close" aria-label="Close">×</button>
        </div>
        <div class="note-dialog-body">
          <label class="note-dialog-label">${t('note.color_label')}</label>
          <div class="note-color-swatches"></div>
          <label class="note-dialog-label" style="margin-top:10px;">${t('note.text_label')}</label>
          <textarea class="note-dialog-text" rows="5" placeholder="${t('note.placeholder')}"></textarea>
        </div>
        <div class="note-dialog-footer">
          <button class="note-btn note-btn-cancel">${t('note.cancel')}</button>
          <button class="note-btn note-btn-save">${t('note.save')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const textEl = overlay.querySelector('.note-dialog-text');
    textEl.value = initText;
    setTimeout(() => textEl.focus(), 0);

    let currentColor = initColor;
    const swatchHost = overlay.querySelector('.note-color-swatches');
    PRESET_COLORS.forEach(c => {
      const sw = document.createElement('button');
      sw.className = 'note-color-swatch' + (c === currentColor ? ' selected' : '');
      sw.style.background = c;
      sw.dataset.color = c;
      sw.addEventListener('click', () => {
        currentColor = c;
        swatchHost.querySelectorAll('.note-color-swatch').forEach(el => el.classList.toggle('selected', el.dataset.color === c));
      });
      swatchHost.appendChild(sw);
    });

    function close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
    }
    function save() {
      const text = textEl.value.trim();
      if (!text) { textEl.focus(); return; }
      close({ text, color: currentColor });
    }
    overlay.querySelector('.note-dialog-close').addEventListener('click', () => close(null));
    overlay.querySelector('.note-btn-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.note-btn-save').addEventListener('click', save);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Called by the canvas click router when the Note tool is active. Opens the
 * dialog at the placement point; on save, creates the note and refreshes the
 * file panel list. Tool stays active for chain-placement.
 */
export async function promptAndCreateNote(position) {
  const result = await openNoteDialog(null);
  if (!result) return;
  createNote(position, result.text, result.color);
  // Refresh the list — Phase 4 will define this. Soft-import so the missing
  // function doesn't crash here in Phase 2.
  try {
    const m = await import('./notes-ui.js');
    m.renderNoteListUI?.();
  } catch (_) { /* not yet implemented */ }
}
