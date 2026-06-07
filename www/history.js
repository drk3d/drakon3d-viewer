import * as THREE from 'three';
import { S } from './state.js';

class HistoryManager {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.maxStates = 50; // Keep up to 50 states
    this.suppress = false;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    console.log('[History] Cleared.');
    this.updateButtons();
  }

  push(action) {
    if (this.suppress) return;
    console.log('[History] Pushing action:', action);
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxStates) {
      this.undoStack.shift();
    }
    this.redoStack = []; // Clear redo stack on new action
    this.updateButtons();
  }

  undo() {
    console.log('[History] Undo requested. Stack size:', this.undoStack.length);
    if (this.undoStack.length === 0) {
      console.log('[History] Undo stack empty.');
      return;
    }
    const action = this.undoStack.pop();
    console.log('[History] Undoing action:', action);
    this.applyState(action, 'before');
    this.redoStack.push(action);
    this.updateButtons();
  }

  redo() {
    console.log('[History] Redo requested. Stack size:', this.redoStack.length);
    if (this.redoStack.length === 0) {
      console.log('[History] Redo stack empty.');
      return;
    }
    const action = this.redoStack.pop();
    console.log('[History] Redoing action:', action);
    this.applyState(action, 'after');
    this.undoStack.push(action);
    this.updateButtons();
  }

  applyState(action, key) {
    const oldSuppress = this.suppress;
    this.suppress = true;
    try {
      if (action.type === 'setting') {
        const val = (key === 'before') ? action.before : action.after;
        const element = document.getElementById(action.elementId);
        if (element) {
          if (element.type === 'checkbox') {
            element.checked = val;
          } else {
            element.value = val;
          }
          element.dispatchEvent(new Event('input'));
          element.dispatchEvent(new Event('change'));
          if (window.updateSliderFill) {
            window.updateSliderFill(element);
          }
        }
      } else if (action.type === 'clipping') {
        const state = (key === 'before') ? action.before : action.after;
        S.clippingPosition = state.position ? state.position.clone() : null;
        S.clippingQuaternion = state.quaternion ? state.quaternion.clone() : null;
        S.clipAxis = state.clipAxis;
        S.clipFlipped = state.clipFlipped;

        // Sync buttons active state
        document.querySelectorAll('.clip-axis-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.axis === S.clipAxis);
        });
        const toggleBtn = document.getElementById('btn-clip-toggle');
        if (toggleBtn) {
          import('./i18n.js').then(m => {
            toggleBtn.classList.toggle('active', S.clippingToggleOn);
            toggleBtn.textContent = S.clippingToggleOn ? m.t('clip.on') : m.t('clip.off');
          });
        }

        import('./tools.js').then(tools => {
          tools.updateClippingPlane();
          if (S.clippingEnabled) {
            tools.setupClippingHelper();
          } else {
            if (window.deactivateClippingHelper) window.deactivateClippingHelper();
          }
        });
      } else if (action.type === 'displayMode') {
        const mode = (key === 'before') ? action.before : action.after;
        import('./app.js').then(app => {
          app.changeDisplayMode(mode);
        });
      } else if (action.type === 'measurements') {
        const state = (key === 'before') ? action.before : action.after;
        import('./tools.js').then(tools => {
          tools.reconstructMeasurements(state);
        });
      } else if (action.targets) {
        const states = action[key];
        action.targets.forEach((obj, idx) => {
          const state = states[idx];
          if (action.type === 'transform') {
            obj.position.copy(state.position);
            obj.quaternion.copy(state.quaternion);
            obj.scale.copy(state.scale);
            obj.updateMatrixWorld(true);
            
            // Sync Gumball helper if it's attached
            if (S.gumballActive && S.gumballHelper && S.selectedObjects.includes(obj)) {
              import('./selection.js').then(sel => sel.setupGumballHelper());
            }
          } else if (action.type === 'color') {
            obj.userData.objectColorCustom = state.objectColorCustom;
            obj.userData.isColorByLayer = state.isColorByLayer;
            
            if (obj.userData.annIndex !== undefined) {
              const ann = S.parsedAnnotations[obj.userData.annIndex];
              ann.objectColorCustom = state.objectColorCustom;
              ann.isColorByLayer = state.isColorByLayer;
            } else {
              obj.traverse(child => {
                if (child.userData.selectionBackup) {
                  child.userData.selectionBackup.color.set(state.objectColorCustom || '#ffffff');
                  if (child.userData.selectionBackup.material && child.userData.selectionBackup.material.color) {
                    child.userData.selectionBackup.material.color.set(state.objectColorCustom || '#ffffff');
                  }
                }
              });
              if (obj.userData.shadedMaterial) obj.userData.shadedMaterial.color.set(state.objectColorCustom || '#ffffff');
              if (obj.material && !obj.userData.selectionBackup) obj.material.color.set(state.objectColorCustom || '#ffffff');
            }
          } else if (action.type === 'material') {
            if (state.customMaterial) {
              obj.userData.customMaterial = { ...state.customMaterial };
            } else {
              obj.userData.customMaterial = null;
            }
            if (state.isMaterialByLayer !== undefined) {
              obj.userData.isMaterialByLayer = !!state.isMaterialByLayer;
            }
          }
        });

        // Rebuild annotations if any changed
        if (action.type === 'color' && action.targets.some(o => o.userData.annIndex !== undefined)) {
          import('./annotations.js').then(a => a.createAnnotationSprites());
        } else {
          import('./display.js').then(d => d.applyDisplayMode());
        }

        // Refresh Selection Outline and Properties Panel
        if (S.selectionOutlinePass) {
          S.selectionOutlinePass.selectedObjects = [...S.selectedObjects];
        }
        
        // Update panel
        import('./selection.js').then(sel => sel.updatePropertiesPanel());
      }
    } finally {
      this.suppress = oldSuppress;
    }
  }

  updateButtons() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    console.log('[History] updateButtons called. Undo stack:', this.undoStack.length, 'Redo stack:', this.redoStack.length, 'btnUndo exists:', !!btnUndo, 'btnRedo exists:', !!btnRedo);
    if (btnUndo) {
      btnUndo.disabled = this.undoStack.length === 0;
      btnUndo.style.opacity = this.undoStack.length === 0 ? '0.35' : '1';
    }
    if (btnRedo) {
      btnRedo.disabled = this.redoStack.length === 0;
      btnRedo.style.opacity = this.redoStack.length === 0 ? '0.35' : '1';
    }
  }
}

export const History = new HistoryManager();
