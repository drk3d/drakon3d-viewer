// notes-ui.js — DOM-side concerns for the Note tool.
//
// Split from notes.js to keep the geometric/state half independent of the
// browser layer. notes.js handles markers + state; this module handles:
//   • Per-frame bubble positioning (3D world → screen projection)
//   • Marker click → show bubble for that note
//   • File-panel list rendering, edit/delete buttons, fly-to-on-click

import * as THREE from 'three';
import { S } from './state.js';
import { deleteNote, updateNote, openNoteDialog } from './notes.js';

// ── HTML bubble ─────────────────────────────────────────────────────────────

let _bubbleEl = null;
let _bubbleEdit = null;
let _bubbleDelete = null;
let _bubbleText = null;

function ensureBubble() {
  if (_bubbleEl) return;
  _bubbleEl     = document.getElementById('note-bubble');
  _bubbleText   = document.getElementById('note-bubble-text');
  _bubbleEdit   = document.getElementById('note-bubble-edit');
  _bubbleDelete = document.getElementById('note-bubble-delete');
  if (!_bubbleEl) return;

  _bubbleEdit.addEventListener('click', async () => {
    const n = S.notes.find(x => x.id === S.noteActiveId);
    if (!n) return;
    const result = await openNoteDialog(n);
    if (!result) return;
    updateNote(n.id, result);
    renderNoteListUI();
    refreshBubbleContent();
  });
  _bubbleDelete.addEventListener('click', () => {
    const id = S.noteActiveId;
    if (id == null) return;
    deleteNote(id);
    hideBubble();
    renderNoteListUI();
  });
}

export function showBubbleForNote(noteId) {
  ensureBubble();
  const n = S.notes.find(x => x.id === noteId);
  if (!n || !_bubbleEl) return;
  S.noteActiveId = noteId;
  refreshBubbleContent();
  _bubbleEl.classList.add('visible');
}

function refreshBubbleContent() {
  const n = S.notes.find(x => x.id === S.noteActiveId);
  if (!n || !_bubbleEl) return;
  _bubbleText.textContent = n.text;
  _bubbleEl.style.setProperty('--note-accent', n.color);
}

export function hideBubble() {
  if (!_bubbleEl) return;
  _bubbleEl.classList.remove('visible');
  // updateBubblePosition() writes inline style.display each frame while a
  // bubble is shown, and bails out early once noteActiveId becomes null —
  // so we must clear the inline style here, otherwise the CSS rule
  // (`.note-bubble { display: none }`) is overridden and the bubble lingers.
  _bubbleEl.style.display = 'none';
  S.noteActiveId = null;
}

/**
 * Called once per frame from the animate loop. Projects the active note's
 * marker world position to screen coords and pins the bubble next to it.
 */
const _v = new THREE.Vector3();
export function updateBubblePosition() {
  if (!_bubbleEl || S.noteActiveId == null) return;
  const n = S.notes.find(x => x.id === S.noteActiveId);
  if (!n?.marker) return;
  n.marker.getWorldPosition(_v);
  _v.project(S.camera);
  // Behind the camera or off-screen → just hide
  if (_v.z > 1) { _bubbleEl.style.display = 'none'; return; }
  _bubbleEl.style.display = _bubbleEl.classList.contains('visible') ? 'block' : 'none';

  const x = (_v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
  // Place bubble to the right of the pin; flip if near right edge.
  const w = _bubbleEl.offsetWidth || 220;
  const h = _bubbleEl.offsetHeight || 60;
  let left = x + 16;
  if (left + w > window.innerWidth - 8) left = x - w - 16;
  let top = y - h / 2;
  if (top < 8) top = 8;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
  _bubbleEl.style.left = left + 'px';
  _bubbleEl.style.top  = top  + 'px';
}

// ── Marker pointer-hit detection ───────────────────────────────────────────

const _raycaster = new THREE.Raycaster();
const _mouse     = new THREE.Vector2();

/**
 * Returns the note whose marker was hit at the given clientX/Y, or null.
 * Markers are sprites under S.measurementGroup with userData.type='note-marker'.
 */
export function pickNoteMarker(clientX, clientY) {
  if (!S.notes.length || !S.camera) return null;
  _mouse.x = (clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(clientY / window.innerHeight) * 2 + 1;
  _raycaster.setFromCamera(_mouse, S.camera);
  // Match camera's enabled layers (markers live on Layer 1).
  // CRITICAL: copy the mask only — never share the Layers instance, otherwise
  // mutating _raycaster.layers later mutates S.camera.layers (which would hide
  // all Layer 1 content: notes, measurements, annotations).
  _raycaster.layers.mask = S.camera.layers.mask;
  const markers = S.notes.map(n => n.marker).filter(Boolean);
  const hits = _raycaster.intersectObjects(markers, false);
  if (!hits.length) return null;
  const hit = hits[0].object;
  return S.notes.find(n => n.marker === hit) || null;
}

// ── Pin drag (active when Gumball/"Move" mode is on) ──────────────────────

let _dragState = null; // { noteId, sphereStart, lastPos }

export function beginNoteDrag(noteId) {
  const n = S.notes.find(x => x.id === noteId);
  if (!n?.marker) return false;
  _dragState = { noteId };
  if (S.controls) S.controls.enabled = false;
  document.body.style.cursor = 'grabbing';
  hideBubble();
  return true;
}

/**
 * Called during pointermove while a drag is active. Raycasts against the
 * loaded model surface — if the pointer hovers a face we snap the marker
 * there; otherwise we leave it in its previous position so the user can
 * lift off and try again.
 */
export function updateNoteDrag(clientX, clientY) {
  if (!_dragState || !S.currentModel) return;
  _mouse.x = (clientX / window.innerWidth)  * 2 - 1;
  _mouse.y = -(clientY / window.innerHeight) * 2 + 1;
  _raycaster.setFromCamera(_mouse, S.camera);
  _raycaster.layers.set(0); // model lives on layer 0
  const hits = _raycaster.intersectObject(S.currentModel, true);
  const hit = hits.find(h => h.object.isMesh &&
    !['ground-plane','rhino-edges','rhino-outline','selection-outline'].includes(h.object.name));
  if (!hit) return;
  const note = S.notes.find(n => n.id === _dragState.noteId);
  if (!note?.marker) return;
  note.marker.position.copy(hit.point);
}

export function endNoteDrag() {
  if (!_dragState) return;
  const note = S.notes.find(n => n.id === _dragState.noteId);
  if (note?.marker) {
    note.position = [
      note.marker.position.x,
      note.marker.position.y,
      note.marker.position.z,
    ];
  }
  _dragState = null;
  if (S.controls) S.controls.enabled = true;
  document.body.style.cursor = '';
}

export function isNoteDragging() { return _dragState !== null; }

// ── File-panel list ─────────────────────────────────────────────────────────

export function renderNoteListUI() {
  let host = document.getElementById('notes-list');
  if (!host) return;
  host.innerHTML = '';
  if (!S.notes.length) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.dataset.i18n = 'note.empty';
    empty.textContent = 'No notes yet';
    host.appendChild(empty);
    return;
  }
  for (const n of S.notes) {
    const row = document.createElement('div');
    row.className = 'note-row';
    row.innerHTML = `
      <span class="note-dot" style="background:${n.color}"></span>
      <span class="note-row-text"></span>
      <span class="note-row-actions">
        <button class="note-row-btn" data-action="edit" title="Edit">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M2 14l3-1L13 5l-2-2L3 11l-1 3z"/></svg>
        </button>
        <button class="note-row-btn danger" data-action="delete" title="Delete">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10"/></svg>
        </button>
      </span>
    `;
    row.querySelector('.note-row-text').textContent = n.text.replace(/\s+/g, ' ').slice(0, 60);

    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;  // action buttons handle themselves
      flyToNote(n);
      showBubbleForNote(n.id);
    });
    row.querySelector('[data-action="edit"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await openNoteDialog(n);
      if (!result) return;
      updateNote(n.id, result);
      renderNoteListUI();
      if (S.noteActiveId === n.id) refreshBubbleContent();
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNote(n.id);
      if (S.noteActiveId === n.id) hideBubble();
      renderNoteListUI();
    });

    host.appendChild(row);
  }
}

// Smoothly orbit + dolly so the marker is centered in view. Uses the existing
// camera transition infrastructure if available; otherwise sets target/position
// directly.
function flyToNote(note) {
  if (!note.marker || !S.controls) return;
  const target = new THREE.Vector3(note.position[0], note.position[1], note.position[2]);
  // Compute a viewpoint along the current camera→target axis at a comfortable
  // distance based on the model size.
  const modelSize = S.currentModel
    ? new THREE.Box3().setFromObject(S.currentModel).getSize(new THREE.Vector3()).length()
    : 100;
  const dir = new THREE.Vector3().subVectors(S.camera.position, S.controls.target).normalize();
  const newPos = target.clone().add(dir.multiplyScalar(modelSize * 0.4));
  S.camera.position.copy(newPos);
  S.controls.target.copy(target);
  S.controls.update();
}
