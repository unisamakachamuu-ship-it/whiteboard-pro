/* ================================================================
   interaction.js — one unified pointer pipeline
   ================================================================
   The old build had three systems listening on #canvas-wrapper at once
   (app.js, DragDropManager and FlowchartManager), all on `mouse*`
   events bound to the wrapper itself. That meant:
     · a drag died the moment the cursor left the wrapper,
     · touch/pen input never dragged anything,
     · flowchart port drags fought the element drag handler.

   Everything now goes through a single pointer-event state machine with
   real pointer capture, so a gesture that starts on the board finishes on
   the board — even over the toolbar or outside the window.
   ================================================================ */

const DRAG_THRESHOLD = 3;       // px of movement before a click becomes a drag
const EDGE_PAN_ZONE  = 42;      // px from the viewport edge that auto-pans
const EDGE_PAN_SPEED = 14;

class Interaction {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.viewport = app.viewport;
    this.overlay = app.overlay;
    this.renderer = app.renderer;

    this.wrapper = this.viewport.wrapper;

    this.mode = 'idle';
    this.suppressOverlay = false;
    this.spaceHeld = false;
    this.editingId = null;

    this._gesture = null;
    this._hoverId = null;
    this._edgePanRaf = null;

    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    this.wrapper.addEventListener('pointerdown', e => this._onDown(e));
    this.wrapper.addEventListener('pointermove', e => this._onHover(e));
    this.wrapper.addEventListener('pointerleave', () => this._setHover(null));
    this.wrapper.addEventListener('dblclick', e => this._onDoubleClick(e));
    this.wrapper.addEventListener('contextmenu', e => this._onContextMenu(e));

    this.wrapper.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    // Pinch-zoom / two-finger pan
    this._touchState = null;
    this.wrapper.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    this.wrapper.addEventListener('touchmove',  e => this._onTouchMove(e),  { passive: false });
    this.wrapper.addEventListener('touchend',   () => { this._touchState = null; }, { passive: true });

    this.app.on('edit:start', id => { this.editingId = id; });
    this.app.on('edit:end',   () => { this.editingId = null; });
  }

  get tool() { return this.app.activeTool; }

  /* ================================================================
     HOVER — port affordances
     ================================================================ */

  _onHover(e) {
    if (this.mode !== 'idle') return;
    const tool = this.tool;
    if (tool !== 'select' && tool !== 'connector') { this._setHover(null); return; }

    const node = e.target.closest('.board-element');
    const id = node?.dataset.elementId || null;

    // Keep ports alive while the pointer is on them.
    if (!id && e.target.closest('.port-set')) return;

    this._setHover(id);
  }

  _setHover(id) {
    if (this._hoverId === id) return;
    this._hoverId = id;
    const el = id ? this.store.get(id) : null;
    // Don't show generic connection port overlays on mindmap nodes and frames (they have their own branch handles)
    if (el && !el.locked && el.type !== 'frame' && el.type !== 'mindmap') {
      this.overlay.showPorts(el);
    } else {
      this.overlay.hidePorts();
    }
  }

  /* ================================================================
     POINTER DOWN — decide what gesture starts
     ================================================================ */

  /**
   * Commit whatever is being typed and drop the caret.
   *
   * `blur()` runs the label's blur handler synchronously, which writes the
   * value through the Store, so the edit is never lost. Returns true if
   * there was an editor to close.
   */
  _blurActiveEditor() {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    if (!active.isContentEditable && !active.classList?.contains('is-editing')) return false;
    active.blur();
    // Chrome leaves the collapsed range behind after blur; a stale range is
    // what lets a stray keystroke reach the old node.
    const sel = window.getSelection();
    if (sel && sel.rangeCount) sel.removeAllRanges();
    return true;
  }

  _onDown(e) {
    // Cleared here rather than only on release: a press that never starts a
    // gesture leaves no pointerup to clean up after it, and a stale entry
    // would put the caret in the wrong label on some later click.
    this._pendingEdit = null;

    if (e.button === 1) {                       // middle mouse always pans
      e.preventDefault();
      return this._begin(e, this._panGesture(e));
    }
    if (e.button === 2) return;                 // right-click -> context menu

    // Clicks on quickbar ribbon belong to the ribbon controls
    if (e.target.closest('.quickbar')) return;

    // Clicks inside an element that is being text-edited belong to the caret.
    if (e.target.isContentEditable || e.target.closest?.('.is-editing')) return;

    // Live blocks — the code cell's editor, the logic circuit's wiring
    // surface, a dashboard's scrollable grid — own the pointer inside their
    // own UI. Every gesture in there (place a caret, drag a gate, select a
    // range of text, scroll a table) is one the board would otherwise
    // hijack into "drag this element". They select themselves on the way
    // in, so the properties panel and Delete still work as normal.
    const liveUI = e.target.closest?.('.wb-live-ui');
    if (liveUI) {
      this._blurActiveEditor();
      const host = liveUI.closest('.board-element');
      if (host && !this.store.selection.has(host.dataset.elementId)) {
        this.store.select([host.dataset.elementId]);
      }
      return;
    }

    // The click landed somewhere else while another element still holds the
    // caret. Almost every branch below calls preventDefault() to own the
    // drag, and preventDefault() on pointerdown suppresses the browser's
    // default focus change — so the old element kept the caret, the new one
    // took the selection, and everything typed afterwards went into the
    // previous element. Commit and release the caret explicitly first.
    this._blurActiveEditor();

    // 1. Element-level interactive buttons (mindmap +/collapse, checklist toggles, table buttons, custom actions) ALWAYS take precedence!
    const actionBtn = e.target.closest('[data-action], [data-mm-action], button');
    if (actionBtn) {
      e.preventDefault();
      e.stopPropagation();
      this._runElementAction(actionBtn, e);
      return;
    }

    const tool = this.tool;

    if (this.spaceHeld || tool === 'hand') {
      e.preventDefault();
      return this._begin(e, this._panGesture(e));
    }

    // 2. Connection endpoint handles (drag to reconnect start or end to another box/point)
    const connHandleEl = e.target.closest('[data-conn-handle]');
    if (connHandleEl) {
      e.preventDefault();
      const connId = connHandleEl.dataset.connId;
      const which = connHandleEl.dataset.connHandle;
      // Grabbing a handle on a connection that's already part of a
      // multi-selection shouldn't collapse the rest of that selection.
      this.store.selectConnection(connId, { additive: this.store.connSelection.has(connId) });
      return this._begin(e, this._reconnectGesture(e, connId, which));
    }

    // 3. Direct endpoint grab on any connection (even before selecting)
    if (tool === 'select' || tool === 'connector') {
      const bp = this.viewport.eventToBoard(e);
      const epThresh = Math.max(16, 22 / this.viewport.scale);
      for (const conn of this.store.connections) {
        const a = this.app.connections?.endpointOf(conn, 'from');
        const b = this.app.connections?.endpointOf(conn, 'to');
        if (a && Math.hypot(bp.x - a.x, bp.y - a.y) <= epThresh) {
          e.preventDefault();
          this.store.selectConnection(conn.id, { additive: this.store.connSelection.has(conn.id) });
          return this._begin(e, this._reconnectGesture(e, conn.id, 'from'));
        }
        if (b && Math.hypot(bp.x - b.x, bp.y - b.y) <= epThresh) {
          e.preventDefault();
          this.store.selectConnection(conn.id, { additive: this.store.connSelection.has(conn.id) });
          return this._begin(e, this._reconnectGesture(e, conn.id, 'to'));
        }
      }
    }

    // 4. Resize / rotate handles (they live in the screen-space overlay)
    const handleEl = e.target.closest('[data-handle]');
    if (handleEl) {
      e.preventDefault();
      const kind = handleEl.dataset.handle;
      return this._begin(e, kind === 'rotate' ? this._rotateGesture(e) : this._resizeGesture(e, kind));
    }

    // 5. Connection ports
    const portEl = e.target.closest('.port');
    if (portEl) {
      e.preventDefault();
      const hostId = this.overlay.ports.dataset.elementId;
      return this._begin(e, this._connectGesture(e, hostId, portEl.dataset.port));
    }

    switch (tool) {
      case 'select':      return this._selectDown(e);
      case 'connector':   return this._connectorToolDown(e);
      case 'pen':
      case 'highlighter': e.preventDefault(); return this._begin(e, this._drawGesture(e, tool));
      case 'eraser':      e.preventDefault(); return this._begin(e, this._eraseGesture(e));
      case 'laser':       e.preventDefault(); return this._begin(e, this._laserGesture(e));
      case 'shape':
      case 'frame':       e.preventDefault(); return this._begin(e, this._createDragGesture(e, tool));
      case 'image':       return this.app.pickImage(this.viewport.eventToBoard(e));
      default:            e.preventDefault(); return this._clickCreate(e, tool);
    }
  }

  _selectDown(e) {
    // If clicking directly on an active contentEditable or editing label, let the caret work
    if (e.target.isContentEditable || e.target.closest?.('.is-editing')) return;

    // Check if clicked directly on a connection SVG element
    const connEl = e.target.closest('.conn');
    let hitConnId = connEl?.dataset.connId;

    // If not direct SVG target, check proximity to connection lines geometrically
    if (!hitConnId && !e.target.closest('.board-element')) {
      const bp = this.viewport.eventToBoard(e);
      const r = Math.max(12, 18 / this.viewport.scale);
      const threshSq = r * r;

      const distToSegSq = (px, py, x1, y1, x2, y2) => {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = x1 + t * dx, projY = y1 + t * dy;
        return (px - projX) * (px - projX) + (py - projY) * (py - projY);
      };

      for (const c of this.store.connections) {
        const a = this.app.connections?.endpointOf(c, 'from');
        const b = this.app.connections?.endpointOf(c, 'to');
        if (!a || !b) continue;
        if (c.routing === 'straight' || !c.routing) {
          if (distToSegSq(bp.x, bp.y, a.x, a.y, b.x, b.y) <= threshSq) {
            hitConnId = c.id;
            break;
          }
        } else {
          const pts = this.app.connections?._routePoints(a, b, c.routing);
          if (pts && pts.length >= 2) {
            let hit = false;
            for (let i = 0; i < pts.length - 1; i++) {
              if (distToSegSq(bp.x, bp.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= threshSq) {
                hit = true;
                break;
              }
            }
            if (hit) { hitConnId = c.id; break; }
          }
        }
      }
    }

    if (hitConnId) {
      e.preventDefault();
      const modifier = e.shiftKey || e.ctrlKey || e.metaKey;
      if (modifier && this.store.connSelection.has(hitConnId)) {
        this.store.toggleSelectConnection(hitConnId);
      } else {
        this.store.selectConnection(hitConnId, { additive: modifier });
      }
      if (this.store.connSelection.has(hitConnId)) this.app.showConnectionPanel(hitConnId);
      else this.app.hidePanels();
      this.overlay.sync();
      return;
    }

    const node = e.target.closest('.board-element');
    if (!node) {
      e.preventDefault();
      // Empty canvas:
      // If Ctrl/Cmd is held or canvasDragPans is enabled, pan;
      // Otherwise, standard cursor tool draws a selection box (marquee).
      if (this.app.settings.canvasDragPans || e.ctrlKey || e.metaKey) {
        return this._begin(e, this._panGesture(e));
      }
      return this._begin(e, this._marqueeGesture(e));
    }

    const id = node.dataset.elementId;
    const el = this.store.get(id);
    if (!el) return;

    // Dot voting consumes the click entirely while it is switched on.
    if (this.app.workshop?.voting) {
      e.preventDefault();
      this.app.workshop.handleClick(id, e.altKey || e.shiftKey);
      return;
    }

    if (el.locked) {
      e.preventDefault();
      this.store.select([id]);
      return;
    }

    // If clicking directly on a specific table cell, focus and edit that exact cell immediately
    const tableCell = e.target.closest('.tbl-cell-input, .el-table-cell');
    if (tableCell) {
      if (!this.store.selection.has(id)) this.store.select([id]);
      this.app.showPropertiesPanel();
      tableCell.focus();
      return;
    }

    // If the press landed on a label and turns out to be a click rather than
    // a drag, drop the caret straight into that label on release. Before
    // this, a fresh element needed one click to select and a second to edit,
    // and on a mind map — where nodes are small and sit close together —
    // the second click often landed on a neighbour instead.
    const editableLabel = e.target.closest('.editable');
    const wasAlreadySelected = this.store.selection.has(id);
    this._pendingEdit = editableLabel
      ? { id, label: editableLabel, at: { x: e.clientX, y: e.clientY } }
      : null;

    // A grouped object drags with the rest of its group unless you
    // explicitly add/remove it from the selection.
    const groupIds = el.groupId
      ? this.store.elements.filter(o => o.groupId === el.groupId).map(o => o.id)
      : [id];

    if (e.shiftKey || (e.metaKey && !e.altKey) || (e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      this.store.toggleSelect(id);
    } else if (!wasAlreadySelected) {
      e.preventDefault();
      this.store.select(groupIds);
    }

    this.app.showPropertiesPanel();

    if (!this.store.selection.size) return;

    // Start drag gesture
    this._begin(e, this._dragGesture(e, e.altKey, id));
  }

  _connectorToolDown(e) {
    e.preventDefault();
    const node = e.target.closest('.board-element');
    const id = node?.dataset.elementId || null;
    this._begin(e, this._connectGesture(e, id, 'auto'));
  }

  /* ================================================================
     GESTURE PLUMBING
     ================================================================ */

  _begin(e, gesture) {
    if (!gesture) return;
    this._gesture = gesture;
    this.mode = gesture.name;
    this._startScreen = this.viewport.eventToScreen(e);
    this._startClient = { x: e.clientX, y: e.clientY };
    this._lastMoveEv = null;
    this._moveRaf = null;
    this._moved = false;
    this._pointerId = e.pointerId;

    try { this.wrapper.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);

    if (gesture.start) gesture.start(e);
  }

  _onMove(e) {
    const g = this._gesture;
    if (!g) return;
    if (e.pointerId !== this._pointerId) return;

    this._lastMoveEv = e;

    if (!this._moved) {
      const d = Math.hypot(e.clientX - this._startClient.x, e.clientY - this._startClient.y);
      if (d < (g.threshold != null ? g.threshold : DRAG_THRESHOLD)) return;
      this._moved = true;
      if (g.firstMove) g.firstMove(e);
    }

    e.preventDefault();
    if (!this._moveRaf) {
      this._moveRaf = requestAnimationFrame(() => {
        this._moveRaf = null;
        if (this._gesture && this._lastMoveEv) {
          this._gesture.move(this._lastMoveEv);
          if (this._gesture.edgePan) this._edgePan(this._lastMoveEv);
        }
      });
    }
  }

  _onUp(e) {
    // A second finger lifting must not tear down a gesture the first one owns.
    if (e && e.pointerId != null && this._pointerId != null &&
        e.pointerId !== this._pointerId && e.type !== 'pointercancel') return;
    const g = this._gesture;
    if (this._moveRaf) {
      cancelAnimationFrame(this._moveRaf);
      this._moveRaf = null;
    }
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    try { this.wrapper.releasePointerCapture(this._pointerId); } catch (_) {}
    this._stopEdgePan();

    this._gesture = null;
    this.mode = 'idle';
    this.suppressOverlay = false;

    if (g && g.end) g.end(e, this._moved);

    // A press on a label that never became a drag is a request to type in
    // that exact label — honour it here, where we finally know it was a
    // click. Deferred a frame so the gesture's own commit lands first.
    const pending = this._pendingEdit;
    this._pendingEdit = null;
    if (pending && !this._moved && g && g.name === 'drag') {
      const el = this.store.get(pending.id);
      if (el && !el.locked && pending.label.isConnected &&
          !pending.label.classList.contains('is-editing')) {
        requestAnimationFrame(() =>
          this.renderer.beginEdit(pending.id, pending.label, null, { caretAt: pending.at }));
      }
    }

    this.overlay.clearGuides();
    this.overlay.sync();
  }

  cancelGesture() {
    if (!this._gesture) return;
    const g = this._gesture;
    this._gesture = null;
    this.mode = 'idle';
    this.suppressOverlay = false;
    if (g.cancel) g.cancel();
    this.overlay.clearGuides();
    this.overlay.hideMarquee();
    this.app.connections.hideDraft();
    this.overlay.sync();
  }

  /* ---- auto-pan when dragging toward a viewport edge ----------------- */

  _edgePan(e) {
    const s = this.viewport.eventToScreen(e);
    let dx = 0, dy = 0;
    if (s.x < EDGE_PAN_ZONE) dx = EDGE_PAN_SPEED * (1 - s.x / EDGE_PAN_ZONE);
    else if (s.x > this.viewport.width - EDGE_PAN_ZONE)
      dx = -EDGE_PAN_SPEED * (1 - (this.viewport.width - s.x) / EDGE_PAN_ZONE);
    if (s.y < EDGE_PAN_ZONE) dy = EDGE_PAN_SPEED * (1 - s.y / EDGE_PAN_ZONE);
    else if (s.y > this.viewport.height - EDGE_PAN_ZONE)
      dy = -EDGE_PAN_SPEED * (1 - (this.viewport.height - s.y) / EDGE_PAN_ZONE);

    if (!dx && !dy) return this._stopEdgePan();
    if (this._edgePanRaf) return;

    const step = () => {
      this.viewport.panBy(dx, dy);
      if (this._gesture) {
        this._gesture.move({ clientX: e.clientX, clientY: e.clientY,
                             shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey });
        this._edgePanRaf = requestAnimationFrame(step);
      } else this._edgePanRaf = null;
    };
    this._edgePanRaf = requestAnimationFrame(step);
  }

  _stopEdgePan() {
    if (this._edgePanRaf) cancelAnimationFrame(this._edgePanRaf);
    this._edgePanRaf = null;
  }

  /* ================================================================
     GESTURES
     ================================================================ */

  _panGesture(e) {
    const start = { x: e.clientX, y: e.clientY, vx: this.viewport.x, vy: this.viewport.y };
    this.wrapper.classList.add('is-panning');
    return {
      name: 'pan',
      threshold: 0,
      move: ev => {
        this.viewport.setTransform(
          start.vx + (ev.clientX - start.x),
          start.vy + (ev.clientY - start.y),
          this.viewport.scale
        );
      },
      end: () => this.wrapper.classList.remove('is-panning'),
    };
  }

  _marqueeGesture(e) {
    const origin = this.viewport.eventToScreen(e);
    const additive = e.shiftKey;
    // `base` used to be seeded from the live selection *after* it had already
    // been cleared, so a non-additive marquee could never start from empty.
    const base = additive ? new Set(this.store.selection) : new Set();
    if (!additive) { this.store.clearSelection(); this.app.hidePanels(); }

    return {
      name: 'marquee',
      move: ev => {
        const p = this.viewport.eventToScreen(ev);
        this.overlay.showMarquee(origin.x, origin.y, p.x, p.y);

        const a = this.viewport.screenToBoard(Math.min(origin.x, p.x), Math.min(origin.y, p.y));
        const b = this.viewport.screenToBoard(Math.max(origin.x, p.x), Math.max(origin.y, p.y));
        const box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };

        const hits = new Set(base);
        for (const el of this.store.elements) {
          if (el.locked || el.hidden) continue;
          const r = { x: el.x, y: el.y, w: el.width, h: el.height };
          // Touch-select (intersect) matches what people expect from Figma
          // far better than the old fully-contained test.
          if (Util.rectsIntersect(box, r)) hits.add(el.id);
        }
        this.store.select([...hits]);
      },
      end: (ev, moved) => {
        this.overlay.hideMarquee();
        if (!moved) { this.store.clearSelection(); this.app.hidePanels(); }
        else if (this.store.selection.size === 1) this.app.showPropertiesPanel();
      },
    };
  }

  _dragGesture(e, duplicate, leadId = null) {
    const self = this;
    let targets = this.store.selected().filter(el => !el.locked);

    // The nodes the user actually grabbed (not the auto-added descendants
    // below) get pinned on drop, so a manual move sticks through future
    // mind-map layout passes instead of only the whole dragged subtree.
    let directIds = new Set(targets.map(el => el.id));

    // Dragging a mind-map node carries its whole subtree, like every real
    // mind-mapping tool. Without this, moving a parent tore the tree apart.
    // Groups travel together for the same reason.
    const expanded = new Map();
    const groups = new Set(targets.map(el => el.groupId).filter(Boolean));
    for (const el of targets) {
      expanded.set(el.id, el);
      if (el.type === 'mindmap') {
        for (const id of this.app.mindmap.descendantIds(el.id)) {
          const d = this.store.get(id);
          if (d && !d.locked) expanded.set(id, d);
        }
      }
    }
    if (groups.size) {
      for (const el of this.store.elements) {
        if (el.locked || !el.groupId || !groups.has(el.groupId)) continue;
        expanded.set(el.id, el);
      }
    }
    targets = [...expanded.values()];
    if (!targets.length) return null;

    // Snapping is measured against the object you actually grabbed, not
    // whatever happened to be first in the selection set.
    const leadIdx = Math.max(0, targets.findIndex(t => t.id === leadId));
    if (leadIdx > 0) {
      const [lead] = targets.splice(leadIdx, 1);
      targets.unshift(lead);
    }

    const startBoard = this.viewport.eventToBoard(e);
    const origins = targets.map(el => ({ id: el.id, x: el.x, y: el.y }));

    // Snap candidates are captured ONCE per gesture, and only for what is
    // on screen. The old code rescanned every element on every frame.
    const view = this.viewport.visibleRect(400);
    const moving = new Set(targets.map(t => t.id));
    const candidates = this.store.elements.filter(el =>
      !moving.has(el.id) && !el.hidden &&
      Util.rectsIntersect(view, { x: el.x, y: el.y, w: el.width, h: el.height })
    ).map(el => ({
      left: el.x, right: el.x + el.width, cx: el.x + el.width / 2,
      top: el.y, bottom: el.y + el.height, cy: el.y + el.height / 2,
    }));

    let duplicated = false;
    const affected = () => targets.map(t => t.id);
    const apply = Util.rafThrottle(ev => this._applyDrag(ev, targets, origins, startBoard, candidates));

    return {
      name: 'drag',
      firstMove: () => {
        if (duplicate && !duplicated) {
          duplicated = true;
          const copies = self.app.duplicate(origins.map(o => o.id), 0, 0, { select: true, silent: true });
          if (copies.length) {
            const oldToNew = new Map(origins.map((o, i) => [o.id, copies[i]?.id]));
            targets = copies;
            origins.length = 0;
            copies.forEach(c => origins.push({ id: c.id, x: c.x, y: c.y }));
            directIds = new Set([...directIds].map(id => oldToNew.get(id)).filter(Boolean));
          }
        }
        self.wrapper.classList.add('is-dragging');
      },
      edgePan: true,
      move: ev => apply(ev),
      end: (ev, moved) => {
        // Flush (not just cancel) so the last in-flight frame's pointer
        // position is actually applied before we commit — otherwise a fast
        // drag can settle a frame behind the real release point.
        if (moved) apply.flush(ev); else apply.cancel();
        self.wrapper.classList.remove('is-dragging');
        self.overlay.clearGuides();
        if (!moved) return;
        for (const id of directIds) {
          const el = self.store.get(id);
          if (el && el.type === 'mindmap' && !el.mmRoot) el.mmPinned = true;
        }
        self.app.connections.refreshFor(affected());
        self.store.transact(duplicated ? 'duplicate' : 'move', () => {});
      },
    };
  }

  _applyDrag(ev, targets, origins, startBoard, candidates) {
    const bp = this.viewport.eventToBoard(ev);
    let dx = bp.x - startBoard.x;
    let dy = bp.y - startBoard.y;

    if (ev.shiftKey) {                      // constrain to one axis
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }

    // Alt is reserved for duplicate-while-dragging (it is what starts the
    // copy), so Ctrl/⌘ is what suspends snapping mid-drag. Previously Alt
    // meant both at once and the two fought each other.
    const snapOff = ev.ctrlKey || ev.metaKey;
    const settings = this.app.settings;
    const guides = [];

    if (!snapOff && settings.snapToGrid) {
      const g = settings.gridSize;
      const lead = origins[0];
      const targetX = lead.x + dx, targetY = lead.y + dy;
      dx += Math.round(targetX / g) * g - targetX;
      dy += Math.round(targetY / g) * g - targetY;
    }

    if (!snapOff && settings.snapToObjects && targets.length) {
      const lead = targets[0];
      const o = origins[0];
      const box = {
        left: o.x + dx, top: o.y + dy,
        right: o.x + dx + lead.width, bottom: o.y + dy + lead.height,
        cx: o.x + dx + lead.width / 2, cy: o.y + dy + lead.height / 2,
      };
      const tol = 6 / this.viewport.scale;

      let bestX = null, bestY = null;
      for (const c of candidates) {
        for (const [a, b, kind] of [
          [box.left, c.left, 'left'], [box.left, c.right, 'left'],
          [box.right, c.right, 'right'], [box.right, c.left, 'right'],
          [box.cx, c.cx, 'cx'],
        ]) {
          const d = b - a;
          if (Math.abs(d) <= tol && (bestX === null || Math.abs(d) < Math.abs(bestX.d))) {
            bestX = { d, at: b, strong: kind === 'cx' };
          }
        }
        for (const [a, b, kind] of [
          [box.top, c.top, 'top'], [box.top, c.bottom, 'top'],
          [box.bottom, c.bottom, 'bottom'], [box.bottom, c.top, 'bottom'],
          [box.cy, c.cy, 'cy'],
        ]) {
          const d = b - a;
          if (Math.abs(d) <= tol && (bestY === null || Math.abs(d) < Math.abs(bestY.d))) {
            bestY = { d, at: b, strong: kind === 'cy' };
          }
        }
      }
      if (bestX) { dx += bestX.d; guides.push({ axis: 'v', at: bestX.at, strong: bestX.strong }); }
      if (bestY) { dy += bestY.d; guides.push({ axis: 'h', at: bestY.at, strong: bestY.strong }); }
    }

    for (let i = 0; i < targets.length; i++) {
      const el = targets[i];
      el.x = origins[i].x + dx;
      el.y = origins[i].y + dy;
      this.renderer.place(el);          // one transform write — no layout
    }

    this.overlay.setGuides(guides);
    this.app.connections.refreshFor(targets.map(t => t.id));
    this.overlay.sync();
    this.store.touch();
  }

  _resizeGesture(e, handle) {
    const sel = this.store.selected().filter(el => !el.locked);
    if (!sel.length) return null;

    const multi = sel.length > 1;
    const bounds = Util.boundsOf(sel);
    const start = {
      board: this.viewport.eventToBoard(e),
      bounds,
      items: sel.map(el => ({ id: el.id, x: el.x, y: el.y, w: el.width, h: el.height })),
    };
    const rotation = multi ? 0 : (sel[0].rotation || 0);

    const apply = Util.rafThrottle(ev => {
      const bp = this.viewport.eventToBoard(ev);
      let dx = bp.x - start.board.x;
      let dy = bp.y - start.board.y;

      // For a rotated element, translate the pointer delta into its own axes.
      if (rotation) {
        const r = -rotation * Math.PI / 180;
        const rx = dx * Math.cos(r) - dy * Math.sin(r);
        const ry = dx * Math.sin(r) + dy * Math.cos(r);
        dx = rx; dy = ry;
      }

      const min = 24;
      let nx = start.bounds.x, ny = start.bounds.y;
      let nw = start.bounds.w, nh = start.bounds.h;

      if (handle.includes('e')) nw = Math.max(min, start.bounds.w + dx);
      if (handle.includes('w')) { nw = Math.max(min, start.bounds.w - dx); nx = start.bounds.x + start.bounds.w - nw; }
      if (handle.includes('s')) nh = Math.max(min, start.bounds.h + dy);
      if (handle.includes('n')) { nh = Math.max(min, start.bounds.h - dy); ny = start.bounds.y + start.bounds.h - nh; }

      const corner = handle.length === 2;
      const keepRatio = corner && (ev.shiftKey || multi || this.app.settings.lockAspect);
      if (keepRatio && start.bounds.w && start.bounds.h) {
        const ratio = start.bounds.w / start.bounds.h;
        if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
        if (handle.includes('w')) nx = start.bounds.x + start.bounds.w - nw;
        if (handle.includes('n')) ny = start.bounds.y + start.bounds.h - nh;
      }

      const sx = nw / (start.bounds.w || 1);
      const sy = nh / (start.bounds.h || 1);

      /* A rotated element is drawn about its own centre, so growing it in
         local space also swings that centre around in world space. Undo that
         swing here, otherwise a rotated box slides away from the pointer as
         soon as you touch a handle — the "resize jumps" bug. */
      let ox = 0, oy = 0;
      if (rotation) {
        const c0x = start.bounds.x + start.bounds.w / 2;
        const c0y = start.bounds.y + start.bounds.h / 2;
        const clx = nx + nw / 2, cly = ny + nh / 2;
        const r = rotation * Math.PI / 180;
        const ddx = clx - c0x, ddy = cly - c0y;
        ox = (ddx * Math.cos(r) - ddy * Math.sin(r)) - ddx;
        oy = (ddx * Math.sin(r) + ddy * Math.cos(r)) - ddy;
      }

      for (const it of start.items) {
        const el = this.store.get(it.id);
        if (!el) continue;
        // A live block has controls of its own — a run button, a gate
        // palette, a panel grid — and 24px is enough room for none of them.
        // Below its own floor it stops being resized and starts being
        // broken, so each type sets one.
        const floor = (window.MIN_SIZE || {})[el.type] || { width: min, height: min };
        el.x = nx + (it.x - start.bounds.x) * sx + ox;
        el.y = ny + (it.y - start.bounds.y) * sy + oy;
        el.width  = Math.max(floor.width, it.w * sx);
        el.height = Math.max(floor.height, it.h * sy);
        this.renderer.place(el);
        if (el.type === 'graph') {
          const canvas = this.renderer.node(el.id)?.querySelector('canvas');
          if (canvas) this.app.charts.draw(el, canvas);
        }
      }

      this.app.connections.refreshFor(start.items.map(i => i.id));
      this.overlay.sync();
      this.app.updatePropertiesPanel();
      this.store.touch();
    });

    return {
      name: 'resize',
      threshold: 0,
      move: apply,
      end: (ev, moved) => {
        if (moved) apply.flush(ev); else apply.cancel();
        if (!moved) return;
        for (const it of start.items) {
          const el = this.store.get(it.id);
          if (el) this.renderer.patch(el);   // re-flow inner content once
        }
        this.app.connections.refreshFor(start.items.map(i => i.id));
        this.store.transact('resize', () => {});
      },
    };
  }

  _rotateGesture(e) {
    const el = this.store.selected()[0];
    if (!el || el.locked) return null;
    const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    const startAngle = el.rotation || 0;
    const bp = this.viewport.eventToBoard(e);
    const grabAngle = Math.atan2(bp.y - center.y, bp.x - center.x) * 180 / Math.PI;

    const apply = Util.rafThrottle(ev => {
      const p = this.viewport.eventToBoard(ev);
      let angle = startAngle + (Math.atan2(p.y - center.y, p.x - center.x) * 180 / Math.PI - grabAngle);
      if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
      angle = ((angle % 360) + 360) % 360;
      el.rotation = angle;
      this.renderer.place(el);
      this.app.connections.refreshFor([el.id]);
      this.overlay.sync();
      this.store.touch();
    });

    return {
      name: 'rotate',
      threshold: 0,
      move: apply,
      end: (ev, moved) => {
        if (moved) { apply.flush(ev); this.store.transact('rotate', () => {}); }
        else apply.cancel();
      },
    };
  }

  _drawGesture(e, tool) {
    const ink = this.app.ink;
    const settings = this.app.settings;
    const bp = this.viewport.eventToBoard(e);
    const opts = tool === 'highlighter'
      ? { color: settings.highlighterColor, width: settings.highlighterWidth, tool: 'highlighter' }
      : { color: settings.penColor, width: settings.penWidth, tool: 'pen' };

    ink.begin(bp.x, bp.y, opts);
    this.store.clearSelection();

    return {
      name: 'draw',
      threshold: 0,
      edgePan: true,
      move: ev => {
        // Coalesced events give a much smoother line on high-rate pointers.
        const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
        for (const p of events) {
          const b = this.viewport.eventToBoard(p);
          ink.extend(b.x, b.y);
        }
      },
      end: () => {
        const stroke = ink.end();
        // Smart shapes: a rough rectangle / ellipse / triangle / line drawn
        // with the pen becomes the real object it was clearly meant to be.
        if (tool === 'pen') this.app.shapes?.apply(stroke);
      },
      cancel: () => ink.cancel(),
    };
  }

  _eraseGesture(e) {
    const ink = this.app.ink;
    const settings = this.app.settings;
    const removedStrokes = new Set();
    const deletedConns = new Set();
    const deletedEls = new Set();

    const distToSegSq = (px, py, x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
      let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const projX = x1 + t * dx, projY = y1 + t * dy;
      return (px - projX) * (px - projX) + (py - projY) * (py - projY);
    };

    const doErase = ev => {
      const bp = this.viewport.eventToBoard(ev);
      const r = Math.max(8, (settings.eraserSize || 18) / this.viewport.scale);
      const threshSq = (r + 6) * (r + 6);

      // 1. Ink strokes
      for (const id of ink.hitStrokes(bp.x, bp.y, r)) removedStrokes.add(id);
      if (removedStrokes.size) {
        this.store.removeStrokes([...removedStrokes], { silent: true });
        ink.redraw();
      }

      // 2. Shaped lines & connection lines
      for (const conn of this.store.connections) {
        if (deletedConns.has(conn.id)) continue;
        const a = this.app.connections?.endpointOf(conn, 'from');
        const b = this.app.connections?.endpointOf(conn, 'to');
        if (!a || !b) continue;

        if (conn.routing === 'straight' || !conn.routing) {
          if (distToSegSq(bp.x, bp.y, a.x, a.y, b.x, b.y) <= threshSq) {
            deletedConns.add(conn.id);
          }
        } else {
          const pts = this.app.connections?._routePoints(a, b, conn.routing);
          if (pts && pts.length >= 2) {
            for (let i = 0; i < pts.length - 1; i++) {
              if (distToSegSq(bp.x, bp.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= threshSq) {
                deletedConns.add(conn.id);
                break;
              }
            }
          }
        }
      }

      // 3. Check elements under eraser cursor (DOM-based hit testing)
      const elementsUnder = document.elementsFromPoint ? document.elementsFromPoint(ev.clientX, ev.clientY) : [];
      for (const node of elementsUnder) {
        const connEl = node.closest?.('.conn');
        if (connEl?.dataset.connId) {
          deletedConns.add(connEl.dataset.connId);
        }
        const boardEl = node.closest?.('.board-element');
        if (boardEl?.dataset.elementId) {
          const el = this.store.get(boardEl.dataset.elementId);
          if (el && !el.locked && (el.type === 'shape' || settings.eraseObjects)) {
            deletedEls.add(el.id);
          }
        }
      }

      // 4. Also check shape elements by geometric proximity
      for (const el of this.store.elements) {
        if (deletedEls.has(el.id) || el.locked || el.type !== 'shape') continue;
        const ex = el.x, ey = el.y, ew = el.width, eh = el.height;
        // Check if eraser center is near perimeter or inside shape
        const nearX = Math.max(ex, Math.min(bp.x, ex + ew));
        const nearY = Math.max(ey, Math.min(bp.y, ey + eh));
        const dSq = (bp.x - nearX) * (bp.x - nearX) + (bp.y - nearY) * (bp.y - nearY);
        if (dSq <= threshSq) {
          deletedEls.add(el.id);
        }
      }

      // Apply live removals so they disappear under the eraser stroke
      if (deletedConns.size) {
        for (const cid of deletedConns) this.app.connections?.remove(cid);
        this.store.removeConnections([...deletedConns], { silent: true });
      }
      if (deletedEls.size) {
        for (const eid of deletedEls) this.renderer.unmount(eid);
        this.store.removeElements([...deletedEls], { silent: true });
      }
    };

    doErase(e);
    return {
      name: 'erase',
      threshold: 0,
      move: doErase,
      end: () => {
        if (removedStrokes.size || deletedConns.size || deletedEls.size) {
          this.store.transact('erase', () => {});
        }
      },
    };
  }

  _laserGesture(e) {
    const trail = [];
    const layer = this.app.laser;
    const push = ev => {
      const b = this.viewport.eventToBoard(ev);
      trail.push({ x: b.x, y: b.y, t: performance.now() });
      layer.set(trail);
    };
    push(e);
    return { name: 'laser', threshold: 0, move: push, end: () => layer.fade() };
  }

  _createDragGesture(e, tool) {
    const startBP = this.viewport.eventToBoard(e);
    const settings = this.app.settings;
    let el = null;

    const spec = tool === 'shape'
      ? { type: 'shape', props: { shapeType: settings.shapeType, style: { backgroundColor: settings.shapeFill, borderColor: settings.shapeStroke, borderWidth: settings.shapeStrokeWidth } } }
      : { type: 'frame', props: { content: 'Frame ' + (this.store.elements.filter(x => x.type === 'frame').length + 1) } };

    return {
      name: 'create',
      threshold: 0,
      firstMove: () => {
        el = this.store.addElement(spec.type, { x: startBP.x, y: startBP.y, width: 1, height: 1, ...spec.props }, { silent: true });
      },
      move: ev => {
        if (!el) return;
        const bp = this.viewport.eventToBoard(ev);
        let w = bp.x - startBP.x, h = bp.y - startBP.y;
        if (ev.shiftKey) {
          const s = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s;
        }
        el.x = w < 0 ? startBP.x + w : startBP.x;
        el.y = h < 0 ? startBP.y + h : startBP.y;
        el.width = Math.max(Math.abs(w), 1);
        el.height = Math.max(Math.abs(h), 1);
        this.renderer.place(el);
        this.store.touch();
      },
      end: (ev, moved) => {
        if (!el) {
          // A plain click drops a default-sized object where you clicked.
          const d = ELEMENT_DEFAULTS[spec.type];
          el = this.store.addElement(spec.type, {
            x: startBP.x - d.width / 2, y: startBP.y - d.height / 2,
            width: d.width, height: d.height, ...spec.props,
          }, { silent: true });
        } else if (el.width < 8 && el.height < 8) {
          const d = ELEMENT_DEFAULTS[spec.type];
          el.width = d.width; el.height = d.height;
        }
        this.renderer.patch(el);
        this.store.select([el.id]);
        this.store.transact('create ' + spec.type, () => {});
        this.app.showPropertiesPanel();
        if (!this.app.settings.stickyTool) this.app.setTool('select');
      },
    };
  }

  _findConnectTarget(bp, excludeId = null) {
    // Search in reverse z-index order (topmost first)
    const els = this.store.elements.slice().sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
    for (const el of els) {
      if (el.locked || el.hidden || el.id === excludeId) continue;
      const pad = 16;
      if (bp.x >= el.x - pad && bp.x <= el.x + el.width + pad &&
          bp.y >= el.y - pad && bp.y <= el.y + el.height + pad) {
        return el;
      }
    }
    return null;
  }

  _connectGesture(e, hostId, port) {
    const store = this.store;
    const conns = this.app.connections;
    const host = hostId ? store.get(hostId) : null;
    const startBP = this.viewport.eventToBoard(e);
    const routing = this.app.settings.connectorRouting;

    const startPoint = host
      ? conns.portPoint(host, port === 'auto' ? conns.autoPort(host, startBP) : port)
      : { x: startBP.x, y: startBP.y, dir: PORT_DIRS.center };

    let hoverId = null;
    let hoverPort = 'auto';
    this.suppressOverlay = true;
    this.overlay.hidePorts();

    const updatePreview = ev => {
      const bp = this.viewport.eventToBoard(ev);
      const target = this._findConnectTarget(bp, hostId);
      const overId = target?.id || null;

      let endPoint;
      if (overId) {
        if (hoverId && hoverId !== overId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        hoverId = overId;
        hoverPort = conns.autoPort(target, startPoint);
        endPoint = conns.portPoint(target, hoverPort);
        this.renderer.node(overId)?.classList.add('is-connect-target');
      } else {
        if (hoverId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        hoverId = null;
        endPoint = { x: bp.x, y: bp.y, dir: PORT_DIRS.center };
      }
      conns.showDraft(startPoint, endPoint, routing);
    };

    const apply = Util.rafThrottle(updatePreview);

    return {
      name: 'connect',
      threshold: 0,
      edgePan: true,
      move: apply,
      end: (ev, moved) => {
        apply.cancel();
        conns.hideDraft();
        if (hoverId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        this.suppressOverlay = false;

        if (!moved) {
          this.overlay.sync();
          return;
        }

        const bp = this.viewport.eventToBoard(ev);
        const finalTarget = this._findConnectTarget(bp, hostId);
        const from = host ? { id: host.id, port: port || 'auto' } : { id: null, port: 'free', x: startBP.x, y: startBP.y };
        let to;
        if (finalTarget) {
          const finalPort = conns.autoPort(finalTarget, startPoint);
          to = { id: finalTarget.id, port: finalPort || 'auto' };
        } else {
          to = { id: null, port: 'free', x: bp.x, y: bp.y };
        }

        if (!from.id && !to.id && Math.hypot(bp.x - startBP.x, bp.y - startBP.y) < 8) return;

        const conn = store.addConnection({
          from, to,
          routing,
          arrowEnd: this.app.settings.connectorArrowEnd,
          arrowStart: this.app.settings.connectorArrowStart,
          style: {
            color: this.app.settings.connectorColor,
            width: this.app.settings.connectorWidth,
            dash: this.app.settings.connectorDash,
          },
        });
        store.selectConnection(conn.id);
        this.app.showConnectionPanel(conn.id);
        this.overlay.sync();
        if (!this.app.settings.stickyTool && this.tool === 'connector') this.app.setTool('select');
      },
      cancel: () => {
        apply.cancel();
        conns.hideDraft();
        if (hoverId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        this.suppressOverlay = false;
        this.overlay.sync();
      },
    };
  }

  _reconnectGesture(e, connId, which) {
    const store = this.store;
    const conns = this.app.connections;
    const conn = store.getConnection(connId);
    if (!conn) return { name: 'noop' };

    const fixedEnd = which === 'from' ? 'to' : 'from';
    const fixedPt = conns.endpointOf(conn, fixedEnd);
    if (!fixedPt) return { name: 'noop' };

    const routing = conn.routing || this.app.settings.connectorRouting || 'orthogonal';
    const color = conn.style?.color || '#4262ff';
    const fixedTargetId = conn[fixedEnd]?.id || null;

    let hoverId = null;
    let hoverPort = 'auto';
    this.suppressOverlay = true;

    // Temporarily hide original SVG connection group during reconnect drag
    const origGroup = conns.groups.get(connId);
    if (origGroup) origGroup.style.display = 'none';

    const updatePreview = ev => {
      const bp = this.viewport.eventToBoard(ev);
      const target = this._findConnectTarget(bp, fixedTargetId);
      const overId = target?.id || null;

      let dragPt;
      if (overId) {
        if (hoverId && hoverId !== overId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        hoverId = overId;
        hoverPort = conns.autoPort(target, fixedPt);
        dragPt = conns.portPoint(target, hoverPort);
        this.renderer.node(overId)?.classList.add('is-connect-target');
      } else {
        if (hoverId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        hoverId = null;
        dragPt = { x: bp.x, y: bp.y, dir: PORT_DIRS.center };
      }

      if (which === 'to') {
        conns.showDraft(fixedPt, dragPt, routing, color);
      } else {
        conns.showDraft(dragPt, fixedPt, routing, color);
      }
    };

    const apply = Util.rafThrottle(updatePreview);

    return {
      name: 'reconnect',
      threshold: 0,
      edgePan: true,
      move: apply,
      end: (ev, moved) => {
        apply.cancel();
        conns.hideDraft();
        if (origGroup) origGroup.style.display = '';
        if (hoverId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        this.suppressOverlay = false;

        if (!moved) {
          this.overlay.sync();
          return;
        }

        const bp = this.viewport.eventToBoard(ev);
        const finalTarget = this._findConnectTarget(bp, fixedTargetId);
        let newEndpoint;
        if (finalTarget) {
          const finalPort = conns.autoPort(finalTarget, fixedPt);
          newEndpoint = { id: finalTarget.id, port: finalPort || 'auto' };
        } else {
          newEndpoint = { id: null, port: 'free', x: bp.x, y: bp.y };
        }

        store.transact('reconnect', () => {
          store.updateConnection(connId, { [which]: newEndpoint });
        });
        this.overlay.sync();
        Modal.toast(finalTarget ? `Connected to ${finalTarget.type}.` : 'Connection endpoint updated.', 'success', 1500);
      },
      cancel: () => {
        apply.cancel();
        conns.hideDraft();
        if (origGroup) origGroup.style.display = '';
        if (hoverId) this.renderer.node(hoverId)?.classList.remove('is-connect-target');
        this.suppressOverlay = false;
        this.overlay.sync();
      },
    };
  }

  /* ================================================================
     CLICK-TO-CREATE TOOLS
     ================================================================ */

  _clickCreate(e, tool) {
    const bp = this.viewport.eventToBoard(e);
    const el = this.app.createAt(tool, bp.x, bp.y);
    if (!el) return;
    this.store.select([el.id]);
    this.app.showPropertiesPanel();
    if (!this.app.settings.stickyTool) this.app.setTool('select');

    // Drop straight into typing for text-first elements.
    if (['sticky-note', 'text', 'flowchart', 'mindmap', 'comment'].includes(el.type)) {
      requestAnimationFrame(() => {
        const label = this.renderer.node(el.id)?.querySelector('.editable');
        if (label) this.renderer.beginEdit(el.id, label);
      });
    }
  }

  /* ================================================================
     ELEMENT INLINE ACTIONS
     ================================================================ */

  _runElementAction(btn, e) {
    const node = btn.closest('.board-element');
    const id = node?.dataset.elementId;
    const el = id ? this.store.get(id) : null;
    if (!el) return;

    if (btn.dataset.action === 'attachments') {
      return this.app.attachments?.showPopover(el.id, btn);
    }
    if (btn.dataset.action === 'frame-owners') {
      return this.app.frames?.openAssignPanel(el.id, btn);
    }

    if (btn.dataset.mmAction === 'add' || btn.dataset.mmAction === 'add-child') {
      return this.app.mindmap.addChild(el.id);
    }
    if (btn.dataset.mmAction === 'add-sibling') {
      return this.app.mindmap.addSibling(el.id);
    }
    if (btn.dataset.mmAction === 'collapse') {
      return this.app.mindmap.toggleCollapse(el.id);
    }

    switch (btn.dataset.action) {
      case 'edit-algorithm': return this.app.algorithm.open(el.id);
      case 'edit-graph':     return this.app.charts.openEditor(el.id);
      case 'resolve-comment':
        return this.store.updateElement(el.id, { resolved: !el.resolved });
      case 'check-toggle': {
        const i = +btn.dataset.index;
        const items = (el.items || []).slice();
        items[i] = { ...items[i], done: !items[i].done };
        return this.store.updateElement(el.id, { items });
      }
      case 'check-remove': {
        const i = +btn.dataset.index;
        const items = (el.items || []).slice();
        items.splice(i, 1);
        return this.store.updateElement(el.id, { items });
      }
      case 'check-add': {
        const items = (el.items || []).concat([{ text: '', done: false }]);
        this.store.updateElement(el.id, { items });
        requestAnimationFrame(() => {
          const rows = this.renderer.node(el.id)?.querySelectorAll('.el-check-text');
          const last = rows?.[rows.length - 1];
          if (last) { last.contentEditable = 'true'; last.focus(); }
        });
        return;
      }
      case 'table-add-row': case 'table-add-col':
      case 'table-del-row': case 'table-del-col':
      case 'table-clear':
        return this.app.editTable(el.id, btn.dataset.action);
    }
  }

  /* ================================================================
     DOUBLE-CLICK / CONTEXT MENU / WHEEL / TOUCH
     ================================================================ */

  _onDoubleClick(e) {
    if (e.target.isContentEditable) return;

    const connEl = e.target.closest('.conn');
    if (connEl) {
      e.preventDefault();
      return this.app.promptConnectionLabel(connEl.dataset.connId);
    }

    const node = e.target.closest('.board-element');
    if (node) {
      const id = node.dataset.elementId;
      const el = this.store.get(id);
      if (!el) return;

      if (el.type === 'algorithm') {
        e.preventDefault();
        return this.app.algorithm?.open(id);
      }
      if (el.type === 'graph') {
        e.preventDefault();
        return this.app.charts?.openEditor(id);
      }

      const tableCell = e.target.closest('.tbl-cell-input, .el-table-cell');
      if (tableCell) {
        e.preventDefault();
        tableCell.focus();
        const range = document.createRange();
        range.selectNodeContents(tableCell);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }

      const clickedEditable = e.target.closest('.editable');
      const label = clickedEditable || node.querySelector('.editable');
      if (label && !label.classList.contains('is-editing')) {
        e.preventDefault();
        this.renderer.beginEdit(id, label);
      }
      return;
    }

    // Never add text field on double-click of empty canvas
  }

  _onContextMenu(e) {
    e.preventDefault();
    const node = e.target.closest('.board-element');
    if (node) {
      const id = node.dataset.elementId;
      if (!this.store.selection.has(id)) this.store.select([id]);
    }
    const connEl = e.target.closest('.conn');
    if (connEl) this.store.selectConnection(connEl.dataset.connId);
    this.app.openContextMenu(e.clientX, e.clientY, { onElement: !!node, onConnection: !!connEl });
  }

  _onWheel(e) {
    e.preventDefault();
    const s = this.viewport.eventToScreen(e);

    // Ctrl/⌘ + wheel, or a pinch on a trackpad, zooms. Plain wheel scrolls.
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      this.viewport.zoomBy(factor, s.x, s.y);
      return;
    }
    if (e.shiftKey) { this.viewport.panBy(-e.deltaY, 0); return; }
    this.viewport.panBy(-e.deltaX, -e.deltaY);
  }

  _onTouchStart(e) {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    this.cancelGesture();
    const [a, b] = e.touches;
    this._touchState = {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
    };
  }

  _onTouchMove(e) {
    if (e.touches.length !== 2 || !this._touchState) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const cx = (a.clientX + b.clientX) / 2;
    const cy = (a.clientY + b.clientY) / 2;
    const r = this.wrapper.getBoundingClientRect();

    this.viewport.panBy(cx - this._touchState.cx, cy - this._touchState.cy);
    if (this._touchState.dist > 0) {
      this.viewport.zoomBy(dist / this._touchState.dist, cx - r.left, cy - r.top);
    }
    this._touchState = { dist, cx, cy };
  }
}

/* ================================================================
   LaserPointer — presentation-mode trail on its own canvas
   ================================================================ */
class LaserPointer {
  constructor(app) {
    this.app = app;
    this.canvas = document.getElementById('laser-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.trail = [];
    this._raf = null;
    this.resize();
    app.viewport.on('resize', () => this.resize());
    app.viewport.on('applied', () => this._draw());
  }

  resize() {
    const w = this.app.viewport.width, h = this.app.viewport.height;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  set(points) {
    this.trail = points;
    if (!this._raf) this._loop();
  }

  fade() { /* the loop expires points on its own */ }

  _loop() {
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      const now = performance.now();
      this.trail = this.trail.filter(p => now - p.t < 900);
      this._draw();
      if (this.trail.length) this._loop();
    });
  }

  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.trail.length) return;
    const d = this.dpr;
    const vp = this.app.viewport;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const now = performance.now();
    for (let i = 1; i < this.trail.length; i++) {
      const p0 = this.trail[i - 1], p1 = this.trail[i];
      const age = (now - p1.t) / 900;
      const s0 = vp.boardToScreen(p0.x, p0.y);
      const s1 = vp.boardToScreen(p1.x, p1.y);
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.strokeStyle = '#ff2d55';
      ctx.lineWidth = 5 * (1 - age * 0.6);
      ctx.shadowColor = '#ff2d55';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
}

window.Interaction = Interaction;
window.LaserPointer = LaserPointer;
