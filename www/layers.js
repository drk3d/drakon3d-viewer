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
      <div style="position:relative;width:14px;height:14px;border-radius:3px;
                  border:1px solid rgba(255,255,255,0.18);cursor:pointer;
                  background:${hexColor};flex-shrink:0;">
        <input type="color" class="layer-color-picker" data-index="${layer.index}" value="${hexColor}"
          style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;">
      </div>
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

  // Event bindings
  list.querySelectorAll('.layer-color-picker').forEach(picker => {
    picker.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.index);
      const hex = e.target.value;
      const layer = S.parsedLayers.find(l => l.index === idx);
      if (layer) {
        layer.color = {
          r: parseInt(hex.slice(1,3), 16),
          g: parseInt(hex.slice(3,5), 16),
          b: parseInt(hex.slice(5,7), 16),
          a: 255
        };
        e.target.parentElement.style.background = hex;
        if (S.currentModel) { applyLayerColorsToModel(S.currentModel); applyDisplayMode(); }
        createAnnotationSprites();
      }
    });
  });

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

export function updateLayerVisibility() {
  if (!S.currentModel) return;
  S.currentModel.traverse(child => {
    if (!child.userData.attributes) return;
    const attrs     = child.userData.attributes;
    const layerIdx  = attrs.layerIndex ?? 0;
    const layer     = S.parsedLayers.find(l => l.index === layerIdx);
    const layerVis  = layer ? layer.visible : true;
    const objectVis = !S.hiddenObjects.has(child);
    child.visible   = layerVis && objectVis;
  });
}
