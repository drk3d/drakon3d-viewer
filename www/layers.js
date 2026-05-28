import { S } from './state.js';
import { applyLayerColorsToModel, applyDisplayMode } from './display.js';
import { createAnnotationSprites } from './annotations.js';

export function renderLayerUI() {
  const list = document.getElementById('layer-list-panel') || document.getElementById('layer-list');
  if (!list) return;
  list.innerHTML = '';

  if (S.parsedLayers.length === 0) {
    list.innerHTML = '<span class="dropdown-empty-msg">No layers parsed</span>';
    return;
  }

  const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => {
    const hex = Math.min(255, Math.max(0, x)).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');

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
    const hexColor = rgbToHex(layer.color.r, layer.color.g, layer.color.b);
    const visColor = layer.visible ? 'var(--primary)' : 'var(--text-3)';
    const indentPx = 8 + depth * 16;

    const div = document.createElement('div');
    div.className  = 'layer-item';
    div.style.cssText = `
      display:flex; align-items:center; gap:6px;
      padding:4px 8px 4px ${indentPx}px;
      margin-bottom:2px;
      background:var(--surface-hi); border-radius:5px;
      border:1px solid var(--border);
    `;

    if (depth > 0) {
      div.style.position = 'relative';
      const line = document.createElement('div');
      line.style.cssText = `
        position:absolute; left:${indentPx - 10}px; top:0; bottom:0;
        width:1px; background:rgba(255,255,255,0.1); pointer-events:none;
      `;
      div.appendChild(line);
    }

    div.innerHTML += `
      <input type="text" class="layer-color-picker-input" data-coloris data-index="${layer.index}" value="${hexColor}" inputmode="none"
             style="width:14px; height:14px; border-radius:3px; border:1px solid rgba(255,255,255,0.18); cursor:pointer;
                    background:${hexColor}; color:transparent; outline:none; flex-shrink:0; box-sizing:border-box; font-size:0; caret-color:transparent;">
      <input type="text" class="layer-rename-input" data-index="${layer.index}" value="${label}"
        style="background:transparent;border:none;border-bottom:1px solid transparent;
               color:var(--text);font-family:inherit;font-size:${depth > 0 ? '0.72' : '0.76'}rem;
               width:100%;padding:1px 2px;outline:none;transition:border-bottom 0.2s;"
        onfocus="this.style.borderBottom='1px solid var(--primary)'"
        onblur="this.style.borderBottom='1px solid transparent'">
      <button class="layer-toggle-btn icon-btn sm ${layer.visible ? 'active' : ''}"
        data-index="${layer.index}"
        style="color:${visColor};background:transparent;border:none;cursor:pointer;
               flex-shrink:0;width:22px;height:22px;" title="Toggle Visibility">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${layer.visible
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}
        </svg>
      </button>
    `;
    list.appendChild(div);
    children.forEach(child => renderNode(child));
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

    if (isAnnotation) {
      child.visible = layerVis && objectVis && annVisible;
    } else {
      child.visible = layerVis && objectVis;
    }
  };

  if (S.currentModel) {
    S.currentModel.traverse(updateChild);
  }
  if (S.annotationGroup && S.annotationGroup.parent !== S.currentModel) {
    S.annotationGroup.traverse(updateChild);
  }
}
