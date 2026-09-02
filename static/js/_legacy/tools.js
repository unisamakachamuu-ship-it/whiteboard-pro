/* ================================================================
   ToolManager + Tool classes for WhiteBoard Pro
   ================================================================ */

/* ---------- Base Tool ---------- */
class BaseTool {
  constructor(app) { this.app = app; this.active = false; }
  activate()   { this.active = true; }
  deactivate() { this.active = false; }
  onMouseDown(e) {}
  onMouseMove(e) {}
  onMouseUp(e)   {}
  onDoubleClick(e) {}
  getCursor()  { return 'default'; }
}

/* ---------- Select Tool ---------- */
class SelectTool extends BaseTool {
  constructor(app) {
    super(app);
    this._rubberBand = false;
    this._startX = 0;
    this._startY = 0;
  }

  getCursor() { return 'default'; }

  onMouseDown(e) {
    // If we get here, DragDrop didn't handle the click
    // (meaning we clicked on empty space, not an element)
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Deselect all and start rubber-band
    if (!e.shiftKey) this.app.state.selectedElements = [];
    this.app.refreshSelection();
    this._rubberBand = true;
    this._startX = sx;
    this._startY = sy;
  }

  onMouseMove(e) {
    if (!this._rubberBand) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    board.showSelectionBox(this._startX, this._startY, sx - this._startX, sy - this._startY);
  }

  onMouseUp(e) {
    if (!this._rubberBand) return;
    const board = this.app.board;
    board.hideSelectionBox();

    const rect = board.wrapper.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const x1 = Math.min(this._startX, sx), y1 = Math.min(this._startY, sy);
    const x2 = Math.max(this._startX, sx), y2 = Math.max(this._startY, sy);

    // Only select if user actually dragged a box (not just a click)
    if (Math.abs(x2 - x1) > 5 || Math.abs(y2 - y1) > 5) {
      const bp1 = board.screenToBoard(x1, y1);
      const bp2 = board.screenToBoard(x2, y2);
      this.app.state.elements.forEach(el => {
        if (el.x >= bp1.x && el.y >= bp1.y &&
            el.x + (el.width || 200) <= bp2.x &&
            el.y + (el.height || 200) <= bp2.y) {
          if (!this.app.state.selectedElements.includes(el.id)) {
            this.app.state.selectedElements.push(el.id);
          }
        }
      });
      this.app.refreshSelection();
    }

    this._rubberBand = false;
  }

  onDoubleClick(e) {
    const target = e.target.closest('.board-element');
    if (target) {
      // Enable text editing on double-click
      const editable = target.querySelector('[contenteditable]') || target;
      if (editable) {
        editable.contentEditable = 'true';
        editable.focus();
      }
    }
  }
}

/* ---------- Hand / Pan Tool ---------- */
class HandTool extends BaseTool {
  constructor(app) {
    super(app);
    this._panning = false;
    this._lastX = 0;
    this._lastY = 0;
  }

  getCursor() { return this._panning ? 'grabbing' : 'grab'; }

  onMouseDown(e) {
    this._panning = true;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this.app.board.wrapper.classList.add('panning');
  }

  onMouseMove(e) {
    if (!this._panning) return;
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this.app.board.panBy(dx, dy);
    this._lastX = e.clientX;
    this._lastY = e.clientY;
  }

  onMouseUp() {
    this._panning = false;
    this.app.board.wrapper.classList.remove('panning');
  }
}

/* ---------- Sticky Note Tool ---------- */
class StickyNoteTool extends BaseTool {
  constructor(app) {
    super(app);
    this.color = '#fff9b1';
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left') || e.target.closest('.sub-menu')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    const el = this.app.createElement('sticky-note', {
      x: bp.x - 110,
      y: bp.y - 110,
      width: 220,
      height: 220,
      content: '',
      style: { backgroundColor: this.color, fontSize: 14 },
    });

    // Auto-focus after render
    setTimeout(() => {
      const dom = document.querySelector(`[data-element-id="${el.id}"]`);
      if (dom) { dom.contentEditable = 'true'; dom.focus(); }
    }, 50);
    
    // FIX: prevent rapid duplicate creation by switching to select tool
    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Text Tool ---------- */
class TextTool extends BaseTool {
  getCursor() { return 'text'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    const el = this.app.createElement('text', {
      x: bp.x,
      y: bp.y,
      width: 200,
      height: 40,
      content: '',
      style: { fontSize: 18, color: '#1a1a2e' },
    });

    setTimeout(() => {
      const dom = document.querySelector(`[data-element-id="${el.id}"]`);
      if (dom) { dom.innerText = ''; dom.contentEditable = 'true'; dom.focus(); }
    }, 50);

    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Shape Tool ---------- */
class ShapeTool extends BaseTool {
  constructor(app) {
    super(app);
    this.shapeType = 'rectangle';
    this._drawing = false;
    this._startBP = null;
    this._tempEl = null;
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left') || e.target.closest('.sub-menu')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    this._startBP = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    this._drawing = true;

    this._tempEl = this.app.createElement('shape', {
      x: this._startBP.x,
      y: this._startBP.y,
      width: 2,
      height: 2,
      shapeType: this.shapeType,
      style: { backgroundColor: 'transparent', borderColor: '#1a1a2e', borderWidth: 2 },
    });
  }

  onMouseMove(e) {
    if (!this._drawing || !this._tempEl) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    let w = bp.x - this._startBP.x;
    let h = bp.y - this._startBP.y;

    if (e.shiftKey) {
      const size = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w) * size;
      h = Math.sign(h) * size;
    }

    this._tempEl.x = w < 0 ? this._startBP.x + w : this._startBP.x;
    this._tempEl.y = h < 0 ? this._startBP.y + h : this._startBP.y;
    this._tempEl.width = Math.abs(w);
    this._tempEl.height = Math.abs(h);
    this.app.board.renderElement(this._tempEl);
  }

  onMouseUp() {
    if (this._tempEl && (this._tempEl.width < 5 && this._tempEl.height < 5)) {
      // Too small, set default size
      this._tempEl.width = 150;
      this._tempEl.height = 150;
      this.app.board.renderElement(this._tempEl);
    }
    this._drawing = false;
    this._tempEl = null;
    this.app.pushHistory('create');
    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Pen Tool ---------- */
class PenTool extends BaseTool {
  constructor(app) {
    super(app);
    this.color = '#1a1a2e';
    this.lineWidth = 3;
    this._drawing = false;
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    board.startPath(bp.x, bp.y, this.color, this.lineWidth);
    this._drawing = true;
  }

  onMouseMove(e) {
    if (!this._drawing) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    board.addPathPoint(bp.x, bp.y);
  }

  onMouseUp() {
    if (!this._drawing) return;
    this.app.board.endPath();
    this._drawing = false;
    this.app.pushHistory('draw');
  }
}

/* ---------- Line / Arrow Tool ---------- */
class LineTool extends BaseTool {
  constructor(app) {
    super(app);
    this._drawing = false;
    this._startBP = null;
    this._lineEl = null;
    this.arrow = true;
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    this._startBP = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    this._drawing = true;
    this._lineEl = {
      id: 'line-' + Date.now(),
      x1: this._startBP.x, y1: this._startBP.y,
      x2: this._startBP.x, y2: this._startBP.y,
      arrow: this.arrow,
      style: { color: '#1a1a2e', width: 2 },
    };
  }

  onMouseMove(e) {
    if (!this._drawing || !this._lineEl) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    this._lineEl.x2 = bp.x;
    this._lineEl.y2 = bp.y;
    board.renderLine(this._lineEl);
  }

  onMouseUp() {
    this._drawing = false;
    if (this._lineEl) {
      this.app.state.lines = this.app.state.lines || [];
      this.app.state.lines.push(this._lineEl);
      this._lineEl = null;
      this.app.pushHistory('line');
      this.app.tools.setActiveTool('select');
    }
  }
}

/* ---------- Eraser Tool ---------- */
class EraserTool extends BaseTool {
  constructor(app) {
    super(app);
    this._erasing = false;
    this.radius = 20;
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    this._erasing = true;
    this._erase(e);
  }

  onMouseMove(e) {
    if (!this._erasing) return;
    this._erase(e);
  }

  onMouseUp() {
    this._erasing = false;
  }

  _erase(e) {
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    // Erase drawing paths
    board.erasePaths(bp.x, bp.y, this.radius / board.transform.scale);

    // Check if clicking on an element — delete it
    const target = e.target.closest('.board-element');
    if (target) {
      const id = target.dataset.elementId;
      this.app.deleteElement(id);
    }
  }
}

/* ---------- Image Tool ---------- */
class ImageTool extends BaseTool {
  getCursor() { return 'copy'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const input = document.getElementById('image-file-input');
    this._clickPos = { x: e.clientX, y: e.clientY };
    input.click();
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      this._uploadImage(file);
      input.value = '';
      this.app.tools.setActiveTool('select');
    };
  }

  _uploadImage(file) {
    const fd = new FormData();
    fd.append('file', file);
    fetch('/api/upload/image', { method: 'POST', body: fd })
      .then(r => r.json())
      .then(data => {
        if (data.url) {
          const board = this.app.board;
          const rect = board.wrapper.getBoundingClientRect();
          const bp = board.screenToBoard(
            (this._clickPos ? this._clickPos.x : rect.width / 2) - rect.left,
            (this._clickPos ? this._clickPos.y : rect.height / 2) - rect.top
          );
          this.app.createElement('image', {
            x: bp.x, y: bp.y, width: 300, height: 200,
            src: data.url,
          });
        }
      })
      .catch(err => console.error('Image upload failed:', err));
  }
}

/* ---------- Frame Tool ---------- */
class FrameTool extends BaseTool {
  constructor(app) {
    super(app);
    this._drawing = false;
    this._startBP = null;
    this._tempEl = null;
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    this._startBP = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    this._drawing = true;

    this._tempEl = this.app.createElement('frame', {
      x: this._startBP.x, y: this._startBP.y,
      width: 2, height: 2, content: 'Frame',
    });
  }

  onMouseMove(e) {
    if (!this._drawing || !this._tempEl) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
    this._tempEl.width = Math.abs(bp.x - this._startBP.x);
    this._tempEl.height = Math.abs(bp.y - this._startBP.y);
    this._tempEl.x = Math.min(bp.x, this._startBP.x);
    this._tempEl.y = Math.min(bp.y, this._startBP.y);
    board.renderElement(this._tempEl);
  }

  onMouseUp() {
    if (this._tempEl && this._tempEl.width < 20) {
      this._tempEl.width = 400;
      this._tempEl.height = 300;
      this.app.board.renderElement(this._tempEl);
    }
    this._drawing = false;
    this._tempEl = null;
    this.app.pushHistory('create');
    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Flowchart Tool ---------- */
class FlowchartTool extends BaseTool {
  constructor(app) {
    super(app);
    this.fcType = 'process';
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left') || e.target.closest('.sub-menu') || e.target.closest('.fc-port')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    const el = this.app.createElement('flowchart', {
      x: bp.x - 75,
      y: bp.y - 30,
      width: 150,
      height: 60,
      fcType: this.fcType,
    });
    
    setTimeout(() => {
        const dom = document.querySelector(`[data-element-id="${el.id}"] .fc-label`);
        if (dom) { dom.contentEditable = 'true'; dom.focus(); }
    }, 50);
    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Mind Map Tool ---------- */
class MindMapTool extends BaseTool {
  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    const el = this.app.createElement('mindmap', {
      x: bp.x - 100,
      y: bp.y - 30,
      width: 200,
      height: 60,
      content: 'Central Idea',
      mmRoot: true,
      mmChildren: [],
      style: { backgroundColor: '#4262ff', color: '#ffffff' }
    });
    
    setTimeout(() => {
        const dom = document.querySelector(`[data-element-id="${el.id}"] .mm-label`);
        if (dom) { dom.contentEditable = 'true'; dom.focus(); }
    }, 50);
    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Graph Tool ---------- */
class GraphTool extends BaseTool {
  constructor(app) {
    super(app);
    this.graphType = 'bar';
  }

  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left') || e.target.closest('.sub-menu')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    this.app.createElement('graph', {
      x: bp.x - 200,
      y: bp.y - 150,
      width: 400,
      height: 300,
      graphType: this.graphType,
      graphTitle: this.graphType.toUpperCase() + ' CHART',
      graphData: [
            { label: 'A', value: 30, color: '#4262ff' },
            { label: 'B', value: 70, color: '#2ecc71' },
            { label: 'C', value: 45, color: '#f39c12' }
      ]
    });
    this.app.tools.setActiveTool('select');
  }
}

/* ---------- Algorithm Tool ---------- */
class AlgorithmTool extends BaseTool {
  getCursor() { return 'crosshair'; }

  onMouseDown(e) {
    if (e.target.closest('.toolbar-left')) return;
    const board = this.app.board;
    const rect = board.wrapper.getBoundingClientRect();
    const bp = board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);

    this.app.createElement('algorithm', {
      x: bp.x - 150,
      y: bp.y - 100,
      width: 300,
      height: 200,
      content: 'Algorithm Block',
      algoSteps: [
          { text: 'def calculate_total(items):', type: 'start' },
          { text: '  total = 0', type: 'process' },
          { text: '  for item in items:', type: 'decision' },
          { text: '    total += item.price', type: 'process' },
          { text: '  return total', type: 'end' }
      ]
    });
    this.app.tools.setActiveTool('select');
  }
}


/* ================================================================
   Tool Manager
   ================================================================ */
class ToolManager {
  constructor(app) {
    this.app = app;
    this.tools = {
      select: new SelectTool(app),
      hand:   new HandTool(app),
      sticky: new StickyNoteTool(app),
      text:   new TextTool(app),
      shape:  new ShapeTool(app),
      pen:    new PenTool(app),
      line:   new LineTool(app),
      eraser: new EraserTool(app),
      image:  new ImageTool(app),
      frame:  new FrameTool(app),
      flowchart: new FlowchartTool(app),
      mindmap:   new MindMapTool(app),
      graph:     new GraphTool(app),
      algorithm: new AlgorithmTool(app),
    };
    this.activeTool = null;
    this._previousTool = null;
    this.setActiveTool('select');
  }

  setActiveTool(name) {
    if (this.activeTool) this.activeTool.deactivate();
    this.activeTool = this.tools[name] || this.tools.select;
    this.activeTool.activate();
    this.app.state.activeTool = name;

    // Update UI
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === name);
    });

    // Update cursor
    const wrapper = this.app.board.wrapper;
    wrapper.className = 'canvas-wrapper';
    if (this.app.state.gridVisible) wrapper.classList.add('show-grid');
    wrapper.classList.add(`tool-${name}`);

    // Show/hide sub-menus
    document.getElementById('sticky-color-menu').classList.toggle('hidden', name !== 'sticky');
    document.getElementById('shape-menu').classList.toggle('hidden', name !== 'shape');
    document.getElementById('flowchart-menu')?.classList.toggle('hidden', name !== 'flowchart');
    document.getElementById('graph-menu')?.classList.toggle('hidden', name !== 'graph');
  }

  getActiveTool() { return this.activeTool; }

  temporarySwitch(name) {
    this._previousTool = this.app.state.activeTool;
    this.setActiveTool(name);
  }

  restorePrevious() {
    if (this._previousTool) {
      this.setActiveTool(this._previousTool);
      this._previousTool = null;
    }
  }

  /* Event routing */
  onMouseDown(e) { if (this.activeTool) this.activeTool.onMouseDown(e); }
  onMouseMove(e) { if (this.activeTool) this.activeTool.onMouseMove(e); }
  onMouseUp(e)   { if (this.activeTool) this.activeTool.onMouseUp(e); }
  onDoubleClick(e) { if (this.activeTool) this.activeTool.onDoubleClick(e); }
}

window.ToolManager = ToolManager;
