/* ================================================================
   studio.js — the feature layer that sits on top of the board
   ================================================================
   Everything here is additive: each class takes the app, subscribes to
   the Store it already owns, and never reaches into another module's
   internals. Nothing in here is required for the board to render, so a
   failure in one feature cannot take the canvas down with it.

     CommandPalette  ⌘K universal search — every action, tool, board object,
                     plus PM tasks/projects and cached Keep notes/events
     ShapeRecognizer rough pen strokes snap to real shapes
     Arranger        tidy-up grid + layered auto-layout for flows
     VersionHistory  named local snapshots you can roll back to
     LiveSync        multi-tab collaboration with presence cursors
     Workshop        facilitation timer, dot voting, reactions
     Converter       turn a selection into a table / list / map / flow
     Insights        outline view + board statistics
     QuickBar        contextual toolbar that follows the selection
     BrushRing       true-size cursor for pen / highlighter / eraser
     SlideSorter     frame thumbnails while presenting
   ================================================================ */

/* ================================================================
   1. COMMAND PALETTE
   ================================================================ */
class CommandPalette {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.items = [];
    this.filtered = [];
    this.index = 0;
  }

  /* Ranks by subsequence match, preferring matches at word starts. */
  static score(query, text) {
    if (!query) return 1;
    const q = query.toLowerCase(), t = text.toLowerCase();
    const direct = t.indexOf(q);
    if (direct === 0) return 1000;
    if (direct > 0) return 700 - direct;
    let qi = 0, score = 0, prevWasSep = true;
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] === q[qi]) { score += prevWasSep ? 12 : 4; qi++; }
      prevWasSep = /[\s\-_/·]/.test(t[i]);
    }
    return qi === q.length ? score : 0;
  }

  /** Built fresh on every open so board objects are always current. */
  build() {
    const app = this.app;
    const out = [];
    const add = (group, label, icon, run, hint) => out.push({ group, label, icon, run, hint });

    for (const def of app.toolDefs) {
      if (def.sep) continue;
      add('Tools', def.label, def.icon, () => app.setTool(def.id), def.key || '');
    }

    add('Board', 'New board', '<i class="ph ph-file-plus"></i>', () => app.newBoard());
    add('Board', 'Open a saved board…', '<i class="ph ph-folder-open"></i>', () => app.library.open());
    add('Board', 'Save board', '<i class="ph ph-floppy-disk"></i>', () => app.save({ server: true }), 'Ctrl S');
    add('Board', 'Rename board…', '<i class="ph ph-textbox"></i>', async () => {
      const v = await Modal.prompt('Board name', app.store.state.name, { title: 'Rename board' });
      if (v == null) return;
      app.store.state.name = v.trim() || 'Untitled Board';
      document.getElementById('board-name').value = app.store.state.name;
      app.save({ quiet: true });
    });
    add('Board', 'Clear the board', '<i class="ph ph-trash"></i>', async () => {
      if (await Modal.confirm('Clear everything on this board? You can still undo afterwards.',
        { title: 'Clear board', confirmLabel: 'Clear' })) app.store.clear();
    });

    add('View', 'Appearance & themes…', '<i class="ph ph-palette"></i>', () => app.theme.openPicker());
    add('View', 'Toggle dark / light', '<i class="ph ph-moon-stars"></i>', () => app.theme.toggle());
    add('View', 'Zoom to fit', '<i class="ph ph-corners-out"></i>', () => app.viewport.zoomToFit(), 'Ctrl 1');
    add('View', 'Zoom to selection', '<i class="ph ph-crosshair-simple"></i>', () => app.viewport.zoomToSelection(), 'Ctrl 2');
    add('View', 'Reset zoom to 100%', '<i class="ph ph-magnifying-glass"></i>', () => app.viewport.zoomTo(1), 'Ctrl 0');
    add('View', 'Toggle grid', '<i class="ph ph-grid-four"></i>', () => document.getElementById('grid-btn').click());
    add('View', 'Toggle grid snapping', '<i class="ph ph-magnet"></i>', () => document.getElementById('snap-btn').click());
    add('View', 'Focus mode (hide all chrome)', '<i class="ph ph-arrows-in"></i>', () => app.studio.toggleFocus(), 'F11');
    add('View', 'Present frames as slides', '<i class="ph ph-projector-screen"></i>', () => app.togglePresent());
    add('View', 'Layers panel', '<i class="ph ph-stack"></i>', () => document.getElementById('layers-btn').click());

    add('Arrange', 'Tidy up into a grid', '<i class="ph ph-grid-nine"></i>', () => app.arranger.tidy(), 'Ctrl ⇧ U');
    add('Arrange', 'Auto-layout connected flow', '<i class="ph ph-tree-structure"></i>', () => app.arranger.autoLayoutFlow(), 'Ctrl ⇧ L');
    add('Arrange', 'Pack selection tightly', '<i class="ph ph-arrows-in-cardinal"></i>', () => app.arranger.pack());
    add('Arrange', 'Match width of selection', '<i class="ph ph-arrows-out-line-horizontal"></i>', () => app.arranger.matchSize('w'));
    add('Arrange', 'Match height of selection', '<i class="ph ph-arrows-out-line-vertical"></i>', () => app.arranger.matchSize('h'));
    add('Arrange', 'Group selection', '<i class="ph ph-selection-plus"></i>', () => app.group(), 'Ctrl G');
    add('Arrange', 'Ungroup selection', '<i class="ph ph-selection-slash"></i>', () => app.ungroup(), 'Ctrl ⇧ G');
    add('Arrange', 'Wrap selection in a frame', '<i class="ph ph-bounding-box"></i>', () => app.converter.wrapInFrame());

    add('Transform', 'Selection → checklist', '<i class="ph ph-check-square"></i>', () => app.converter.toChecklist());
    add('Transform', 'Selection → table', '<i class="ph ph-table"></i>', () => app.converter.toTable());
    add('Transform', 'Selection → mind map', '<i class="ph ph-brain"></i>', () => app.converter.toMindMap());
    add('Transform', 'Selection → flowchart', '<i class="ph ph-git-branch"></i>', () => app.converter.toFlowchart());
    add('Transform', 'Selection → sticky notes', '<i class="ph ph-note"></i>', () => app.converter.toStickies());
    add('Transform', 'Split sticky into one note per line', '<i class="ph ph-scissors"></i>', () => app.converter.explode());
    add('Transform', 'Import an outline / Markdown…', '<i class="ph ph-list-dashes"></i>', () => app.converter.importOutline());

    add('Workshop', 'Start a timer…', '<i class="ph ph-timer"></i>', () => app.workshop.openTimer());
    add('Workshop', 'Toggle dot voting', '<i class="ph ph-thumbs-up"></i>', () => app.workshop.toggleVoting());
    add('Workshop', 'Clear all votes', '<i class="ph ph-eraser"></i>', () => app.workshop.clearVotes());
    add('Workshop', 'Sort selection by votes', '<i class="ph ph-sort-ascending"></i>', () => app.workshop.sortByVotes());
    add('Workshop', 'Toggle live collaboration', '<i class="ph ph-users"></i>', () => app.live.toggle());
    add('Workshop', 'Share this board…', '<i class="ph ph-user-plus"></i>', () => app.live.openShareDialog());

    add('Google', 'New calendar event…', '<i class="ph ph-calendar-plus"></i>',
      () => window.GCalComposeFromSelection?.(app));
    add('Google', 'Add a live calendar to the board', '<i class="ph ph-calendar-dots"></i>',
      () => app.setTool('gcal'));
    add('Google', 'Import from Google Keep…', '<i class="ph ph-lightbulb"></i>',
      () => app.keep?.openModal());
    add('Google', 'Sync Keep now', '<i class="ph ph-arrows-clockwise"></i>',
      async () => { await app.keepSync?.pull(); await app.keepSync?.push(); });
    add('Google', 'Send selected stickies to Keep', '<i class="ph ph-upload-simple"></i>',
      () => app.keepSync?.createFromSelection());

    add('History', 'Undo', '<i class="ph ph-arrow-u-up-left"></i>', () => app.store.undo(), 'Ctrl Z');
    add('History', 'Redo', '<i class="ph ph-arrow-u-up-right"></i>', () => app.store.redo(), 'Ctrl ⇧ Z');
    add('History', 'Save a named snapshot…', '<i class="ph ph-bookmark-simple"></i>', () => app.versions.saveNamed());
    add('History', 'Browse version history…', '<i class="ph ph-clock-counter-clockwise"></i>', () => app.versions.open());

    add('Export', 'Export…', '<i class="ph ph-download-simple"></i>', () => app.openExport(), 'Ctrl E');
    add('Export', 'Export PNG', '<i class="ph ph-image"></i>', () => app.exporter.png({ scale: 2 }));
    add('Export', 'Export SVG', '<i class="ph ph-vector-two"></i>', () => app.exporter.svg());
    add('Export', 'Export Markdown', '<i class="ph ph-file-md"></i>', () => app.exporter.markdown());
    add('Export', 'Export CSV (tables & charts)', '<i class="ph ph-file-csv"></i>', () => app.exporter.csv());
    add('Export', 'Copy board image to clipboard', '<i class="ph ph-copy"></i>', () => app.exporter.copyPNG());
    add('Export', 'Print / save as PDF', '<i class="ph ph-printer"></i>', () => app.exporter.pdf());

    add('Insight', 'Board outline…', '<i class="ph ph-list-bullets"></i>', () => app.insights.openOutline());
    add('Insight', 'Board statistics…', '<i class="ph ph-chart-donut"></i>', () => app.insights.openStats());
    add('Insight', 'Keyboard shortcuts…', '<i class="ph ph-keyboard"></i>', () => app.openShortcuts());

    for (const [key, tpl] of Object.entries(TEMPLATES)) {
      add('Templates', tpl.name, tpl.icon, () => app.applyTemplate(key), tpl.desc);
    }

    // Projects & tasks — the PM module keeps its Firestore-backed data
    // resident in memory once loaded, so this is free: no extra fetch.
    const pm = window.pmHub?.store;
    if (pm) {
      for (const p of pm.projects.values()) {
        add('Projects', p.name || 'Untitled project', '<i class="ph ph-squares-four"></i>',
          () => window.pmHub.openProject(p.id), 'Open project');
      }
      for (const t of pm.tasks.values()) {
        if (t.archived) continue;
        const proj = pm.projects.get(t.projectId);
        add('Tasks', t.title || 'Untitled task', '<i class="ph ph-check-square"></i>', () => {
          window.pmHub.openProject(t.projectId);
          window.pmHub.taskPanel.open(t.id);
        }, proj?.name || '');
      }
    }

    // Keep notes & calendar events — only what the Workspace panel already
    // has cached from being opened once; never triggers a fetch of its own.
    const gwResults = app.gwPanel?._lastResults || [];
    const keepSection = gwResults.find(r => r.sec.id === 'keep' && !r.error);
    for (const n of keepSection?.items || []) {
      add('Keep notes', n.name || 'Untitled note', keepSection.sec.icon, () => {
        app.gwPanel.open();
        app.gwPanel.searchInput.value = n.name || '';
      }, (n.content || '').replace(/\s+/g, ' ').slice(0, 40));
    }
    const calSection = gwResults.find(r => r.sec.id === 'calendar' && !r.error);
    for (const e of calSection?.items || []) {
      add('Calendar', e.name || 'Untitled event', calSection.sec.icon, () => {
        app.gwPanel.open();
        app.gwPanel.searchInput.value = e.name || '';
      }, '');
    }

    // Board objects — jump straight to anything with text on it.
    for (const el of this.app.store.elements) {
      const text = (el.content || el.graphTitle || '').trim();
      if (!text) continue;
      add('Go to', text.slice(0, 60), app._typeGlyph(el.type), () => {
        app.store.select([el.id]);
        app.viewport.zoomToFit({ x: el.x, y: el.y, w: el.width, h: el.height }, 220);
        app.showPropertiesPanel();
      }, app._typeLabel(el.type));
    }

    this.items = out;
  }

  open(prefill = '') {
    if (this.root) return;
    this.build();

    const root = document.createElement('div');
    root.className = 'cmdk';
    root.innerHTML =
      '<div class="cmdk-box">' +
      '<input class="cmdk-input" placeholder="Search commands, board objects, tasks, projects, Keep notes, calendar…" spellcheck="false" />' +
      '<div class="cmdk-list"></div>' +
      '<div class="cmdk-foot"><span>↑↓ navigate</span><span>↵ run</span><span>esc close</span></div>' +
      '</div>';
    document.body.appendChild(root);
    this.root = root;

    const input = root.querySelector('.cmdk-input');
    const list = root.querySelector('.cmdk-list');
    input.value = prefill;

    const render = () => {
      const q = input.value.trim();
      const scored = this.items
        .map(it => ({ it, s: CommandPalette.score(q, it.label + ' ' + it.group) }))
        .filter(r => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60);

      // Keep each group contiguous — ordered by its own best hit — so the
      // list reads as a few labelled blocks instead of the same headings
      // repeating every other row.
      const best = new Map();
      for (const r of scored) if (!best.has(r.it.group)) best.set(r.it.group, r.s);
      this.filtered = scored
        .sort((a, b) => (best.get(b.it.group) - best.get(a.it.group)) || (b.s - a.s))
        .map(r => r.it);

      this.index = 0;
      list.textContent = '';
      if (!this.filtered.length) {
        list.innerHTML = '<div class="cmdk-empty">Nothing matches that.</div>';
        return;
      }
      let group = null;
      this.filtered.forEach((it, i) => {
        if (it.group !== group) {
          group = it.group;
          const g = document.createElement('div');
          g.className = 'cmdk-group';
          g.textContent = group;
          list.appendChild(g);
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cmdk-item' + (i === 0 ? ' is-active' : '');
        b.dataset.i = i;
        b.innerHTML = `<span class="cmdk-ic">${it.icon || ''}</span>` +
          `<span class="cmdk-label">${Util.escapeHTML(it.label)}</span>` +
          (it.hint ? `<span class="cmdk-hint">${Util.escapeHTML(it.hint)}</span>` : '');
        b.addEventListener('click', () => this.run(i));
        b.addEventListener('pointermove', () => this.highlight(i));
        list.appendChild(b);
      });
    };

    this.highlight = i => {
      this.index = Util.clamp(i, 0, this.filtered.length - 1);
      list.querySelectorAll('.cmdk-item').forEach(n =>
        n.classList.toggle('is-active', +n.dataset.i === this.index));
      const active = list.querySelector('.cmdk-item.is-active');
      active?.scrollIntoView({ block: 'nearest' });
    };

    this.run = i => {
      const it = this.filtered[i];
      this.close();
      if (!it) return;
      try { it.run(); }
      catch (err) { console.error('[cmdk]', err); Modal.toast('That command failed.', 'warn'); }
    };

    input.addEventListener('input', render);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); this.highlight(this.index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.highlight(this.index - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.run(this.index); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    root.addEventListener('pointerdown', e => { if (e.target === root) this.close(); });

    render();
    requestAnimationFrame(() => { root.classList.add('is-open'); input.focus(); input.select(); });
  }

  close() {
    this.root?.remove();
    this.root = null;
  }

  toggle() { this.root ? this.close() : this.open(); }
}

/* ================================================================
   2. SHAPE RECOGNITION — rough strokes become real objects
   ================================================================ */
class ShapeRecognizer {
  constructor(app) { this.app = app; }

  /** Ramer–Douglas–Peucker simplification. */
  static simplify(points, tol) {
    if (points.length < 3) return points.slice();
    const sqTol = tol * tol;
    const distSq = (p, a, b) => {
      let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y;
      if (dx || dy) {
        const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) { x = b.x; y = b.y; }
        else if (t > 0) { x += dx * t; y += dy * t; }
      }
      return (p.x - x) ** 2 + (p.y - y) ** 2;
    };
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = lo + 1; i < hi; i++) {
        const d = distSq(points[i], points[lo], points[hi]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > sqTol && idx > 0) { keep[idx] = true; stack.push([lo, idx], [idx, hi]); }
    }
    return points.filter((_, i) => keep[i]);
  }

  static polygonArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    return Math.abs(a / 2);
  }

  /**
   * Returns { kind, bbox } or null. Deliberately conservative: when the
   * evidence is weak the stroke is left exactly as it was drawn.
   */
  recognize(stroke) {
    const pts = stroke.points || [];
    if (pts.length < 6) return null;

    const b = Store.strokeBBox(pts);
    const diag = Math.hypot(b.w, b.h);
    if (diag < 34) return null;

    const first = pts[0], last = pts[pts.length - 1];
    const gap = Math.hypot(last.x - first.x, last.y - first.y);
    const closed = gap < Math.max(b.w, b.h) * 0.34;

    const simple = ShapeRecognizer.simplify(pts, diag * 0.042);

    /* ---- open strokes: only straight lines / arrows are worth snapping */
    if (!closed) {
      if (simple.length > 3) return null;
      const len = Math.hypot(last.x - first.x, last.y - first.y);
      if (len < 34) return null;
      let maxDev = 0;
      for (const p of pts) {
        const t = ((p.x - first.x) * (last.x - first.x) + (p.y - first.y) * (last.y - first.y)) / (len * len);
        const px = first.x + (last.x - first.x) * t, py = first.y + (last.y - first.y) * t;
        maxDev = Math.max(maxDev, Math.hypot(p.x - px, p.y - py));
      }
      if (maxDev > len * 0.085) return null;
      return { kind: 'line', bbox: b, from: first, to: last };
    }

    /* ---- closed strokes: classify by corner count + fill ratio ------- */
    const ring = simple.slice();
    if (ring.length > 1) {
      const a = ring[0], z = ring[ring.length - 1];
      if (Math.hypot(a.x - z.x, a.y - z.y) < diag * 0.06) ring.pop();
    }
    const corners = ring.length;
    if (corners < 3) return null;

    const fill = ShapeRecognizer.polygonArea(ring) / Math.max(b.w * b.h, 1);
    const nearCorner = p =>
      (Math.abs(p.x - b.x) < b.w * 0.22 || Math.abs(p.x - (b.x + b.w)) < b.w * 0.22) &&
      (Math.abs(p.y - b.y) < b.h * 0.22 || Math.abs(p.y - (b.y + b.h)) < b.h * 0.22);

    if (corners === 3 && fill > 0.32 && fill < 0.68) return { kind: 'triangle', bbox: b };

    if (corners === 4) {
      const atCorners = ring.filter(nearCorner).length;
      if (atCorners >= 3 && fill > 0.72) return { kind: 'rectangle', bbox: b };
      if (atCorners <= 1 && fill > 0.34 && fill < 0.68) return { kind: 'diamond', bbox: b };
      if (fill > 0.72) return { kind: 'rectangle', bbox: b };
    }

    if (corners >= 5 && corners <= 7 && fill > 0.68 && fill < 0.9) return { kind: 'circle', bbox: b };
    if (corners > 7 && fill > 0.66 && fill < 0.92) return { kind: 'circle', bbox: b };
    if (corners > 4 && fill > 0.9) return { kind: 'rectangle', bbox: b };

    return null;
  }

  /** Swap a just-finished stroke for the shape it was clearly meant to be. */
  apply(stroke) {
    if (!this.app.settings.smartShapes || !stroke) return false;
    const hit = this.recognize(stroke);
    if (!hit) return false;

    const store = this.app.store;
    const s = this.app.settings;
    const b = hit.bbox;

    store.transact('smart shape', () => {
      store.removeStrokes([stroke.id], { silent: true });

      if (hit.kind === 'line') {
        store.addConnection({
          from: { id: null, port: 'free', x: hit.from.x, y: hit.from.y },
          to: { id: null, port: 'free', x: hit.to.x, y: hit.to.y },
          routing: 'straight',
          arrowStart: false,
          arrowEnd: s.connectorArrowEnd,
          style: { color: stroke.color, width: Math.max(2, stroke.width), dash: null },
        }, { silent: true });
        return;
      }

      const el = store.addElement('shape', {
        x: b.x, y: b.y, width: Math.max(24, b.w), height: Math.max(24, b.h),
        shapeType: hit.kind,
        style: { backgroundColor: 'transparent', borderColor: stroke.color, borderWidth: Math.max(2, stroke.width) },
      }, { silent: true });
      store.select([el.id]);
    });

    this.app.ink.redraw();
    Modal.toast(`Snapped to a ${hit.kind}. Ctrl+Z keeps the ink.`, 'info', 1800);
    return true;
  }
}

/* ================================================================
   3. ARRANGER — tidy up, pack, auto-layout
   ================================================================ */
class Arranger {
  constructor(app) { this.app = app; this.store = app.store; }

  _targets() {
    const sel = this.store.selected().filter(e => !e.locked && !e.hidden);
    if (sel.length >= 2) return sel;
    Modal.toast('Select two or more objects first.', 'warn', 1800);
    return null;
  }

  /** Snap the selection into an even grid, preserving reading order. */
  tidy(gap = 28) {
    const sel = this._targets();
    if (!sel) return;

    const bounds = Util.boundsOf(sel);
    // Reading order: group into rows by vertical overlap, then sort each row.
    const rowTol = Math.max(...sel.map(e => e.height)) * 0.55;
    const sorted = sel.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const rows = [];
    for (const el of sorted) {
      const row = rows.find(r => Math.abs(r.y - el.y) < rowTol);
      if (row) { row.items.push(el); row.y = Math.min(row.y, el.y); }
      else rows.push({ y: el.y, items: [el] });
    }
    for (const r of rows) r.items.sort((a, b) => a.x - b.x);

    const cols = Math.max(...rows.map(r => r.items.length));
    const colW = Math.max(...sel.map(e => e.width));
    const rowH = rows.map(r => Math.max(...r.items.map(e => e.height)));

    this.store.transact('tidy up', () => {
      let y = bounds.y;
      rows.forEach((r, ri) => {
        let x = bounds.x;
        for (const el of r.items) {
          el.x = x + (colW - el.width) / 2;
          el.y = y + (rowH[ri] - el.height) / 2;
          this.app.renderer.place(el);
          x += colW + gap;
        }
        y += rowH[ri] + gap;
      });
      this.app.connections.refreshFor(sel.map(e => e.id));
    });
    Modal.toast(`Tidied ${sel.length} objects into ${rows.length} row${rows.length > 1 ? 's' : ''}.`, 'success', 1800);
    void cols;
  }

  /** Squeeze the selection together without changing its reading order. */
  pack(gap = 16) {
    const sel = this._targets();
    if (!sel) return;
    const sorted = sel.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const b = Util.boundsOf(sel);
    this.store.transact('pack', () => {
      let y = b.y;
      for (const el of sorted) {
        el.x = b.x;
        el.y = y;
        y += el.height + gap;
        this.app.renderer.place(el);
      }
      this.app.connections.refreshFor(sel.map(e => e.id));
    });
  }

  matchSize(axis) {
    const sel = this._targets();
    if (!sel) return;
    const w = Math.max(...sel.map(e => e.width));
    const h = Math.max(...sel.map(e => e.height));
    this.store.transact('match size', () => {
      for (const el of sel) {
        if (axis !== 'h') el.width = w;
        if (axis !== 'w') el.height = h;
        this.app.renderer.patch(el);
      }
      this.app.connections.refreshFor(sel.map(e => e.id));
    });
  }

  /**
   * Layered (Sugiyama-lite) layout over whatever is connected. Layers come
   * from a longest-path pass; within a layer nodes are ordered by the mean
   * position of their parents, which removes most edge crossings.
   */
  autoLayoutFlow({ hGap = 70, vGap = 56, direction = 'vertical' } = {}) {
    const store = this.store;
    const sel = store.selected();
    const pool = (sel.length >= 2 ? sel : store.elements).filter(e => !e.locked && !e.hidden && e.type !== 'frame');
    const ids = new Set(pool.map(e => e.id));

    const edges = store.connections.filter(c => ids.has(c.from?.id) && ids.has(c.to?.id) && c.from.id !== c.to.id);
    if (!edges.length) { Modal.toast('Nothing connected to lay out — draw some connectors first.', 'warn', 2200); return; }

    const nodes = new Map();
    for (const e of pool) nodes.set(e.id, { el: e, in: [], out: [] });
    for (const c of edges) {
      nodes.get(c.from.id).out.push(c.to.id);
      nodes.get(c.to.id).in.push(c.from.id);
    }
    // Drop anything with no edges at all so loose notes are left in place.
    for (const [id, n] of [...nodes]) if (!n.in.length && !n.out.length) nodes.delete(id);
    if (!nodes.size) return;

    /* longest-path layering, cycle-safe via a visited guard */
    const layer = new Map();
    const visiting = new Set();
    const depth = id => {
      if (layer.has(id)) return layer.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const n = nodes.get(id);
      let d = 0;
      for (const p of n.in) if (nodes.has(p)) d = Math.max(d, depth(p) + 1);
      visiting.delete(id);
      layer.set(id, d);
      return d;
    };
    for (const id of nodes.keys()) depth(id);

    const byLayer = [];
    for (const [id, d] of layer) (byLayer[d] ||= []).push(id);

    // Order each layer by the average slot of its parents (barycentre).
    const slot = new Map();
    byLayer.forEach((ids2, d) => {
      if (d === 0) {
        ids2.sort((a, b) => nodes.get(a).el.x - nodes.get(b).el.x || nodes.get(a).el.y - nodes.get(b).el.y);
      } else {
        ids2.sort((a, b) => {
          const bc = id => {
            const ps = nodes.get(id).in.filter(p => slot.has(p));
            return ps.length ? ps.reduce((s, p) => s + slot.get(p), 0) / ps.length : 1e9;
          };
          return bc(a) - bc(b) || nodes.get(a).el.x - nodes.get(b).el.x;
        });
      }
      ids2.forEach((id, i) => slot.set(id, i));
    });

    const origin = Util.boundsOf([...nodes.values()].map(n => n.el));
    const vertical = direction === 'vertical';

    store.transact('auto-layout', () => {
      let cross = vertical ? origin.y : origin.x;
      for (const ids2 of byLayer) {
        if (!ids2) continue;
        const els = ids2.map(id => nodes.get(id).el);
        const span = els.reduce((s, e) => s + (vertical ? e.width : e.height), 0) +
          (els.length - 1) * (vertical ? hGap : vGap);
        let along = (vertical ? origin.x + origin.w / 2 : origin.y + origin.h / 2) - span / 2;
        const thickness = Math.max(...els.map(e => (vertical ? e.height : e.width)));
        for (const el of els) {
          if (vertical) {
            el.x = along; el.y = cross + (thickness - el.height) / 2;
            along += el.width + hGap;
          } else {
            el.y = along; el.x = cross + (thickness - el.width) / 2;
            along += el.height + vGap;
          }
          this.app.renderer.place(el);
        }
        cross += thickness + (vertical ? vGap : hGap);
      }
      // Re-point ports so the arrows follow the new flow direction.
      for (const c of edges) {
        c.from.port = vertical ? 'bottom' : 'right';
        c.to.port = vertical ? 'top' : 'left';
      }
      this.app.connections.refreshFor([...nodes.keys()]);
    });

    this.app.viewport.zoomToFit(Util.boundsOf([...nodes.values()].map(n => n.el)), 120);
    Modal.toast(`Laid out ${nodes.size} nodes across ${byLayer.filter(Boolean).length} levels.`, 'success');
  }
}

/* ================================================================
   4. VERSION HISTORY — named local snapshots
   ================================================================ */
const VERSIONS_KEY = 'wbpro.versions.v1';
const MAX_VERSIONS = 24;

class VersionHistory {
  constructor(app) {
    this.app = app;
    this._lastAuto = 0;
    this._lastHash = '';
    app.store.on('change', () => this._maybeAuto());
  }

  list() {
    try { return JSON.parse(localStorage.getItem(VERSIONS_KEY)) || []; }
    catch (_) { return []; }
  }

  _write(list) {
    // Trim oldest auto-snapshots first when storage gets tight.
    let entries = list.slice(0, MAX_VERSIONS);
    for (let attempt = 0; attempt < 6; attempt++) {
      try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(entries)); return true; }
      catch (_) {
        const i = entries.map(e => e.auto).lastIndexOf(true);
        if (i === -1) { entries.pop(); } else { entries.splice(i, 1); }
        if (!entries.length) return false;
      }
    }
    return false;
  }

  snapshot(name, auto = false) {
    const data = this.app.store.serialize();
    const entry = {
      id: Util.uid('ver'),
      name: name || new Date().toLocaleString(),
      at: Date.now(),
      auto,
      count: data.elements.length + data.connections.length + data.strokes.length,
      data,
    };
    const list = this.list();
    list.unshift(entry);
    return this._write(list) ? entry : null;
  }

  async saveNamed() {
    const v = await Modal.prompt('Name this version', 'Checkpoint ' + new Date().toLocaleTimeString(),
      { title: 'Save a snapshot' });
    if (v == null) return;
    const e = this.snapshot(v.trim() || 'Checkpoint', false);
    Modal.toast(e ? `Snapshot “${e.name}” saved.` : 'Local storage is full — export instead.', e ? 'success' : 'warn');
  }

  _maybeAuto() {
    const now = Date.now();
    if (now - this._lastAuto < 5 * 60 * 1000) return;
    const hash = this.app.store.elements.length + ':' + this.app.store.connections.length + ':' + this.app.store.strokes.length;
    if (hash === this._lastHash) return;
    this._lastAuto = now;
    this._lastHash = hash;
    this.snapshot('Auto-save', true);
  }

  restore(id) {
    const entry = this.list().find(e => e.id === id);
    if (!entry) return;
    this.snapshot('Before restore', true);
    this.app._adoptBoard(entry.data);
    Modal.toast(`Restored “${entry.name}”.`, 'success');
  }

  open() {
    const body = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'vh-list';
    body.appendChild(list);

    const render = () => {
      const versions = this.list();
      list.textContent = '';
      if (!versions.length) {
        list.innerHTML = '<p class="muted">No snapshots yet. Save one before a big change — auto-saves are taken every five minutes as you work.</p>';
        return;
      }
      for (const v of versions) {
        const row = document.createElement('div');
        row.className = 'vh-row' + (v.auto ? ' is-auto' : '');
        row.innerHTML =
          '<span class="vh-dot"></span>' +
          `<span class="vh-meta"><strong>${Util.escapeHTML(v.name)}</strong>` +
          `<small>${new Date(v.at).toLocaleString()} · ${v.count} objects${v.auto ? ' · auto' : ''}</small></span>`;

        const restore = document.createElement('button');
        restore.className = 'btn btn-ghost';
        restore.type = 'button';
        restore.textContent = 'Restore';
        restore.addEventListener('click', async () => {
          if (!await Modal.confirm(`Replace the current board with “${v.name}”? The current state is snapshotted first.`,
            { title: 'Restore version', confirmLabel: 'Restore' })) return;
          this.restore(v.id);
          handle.close();
        });
        row.appendChild(restore);

        const del = document.createElement('button');
        del.className = 'btn btn-ghost';
        del.type = 'button';
        del.innerHTML = '<i class="ph ph-trash"></i>';
        del.title = 'Delete snapshot';
        del.addEventListener('click', () => {
          this._write(this.list().filter(x => x.id !== v.id));
          render();
        });
        row.appendChild(del);

        list.appendChild(row);
      }
    };
    render();

    const handle = Modal.open({
      title: '<i class="ph ph-clock-counter-clockwise"></i> Version history',
      width: 640, body,
      actions: [
        { label: 'Save a snapshot now', onClick: () => { this.snapshot('Checkpoint ' + new Date().toLocaleTimeString()); render(); return true; } },
        { label: 'Close' },
      ],
    });
  }
}

/* ================================================================
   5. LIVE SYNC — real-time collaboration between browser tabs
   ================================================================
   BroadcastChannel gives every tab on this machine a shared bus with no
   server involved. It is opt-in because joining adopts the shared board,
   which would otherwise silently replace whatever a second tab had open.
   ================================================================ */
const PEER_COLORS = ['#4262ff', '#e8618c', '#00b894', '#f39c12', '#9b59b6', '#00a8b5', '#e74c3c', '#5a6acf'];
const PEER_NAMES = ['Otter', 'Falcon', 'Cedar', 'Comet', 'Lynx', 'Harbor', 'Ember', 'Quartz'];

/* ----------------------------------------------------------------
   FirestoreChannel — same postMessage/onmessage shape as a
   BroadcastChannel, so LiveSync's protocol (_send/_receive) doesn't
   need to know or care which transport is under it, but backed by
   Firestore so it reaches other people on other machines, not just
   other tabs on this one.

   - `state` messages write to the board document itself (the same
     one FirebaseSync.saveBoard writes), and an onSnapshot listener on
     that document delivers other peers' state pushes.
   - `cursor`/`view` messages are merged into a per-user presence doc
     under boards/{boardId}/presence/{uid} — small, frequently
     overwritten, and cheap to clean up on disconnect.
   - `hello`/`need-state` are no-ops: a fresh onSnapshot subscription
     already delivers the current board + roster immediately, so there
     is nothing to explicitly ask for.
   ---------------------------------------------------------------- */
class FirestoreChannel {
  /**
   * `peerId` (the Firebase uid) has to be the presence doc's id — the
   * security rules require `request.auth.uid == uid` on that write.
   * `sessionId` is separate and random per browser tab: two tabs signed
   * into the SAME account (laptop + phone, say) must not have their board
   * edits mistaken for an echo of each other just because they share a
   * uid, so state-echo suppression keys off sessionId, not peerId.
   */
  constructor(boardId, peerId, sessionId = Util.uid('sess')) {
    const FB = window.FB;
    if (!FB) throw new Error('Firebase is not ready yet');
    this._fb = FB;
    this.boardId = boardId;
    this.peerId = peerId;
    this.sessionId = sessionId;
    this.onmessage = null;
    this._closed = false;
    this._lastAppliedMs = 0;

    this._boardRef = FB.doc(FB.db, 'boards', boardId);
    this._presenceCol = FB.collection(FB.db, 'boards', boardId, 'presence');
    this._myPresenceRef = FB.doc(this._presenceCol, peerId);

    this._unsubState = FB.onSnapshot(this._boardRef, snap => {
      if (this._closed || !snap.exists()) return;
      const record = snap.data();
      if (record._writerSession === this.sessionId) return;
      const ms = record.updatedAt?.toMillis ? record.updatedAt.toMillis() : Date.now();
      if (ms <= this._lastAppliedMs) return;
      this._lastAppliedMs = ms;
      let data;
      try { data = typeof record.data === 'string' ? JSON.parse(record.data) : record.data; } catch (_) { return; }
      if (!data) return;
      this._deliver({ t: 'state', data, peer: { id: record._writerId || 'remote', name: record._writerName || 'Someone', color: record._writerColor || PEER_COLORS[0] } });
    }, err => console.warn('Live board listener error:', err));

    this._unsubPresence = FB.onSnapshot(this._presenceCol, snap => {
      if (this._closed) return;
      for (const ch of snap.docChanges()) {
        const id = ch.doc.id;
        if (id === this.peerId) continue;
        if (ch.type === 'removed') { this._deliver({ t: 'bye', peer: { id } }); continue; }
        const p = ch.doc.data();
        const peer = { id, name: p.name || 'Someone', color: p.color || PEER_COLORS[0] };
        if (p.x != null) this._deliver({ t: 'cursor', x: p.x, y: p.y, peer });
        if (p.view) this._deliver({ t: 'view', x: p.view.x, y: p.view.y, s: p.view.s, peer });
        // Only act on a drag frame that is actually current — a stale one
        // replayed from an old snapshot would yank elements backwards.
        if (p.live?.els?.length && Date.now() - (p.live.at || 0) < 3000) {
          this._deliver({ t: 'live', els: p.live.els, peer });
        }
      }
    }, err => console.warn('Live presence listener error:', err));
  }

  _deliver(data) { try { this.onmessage?.({ data }); } catch (e) { console.error(e); } }

  postMessage(msg) {
    if (this._closed) return;
    const FB = this._fb;
    if (msg.t === 'state') {
      FB.setDoc(this._boardRef, {
        data: JSON.stringify(msg.data),
        updatedAt: FB.serverTimestamp(),
        _writerId: this.peerId,
        _writerSession: this.sessionId,
        _writerName: msg.peer?.name || '',
        _writerColor: msg.peer?.color || '',
      }, { merge: true }).catch(err => {
        console.warn('Live state push failed:', err);
        // Firestore documents cap out at 1MiB — the one case worth telling
        // someone about, since everything else here is a silent background
        // retry-next-change anyway.
        if (String(err?.code || '').includes('invalid-argument') || /longer than/i.test(err?.message || '')) {
          Modal?.toast('This board is too large for live sync to push in one piece. Turn Live sync off and use Save instead.', 'warn', 7000);
        }
      });
      return;
    }
    if (msg.t === 'bye') {
      FB.deleteDoc(this._myPresenceRef).catch(() => {});
      return;
    }
    if (msg.t === 'hello' || msg.t === 'need-state') return;

    // Cursor / viewport / in-flight drags all ride the caller's own small
    // presence document. That keeps this high-frequency traffic off the
    // board document, where every peer would otherwise be writing to the
    // same doc at once and serialising behind each other.
    const patch = { name: msg.peer?.name || '', color: msg.peer?.color || '', seenAt: FB.serverTimestamp() };
    if (msg.t === 'cursor') { patch.x = msg.x; patch.y = msg.y; }
    if (msg.t === 'view') { patch.view = { x: msg.x, y: msg.y, s: msg.s }; }
    if (msg.t === 'live') { patch.live = { els: msg.els || [], at: Date.now() }; }
    FB.setDoc(this._myPresenceRef, patch, { merge: true }).catch(() => {});
  }

  close() {
    this._closed = true;
    this._unsubState?.();
    this._unsubPresence?.();
    this._fb.deleteDoc(this._myPresenceRef).catch(() => {});
  }
}

class LiveSync {
  constructor(app) {
    this.app = app;
    this.enabled = false;
    this.channel = null;
    this.peers = new Map();
    this.followId = null;
    this.me = null;   // assigned in start() — depends on sign-in state at that moment

    this.bar = document.createElement('div');
    this.bar.className = 'presence-bar';
    document.body.appendChild(this.bar);

    this._applying = false;
    this._pushState = Util.debounce(() => this._send({ t: 'state', data: this.app.store.serialize() }), 220);
    // Time-throttled, not per-frame: each of these is a network write, and
    // 60/s does not arrive 60/s — it queues and arrives late and bunched,
    // which is what made cursors feel laggy. ~14/s sends, smoothed back up
    // to full framerate by interpolation on the receiving side.
    this._pushCursor = Util.throttle(p => this._send({ t: 'cursor', x: p.x, y: p.y }), 70);
    this._pushLive = Util.throttle(() => this._sendLiveMoves(), 70);

    this.app.store.on('change', () => { if (!this._applying) this._pushState(); });
    // A drag emits 'live-change' on every frame and only emits 'change' when
    // it is committed on release. Listening for 'change' alone meant the
    // other side saw nothing at all during the drag and then a teleport at
    // the end — the single biggest reason this did not feel live.
    this.app.store.on('live-change', () => { if (!this._applying) this._pushLive(); });

    document.addEventListener('pointermove', e => {
      if (!this.enabled) return;
      const b = this.app.viewport.eventToBoard(e);
      this._pushCursor(b);
    }, { passive: true });

    this.app.viewport.on('applied', () => {
      this._renderCursors();
      if (this.enabled) this._send({ t: 'view', x: this.app.viewport.x, y: this.app.viewport.y, s: this.app.viewport.scale });
    });

    window.addEventListener('beforeunload', () => { if (this.enabled) this._send({ t: 'bye' }); });
    setInterval(() => this._reap(), 4000);
  }

  toggle() { this.enabled ? this.stop() : this.start(); }

  /**
   * Redraw peer cursors every frame while anyone is connected.
   *
   * The interpolation in _renderCursors only advances when something calls
   * it, and network updates arrive ~14 times a second — so without this the
   * easing would step at exactly the rate it is meant to smooth over.
   */
  _startCursorLoop() {
    if (this._cursorRaf) return;
    const step = () => {
      if (!this.enabled) { this._cursorRaf = null; return; }
      if (this.peers.size) this._renderCursors();
      this._cursorRaf = requestAnimationFrame(step);
    };
    this._cursorRaf = requestAnimationFrame(step);
  }

  _stopCursorLoop() {
    if (this._cursorRaf) cancelAnimationFrame(this._cursorRaf);
    this._cursorRaf = null;
  }

  /**
   * Stream the geometry of whatever is being dragged/resized right now.
   *
   * Deliberately small and deliberately *not* the whole board: this fires
   * many times a second during a gesture, while the full-state push is
   * debounced and only really lands on commit. Position only — the
   * authoritative copy still arrives via the normal 'state' message, so a
   * dropped live frame costs a moment of smoothness, never correctness.
   */
  _sendLiveMoves() {
    if (!this.enabled) return;
    const sel = this.app.store.selected();
    if (!sel.length || sel.length > 40) return;
    this._send({
      t: 'live',
      els: sel.map(el => ({
        id: el.id, x: Math.round(el.x), y: Math.round(el.y),
        w: Math.round(el.width), h: Math.round(el.height),
        r: el.rotation || 0,
      })),
    });
  }

  /** Apply a peer's in-flight drag — visual only, never touches history. */
  _applyLiveMoves(els) {
    if (!Array.isArray(els)) return;
    const touched = [];
    for (const m of els) {
      const el = this.app.store.get(m.id);
      if (!el || this.app.store.selection.has(m.id)) continue;   // never fight a local drag
      el.x = m.x; el.y = m.y;
      if (m.w) el.width = m.w;
      if (m.h) el.height = m.h;
      el.rotation = m.r || 0;
      this.app.renderer.place(el);
      touched.push(el.id);
    }
    if (touched.length) {
      this.app.connections.refreshFor(touched);
      this.app.overlay.sync();
    }
  }

  /** A signed-in Firebase user gets real cross-device/cross-user sync
   *  (Firestore-backed); anyone else still gets same-machine tab sync via
   *  BroadcastChannel, same as before. */
  get _fbUser() { return window.FirebaseSync?.isLoggedIn ? window.FirebaseSync.user : null; }

  start() {
    const fbUser = this._fbUser;
    this.me = fbUser
      ? {
          id: fbUser.uid,
          name: fbUser.displayName || fbUser.email || 'Someone',
          color: PEER_COLORS[[...fbUser.uid].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PEER_COLORS.length],
        }
      : {
          id: Util.uid('peer'),
          name: PEER_NAMES[Math.floor(Math.random() * PEER_NAMES.length)] + ' ' + (1 + Math.floor(Math.random() * 89)),
          color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
        };

    const boardId = this.app.store.state.id;
    if (fbUser && window.FB && boardId) {
      try {
        this.channel = new FirestoreChannel(boardId, fbUser.uid);
      } catch (err) {
        console.warn('Firestore live channel failed, falling back to same-tab sync:', err);
        this.channel = null;
      }
    }

    if (this.channel) {
      this.channel.onmessage = e => this._receive(e.data);
      this.enabled = true;
      document.getElementById('live-btn')?.classList.add('is-on');
      Modal.toast(`Live sync on — you are “${this.me.name}”. Anyone this board is shared with sees your cursor and edits in real time.`, 'success', 4200);
      this._renderBar();
      this._startCursorLoop();
      return true;
    }

    if (typeof BroadcastChannel !== 'function') {
      Modal.toast('This browser has no BroadcastChannel — live tabs are unavailable.', 'warn');
      return false;
    }
    this.channel = new BroadcastChannel('wbpro-live-v1');
    this.channel.onmessage = e => this._receive(e.data);
    this.enabled = true;
    this._send({ t: 'hello' });
    this._send({ t: 'need-state' });
    document.getElementById('live-btn')?.classList.add('is-on');
    Modal.toast(fbUser
      ? `Live tabs on — you are “${this.me.name}”. Open this board in another tab to see it sync.`
      : `Live tabs on — you are “${this.me.name}”. Sign in with Google and share this board to sync with other people, not just tabs.`,
      'success', 4200);
    this._renderBar();
    this._startCursorLoop();
    return true;
  }

  stop() {
    this._send({ t: 'bye' });
    this.channel?.close();
    this.channel = null;
    this.enabled = false;
    this._stopCursorLoop();
    this.peers.clear();
    this.followId = null;
    document.getElementById('live-btn')?.classList.remove('is-on');
    this._renderCursors();
    this._renderBar();
    Modal.toast('Live sync off.', 'info', 1600);
  }

  /* ---- sharing ---------------------------------------------------------
     A board otherwise only its owner can read/write. Sharing adds someone
     by email to the board's `sharedWith`/`sharedEmails` (Firestore rules
     grant them read + limited write from that alone) and sends them a
     link straight into it. */

  async openShareDialog() {
    let fbUser = this._fbUser;
    if (!fbUser) {
      // Being connected to Google Workspace (Drive/Docs/Gmail) does NOT mean
      // signed in here — that's a separate Firebase Authentication step, and
      // sharing/live-sync specifically need it. GoogleAccount.connect() used
      // to be fired-and-forgotten: even a successful sign-in left this
      // function already returned, so the dialog never actually opened
      // until a second click. Wait for it and continue automatically.
      if (!window.GoogleAccount?.connect) {
        Modal.toast('Sign in with Google first to share this board.', 'warn');
        return;
      }
      Modal.toast('Sharing needs one more sign-in — pick your Google account in the popup that opens.', 'info', 5000);
      await window.GoogleAccount.connect();
      fbUser = this._fbUser;
      if (!fbUser) {
        // connect()/signIn() already explained the specific failure (blocked
        // popup, wrong domain, etc.) in its own toast — this just closes the
        // loop instead of failing silently.
        Modal.toast('Still not signed in. Finish the Google sign-in popup, then click Share again.', 'warn', 6000);
        return;
      }
    }
    const FB = window.FB;
    if (!FB) { Modal.toast('Cloud sync is not ready yet — try again in a moment.', 'warn'); return; }

    await this.app.save({ quiet: true, server: false }).catch(() => {});
    const boardId = this.app.store.state.id;
    const boardRef = FB.doc(FB.db, 'boards', boardId);

    let snap = await FB.getDoc(boardRef).catch(() => null);
    if (!snap?.exists()) {
      // The board has never been pushed to the cloud — sharing needs a
      // cloud copy to attach the sharing lists to.
      try { await window.FirebaseSync.saveBoard(this.app.store.serialize()); }
      catch (err) { Modal.toast('Could not prepare this board for sharing: ' + err.message, 'warn', 5000); return; }
      snap = await FB.getDoc(boardRef).catch(() => null);
    }
    if (!snap?.exists() || snap.data().ownerId !== fbUser.uid) {
      Modal.toast('Only the board owner can share it.', 'warn');
      return;
    }

    const data = snap.data();
    const emails = data.sharedEmails || [];

    const list = document.createElement('div');
    list.className = 'wb-share-list';
    const renderList = () => {
      list.textContent = '';
      if (!emails.length) {
        const empty = document.createElement('p');
        empty.className = 'wb-cal-note';
        empty.textContent = 'Not shared with anyone yet.';
        list.appendChild(empty);
        return;
      }
      for (const email of emails) {
        const row = document.createElement('div');
        row.className = 'wb-share-row';
        const label = document.createElement('span');
        label.textContent = email;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'icon-btn';
        removeBtn.title = 'Remove access';
        removeBtn.innerHTML = '<i class="ph ph-x"></i>';
        removeBtn.addEventListener('click', async () => {
          try {
            await FB.updateDoc(boardRef, { sharedEmails: FB.arrayRemove(email) });
            emails.splice(emails.indexOf(email), 1);
            renderList();
          } catch (err) { Modal.toast('Could not remove access: ' + err.message, 'warn'); }
        });
        row.append(label, removeBtn);
        list.appendChild(row);
      }
    };
    renderList();

    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'email';
    input.placeholder = 'Add someone by email…';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary';
    addBtn.type = 'button';
    addBtn.textContent = 'Add';
    const addRow = document.createElement('div');
    addRow.className = 'wb-share-add';
    addRow.append(input, addBtn);

    const doAdd = async () => {
      const email = input.value.trim().toLowerCase();
      if (!email || !email.includes('@')) { Modal.toast('Enter a valid email address.', 'warn'); return; }
      if (emails.includes(email)) { Modal.toast('Already shared with that address.', 'info'); return; }
      try {
        await FB.updateDoc(boardRef, { sharedEmails: FB.arrayUnion(email) });
        emails.push(email);
        input.value = '';
        renderList();

        const link = `${location.origin}${location.pathname}?board=${encodeURIComponent(boardId)}`;
        const res = await fetch('/api/board/invite', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emails: [email], boardName: this.app.store.state.name || 'Untitled Board',
            inviter: fbUser.displayName || fbUser.email, link,
          }),
        }).then(r => r.json()).catch(() => null);

        if (res?.sent) Modal.toast(`Invited ${email} — they'll get an email with a link straight in.`, 'success', 3500);
        else Modal.toast(`Shared with ${email}. ${res?.hint || 'They can open the board link directly.'}`, 'info', 5000);
      } catch (err) {
        Modal.toast('Could not share the board: ' + err.message, 'warn', 5000);
      }
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

    const intro = document.createElement('p');
    intro.className = 'wb-cal-note';
    intro.textContent = 'Anyone added here can open, edit and live-sync this board with you.';
    const body = document.createElement('div');
    body.className = 'wb-share-body';
    body.append(intro, addRow, list);

    Modal.open({
      title: '<i class="ph ph-user-plus"></i> Share this board',
      width: 480,
      body,
      actions: [{ label: 'Done' }],
    });
  }

  _send(msg) {
    if (!this.channel) return;
    try { this.channel.postMessage({ ...msg, peer: this.me }); } catch (_) { /* structured clone failed */ }
  }

  _receive(msg) {
    if (!msg || !msg.peer) return;
    // Presence (cursor/view/bye) is keyed by uid, so two tabs signed into
    // the same account intentionally collapse to one roster entry there —
    // but a `state` push from your OTHER tab must still land here even
    // though it carries the same uid; FirestoreChannel already guarantees
    // it only forwards a `state` message once it's confirmed to be from a
    // different browser session, not a different account.
    if (msg.peer.id === this.me.id && msg.t !== 'state') return;
    const now = Date.now();

    if (msg.t === 'bye') { this.peers.delete(msg.peer.id); this._renderCursors(); this._renderBar(); return; }

    const p = this.peers.get(msg.peer.id) || { ...msg.peer };
    p.seen = now;
    if (msg.t === 'cursor') {
      // Keep the last drawn position as the animation's starting point and
      // the new one as its target; _renderCursors eases between them so
      // ~14 updates/second still reads as continuous motion.
      p.fromX = p.dx != null ? p.dx : msg.x;
      p.fromY = p.dy != null ? p.dy : msg.y;
      p.x = msg.x; p.y = msg.y;
      p.tweenStart = now;
    }
    if (msg.t === 'view') { p.view = { x: msg.x, y: msg.y, s: msg.s }; }
    const isNew = !this.peers.has(msg.peer.id);
    this.peers.set(msg.peer.id, p);
    if (isNew) { this._renderBar(); this._send({ t: 'hello' }); }

    if (msg.t === 'need-state') { this._send({ t: 'state', data: this.app.store.serialize() }); return; }

    if (msg.t === 'state' && msg.data) {
      this._applying = true;
      try {
        const sel = [...this.app.store.selection];
        this.app.store.load(msg.data);
        this.app.connections.renderAll();
        this.app.ink.redraw();
        this.app.store.select(sel.filter(id => this.app.store.get(id)));
        this.app.overlay.sync();
      } finally { this._applying = false; }
    }

    if (msg.t === 'live') this._applyLiveMoves(msg.els);

    if (msg.t === 'cursor' || msg.t === 'view') this._renderCursors();
    if (msg.t === 'view' && this.followId === msg.peer.id) {
      this.app.viewport.setTransform(msg.x, msg.y, msg.s);
    }
  }

  _reap() {
    if (!this.enabled) return;
    const cutoff = Date.now() - 9000;
    let changed = false;
    for (const [id, p] of this.peers) if ((p.seen || 0) < cutoff) { this.peers.delete(id); changed = true; }
    if (changed) { this._renderCursors(); this._renderBar(); }
  }

  _renderBar() {
    this.bar.textContent = '';
    if (!this.enabled) return;
    const mine = document.createElement('span');
    mine.className = 'pb-chip';
    mine.style.background = this.me.color;
    mine.title = this.me.name + ' (you)';
    mine.textContent = this.me.name[0];
    this.bar.appendChild(mine);
    for (const p of this.peers.values()) {
      const chip = document.createElement('span');
      chip.className = 'pb-chip' + (this.followId === p.id ? ' is-following' : '');
      chip.style.background = p.color;
      chip.title = `${p.name} — click to follow their view`;
      chip.textContent = p.name[0];
      chip.addEventListener('click', () => {
        this.followId = this.followId === p.id ? null : p.id;
        if (this.followId && p.view) this.app.viewport.setTransform(p.view.x, p.view.y, p.view.s);
        this._renderBar();
      });
      this.bar.appendChild(chip);
    }
  }

  _renderCursors() {
    const layer = document.getElementById('overlay-layer');
    if (!layer) return;
    const seen = new Set();
    for (const p of this.peers.values()) {
      if (p.x == null) continue;
      seen.add(p.id);
      let node = layer.querySelector(`[data-peer="${p.id}"]`);
      if (!node) {
        node = document.createElement('div');
        node.className = 'presence-cursor';
        node.dataset.peer = p.id;
        node.innerHTML =
          `<svg width="18" height="22" viewBox="0 0 18 22"><path d="M2,1 L15,12 L9,12.6 L12,19 L9.3,20 L6.4,13.7 L2,17 Z" fill="${p.color}" stroke="#fff" stroke-width="1.2"/></svg>` +
          `<span class="presence-name" style="background:${p.color}">${Util.escapeHTML(p.name)}</span>`;
        layer.appendChild(node);
      }
      // Ease from where this cursor was last drawn toward its latest
      // reported position over roughly one send-interval, so motion looks
      // continuous instead of stepping once per network update.
      const TWEEN_MS = 90;
      const t = p.tweenStart ? Math.min(1, (Date.now() - p.tweenStart) / TWEEN_MS) : 1;
      const ease = t * (2 - t);                       // easeOutQuad
      const fromX = p.fromX != null ? p.fromX : p.x;
      const fromY = p.fromY != null ? p.fromY : p.y;
      p.dx = fromX + (p.x - fromX) * ease;
      p.dy = fromY + (p.y - fromY) * ease;

      const s = this.app.viewport.boardToScreen(p.dx, p.dy);
      node.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
    for (const node of layer.querySelectorAll('.presence-cursor')) {
      if (!seen.has(node.dataset.peer)) node.remove();
    }
  }
}

/* ================================================================
   6. WORKSHOP — timer, dot voting, reactions
   ================================================================ */
const REACTIONS = ['👍', '❤️', '🎉', '🤔', '🚀', '⚠️'];

class Workshop {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.voting = false;
    this.timer = null;

    this.store.on('element:update', el => this._decorate(el));
    this.store.on('reload', () => this.decorateAll());
    this.store.on('change', () => this.decorateAll());
  }

  /* ---- votes ------------------------------------------------------- */

  toggleVoting() {
    this.voting = !this.voting;
    document.body.classList.toggle('vote-mode', this.voting);
    document.getElementById('vote-btn')?.classList.toggle('is-on', this.voting);
    Modal.toast(this.voting
      ? 'Dot voting on — click any object to add a vote, Alt-click to remove one.'
      : 'Dot voting off.', 'info', 2600);
  }

  /** Returns true when the click was consumed by voting. */
  handleClick(elementId, remove) {
    if (!this.voting) return false;
    const el = this.store.get(elementId);
    if (!el) return false;
    const who = this.app.live?.me?.id || 'local';
    const votes = { ...(el.votes || {}) };
    votes[who] = Math.max(0, (votes[who] || 0) + (remove ? -1 : 1));
    if (!votes[who]) delete votes[who];
    this.store.updateElement(elementId, { votes });
    return true;
  }

  static total(el) {
    return Object.values(el.votes || {}).reduce((s, n) => s + n, 0);
  }

  clearVotes() {
    const targets = this.store.elements.filter(e => e.votes && Object.keys(e.votes).length);
    if (!targets.length) { Modal.toast('No votes to clear.', 'info', 1500); return; }
    this.store.transact('clear votes', () => {
      for (const el of targets) this.store.updateElement(el.id, { votes: {} }, { silent: true });
    });
    this.decorateAll();
    Modal.toast('Votes cleared.', 'success', 1500);
  }

  sortByVotes() {
    const sel = this.store.selected().filter(e => !e.locked);
    const pool = sel.length >= 2 ? sel : this.store.elements.filter(e => Workshop.total(e) > 0);
    if (pool.length < 2) { Modal.toast('Nothing with votes to sort yet.', 'warn', 1800); return; }
    const b = Util.boundsOf(pool);
    const sorted = pool.slice().sort((a, c) => Workshop.total(c) - Workshop.total(a));
    this.store.transact('sort by votes', () => {
      let y = b.y;
      for (const el of sorted) {
        el.x = b.x; el.y = y;
        y += el.height + 18;
        this.app.renderer.place(el);
      }
      this.app.connections.refreshFor(sorted.map(e => e.id));
    });
    Modal.toast('Sorted by vote count, highest first.', 'success', 1800);
  }

  /* ---- reactions ---------------------------------------------------- */

  react(elementId, emoji) {
    const el = this.store.get(elementId);
    if (!el) return;
    const reactions = { ...(el.reactions || {}) };
    reactions[emoji] = (reactions[emoji] || 0) + 1;
    this.store.updateElement(elementId, { reactions });
  }

  openReactionPicker(elementId, clientX, clientY) {
    const menu = document.getElementById('context-menu');
    menu.textContent = '';
    menu.classList.add('ctx-reactions');
    for (const r of REACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r + '  react';
      b.addEventListener('click', () => { this.react(elementId, r); this.app.closeContextMenu(); });
      menu.appendChild(b);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear reactions';
    clear.addEventListener('click', () => {
      this.store.updateElement(elementId, { reactions: {} });
      this.app.closeContextMenu();
    });
    menu.appendChild(clear);
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(clientX, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(clientY, window.innerHeight - r.height - 8) + 'px';
  }

  /* ---- badges ------------------------------------------------------- */

  /**
   * Runs on every commit, so it bails out immediately on the overwhelmingly
   * common case of a board with no votes and no reactions — otherwise a
   * 500-object board would pay a DOM query per object per edit.
   */
  decorateAll() {
    const any = this.store.elements.some(el =>
      (el.votes && Object.keys(el.votes).length) || (el.reactions && Object.keys(el.reactions).length));
    if (!any && !this._hadDecorations) return;
    this._hadDecorations = any;
    for (const el of this.store.elements) this._decorate(el);
  }

  _decorate(el) {
    const node = this.app.renderer.node(el.id);
    if (!node) return;

    const votes = Workshop.total(el);
    let badge = node.querySelector(':scope > .vote-badge');
    if (votes > 0) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'vote-badge';
        node.appendChild(badge);
      }
      badge.textContent = votes;
    } else badge?.remove();

    const reactions = Object.entries(el.reactions || {}).filter(([, n]) => n > 0);
    let strip = node.querySelector(':scope > .reaction-strip');
    if (reactions.length) {
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'reaction-strip';
        node.appendChild(strip);
      }
      strip.textContent = '';
      for (const [emoji, n] of reactions) {
        const chip = document.createElement('span');
        chip.className = 'reaction-chip';
        chip.textContent = n > 1 ? `${emoji} ${n}` : emoji;
        strip.appendChild(chip);
      }
    } else strip?.remove();
  }

  /* ---- timer -------------------------------------------------------- */

  async openTimer() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<p class="modal-text">Pick a length, or type your own in minutes.</p>';
    const row = document.createElement('div');
    row.className = 'btn-grid';
    for (const m of [1, 2, 3, 5, 10, 15, 20, 30]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost';
      b.textContent = m + ' min';
      b.addEventListener('click', () => { handle.close(); this.startTimer(m * 60); });
      row.appendChild(b);
    }
    wrap.appendChild(row);
    const custom = document.createElement('input');
    custom.className = 'input';
    custom.type = 'number';
    custom.min = '1';
    custom.placeholder = 'Custom minutes…';
    custom.style.marginTop = '12px';
    custom.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const m = parseFloat(custom.value);
      if (m > 0) { handle.close(); this.startTimer(Math.round(m * 60)); }
    });
    wrap.appendChild(custom);

    const handle = Modal.open({
      title: '<i class="ph ph-timer"></i> Workshop timer',
      width: 460, body: wrap, actions: [{ label: 'Cancel' }],
    });
  }

  startTimer(seconds) {
    this.stopTimer();
    const host = document.createElement('div');
    host.className = 'wk-timer';
    host.innerHTML = '<span class="wk-time">00:00</span>';

    const pause = document.createElement('button');
    pause.type = 'button';
    pause.innerHTML = '<i class="ph ph-pause"></i>';
    pause.title = 'Pause / resume';
    const close = document.createElement('button');
    close.type = 'button';
    close.innerHTML = '<i class="ph ph-x"></i>';
    close.title = 'Dismiss';
    host.appendChild(pause);
    host.appendChild(close);
    document.body.appendChild(host);

    const timeEl = host.querySelector('.wk-time');
    const state = { end: Date.now() + seconds * 1000, paused: false, left: seconds * 1000, rang: false };

    const tick = () => {
      const ms = state.paused ? state.left : state.end - Date.now();
      const over = ms < 0;
      const abs = Math.abs(ms);
      const mm = String(Math.floor(abs / 60000)).padStart(2, '0');
      const ss = String(Math.floor((abs % 60000) / 1000)).padStart(2, '0');
      timeEl.textContent = (over ? '−' : '') + mm + ':' + ss;
      host.classList.toggle('is-over', over);
      if (over && !state.rang) {
        state.rang = true;
        Modal.toast('⏰ Time is up.', 'warn', 5000);
      }
    };

    pause.addEventListener('click', () => {
      if (state.paused) { state.end = Date.now() + state.left; state.paused = false; pause.innerHTML = '<i class="ph ph-pause"></i>'; }
      else { state.left = state.end - Date.now(); state.paused = true; pause.innerHTML = '<i class="ph ph-play"></i>'; }
      tick();
    });
    close.addEventListener('click', () => this.stopTimer());

    tick();
    this.timer = { host, id: setInterval(tick, 250) };
  }

  stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer.id);
    this.timer.host.remove();
    this.timer = null;
  }
}

/* ================================================================
   7. CONVERTER — turn a selection into something else
   ================================================================ */
class Converter {
  constructor(app) { this.app = app; this.store = app.store; }

  _selection(min = 1) {
    const sel = this.store.selected().filter(e => !e.locked);
    if (sel.length < min) { Modal.toast(`Select ${min > 1 ? min + ' or more objects' : 'something'} first.`, 'warn', 1900); return null; }
    return sel.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  static textOf(el) {
    if (el.type === 'checklist') return (el.items || []).map(i => i.text).join('\n');
    if (el.type === 'graph') return el.graphTitle || '';
    if (el.type === 'algorithm') return el.content || 'Algorithm';
    return el.content || '';
  }

  toChecklist() {
    const sel = this._selection(1);
    if (!sel) return;
    const items = sel.flatMap(el => Converter.textOf(el).split('\n'))
      .map(t => t.trim()).filter(Boolean).map(t => ({ text: t, done: false }));
    if (!items.length) { Modal.toast('Nothing with text in that selection.', 'warn'); return; }
    const b = Util.boundsOf(sel);
    this.store.transact('convert to checklist', () => {
      this.store.removeElements(sel.map(e => e.id), { silent: true });
      const el = this.store.addElement('checklist', {
        x: b.x, y: b.y, width: Math.max(300, b.w), height: Math.max(140, items.length * 30 + 90),
        content: 'Checklist', items,
      }, { silent: true });
      this.store.select([el.id]);
    });
  }

  toTable() {
    const sel = this._selection(2);
    if (!sel) return;
    const rows = sel.map(el => Converter.textOf(el).split('\n').map(s => s.trim()));
    const cols = Math.max(1, ...rows.map(r => r.length));
    const cells = [new Array(cols).fill('').map((_, i) => 'Column ' + String.fromCharCode(65 + i))];
    for (const r of rows) cells.push(Array.from({ length: cols }, (_, i) => r[i] || ''));
    const b = Util.boundsOf(sel);
    this.store.transact('convert to table', () => {
      this.store.removeElements(sel.map(e => e.id), { silent: true });
      const el = this.store.addElement('table', {
        x: b.x, y: b.y, width: Math.max(420, cols * 160), height: cells.length * 40 + 34,
        tableData: { rows: cells.length, cols, cells },
      }, { silent: true });
      this.store.select([el.id]);
    });
  }

  toStickies() {
    const sel = this._selection(1);
    if (!sel) return;
    const b = Util.boundsOf(sel);
    const colors = this.app.theme.stickyColors;
    this.store.transact('convert to notes', () => {
      const made = [];
      sel.forEach((el, i) => {
        const text = Converter.textOf(el);
        made.push(this.store.addElement('sticky-note', {
          x: b.x + (i % 4) * 200, y: b.y + b.h + 40 + Math.floor(i / 4) * 200,
          width: 180, height: 180, content: text,
          style: { backgroundColor: colors[i % colors.length], fontSize: 14 },
        }, { silent: true }));
      });
      this.store.removeElements(sel.map(e => e.id), { silent: true });
      this.store.select(made.map(m => m.id));
    });
  }

  toMindMap() {
    const sel = this._selection(2);
    if (!sel) return;
    const b = Util.boundsOf(sel);
    const texts = sel.map(Converter.textOf).map(t => t.trim()).filter(Boolean);
    if (!texts.length) { Modal.toast('Nothing with text in that selection.', 'warn'); return; }

    this.store.transact('convert to mind map', () => {
      this.store.removeElements(sel.map(e => e.id), { silent: true });
      const root = this.app.mindmap.createRoot(b.x, b.y, texts[0]);
      for (const t of texts.slice(1)) this.app.mindmap.addChild(root.id, t, { focus: false });
      this.app.mindmap.layout(root.id);
      this.store.select([root.id]);
    });
    this.app.viewport.zoomToSelection();
  }

  toFlowchart() {
    const sel = this._selection(2);
    if (!sel) return;
    const b = Util.boundsOf(sel);
    const texts = sel.map(Converter.textOf).map(t => t.trim()).filter(Boolean);
    if (texts.length < 2) { Modal.toast('Need at least two text objects.', 'warn'); return; }

    this.store.transact('convert to flowchart', () => {
      this.store.removeElements(sel.map(e => e.id), { silent: true });
      const made = [];
      texts.forEach((t, i) => {
        const first = i === 0, last = i === texts.length - 1;
        made.push(this.store.addElement('flowchart', {
          x: b.x, y: b.y + i * 130, width: 220, height: first || last ? 58 : 72,
          fcType: first || last ? 'startend' : (/\?$/.test(t) ? 'decision' : 'process'),
          content: t,
          style: {
            backgroundColor: first ? '#e8f5e9' : last ? '#eceff1' : '#ffffff',
            borderColor: first ? '#2e7d32' : last ? '#37474f' : '#16161d', borderWidth: 2, fontSize: 13,
          },
        }, { silent: true }));
      });
      for (let i = 0; i < made.length - 1; i++) {
        this.store.addConnection({
          from: { id: made[i].id, port: 'bottom' }, to: { id: made[i + 1].id, port: 'top' },
          routing: 'orthogonal', arrowEnd: true, style: { color: '#5a6274', width: 2 },
        }, { silent: true });
      }
      this.store.select(made.map(m => m.id));
    });
    this.app.viewport.zoomToSelection();
  }

  /** One sticky whose text has many lines becomes many stickies. */
  explode() {
    const sel = this._selection(1);
    if (!sel) return;
    const colors = this.app.theme.stickyColors;
    this.store.transact('split into notes', () => {
      const made = [];
      for (const src of sel) {
        const lines = Converter.textOf(src).split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        lines.forEach((line, i) => {
          made.push(this.store.addElement('sticky-note', {
            x: src.x + (i % 3) * (src.width + 16),
            y: src.y + Math.floor(i / 3) * (src.height + 16),
            width: src.width, height: src.height, content: line,
            style: { ...(src.style || {}), backgroundColor: src.style?.backgroundColor || colors[i % colors.length] },
          }, { silent: true }));
        });
        this.store.removeElements([src.id], { silent: true });
      }
      if (!made.length) { Modal.toast('Those notes only have one line each.', 'warn'); return; }
      this.store.select(made.map(m => m.id));
    });
  }

  wrapInFrame() {
    const sel = this._selection(1);
    if (!sel) return;
    const b = Util.boundsOf(sel);
    const pad = 40;
    this.store.transact('wrap in frame', () => {
      const frame = this.store.addElement('frame', {
        x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
        content: 'Frame ' + (this.store.elements.filter(e => e.type === 'frame').length + 1),
        zIndex: Math.min(...sel.map(e => e.zIndex || 1)) - 1,
      }, { silent: true });
      this.store.select([frame.id]);
    });
  }

  /**
   * Paste an indented outline (or Markdown bullets) and get a real mind map
   * or a column of notes. Indentation with tabs or two spaces sets the depth.
   */
  async importOutline() {
    const text = await Modal.prompt(
      'Paste an outline. Indent with spaces or tabs to nest, one item per line.',
      '', {
        title: 'Import an outline',
        multiline: true,
        placeholder: 'Launch plan\n  Marketing\n    Landing page\n    Email list\n  Engineering\n    API\n    Web app',
      });
    if (text == null || !text.trim()) return;

    const lines = text.split('\n').filter(l => l.trim());
    const parsed = lines.map(l => {
      const raw = l.replace(/\t/g, '  ');
      const indent = raw.length - raw.trimStart().length;
      return { depth: Math.floor(indent / 2), text: raw.trim().replace(/^([-*+]|#{1,6}|\d+[.)])\s*/, '') };
    });

    const asMap = await Modal.confirm(
      `${parsed.length} lines. Build a mind map (recommended for nested outlines), or a column of sticky notes?`,
      { title: 'Import as…', confirmLabel: 'Mind map' });

    const center = this.app.viewport.screenToBoard(this.app.viewport.width / 2, this.app.viewport.height / 2);

    if (!asMap) {
      const colors = this.app.theme.stickyColors;
      this.store.transact('import outline', () => {
        const made = parsed.map((p, i) => this.store.addElement('sticky-note', {
          x: center.x + p.depth * 60, y: center.y + i * 200,
          width: 220, height: 180, content: p.text,
          style: { backgroundColor: colors[p.depth % colors.length], fontSize: 14 },
        }, { silent: true }));
        this.store.select(made.map(m => m.id));
      });
      this.app.viewport.zoomToSelection();
      return;
    }

    this.store.transact('import outline', () => {
      const root = this.app.mindmap.createRoot(center.x, center.y, parsed[0].text || 'Outline');
      const stack = [root.id];
      for (const p of parsed.slice(1)) {
        const depth = Util.clamp(p.depth, 1, stack.length);
        stack.length = depth;
        const parentId = stack[depth - 1];
        const child = this.app.mindmap.addChild(parentId, p.text, { focus: false });
        if (child) stack[depth] = child.id;
      }
      this.app.mindmap.layout(root.id);
      this.store.select([root.id]);
    });
    this.app.viewport.zoomToSelection();
    Modal.toast(`Imported ${parsed.length} topics.`, 'success');
  }
}

/* ================================================================
   8. INSIGHTS — outline view and board statistics
   ================================================================ */
class Insights {
  constructor(app) { this.app = app; this.store = app.store; }

  openOutline() {
    const wrap = document.createElement('div');
    wrap.className = 'outline-tree';
    const frames = this.store.elements.filter(e => e.type === 'frame').sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const used = new Set(frames.map(f => f.id));

    const jump = el => {
      this.store.select([el.id]);
      this.app.viewport.zoomToFit({ x: el.x, y: el.y, w: el.width, h: el.height }, 220);
      this.app.showPropertiesPanel();
    };

    const row = (el, depth, label) => {
      const d = document.createElement('div');
      d.className = 'ot-row';
      d.style.paddingLeft = depth * 18 + 'px';
      d.innerHTML = `<span>${this.app._typeGlyph(el.type)}</span>`;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label || this.app._typeLabel(el.type);
      b.addEventListener('click', () => { jump(el); handle.close(); });
      d.appendChild(b);
      wrap.appendChild(d);
    };

    for (const f of frames) {
      row(f, 0, f.content || 'Frame');
      const inside = this.store.elements.filter(e =>
        e.type !== 'frame' && !used.has(e.id) &&
        Util.rectContains({ x: f.x, y: f.y, w: f.width, h: f.height },
          { x: e.x, y: e.y, w: e.width, h: e.height }));
      for (const el of inside.sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
        used.add(el.id);
        row(el, 1, (Converter.textOf(el) || this.app._typeLabel(el.type)).slice(0, 70));
      }
    }
    const loose = this.store.elements.filter(e => !used.has(e.id)).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const el of loose) row(el, frames.length ? 1 : 0, (Converter.textOf(el) || this.app._typeLabel(el.type)).slice(0, 70));

    if (!this.store.elements.length) wrap.innerHTML = '<p class="muted">The board is empty.</p>';

    const handle = Modal.open({
      title: '<i class="ph ph-list-bullets"></i> Board outline',
      width: 620, body: wrap,
      actions: [
        { label: 'Copy as Markdown', onClick: () => { this.app.exporter.markdown(); return true; } },
        { label: 'Close' },
      ],
    });
  }

  openStats() {
    const s = this.store;
    const byType = {};
    for (const el of s.elements) byType[el.type] = (byType[el.type] || 0) + 1;
    const words = s.elements.reduce((n, el) =>
      n + Converter.textOf(el).split(/\s+/).filter(Boolean).length, 0);
    const votes = s.elements.reduce((n, el) => n + Workshop.total(el), 0);
    const done = s.elements.filter(e => e.type === 'checklist')
      .flatMap(e => e.items || []);
    const bounds = this.app.viewport.contentBounds();

    const tiles = [
      ['Objects', s.elements.length],
      ['Connections', s.connections.length],
      ['Ink strokes', s.strokes.length],
      ['Words', words],
      ['Frames', byType.frame || 0],
      ['Sticky notes', byType['sticky-note'] || 0],
      ['Votes cast', votes],
      ['Tasks done', done.length ? `${done.filter(i => i.done).length} / ${done.length}` : '—'],
      ['Board width', bounds ? Math.round(bounds.w) + ' px' : '—'],
      ['Board height', bounds ? Math.round(bounds.h) + ' px' : '—'],
    ];

    const wrap = document.createElement('div');
    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    for (const [label, value] of tiles) {
      const t = document.createElement('div');
      t.className = 'stat-tile';
      t.innerHTML = `<b>${Util.escapeHTML(String(value))}</b><span>${Util.escapeHTML(label)}</span>`;
      grid.appendChild(t);
    }
    wrap.appendChild(grid);

    const list = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    if (list.length) {
      const h = document.createElement('h4');
      h.className = 'panel-title';
      h.style.marginTop = '18px';
      h.textContent = 'Breakdown by type';
      wrap.appendChild(h);
      const ul = document.createElement('div');
      ul.className = 'outline-tree';
      for (const [type, n] of list) {
        const d = document.createElement('div');
        d.className = 'ot-row';
        d.innerHTML = `<span>${this.app._typeGlyph(type)}</span><span>${Util.escapeHTML(this.app._typeLabel(type))} — ${n}</span>`;
        ul.appendChild(d);
      }
      wrap.appendChild(ul);
    }

    Modal.open({
      title: '<i class="ph ph-chart-donut"></i> Board statistics',
      width: 620, body: wrap, actions: [{ label: 'Close' }],
    });
  }
}

/* ================================================================
   9. QUICKBAR — contextual toolbar that follows the selection
   ================================================================ */
class QuickBar {
  constructor(app) {
    this.app = app;
    this.store = app.store;

    this.root = document.createElement('div');
    this.root.className = 'quickbar hidden';
    
    // Stop pointer/mouse events from bubbling so canvas interaction doesn't cancel clicks
    this.root.addEventListener('pointerdown', e => e.stopPropagation());
    this.root.addEventListener('mousedown', e => e.stopPropagation());
    this.root.addEventListener('click', e => e.stopPropagation());

    document.getElementById('overlay-layer').appendChild(this.root);

    this.store.on('selection', () => this.sync());
    this.store.on('change', () => this.sync());
    this.store.on('live-change', () => this._position());
    app.viewport.on('applied', () => this._position());
    app.on?.('edit:start', () => this.root.classList.add('hidden'));
    app.on?.('edit:end', () => this.sync());
  }

  sync() {
    const sel = this.store.selected();
    if (!sel.length || !this.app.settings.quickBar || this.app._presenting || this.app.interaction?.editingId) {
      this.root.classList.add('hidden');
      return;
    }
    this.build(sel);
    this._position();
  }

  build(sel) {
    const app = this.app;
    const el = sel[0];
    this.root.textContent = '';
    this.root.classList.remove('hidden');

    // 1. Color swatches
    const colors = app.theme?.stickyColors?.slice(0, 7) || ['#ffe66d', '#ff9f43', '#ff6b6b', '#a8ff78', '#70a1ff', '#dff9fb', '#f8a5c2'];
    const current = el.style?.backgroundColor;
    for (const c of colors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qb-sw' + (c === current ? ' is-active' : '');
      b.style.background = c;
      b.title = 'Color ' + c;
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        app.store.transact('change color', () => {
          for (const s of sel) {
            app.store.updateElement(s.id, { style: { backgroundColor: c } });
          }
        });
        this.sync();
      });
      this.root.appendChild(b);
    }

    const sep = () => {
      const s = document.createElement('span');
      s.className = 'qb-sep';
      this.root.appendChild(s);
    };

    const btn = (icon, title, fn, isActive = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qb-btn' + (isActive ? ' is-active' : '');
      b.innerHTML = icon;
      b.title = title;
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        fn(e);
      });
      this.root.appendChild(b);
      return b;
    };

    sep();

    // Bold button
    const isBold = !!el.style?.bold;
    btn('<i class="ph ph-text-b"></i>', 'Bold', () => {
      const next = !isBold;
      app.store.transact('bold text', () => {
        for (const s of sel) {
          app.store.updateElement(s.id, { style: { bold: next } });
        }
      });
      this.sync();
    }, isBold);

    // Font size down
    btn('<i class="ph ph-minus"></i>', 'Smaller text', () => {
      app.store.transact('smaller text', () => {
        for (const s of sel) {
          const sz = Math.max(10, (s.style?.fontSize || 16) - 2);
          app.store.updateElement(s.id, { style: { fontSize: sz } });
          if (AUTO_HEIGHT_TYPES.has(s.type)) app.autoSize?.(s.id);
        }
      });
      this.sync();
    });

    // Font size up
    btn('<i class="ph ph-plus"></i>', 'Bigger text', () => {
      app.store.transact('bigger text', () => {
        for (const s of sel) {
          const sz = Math.min(96, (s.style?.fontSize || 16) + 2);
          app.store.updateElement(s.id, { style: { fontSize: sz } });
          if (AUTO_HEIGHT_TYPES.has(s.type)) app.autoSize?.(s.id);
        }
      });
      this.sync();
    });

    // Align text (cycle left -> center -> right)
    const alignIcons = {
      left: '<i class="ph ph-text-align-left"></i>',
      center: '<i class="ph ph-text-align-center"></i>',
      right: '<i class="ph ph-text-align-right"></i>',
    };
    const currentAlign = el.style?.align || 'left';
    btn(alignIcons[currentAlign] || alignIcons.left, 'Align: ' + currentAlign, () => {
      const nextMap = { left: 'center', center: 'right', right: 'left' };
      const nextAlign = nextMap[currentAlign] || 'center';
      app.store.transact('align text', () => {
        for (const s of sel) {
          app.store.updateElement(s.id, { style: { align: nextAlign } });
        }
      });
      this.sync();
    });

    sep();

    // Duplicate
    btn('<i class="ph ph-copy"></i>', 'Duplicate (Ctrl+D)', () => {
      app.duplicate();
    });

    // Lock / Unlock
    btn(el.locked ? '<i class="ph ph-lock-key"></i>' : '<i class="ph ph-lock-key-open"></i>', el.locked ? 'Unlock' : 'Lock', () => {
      const next = !el.locked;
      app.store.transact('lock', () => {
        for (const s of sel) {
          app.store.updateElement(s.id, { locked: next });
        }
      });
      this.sync();
    });

    // Delete
    btn('<i class="ph ph-trash"></i>', 'Delete', () => {
      app.deleteSelection();
    });
  }

  _position() {
    if (this.root.classList.contains('hidden')) return;
    const sel = this.store.selected();
    if (!sel.length || this.app.interaction?.editingId) {
      this.root.classList.add('hidden');
      return;
    }
    const b = Util.boundsOf(sel);
    if (!b) {
      this.root.classList.add('hidden');
      return;
    }
    const vp = this.app.viewport;
    const p = vp.boardToScreen(b.x + b.w / 2, b.y);
    const top = p.y - 12;

    // Flip below the selection when there is no room above the element
    if (top < 65) {
      const bottom = vp.boardToScreen(b.x + b.w / 2, b.y + b.h);
      this.root.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(bottom.y + 12)}px, 0) translate(-50%, 0)`;
    } else {
      this.root.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(top)}px, 0) translate(-50%, -100%)`;
    }
  }
}

/* ================================================================
   10. BRUSH RING — a true-size cursor for pen / eraser
   ================================================================ */
class BrushRing {
  constructor(app) {
    this.app = app;
    this.node = document.createElement('div');
    this.node.className = 'brush-ring';
    document.body.appendChild(this.node);

    document.addEventListener('pointermove', e => this.update(e), { passive: true });
    app.viewport.on('applied', () => this.update(null));
    this._last = null;
  }

  update(e) {
    if (e) this._last = { x: e.clientX, y: e.clientY, over: this.app.viewport.wrapper.contains(e.target) };
    const tool = this.app.activeTool;
    const sizes = {
      pen: this.app.settings.penWidth,
      highlighter: this.app.settings.highlighterWidth,
      eraser: this.app.settings.eraserSize * 2,
    };
    const size = sizes[tool];
    if (!size || !this._last || !this._last.over) { this.node.classList.remove('is-on'); return; }
    const px = Math.max(6, size * (tool === 'eraser' ? 1 : this.app.viewport.scale));
    this.node.classList.add('is-on');
    this.node.style.width = px + 'px';
    this.node.style.height = px + 'px';
    this.node.style.left = this._last.x + 'px';
    this.node.style.top = this._last.y + 'px';
  }
}

/* ================================================================
   11. SLIDE SORTER — frame thumbnails during a presentation
   ================================================================ */
class SlideSorter {
  constructor(app) {
    this.app = app;
    this.root = document.createElement('div');
    this.root.className = 'slide-sorter';
    document.body.appendChild(this.root);
  }

  render(slides, current) {
    this.root.textContent = '';
    if (!slides?.length) return;
    slides.forEach((frame, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slide-thumb' + (i === current ? ' is-current' : '');
      const canvas = document.createElement('canvas');
      canvas.width = 264; canvas.height = 168;
      canvas.style.width = '100%'; canvas.style.height = '100%';
      this._paint(canvas, frame);
      b.appendChild(canvas);
      const label = document.createElement('span');
      label.textContent = (i + 1) + '. ' + (frame.content || 'Frame');
      b.appendChild(label);
      b.addEventListener('click', () => this.app._showSlide(i));
      this.root.appendChild(b);
    });
  }

  /** A cheap block preview — real element paints would stall the sorter. */
  _paint(canvas, frame) {
    const ctx = canvas.getContext('2d');
    const scale = Math.min(canvas.width / Math.max(frame.width, 1), canvas.height / Math.max(frame.height, 1));
    ctx.fillStyle = frame.style?.backgroundColor || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const inside = this.app.store.elements.filter(e =>
      e.id !== frame.id && !e.hidden &&
      Util.rectsIntersect({ x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        { x: e.x, y: e.y, w: e.width, h: e.height }));
    for (const el of inside.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))) {
      ctx.fillStyle = el.style?.backgroundColor || '#c3cbdb';
      ctx.globalAlpha = .92;
      ctx.fillRect((el.x - frame.x) * scale, (el.y - frame.y) * scale,
        Math.max(2, el.width * scale), Math.max(2, el.height * scale));
    }
    ctx.globalAlpha = 1;
  }

  clear() { this.root.textContent = ''; }
}

/* ================================================================
   12. STUDIO — the thin façade the app talks to
   ================================================================ */
class Studio {
  constructor(app) {
    this.app = app;
    app.cmdk = new CommandPalette(app);
    app.shapes = new ShapeRecognizer(app);
    app.arranger = new Arranger(app);
    app.versions = new VersionHistory(app);
    app.live = new LiveSync(app);
    app.workshop = new Workshop(app);
    app.converter = new Converter(app);
    app.insights = new Insights(app);
    app.quickbar = new QuickBar(app);
    app.brush = new BrushRing(app);
    app.slides = new SlideSorter(app);
  }

  toggleFocus() {
    const on = document.body.classList.toggle('is-focus');
    this.app.viewport.emit('resize');
    Modal.toast(on ? 'Focus mode — move the pointer to an edge to bring the chrome back, or press F11 again.'
                   : 'Focus mode off.', 'info', on ? 3200 : 1400);
  }
}

window.CommandPalette = CommandPalette;
window.ShapeRecognizer = ShapeRecognizer;
window.Arranger = Arranger;
window.VersionHistory = VersionHistory;
window.LiveSync = LiveSync;
window.Workshop = Workshop;
window.Converter = Converter;
window.Insights = Insights;
window.QuickBar = QuickBar;
window.BrushRing = BrushRing;
window.SlideSorter = SlideSorter;
window.Studio = Studio;
window.REACTIONS = REACTIONS;
