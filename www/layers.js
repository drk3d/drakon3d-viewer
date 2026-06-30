import { S } from './state.js';
import { applyLayerColorsToModel, applyDisplayMode } from './display.js';
import { createAnnotationSprites } from './annotations.js';

// Tracks which parent layers are collapsed (by layer index). Persists across
// re-renders within a session; stale indices from a previous file are harmless.
const collapsedLayers = new Set();

const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => {
  const hex = Math.min(255, Math.max(0, x)).toString(16);
  return hex.length === 1 ? '0' + hex : hex;
}).join('');

const getLayerHex = (layer) => {
  if (!layer || !layer.color) return '#888888';
  const c = layer.color;
  const r = c.r ?? c.R ?? 120;
  const g = c.g ?? c.G ?? 120;
  const b = c.b ?? c.B ?? 120;
  return rgbToHex(r, g, b);
};

export function renderLayerUI() {
  const list = document.getElementById('layer-list-panel') || document.getElementById('layer-list');
  if (!list) return;
  list.innerHTML = '';

  if (S.parsedLayers.length === 0) {
    list.innerHTML = '<span class="dropdown-empty-msg">No layers parsed</span>';
    return;
  }

  const nodeByIndex = {};
  const roots = [];

  S.parsedLayers.forEach(layer => {
    const label = layer.name.includes('::')
      ? layer.name.split('::').pop()
      : layer.name;
    nodeByIndex[layer.index] = { layer, label, depth: 0, children: [] };
  });

  S.parsedLayers.forEach(layer => {
    const node      = nodeByIndex[layer.index];
    const parentIdx = layer.parentLayerIndex ?? -1;
    if (parentIdx >= 0 && nodeByIndex[parentIdx]) {
      nodeByIndex[parentIdx].children.push(node);
    } else {
      roots.push(node);
    }
  });

  // Fallback: infer hierarchy from "::" names when parentLayerIndex gives no nesting
  if (roots.length === S.parsedLayers.length && S.parsedLayers.some(l => l.name.includes('::'))) {
    roots.length = 0;
    S.parsedLayers.forEach(l => { nodeByIndex[l.index].children = []; });
    const nameToNode = {};
    S.parsedLayers.forEach(l => { nameToNode[l.name] = nodeByIndex[l.index]; });
    S.parsedLayers.forEach(layer => {
      const node  = nodeByIndex[layer.index];
      const parts = layer.name.split('::');
      if (parts.length > 1) {
        const parentName = parts.slice(0, -1).join('::');
        const parentNode = nameToNode[parentName];
        if (parentNode && parentNode !== node) { parentNode.children.push(node); return; }
      }
      roots.push(node);
    });
  }

  S.layerNodeByIndex = nodeByIndex;

  // Assign depth (BFS)
  const queue = roots.map(n => ({ node: n, depth: 0 }));
  while (queue.length) {
    const { node, depth } = queue.shift();
    node.depth = depth;
    node.children.forEach(c => queue.push({ node: c, depth: depth + 1 }));
  }

  function renderNode(node) {
    const { layer, label, depth, children } = node;
    const hexColor = getLayerHex(layer);
    const visColor = layer.visible ? 'var(--primary)' : 'var(--text-3)';
    const indentPx = 6 + depth * 14;
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedLayers.has(layer.index);

    const div = document.createElement('div');
    div.className  = 'layer-item';
    // Only the dynamic indent is inline; the rest of the row styling lives in
    // the #layer-list-panel .layer-item CSS rule (compact, Rhino-like list).
    div.style.paddingLeft = indentPx + 'px';
    if (depth > 0) div.style.position = 'relative';

    // Collapse/expand control — a chevron for parents, an equal-width spacer for
    // leaves so the swatches line up vertically across siblings.
    const collapseControl = hasChildren
      ? `<button class="layer-collapse-btn" data-index="${layer.index}" title="${isCollapsed ? 'Expand' : 'Collapse'}"
           style="background:transparent;border:none;cursor:pointer;color:var(--text-2);flex-shrink:0;
                  width:14px;height:14px;padding:0;display:inline-flex;align-items:center;justify-content:center;
                  transition:transform 0.12s; transform:rotate(${isCollapsed ? 0 : 90}deg);">
           <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor"
                stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
         </button>`
      : `<span class="layer-collapse-spacer" style="display:inline-block;width:14px;flex-shrink:0;"></span>`;

    div.innerHTML += `
      ${collapseControl}
      <div class="layer-swatches">
        <input type="text" class="layer-color-picker-input" data-coloris data-index="${layer.index}" value="${hexColor}" inputmode="none"
               style="background:${hexColor}; color:transparent; outline:none; font-size:0; caret-color:transparent; cursor:pointer;">
        <button class="layer-material-swatch" data-index="${layer.index}" title="Edit Layer Material"
                style="${getMaterialSwatchStyle(layer)}; border:${getSwatchBorder(layer)}; cursor:pointer; transition:transform 0.15s, box-shadow 0.15s;"></button>
      </div>
      <input type="text" class="layer-rename-input" data-index="${layer.index}" value="${label}"
        style="background:transparent;border:none;border-bottom:1px solid transparent;
               color:var(--text);font-family:inherit;font-size:${depth > 0 ? '0.72' : '0.76'}rem;
               width:100%;padding:0 2px;outline:none;transition:border-bottom 0.2s;"
        onfocus="this.style.borderBottom='1px solid var(--primary)'"
        onblur="this.style.borderBottom='1px solid transparent'">
      <button class="layer-toggle-btn icon-btn sm ${layer.visible ? 'active' : ''}"
        data-index="${layer.index}"
        style="color:${visColor};background:transparent;border:none;cursor:pointer;
               flex-shrink:0;width:18px;height:18px;" title="Toggle Visibility">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${layer.visible
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}
        </svg>
      </button>
    `;
    list.appendChild(div);
    // Skip descendants entirely when this node is collapsed.
    if (!isCollapsed) children.forEach(child => renderNode(child));
  }

  roots.forEach(node => renderNode(node));

  // Connect Coloris inputs to real-time 3D model updating
  list.querySelectorAll('.layer-color-picker-input').forEach(input => {
    input.addEventListener('input', e => {
      const hex = e.target.value;
      const idx = parseInt(e.target.dataset.index);
      
      // Update background color of parent .clr-field wrapper (which styles Coloris' button swatch)
      const wrapper = e.target.parentNode;
      if (wrapper && wrapper.classList.contains('clr-field')) {
        wrapper.style.color = hex;
      }
      
      applyNewLayerColor(idx, hex);
    });
  });

  // Call Coloris wrapping handler to bind touch-reliable buttons dynamically
  if (window.Coloris) {
    Coloris.wrap('.layer-color-picker-input');
  }

  list.querySelectorAll('.layer-rename-input').forEach(input => {
    input.addEventListener('change', e => {
      const idx   = parseInt(e.target.dataset.index);
      const name  = e.target.value.trim();
      const layer = S.parsedLayers.find(l => l.index === idx);
      if (layer && name) layer.name = name;
    });
  });

  list.querySelectorAll('.layer-toggle-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx   = parseInt(e.currentTarget.dataset.index);
      const layer = S.parsedLayers.find(l => l.index === idx);
      if (layer) {
        layer.visible = !layer.visible;
        const setDescendants = (parentIdx, vis) => {
          const node = S.layerNodeByIndex[parentIdx];
          if (!node) return;
          node.children.forEach(childNode => {
            childNode.layer.visible = vis;
            setDescendants(childNode.layer.index, vis);
          });
        };
        setDescendants(layer.index, layer.visible);
        renderLayerUI();
        updateLayerVisibility();
      }
    });
  });

  // Bind collapse/expand chevrons
  list.querySelectorAll('.layer-collapse-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.index);
      if (collapsedLayers.has(idx)) collapsedLayers.delete(idx);
      else collapsedLayers.add(idx);
      renderLayerUI();
    });
  });

  // Bind material swatch buttons to open the layer material dialog
  list.querySelectorAll('.layer-material-swatch').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.currentTarget.dataset.index);
      openLayerMaterialDialog(idx);
    });
  });
}

function applyNewLayerColor(idx, hex) {
  const layer = S.parsedLayers.find(l => l.index === idx);
  if (layer) {
    layer.color = {
      r: parseInt(hex.slice(1,3), 16),
      g: parseInt(hex.slice(3,5), 16),
      b: parseInt(hex.slice(5,7), 16),
      a: 255
    };
    if (S.currentModel) { applyLayerColorsToModel(S.currentModel); applyDisplayMode(); }
    createAnnotationSprites();
  }
}

// ── Material sphere swatch CSS style ─────────────────────────────────────────
function getMaterialSwatchStyle(layer) {
  const cm = layer.customMaterial;

  // No material assigned: show a white matte sphere — matches Rhino's "default
  // material" appearance in the Layers panel. The subtle shading reads as a
  // sphere on both light and dark themes.
  if (!cm) {
    return `background: radial-gradient(circle at 35% 30%, #ffffff 0%, #f3f3f3 35%, #c8c8c8 75%, #8a8a8a 100%)`;
  }

  // Material assigned: use the material's color, fall back to layer color!
  const layerHex = getLayerHex(layer);
  const baseHex = cm.color || layerHex || '#ffffff';
  const roughness = cm.roughness ?? 0.5;
  const metalness = cm.metalness ?? 0.0;

  // Glossiness for highlight (roughness 0→sharp highlight, 1→diffuse)
  const highlightAlpha = Math.max(0.05, 1.0 - roughness * 0.95);
  const highlightSize  = 20 + (1.0 - roughness) * 30;  // 20%–50%
  // Metalness: shift base toward specular
  const specularBright = metalness > 0.5 ? 'rgba(255,255,255,0.85)' : `rgba(255,255,255,${highlightAlpha.toFixed(2)})`;
  const bg = `radial-gradient(circle at 35% 30%, ${specularBright} 0%, ${specularBright} ${highlightSize}%, ${baseHex} ${highlightSize + 10}%, ${metalness > 0.3 ? baseHex : '#222'} 100%)`;
  return `background:${bg}`;
}

// ── Update sphere swatch button border to reflect material state ──────────────
function getSwatchBorder(layer) {
  return layer.customMaterial
    ? '1px solid rgba(255,255,255,0.30)'   // has material: solid border
    : '1px dashed rgba(255,255,255,0.25)'; // no material: dashed = "empty slot"
}


// ── Update sphere swatch button appearance ────────────────────────────────────
function updateSwatchButton(layer) {
  const btn = document.querySelector(`.layer-material-swatch[data-index="${layer.index}"]`);
  // Sizing / positioning come from CSS (#layer-list-panel .layer-swatches > ...).
  // We only refresh the visual fill (background gradient) and border style here.
  if (btn) btn.style.cssText = `${getMaterialSwatchStyle(layer)}; border:${getSwatchBorder(layer)}; cursor:pointer; transition:transform 0.15s, box-shadow 0.15s;`;
}

// ── Layer Material Dialog controller ─────────────────────────────────────────
let _lmdLayerIdx = null;  // which layer is currently being edited

// Module-level AbortController to cleanly remove previous dialog listeners on each open
let _lmdAbortController = null;

function openLayerMaterialDialog(layerIdx) {
  const layer = S.parsedLayers.find(l => l.index === layerIdx);
  if (!layer) return;
  _lmdLayerIdx = layerIdx;

  // Cancel previous listeners
  if (_lmdAbortController) { _lmdAbortController.abort(); }
  _lmdAbortController = new AbortController();
  const { signal } = _lmdAbortController;

  const dialog     = document.getElementById('layer-material-dialog');
  const nameEl     = document.getElementById('lmd-layer-name');
  const roughSlider= document.getElementById('lmd-roughness');
  const roughVal   = document.getElementById('lmd-roughness-val');
  const metalSlider= document.getElementById('lmd-metalness');
  const metalVal   = document.getElementById('lmd-metalness-val');
  const opacSlider = document.getElementById('lmd-opacity');
  const opacVal    = document.getElementById('lmd-opacity-val');
  const resetBtn   = document.getElementById('lmd-reset-btn');
  const okBtn      = document.getElementById('lmd-ok-btn');
  const closeBtn   = document.getElementById('lmd-close-btn');
  if (!dialog) return;

  // Show dialog and wrap input immediately to ensure Coloris initializes on a visible element
  dialog.style.display = 'flex';
  if (window.Coloris) {
    Coloris.wrap('#lmd-color-input');
  }

  // ── Drag-to-move (header is the drag handle) ──────────────────────────
  // Reset position to CSS-centered default on each open. After the user
  // starts dragging, switch to explicit pixel coordinates.
  const card = dialog.querySelector('.lmd-card');
  const header = dialog.querySelector('.lmd-header');
  if (card && header) {
    card.style.left = '';
    card.style.top = '';
    card.style.transform = '';
    let dragOffsetX = 0, dragOffsetY = 0;
    const onPointerDown = (e) => {
      // Don't start drag when clicking interactive elements inside header
      if (e.target.closest('button, input, .clr-field, .lmd-sphere')) return;
      const rect = card.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      // Pin to explicit pixel coords (drops CSS transform centering)
      card.style.left = rect.left + 'px';
      card.style.top = rect.top + 'px';
      card.style.transform = 'none';
      try { header.setPointerCapture(e.pointerId); } catch (_) {}
      header.addEventListener('pointermove', onPointerMove, { signal });
      header.addEventListener('pointerup', onPointerUp, { signal, once: true });
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      // Keep the dialog roughly on-screen (allow a 60px margin so the user
      // can always grab the header back even if dragged near a viewport edge)
      const maxLeft = window.innerWidth  - 60;
      const maxTop  = window.innerHeight - 60;
      const nextLeft = Math.min(Math.max(e.clientX - dragOffsetX, -card.offsetWidth + 60), maxLeft);
      const nextTop  = Math.min(Math.max(e.clientY - dragOffsetY, 0), maxTop);
      card.style.left = nextLeft + 'px';
      card.style.top  = nextTop  + 'px';
    };
    const onPointerUp = (e) => {
      try { header.releasePointerCapture(e.pointerId); } catch (_) {}
      header.removeEventListener('pointermove', onPointerMove);
    };
    header.addEventListener('pointerdown', onPointerDown, { signal });
  }

  // ── Populate fields ────────────────────────────────────────────────────
  const cm = layer.customMaterial || {};
  const shortLabel = layer.name.includes('::') ? layer.name.split('::').pop() : layer.name;
  if (nameEl) nameEl.textContent = shortLabel;

  // initColor: use cm.color if set. Fall back to layer display color, then white.
  const layerHex = getLayerHex(layer);
  const initColor = cm.color || layerHex || '#ffffff';

  // Update color input without cloneNode (preserves Coloris binding)
  const colorInput = document.getElementById('lmd-color-input');
  if (colorInput) {
    colorInput.value = initColor;
    colorInput.style.background = initColor;
    // Also update the Coloris wrapper element & inner button so the swatch reflects initColor
    const clrField = colorInput.closest('.clr-field');
    if (clrField) {
      clrField.style.color = initColor;                                       // drives Coloris currentColor
      const clrBtn = clrField.querySelector('button');
      if (clrBtn) clrBtn.style.backgroundColor = initColor;
    }
    const colorValue = document.getElementById('lmd-color-value');
    if (colorValue) colorValue.textContent = initColor;
  }

  const roughInit = cm.roughness ?? 0.5;
  const metalInit = cm.metalness ?? 0.0;
  const opacInit  = cm.opacity   ?? 1.0;

  if (roughSlider) roughSlider.value = roughInit;
  if (roughVal)    roughVal.textContent = roughInit.toFixed(2);
  if (metalSlider) metalSlider.value = metalInit;
  if (metalVal)    metalVal.textContent = metalInit.toFixed(2);
  if (opacSlider)  opacSlider.value = opacInit;
  if (opacVal)     opacVal.textContent = opacInit.toFixed(2);

  updateDialogSphere(initColor, roughInit, metalInit);

  // ── Helper: read all dialog fields and write to layer ─────────────────
  function applyDialogToLayer() {
    const lay = S.parsedLayers.find(l => l.index === _lmdLayerIdx);
    if (!lay) return;
    const cEl = document.getElementById('lmd-color-input');
    const rEl = document.getElementById('lmd-roughness');
    const mEl = document.getElementById('lmd-metalness');
    const oEl = document.getElementById('lmd-opacity');
    const c = cEl?.value || initColor;
    const r = parseFloat(rEl?.value ?? 0.5);
    const m = parseFloat(mEl?.value ?? 0.0);
    const o = parseFloat(oEl?.value ?? 1.0);
    if (!lay.customMaterial) lay.customMaterial = {};
    lay.customMaterial.color     = c;
    lay.customMaterial.roughness = r;
    lay.customMaterial.metalness = m;
    lay.customMaterial.opacity   = o;
    updateSwatchButton(lay);
    updateDialogSphere(c, r, m);
    if (S.currentModel) applyDisplayMode();
  }

  // ── Sliders ───────────────────────────────────────────────────────────
  roughSlider?.addEventListener('input', () => {
    if (roughVal) roughVal.textContent = parseFloat(roughSlider.value).toFixed(2);
    applyDialogToLayer();
  }, { signal });
  metalSlider?.addEventListener('input', () => {
    if (metalVal) metalVal.textContent = parseFloat(metalSlider.value).toFixed(2);
    applyDialogToLayer();
  }, { signal });
  opacSlider?.addEventListener('input', () => {
    if (opacVal) opacVal.textContent = parseFloat(opacSlider.value).toFixed(2);
    applyDialogToLayer();
  }, { signal });

  // ── Color input (Coloris fires 'input' on the text element) ──────────
  colorInput?.addEventListener('input', e => {
    const hex = e.target.value;
    colorInput.style.background = hex;
    // Keep the wrapper swatch in sync (Coloris reads its visible color from `color`)
    const clrField = colorInput.closest('.clr-field');
    if (clrField) clrField.style.color = hex;
    const cv = document.getElementById('lmd-color-value');
    if (cv) cv.textContent = hex;
    applyDialogToLayer();
  }, { signal });

  // ── Reset ─────────────────────────────────────────────────────────────
  // Restore the layer material exactly as it was loaded from the 3DM file.
  // If the file had no layer material assigned, drop back to "no material" (null).
  resetBtn?.addEventListener('click', () => {
    const lay = S.parsedLayers.find(l => l.index === _lmdLayerIdx);
    if (!lay) return;
    lay.customMaterial = lay.originalCustomMaterial
      ? { ...lay.originalCustomMaterial }
      : null;
    updateSwatchButton(lay);
    if (S.currentModel) applyDisplayMode();
    openLayerMaterialDialog(_lmdLayerIdx); // re-open refreshes fields
  }, { signal });

  // ── OK ────────────────────────────────────────────────────────────────
  okBtn?.addEventListener('click', () => {
    closeLayerMaterialDialog();
  }, { signal });

  // ── Close ─────────────────────────────────────────────────────────────
  closeBtn?.addEventListener('click', closeLayerMaterialDialog, { signal });
  dialog.onclick = (e) => { if (e.target === dialog) closeLayerMaterialDialog(); };
}

function updateDialogSphere(color, roughness, metalness) {
  const sphere = document.getElementById('lmd-preview-sphere');
  if (!sphere) return;
  const safeColor = color || '#ffffff';
  const highlightAlpha = Math.max(0.05, 1.0 - roughness * 0.95);
  const highlightSize  = 20 + (1.0 - roughness) * 30;
  const specularBright = metalness > 0.5 ? 'rgba(255,255,255,0.85)' : `rgba(255,255,255,${highlightAlpha.toFixed(2)})`;
  sphere.style.background = `radial-gradient(circle at 35% 30%, ${specularBright} 0%, ${specularBright} ${highlightSize}%, ${safeColor} ${highlightSize + 10}%, ${metalness > 0.3 ? safeColor : '#222'} 100%)`;
}

function closeLayerMaterialDialog() {
  if (_lmdAbortController) { _lmdAbortController.abort(); _lmdAbortController = null; }
  const dialog = document.getElementById('layer-material-dialog');
  if (dialog) { dialog.style.display = 'none'; dialog.onclick = null; }
  _lmdLayerIdx = null;
}


// Load custom swatches from localStorage or fall back to default
const defaultSwatches = [
  'DarkSlateGray',
  '#2a9d8f',
  '#e9c46a',
  'coral',
  'rgb(231, 111, 81)',
  'Crimson',
  '#023e8a',
  '#0077b6',
  'hsl(194, 100%, 39%)',
  '#00b4d8',
  '#48cae4',
  '#7209b7' // Premium violet purple (12th swatch to complete the beautiful even centered layout)
];

let customSwatches = [];
try {
  const saved = localStorage.getItem('byrhinoview_custom_swatches');
  if (saved) {
    customSwatches = JSON.parse(saved);
    // If user has old swatches count (< 12), auto-upgrade so they get the even layout instantly
    if (customSwatches.length < 12 && !customSwatches.some(c => c.toLowerCase() === '#7209b7')) {
      customSwatches.push('#7209b7');
      try {
        localStorage.setItem('byrhinoview_custom_swatches', JSON.stringify(customSwatches));
      } catch (err) {}
    }
  } else {
    customSwatches = [...defaultSwatches];
  }
} catch (e) {
  customSwatches = [...defaultSwatches];
}

// Configure Coloris globally for layer color picking (deferred slightly to ensure Coloris has completed its internal DOM setup)
if (window.Coloris) {
  setTimeout(() => {
    // Inject CSS styles dynamically to bypass browser file caches completely
    injectColorisStyles();


    Coloris({
      el: '.layer-color-picker-input',
      theme: 'default',
      themeMode: 'auto',
      alpha: false,
      format: 'hex',
      wrap: true,
      focusInput: false, // Prevent virtual mobile keyboard from automatically popping up on picker open
      swatches: customSwatches,
      onChange: (color, inputEl) => {
        console.log(`The new color is ${color}`);
      }
    });

    // Poll every 30ms to wait until Coloris has appended the clr-swatches element on DomContentLoaded
    const initInterval = setInterval(() => {
      const swatchesContainer = document.getElementById('clr-swatches');
      if (swatchesContainer) {
        clearInterval(initInterval);
        setupSwatchesBuilder();
      }
    }, 30);
  }, 0);
}

function injectColorisStyles() {
  let style = document.getElementById('clr-custom-styles-injector');
  if (!style) {
    style = document.createElement('style');
    style.id = 'clr-custom-styles-injector';
    document.head.appendChild(style);
  }
  style.textContent = `
    /* Force Coloris picker width so 6 swatches (20px each + 6px gap) fit perfectly in one row! */
    .clr-picker {
      width: 212px !important;
      /* layer-material-dialog uses z-index 9999, so picker must sit above it */
      z-index: 10001 !important;
    }

    /* Coloris Swatches: center-aligned grid with uniform gap */
    .clr-picker .clr-swatches div {
      justify-content: center !important;
      align-items: center !important;
      padding-left: 10px !important;
      padding-right: 10px !important;
      gap: 6px !important;
    }

    /* Custom Swatch Add Button: override ALL Coloris button defaults (Default Light Mode style) */
    #clr-custom-add-btn {
      position: relative !important;
      width: 20px !important;
      height: 20px !important;
      margin: 0 !important; /* Rely on container gap */
      padding: 0 !important;
      border-radius: 50% !important;
      border: 1.5px dashed #4b5563 !important; /* Visible dark grey border in Light Mode */
      background: #f3f4f6 !important; /* Light grey background */
      text-indent: 0 !important;
      overflow: visible !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      box-shadow: none !important;
      flex-shrink: 0 !important;
      transition: background 0.15s, border-color 0.15s, transform 0.15s !important;
      box-sizing: border-box !important;
    }

    /* CRITICAL: Hide the ::after overlay that Coloris paints currentColor over the button */
    #clr-custom-add-btn::after {
      display: none !important;
    }

    /* The span inside carries the + text, visible above any overlay (Default Light Mode style) */
    #clr-custom-add-btn > span {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: 100% !important;
      color: #1f2937 !important; /* Very dark grey plus sign */
      font-size: 15px !important;
      font-weight: bold !important;
      line-height: 1 !important;
      pointer-events: none !important;
      text-indent: 0 !important;
    }

    #clr-custom-add-btn:hover {
      background: #e5e7eb !important;
      border-color: #111827 !important;
      transform: scale(1.08) !important;
    }

    /* Custom Swatch Add Button: Premium Dark Mode styling (inside .clr-dark) */
    .clr-dark #clr-custom-add-btn {
      border: 1.5px dashed rgba(255, 255, 255, 0.45) !important;
      background: rgba(255, 255, 255, 0.08) !important;
    }

    .clr-dark #clr-custom-add-btn > span {
      color: rgba(255, 255, 255, 0.85) !important;
    }

    .clr-dark #clr-custom-add-btn:hover {
      background: rgba(255, 255, 255, 0.2) !important;
      border-color: rgba(255, 255, 255, 0.9) !important;
    }

    /* Keep normal swatches aligned with a consistent margin/gap */
    .clr-picker .clr-swatches button {
      margin: 0 !important; /* Let the container gap handle it! */
    }
  `;
}

function setupSwatchesBuilder() {
  const swatchesContainer = document.getElementById('clr-swatches');
  if (!swatchesContainer) return;

  // Build once immediately since initial swatches are already rendered
  buildSwatchesUI(swatchesContainer);

  const observer = new MutationObserver(() => {
    observer.disconnect();
    buildSwatchesUI(swatchesContainer);
    observer.observe(swatchesContainer, { childList: true, subtree: true });
  });

  observer.observe(swatchesContainer, { childList: true, subtree: true });

  // BULLETPROOF FALLBACK: Also bind to document touch/click events to rebuild swatches instantly when opened
  document.addEventListener('click', e => {
    if (e.target.closest('.clr-field') || e.target.closest('.layer-color-picker-input') || e.target.closest('#clr-picker')) {
      setTimeout(() => {
        buildSwatchesUI(document.getElementById('clr-swatches'));
      }, 50);
    }
  }, { passive: true });
}

function buildSwatchesUI(swatchesContainer) {
  try {
    const innerDiv = swatchesContainer.querySelector('div');
    if (innerDiv) {
      // 1. Add custom "+" button if not present
      if (!innerDiv.querySelector('#clr-custom-add-btn')) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.id = 'clr-custom-add-btn';
        addBtn.title = 'Add active color to palette';
        // Use a <span> child so the text is NOT hidden by Coloris's text-indent:-1000px rule
        // and is NOT covered by the ::after pseudo-element (which we hide in CSS).
        const plusSpan = document.createElement('span');
        plusSpan.textContent = '+';
        addBtn.appendChild(plusSpan);

        addBtn.addEventListener('click', e => {
          e.stopPropagation();
          const activeColor = document.getElementById('clr-color-value')?.value;
          if (activeColor && !customSwatches.some(c => c.toLowerCase() === activeColor.toLowerCase())) {
            customSwatches.push(activeColor);
            try {
              localStorage.setItem('byrhinoview_custom_swatches', JSON.stringify(customSwatches));
            } catch (err) {}
            
            Coloris({ swatches: customSwatches });
            
            // Re-run builder immediately to append button to new container
            setTimeout(() => {
              buildSwatchesUI(document.getElementById('clr-swatches'));
            }, 30);
          }
        });

        innerDiv.appendChild(addBtn);
      }

      // 2. Bind delete events (dblclick and long-press) to swatches
      innerDiv.querySelectorAll('button:not(#clr-custom-add-btn)').forEach(btn => {
        // Prevent multiple bindings
        if (!btn.dataset.hasDeleteListeners) {
          btn.dataset.hasDeleteListeners = 'true';

          // Double click to delete (PC)
          btn.addEventListener('dblclick', e => {
            e.stopPropagation();
            const color = btn.textContent || btn.style.color;
            removeSwatch(color);
          });

          // Long press / right-click to delete (Mobile / tablet)
          btn.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            const color = btn.textContent || btn.style.color;
            removeSwatch(color);
          });
        }
      });
    }
  } catch (err) {
    console.error('Error in buildSwatchesUI:', err);
  }
}

function removeSwatch(color) {
  const normalized = color.trim();
  const index = customSwatches.findIndex(c => c.toLowerCase() === normalized.toLowerCase());
  if (index > -1) {
    customSwatches.splice(index, 1);
    try {
      localStorage.setItem('byrhinoview_custom_swatches', JSON.stringify(customSwatches));
    } catch (err) {}
    
    Coloris({ swatches: customSwatches });

    // Re-run builder immediately to append button to new container
    setTimeout(() => {
      buildSwatchesUI(document.getElementById('clr-swatches'));
    }, 30);
  }
}


export function updateLayerVisibility() {
  const annVisible = document.getElementById('chk-annotations-panel')?.checked ?? true;

  const updateChild = (child) => {
    // iRefObject groups: gate the whole instance on the InstanceReference's
    // own layer. Block-content children below still get their own layerIndex
    // visibility — Three.js will hide an object when either it or any
    // ancestor is invisible, so both layers work as gates simultaneously.
    if (typeof child.userData?.instanceLayerIndex === 'number') {
      const instLayer = S.parsedLayers.find(l => l.index === child.userData.instanceLayerIndex);
      child.visible = instLayer ? instLayer.visible : true;
      return;
    }

    let layerIdx = null;
    let isAnnotation = false;

    if (child.userData && typeof child.userData.layerIndex === 'number') {
      layerIdx = child.userData.layerIndex;
      isAnnotation = true;
    } else if (child.userData && child.userData.attributes) {
      layerIdx = child.userData.attributes.layerIndex ?? 0;
    }

    if (layerIdx === null) return;

    const layer     = S.parsedLayers.find(l => l.index === layerIdx);
    const layerVis  = layer ? layer.visible : true;
    const objectVis = !S.hiddenObjects.has(child);

    // Rhino per-object hidden state. THREE's Rhino3dmLoader applies only LAYER
    // visibility (3DMLoader.js:539), so individually-hidden objects must be
    // gated here too. Source of truth: userData.attributes.visible for geometry,
    // parsedAnnotations[].visible for annotation children (which carry annIndex
    // instead of attributes). S.revealHidden ("Show All") overrides it to reveal
    // file-author-hidden objects, matching Rhino's Show command.
    const rhinoVis = S.revealHidden || (isAnnotation
      ? (S.parsedAnnotations?.[child.userData.annIndex]?.visible !== false)
      : (child.userData?.attributes?.visible !== false));

    if (isAnnotation) {
      child.visible = layerVis && objectVis && annVisible && rhinoVis;
    } else {
      child.visible = layerVis && objectVis && rhinoVis;
    }
  };

  if (S.currentModel) {
    S.currentModel.traverse(updateChild);
  }
  if (S.annotationGroup && S.annotationGroup.parent !== S.currentModel) {
    S.annotationGroup.traverse(updateChild);
  }
}
