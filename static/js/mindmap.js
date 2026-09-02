/* ================================================================
   mindmap.js — balanced tidy-tree mind mapping
   ================================================================
   What was broken before:
     · Child nodes painted a saturated branch colour behind hardcoded
       dark text, so labels were unreadable.
     · Collapsing set style.display='none' directly on the DOM — any
       re-render silently un-collapsed the branch.
     · Links were bespoke SVG that undo/redo and save never restored.
     · Deleting a node with the Delete key skipped this manager entirely
       and left dangling children plus orphan links.
     · Nodes were a fixed 140px wide, so any real topic overflowed.
     · Layout only ever grew to the right and never balanced.

   Now: links are real store connections (so history/save/export cover
   them), nodes measure themselves from their text, the tree is laid out
   with a proper tidy algorithm and balances left/right around the root.
   ================================================================ */

const MM_BRANCH_COLORS = [
  '#4262ff', '#00b894', '#e74c3c', '#f39c12',
  '#9b59b6', '#00a8b5', '#e8618c', '#3b8beb',
];

class MindMapManager {
  constructor(app) {
    this.app = app;
    this.store = app.store;

    this.H_GAP = 64;      // horizontal gap between a node and its children
    this.V_GAP = 14;      // vertical gap between siblings
    this.MIN_W = 96;
    this.MAX_W = 300;

    this._measure = document.createElement('div');
    this._measure.className = 'mm-measure';
    document.body.appendChild(this._measure);
  }

  /* ---- tree queries ------------------------------------------------ */

  childrenOf(id) {
    const el = this.store.get(id);
    if (!el || !el.mmChildren) return [];
    return el.mmChildren.map(cid => this.store.get(cid)).filter(Boolean);
  }

  rootOf(id) {
    let cur = this.store.get(id);
    const seen = new Set();
    while (cur && cur.mmParent && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = this.store.get(cur.mmParent);
      if (!parent) break;
      cur = parent;
    }
    return cur ? cur.id : id;
  }

  descendantIds(id) {
    const out = [];
    const walk = nid => {
      const el = this.store.get(nid);
      if (!el || !el.mmChildren) return;
      for (const cid of el.mmChildren) { out.push(cid); walk(cid); }
    };
    walk(id);
    return out;
  }

  countDescendants(id) { return this.descendantIds(id).length; }

  /* ---- creation ----------------------------------------------------- */

  createRoot(x, y, text = 'Central idea') {
    const el = this.store.addElement('mindmap', {
      x, y,
      content: text,
      mmRoot: true,
      mmParent: null,
      mmChildren: [],
      mmCollapsed: false,
      mmSide: 'root',
      style: { backgroundColor: '#4262ff', fontSize: 16 },
    }, { silent: true });
    this.measureNode(el.id);
    this.store.transact('add mind map', () => {});
    return el;
  }

  /** `focus` is opt-out so bulk/template creation doesn't fight for the caret. */
  addChild(parentId, text = '', { focus = true } = {}) {
    const parent = this.store.get(parentId);
    if (!parent) return null;

    return this.store.transact('add topic', () => {
      if (!parent.mmChildren) parent.mmChildren = [];
      if (parent.mmCollapsed) parent.mmCollapsed = false;

      // Root children alternate sides to keep the map balanced.
      let side;
      if (parent.mmRoot) {
        const right = parent.mmChildren.filter(cid => this.store.get(cid)?.mmSide === 'right').length;
        const left = parent.mmChildren.length - right;
        side = right <= left ? 'right' : 'left';
      } else {
        side = parent.mmSide || 'right';
      }

      const branchColor = parent.mmRoot
        ? MM_BRANCH_COLORS[parent.mmChildren.length % MM_BRANCH_COLORS.length]
        : (parent.style?.branchColor || MM_BRANCH_COLORS[0]);

      const depth = (parent.mmDepth || 0) + 1;
      // Deeper levels get progressively lighter so hierarchy reads at a glance.
      const bg = depth === 1 ? branchColor : Util.shade(branchColor, Math.min(0.13 * (depth - 1), 0.42));

      const child = this.store.addElement('mindmap', {
        x: parent.x + (side === 'right' ? parent.width + this.H_GAP : -this.H_GAP - 150),
        y: parent.y,
        content: text,
        mmRoot: false,
        mmParent: parentId,
        mmChildren: [],
        mmCollapsed: false,
        mmSide: side,
        mmDepth: depth,
        style: { backgroundColor: bg, branchColor, fontSize: depth === 1 ? 14 : 13 },
      }, { silent: true });

      parent.mmChildren.push(child.id);
      this.store.emit('element:update', parent);

      this.store.addConnection({
        from: { id: parentId, port: side === 'right' ? 'right' : 'left' },
        to:   { id: child.id, port: side === 'right' ? 'left' : 'right' },
        routing: 'curved',
        arrowEnd: false,
        mm: true,
        style: { color: branchColor, width: Math.max(3.5 - depth * 0.6, 1.6) },
      }, { silent: true });

      this.measureNode(child.id);
      this.layoutTreeOf(parentId);

      if (focus) {
        requestAnimationFrame(() => {
          const label = this.app.renderer.node(child.id)?.querySelector('.editable');
          if (label) this.app.renderer.beginEdit(child.id, label);
        });
      }

      return child;
    });
  }

  addSibling(nodeId) {
    const el = this.store.get(nodeId);
    if (!el) return null;
    if (!el.mmParent) return this.addChild(nodeId);   // root has no siblings
    return this.addChild(el.mmParent);
  }

  /** Remove a node and everything under it, links included. */
  deleteSubtree(nodeId) {
    const el = this.store.get(nodeId);
    if (!el) return;
    const parentId = el.mmParent;
    this.store.transact('delete topic', () => {
      const ids = [nodeId, ...this.descendantIds(nodeId)];
      this.store.removeElements(ids, { silent: true });   // also drops the links
      if (parentId) {
        const parent = this.store.get(parentId);
        if (parent) this.store.emit('element:update', parent);
        this.layoutTreeOf(parentId);
      }
    });
  }

  toggleCollapse(nodeId) {
    const el = this.store.get(nodeId);
    if (!el) return;
    this.store.transact(el.mmCollapsed ? 'expand' : 'collapse', () => {
      el.mmCollapsed = !el.mmCollapsed;
      this._applyVisibility(this.rootOf(nodeId));
      this.store.emit('element:update', el);
      this.layoutTreeOf(nodeId);
    });
  }

  /**
   * Collapsed state is stored on the elements themselves (`hidden`), so a
   * re-render can never lose it — unlike the old direct display:none hack.
   */
  _applyVisibility(rootId) {
    const walk = (id, visible) => {
      const el = this.store.get(id);
      if (!el) return;
      const wasHidden = !!el.hidden;
      el.hidden = !visible;
      if (wasHidden !== !!el.hidden) this.app.renderer.place(el);
      const childrenVisible = visible && !el.mmCollapsed;
      for (const cid of (el.mmChildren || [])) walk(cid, childrenVisible);
    };
    const root = this.store.get(rootId);
    if (!root) return;
    root.hidden = false;
    for (const cid of (root.mmChildren || [])) walk(cid, !root.mmCollapsed);

    // Hide links whose child end is hidden.
    for (const c of this.store.connections) {
      if (!c.mm) continue;
      const child = this.store.get(c.to?.id);
      const g = this.app.connections.groups.get(c.id);
      if (g) g.style.display = (child && child.hidden) ? 'none' : '';
    }
  }

  /* ---- measuring ------------------------------------------------------ */

  /** Size a node to its own text so long topics stop overflowing. */
  measureNode(id) {
    const el = this.store.get(id);
    if (!el || el.type !== 'mindmap') return;
    const fs = el.style?.fontSize || (el.mmRoot ? 16 : 14);
    this._measure.style.fontSize = fs + 'px';
    this._measure.style.fontWeight = el.mmRoot ? '700' : '600';
    this._measure.style.maxWidth = this.MAX_W + 'px';
    this._measure.textContent = el.content || 'Topic';

    const w = Util.clamp(Math.ceil(this._measure.offsetWidth) + (el.mmRoot ? 56 : 48), this.MIN_W, this.MAX_W + 60);
    const h = Math.max(el.mmRoot ? 48 : 40, Math.ceil(this._measure.offsetHeight) + 20);
    el.width = w;
    el.height = h;
    this.app.renderer.place(el);
  }

  /* ---- layout ----------------------------------------------------------- */

  layoutTreeOf(anyNodeId) {
    const rootId = this.rootOf(anyNodeId);
    this.layout(rootId);
  }

  /**
   * Tidy tree layout. Each subtree reserves exactly as much vertical space
   * as it needs, so siblings never overlap however deep the map gets.
   */
  layout(rootId) {
    const root = this.store.get(rootId);
    if (!root || root.type !== 'mindmap') return;

    this._applyVisibility(rootId);

    const heights = new Map();
    const measureSubtree = id => {
      const el = this.store.get(id);
      if (!el) return 0;
      const own = el.height || 40;
      const kids = (el.mmCollapsed ? [] : (el.mmChildren || []))
        .map(cid => this.store.get(cid)).filter(Boolean);
      if (!kids.length) { heights.set(id, own); return own; }
      let total = 0;
      kids.forEach((k, i) => {
        total += measureSubtree(k.id);
        if (i > 0) total += this.V_GAP;
      });
      const h = Math.max(total, own);
      heights.set(id, h);
      return h;
    };

    // A node the user has manually dragged (`mmPinned`) keeps its own x/y
    // forever instead of being overwritten by every future layout pass —
    // that overwrite (on every add/collapse/rename anywhere in the tree)
    // was why the whole map used to "reshrink" back to its old shape.
    // Its children still flow from wherever it actually is.
    const place = (id, anchorX, centerY, side) => {
      const el = this.store.get(id);
      if (!el) return;
      let effSide = side;
      if (el.mmPinned) {
        effSide = el.mmSide === 'left' ? 'left' : 'right';
      } else {
        el.x = side === 'left' ? anchorX - el.width : anchorX;
        el.y = centerY - el.height / 2;
        el.mmSide = el.mmRoot ? 'root' : side;
      }
      this.app.renderer.place(el);

      if (el.mmCollapsed) return;
      const kids = (el.mmChildren || []).map(cid => this.store.get(cid)).filter(Boolean);
      if (!kids.length) return;

      const nodeCenterY = el.y + el.height / 2;
      const childAnchor = effSide === 'left'
        ? el.x - this.H_GAP
        : el.x + el.width + this.H_GAP;

      let total = 0;
      kids.forEach((k, i) => { total += heights.get(k.id) || 40; if (i > 0) total += this.V_GAP; });
      let cursor = nodeCenterY - total / 2;
      for (const k of kids) {
        const kh = heights.get(k.id) || 40;
        place(k.id, childAnchor, cursor + kh / 2, effSide);
        cursor += kh + this.V_GAP;
      }
    };

    // Split root children into two balanced columns.
    const rootKids = (root.mmChildren || []).map(cid => this.store.get(cid)).filter(Boolean);
    for (const k of rootKids) measureSubtree(k.id);

    const rightKids = rootKids.filter(k => k.mmSide !== 'left');
    const leftKids  = rootKids.filter(k => k.mmSide === 'left');

    const centerY = root.y + root.height / 2;
    this.app.renderer.place(root);

    const runSide = (kids, side) => {
      if (!kids.length) return;
      let total = 0;
      kids.forEach((k, i) => { total += heights.get(k.id) || 40; if (i > 0) total += this.V_GAP; });
      let cursor = centerY - total / 2;
      const anchor = side === 'left' ? root.x - this.H_GAP : root.x + root.width + this.H_GAP;
      for (const k of kids) {
        const kh = heights.get(k.id) || 40;
        place(k.id, anchor, cursor + kh / 2, side);
        cursor += kh + this.V_GAP;
      }
    };

    if (!root.mmCollapsed) { runSide(rightKids, 'right'); runSide(leftKids, 'left'); }

    this.syncLinks(rootId);
    this.store.touch();
  }

  /** Keep every link's ports on the correct side after a re-layout. */
  syncLinks(rootId) {
    const ids = new Set([rootId, ...this.descendantIds(rootId)]);
    for (const c of this.store.connections) {
      if (!c.mm) continue;
      if (!ids.has(c.from?.id) && !ids.has(c.to?.id)) continue;
      const child = this.store.get(c.to?.id);
      if (!child) continue;
      const side = child.mmSide === 'left' ? 'left' : 'right';
      c.from.port = side === 'right' ? 'right' : 'left';
      c.to.port   = side === 'right' ? 'left' : 'right';
      this.app.connections.render(c);
    }
  }

  /** Re-layout every mind map on the board (used after load). */
  layoutAll() {
    const roots = this.store.elements.filter(e => e.type === 'mindmap' && !e.mmParent);
    for (const r of roots) {
      for (const id of [r.id, ...this.descendantIds(r.id)]) this.measureNode(id);
      this.layout(r.id);
    }
  }

  /**
   * Repairs mind maps loaded from the legacy format, where links were kept
   * outside the board data and were therefore lost on save.
   */
  repairLegacy() {
    const nodes = this.store.elements.filter(e => e.type === 'mindmap');
    if (!nodes.length) return;
    let created = 0;
    for (const node of nodes) {
      if (!node.mmParent) continue;
      const exists = this.store.connections.some(
        c => c.mm && c.from?.id === node.mmParent && c.to?.id === node.id
      );
      if (exists) continue;
      const branchColor = node.style?.branchColor || node.style?.backgroundColor || MM_BRANCH_COLORS[0];
      this.store.addConnection({
        from: { id: node.mmParent, port: 'right' },
        to:   { id: node.id, port: 'left' },
        routing: 'curved', arrowEnd: false, mm: true,
        style: { color: branchColor, width: 2.6 },
      }, { silent: true });
      created++;
    }
    if (created) this.app.connections.renderAll();
  }
}

window.MindMapManager = MindMapManager;
window.MM_BRANCH_COLORS = MM_BRANCH_COLORS;
