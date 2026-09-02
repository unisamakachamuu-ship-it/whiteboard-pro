/* ================================================================
   viewport.js — camera, the infinite ink layer and the minimap
   ================================================================
   THE INFINITE-CANVAS FIX
   -----------------------
   Three layers share one board coordinate space:

     1. #ink-canvas   — a *sibling* of the transformed container, sized to
                        the viewport (× devicePixelRatio). It is NEVER CSS
                        transformed; the camera lives in its 2D context.
                        Previously it was inside the transformed container
                        AND applied ctx.translate/scale, so every stroke was
                        transformed twice and clipped to one viewport.

     2. #svg-layer    — inside the transformed container, but given a huge
                        coordinate space (±SVG_EXTENT) with an inner <g>
                        that shifts the origin back. An <svg> element ALWAYS
                        clips to its own viewport, which is why a 100%×100%
                        overlay made every connection outside the first
                        screen — and every negative coordinate — invisible.

     3. .elements-layer — plain DOM, unbounded, positioned with transforms.
   ================================================================ */

const SVG_EXTENT = 100000;   // board coords are valid across ±100 000
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

class Viewport extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.wrapper   = document.getElementById('canvas-wrapper');
    this.container = document.getElementById('canvas-container');

    this.x = 0;
    this.y = 0;
    this.scale = 1;

    this._applyRaf = Util.rafThrottle(() => this._apply());

    this._observer = new ResizeObserver(() => this.emit('resize'));
    this._observer.observe(this.wrapper);

    this._apply();
  }

  /* ---- coordinate conversion ------------------------------------ */

  /** Screen coords are relative to the canvas wrapper's top-left. */
  screenToBoard(sx, sy) {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale };
  }

  boardToScreen(bx, by) {
    return { x: bx * this.scale + this.x, y: by * this.scale + this.y };
  }

  /** Convert a raw pointer event into wrapper-relative screen coords. */
  eventToScreen(e) {
    const r = this.wrapper.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  eventToBoard(e) {
    const s = this.eventToScreen(e);
    return this.screenToBoard(s.x, s.y);
  }

  get width()  { return this.wrapper.clientWidth; }
  get height() { return this.wrapper.clientHeight; }

  /** The board-space rectangle currently on screen. */
  visibleRect(padding = 0) {
    const tl = this.screenToBoard(-padding, -padding);
    const br = this.screenToBoard(this.width + padding, this.height + padding);
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  /* ---- camera ----------------------------------------------------- */

  setTransform(x, y, scale) {
    // Never let a bad number reach the camera: a NaN here makes the whole
    // container transform invalid and the board silently disappears.
    this.x = Util.num(x, this.x);
    this.y = Util.num(y, this.y);
    this.scale = Util.clamp(Util.num(scale, this.scale) || 1, MIN_SCALE, MAX_SCALE);
    this._applyRaf();
    this.emit('transform', this);
  }

  panBy(dx, dy) { this.setTransform(this.x + dx, this.y + dy, this.scale); }

  /** Zoom keeping the board point under (sx,sy) pinned to that pixel. */
  zoomTo(scale, sx, sy) {
    const next = Util.clamp(scale, MIN_SCALE, MAX_SCALE);
    if (next === this.scale) return;
    const cx = sx == null ? this.width / 2 : sx;
    const cy = sy == null ? this.height / 2 : sy;
    const ratio = next / this.scale;
    this.setTransform(cx - (cx - this.x) * ratio, cy - (cy - this.y) * ratio, next);
  }

  zoomBy(factor, sx, sy) { this.zoomTo(this.scale * factor, sx, sy); }

  reset() { this.setTransform(0, 0, 1); }

  /** Fit everything (or a given rect) into view. */
  zoomToFit(rect = null, padding = 90) {
    let bounds = rect || this.contentBounds();
    if (!bounds || (!bounds.w && !bounds.h) || (bounds.w <= 0 && bounds.h <= 0)) {
      this.reset();
      return;
    }

    const vw = this.width || window.innerWidth || 1200;
    const vh = this.height || window.innerHeight || 800;
    const fit = b => Math.min((vw - padding * 2) / Math.max(b.w, 1),
                              (vh - padding * 2) / Math.max(b.h, 1));

    // If fitting everything would drop zoom below 25%, frame the dense cluster
    if (!rect && fit(bounds) < 0.25) {
      const dense = this.denseBounds();
      if (dense && fit(dense) >= 0.25) bounds = dense;
    }

    // Do not zoom out below 25% or in above 1.25 on auto-fit
    let scale = fit(bounds);
    scale = Util.clamp(scale, 0.25, 1.25);
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    this.setTransform(vw / 2 - cx * scale, vh / 2 - cy * scale, scale);
  }

  zoomToSelection() {
    const sel = this.app.store.selected();
    if (!sel.length) return this.zoomToFit();
    const b = Util.boundsOf(sel);
    if (!b) return;
    this.zoomToFit(b, 140);
  }

  centerOn(bx, by) {
    this.setTransform(this.width / 2 - bx * this.scale,
                      this.height / 2 - by * this.scale, this.scale);
  }

  /** Bounding box of every element and stroke on the board. */
  contentBounds() {
    const store = this.app.store;
    const items = [];
    const add = (x, y, width, height) => {
      // A single NaN or runaway coordinate would otherwise poison the whole
      // box and send zoomToFit thousands of screens away from the content.
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      items.push({ x, y, width: Util.num(width, 0), height: Util.num(height, 0) });
    };

    for (const e of store.elements) add(e.x, e.y, e.width, e.height);
    for (const s of store.strokes) {
      const b = s.bbox || Store.strokeBBox(s.points);
      if (b) add(b.x, b.y, b.w, b.h);
    }
    for (const c of store.connections) {
      // `c.from?.id == null` is also true when c.from itself is missing, so
      // the endpoint has to be checked before its coordinates are read.
      if (c.from && c.from.id == null) add(c.from.x, c.from.y, 0, 0);
      if (c.to   && c.to.id   == null) add(c.to.x,   c.to.y,   0, 0);
    }
    return Util.boundsOf(items);
  }

  /**
   * The bounds of the *dense* part of the board, ignoring far-flung strays.
   * zoomToFit falls back to this when fitting everything would push the
   * camera to its minimum scale and leave the screen looking empty.
   */
  denseBounds() {
    const els = this.app.store.elements;
    if (els.length < 2) return null;
    const cx = Util.median(els.map(e => e.x));
    const cy = Util.median(els.map(e => e.y));
    const spread = Util.median(els.map(e => Math.abs(e.x - cx) + Math.abs(e.y - cy)));
    const limit = Math.max(2000, spread * 8);
    const near = els.filter(e => Math.abs(e.x - cx) <= limit && Math.abs(e.y - cy) <= limit);
    return near.length ? Util.boundsOf(near) : null;
  }

  _apply() {
    // translate3d keeps the layer on the compositor — no per-frame layout.
    this.container.style.transform =
      `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.scale})`;

    // The dotted grid lives on the wrapper and scrolls with the camera so
    // the board genuinely reads as infinite in every direction.
    const g = 24 * this.scale;
    this.wrapper.style.backgroundSize = `${g}px ${g}px`;
    this.wrapper.style.backgroundPosition = `${this.x}px ${this.y}px`;

    this.emit('applied', this);
  }
}

/* ================================================================
   InkLayer — freehand drawing on a truly unbounded surface
   ================================================================ */
class InkLayer {
  constructor(app) {
    this.app = app;
    this.viewport = app.viewport;
    this.canvas = document.getElementById('ink-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.active = null;           // stroke currently being drawn
    this._redrawRaf = Util.rafThrottle(() => this.redraw());

    this.resize();
    this.viewport.on('applied', () => this._redrawRaf());
    this.viewport.on('resize', () => { this.resize(); this.redraw(); });
  }

  resize() {
    const w = this.viewport.width;
    const h = this.viewport.height;
    this.canvas.width  = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  /** Map board space onto the bitmap. One transform, applied once. */
  _setCameraTransform() {
    const { x, y, scale } = this.viewport;
    const d = this.dpr;
    this.ctx.setTransform(d * scale, 0, 0, d * scale, d * x, d * y);
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._setCameraTransform();

    // Only draw what can actually be seen — this is what keeps a board with
    // thousands of strokes at 60fps while panning.
    const view = this.viewport.visibleRect(80);
    for (const s of this.app.store.strokes) {
      const b = s.bbox || (s.bbox = Store.strokeBBox(s.points));
      const pad = (s.width || 3) / 2 + 2;
      if (!Util.rectsIntersect(view, { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 })) continue;
      this._paint(ctx, s);
    }
    if (this.active) this._paint(ctx, this.active);
  }

  _paint(ctx, stroke) {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color || '#16161d';
    ctx.lineWidth = stroke.width || 3;

    if (stroke.tool === 'highlighter') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineCap = 'butt';
    }

    if (pts.length === 1) {
      // A single tap still leaves a dot.
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, (stroke.width || 3) / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color || '#16161d';
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
    ctx.restore();
  }

  /* ---- drawing gestures ------------------------------------------ */

  begin(bx, by, opts) {
    this.active = {
      id: Util.uid('stroke'),
      points: [{ x: bx, y: by }],
      color: opts.color,
      width: opts.width,
      tool: opts.tool || 'pen',
    };
    this.redraw();
  }

  extend(bx, by) {
    const s = this.active;
    if (!s) return;
    const last = s.points[s.points.length - 1];
    // Skip sub-pixel moves: fewer points means a smoother curve and less work.
    const minDist = 1.2 / this.viewport.scale;
    if (Math.hypot(bx - last.x, by - last.y) < minDist) return;
    s.points.push({ x: bx, y: by });
    this._redrawRaf();
  }

  end() {
    const s = this.active;
    this.active = null;
    if (!s) return null;
    if (s.points.length < 1) { this.redraw(); return null; }
    s.bbox = Store.strokeBBox(s.points);
    this.app.store.addStroke(s);
    this.redraw();
    return s;
  }

  cancel() { this.active = null; this.redraw(); }

  /** Ids of strokes intersecting an eraser circle in board space. */
  hitStrokes(bx, by, radius) {
    const hits = [];
    const r2 = radius * radius;
    for (const s of this.app.store.strokes) {
      const b = s.bbox || (s.bbox = Store.strokeBBox(s.points));
      if (!Util.rectsIntersect(
        { x: bx - radius, y: by - radius, w: radius * 2, h: radius * 2 },
        { x: b.x, y: b.y, w: b.w, h: b.h })) continue;

      for (const p of s.points) {
        const dx = p.x - bx, dy = p.y - by;
        if (dx * dx + dy * dy <= r2) { hits.push(s.id); break; }
      }
    }
    return hits;
  }
}

/* ================================================================
   Minimap — overview + click/drag to navigate
   ================================================================ */
class Minimap {
  constructor(app) {
    this.app = app;
    this.canvas = document.getElementById('minimap-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._bounds = null;
    this._scale = 1;
    this._dragging = false;
    this._w = 0;
    this._h = 0;

    this._sizeCanvas();
    this._render = Util.rafThrottle(() => this.render());

    this.app.viewport.on('applied', () => this._render());
    this.app.store.on('change', () => this._render());
    this.app.store.on('reload', () => this._render());

    this.canvas.addEventListener('pointerdown', e => {
      this._dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this._navigate(e);
    });
    this.canvas.addEventListener('pointermove', e => { if (this._dragging) this._navigate(e); });
    this.canvas.addEventListener('pointerup', e => {
      this._dragging = false;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    this.render();
  }

  _sizeCanvas() {
    const w = this.canvas.clientWidth || 180;
    const h = this.canvas.clientHeight || 120;
    this._w = w;
    this._h = h;
    this.canvas.width  = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
  }

  _navigate(e) {
    if (!this._bounds) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const bx = this._bounds.x + (mx - this._pad) / this._scale;
    const by = this._bounds.y + (my - this._pad) / this._scale;
    this.app.viewport.centerOn(bx, by);
  }

  render() {
    if (!this.canvas || this.canvas.offsetParent === null) return;
    if (!this._w || !this._h) this._sizeCanvas();

    const ctx = this.ctx;
    const W = this._w, H = this._h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#f5f6fa';
    ctx.fillRect(0, 0, W, H);

    const view = this.app.viewport.visibleRect();
    let bounds = this.app.viewport.contentBounds();
    // Always include the viewport so the indicator has somewhere to live.
    bounds = bounds
      ? {
          x: Math.min(bounds.x, view.x), y: Math.min(bounds.y, view.y),
          w: Math.max(bounds.x + bounds.w, view.x + view.w) - Math.min(bounds.x, view.x),
          h: Math.max(bounds.y + bounds.h, view.y + view.h) - Math.min(bounds.y, view.y),
        }
      : view;

    const pad = 6;
    const scale = Math.min((W - pad * 2) / Math.max(bounds.w, 1),
                           (H - pad * 2) / Math.max(bounds.h, 1));
    this._bounds = bounds;
    this._scale = scale;
    this._pad = pad;

    const px = bx => (bx - bounds.x) * scale + pad;
    const py = by => (by - bounds.y) * scale + pad;

    // connections
    ctx.strokeStyle = 'rgba(120,130,150,.5)';
    ctx.lineWidth = 1;
    for (const c of this.app.store.connections) {
      const a = this.app.connections?.endpointOf(c, 'from');
      const b = this.app.connections?.endpointOf(c, 'to');
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(px(a.x), py(a.y));
      ctx.lineTo(px(b.x), py(b.y));
      ctx.stroke();
    }

    // elements
    for (const el of this.app.store.elements) {
      ctx.fillStyle = el.style?.backgroundColor || '#b9c4dd';
      ctx.globalAlpha = 0.9;
      ctx.fillRect(px(el.x), py(el.y),
        Math.max(el.width * scale, 1.5), Math.max(el.height * scale, 1.5));
    }
    ctx.globalAlpha = 1;

    // strokes
    ctx.strokeStyle = 'rgba(60,60,80,.55)';
    for (const s of this.app.store.strokes) {
      const b = s.bbox;
      if (!b) continue;
      ctx.strokeRect(px(b.x), py(b.y), Math.max(b.w * scale, 1), Math.max(b.h * scale, 1));
    }

    // viewport indicator
    ctx.strokeStyle = '#4262ff';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(66,98,255,.10)';
    const vx = px(view.x), vy = py(view.y);
    const vw = view.w * scale, vh = view.h * scale;
    ctx.fillRect(vx, vy, vw, vh);
    ctx.strokeRect(vx, vy, vw, vh);
  }
}

window.Viewport = Viewport;
window.InkLayer = InkLayer;
window.Minimap = Minimap;
window.SVG_EXTENT = SVG_EXTENT;
window.MIN_SCALE = MIN_SCALE;
window.MAX_SCALE = MAX_SCALE;
