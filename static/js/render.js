/* ================================================================
   render.js — element DOM renderer + screen-space selection overlay
   ================================================================
   Renderer keeps a Map<id, node> so dragging never touches the DOM
   beyond a single `style.transform` write per element per frame.
   The old code called document.querySelector inside the drag loop and
   rebuilt whole nodes on every property change — that was most of the
   "movement is laggy" problem.
   ================================================================ */

/* ---------- shape geometry, drawn in a 0..100 viewBox ------------- */
const SHAPE_PATHS = {
  rectangle:     () => 'M2,2 L98,2 L98,98 L2,98 Z',
  rounded:       () => 'M14,2 L86,2 Q98,2 98,14 L98,86 Q98,98 86,98 L14,98 Q2,98 2,86 L2,14 Q2,2 14,2 Z',
  circle:        () => 'M50,2 A48,48 0 1,1 49.9,2 Z',
  diamond:       () => 'M50,2 L98,50 L50,98 L2,50 Z',
  triangle:      () => 'M50,3 L97,97 L3,97 Z',
  pentagon:      () => 'M50,2 L97,37 L79,95 L21,95 L3,37 Z',
  hexagon:       () => 'M25,4 L75,4 L98,50 L75,96 L25,96 L2,50 Z',
  star:          () => 'M50,3 L61,37 L97,37 L68,58 L79,93 L50,71 L21,93 L32,58 L3,37 L39,37 Z',
  parallelogram: () => 'M22,6 L98,6 L78,94 L2,94 Z',
  trapezoid:     () => 'M22,6 L78,6 L98,94 L2,94 Z',
  arrowRight:    () => 'M2,32 L60,32 L60,8 L98,50 L60,92 L60,68 L2,68 Z',
  arrowLeft:     () => 'M98,32 L40,32 L40,8 L2,50 L40,92 L40,68 L98,68 Z',
  cross:         () => 'M35,2 L65,2 L65,35 L98,35 L98,65 L65,65 L65,98 L35,98 L35,65 L2,65 L2,35 L35,35 Z',
  cylinder:      () => 'M2,14 A48,12 0 0,1 98,14 L98,86 A48,12 0 0,1 2,86 Z',
  cloud:         () => 'M25,80 A20,20 0 0,1 25,42 A24,24 0 0,1 70,34 A18,18 0 0,1 78,80 Z',
  heart:         () => 'M50,92 C10,62 4,36 22,22 C36,11 50,22 50,32 C50,22 64,11 78,22 C96,36 90,62 50,92 Z',
  speech:        () => 'M6,6 L94,6 L94,72 L44,72 L24,94 L26,72 L6,72 Z',
};

/* ---------- flowchart node geometry ------------------------------ */
const FLOWCHART_PATHS = {
  process:   () => 'M2,2 L98,2 L98,98 L2,98 Z',
  decision:  () => 'M50,2 L98,50 L50,98 L2,50 Z',
  startend:  () => 'M25,2 L75,2 A24,48 0 0,1 75,98 L25,98 A24,48 0 0,1 25,2 Z',
  data:      () => 'M22,2 L98,2 L78,98 L2,98 Z',
  document:  () => 'M2,2 L98,2 L98,84 Q75,100 50,88 Q25,76 2,90 Z',
  manual:    () => 'M14,2 L86,2 L98,98 L2,98 Z',
  database:  () => 'M2,16 A48,14 0 0,1 98,16 L98,84 A48,14 0 0,1 2,84 Z',
  prep:      () => 'M20,2 L80,2 L98,50 L80,98 L20,98 L2,50 Z',
  connector: () => 'M50,2 A48,48 0 1,1 49.9,2 Z',
  delay:     () => 'M2,2 L64,2 A48,48 0 0,1 64,98 L2,98 Z',
};

const FLOWCHART_LABELS = {
  process: 'Process', decision: 'Decision?', startend: 'Start', data: 'Data',
  document: 'Document', manual: 'Manual', database: 'Database',
  prep: 'Prepare', connector: 'A', delay: 'Delay',
};

const NS = 'http://www.w3.org/2000/svg';

class Renderer {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.layer = document.getElementById('elements-layer');
    /** @type {Map<string, HTMLElement>} */
    this.nodes = new Map();

    this.store.on('element:add',    el => { this.mount(el); this.place(el); });
    this.store.on('element:update', el => this.patch(el));
    this.store.on('element:remove', id => this.unmount(id));
    this.store.on('reload',         () => this.rebuildAll());
  }

  node(id) { return this.nodes.get(id) || null; }

  rebuildAll() {
    // Opening another board drops every node at once. Clearing the layer
    // detaches them but does not stop what they started: a dashboard's
    // refresh timer would keep polling Google for a board that is no
    // longer open, and a code cell would keep listening for kernel
    // status. Dispose them the same way unmount() does.
    for (const node of this.nodes.values()) {
      try { node.__live?.destroy?.(); } catch (err) { console.error('[live] destroy', err); }
    }
    this.layer.textContent = '';
    this.nodes.clear();
    for (const el of this.store.elements) { this.mount(el); this.place(el); }
  }

  /* ---- lifecycle -------------------------------------------------- */

  mount(el) {
    const node = document.createElement('div');
    node.className = 'board-element type-' + el.type;
    node.dataset.elementId = el.id;
    this.nodes.set(el.id, node);
    this.layer.appendChild(node);
    this.renderBody(el, node);
    return node;
  }

  unmount(id) {
    const node = this.nodes.get(id);
    if (node) {
      // A live widget may hold a poll timer, a Pyodide handle or a document
      // listener. Dropping the node alone would leak all three.
      try { node.__live?.destroy?.(); } catch (err) { console.error('[live] destroy', err); }
      node.remove();
    }
    this.nodes.delete(id);
  }

  /** Cheap path — geometry only. Safe to call every animation frame. */
  place(el) {
    const node = this.nodes.get(el.id);
    if (!node) return;
    node.style.transform = el.rotation
      ? `translate3d(${el.x}px, ${el.y}px, 0) rotate(${el.rotation}deg)`
      : `translate3d(${el.x}px, ${el.y}px, 0)`;
    if (node._w !== el.width) { node.style.width = el.width + 'px'; node._w = el.width; }
    if (node._h !== el.height) { node.style.height = el.height + 'px'; node._h = el.height; }
    if (node._z !== el.zIndex) { node.style.zIndex = el.zIndex || 1; node._z = el.zIndex; }
    if (node._op !== el.style?.opacity) {
      node.style.opacity = el.style?.opacity != null ? el.style.opacity : 1;
      node._op = el.style?.opacity;
    }
    node.classList.toggle('is-locked', !!el.locked);
    node.classList.toggle('is-hidden', !!el.hidden);
  }

  /** Full path — rebuilds inner content, then geometry. */
  patch(el) {
    let node = this.nodes.get(el.id);
    if (!node) {
      node = this.mount(el);
    } else {
      // Do not wipe out DOM if user is actively typing inside an editable text/cell
      const activeText = document.activeElement &&
        (document.activeElement.classList?.contains('is-editing') || document.activeElement.isContentEditable) &&
        node.contains(document.activeElement);

      if (activeText) {
        const container = node.querySelector('.el-table-container');
        if (container && el.tableTheme) {
          container.className = `el-table-container theme-${el.tableTheme}`;
        }
        this.place(el);
        return;
      }
      this.renderBody(el, node);
    }
    this.place(el);
  }

  /* ---- body construction ------------------------------------------ */

  renderBody(el, node) {
    /* ---- live widgets ------------------------------------------------
       Code cells, logic circuits and sheet dashboards own the DOM inside
       their node and carry state the model does not: a caret position, a
       half-drawn wire, a running Python kernel, a refresh timer. Wiping
       and rebuilding them on every unrelated store change — someone else
       dragging a sticky, an autosave — would destroy that mid-use, which
       is what makes an embedded editor feel broken rather than slow.

       So they are built once and updated in place. `node.__live` is the
       contract: a widget publishes { type, update, destroy }. Anything
       else falls through to the normal rebuild below.
       ------------------------------------------------------------------ */
    const live = node.__live;
    if (live && live.type === el.type) {
      for (const b of node.querySelectorAll(':scope > .el-att-badge, :scope > .el-frame-owners')) b.remove();
      try { live.update(el); } catch (err) { console.error('[live] update', err); }
      this._attachmentBadge(el, node);
      this._assigneeBadge(el, node);
      return;
    }
    if (live) { try { live.destroy?.(); } catch (_) {} node.__live = null; }

    node.className = 'board-element type-' + el.type + (el.locked ? ' is-locked' : '');
    node.textContent = '';
    node.style.background = '';
    node.style.color = '';
    node.style.border = '';

    const builder = this['_' + el.type.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    if (typeof builder === 'function') builder.call(this, el, node);
    else node.textContent = el.type;

    // A sticky bound to a Keep note that has since been deleted in Keep.
    // Flagged rather than removed: deleting someone's board object because
    // a remote copy went away is the kind of surprise a sync must not
    // spring on them.
    if (el.meta?.keepMissing) node.dataset.keepMissing = 'true';
    else delete node.dataset.keepMissing;

    // Overlays that any type can carry, added after the body so a builder
    // clearing the node cannot wipe them.
    this._attachmentBadge(el, node);
    this._assigneeBadge(el, node);
  }

  /**
   * The paperclip on an object that has files attached to it.
   *
   * Drawn as part of the element rather than the screen-space overlay so it
   * scales, rotates and exports with the object it belongs to.
   */
  _attachmentBadge(el, node) {
    const items = el.attachments || [];
    if (!items.length) return;

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'el-att-badge';
    badge.dataset.action = 'attachments';
    badge.title = items.length === 1
      ? items[0].name
      : `${items.length} attachments`;
    badge.innerHTML = `<i class="ph ph-paperclip"></i>` +
      (items.length > 1 ? `<span>${items.length}</span>` : '');
    node.appendChild(badge);
  }

  /**
   * Who a frame belongs to. Only frames carry this: a frame marks out a
   * region of the board as one person's or one team's area of the work.
   */
  _assigneeBadge(el, node) {
    if (el.type !== 'frame') return;
    const owners = el.assignees || [];
    if (!owners.length) return;

    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'el-frame-owners';
    wrap.dataset.action = 'frame-owners';
    wrap.title = 'Assigned to ' + owners.map(o => o.name || o.email).join(', ');

    for (const o of owners.slice(0, 4)) {
      const av = document.createElement('span');
      av.className = 'el-frame-av';
      if (o.photoURL) {
        av.style.backgroundImage = `url("${o.photoURL}")`;
      } else {
        av.textContent = (o.name || o.email || '?').trim().charAt(0).toUpperCase();
        av.style.background = o.color || '#4262ff';
      }
      wrap.appendChild(av);
    }
    if (owners.length > 4) {
      const rest = document.createElement('span');
      rest.className = 'el-frame-av is-rest';
      rest.textContent = '+' + (owners.length - 4);
      wrap.appendChild(rest);
    }
    node.appendChild(wrap);
  }

  /* ---- shared helpers ---------------------------------------------- */

  /**
   * Creates an editable label. Editing is triggered by double-click,
   * single-click when selected, or typing on a selected element.
   */
  _label(el, { className = 'el-label', text, placeholder = '', onCommit, style = {} } = {}) {
    const div = document.createElement('div');
    div.className = className + ' editable';
    div.dataset.placeholder = placeholder;
    div.textContent = text != null ? text : (el.content || '');
    div.spellcheck = false;
    Object.assign(div.style, style);
    if (!div.textContent) div.classList.add('is-empty');

    div.addEventListener('dblclick', e => {
      e.stopPropagation();
      this.beginEdit(el.id, div);
    });

    div.addEventListener('click', e => {
      // If already selected, single-click inside the label starts editing
      if (this.store.selection.has(el.id) && !div.classList.contains('is-editing')) {
        e.stopPropagation();
        this.beginEdit(el.id, div, null, { caretAt: { x: e.clientX, y: e.clientY } });
      }
    });

    div.addEventListener('blur', () => {
      div.contentEditable = 'false';
      div.classList.remove('is-editing');
      // contenteditable emits U+00A0 for typed spaces; normalise before storing
      const value = div.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '');
      div.classList.toggle('is-empty', !value);
      if (onCommit) onCommit(value);
      else if (value !== el.content) this.store.updateElement(el.id, { content: value });
      this.app.emit?.('edit:end', el.id);
    });

    div.addEventListener('keydown', e => {
      e.stopPropagation();                     // never let board shortcuts fire
      if (e.key === 'Escape') { e.preventDefault(); div.blur(); }
      if (e.key === 'Enter' && !e.shiftKey && el.type !== 'sticky-note' && el.type !== 'text') {
        e.preventDefault();
        div.blur();
      }
    });

    div.addEventListener('input', () => {
      div.classList.toggle('is-empty', !div.innerText.trim());
      if (AUTO_HEIGHT_TYPES.has(el.type)) this.app.autoSize?.(el.id);
    });

    return div;
  }

  beginEdit(id, labelNode, initialChar = null, opts = {}) {
    const el = this.store.get(id);
    if (!el || el.locked) return;
    const node = labelNode || this.nodes.get(id)?.querySelector('.editable');
    if (!node) return;
    node.contentEditable = 'true';
    node.classList.add('is-editing');
    node.classList.remove('is-empty');
    node.focus();

    // Clicking into existing text should put the caret where the pointer
    // was, not select the whole label — selecting everything meant the next
    // keystroke wiped the note instead of inserting into it.
    if (!initialChar && opts.caretAt && node.textContent) {
      const pos = this._caretFromPoint(opts.caretAt.x, opts.caretAt.y);
      if (pos) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
        this.app.emit?.('edit:start', id);
        return;
      }
    }

    if (initialChar) {
      // Replace with initial typed character or append
      if (node.classList.contains('is-empty') || !node.textContent) {
        node.textContent = initialChar;
      } else {
        node.textContent += initialChar;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.app.emit?.('edit:start', id);
  }

  /** A collapsed Range at a viewport point, across the two browser APIs. */
  _caretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p || !p.offsetNode) return null;
      const r = document.createRange();
      try { r.setStart(p.offsetNode, p.offset); } catch { return null; }
      r.collapse(true);
      return r;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) r.collapse(true);
      return r;
    }
    return null;
  }

  _svgShape(pathData, style, el) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'el-shape-svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', style.backgroundColor || 'transparent');
    path.setAttribute('stroke', style.borderColor || 'transparent');
    path.setAttribute('stroke-width', style.borderWidth != null ? style.borderWidth : 2);
    path.setAttribute('stroke-linejoin', 'round');
    // Keeps outlines a constant weight no matter how the box is stretched.
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
    svg.appendChild(path);
    return svg;
  }

  /* ================================================================
     ELEMENT TYPES
     ================================================================ */

  _stickyNote(el, node) {
    const bg = el.style?.backgroundColor || '#ffe66d';
    node.style.background = bg;
    node.style.color = el.style?.color || Util.readableText(bg);

    if (el.meta?.gwIcon && window.GW_ICONS) {
      node.style.flexDirection = 'column';
      node.style.padding = '10px 14px';

      const iconKey = el.meta.gwType || 'doc';
      const iconSvg = window.GW_ICONS[iconKey] || window.GW_ICONS.doc;
      const head = document.createElement('div');
      head.className = 'el-sticky-gw-head';
      head.style.cssText = 'display:flex;align-items:center;margin-bottom:6px;flex:none;';
      head.innerHTML = iconSvg;
      node.appendChild(head);
    }

    const label = this._label(el, {
      className: 'el-sticky-text',
      placeholder: 'Type a note…',
      style: {
        fontSize: (el.style?.fontSize || 15) + 'px',
        textAlign: el.style?.align || 'left',
        fontWeight: el.style?.bold ? '700' : '400',
        fontStyle: el.style?.italic ? 'italic' : 'normal',
        fontFamily: el.style?.fontFamily || 'inherit',
        flex: '1',
        minHeight: 0,
      },
    });
    node.appendChild(label);
  }

  _text(el, node) {
    const hasBg = el.style?.backgroundColor && el.style.backgroundColor !== 'transparent';
    const themedExplicit = Util.themedColor(el.style?.color, hasBg ? el.style.backgroundColor : 'transparent', this.app.theme?.isDark);
    const label = this._label(el, {
      className: 'el-text-body' + (hasBg ? ' has-bg' : ''),
      placeholder: 'Type something…',
      style: {
        fontSize: (el.style?.fontSize || 22) + 'px',
        color: themedExplicit || (hasBg ? Util.readableText(el.style.backgroundColor) : 'var(--clr-text)'),
        textAlign: el.style?.align || 'left',
        fontWeight: el.style?.bold ? '700' : (el.style?.fontWeight || '400'),
        fontStyle: el.style?.italic ? 'italic' : 'normal',
        textDecoration: el.style?.underline ? 'underline' : 'none',
        fontFamily: el.style?.fontFamily || 'inherit',
        backgroundColor: el.style?.backgroundColor || 'transparent',
      },
    });
    node.appendChild(label);
  }

  _shape(el, node) {
    const style = el.style || {};
    const build = SHAPE_PATHS[el.shapeType] || SHAPE_PATHS.rectangle;
    const hasBg = style.backgroundColor && style.backgroundColor !== 'transparent';
    const isDark = this.app.theme?.isDark;
    // An outline-only shape's stroke is the only thing that has to read
    // against the canvas itself — a filled shape's border sits on its own
    // fill, so leave that case alone.
    const svgStyle = hasBg ? style : { ...style, borderColor: Util.themedColor(style.borderColor, 'transparent', isDark) };
    node.appendChild(this._svgShape(build(), svgStyle, el));

    const label = this._label(el, {
      className: 'el-shape-label',
      placeholder: '',
      style: {
        fontSize: (style.fontSize || 14) + 'px',
        // An outline-only shape (no fill) has no background to anchor
        // contrast against, so its label used to default to near-black
        // no matter what — invisible against a dark canvas. Fall back to
        // the theme-aware CSS token instead, and adapt an explicit colour
        // choice the same way _text() does.
        color: hasBg
          ? (Util.themedColor(style.color, style.backgroundColor, isDark) || Util.readableText(style.backgroundColor))
          : (Util.themedColor(style.color, 'transparent', isDark) || 'var(--clr-text)'),
        fontWeight: style.bold ? '700' : '500',
      },
    });
    node.appendChild(label);
  }

  _image(el, node) {
    const img = document.createElement('img');
    img.src = el.src || '';
    img.alt = el.alt || 'Board image';
    img.draggable = false;
    img.style.objectFit = el.style?.fit || 'contain';
    img.addEventListener('error', () => {
      node.classList.add('img-error');
      node.textContent = '🖼 image unavailable';
    });
    node.appendChild(img);
  }

  _frame(el, node) {
    node.style.background = el.style?.backgroundColor || 'rgba(255,255,255,.45)';

    // The frame body must NOT swallow clicks meant for whatever sits inside
    // it, so only its edges and title are hit-targets.
    for (const side of ['t', 'r', 'b', 'l']) {
      const edge = document.createElement('div');
      edge.className = 'frame-edge frame-edge-' + side;
      node.appendChild(edge);
    }

    const title = this._label(el, {
      className: 'el-frame-title',
      text: el.content || 'Frame',
      placeholder: 'Frame',
    });
    node.appendChild(title);
  }

  _flowchart(el, node) {
    const style = el.style || {};
    const type = el.fcType || 'process';
    const build = FLOWCHART_PATHS[type] || FLOWCHART_PATHS.process;
    node.appendChild(this._svgShape(build(), {
      backgroundColor: style.backgroundColor || '#ffffff',
      borderColor: style.borderColor || '#16161d',
      borderWidth: style.borderWidth != null ? style.borderWidth : 2,
      dash: style.dash,
    }, el));

    const fcHasBg = style.backgroundColor && style.backgroundColor !== 'transparent';
    const label = this._label(el, {
      className: 'el-fc-label',
      text: el.content || FLOWCHART_LABELS[type] || 'Step',
      placeholder: 'Step',
      style: {
        fontSize: (style.fontSize || 14) + 'px',
        color: fcHasBg
          ? (Util.themedColor(style.color, style.backgroundColor, this.app.theme?.isDark) || Util.readableText(style.backgroundColor))
          : (Util.themedColor(style.color, 'transparent', this.app.theme?.isDark) || Util.readableText('#ffffff')),
      },
    });
    node.appendChild(label);
  }

  _mindmap(el, node) {
    const bg = el.style?.backgroundColor || (el.mmRoot ? '#4262ff' : '#e8ecff');
    node.classList.add(el.mmRoot ? 'mm-root' : 'mm-child');
    if (el.mmSide) node.classList.add('mm-side-' + el.mmSide);
    node.style.background = bg;
    node.style.color = el.style?.color || Util.readableText(bg);
    node.style.borderColor = Util.shade(bg, -0.12);
    if (el.mmCollapsed) node.classList.add('is-collapsed');

    const label = this._label(el, {
      className: 'el-mm-label',
      placeholder: 'Topic',
      style: { fontSize: (el.style?.fontSize || (el.mmRoot ? 16 : 14)) + 'px' },
      onCommit: value => {
        this.store.updateElement(el.id, { content: value }, { silent: true });
        this.app.mindmap.measureNode(el.id);
        this.app.mindmap.layoutTreeOf(el.id);
        this.store.transact('edit topic', () => {});
      },
    });
    node.appendChild(label);

    const tools = document.createElement('div');
    tools.className = 'mm-tools' + (el.mmSide === 'left' ? ' mm-tools-left' : ' mm-tools-right');

    if (el.mmChildren && el.mmChildren.length) {
      const collapse = document.createElement('button');
      collapse.className = 'mm-btn mm-collapse';
      collapse.type = 'button';
      collapse.dataset.mmAction = 'collapse';
      collapse.title = el.mmCollapsed ? 'Expand branch' : 'Collapse branch';
      collapse.textContent = el.mmCollapsed ? String(this.app.mindmap.countDescendants(el.id)) : '−';
      tools.appendChild(collapse);
    }

    const addChild = document.createElement('button');
    addChild.className = 'mm-btn mm-add mm-add-child';
    addChild.type = 'button';
    addChild.dataset.mmAction = 'add-child';
    addChild.title = 'Add next step (Tab)';
    addChild.innerHTML = '<i class="ph-bold ph-plus"></i>';
    tools.appendChild(addChild);

    if (!el.mmRoot) {
      const addSibling = document.createElement('button');
      addSibling.className = 'mm-btn mm-add mm-add-sibling';
      addSibling.type = 'button';
      addSibling.dataset.mmAction = 'add-sibling';
      addSibling.title = 'Add sibling step (Enter)';
      addSibling.innerHTML = '<i class="ph-bold ph-arrow-down"></i>';
      tools.appendChild(addSibling);
    }

    node.appendChild(tools);
  }

  _graph(el, node) {
    const head = document.createElement('div');
    head.className = 'el-graph-head';
    const title = this._label(el, {
      className: 'el-graph-title',
      text: el.graphTitle || 'Chart',
      placeholder: 'Chart title',
      onCommit: v => this.store.updateElement(el.id, { graphTitle: v }),
    });
    head.appendChild(title);

    const edit = document.createElement('button');
    edit.className = 'el-corner-btn';
    edit.type = 'button';
    edit.dataset.action = 'edit-graph';
    edit.textContent = 'Edit data';
    head.appendChild(edit);
    node.appendChild(head);

    const canvas = document.createElement('canvas');
    canvas.className = 'el-graph-canvas';
    node.appendChild(canvas);

    // Draw once the node has real layout dimensions.
    requestAnimationFrame(() => this.app.charts?.draw(el, canvas));
  }

  _algorithm(el, node) {
    const themes = AlgorithmManager.THEMES;
    const theme = themes[el.algoTheme] || themes.dark;
    node.style.background = theme.bg;
    node.style.color = theme.text;
    node.style.borderColor = theme.border;

    const head = document.createElement('div');
    head.className = 'el-algo-head';
    head.style.background = theme.headerBg;
    head.style.borderBottomColor = theme.border;

    const icon = document.createElement('span');
    icon.className = 'el-algo-icon';
    icon.textContent = '⚡';
    head.appendChild(icon);

    head.appendChild(this._label(el, {
      className: 'el-algo-title',
      text: el.content || 'Algorithm',
      placeholder: 'Algorithm',
    }));

    const edit = document.createElement('button');
    edit.className = 'el-corner-btn';
    edit.type = 'button';
    edit.dataset.action = 'edit-algorithm';
    edit.textContent = 'Edit';
    head.appendChild(edit);
    node.appendChild(head);

    const body = document.createElement('div');
    body.className = 'el-algo-body';

    const steps = el.algoSteps || [];
    const gutter = String(steps.length).length;
    steps.forEach((step, i) => {
      const meta = AlgorithmManager.STEP_META[step.type] || AlgorithmManager.STEP_META.process;
      const raw = step.text || '';
      const indent = (raw.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;

      const row = document.createElement('div');
      row.className = 'el-algo-step step-' + step.type;
      row.style.paddingLeft = (10 + indent * 7) + 'px';

      const ln = document.createElement('span');
      ln.className = 'el-algo-ln';
      ln.style.minWidth = (gutter * 8 + 4) + 'px';
      ln.textContent = i + 1;
      row.appendChild(ln);

      const ic = document.createElement('span');
      ic.className = 'el-algo-ic';
      ic.style.color = meta.color;
      ic.textContent = meta.icon;
      row.appendChild(ic);

      const tx = document.createElement('span');
      tx.className = 'el-algo-tx';
      tx.style.color = meta.color;
      tx.textContent = raw.trim();
      row.appendChild(tx);

      body.appendChild(row);
    });

    if (!steps.length) {
      const hint = document.createElement('div');
      hint.className = 'el-algo-empty';
      hint.textContent = 'Double-click “Edit” to write pseudocode…';
      body.appendChild(hint);
    }
    node.appendChild(body);

    // Ports live on every element type now (see Overlay), so an algorithm
    // block can be wired into a flow like anything else.
  }

  _code(el, node) {
    node.style.background = '#0f1117';
    node.style.color = '#d6deeb';
    const head = document.createElement('div');
    head.className = 'el-code-head';
    head.textContent = el.language || 'javascript';
    node.appendChild(head);

    const pre = document.createElement('pre');
    pre.className = 'el-code-body editable';
    pre.textContent = el.content || '';
    pre.spellcheck = false;
    pre.addEventListener('dblclick', e => { e.stopPropagation(); this.beginEdit(el.id, pre); });
    pre.addEventListener('click', e => {
      if (this.store.selection.has(el.id) && !pre.classList.contains('is-editing')) {
        e.stopPropagation();
        this.beginEdit(el.id, pre);
      }
    });
    pre.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); pre.blur(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand?.('insertText', false, '  ');
      }
    });
    pre.addEventListener('blur', () => {
      pre.contentEditable = 'false';
      pre.classList.remove('is-editing');
      this.store.updateElement(el.id, { content: pre.innerText });
      this.app.emit?.('edit:end', el.id);
    });
    node.appendChild(pre);
  }

  _table(el, node) {
    const rawData = el.tableData || {};
    const rows = Math.max(1, rawData.rows || 3);
    const cols = Math.max(1, rawData.cols || 3);

    // Normalize cells array safely
    const cellsData = (rawData.cells || []).map(r => [...(r || [])]);
    while (cellsData.length < rows) cellsData.push(new Array(cols).fill(''));
    for (let r = 0; r < rows; r++) {
      while (cellsData[r].length < cols) cellsData[r].push(r === 0 ? `Col ${cellsData[r].length + 1}` : '');
    }

    const activeTheme = el.tableTheme || 'clean-slate';
    const container = document.createElement('div');
    container.className = `el-table-container theme-${activeTheme}`;

    // Professional theme selector options (clean text, no emojis)
    const themeOpts = (typeof TABLE_THEMES !== 'undefined' ? TABLE_THEMES : []).map(t =>
      `<option value="${t.id}" ${t.id === activeTheme ? 'selected' : ''}>${t.name}</option>`
    ).join('');

    // 1. Header Toolbar
    const headBar = document.createElement('div');
    headBar.className = 'el-table-header-bar';
    headBar.innerHTML = `
      <div class="el-table-title-area">
        <span class="el-table-icon" title="Table"><i class="ph-bold ph-table"></i></span>
        <span class="el-table-name">${Util.escapeHTML(el.content || 'Table')}</span>
        <div class="tbl-theme-wrap" title="Table Theme">
          <i class="ph-bold ph-swatches tbl-theme-ic"></i>
          <select class="tbl-theme-select" title="Change Table Theme">
            ${themeOpts}
          </select>
        </div>
      </div>
      <div class="el-table-actions">
        <button type="button" class="tbl-action-btn" data-action="table-add-row" title="Add Row at bottom">+ Row</button>
        <button type="button" class="tbl-action-btn" data-action="table-add-col" title="Add Column at right">+ Col</button>
        <button type="button" class="tbl-action-btn" data-action="table-del-row" title="Delete Row">− Row</button>
        <button type="button" class="tbl-action-btn" data-action="table-del-col" title="Delete Column">− Col</button>
        <button type="button" class="tbl-action-btn tbl-action-clear" data-action="table-clear" title="Clear table contents">Clear</button>
      </div>
    `;

    const themeSelect = headBar.querySelector('.tbl-theme-select');
    themeSelect?.addEventListener('change', e => {
      e.stopPropagation();
      const val = themeSelect.value;
      container.className = `el-table-container theme-${val}`;
      this.store.updateElement(el.id, { tableTheme: val }, { silent: true });
      this.store.transact('change table theme', () => {});
    });
    themeSelect?.addEventListener('pointerdown', e => e.stopPropagation());
    themeSelect?.addEventListener('click', e => e.stopPropagation());

    container.appendChild(headBar);

    // 2. Table Grid
    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'el-table-scroll';

    const table = document.createElement('table');
    table.className = 'el-table-grid';

    // Table Header (Row 0)
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.className = 'tbl-col-header';

      const cellDiv = document.createElement('div');
      cellDiv.className = 'tbl-cell-input tbl-header-input editable';
      cellDiv.contentEditable = 'true';
      cellDiv.spellcheck = false;
      cellDiv.dataset.r = 0;
      cellDiv.dataset.c = c;
      cellDiv.textContent = cellsData[0]?.[c] ?? `Column ${c + 1}`;

      this._bindTableCell(cellDiv, el, 0, c, rows, cols, table, cellsData);
      th.appendChild(cellDiv);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    // Table Body (Rows 1 to N-1)
    const tbody = document.createElement('tbody');
    for (let r = 1; r < rows; r++) {
      const tr = document.createElement('tr');

      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.className = 'tbl-data-cell';

        const cellDiv = document.createElement('div');
        cellDiv.className = 'tbl-cell-input editable';
        cellDiv.contentEditable = 'true';
        cellDiv.spellcheck = false;
        cellDiv.dataset.r = r;
        cellDiv.dataset.c = c;
        cellDiv.textContent = cellsData[r]?.[c] ?? '';

        this._bindTableCell(cellDiv, el, r, c, rows, cols, table, cellsData);
        td.appendChild(cellDiv);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scrollWrap.appendChild(table);
    container.appendChild(scrollWrap);
    node.appendChild(container);
  }

  _bindTableCell(cellDiv, el, r, c, rows, cols, table, cellsData) {
    cellDiv.addEventListener('focus', () => {
      cellDiv.classList.add('is-editing');
      if (!this.store.selection.has(el.id)) this.store.select([el.id]);
    });

    cellDiv.addEventListener('input', () => {
      const val = cellDiv.innerText.replace(/\u00a0/g, ' ');
      if (!cellsData[r]) cellsData[r] = [];
      cellsData[r][c] = val;
    });

    cellDiv.addEventListener('blur', () => {
      cellDiv.classList.remove('is-editing');
      const val = cellDiv.innerText.replace(/\u00a0/g, ' ').trim();
      const currentEl = this.store.get(el.id);
      if (!currentEl) return;
      const curData = currentEl.tableData || { rows, cols, cells: [] };
      const curCells = (curData.cells || []).map(row => [...(row || [])]);
      while (curCells.length < rows) curCells.push(new Array(cols).fill(''));
      for (let i = 0; i < rows; i++) {
        while (curCells[i].length < cols) curCells[i].push('');
      }
      if (curCells[r][c] !== val) {
        curCells[r][c] = val;
        this.store.updateElement(el.id, { tableData: { rows, cols, cells: curCells } }, { silent: true });
      }
    });

    cellDiv.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        cellDiv.blur();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        cellDiv.blur();
        if (e.shiftKey) {
          const prev = table.querySelector(`[data-r="${c === 0 ? r - 1 : r}"][data-c="${c === 0 ? cols - 1 : c - 1}"]`);
          if (prev) { prev.focus(); }
        } else {
          if (r === rows - 1 && c === cols - 1) {
            this.app.editTable(el.id, 'table-add-row');
            requestAnimationFrame(() => {
              const newCell = this.nodes.get(el.id)?.querySelector(`[data-r="${r + 1}"][data-c="0"]`);
              if (newCell) { newCell.focus(); }
            });
          } else {
            const next = table.querySelector(`[data-r="${c === cols - 1 ? r + 1 : r}"][data-c="${c === cols - 1 ? 0 : c + 1}"]`);
            if (next) { next.focus(); }
          }
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        cellDiv.blur();
        if (r === rows - 1) {
          this.app.editTable(el.id, 'table-add-row');
          requestAnimationFrame(() => {
            const newCell = this.nodes.get(el.id)?.querySelector(`[data-r="${r + 1}"][data-c="${c}"]`);
            if (newCell) { newCell.focus(); }
          });
        } else {
          const below = table.querySelector(`[data-r="${r + 1}"][data-c="${c}"]`);
          if (below) { below.focus(); }
        }
        return;
      }
    });

    cellDiv.addEventListener('paste', e => {
      e.stopPropagation();
      const text = e.clipboardData?.getData('text/plain');
      if (!text || (!text.includes('\t') && !text.includes('\n'))) return;
      e.preventDefault();

      const pasteRows = text.replace(/\r/g, '').split('\n').filter(Boolean).map(row => row.split('\t'));
      let newRows = Math.max(rows, r + pasteRows.length);
      let maxPasteCols = Math.max(...pasteRows.map(p => p.length));
      let newCols = Math.max(cols, c + maxPasteCols);

      const updatedCells = cellsData.map(row => [...(row || [])]);
      while (updatedCells.length < newRows) updatedCells.push(new Array(newCols).fill(''));
      for (let pr = 0; pr < newRows; pr++) {
        while (updatedCells[pr].length < newCols) updatedCells[pr].push('');
      }

      pasteRows.forEach((pRow, pRIdx) => {
        pRow.forEach((val, pCIdx) => {
          if (r + pRIdx < newRows && c + pCIdx < newCols) {
            updatedCells[r + pRIdx][c + pCIdx] = val.trim();
          }
        });
      });

      this.store.transact('paste table data', () => {
        this.store.updateElement(el.id, {
          width: Math.max(el.width, newCols * 140),
          height: Math.max(el.height, newRows * 44 + 56),
          tableData: { rows: newRows, cols: newCols, cells: updatedCells }
        });
      });
    });
  }

  _checklist(el, node) {
    node.style.background = el.style?.backgroundColor || '#ffffff';
    const title = this._label(el, {
      className: 'el-check-title',
      text: el.content || 'Checklist',
      placeholder: 'Checklist',
    });
    node.appendChild(title);

    const list = document.createElement('div');
    list.className = 'el-check-list';
    const items = el.items || [];
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'el-check-row' + (item.done ? ' is-done' : '');

      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'el-check-box';
      box.dataset.action = 'check-toggle';
      box.dataset.index = i;
      box.textContent = item.done ? '✓' : '';
      row.appendChild(box);

      const text = document.createElement('div');
      text.className = 'el-check-text editable';
      text.textContent = item.text || '';
      text.addEventListener('dblclick', e => {
        e.stopPropagation();
        text.contentEditable = 'true'; text.focus();
      });
      text.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); text.blur(); }
      });
      text.addEventListener('blur', () => {
        text.contentEditable = 'false';
        const next = el.items.slice();
        next[i] = { ...next[i], text: text.innerText.trim() };
        this.store.updateElement(el.id, { items: next });
      });
      row.appendChild(text);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'el-check-del';
      del.dataset.action = 'check-remove';
      del.dataset.index = i;
      del.textContent = '×';
      row.appendChild(del);

      list.appendChild(row);
    });
    node.appendChild(list);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'el-check-add';
    add.dataset.action = 'check-add';
    add.textContent = '+ Add item';
    node.appendChild(add);
  }

  _comment(el, node) {
    node.style.background = el.style?.backgroundColor || '#fff2b8';
    const head = document.createElement('div');
    head.className = 'el-comment-head';
    head.innerHTML = `<span class="el-comment-avatar">${Util.escapeHTML((el.author || 'You')[0])}</span>` +
                     `<span class="el-comment-author">${Util.escapeHTML(el.author || 'You')}</span>` +
                     (el.resolved ? '<span class="el-comment-resolved">resolved</span>' : '');
    node.appendChild(head);
    node.appendChild(this._label(el, { className: 'el-comment-body', placeholder: 'Leave a comment…' }));

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'el-corner-btn';
    done.dataset.action = 'resolve-comment';
    done.textContent = el.resolved ? 'Reopen' : 'Resolve';
    node.appendChild(done);
  }

  _embed(el, node) {
    const head = document.createElement('div');
    head.className = 'el-embed-head';
    head.textContent = el.url || 'Embed';
    node.appendChild(head);

    if (el.url) {
      const frame = document.createElement('iframe');
      frame.src = el.url;
      frame.className = 'el-embed-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.loading = 'lazy';
      node.appendChild(frame);
    } else {
      const empty = document.createElement('div');
      empty.className = 'el-embed-empty';
      empty.textContent = 'No URL set';
      node.appendChild(empty);
    }

    const shield = document.createElement('div');
    shield.className = 'el-embed-shield';
    shield.title = 'Double-click to interact';
    shield.addEventListener('dblclick', e => {
      e.stopPropagation();
      shield.classList.toggle('is-off');
    });
    node.appendChild(shield);
  }
}

/* ================================================================
   Overlay — selection frame, handles, ports, guides, marquee
   ================================================================
   Everything here is drawn in SCREEN space so handles stay a constant
   size at any zoom, and so dragging never mutates the element layer.
   ================================================================ */
class Overlay {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.root = document.getElementById('overlay-layer');

    this.frame = document.createElement('div');
    this.frame.className = 'sel-frame hidden';
    this.root.appendChild(this.frame);

    this.handles = {};
    for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const h = document.createElement('div');
      h.className = 'sel-handle sel-' + dir;
      h.dataset.handle = dir;
      this.frame.appendChild(h);
      this.handles[dir] = h;
    }
    this.rotateHandle = document.createElement('div');
    this.rotateHandle.className = 'sel-rotate';
    this.rotateHandle.dataset.handle = 'rotate';
    this.rotateHandle.title = 'Rotate (hold Shift to snap 15°)';
    this.frame.appendChild(this.rotateHandle);

    this.sizeBadge = document.createElement('div');
    this.sizeBadge.className = 'sel-badge hidden';
    this.root.appendChild(this.sizeBadge);

    this.marquee = document.createElement('div');
    this.marquee.className = 'marquee hidden';
    this.root.appendChild(this.marquee);

    this.ports = document.createElement('div');
    this.ports.className = 'port-set hidden';
    for (const dir of ['top', 'right', 'bottom', 'left']) {
      const p = document.createElement('div');
      p.className = 'port port-' + dir;
      p.dataset.port = dir;
      this.ports.appendChild(p);
    }
    this.root.appendChild(this.ports);

    this.connHandles = document.createElement('div');
    this.connHandles.className = 'conn-handles';
    this.root.appendChild(this.connHandles);

    this.guides = [];
    this._portTarget = null;

    this._sync = Util.rafThrottle(() => this.sync());
    this.store.on('selection', () => this._sync());
    this.store.on('change', () => this._sync());
    this.store.on('live-change', () => this._sync());
    this.store.on('reload', () => this._sync());
    this.store.on('connection:update', () => this._sync());
    this.store.on('connection:add', () => this._sync());
    this.store.on('connection:remove', () => this._sync());
    this.app.viewport.on('applied', () => this._sync());
  }

  /* ---- selection frame & connection handles ------------------------- */

  sync() {
    const sel = this.store.selected();
    const vp = this.app.viewport;

    // Ports are positioned in screen space, so they drift on pan and zoom
    // unless they are re-placed with everything else.
    this.syncPorts();

    // Connection handles
    this.connHandles.textContent = '';
    if (this.store.connSelection.size && !this.app.interaction?.suppressOverlay) {
      for (const connId of this.store.connSelection) {
        const conn = this.store.getConnection(connId);
        if (!conn) continue;
        const a = this.app.connections?.endpointOf(conn, 'from');
        const b = this.app.connections?.endpointOf(conn, 'to');
        if (!a || !b) continue;

        const sa = vp.boardToScreen(a.x, a.y);
        const sb = vp.boardToScreen(b.x, b.y);

        const hFrom = document.createElement('div');
        hFrom.className = 'conn-endpoint endpoint-from';
        hFrom.dataset.connHandle = 'from';
        hFrom.dataset.connId = conn.id;
        hFrom.title = 'Drag to reconnect start';
        hFrom.style.transform = `translate(${sa.x}px, ${sa.y}px)`;

        const hTo = document.createElement('div');
        hTo.className = 'conn-endpoint endpoint-to';
        hTo.dataset.connHandle = 'to';
        hTo.dataset.connId = conn.id;
        hTo.title = 'Drag to reconnect end';
        hTo.style.transform = `translate(${sb.x}px, ${sb.y}px)`;

        this.connHandles.appendChild(hFrom);
        this.connHandles.appendChild(hTo);
      }
    }

    if (!sel.length || this.app.interaction?.suppressOverlay) {
      this.frame.classList.add('hidden');
      this.sizeBadge.classList.add('hidden');
      return;
    }

    this.frame.classList.remove('hidden');

    if (sel.length === 1) {
      const el = sel[0];
      const p = vp.boardToScreen(el.x, el.y);
      this.frame.style.width  = el.width * vp.scale + 'px';
      this.frame.style.height = el.height * vp.scale + 'px';
      this.frame.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${el.rotation || 0}deg)`;
      this.frame.classList.toggle('is-locked', !!el.locked);
      this.frame.classList.remove('is-multi');
      const noResize = el.locked;
      for (const dir in this.handles) {
        this.handles[dir].classList.toggle('hidden', noResize);
      }
      // Side handles are only useful when there is room for them.
      const narrow = el.width * vp.scale < 46, short = el.height * vp.scale < 46;
      this.handles.n.classList.toggle('hidden', noResize || narrow);
      this.handles.s.classList.toggle('hidden', noResize || narrow);
      this.handles.e.classList.toggle('hidden', noResize || short);
      this.handles.w.classList.toggle('hidden', noResize || short);
      this.rotateHandle.classList.toggle('hidden', noResize || el.type === 'mindmap');

      this.sizeBadge.classList.remove('hidden');
      this.sizeBadge.textContent = `${Math.round(el.width)} × ${Math.round(el.height)}`;
      const bp = vp.boardToScreen(el.x + el.width / 2, el.y + el.height);
      this.sizeBadge.style.transform = `translate(${bp.x}px, ${bp.y + 12}px) translateX(-50%)`;
    } else {
      const b = Util.boundsOf(sel);
      const p = vp.boardToScreen(b.x, b.y);
      this.frame.style.width  = b.w * vp.scale + 'px';
      this.frame.style.height = b.h * vp.scale + 'px';
      this.frame.style.transform = `translate(${p.x}px, ${p.y}px)`;
      this.frame.classList.add('is-multi');
      this.frame.classList.remove('is-locked');
      for (const dir in this.handles) {
        this.handles[dir].classList.toggle('hidden', !['nw', 'ne', 'se', 'sw'].includes(dir));
      }
      this.rotateHandle.classList.add('hidden');
      this.sizeBadge.classList.remove('hidden');
      this.sizeBadge.textContent = `${sel.length} selected`;
      const bp = vp.boardToScreen(b.x + b.w / 2, b.y + b.h);
      this.sizeBadge.style.transform = `translate(${bp.x}px, ${bp.y + 12}px) translateX(-50%)`;
    }
  }

  /* ---- connection ports --------------------------------------------- */

  showPorts(el) {
    if (!el) return this.hidePorts();
    this._portTarget = el.id;
    const vp = this.app.viewport;
    const p = vp.boardToScreen(el.x, el.y);
    this.ports.style.width  = el.width * vp.scale + 'px';
    this.ports.style.height = el.height * vp.scale + 'px';
    this.ports.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${el.rotation || 0}deg)`;
    this.ports.dataset.elementId = el.id;

    // A selected element also carries eight resize handles, and the four
    // mid-side ones sat on exactly the same pixels as the ports — the ports
    // are appended later, so they won the hit test and dragging a side
    // handle started a connection instead of a resize. When the element is
    // selected, push the ports out to their own ring beyond the handles.
    this.ports.classList.toggle('is-outset', this.store.selection.has(el.id));
    this.ports.classList.remove('hidden');
  }

  /** Keep the port ring glued to its element through pan, zoom and drag. */
  syncPorts() {
    if (!this._portTarget) return;
    const el = this.store.get(this._portTarget);
    if (!el) return this.hidePorts();
    this.showPorts(el);
  }

  hidePorts() {
    this._portTarget = null;
    this.ports.classList.add('hidden');
    delete this.ports.dataset.elementId;
  }

  get portTargetId() { return this._portTarget; }

  /* ---- marquee -------------------------------------------------------- */

  showMarquee(x1, y1, x2, y2) {
    this.marquee.classList.remove('hidden');
    this.marquee.style.left   = Math.min(x1, x2) + 'px';
    this.marquee.style.top    = Math.min(y1, y2) + 'px';
    this.marquee.style.width  = Math.abs(x2 - x1) + 'px';
    this.marquee.style.height = Math.abs(y2 - y1) + 'px';
  }

  hideMarquee() { this.marquee.classList.add('hidden'); }

  /* ---- alignment guides ------------------------------------------------ */

  /**
   * Guides are pooled and reused. The previous implementation created and
   * destroyed DOM nodes on every pointermove, which forced a full layout
   * pass per frame during every drag.
   */
  setGuides(list) {
    while (this.guides.length < list.length) {
      const g = document.createElement('div');
      g.className = 'align-guide';
      this.root.appendChild(g);
      this.guides.push(g);
    }
    const vp = this.app.viewport;
    for (let i = 0; i < this.guides.length; i++) {
      const g = this.guides[i];
      const spec = list[i];
      if (!spec) { g.style.display = 'none'; continue; }
      g.style.display = 'block';
      if (spec.axis === 'v') {
        const s = vp.boardToScreen(spec.at, 0);
        g.className = 'align-guide guide-v' + (spec.strong ? ' strong' : '');
        g.style.transform = `translateX(${s.x}px)`;
      } else {
        const s = vp.boardToScreen(0, spec.at);
        g.className = 'align-guide guide-h' + (spec.strong ? ' strong' : '');
        g.style.transform = `translateY(${s.y}px)`;
      }
    }
  }

  clearGuides() { for (const g of this.guides) g.style.display = 'none'; }
}

window.Renderer = Renderer;
window.Overlay = Overlay;
window.SHAPE_PATHS = SHAPE_PATHS;
window.FLOWCHART_PATHS = FLOWCHART_PATHS;
window.FLOWCHART_LABELS = FLOWCHART_LABELS;
