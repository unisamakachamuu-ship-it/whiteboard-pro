/* ================================================================
   core.js — utilities, event bus and the central Store
   ================================================================
   The Store owns ALL board data. Nothing else mutates it directly
   without going through commit()/transact(), which is what makes
   undo/redo and autosave reliable.
   ================================================================ */

/* How far from the origin a board coordinate may legitimately sit. Matches
   SVG_EXTENT in viewport.js — the connection layer cannot draw past it, so
   anything beyond this is unreachable rather than merely far away. */
const BOARD_LIMIT = 100000;

/* ----------------------------------------------------------------
   Util
   ---------------------------------------------------------------- */
const Util = {
  uid(prefix = 'id') {
    return prefix + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  },

  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },

  /** A finite number, or `fallback` for NaN/Infinity/null/garbage. */
  num(v, fallback = 0) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  },

  /** Median of a numeric array. Used instead of the mean wherever a single
      runaway coordinate must not be allowed to drag the answer with it. */
  median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },

  escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  clone(obj) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(obj); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(obj));
  },

  /* Axis-aligned rect helpers -------------------------------------- */
  rect(x, y, w, h) { return { x, y, w, h }; },

  rectsIntersect(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x ||
             a.y + a.h < b.y || b.y + b.h < a.y);
  },

  rectContains(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
           inner.x + inner.w <= outer.x + outer.w &&
           inner.y + inner.h <= outer.y + outer.h;
  },

  pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  },

  /* Bounding box of a list of {x,y,width,height} elements */
  boundsOf(items) {
    if (!items.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
      const w = it.width || 0, h = it.height || 0;
      minX = Math.min(minX, it.x);
      minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + w);
      maxY = Math.max(maxY, it.y + h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },

  /* Rotate a point around a centre (degrees) */
  rotatePoint(px, py, cx, cy, deg) {
    if (!deg) return { x: px, y: py };
    const r = deg * Math.PI / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    const dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  },

  /* Colour helpers -------------------------------------------------- */
  hexToRgb(hex) {
    if (!hex) return { r: 0, g: 0, b: 0 };
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  },

  /* Relative luminance (sRGB, WCAG), 0 (black) .. 1 (white). */
  relativeLuminance(hex) {
    const { r, g, b } = Util.hexToRgb(hex);
    const lin = c => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  },

  /* Returns '#fff' or '#111' — whichever is readable on `bg` */
  readableText(bg) {
    if (!bg || bg === 'transparent') return '#16161d';
    return Util.relativeLuminance(bg) > 0.45 ? '#16161d' : '#ffffff';
  },

  shade(hex, amount) {
    const { r, g, b } = Util.hexToRgb(hex);
    const f = v => Util.clamp(Math.round(v + amount * 255), 0, 255)
      .toString(16).padStart(2, '0');
    return '#' + f(r) + f(g) + f(b);
  },

  /**
   * A text/stroke colour the user explicitly chose against a light canvas
   * (e.g. navy on transparent) can go illegible once the canvas itself
   * turns dark — but only when there's no element background of its own
   * anchoring the contrast; an opaque sticky note or shape fill already
   * guarantees readability regardless of canvas theme, so this is a no-op
   * for those. Lightens toward white rather than inverting hue, so a
   * stored colour still reads as itself, just adapted — and since this
   * never touches stored data, switching back to light restores it exactly.
   */
  themedColor(storedColor, bgColor, isDark) {
    if (!storedColor || !isDark) return storedColor;
    if (bgColor && bgColor !== 'transparent') return storedColor;
    if (Util.relativeLuminance(storedColor) >= 0.35) return storedColor;
    return Util.shade(storedColor, 0.55);
  },

  /* Timing ---------------------------------------------------------- */
  debounce(fn, ms) {
    let t = null;
    const wrapped = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
    return wrapped;
  },

  /**
   * At most one call per `ms`, leading edge, with the final call always
   * delivered. Unlike rafThrottle (up to 60/s) this is for work whose cost
   * is per-call rather than per-frame — a network write, say, where 60/s is
   * both wasteful and slower than 14/s because the writes queue behind
   * each other.
   */
  throttle(fn, ms) {
    let last = 0, timer = null, lastArgs = null;
    const run = () => { last = Date.now(); timer = null; fn(...lastArgs); };
    const wrapped = (...args) => {
      lastArgs = args;
      const wait = ms - (Date.now() - last);
      if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null; } run(); }
      else if (!timer) timer = setTimeout(run, wait);
    };
    wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
    return wrapped;
  },

  /* Coalesces calls into one per animation frame. */
  rafThrottle(fn) {
    let id = null, lastArgs = null;
    const wrapped = (...args) => {
      lastArgs = args;
      if (id !== null) return;
      id = requestAnimationFrame(() => { id = null; fn(...lastArgs); });
    };
    wrapped.cancel = () => { if (id !== null) cancelAnimationFrame(id); id = null; };
    /* Cancels any pending frame and runs fn immediately with the given (or last-queued) args,
       so a gesture-end handler can commit the true final state instead of losing an in-flight frame. */
    wrapped.flush = (...args) => {
      const useArgs = args.length ? args : lastArgs;
      if (id !== null) { cancelAnimationFrame(id); id = null; }
      if (useArgs) fn(...useArgs);
    };
    return wrapped;
  },

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  safeName(s) {
    return String(s || 'board').replace(/[^a-z0-9_\- ]/gi, '').trim().replace(/\s+/g, '_') || 'board';
  },
};

/* ----------------------------------------------------------------
   Tiny event emitter
   ---------------------------------------------------------------- */
class Emitter {
  constructor() { this._handlers = new Map(); }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const set = this._handlers.get(event);
    if (set) set.delete(fn);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); }
      catch (err) { console.error(`[emitter] handler for "${event}" threw`, err); }
    }
  }
}

/* ----------------------------------------------------------------
   Element defaults per type
   ---------------------------------------------------------------- */
const ELEMENT_DEFAULTS = {
  'sticky-note': { width: 200, height: 200, style: { backgroundColor: '#ffe66d', fontSize: 15, fontFamily: 'Inter', align: 'left' } },
  'text':        { width: 220, height: 44,  style: { fontSize: 20, color: '#16161d', fontFamily: 'Inter', align: 'left' } },
  'shape':       { width: 160, height: 160, shapeType: 'rectangle', style: { backgroundColor: '#dbe4ff', borderColor: '#4262ff', borderWidth: 2, fontSize: 14 } },
  'image':       { width: 320, height: 220 },
  'frame':       { width: 640, height: 420, content: 'Frame' },
  'flowchart':   { width: 170, height: 74, fcType: 'process', style: { backgroundColor: '#ffffff', borderColor: '#16161d', borderWidth: 2, fontSize: 14 } },
  'mindmap':     { width: 150, height: 44, style: { backgroundColor: '#4262ff' } },
  'graph':       { width: 420, height: 300, graphType: 'bar' },
  'algorithm':   { width: 380, height: 220, algoTheme: 'dark' },
  'table':       { width: 480, height: 220, tableTheme: 'clean-slate', tableData: { rows: 3, cols: 3, cells: [['Item / Name', 'Category', 'Status / Value'], ['Project Alpha', 'Design', 'In Progress'], ['Project Beta', 'Engineering', 'Completed']] } },
  'checklist':   { width: 280, height: 200, style: { backgroundColor: '#ffffff' } },
  'code':        { width: 420, height: 240 },
  'comment':     { width: 240, height: 120, style: { backgroundColor: '#fff2b8' } },
  'embed':       { width: 480, height: 300 },

  /* ---- live blocks -------------------------------------------------
     These three render themselves and keep their own internal state, so
     they are bigger by default than a note: a code cell that opens too
     small to show its own output, or a circuit with no room to place a
     second gate, reads as broken rather than as needing a drag.
     ------------------------------------------------------------------ */
  'code-cell':   { width: 560, height: 340, language: 'python', content: '', outputs: [], runCount: 0 },
  'logic-lab':   { width: 720, height: 460 },
  'sheet-dash':  { width: 820, height: 540, refreshSec: 60 },
  'gcal':        { width: 640, height: 480, view: 'agenda', days: 14, refreshSec: 120 },
};

/* Minimum sizes below which a live block cannot show its own controls. */
const MIN_SIZE = {
  'code-cell':  { width: 320, height: 160 },
  'logic-lab':  { width: 380, height: 260 },
  'sheet-dash': { width: 420, height: 300 },
  'gcal':       { width: 380, height: 280 },
};

const TABLE_THEMES = [
  { id: 'clean-slate', name: 'Clean Slate', color: '#0f172a', bg: '#f8fafc', badge: '#3b82f6' },
  { id: 'royal-indigo', name: 'Royal Indigo', color: '#1e1b4b', bg: '#e0e7ff', badge: '#6366f1' },
  { id: 'emerald-pro', name: 'Emerald Pro', color: '#064e3b', bg: '#d1fae5', badge: '#10b981' },
  { id: 'ocean-breeze', name: 'Ocean Breeze', color: '#164e63', bg: '#cffafe', badge: '#06b6d4' },
  { id: 'sunset-coral', name: 'Sunset Coral', color: '#881337', bg: '#ffe4e6', badge: '#f43f5e' },
  { id: 'midnight-dark', name: 'Midnight Dark', color: '#09090b', bg: '#18181b', badge: '#a855f7' },
  { id: 'cyber-neon', name: 'Cyber Neon', color: '#030712', bg: '#0f172a', badge: '#38bdf8' },
  { id: 'minimalist-mono', name: 'Minimalist Mono', color: '#000000', bg: '#f5f5f5', badge: '#000000' },
  { id: 'warm-amber', name: 'Warm Amber', color: '#78350f', bg: '#fef3c7', badge: '#f59e0b' },
  { id: 'purple-haze', name: 'Purple Haze', color: '#581c87', bg: '#f3e8ff', badge: '#a855f7' },
  { id: 'nordic-frost', name: 'Nordic Frost', color: '#1e293b', bg: '#f0f9ff', badge: '#0284c7' },
  { id: 'crimson-executive', name: 'Crimson Executive', color: '#450a0a', bg: '#fee2e2', badge: '#dc2626' },
  { id: 'coffee-latte', name: 'Coffee Latte', color: '#3e2723', bg: '#efebe9', badge: '#795548' },
  { id: 'mint-fresh', name: 'Mint Fresh', color: '#14532d', bg: '#dcfce7', badge: '#22c55e' },
  { id: 'electric-blue', name: 'Electric Blue', color: '#1d4ed8', bg: '#eff6ff', badge: '#2563eb' },
  { id: 'charcoal-luxury', name: 'Charcoal & Gold', color: '#1c1917', bg: '#292524', badge: '#eab308' },
  { id: 'cherry-blossom', name: 'Cherry Blossom', color: '#831843', bg: '#fce7f3', badge: '#ec4899' },
  { id: 'vintage-paper', name: 'Vintage Paper', color: '#334155', bg: '#fef9c3', badge: '#d97706' },
  { id: 'matrix-terminal', name: 'Matrix Terminal', color: '#052e16', bg: '#022c22', badge: '#4ade80' },
  { id: 'glass-frosted', name: 'Glass Frosted', color: '#334155', bg: 'rgba(255,255,255,0.7)', badge: '#4262ff' },
];

/* Types whose height is driven by their content, not the user. */
const AUTO_HEIGHT_TYPES = new Set(['text', 'mindmap']);

/* ----------------------------------------------------------------
   Retyping an existing element
   ----------------------------------------------------------------
   These types are all "a box with a label": they hold the same
   content, size the same way and connect the same way, so one can
   become another after the fact without losing anything. Types with
   their own data model (table, chart, algorithm, code, image, embed)
   are deliberately excluded — there is nothing sensible to convert
   their contents into.
   ---------------------------------------------------------------- */
const CONVERTIBLE_TYPES = new Set(['sticky-note', 'text', 'shape', 'flowchart', 'comment']);

const CONVERT_TARGETS = [
  ['sticky-note', 'Sticky', '<i class="ph ph-note"></i>'],
  ['shape',       'Shape',  '<i class="ph ph-square"></i>'],
  ['flowchart',   'Node',   '<i class="ph ph-flow-arrow"></i>'],
  ['text',        'Text',   '<i class="ph ph-text-t"></i>'],
  ['comment',     'Comment','<i class="ph ph-chat-circle"></i>'],
];

/* ----------------------------------------------------------------
   Store — single source of truth
   ---------------------------------------------------------------- */
class Store extends Emitter {
  constructor() {
    super();

    this.state = {
      id: null,
      name: 'Untitled Board',
      projectId: null,
      elements: [],
      connections: [],
      strokes: [],
    };

    /** @type {Set<string>} ids of selected elements */
    this.selection = new Set();
    /** @type {Set<string>} ids of selected connections */
    this.connSelection = new Set();

    this._index = new Map();        // id -> element (kept in sync)
    this._connIndex = new Map();    // id -> connection

    this._history = [];
    this._hIndex = -1;
    this._maxHistory = 80;
    this._txDepth = 0;
    this._txDirty = false;
    this._maxZ = 0;

    this.pushHistory('init');
  }

  /* ---- indexing ------------------------------------------------- */

  reindex() {
    this._index.clear();
    this._connIndex.clear();
    this._maxZ = 0;
    for (const el of this.state.elements) {
      this._index.set(el.id, el);
      if ((el.zIndex || 0) > this._maxZ) this._maxZ = el.zIndex || 0;
    }
    for (const c of this.state.connections) this._connIndex.set(c.id, c);
  }

  get(id) { return this._index.get(id) || null; }
  getConnection(id) { return this._connIndex.get(id) || null; }
  get elements() { return this.state.elements; }
  get connections() { return this.state.connections; }
  get strokes() { return this.state.strokes; }

  nextZ() { return ++this._maxZ; }

  selected() {
    const out = [];
    for (const id of this.selection) {
      const el = this._index.get(id);
      if (el) out.push(el);
    }
    return out;
  }

  /* ---- transactions --------------------------------------------- */

  /**
   * Run `fn`, then push exactly one history entry and emit one change.
   * Nesting is safe — only the outermost transaction commits.
   */
  transact(label, fn) {
    this._txDepth++;
    let result;
    try { result = fn(); }
    finally {
      this._txDepth--;
      if (this._txDepth === 0) {
        this.pushHistory(label);
        this.emit('change', { label });
      } else {
        this._txDirty = true;
      }
    }
    return result;
  }

  /** Mark data changed without a history entry (e.g. live drag). */
  touch() { this.emit('live-change'); }

  /* ---- element CRUD ---------------------------------------------- */

  addElement(type, props = {}, opts = {}) {
    const defaults = ELEMENT_DEFAULTS[type] || {};
    const el = {
      id: Util.uid('el'),
      type,
      x: 0, y: 0,
      width: defaults.width || 160,
      height: defaults.height || 120,
      rotation: 0,
      zIndex: this.nextZ(),
      locked: false,
      content: defaults.content || '',
      ...Util.clone(defaults),
      ...props,
      style: { ...Util.clone(defaults.style || {}), ...(props.style || {}) },
    };
    // props may override width/height/id
    if (props.width != null) el.width = props.width;
    if (props.height != null) el.height = props.height;
    if (props.id) el.id = props.id;
    el.zIndex = props.zIndex != null ? props.zIndex : el.zIndex;

    // A drop point comes from screenToBoard, which divides by the camera
    // scale — at 5% zoom a click lands 20x further out than it looks, and a
    // few of those in a row run the board off into the millions. Keep every
    // new element inside the reachable range so that cannot compound.
    el.x = Util.clamp(Util.num(el.x, 0), -BOARD_LIMIT, BOARD_LIMIT);
    el.y = Util.clamp(Util.num(el.y, 0), -BOARD_LIMIT, BOARD_LIMIT);

    this.state.elements.push(el);
    this._index.set(el.id, el);
    if (el.zIndex > this._maxZ) this._maxZ = el.zIndex;

    this.emit('element:add', el);
    if (!opts.silent) this._autoCommit('add element');
    return el;
  }

  updateElement(id, props, opts = {}) {
    const el = this._index.get(id);
    if (!el) return null;
    if (props.style) {
      props = { ...props, style: { ...(el.style || {}), ...props.style } };
    }
    Object.assign(el, props);
    this.emit('element:update', el);
    if (!opts.silent) this._autoCommit('update element');
    return el;
  }

  removeElements(ids, opts = {}) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    if (!set.size) return;

    // Never leave a dangling connection behind.
    const orphanConns = this.state.connections.filter(
      c => set.has(c.from?.id) || set.has(c.to?.id)
    );
    for (const c of orphanConns) {
      this._connIndex.delete(c.id);
      this.connSelection.delete(c.id);
      this.emit('connection:remove', c);
    }
    this.state.connections = this.state.connections.filter(
      c => !set.has(c.from?.id) && !set.has(c.to?.id)
    );

    // Detach mind-map parents so no tree is left pointing at a ghost.
    for (const el of this.state.elements) {
      if (el.mmChildren && el.mmChildren.some(cid => set.has(cid))) {
        el.mmChildren = el.mmChildren.filter(cid => !set.has(cid));
        this.emit('element:update', el);
      }
      if (el.mmParent && set.has(el.mmParent)) el.mmParent = null;
    }

    this.state.elements = this.state.elements.filter(e => !set.has(e.id));
    for (const id of set) {
      this._index.delete(id);
      this.selection.delete(id);
      this.emit('element:remove', id);
    }
    if (!opts.silent) this._autoCommit('delete');
  }

  /* ---- connection CRUD ------------------------------------------- */

  addConnection(conn, opts = {}) {
    const c = {
      id: Util.uid('conn'),
      from: { id: null, port: 'auto', x: 0, y: 0 },
      to: { id: null, port: 'auto', x: 0, y: 0 },
      routing: 'orthogonal',      // 'orthogonal' | 'curved' | 'straight'
      arrowStart: false,
      arrowEnd: true,
      label: '',
      style: { color: '#16161d', width: 2, dash: null },
      ...conn,
    };
    c.style = { color: '#16161d', width: 2, dash: null, ...(conn.style || {}) };
    this.state.connections.push(c);
    this._connIndex.set(c.id, c);
    this.emit('connection:add', c);
    if (!opts.silent) this._autoCommit('connect');
    return c;
  }

  updateConnection(id, props, opts = {}) {
    const c = this._connIndex.get(id);
    if (!c) return null;
    if (props.style) props = { ...props, style: { ...c.style, ...props.style } };
    Object.assign(c, props);
    this.emit('connection:update', c);
    if (!opts.silent) this._autoCommit('edit connection');
    return c;
  }

  removeConnections(ids, opts = {}) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    this.state.connections = this.state.connections.filter(c => {
      if (!set.has(c.id)) return true;
      this._connIndex.delete(c.id);
      this.connSelection.delete(c.id);
      this.emit('connection:remove', c);
      return false;
    });
    if (!opts.silent) this._autoCommit('delete connection');
  }

  /** All connections touching a given element id. */
  connectionsFor(elementId) {
    return this.state.connections.filter(
      c => c.from?.id === elementId || c.to?.id === elementId
    );
  }

  /* ---- strokes ---------------------------------------------------- */

  addStroke(stroke, opts = {}) {
    this.state.strokes.push(stroke);
    this.emit('stroke:add', stroke);
    if (!opts.silent) this._autoCommit('draw');
    return stroke;
  }

  removeStrokes(ids, opts = {}) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    const before = this.state.strokes.length;
    this.state.strokes = this.state.strokes.filter(s => !set.has(s.id));
    if (this.state.strokes.length !== before) {
      this.emit('stroke:remove', ids);
      if (!opts.silent) this._autoCommit('erase');
    }
  }

  _autoCommit(label) {
    if (this._txDepth > 0) { this._txDirty = true; return; }
    this.pushHistory(label);
    this.emit('change', { label });
  }

  /* ---- selection --------------------------------------------------- */

  select(ids, { additive = false } = {}) {
    const list = Array.isArray(ids) ? ids : (ids == null ? [] : [ids]);
    if (!additive) { this.selection.clear(); this.connSelection.clear(); }
    for (const id of list) if (this._index.has(id)) this.selection.add(id);
    this.emit('selection', this.selection);
  }

  toggleSelect(id) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.emit('selection', this.selection);
  }

  selectConnection(id, { additive = false } = {}) {
    if (!additive) { this.selection.clear(); this.connSelection.clear(); }
    if (id) this.connSelection.add(id);
    this.emit('selection', this.selection);
  }

  toggleSelectConnection(id) {
    if (this.connSelection.has(id)) this.connSelection.delete(id);
    else this.connSelection.add(id);
    this.emit('selection', this.selection);
  }

  clearSelection() {
    if (!this.selection.size && !this.connSelection.size) return;
    this.selection.clear();
    this.connSelection.clear();
    this.emit('selection', this.selection);
  }

  selectAll() {
    this.selection = new Set(this.state.elements.filter(e => !e.locked).map(e => e.id));
    this.emit('selection', this.selection);
  }

  /* ---- history ----------------------------------------------------- */

  pushHistory(label) {
    const snapshot = JSON.stringify({
      elements: this.state.elements,
      connections: this.state.connections,
      strokes: this.state.strokes,
    });

    // Skip no-op entries so undo always moves something visible.
    const top = this._history[this._hIndex];
    if (top && top.snapshot === snapshot) return;

    this._history.length = this._hIndex + 1;
    this._history.push({ label, snapshot });

    if (this._history.length > this._maxHistory) this._history.shift();
    this._hIndex = this._history.length - 1;
    this.emit('history', this.historyInfo());
  }

  historyInfo() {
    return {
      canUndo: this._hIndex > 0,
      canRedo: this._hIndex < this._history.length - 1,
      label: this._history[this._hIndex]?.label || '',
    };
  }

  undo() {
    if (this._hIndex <= 0) return false;
    this._hIndex--;
    this._restore(this._history[this._hIndex].snapshot);
    return true;
  }

  redo() {
    if (this._hIndex >= this._history.length - 1) return false;
    this._hIndex++;
    this._restore(this._history[this._hIndex].snapshot);
    return true;
  }

  _restore(snapshot) {
    const data = JSON.parse(snapshot);
    this.state.elements = data.elements || [];
    this.state.connections = data.connections || [];
    this.state.strokes = data.strokes || [];
    this.reindex();
    // Drop selections pointing at things that no longer exist.
    this.selection = new Set([...this.selection].filter(id => this._index.has(id)));
    this.connSelection = new Set([...this.connSelection].filter(id => this._connIndex.has(id)));
    this.emit('reload');
    this.emit('selection', this.selection);
    this.emit('history', this.historyInfo());
    this.emit('change', { label: 'history' });
  }

  /* ---- serialisation ------------------------------------------------ */

  serialize() {
    return {
      version: 2,
      id: this.state.id,
      name: this.state.name,
      // Which project owns this board. Kept on the board itself so opening
      // it from a share link still knows where it belongs.
      projectId: this.state.projectId || null,
      elements: this.state.elements,
      connections: this.state.connections,
      strokes: this.state.strokes,
    };
  }

  /**
   * Accepts both the new (v2) format and the original one, so existing
   * boards on disk / in localStorage keep working.
   */
  static migrate(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const out = {
      id: raw.id || null,
      name: raw.name || 'Untitled Board',
      projectId: raw.projectId || null,
      elements: [],
      connections: [],
      strokes: [],
    };

    if (raw.version === 2) {
      out.elements = raw.elements || [];
      out.connections = raw.connections || [];
      out.strokes = raw.strokes || [];
      return Store._normalise(out);
    }

    /* ---- legacy v1 ---- */
    out.elements = (raw.elements || []).map(el => ({
      ...el,
      style: el.style || {},
      rotation: el.rotation || 0,
      locked: !!el.locked,
    }));

    // legacy free-standing lines -> connections with fixed endpoints
    for (const l of (raw.lines || [])) {
      out.connections.push({
        id: l.id || Util.uid('conn'),
        from: { id: null, port: 'free', x: l.x1, y: l.y1 },
        to: { id: null, port: 'free', x: l.x2, y: l.y2 },
        routing: 'straight',
        arrowStart: false,
        arrowEnd: l.arrow !== false,
        label: '',
        style: { color: l.style?.color || '#16161d', width: l.style?.width || 2, dash: l.style?.dash || null },
      });
    }

    // legacy flowchart connections
    for (const c of (raw.flowchartConnections || [])) {
      out.connections.push({
        id: c.id || Util.uid('conn'),
        from: { id: c.from, port: c.fromPort || 'auto', x: 0, y: 0 },
        to: { id: c.to, port: c.toPort || 'auto', x: 0, y: 0 },
        routing: 'orthogonal',
        arrowStart: false,
        arrowEnd: true,
        label: '',
        style: { color: '#16161d', width: 2, dash: null },
      });
    }

    // legacy drawings -> strokes
    for (const d of (raw.drawings || [])) {
      out.strokes.push({
        id: Util.uid('stroke'),
        points: d.points || [],
        color: d.color || '#16161d',
        width: d.width || 3,
        tool: 'pen',
      });
    }

    return Store._normalise(out);
  }

  static _normalise(data) {
    for (const el of data.elements) {
      el.style = el.style || {};
      el.rotation = el.rotation || 0;
      el.x = Util.num(el.x, 0);
      el.y = Util.num(el.y, 0);
      el.width = Util.num(el.width, 0) || ELEMENT_DEFAULTS[el.type]?.width || 160;
      el.height = Util.num(el.height, 0) || ELEMENT_DEFAULTS[el.type]?.height || 120;
      el.zIndex = el.zIndex || 1;
    }
    for (const s of data.strokes) {
      if (!s.bbox) s.bbox = Store.strokeBBox(s.points);
      if (!s.id) s.id = Util.uid('stroke');
    }
    Store.rescueStranded(data);
    return data;
  }

  /* How much empty board may sit between two things before they count as
     separate work areas rather than one drawing. */
  static CLUSTER_GAP = 20000;

  /**
   * Close up a board whose work areas have drifted astronomically apart.
   *
   * Placing an element uses `screenToBoard`, which divides the pointer offset
   * by the camera scale — so a click at 5% zoom lands ~20x further out than it
   * looks. One such drop widens the content bounds, which makes the next
   * zoom-to-fit smaller, which amplifies the next drop: coordinates run away
   * into the millions within a few rounds. Once that happens `zoomToFit` pins
   * at MIN_SCALE and parks the content thousands of screens off-camera, so the
   * canvas reads as empty and nothing can be selected or moved.
   *
   * The content is all still real work, so nothing is discarded or flattened:
   * each cluster is found by single-linkage on empty space and moved as a rigid
   * body into a compact grid, which preserves every internal layout exactly.
   * It only runs when the emptiness genuinely dwarfs the content, so a board
   * that is merely large is left exactly as the user arranged it.
   */
  static rescueStranded(data) {
    const items = [
      ...data.elements.map(e => ({ ref: e, stroke: false, x: e.x, y: e.y, w: e.width, h: e.height })),
      ...data.strokes.map(s => {
        const b = s.bbox || Store.strokeBBox(s.points);
        return { ref: s, stroke: true, x: b.x, y: b.y, w: b.w, h: b.h };
      }),
    ];
    if (items.length < 2 || items.length > 3000) return 0;

    /* ---- single-linkage clustering over empty space ---- */
    const parent = items.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const gap = Store.CLUSTER_GAP;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
        const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
        if (dx > gap || dy > gap) continue;
        const ra = find(i), rb = find(j);
        if (ra !== rb) parent[rb] = ra;
      }
    }

    const groups = new Map();
    items.forEach((it, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(it);
    });
    if (groups.size < 2) return 0;

    const box = list => Util.boundsOf(list.map(it => ({ x: it.x, y: it.y, width: it.w, height: it.h })));
    const clusters = [...groups.values()].map(g => ({ items: g, box: box(g) }));
    const full = box(items);

    /* ---- only step in when the emptiness dwarfs the content ---- */
    const PAD = 400;
    const cols = Math.ceil(Math.sqrt(clusters.length));
    const packedW = clusters.reduce((s, c) => s + c.box.w, 0) + PAD * (clusters.length - 1);
    const packedH = clusters.reduce((s, c) => Math.max(s, c.box.h), 0);
    if (Math.max(full.w, full.h) < Math.max(packedW, packedH, 1) * 8) return 0;

    /* ---- pack the clusters into a grid, each moved rigidly ---- */
    clusters.sort((a, b) => (a.box.x - b.box.x) || (a.box.y - b.box.y));
    const originX = clusters[0].box.x, originY = clusters[0].box.y;
    let cursorX = originX, cursorY = originY, rowH = 0, moved = 0;

    clusters.forEach((c, i) => {
      if (i && i % cols === 0) { cursorX = originX; cursorY += rowH + PAD; rowH = 0; }
      const dx = cursorX - c.box.x, dy = cursorY - c.box.y;
      c.shift = { dx, dy };   // c.box stays the ORIGINAL box, for the endpoint pass below
      if (dx || dy) {
        for (const it of c.items) {
          if (it.stroke) {
            for (const p of it.ref.points) { p.x += dx; p.y += dy; }
            it.ref.bbox = Store.strokeBBox(it.ref.points);
          } else {
            it.ref.meta = { ...(it.ref.meta || {}), rescuedFrom: { x: it.ref.x, y: it.ref.y } };
            it.ref.x += dx;
            it.ref.y += dy;
          }
          moved++;
        }
      }
      cursorX += c.box.w + PAD;
      rowH = Math.max(rowH, c.box.h);
    });

    // Free-floating connection endpoints are in board space too, so they have
    // to follow the cluster they were drawn in or the line points at nothing.
    for (const c of (data.connections || [])) {
      for (const end of [c.from, c.to]) {
        if (!end || end.id != null) continue;
        const owner = clusters.find(cl => end.x >= cl.box.x - gap && end.x <= cl.box.x + cl.box.w + gap &&
                                          end.y >= cl.box.y - gap && end.y <= cl.box.y + cl.box.h + gap);
        if (owner && owner.shift) { end.x += owner.shift.dx; end.y += owner.shift.dy; }
      }
    }

    if (!moved) return 0;
    console.warn(`[whiteboard] board had ${clusters.length} work areas scattered across ` +
                 `${Math.round(Math.max(full.w, full.h)).toLocaleString()} units; ` +
                 `compacted ${moved} item(s) back into view.`);
    data._rescued = moved;
    return moved;
  }

  static strokeBBox(points) {
    if (!points || !points.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  load(raw) {
    const data = Store.migrate(raw);
    if (!data) return false;
    this.lastRescued = data._rescued || 0;
    this.state.id = data.id;
    this.state.name = data.name;
    this.state.projectId = data.projectId || null;
    this.state.elements = data.elements;
    this.state.connections = data.connections;
    this.state.strokes = data.strokes;
    this.reindex();
    this.selection.clear();
    this.connSelection.clear();
    this._history = [];
    this._hIndex = -1;
    this.pushHistory('load');
    this.emit('reload');
    return true;
  }

  clear() {
    this.state.elements = [];
    this.state.connections = [];
    this.state.strokes = [];
    this.reindex();
    this.selection.clear();
    this.connSelection.clear();
    this.pushHistory('clear board');
    this.emit('reload');
    this.emit('change', { label: 'clear board' });
  }
}

window.Util = Util;
window.Emitter = Emitter;
window.Store = Store;
window.BOARD_LIMIT = BOARD_LIMIT;
window.ELEMENT_DEFAULTS = ELEMENT_DEFAULTS;
window.AUTO_HEIGHT_TYPES = AUTO_HEIGHT_TYPES;
window.MIN_SIZE = MIN_SIZE;
