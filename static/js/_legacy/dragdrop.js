/* ================================================================
   DragDropManager – REWRITTEN for smooth movement & drag threshold
   ================================================================ */

class DragDropManager {
  constructor(app) {
    this.app = app;

    // Drag state
    this.isDragging = false;
    this._pendingDrag = false;   // mousedown happened, waiting for threshold
    this._startClientX = 0;
    this._startClientY = 0;
    this.dragTargets = [];
    this.dragOffsets = [];
    this.DRAG_THRESHOLD = 4;     // pixels before drag really starts

    // Resize state
    this.isResizing = false;
    this.resizeHandle = null;
    this.resizeTarget = null;
    this.resizeStart = {};

    // Rotate state
    this.isRotating = false;
    this.rotateTarget = null;
    this.rotateCenter = {};

    // Snapping
    this.snapThreshold = 6;
    this.gridSize = 24;

    // rAF bookkeeping
    this._rafId = null;

    this._bindFileDrop();
  }

  /* ============================================================
     MASTER EVENT HANDLERS (called from app.js)
     ============================================================ */

  onMouseDown(e) {
    if (this.app.state.activeTool !== 'select') return false;

    // Ignore clicks on buttons, editable text, ports
    if (e.target.tagName === 'BUTTON' || e.target.contentEditable === 'true') return false;
    if (e.target.classList.contains('fc-port')) return false;
    if (e.target.classList.contains('mm-add-btn') || e.target.classList.contains('mm-collapse-btn')) return false;
    if (e.target.classList.contains('algo-edit-btn') || e.target.classList.contains('graph-edit-btn')) return false;

    const target = e.target.closest('.board-element');
    if (!target) return false;

    const id = target.dataset.elementId;
    const el = this.app.state.elements.find(x => x.id === id);
    if (!el || el.locked) return false;

    // Check resize / rotate handles first
    const handleEl = e.target.closest('[data-handle]');
    if (handleEl) {
      const handle = handleEl.dataset.handle;
      if (handle === 'rotate') return this._startRotate(e, el);
      return this._startResize(e, el, handle);
    }

    // Store start position — don't actually drag yet (threshold)
    this._pendingDrag = true;
    this._startClientX = e.clientX;
    this._startClientY = e.clientY;

    // Select the element immediately
    const selected = this.app.state.selectedElements;
    if (e.shiftKey) {
      const idx = selected.indexOf(id);
      if (idx >= 0) selected.splice(idx, 1);
      else selected.push(id);
    } else if (!selected.includes(id)) {
      this.app.state.selectedElements = [id];
    }
    this.app.refreshSelection();

    // Prepare drag targets (but don't move yet)
    const sel = this.app.state.selectedElements;
    this.dragTargets = this.app.state.elements.filter(x => sel.includes(x.id) && !x.locked);

    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    this.dragOffsets = this.dragTargets.map(t => ({ dx: bp.x - t.x, dy: bp.y - t.y }));

    return true;
  }

  onMouseMove(e) {
    if (this.isResizing)  return this._moveResize(e);
    if (this.isRotating)  return this._moveRotate(e);

    // Check drag threshold
    if (this._pendingDrag && !this.isDragging) {
      const dx = e.clientX - this._startClientX;
      const dy = e.clientY - this._startClientY;
      if (Math.sqrt(dx * dx + dy * dy) >= this.DRAG_THRESHOLD) {
        this.isDragging = true;
      } else {
        return; // haven't moved far enough
      }
    }

    if (this.isDragging) this._moveDrag(e);
  }

  onMouseUp(e) {
    if (this.isResizing)  return this._endResize();
    if (this.isRotating)  return this._endRotate();

    if (this.isDragging) {
      this._endDrag();
    } else if (this._pendingDrag) {
      // It was a click, not a drag — selection already handled in onMouseDown
    }
    this._pendingDrag = false;
    this.isDragging = false;
  }

  /* ============================================================
     DRAG (smooth, rAF-optimised)
     ============================================================ */

  _moveDrag(e) {
    // Capture coordinates NOW before they go stale
    const cx = e.clientX;
    const cy = e.clientY;
    const altKey = e.altKey;

    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._performDrag(cx, cy, altKey);
    });
  }

  _performDrag(cx, cy, altKey) {
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(cx - rect.left, cy - rect.top);

    board.clearAlignmentGuides();

    for (let i = 0; i < this.dragTargets.length; i++) {
      const el = this.dragTargets[i];
      let newX = bp.x - this.dragOffsets[i].dx;
      let newY = bp.y - this.dragOffsets[i].dy;

      if (!altKey && this.app.state.gridVisible) {
        newX = Math.round(newX / this.gridSize) * this.gridSize;
        newY = Math.round(newY / this.gridSize) * this.gridSize;
      }
      if (this.dragTargets.length === 1 && !altKey) {
        const snap = this._checkAlignment(el, newX, newY);
        newX = snap.x;
        newY = snap.y;
      }

      el.x = newX;
      el.y = newY;

      const dom = document.querySelector(`[data-element-id="${el.id}"]`);
      if (dom) {
        dom.style.left = newX + 'px';
        dom.style.top  = newY + 'px';
      }

      if (this.app.flowchart) this.app.flowchart.updateConnectionsForNode(el.id);
      if (this.app.mindmap)   this.app.mindmap.updateConnectionsForNode(el.id);
    }
  }

  _endDrag() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this.app.board.clearAlignmentGuides();
    this.app.pushHistory('move');
    this.app.board.updateMinimap();
    this.app.updatePropertiesPanel();
    this.isDragging = false;
    this.dragTargets = [];
    this.dragOffsets = [];
  }

  /* ============================================================
     RESIZE
     ============================================================ */

  _startResize(e, el, handle) {
    this.isResizing = true;
    this.resizeHandle = handle;
    this.resizeTarget = el;
    this.resizeStart = {
      x: el.x, y: el.y,
      w: el.width || 200, h: el.height || 200,
      mouseX: e.clientX, mouseY: e.clientY,
    };
    return true;
  }

  _moveResize(e) {
    if (!this.resizeTarget) return;
    const board = this.app.board;
    const s = this.resizeStart;
    const dx = (e.clientX - s.mouseX) / board.transform.scale;
    const dy = (e.clientY - s.mouseY) / board.transform.scale;
    const el = this.resizeTarget;
    const h = this.resizeHandle;
    const minSize = 30;

    let newX = s.x, newY = s.y, newW = s.w, newH = s.h;

    if (h.includes('e')) newW = Math.max(minSize, s.w + dx);
    if (h.includes('w')) { newW = Math.max(minSize, s.w - dx); newX = s.x + s.w - newW; }
    if (h.includes('s')) newH = Math.max(minSize, s.h + dy);
    if (h.includes('n')) { newH = Math.max(minSize, s.h - dy); newY = s.y + s.h - newH; }

    if (e.shiftKey && s.w && s.h) {
      const ratio = s.w / s.h;
      if (['se','nw','ne','sw'].includes(h)) newH = newW / ratio;
    }

    el.x = newX; el.y = newY; el.width = newW; el.height = newH;

    const dom = document.querySelector(`[data-element-id="${el.id}"]`);
    if (dom) {
      dom.style.left = newX + 'px'; dom.style.top = newY + 'px';
      dom.style.width = newW + 'px'; dom.style.height = newH + 'px';
    }

    if (el.type === 'graph') {
      const canvas = dom?.querySelector('canvas');
      if (canvas && this.app.graphMgr) {
        canvas.width = newW - 20; canvas.height = newH - 50;
        this.app.graphMgr.renderChart(el, canvas);
      }
    }

    if (this.app.flowchart) this.app.flowchart.updateConnectionsForNode(el.id);
    if (this.app.mindmap) this.app.mindmap.updateConnectionsForNode(el.id);
    this.app.updatePropertiesPanel();
  }

  _endResize() {
    if (this.isResizing) {
      this.app.pushHistory('resize');
      this.app.board.updateMinimap();
    }
    this.isResizing = false;
    this.resizeHandle = null;
    this.resizeTarget = null;
  }

  /* ============================================================
     ROTATE
     ============================================================ */

  _startRotate(e, el) {
    this.isRotating = true;
    this.rotateTarget = el;
    this.rotateCenter = {
      x: el.x + (el.width || 200) / 2,
      y: el.y + (el.height || 200) / 2,
    };
    return true;
  }

  _moveRotate(e) {
    if (!this.rotateTarget) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    let angle = Math.atan2(bp.y - this.rotateCenter.y, bp.x - this.rotateCenter.x) * (180 / Math.PI) + 90;
    if (e.shiftKey) angle = Math.round(angle / 15) * 15;

    this.rotateTarget.rotation = angle;
    const dom = document.querySelector(`[data-element-id="${this.rotateTarget.id}"]`);
    if (dom) dom.style.transform = `rotate(${angle}deg)`;
  }

  _endRotate() {
    if (this.isRotating) this.app.pushHistory('rotate');
    this.isRotating = false;
    this.rotateTarget = null;
  }

  /* ============================================================
     ALIGNMENT SNAPPING
     ============================================================ */

  _checkAlignment(dragEl, newX, newY) {
    const board = this.app.board;
    const w = dragEl.width || 200;
    const h = dragEl.height || 200;
    const cx = newX + w / 2;
    const cy = newY + h / 2;
    let snappedX = newX, snappedY = newY;

    const els = this.app.state.elements;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.id === dragEl.id) continue;
      const ew = el.width || 200, eh = el.height || 200;
      const ecx = el.x + ew / 2, ecy = el.y + eh / 2;
      const t = this.snapThreshold;

      if (Math.abs(cx - ecx) < t) { snappedX = ecx - w / 2; board.showAlignmentGuide('vertical', ecx); }
      if (Math.abs(cy - ecy) < t) { snappedY = ecy - h / 2; board.showAlignmentGuide('horizontal', ecy); }
      if (Math.abs(newX - el.x) < t) { snappedX = el.x; board.showAlignmentGuide('vertical', el.x); }
      if (Math.abs(newX + w - el.x - ew) < t) { snappedX = el.x + ew - w; board.showAlignmentGuide('vertical', el.x + ew); }
      if (Math.abs(newY - el.y) < t) { snappedY = el.y; board.showAlignmentGuide('horizontal', el.y); }
      if (Math.abs(newY + h - el.y - eh) < t) { snappedY = el.y + eh - h; board.showAlignmentGuide('horizontal', el.y + eh); }
    }
    return { x: snappedX, y: snappedY };
  }

  /* ============================================================
     FILE DROP
     ============================================================ */

  _bindFileDrop() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;

    wrapper.addEventListener('dragover', (e) => {
      e.preventDefault();
      wrapper.style.outline = '3px dashed var(--clr-primary)';
    });
    wrapper.addEventListener('dragleave', () => { wrapper.style.outline = ''; });
    wrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      wrapper.style.outline = '';
      const board = this.app.board;
      const rect = board.wrapper.getBoundingClientRect();
      const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

      if (e.dataTransfer.files.length) {
        Array.from(e.dataTransfer.files).forEach((file, idx) => {
          if (file.type.startsWith('image/')) {
            const fd = new FormData(); fd.append('file', file);
            fetch('/api/upload/image', { method: 'POST', body: fd })
              .then(r => r.json())
              .then(data => {
                if (data.url) this.app.createElement('image', {
                  x: bp.x + idx * 40, y: bp.y + idx * 40,
                  width: 300, height: 200, src: data.url });
              });
          } else if (file.name.endsWith('.json')) {
            file.text().then(text => {
              try { this.app.importFromJSON(JSON.parse(text)); }
              catch (e) { console.error('Bad JSON'); }
            });
          }
        });
      }
    });
  }
}

window.DragDropManager = DragDropManager;
