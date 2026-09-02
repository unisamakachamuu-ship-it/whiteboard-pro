/* ================================================================
   BoardCanvas – Infinite canvas with dual-layer rendering (FIXED)
   ================================================================ */

class BoardCanvas {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.wrapper = document.getElementById('canvas-wrapper');
    this.canvas = document.getElementById('draw-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.elementsLayer = document.getElementById('elements-layer');
    this.svgOverlay = document.getElementById('svg-overlay');
    this.selectionBox = document.getElementById('selection-box');

    this.transform = { x: 0, y: 0, scale: 1 };
    this.drawingPaths = [];
    this.currentPath = null;

    this._resizeCanvas();
    window.addEventListener('resize', () => this._resizeCanvas());

    /* FIX: draw-canvas must not block element clicks when not drawing */
    this.canvas.style.pointerEvents = 'none';
  }

  /* ---- coordinate helpers ---- */

  screenToBoard(sx, sy) {
    return {
      x: (sx - this.transform.x) / this.transform.scale,
      y: (sy - this.transform.y) / this.transform.scale,
    };
  }

  boardToScreen(bx, by) {
    return {
      x: bx * this.transform.scale + this.transform.x,
      y: by * this.transform.scale + this.transform.y,
    };
  }

  /* ---- enable / disable drawing layer ---- */
  enableDrawCanvas()  { this.canvas.style.pointerEvents = 'auto'; }
  disableDrawCanvas() { this.canvas.style.pointerEvents = 'none'; }

  /* ---- zoom / pan ---- */

  setTransform(x, y, scale) {
    this.transform = { x, y, scale };
    this.container.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this._renderDrawing();
    this.app.updateZoomDisplay();
    this.updateMinimap();
  }

  zoomAtPoint(delta, cx, cy) {
    const oldScale = this.transform.scale;
    let newScale = oldScale * (1 + delta);
    newScale = Math.max(0.1, Math.min(5, newScale));
    const ratio = newScale / oldScale;
    const nx = cx - (cx - this.transform.x) * ratio;
    const ny = cy - (cy - this.transform.y) * ratio;
    this.setTransform(nx, ny, newScale);
  }

  panBy(dx, dy) {
    this.setTransform(this.transform.x + dx, this.transform.y + dy, this.transform.scale);
  }

  zoomToFit() {
    const els = this.app.state.elements;
    if (!els.length) { this.setTransform(0, 0, 1); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    els.forEach(el => {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + (el.width || 200));
      maxY = Math.max(maxY, el.y + (el.height || 200));
    });
    const pad = 80;
    const vw = this.wrapper.clientWidth;
    const vh = this.wrapper.clientHeight;
    const scale = Math.min((vw - pad * 2) / (maxX - minX || 1), (vh - pad * 2) / (maxY - minY || 1), 2);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.setTransform(vw / 2 - cx * scale, vh / 2 - cy * scale, scale);
  }

  /* ---- canvas sizing ---- */

  _resizeCanvas() {
    const w = this.wrapper.clientWidth;
    const h = this.wrapper.clientHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this._renderDrawing();
  }

  /* ================================================================
     ELEMENT RENDERING
     ================================================================ */

  renderElement(el) {
    let dom = this.elementsLayer.querySelector(`[data-element-id="${el.id}"]`);
    if (dom) dom.remove();

    switch (el.type) {
      case 'sticky-note': dom = this._createStickyNote(el); break;
      case 'text':        dom = this._createTextElement(el); break;
      case 'shape':       dom = this._createShape(el); break;
      case 'image':       dom = this._createImage(el); break;
      case 'frame':       dom = this._createFrame(el); break;
      case 'flowchart':   dom = this._createFlowchartNode(el); break;
      case 'mindmap':     dom = this._createMindMapNode(el); break;
      case 'graph':       dom = this._createGraphElement(el); break;
      case 'algorithm':   dom = this._createAlgorithmBlock(el); break;
      default: return null;
    }

    if (!dom) return null;

    dom.setAttribute('data-element-id', el.id);
    dom.classList.add('board-element');
    dom.style.left = el.x + 'px';
    dom.style.top = el.y + 'px';
    if (el.width)  dom.style.width = el.width + 'px';
    if (el.height) dom.style.height = el.height + 'px';
    if (el.rotation) dom.style.transform = `rotate(${el.rotation}deg)`;
    if (el.zIndex) dom.style.zIndex = el.zIndex;
    if (el.style && el.style.opacity != null) dom.style.opacity = el.style.opacity;
    if (el.locked) dom.classList.add('locked');

    this.elementsLayer.appendChild(dom);
    return dom;
  }

  /* ---- FIX: contentEditable off by default; enable on double-click ---- */

  _createStickyNote(el) {
    const div = document.createElement('div');
    div.className = 'sticky-note';
    const bg = (el.style && el.style.backgroundColor) || '#fff9b1';
    div.style.background = bg;
    div.innerText = el.content || '';
    div.style.fontSize = (el.style && el.style.fontSize ? el.style.fontSize : 14) + 'px';

    /* FIX: Not editable by default — prevents drag-blocking */
    div.contentEditable = 'false';
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      div.contentEditable = 'true';
      div.focus();
    });
    div.addEventListener('blur', () => {
      div.contentEditable = 'false';
      el.content = div.innerText;
      this.app.saveState();
    });
    return div;
  }

  _createTextElement(el) {
    const div = document.createElement('div');
    div.className = 'text-element';
    div.innerText = el.content || 'Type here…';
    if (el.style) {
      if (el.style.fontSize)   div.style.fontSize = el.style.fontSize + 'px';
      if (el.style.fontFamily) div.style.fontFamily = el.style.fontFamily;
      if (el.style.color)      div.style.color = el.style.color;
      if (el.style.fontWeight) div.style.fontWeight = el.style.fontWeight;
    }
    /* FIX: same as sticky note */
    div.contentEditable = 'false';
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      div.contentEditable = 'true';
      div.focus();
    });
    div.addEventListener('blur', () => {
      div.contentEditable = 'false';
      el.content = div.innerText;
      this.app.saveState();
    });
    return div;
  }

  _createShape(el) {
    const div = document.createElement('div');
    div.className = `shape-element shape-${el.shapeType || 'rectangle'}`;
    const style = el.style || {};
    
    // Instead of CSS borders, we use an inline SVG that scales 100% to the bounding box
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    
    let fill = (style.backgroundColor && style.backgroundColor !== 'transparent') ? style.backgroundColor : 'transparent';
    let stroke = style.borderColor || '#1a1a2e';
    // Calculate relative stroke width
    let strokeW = style.borderWidth ? (style.borderWidth * 100 / Math.max(el.width || 100, 1)) : 2;
    
    let shapeNode;
    switch(el.shapeType) {
      case 'circle':
        shapeNode = document.createElementNS(ns, 'ellipse');
        shapeNode.setAttribute('cx', '50');
        shapeNode.setAttribute('cy', '50');
        shapeNode.setAttribute('rx', 50 - strokeW/2);
        shapeNode.setAttribute('ry', 50 - strokeW/2);
        break;
      case 'diamond':
        shapeNode = document.createElementNS(ns, 'polygon');
        shapeNode.setAttribute('points', `50,${strokeW/2} ${100-strokeW/2},50 50,${100-strokeW/2} ${strokeW/2},50`);
        break;
      case 'triangle':
        shapeNode = document.createElementNS(ns, 'polygon');
        shapeNode.setAttribute('points', `50,${strokeW/2} ${100-strokeW/2},${100-strokeW/2} ${strokeW/2},${100-strokeW/2}`);
        break;
      default: // rectangle
        shapeNode = document.createElementNS(ns, 'rect');
        shapeNode.setAttribute('x', strokeW/2);
        shapeNode.setAttribute('y', strokeW/2);
        shapeNode.setAttribute('width', 100 - strokeW);
        shapeNode.setAttribute('height', 100 - strokeW);
        break;
    }
    
    shapeNode.setAttribute('fill', fill);
    shapeNode.setAttribute('stroke', stroke);
    shapeNode.setAttribute('stroke-width', strokeW);
    shapeNode.setAttribute('vector-effect', 'non-scaling-stroke'); // Keeps borders consistent
    
    svg.appendChild(shapeNode);
    div.appendChild(svg);
    
    // Make wrapper completely transparent so the SVG dictates the visual
    div.style.background = 'transparent';
    div.style.border = 'none';

    return div;
  }

  _createImage(el) {
    const div = document.createElement('div');
    div.className = 'image-element';
    const img = document.createElement('img');
    img.src = el.src || '';
    img.alt = 'Board image';
    img.draggable = false;
    div.appendChild(img);
    return div;
  }

  _createFrame(el) {
    const div = document.createElement('div');
    div.className = 'frame-element';
    const title = document.createElement('div');
    title.className = 'frame-title';
    title.innerText = el.content || 'Frame';
    title.contentEditable = 'false';
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      title.contentEditable = 'true';
      title.focus();
    });
    title.addEventListener('blur', () => {
      title.contentEditable = 'false';
      el.content = title.innerText;
    });
    div.appendChild(title);
    return div;
  }

  /* ---- NEW: Flowchart node ---- */
  _createFlowchartNode(el) {
    const div = document.createElement('div');
    div.className = `fc-node fc-${el.fcType || 'process'}`;
    const label = document.createElement('div');
    label.className = 'fc-label';
    label.innerText = el.content || el.fcType || 'Process';
    label.contentEditable = 'false';
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      label.contentEditable = 'true';
      label.focus();
    });
    label.addEventListener('blur', () => {
      label.contentEditable = 'false';
      el.content = label.innerText;
      this.app.saveState();
    });
    div.appendChild(label);

    /* connection ports */
    ['top','right','bottom','left'].forEach(dir => {
      const port = document.createElement('div');
      port.className = `fc-port fc-port-${dir}`;
      port.dataset.port = dir;
      port.dataset.nodeId = el.id;
      div.appendChild(port);
    });
    return div;
  }

  /* ---- NEW: Mind-map node ---- */
  _createMindMapNode(el) {
    const div = document.createElement('div');
    div.className = `mm-node ${el.mmRoot ? 'mm-root' : 'mm-child'}`;
    div.style.background = el.style?.backgroundColor || (el.mmRoot ? '#4262ff' : '#e8ecff');
    div.style.color = el.mmRoot ? '#fff' : '#1a1a2e';

    const label = document.createElement('div');
    label.className = 'mm-label';
    label.innerText = el.content || 'Topic';
    label.contentEditable = 'false';
    label.addEventListener('dblclick', (e) => { e.stopPropagation(); label.contentEditable = 'true'; label.focus(); });
    label.addEventListener('blur', () => { label.contentEditable = 'false'; el.content = label.innerText; this.app.saveState(); });
    div.appendChild(label);

    /* add-child button */
    const addBtn = document.createElement('button');
    addBtn.className = 'mm-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add child';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.app.mindmap) this.app.mindmap.addChild(el.id);
    });
    div.appendChild(addBtn);

    /* collapse button (only if has children) */
    if (el.mmChildren && el.mmChildren.length) {
      const colBtn = document.createElement('button');
      colBtn.className = 'mm-collapse-btn';
      colBtn.textContent = el.mmCollapsed ? '+' : '−';
      colBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.app.mindmap) this.app.mindmap.toggleCollapse(el.id);
      });
      div.appendChild(colBtn);
    }

    return div;
  }

  /* ---- NEW: Graph/chart element ---- */
  _createGraphElement(el) {
    const div = document.createElement('div');
    div.className = 'graph-element';
    const titleEl = document.createElement('div');
    titleEl.className = 'graph-title';
    titleEl.textContent = el.graphTitle || 'Chart';
    div.appendChild(titleEl);

    const canvasEl = document.createElement('canvas');
    canvasEl.className = 'graph-canvas';
    canvasEl.width = (el.width || 400) - 20;
    canvasEl.height = (el.height || 300) - 50;
    div.appendChild(canvasEl);

    /* edit button */
    const editBtn = document.createElement('button');
    editBtn.className = 'graph-edit-btn';
    editBtn.textContent = '✏️ Edit Data';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.app.graphMgr) this.app.graphMgr.openEditor(el.id);
    });
    div.appendChild(editBtn);

    /* render chart after appending to DOM */
    requestAnimationFrame(() => {
      if (this.app.graphMgr) this.app.graphMgr.renderChart(el, canvasEl);
    });
    return div;
  }

  /* ---- NEW: Algorithm block ---- */
  _createAlgorithmBlock(el) {
    const div = document.createElement('div');
    div.className = 'algo-block';

    // Apply theme
    const themeName = el.algoTheme || 'dark';
    const themes = (typeof AlgorithmManager !== 'undefined') ? AlgorithmManager.THEMES : {};
    const theme = themes[themeName] || { bg:'#1e1e1e', headerBg:'#2d2d2d', text:'#d4d4d4', border:'#404040' };
    const stepMeta = (typeof AlgorithmManager !== 'undefined') ? AlgorithmManager.STEP_META : {};

    div.style.background = theme.bg;
    div.style.color = theme.text;
    div.style.borderColor = theme.border;

    const header = document.createElement('div');
    header.className = 'algo-header';
    header.style.background = theme.headerBg;
    header.style.borderBottomColor = theme.border;
    header.innerHTML = `<span class="algo-icon">⚡</span><span class="algo-title">${this._escapeHTML(el.content || 'Algorithm')}</span>`;
    header.querySelector('.algo-title').contentEditable = 'false';
    header.querySelector('.algo-title').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.target.contentEditable = 'true';
      e.target.focus();
    });
    header.querySelector('.algo-title').addEventListener('blur', (e) => {
      e.target.contentEditable = 'false';
      el.content = e.target.textContent;
      this.app.saveState();
    });
    div.appendChild(header);

    const body = document.createElement('div');
    body.className = 'algo-body';

    (el.algoSteps || []).forEach((step, i) => {
      const meta = stepMeta[step.type] || stepMeta.process || { icon:'▸', color:'#d4d4d4' };
      const indent = (step.text || '').match(/^(\s*)/)[1].length;
      const row = document.createElement('div');
      row.className = 'algo-step';
      row.style.paddingLeft = (12 + indent * 8) + 'px';
      row.innerHTML = `<span class="algo-line-num">${i + 1}</span>`
        + `<span class="algo-type-icon" style="color:${meta.color}">${meta.icon}</span>`
        + `<span class="algo-step-text" style="color:${meta.color}">${this._escapeHTML((step.text || '').trim())}</span>`;
      body.appendChild(row);
    });
    div.appendChild(body);

    const editBtn = document.createElement('button');
    editBtn.className = 'algo-edit-btn';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.app.algoMgr) this.app.algoMgr.openEditor(el.id);
    });
    div.appendChild(editBtn);

    return div;
  }

  _escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  /* ---- element removal ---- */

  removeElement(id) {
    const dom = this.elementsLayer.querySelector(`[data-element-id="${id}"]`);
    if (dom) dom.remove();
    /* also remove any SVG connections referencing this element */
    this.svgOverlay.querySelectorAll(`[data-from="${id}"],[data-to="${id}"]`).forEach(e => e.remove());
  }

  renderAllElements() {
    this.elementsLayer.innerHTML = '';
    this.app.state.elements.forEach(el => this.renderElement(el));
  }

  /* ================================================================
     SELECTION VISUALS
     ================================================================ */

  showSelection(el) {
    const dom = this.elementsLayer.querySelector(`[data-element-id="${el.id}"]`);
    if (!dom) return;
    dom.classList.add('selected');
    /* only add handles if not already there */
    if (!dom.querySelector('.resize-handle')) this._addResizeHandles(dom);
  }

  clearSelectionVisuals() {
    this.elementsLayer.querySelectorAll('.selected').forEach(d => {
      d.classList.remove('selected');
      d.querySelectorAll('.resize-handle, .rotation-handle').forEach(h => h.remove());
    });
  }

  _addResizeHandles(dom) {
    ['nw','ne','sw','se','n','s','e','w'].forEach(dir => {
      const h = document.createElement('div');
      h.className = `resize-handle ${dir}`;
      h.dataset.handle = dir;
      dom.appendChild(h);
    });
    const rot = document.createElement('div');
    rot.className = 'rotation-handle';
    rot.dataset.handle = 'rotate';
    dom.appendChild(rot);
  }

  /* ---- rubber-band ---- */

  showSelectionBox(x, y, w, h) {
    const box = this.selectionBox;
    box.classList.remove('hidden');
    box.style.left = Math.min(x, x + w) + 'px';
    box.style.top  = Math.min(y, y + h) + 'px';
    box.style.width  = Math.abs(w) + 'px';
    box.style.height = Math.abs(h) + 'px';
  }

  hideSelectionBox() { this.selectionBox.classList.add('hidden'); }

  /* ================================================================
     PEN / DRAWING LAYER
     ================================================================ */

  startPath(x, y, color, width) {
    this.enableDrawCanvas();
    this.currentPath = { points: [{ x, y }], color: color || '#1a1a2e', width: width || 3 };
  }

  addPathPoint(x, y) {
    if (!this.currentPath) return;
    this.currentPath.points.push({ x, y });
    this._drawCurrentPath();
  }

  endPath() {
    if (this.currentPath && this.currentPath.points.length > 1) {
      this.drawingPaths.push(this.currentPath);
    }
    this.currentPath = null;
    this._renderDrawing();
    this.disableDrawCanvas();
  }

  _drawCurrentPath() {
    if (!this.currentPath) return;
    this._renderDrawing();
    this._drawPath(this.currentPath);
  }

  _renderDrawing() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.scale, this.transform.scale);
    this.drawingPaths.forEach(p => this._drawPath(p));
    if (this.currentPath) this._drawPath(this.currentPath);
    ctx.restore();
  }

  _drawPath(path) {
    const { ctx } = this;
    const pts = path.points;
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = path.color;
    ctx.lineWidth = path.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  erasePaths(bx, by, radius) {
    this.drawingPaths = this.drawingPaths.filter(path => {
      return !path.points.some(p => {
        const dx = p.x - bx, dy = p.y - by;
        return Math.sqrt(dx * dx + dy * dy) < radius;
      });
    });
    this._renderDrawing();
  }

  /* ================================================================
     SVG LINES / ARROWS / CONNECTIONS
     ================================================================ */

  renderLine(el) {
    let g = this.svgOverlay.querySelector(`[data-line-id="${el.id}"]`);
    if (g) g.remove();
    const ns = 'http://www.w3.org/2000/svg';
    g = document.createElementNS(ns, 'g');
    g.setAttribute('data-line-id', el.id);
    g.style.pointerEvents = 'auto';

    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', el.x1); l.setAttribute('y1', el.y1);
    l.setAttribute('x2', el.x2); l.setAttribute('y2', el.y2);
    l.setAttribute('stroke', (el.style && el.style.color) || '#1a1a2e');
    l.setAttribute('stroke-width', (el.style && el.style.width) || 2);
    if (el.style && el.style.dash) l.setAttribute('stroke-dasharray', el.style.dash);
    g.appendChild(l);

    if (el.arrow) {
      const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
      const sz = 12;
      const poly = document.createElementNS(ns, 'polygon');
      const px = el.x2, py = el.y2;
      const p1x = px - sz * Math.cos(angle - 0.4);
      const p1y = py - sz * Math.sin(angle - 0.4);
      const p2x = px - sz * Math.cos(angle + 0.4);
      const p2y = py - sz * Math.sin(angle + 0.4);
      poly.setAttribute('points', `${px},${py} ${p1x},${p1y} ${p2x},${p2y}`);
      poly.setAttribute('fill', (el.style && el.style.color) || '#1a1a2e');
      g.appendChild(poly);
    }
    this.svgOverlay.appendChild(g);
  }

  /* Render flowchart / mindmap connection as curved SVG path */
  renderConnection(conn) {
    let g = this.svgOverlay.querySelector(`[data-conn-id="${conn.id}"]`);
    if (g) g.remove();

    const ns = 'http://www.w3.org/2000/svg';
    g = document.createElementNS(ns, 'g');
    g.setAttribute('data-conn-id', conn.id);
    if (conn.from) g.setAttribute('data-from', conn.from);
    if (conn.to)   g.setAttribute('data-to', conn.to);

    const path = document.createElementNS(ns, 'path');
    const x1 = conn.x1, y1 = conn.y1, x2 = conn.x2, y2 = conn.y2;

    let d;
    if (conn.curved) {
      const cx1 = x1 + (x2 - x1) * 0.5;
      const cx2 = x1 + (x2 - x1) * 0.5;
      d = `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;
    } else {
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`;
    }

    path.setAttribute('d', d);
    path.setAttribute('stroke', conn.color || '#6b7280');
    path.setAttribute('stroke-width', conn.width || 2);
    path.setAttribute('fill', 'none');
    g.appendChild(path);

    /* arrow head */
    if (conn.arrow) {
      const angle = Math.atan2(y2 - (y1 + y2) / 2, x2 - x2);
      const sz = 8;
      const marker = document.createElementNS(ns, 'polygon');
      marker.setAttribute('points',
        `${x2},${y2} ${x2 - sz},${y2 - sz / 2} ${x2 - sz},${y2 + sz / 2}`);
      marker.setAttribute('fill', conn.color || '#6b7280');
      g.appendChild(marker);
    }

    this.svgOverlay.appendChild(g);
  }

  clearConnections() {
    this.svgOverlay.querySelectorAll('[data-conn-id]').forEach(g => g.remove());
  }

  /* ---- alignment guides ---- */

  showAlignmentGuide(type, pos) {
    const g = document.createElement('div');
    g.className = `alignment-guide ${type}`;
    if (type === 'horizontal') g.style.top = pos + 'px';
    else g.style.left = pos + 'px';
    this.elementsLayer.appendChild(g);
  }

  clearAlignmentGuides() {
    this.elementsLayer.querySelectorAll('.alignment-guide').forEach(g => g.remove());
  }

  /* ---- minimap ---- */

  updateMinimap() {
    const mc = document.getElementById('minimap-canvas');
    if (!mc) return;
    const mctx = mc.getContext('2d');
    const mw = mc.width, mh = mc.height;
    mctx.clearRect(0, 0, mw, mh);
    mctx.fillStyle = '#f8f9fb';
    mctx.fillRect(0, 0, mw, mh);

    const els = this.app.state.elements;
    if (!els.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    els.forEach(el => {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + (el.width || 200));
      maxY = Math.max(maxY, el.y + (el.height || 200));
    });
    const pad = 40;
    const bw = (maxX - minX) || 1;
    const bh = (maxY - minY) || 1;
    const scale = Math.min((mw - pad) / bw, (mh - pad) / bh);

    els.forEach(el => {
      const rx = (el.x - minX) * scale + pad / 2;
      const ry = (el.y - minY) * scale + pad / 2;
      const rw = (el.width || 200) * scale;
      const rh = (el.height || 200) * scale;
      mctx.fillStyle = (el.style && el.style.backgroundColor) || '#d0e8ff';
      mctx.fillRect(rx, ry, Math.max(rw, 2), Math.max(rh, 2));
    });
  }
}

window.BoardCanvas = BoardCanvas;
