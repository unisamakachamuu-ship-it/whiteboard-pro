/* ================================================================
   app.js — application shell: tools, panels, shortcuts, persistence
   ================================================================ */

const SETTINGS_KEY = 'wbpro.settings.v2';

/* ================================================================
   Local board storage
   ----------------------------------------------------------------
   There used to be one key — 'wbpro.autosave.v2' — holding one board.
   Every save overwrote it and every reload restored it, so whichever
   board you opened, the canvas came back to the same drawing, and two
   people sharing a browser profile shared a whiteboard. Project
   boards made it worse: creating one only wrote a record into the
   project, so opening it 404'd on the server and left the previous
   canvas on screen. That is the "same whiteboard every time" bug.

   Storage is now addressed by (account, board):

     wbpro.board.v3::<scope>::<boardId>   one board's contents
     wbpro.lastboard.v3::<scope>          which board to reopen

   `scope` is the signed-in Firebase uid, or 'local' when signed out,
   so signing in or out never shows you someone else's canvas.
   ================================================================ */

const BOARD_PREFIX = 'wbpro.board.v3';
const LAST_BOARD_KEY = 'wbpro.lastboard.v3';
const LEGACY_AUTOSAVE_KEY = 'wbpro.autosave.v2';

const BoardStorage = {
  /** Which account's boards we are looking at right now. */
  scope() {
    const uid = window.FirebaseSync?.currentUser?.uid;
    return uid ? 'u_' + uid : 'local';
  },

  key(boardId) { return `${BOARD_PREFIX}::${this.scope()}::${boardId}`; },

  read(boardId) {
    if (!boardId) return null;
    try { return JSON.parse(localStorage.getItem(this.key(boardId))); }
    catch (_) { return null; }
  },

  write(boardId, data) {
    if (!boardId) return false;
    try { localStorage.setItem(this.key(boardId), JSON.stringify(data)); return true; }
    catch (_) { return false; }
  },

  remove(boardId) {
    try { localStorage.removeItem(this.key(boardId)); } catch (_) {}
  },

  lastBoardId() {
    try { return localStorage.getItem(`${LAST_BOARD_KEY}::${this.scope()}`); }
    catch (_) { return null; }
  },

  setLastBoardId(id) {
    try { localStorage.setItem(`${LAST_BOARD_KEY}::${this.scope()}`, id); } catch (_) {}
  },

  /** Every board this account has a local copy of, newest first. */
  list() {
    const prefix = `${BOARD_PREFIX}::${this.scope()}::`;
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(k));
        if (d?.id) out.push(d);
      } catch (_) {}
    }
    return out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  },

  /**
   * Carry the single legacy board into the new layout, once, so nobody
   * loses the work they had open when they upgraded.
   */
  migrateLegacy() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(LEGACY_AUTOSAVE_KEY)
        || localStorage.getItem('whiteboard_autosave'));
    } catch (_) { return null; }
    if (!raw) return null;

    const id = raw.id || 'board-' + Date.now();
    raw.id = id;
    if (!this.read(id)) this.write(id, raw);
    try { localStorage.removeItem(LEGACY_AUTOSAVE_KEY); } catch (_) {}
    try { localStorage.removeItem('whiteboard_autosave'); } catch (_) {}
    return id;
  },
};

const DEFAULT_SETTINGS = {
  // 'projects' opens the workspace on load; 'canvas' goes straight to the
  // last board. Projects is the default because a whiteboard on its own has
  // no context — which project, whose board — and that ambiguity is what
  // made every project look like it shared one canvas.
  landing: 'projects',

  theme: 'ios',
  lastLightTheme: 'ios',
  lastDarkTheme: 'ios-dark',
  canvasPattern: 'dots',
  gridVisible: true,
  gridSize: 24,
  snapToGrid: false,          // OFF by default — forced grid snap was what
  snapToObjects: true,        // made dragging feel chunky and "laggy"
  lockAspect: false,
  stickyTool: false,          // keep a tool active after one use
  canvasDragPans: false,      // false = drag on empty canvas rubber-bands (select/cursor tool)
  smartShapes: true,          // rough pen strokes snap to real shapes
  quickBar: true,             // floating toolbar above selection

  stickyColor: '#ffe66d',
  penColor: '#16161d',
  penWidth: 3,
  highlighterColor: '#ffd93d',
  highlighterWidth: 18,
  eraserSize: 18,
  eraseObjects: false,

  shapeType: 'rectangle',
  shapeFill: '#dbe4ff',
  shapeStroke: '#4262ff',
  shapeStrokeWidth: 2,

  fcType: 'process',
  graphType: 'bar',
  algoTheme: 'dark',

  connectorRouting: 'orthogonal',
  connectorColor: '#16161d',
  connectorWidth: 2,
  connectorDash: null,
  connectorArrowEnd: true,
  connectorArrowStart: false,
};

/* Kept as the fallback palette; the live one comes from the active theme
   (see ThemeManager.stickyColors in themes.js). */
const STICKY_COLORS = ['#ffe66d', '#ffd6a5', '#ffadad', '#fdcfe8', '#d8c7ff', '#bde0fe', '#b8f2e6', '#d9f7be', '#ffffff'];

class WhiteboardApp extends Emitter {
  constructor() {
    super();

    this.settings = { ...DEFAULT_SETTINGS, ...this._loadSettings() };
    this.activeTool = 'select';
    this.clipboard = [];
    this._lastPointer = { x: 0, y: 0 };
    this._presenting = false;
    this._slideIndex = 0;

    this.store = new Store();
    this.viewport = new Viewport(this);
    this.ink = new InkLayer(this);
    this.renderer = new Renderer(this);
    this.overlay = new Overlay(this);
    this.connections = new ConnectionLayer(this);
    this.mindmap = new MindMapManager(this);
    this.algorithm = new AlgorithmManager(this);
    this.charts = new ChartManager(this);
    this.exporter = new Exporter(this);
    this.library = new BoardLibrary(this);
    this.laser = new LaserPointer(this);
    this.interaction = new Interaction(this);
    this.minimap = new Minimap(this);
    this.theme = new ThemeManager(this);
    this.keep = typeof KeepIntegration === 'function' ? new KeepIntegration(this) : null;
    this.projects = typeof ProjectManager === 'function' ? new ProjectManager(this) : null;

    // Files on objects, and frames as areas of responsibility. Both are
    // optional the same way the studio features are: if the file is missing
    // the canvas still boots, it just cannot attach or assign.
    this.attachments = typeof Attachments === 'function' ? new Attachments(this) : null;
    this.frames = typeof Frames === 'function' ? new Frames(this) : null;
    this.gwPanel = typeof GWPanel === 'function' ? new GWPanel(this) : null;

    // Everything additive — palette, themes, collaboration, workshop tools.
    // Wrapped so one broken feature can never stop the board from booting.
    try { this.studio = new Studio(this); }
    catch (err) { console.error('[studio] failed to start', err); }

    this._buildToolbars();
    this._buildPanels();
    this._bindTopBar();
    this._bindKeyboard();
    this._bindStore();
    this._bindClipboard();
    this._bindFileDrop();

    this.applyTheme(this.settings.theme);
    this.applyGrid();
    this.setTool('select');

    this._autosave = Util.debounce(() => this.save({ quiet: true }), 900);
    setInterval(() => this.save({ quiet: true, server: true }), 45000);
    window.addEventListener('beforeunload', () => this.save({ quiet: true, sync: true }));

    this._restore();
    this._watchAccount();

    setTimeout(() => {
      const ls = document.getElementById('loading-screen');
      if (ls) { ls.classList.add('is-out'); setTimeout(() => ls.remove(), 400); }
    }, 250);
  }

  /**
   * Board storage is keyed by account, so a sign-in or sign-out has to move
   * the canvas with it. Without this, signing in left the signed-out board on
   * screen and the next autosave filed it under the new account.
   */
  _watchAccount() {
    // Compare scopes rather than counting callbacks: onUserChange replays the
    // current user on subscribe only when someone is already signed in, so a
    // "skip the first one" rule would swallow a real sign-in.
    this._accountScope = BoardStorage.scope();
    const attach = () => {
      window.FirebaseSync?.onUserChange(() => {
        const scope = BoardStorage.scope();
        if (scope === this._accountScope) return;
        this._accountScope = scope;
        this.onAccountChanged();
      });
    };
    if (window.FirebaseSync) attach();
    else window.addEventListener('firebase-ready', attach, { once: true });
  }

  /* ================================================================
     SETTINGS + THEME
     ================================================================ */

  _loadSettings() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (_) { return {}; }

    // One-time move onto the iOS themes. Only the two stock values are
    // touched — anyone who picked Dracula or Nord deliberately keeps it.
    if (!saved.themeMigratedIOS) {
      if (saved.theme === 'light') saved.theme = 'ios';
      else if (saved.theme === 'dark') saved.theme = 'ios-dark';
      if (saved.lastLightTheme === 'light') saved.lastLightTheme = 'ios';
      if (saved.lastDarkTheme === 'dark') saved.lastDarkTheme = 'ios-dark';
      saved.themeMigratedIOS = true;
    }
    return saved;
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (_) {}
  }

  /** Kept for compatibility — ThemeManager owns the palette now. */
  applyTheme(theme) { this.theme.apply(theme); }

  applyGrid() {
    this.viewport.wrapper.classList.toggle('show-grid', this.settings.gridVisible);
    this.viewport.wrapper.dataset.pattern = this.settings.canvasPattern || 'dots';
    document.getElementById('grid-btn')?.classList.toggle('is-on', this.settings.gridVisible);
    document.getElementById('snap-btn')?.classList.toggle('is-on', this.settings.snapToGrid);
  }

  /* ================================================================
     TOOLBARS
     ================================================================ */

  get toolDefs() {
    return [
      { id: 'select',      icon: '<i class="ph ph-cursor"></i>',  label: 'Select',        key: 'V' },
      { id: 'hand',        icon: '<i class="ph ph-hand"></i>', label: 'Pan',            key: 'H' },
      { sep: true },
      { id: 'sticky-note', icon: '<i class="ph ph-note"></i>',  label: 'Sticky note',    key: 'N', sub: 'sticky' },
      { id: 'text',        icon: '<i class="ph ph-text-t"></i>',  label: 'Text',           key: 'T' },
      { id: 'shape',       icon: '<i class="ph ph-square"></i>',  label: 'Shape',          key: 'R', sub: 'shape' },
      { id: 'connector',   icon: '<i class="ph ph-arrow-up-right"></i>',  label: 'Connector',      key: 'C', sub: 'connector' },
      { sep: true },
      { id: 'pen',         icon: '<i class="ph ph-pencil-simple"></i>', label: 'Pen',            key: 'P', sub: 'pen' },
      { id: 'highlighter', icon: '<i class="ph ph-highlighter"></i>', label: 'Highlighter',    key: 'K', sub: 'highlighter' },
      { id: 'eraser',      icon: '<i class="ph ph-eraser"></i>', label: 'Eraser',         key: 'E', sub: 'eraser' },
      { sep: true },
      { id: 'flowchart',   icon: '<i class="ph ph-git-branch"></i>', label: 'Flowchart node', key: 'F', sub: 'flowchart' },
      { id: 'mindmap',     icon: '<i class="ph ph-brain"></i>', label: 'Mind map',       key: 'M' },
      { id: 'algorithm',   icon: '<i class="ph ph-lightning"></i>', label: 'Algorithm block', key: 'A' },
      { id: 'graph',       icon: '<i class="ph ph-chart-bar"></i>', label: 'Chart',          key: 'G', sub: 'graph' },
      { id: 'table',       icon: '<i class="ph ph-table"></i>',  label: 'Table' },
      { id: 'checklist',   icon: '<i class="ph ph-check-square"></i>',  label: 'Checklist' },
      { id: 'code',        icon: '<i class="ph ph-code"></i>',  label: 'Code block' },
      { sep: true },
      { id: 'code-cell',   icon: '<i class="ph ph-terminal-window"></i>', label: 'Live code cell — runs Python & JavaScript' },
      { id: 'logic-lab',   icon: '<i class="ph ph-circuitry"></i>', label: 'Logic circuit — gates with real output' },
      { id: 'sheet-dash',  icon: '<i class="ph ph-chart-line-up"></i>', label: 'Live Google Sheets dashboard' },
      { id: 'gcal',        icon: '<i class="ph ph-calendar-dots"></i>', label: 'Google Calendar — live, editable both ways' },
      { sep: true },
      { id: 'image',       icon: '<i class="ph ph-image"></i>',  label: 'Image',          key: 'I' },
      { id: 'frame',       icon: '<i class="ph ph-bounding-box"></i>',  label: 'Frame' },
      { id: 'comment',     icon: '<i class="ph ph-chat-circle"></i>', label: 'Comment' },
      { id: 'laser',       icon: '<i class="ph ph-dot-outline" style="color:var(--clr-danger)"></i>', label: 'Laser pointer',  key: 'L' },
    ];
  }

  _buildToolbars() {
    const bar = document.getElementById('toolbar-left');
    bar.textContent = '';

    for (const def of this.toolDefs) {
      if (def.sep) {
        const d = document.createElement('div');
        d.className = 'tool-sep';
        bar.appendChild(d);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-btn';
      btn.dataset.tool = def.id;
      btn.title = def.label + (def.key ? `  (${def.key})` : '');
      btn.innerHTML = `<span class="tool-glyph">${def.icon}</span>`;
      if (def.sub) btn.classList.add('has-sub');
      btn.addEventListener('click', () => this.setTool(def.id));
      bar.appendChild(btn);
    }

    this.subMenu = document.getElementById('tool-submenu');
    this._fitToolbar();

    // The palette has to survive a window resize and a browser-chrome
    // change, not just the size it happened to be built at.
    if (!this._toolbarWired) {
      this._toolbarWired = true;
      bar.addEventListener('scroll', () => this._toolbarScrollHint(), { passive: true });
      window.addEventListener('resize', Util.debounce(() => this._fitToolbar(), 120));
    }
  }

  /**
   * Make every tool reachable, whatever the window height.
   *
   * The toolbar has always been `overflow-y: auto` with its scrollbar
   * hidden and nothing else to signal that it scrolls. At 24 tools that
   * is between five and thirteen of them silently below the fold —
   * invisible, and with no hint they exist at all. A tool you cannot see
   * is a tool you do not have.
   *
   * Two steps, in order. First try to make everything fit by tightening
   * the buttons, because a palette you can see in one glance beats one
   * you have to scroll. Only if that is not enough does it stay
   * scrollable — and then it says so, with edge fades that appear on the
   * side there is more to see.
   */
  _fitToolbar() {
    const bar = document.getElementById('toolbar-left');
    if (!bar) return;

    bar.classList.remove('is-dense', 'is-denser');
    if (bar.scrollHeight > bar.clientHeight) bar.classList.add('is-dense');
    if (bar.scrollHeight > bar.clientHeight) bar.classList.add('is-denser');
    this._toolbarScrollHint();
  }

  _toolbarScrollHint() {
    const bar = document.getElementById('toolbar-left');
    if (!bar) return;
    const hidden = bar.scrollHeight - bar.clientHeight;
    bar.classList.toggle('has-more', hidden > 2);
    bar.classList.toggle('at-top', bar.scrollTop <= 1);
    bar.classList.toggle('at-bottom', bar.scrollTop >= hidden - 1);
  }

  setTool(id) {
    this.activeTool = id;
    document.querySelectorAll('.tool-btn').forEach(b =>
      b.classList.toggle('is-active', b.dataset.tool === id));

    const w = this.viewport.wrapper;
    w.dataset.tool = id;
    this._renderSubMenu(id);
    this.overlay.hidePorts();
    if (id !== 'select') this.hidePanels();
  }

  /* ---- contextual sub-menu for the active tool --------------------- */

  _renderSubMenu(tool) {
    const host = this.subMenu;
    host.textContent = '';

    const def = this.toolDefs.find(d => d.id === tool);
    const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
    if (!def || !def.sub || !btn) { host.classList.add('hidden'); return; }

    host.classList.remove('hidden');
    const top = btn.getBoundingClientRect().top;
    host.style.top = Math.max(64, top) + 'px';

    const swatchRow = (colors, current, onPick) => {
      const row = document.createElement('div');
      row.className = 'sub-row';
      for (const c of colors) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'swatch' + (c === current ? ' is-active' : '');
        s.style.background = c;
        s.title = c;
        s.addEventListener('click', () => {
          onPick(c);
          row.querySelectorAll('.swatch').forEach(x => x.classList.toggle('is-active', x === s));
          this.saveSettings();
        });
        row.appendChild(s);
      }
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'swatch-custom';
      custom.value = current;
      custom.title = 'Custom colour';
      custom.addEventListener('input', () => { onPick(custom.value); this.saveSettings(); });
      row.appendChild(custom);
      return row;
    };

    const sliderRow = (label, value, min, max, step, onChange) => {
      const row = document.createElement('label');
      row.className = 'sub-row sub-slider';
      row.innerHTML = `<span>${label}</span>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step; input.value = value;
      const out = document.createElement('b');
      out.textContent = value;
      input.addEventListener('input', () => {
        out.textContent = input.value;
        onChange(parseFloat(input.value));
        this.saveSettings();
      });
      row.appendChild(input);
      row.appendChild(out);
      return row;
    };

    const iconRow = (items, current, onPick) => {
      const row = document.createElement('div');
      row.className = 'sub-row sub-icons';
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sub-icon' + (it.id === current ? ' is-active' : '');
        b.title = it.label;
        b.innerHTML = it.glyph;
        b.addEventListener('click', () => {
          onPick(it.id);
          row.querySelectorAll('.sub-icon').forEach(x => x.classList.toggle('is-active', x === b));
          this.saveSettings();
        });
        row.appendChild(b);
      }
      return row;
    };

    switch (def.sub) {
      case 'sticky':
        // The palette follows the active theme so notes stay readable on a
        // dark canvas instead of glowing like highlighter pen.
        host.appendChild(swatchRow(this.theme.stickyColors, this.settings.stickyColor, c => this.settings.stickyColor = c));
        break;

      case 'shape': {
        const shapes = Object.keys(SHAPE_PATHS).map(k => ({
          id: k,
          label: k,
          glyph: `<svg viewBox="0 0 100 100" width="20" height="20"><path d="${SHAPE_PATHS[k]()}" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="6"/></svg>`,
        }));
        host.appendChild(iconRow(shapes, this.settings.shapeType, v => this.settings.shapeType = v));
        host.appendChild(swatchRow(['#dbe4ff', '#d7f5e3', '#fff0cf', '#ffe0e0', '#f3e8ff', '#ffffff', 'transparent'],
          this.settings.shapeFill, c => this.settings.shapeFill = c));
        host.appendChild(sliderRow('Border', this.settings.shapeStrokeWidth, 0, 10, 1, v => this.settings.shapeStrokeWidth = v));
        break;
      }

      case 'connector':
        host.appendChild(iconRow([
          { id: 'orthogonal', label: 'Elbow', glyph: '<i class="ph ph-corners-out"></i>' },
          { id: 'curved', label: 'Curved', glyph: '<i class="ph ph-wave-sine"></i>' },
          { id: 'straight', label: 'Straight', glyph: '<i class="ph ph-line-segment"></i>' },
        ], this.settings.connectorRouting, v => this.settings.connectorRouting = v));
        host.appendChild(iconRow([
          { id: 'end', label: 'Arrow at end', glyph: '<i class="ph ph-arrow-right"></i>' },
          { id: 'both', label: 'Arrows both ends', glyph: '<i class="ph ph-arrows-left-right"></i>' },
          { id: 'none', label: 'No arrows', glyph: '<i class="ph ph-minus"></i>' },
        ], this.settings.connectorArrowStart ? 'both' : this.settings.connectorArrowEnd ? 'end' : 'none', v => {
          this.settings.connectorArrowEnd = v !== 'none';
          this.settings.connectorArrowStart = v === 'both';
        }));
        host.appendChild(iconRow([
          { id: 'solid', label: 'Solid', glyph: '<i class="ph ph-minus"></i>' },
          { id: 'dashed', label: 'Dashed', glyph: '<i class="ph ph-line-segments"></i>' },
        ], this.settings.connectorDash ? 'dashed' : 'solid', v => this.settings.connectorDash = v === 'dashed' ? '8 5' : null));
        host.appendChild(swatchRow(['#16161d', '#4262ff', '#e74c3c', '#00b894', '#f39c12', '#9b59b6'],
          this.settings.connectorColor, c => this.settings.connectorColor = c));
        break;

      case 'pen': {
        host.appendChild(swatchRow(['#16161d', '#4262ff', '#e74c3c', '#00b894', '#f39c12', '#9b59b6', '#ffffff'],
          this.settings.penColor, c => this.settings.penColor = c));
        host.appendChild(sliderRow('Size', this.settings.penWidth, 1, 24, 1, v => this.settings.penWidth = v));
        const smart = document.createElement('label');
        smart.className = 'sub-row sub-check';
        smart.title = 'Draw a rough rectangle, ellipse, triangle or line and it becomes a real object';
        smart.innerHTML = `<input type="checkbox" ${this.settings.smartShapes ? 'checked' : ''}/> <span>Smart shapes</span>`;
        smart.querySelector('input').addEventListener('change', e => {
          this.settings.smartShapes = e.target.checked;
          this.saveSettings();
        });
        host.appendChild(smart);
        break;
      }

      case 'highlighter':
        host.appendChild(swatchRow(['#ffd93d', '#7bed9f', '#70a1ff', '#ff9ff3', '#ff7f50'],
          this.settings.highlighterColor, c => this.settings.highlighterColor = c));
        host.appendChild(sliderRow('Size', this.settings.highlighterWidth, 6, 60, 2, v => this.settings.highlighterWidth = v));
        break;

      case 'eraser': {
        host.appendChild(sliderRow('Size', this.settings.eraserSize, 6, 80, 2, v => this.settings.eraserSize = v));
        const lab = document.createElement('label');
        lab.className = 'sub-row sub-check';
        lab.innerHTML = `<input type="checkbox" ${this.settings.eraseObjects ? 'checked' : ''}/> <span>Also erase objects</span>`;
        lab.querySelector('input').addEventListener('change', e => {
          this.settings.eraseObjects = e.target.checked;
          this.saveSettings();
        });
        host.appendChild(lab);
        break;
      }

      case 'flowchart': {
        const items = Object.keys(FLOWCHART_PATHS).map(k => ({
          id: k, label: FLOWCHART_LABELS[k] || k,
          glyph: `<svg viewBox="0 0 100 100" width="22" height="22"><path d="${FLOWCHART_PATHS[k]()}" fill="none" stroke="currentColor" stroke-width="7"/></svg>`,
        }));
        host.appendChild(iconRow(items, this.settings.fcType, v => this.settings.fcType = v));
        break;
      }

      case 'graph':
        host.appendChild(iconRow([
          { id: 'bar', label: 'Bar', glyph: '<i class="ph ph-chart-bar"></i>' },
          { id: 'hbar', label: 'Horizontal bar', glyph: '<i class="ph ph-chart-bar-horizontal"></i>' },
          { id: 'line', label: 'Line', glyph: '<i class="ph ph-chart-line-up"></i>' },
          { id: 'area', label: 'Area', glyph: '<i class="ph ph-chart-polar"></i>' },
          { id: 'pie', label: 'Pie', glyph: '<i class="ph ph-chart-pie-slice"></i>' },
          { id: 'donut', label: 'Donut', glyph: '<i class="ph ph-circle-notch"></i>' },
          { id: 'scatter', label: 'Scatter', glyph: '<i class="ph ph-chart-scatter"></i>' },
        ], this.settings.graphType, v => this.settings.graphType = v));
        break;
    }
  }

  /* ================================================================
     ELEMENT CREATION
     ================================================================ */

  createAt(tool, bx, by) {
    const s = this.settings;
    const center = (w, h) => ({ x: bx - w / 2, y: by - h / 2 });

    switch (tool) {
      case 'sticky-note': {
        const p = center(200, 200);
        return this.store.addElement('sticky-note', { ...p, style: { backgroundColor: s.stickyColor, fontSize: 15 } });
      }
      case 'text':
        return this.store.addElement('text', { x: bx, y: by - 20, content: '' });

      case 'flowchart': {
        const p = center(170, s.fcType === 'decision' ? 100 : 74);
        return this.store.addElement('flowchart', {
          ...p, height: s.fcType === 'decision' ? 100 : 74,
          fcType: s.fcType,
          content: FLOWCHART_LABELS[s.fcType] || 'Step',
          style: { backgroundColor: '#ffffff', borderColor: '#16161d', borderWidth: 2, fontSize: 14 },
        });
      }
      case 'mindmap':
        return this.mindmap.createRoot(bx - 90, by - 24, 'Central idea');

      case 'algorithm':
        return this.algorithm.create(bx - 200, by - 110);

      case 'graph':
        return this.charts.create(bx - 210, by - 150, s.graphType);

      case 'table':
        return this.store.addElement('table', {
          x: bx - 230, y: by - 100, width: 460, height: 180,
          tableData: { rows: 3, cols: 3, cells: [['Column A', 'Column B', 'Column C'], ['', '', ''], ['', '', '']] },
        });

      case 'checklist':
        return this.store.addElement('checklist', {
          x: bx - 140, y: by - 100, content: 'Checklist',
          items: [{ text: 'First task', done: false }, { text: 'Second task', done: false }],
        });

      case 'code':
        return this.store.addElement('code', {
          x: bx - 210, y: by - 120, language: 'javascript',
          content: 'function hello() {\n  return "world";\n}',
        });

      case 'code-cell': {
        const d = ELEMENT_DEFAULTS['code-cell'];
        return this.store.addElement('code-cell', {
          ...center(d.width, d.height),
          language: s.codeCellLanguage || 'python',
          content: (s.codeCellLanguage || 'python') === 'python'
            ? 'import math\n\nvalues = [1, 4, 9, 16, 25]\nprint("mean", sum(values) / len(values))\n[math.sqrt(v) for v in values]'
            : 'const values = [1, 4, 9, 16, 25];\nconsole.log("mean", values.reduce((a, b) => a + b) / values.length);\nvalues.map(Math.sqrt)',
          outputs: [], runCount: 0,
        });
      }

      case 'logic-lab': {
        const d = ELEMENT_DEFAULTS['logic-lab'];
        return this.store.addElement('logic-lab', {
          ...center(d.width, d.height),
          circuit: LogicLab.starterCircuit(),
        });
      }

      case 'sheet-dash': {
        const d = ELEMENT_DEFAULTS['sheet-dash'];
        return this.store.addElement('sheet-dash', {
          ...center(d.width, d.height),
          title: 'Live dashboard', range: '', refreshSec: 60, widgets: [],
        });
      }

      case 'gcal': {
        const d = ELEMENT_DEFAULTS.gcal;
        return this.store.addElement('gcal', {
          ...center(d.width, d.height),
          calendarId: 'primary', view: 'agenda', days: 14, refreshSec: 120,
        });
      }

      case 'comment':
        return this.store.addElement('comment', { x: bx, y: by, author: 'You', content: '' });

      case 'frame': {
        const d = ELEMENT_DEFAULTS.frame;
        return this.store.addElement('frame', { ...center(d.width, d.height), content: 'Frame' });
      }
      default:
        return null;
    }
  }

  duplicate(ids, dx = 26, dy = 26, { select = true, silent = false } = {}) {
    const idList = ids || [...this.store.selection];
    const map = new Map();
    const copies = [];

    const run = () => {
      for (const id of idList) {
        const src = this.store.get(id);
        if (!src) continue;
        const clone = Util.clone(src);
        delete clone.id;
        clone.x += dx;
        clone.y += dy;
        clone.zIndex = this.store.nextZ();
        const copy = this.store.addElement(src.type, clone, { silent: true });
        map.set(id, copy.id);
        copies.push(copy);
      }
      // Re-point mind-map links and internal connections at the copies.
      for (const copy of copies) {
        if (copy.mmParent && map.has(copy.mmParent)) copy.mmParent = map.get(copy.mmParent);
        else if (copy.mmParent) { copy.mmParent = null; copy.mmRoot = true; }
        if (copy.mmChildren) copy.mmChildren = copy.mmChildren.map(c => map.get(c)).filter(Boolean);
      }
      for (const conn of this.store.connections.slice()) {
        const a = map.get(conn.from?.id);
        const b = map.get(conn.to?.id);
        if (a && b) {
          this.store.addConnection({ ...Util.clone(conn), id: undefined, from: { ...conn.from, id: a }, to: { ...conn.to, id: b } }, { silent: true });
        }
      }
      if (select) this.store.select(copies.map(c => c.id));
    };

    if (silent) run();
    else this.store.transact('duplicate', run);

    return copies;
  }

  autoSize(id) {
    const el = this.store.get(id);
    if (!el) return;
    const node = this.renderer.node(id);
    if (!node) return;
    if (el.type === 'text') {
      const body = node.querySelector('.el-text-body');
      if (body) {
        const h = Math.max(32, body.scrollHeight + 8);
        if (Math.abs(h - el.height) > 1) { el.height = h; this.renderer.place(el); this.overlay.sync(); }
      }
    } else if (el.type === 'mindmap') {
      this.mindmap.measureNode(id);
    }
  }

  pickImage(boardPoint) {
    const input = document.getElementById('image-input');
    input.value = '';
    input.onchange = () => {
      const files = Array.from(input.files || []);
      files.forEach((file, i) => this.insertImageFile(file, {
        x: (boardPoint?.x ?? 0) + i * 30,
        y: (boardPoint?.y ?? 0) + i * 30,
      }));
      this.setTool('select');
    };
    input.click();
  }

  async insertImageFile(file, at) {
    if (!file.type.startsWith('image/')) return;
    const fd = new FormData();
    fd.append('file', file);
    let url = null;
    try {
      const res = await fetch('/api/upload/image', { method: 'POST', body: fd });
      const data = await res.json();
      url = data.url;
    } catch (_) { /* fall back to a data URL so it still works offline */ }

    if (!url) {
      url = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.readAsDataURL(file);
      });
    }

    const img = new Image();
    img.onload = () => {
      const max = 480;
      const ratio = img.width / img.height;
      const w = img.width > img.height ? max : max * ratio;
      const h = img.width > img.height ? max / ratio : max;
      const el = this.store.addElement('image', {
        x: at.x, y: at.y, width: Math.round(w), height: Math.round(h), src: url,
      });
      this.store.select([el.id]);
    };
    img.onerror = () => Modal.toast('That image could not be loaded.', 'warn');
    img.src = url;
  }

  editTable(id, action) {
    const el = this.store.get(id);
    if (!el) return;
    const d = el.tableData || { rows: 3, cols: 3, cells: [] };
    let rows = Math.max(1, d.rows || 3);
    let cols = Math.max(1, d.cols || 3);
    const cells = (d.cells || []).map(r => [...(r || [])]);

    while (cells.length < rows) cells.push(new Array(cols).fill(''));
    for (let r = 0; r < rows; r++) {
      while (cells[r].length < cols) cells[r].push(r === 0 ? `Col ${cells[r].length + 1}` : '');
    }

    if (action === 'table-add-row') {
      rows++;
      cells.push(new Array(cols).fill(''));
    } else if (action === 'table-del-row' && rows > 1) {
      rows--;
      cells.pop();
    } else if (action === 'table-add-col') {
      cols++;
      cells.forEach((r, idx) => r.push(idx === 0 ? `Col ${cols}` : ''));
    } else if (action === 'table-del-col' && cols > 1) {
      cols--;
      cells.forEach(r => r.pop());
    } else if (action === 'table-clear') {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          cells[r][c] = r === 0 ? `Column ${c + 1}` : '';
        }
      }
    }

    const nextWidth = Math.max(el.width || 420, cols * 140);
    const nextHeight = Math.max(140, rows * 44 + 48);

    this.store.transact('edit table', () => {
      this.store.updateElement(id, {
        width: nextWidth,
        height: nextHeight,
        tableData: { rows, cols, cells },
      });
    });
    this.overlay?.sync();
  }

  /* ================================================================
     PANELS
     ================================================================ */

  _buildPanels() {
    this.panel = document.getElementById('panel-right');
    this.panelBody = document.getElementById('panel-body');
    document.getElementById('panel-close').addEventListener('click', () => this.hidePanels());

    /* While a panel control is being dragged we must not rebuild the panel —
       replacing the slider mid-gesture would drop the drag on the floor. */
    this._panelBusy = false;
    this.panel.addEventListener('pointerdown', (e) => { 
      if (e.target.tagName === 'INPUT' && e.target.type === 'range') {
        this._panelBusy = true; 
      }
    });
    window.addEventListener('pointerup', () => {
      if (!this._panelBusy) return;
      this._panelBusy = false;
      this.updatePropertiesPanel();
    });

    this.layersPanel = document.getElementById('panel-layers');
    document.getElementById('layers-close').addEventListener('click', () =>
      this.layersPanel.classList.add('hidden'));
  }

  hidePanels() {
    this.panel.classList.add('hidden');
  }

  showPropertiesPanel() {
    if (!this.store.selection.size) return this.hidePanels();
    this.panel.classList.remove('hidden');
    this.updatePropertiesPanel();
  }

  showConnectionPanel(connId) {
    const conn = this.store.getConnection(connId);
    if (!conn) return;
    this.panel.classList.remove('hidden');
    const b = this.panelBody;
    b.textContent = '';
    b.appendChild(this._section('Connection', [
      this._selectField('Routing', conn.routing, [
        ['orthogonal', 'Elbow'], ['curved', 'Curved'], ['straight', 'Straight'],
      ], v => this.store.updateConnection(connId, { routing: v })),
      this._selectField('Arrows',
        conn.arrowStart ? 'both' : conn.arrowEnd ? 'end' : 'none',
        [['end', 'End only'], ['both', 'Both ends'], ['none', 'None']],
        v => this.store.updateConnection(connId, {
          arrowEnd: v !== 'none', arrowStart: v === 'both',
        })),
      this._colorField('Colour', conn.style?.color || '#16161d',
        (v, live) => this.store.updateConnection(connId, { style: { color: v } }, { silent: live })),
      this._rangeField('Thickness', conn.style?.width || 2, 1, 10, 0.5,
        (v, live) => this.store.updateConnection(connId, { style: { width: v } }, { silent: live })),
      this._selectField('Line style', conn.style?.dash ? 'dashed' : 'solid',
        [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']],
        v => this.store.updateConnection(connId, {
          style: { dash: v === 'dashed' ? '8 5' : v === 'dotted' ? '2 5' : null },
        })),
      this._textField('Label', conn.label || '',
        v => this.store.updateConnection(connId, { label: v })),
    ]));

    const del = document.createElement('button');
    del.className = 'btn btn-danger full';
    del.type = 'button';
    del.textContent = 'Delete connection';
    del.addEventListener('click', () => { this.store.removeConnections([connId]); this.hidePanels(); });
    b.appendChild(del);
  }

  async promptConnectionLabel(connId) {
    const conn = this.store.getConnection(connId);
    if (!conn) return;
    const v = await Modal.prompt('Label for this connection', conn.label || '', { title: 'Connection label' });
    if (v != null) this.store.updateConnection(connId, { label: v.trim() });
  }

  updatePropertiesPanel() {
    if (this.panel.classList.contains('hidden')) return;
    if (this._panelBusy) return;               // never rebuild mid-gesture
    // A connection-only selection owns the panel via showConnectionPanel().
    // Every 'change' event used to route through here regardless of what's
    // selected, so editing a connection's routing/style immediately hid the
    // panel it was just shown in — the edit "looked" reverted even though
    // it had saved. Leave the panel alone in that case instead of hiding it.
    if (this.store.connSelection.size && !this.store.selection.size) return;
    const sel = this.store.selected();
    if (!sel.length) return this.hidePanels();

    const b = this.panelBody;
    b.textContent = '';
    const multi = sel.length > 1;
    const el = sel[0];

    /**
     * `live` writes without touching history so dragging a slider stays
     * smooth and produces exactly ONE undo step when you let go.
     */
    const apply = (props, label = 'style', live = false) => {
      const write = () => {
        for (const s of sel) this.store.updateElement(s.id, Util.clone(props), { silent: true });
      };
      if (live) {
        write();
        this.store.touch();
        this.overlay.sync();
      } else {
        this.store.transact(label, write);
      }
    };

    /* header */
    const head = document.createElement('div');
    head.className = 'panel-title';
    head.textContent = multi ? `${sel.length} items selected` : this._typeLabel(el.type);
    b.appendChild(head);

    /* position + size */
    b.appendChild(this._section('Position & size', [
      this._numGrid([
        ['X', Math.round(el.x), v => apply({ x: v }, 'move')],
        ['Y', Math.round(el.y), v => apply({ y: v }, 'move')],
        ['W', Math.round(el.width), v => apply({ width: Math.max(8, v) }, 'resize')],
        ['H', Math.round(el.height), v => apply({ height: Math.max(8, v) }, 'resize')],
      ]),
      this._rangeField('Rotation', Math.round(el.rotation || 0), 0, 360, 1,
        (v, live) => apply({ rotation: v }, 'rotate', live)),
    ]));

    /* appearance */
    const appearance = [];
    // The live blocks paint themselves from the theme; a Fill swatch here
    // would set a colour nothing reads, which is worse than no control.
    if (!['image', 'code', 'algorithm', 'graph',
          'code-cell', 'logic-lab', 'sheet-dash', 'gcal'].includes(el.type)) {
      appearance.push(this._colorField('Fill', el.style?.backgroundColor || '#ffffff',
        (v, live) => apply({ style: { backgroundColor: v } }, 'fill', live)));
    }
    if (['shape', 'flowchart', 'frame'].includes(el.type)) {
      appearance.push(this._colorField('Border', el.style?.borderColor || '#16161d',
        (v, live) => apply({ style: { borderColor: v } }, 'border', live)));
      appearance.push(this._rangeField('Border width', el.style?.borderWidth ?? 2, 0, 12, 1,
        (v, live) => apply({ style: { borderWidth: v } }, 'border', live)));
    }
    appearance.push(this._rangeField('Opacity', el.style?.opacity ?? 1, 0.05, 1, 0.05,
      (v, live) => apply({ style: { opacity: v } }, 'opacity', live)));
    b.appendChild(this._section('Appearance', appearance));

    /* text */
    if (['sticky-note', 'text', 'shape', 'flowchart', 'mindmap', 'comment', 'checklist'].includes(el.type)) {
      b.appendChild(this._section('Text', [
        this._rangeField('Size', el.style?.fontSize || 15, 8, 96, 1,
          (v, live) => apply({ style: { fontSize: v } }, 'font size', live)),
        this._colorField('Colour', el.style?.color || Util.readableText(el.style?.backgroundColor),
          (v, live) => apply({ style: { color: v } }, 'text colour', live)),
        this._buttonGroup('Align', el.style?.align || 'left',
          [['left', '<i class="ph ph-text-align-left"></i>'], ['center', '<i class="ph ph-text-align-center"></i>'], ['right', '<i class="ph ph-text-align-right"></i>']],
          v => apply({ style: { align: v } })),
        this._buttonGroup('Style', el.style?.bold ? 'bold' : 'normal',
          [['normal', 'A'], ['bold', 'B']],
          v => apply({ style: { bold: v === 'bold' } })),
      ]));
    }

    /* type-specific */
    if (el.type === 'shape' && !multi) {
      b.appendChild(this._section('Shape', [
        this._shapePicker(el),
        this._selectField('Type', el.shapeType || 'rectangle',
          Object.keys(SHAPE_PATHS).map(k => [k, k]),
          v => this.store.updateElement(el.id, { shapeType: v })),
      ]));
    }
    if (el.type === 'flowchart' && !multi) {
      b.appendChild(this._section('Flowchart', [
        this._selectField('Node type', el.fcType || 'process',
          Object.keys(FLOWCHART_PATHS).map(k => [k, FLOWCHART_LABELS[k] || k]),
          v => this.store.updateElement(el.id, { fcType: v })),
      ]));
    }

    /* Anything that is really "a box with a label" can become any of the
       others after the fact. The element keeps its id, so its connectors,
       group, z-order and any linked task survive the change. */
    if (!multi && CONVERTIBLE_TYPES.has(el.type)) {
      b.appendChild(this._section('Change type', [this._typeConverter(el)]));
    }

    /* Frames mark out an area of the board, so they get an owner. */
    if (!multi && el.type === 'frame' && this.frames) {
      b.appendChild(this._section('Area owner', [this._frameOwners(el)]));
    }

    /* Files and documents can hang off anything. */
    if (!multi && this.attachments) {
      b.appendChild(this._section('Attachments', [this._attachmentList(el)]));
    }
    if (el.type === 'image' && !multi) {
      b.appendChild(this._section('Image', [
        this._selectField('Fit', el.style?.fit || 'contain',
          [['contain', 'Contain'], ['cover', 'Cover'], ['fill', 'Stretch']],
          v => this.store.updateElement(el.id, { style: { fit: v } })),
        this._actionButton('Replace image…', () => this.pickImage({ x: el.x, y: el.y })),
      ]));
    }
    if (el.type === 'graph' && !multi) {
      b.appendChild(this._section('Chart', [
        this._actionButton('Edit chart data…', () => this.charts.openEditor(el.id)),
      ]));
    }
    if (el.type === 'algorithm' && !multi) {
      b.appendChild(this._section('Algorithm', [
        this._actionButton('Edit algorithm…', () => this.algorithm.open(el.id)),
        this._actionButton('Generate flowchart', () =>
          this.algorithm.toFlowchart(el.id, el.algoSteps || [], el.content)),
      ]));
    }
    if (el.type === 'mindmap' && !multi) {
      b.appendChild(this._section('Mind map', [
        this._actionButton('Add child topic  (Tab)', () => this.mindmap.addChild(el.id)),
        this._actionButton('Add sibling  (Enter)', () => this.mindmap.addSibling(el.id)),
        this._actionButton('Re-layout tree', () => this.mindmap.layoutTreeOf(el.id)),
      ]));
    }
    if (el.type === 'table' && !multi) {
      const themeList = (typeof TABLE_THEMES !== 'undefined' ? TABLE_THEMES : []).map(t => [t.id, t.name]);
      b.appendChild(this._section('Table', [
        this._selectField('Theme', el.tableTheme || 'clean-slate', themeList,
          v => this.store.updateElement(el.id, { tableTheme: v })),
        this._actionButton('+ Add Row', () => this.editTable(el.id, 'table-add-row')),
        this._actionButton('+ Add Column', () => this.editTable(el.id, 'table-add-col')),
        this._actionButton('− Remove Row', () => this.editTable(el.id, 'table-del-row')),
        this._actionButton('− Remove Column', () => this.editTable(el.id, 'table-del-col')),
        this._actionButton('Clear Table Data', () => this.editTable(el.id, 'table-clear')),
      ]));
    }

    /* arrange */
    const arrange = document.createElement('div');
    arrange.className = 'panel-section';
    arrange.innerHTML = '<h4>Arrange</h4>';
    const grid = document.createElement('div');
    grid.className = 'btn-grid';
    const arrangeButtons = [
      ['<i class="ph ph-bring-to-front"></i> Front', () => this.reorder('front')],
      ['<i class="ph ph-send-to-back"></i> Back', () => this.reorder('back')],
      ['<i class="ph ph-arrow-up"></i> Forward', () => this.reorder('forward')],
      ['<i class="ph ph-arrow-down"></i> Backward', () => this.reorder('backward')],
    ];
    if (multi) {
      arrangeButtons.push(
        ['<i class="ph ph-align-left"></i> Left', () => this.align('left')], ['<i class="ph ph-align-right"></i> Right', () => this.align('right')],
        ['<i class="ph ph-align-top"></i> Top', () => this.align('top')], ['<i class="ph ph-align-bottom"></i> Bottom', () => this.align('bottom')],
        ['<i class="ph ph-align-center-horizontal"></i> Centre H', () => this.align('cx')], ['<i class="ph ph-align-center-vertical"></i> Centre V', () => this.align('cy')],
        ['<i class="ph ph-arrows-out-line-horizontal"></i> Space H', () => this.distribute('h')], ['<i class="ph ph-arrows-out-line-vertical"></i> Space V', () => this.distribute('v')],
      );
    }
    for (const [label, fn] of arrangeButtons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.innerHTML = label;
      btn.addEventListener('click', fn);
      grid.appendChild(btn);
    }
    arrange.appendChild(grid);
    b.appendChild(arrange);

    /* actions */
    const actions = document.createElement('div');
    actions.className = 'panel-section panel-actions';
    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = 'btn btn-ghost';
    lock.innerHTML = el.locked ? '<i class="ph ph-lock-open"></i> Unlock' : '<i class="ph ph-lock-key"></i> Lock';
    lock.addEventListener('click', () => {
      const next = !el.locked;
      this.store.transact('lock', () => {
        for (const s of sel) this.store.updateElement(s.id, { locked: next }, { silent: true });
      });
      this.updatePropertiesPanel();
    });
    actions.appendChild(lock);

    const dup = document.createElement('button');
    dup.type = 'button';
    dup.className = 'btn btn-ghost';
    dup.innerHTML = '<i class="ph ph-copy"></i> Duplicate';
    dup.addEventListener('click', () => this.duplicate());
    actions.appendChild(dup);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = '🗑 Delete';
    del.addEventListener('click', () => this.deleteSelection());
    actions.appendChild(del);

    b.appendChild(actions);
  }

  _typeLabel(type) {
    return ({
      'sticky-note': 'Sticky note', text: 'Text', shape: 'Shape', image: 'Image',
      frame: 'Frame', flowchart: 'Flowchart node', mindmap: 'Mind map topic',
      graph: 'Chart', algorithm: 'Algorithm block', table: 'Table',
      checklist: 'Checklist', code: 'Code block', comment: 'Comment', embed: 'Embed',
      'code-cell': 'Live code cell', 'logic-lab': 'Logic circuit',
      'sheet-dash': 'Sheets dashboard', gcal: 'Google Calendar',
    })[type] || type;
  }

  /* ---- little field builders ---------------------------------------- */

  _section(title, fields) {
    const s = document.createElement('div');
    s.className = 'panel-section';
    s.innerHTML = `<h4>${Util.escapeHTML(title)}</h4>`;
    for (const f of fields) if (f) s.appendChild(f);
    return s;
  }

  _numGrid(rows) {
    const grid = document.createElement('div');
    grid.className = 'num-grid';
    for (const [label, value, onChange] of rows) {
      const wrap = document.createElement('label');
      wrap.className = 'num-field';
      wrap.innerHTML = `<span>${label}</span>`;
      const input = document.createElement('input');
      input.type = 'number';
      input.value = value;
      input.addEventListener('change', () => onChange(parseFloat(input.value) || 0));
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    return grid;
  }

  /* `onChange(value, live)` — live=true means "preview, don't record". */
  _colorField(label, value, onChange) {
    const row = document.createElement('label');
    row.className = 'field-row';
    row.innerHTML = `<span>${Util.escapeHTML(label)}</span>`;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'color';
    input.value = (value && String(value).startsWith('#')) ? value : '#ffffff';
    input.addEventListener('input', () => onChange(input.value, true));
    input.addEventListener('change', () => onChange(input.value, false));
    row.appendChild(input);
    return row;
  }

  _rangeField(label, value, min, max, step, onChange) {
    const row = document.createElement('label');
    row.className = 'field-row field-range';
    row.innerHTML = `<span>${Util.escapeHTML(label)}</span>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = value;
    const out = document.createElement('b');
    out.textContent = value;
    let raf = null;
    input.addEventListener('input', () => {
      out.textContent = input.value;
      if (raf) return;                       // one write per frame while dragging
      raf = requestAnimationFrame(() => { raf = null; onChange(parseFloat(input.value), true); });
    });
    input.addEventListener('change', () => {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      onChange(parseFloat(input.value), false);   // one undo step on release
    });
    row.appendChild(input);
    row.appendChild(out);
    return row;
  }

  _selectField(label, value, options, onChange) {
    const row = document.createElement('label');
    row.className = 'field-row';
    row.innerHTML = `<span>${Util.escapeHTML(label)}</span>`;
    const sel = document.createElement('select');
    sel.className = 'input';
    for (const [v, t] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(sel);
    return row;
  }

  _textField(label, value, onChange) {
    const row = document.createElement('label');
    row.className = 'field-row';
    row.innerHTML = `<span>${Util.escapeHTML(label)}</span>`;
    const input = document.createElement('input');
    input.className = 'input';
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
    row.appendChild(input);
    return row;
  }

  _buttonGroup(label, value, options, onChange) {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `<span>${Util.escapeHTML(label)}</span>`;
    const group = document.createElement('div');
    group.className = 'btn-group';
    for (const [v, t] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-mini' + (v === value ? ' is-active' : '');
      b.innerHTML = t;
      b.addEventListener('click', () => {
        group.querySelectorAll('.btn-mini').forEach(x => x.classList.toggle('is-active', x === b));
        onChange(v);
      });
      group.appendChild(b);
    }
    row.appendChild(group);
    return row;
  }

  _actionButton(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost full';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  /**
   * A visual grid of every shape, so re-shaping an existing object is one
   * click on the thing you want rather than hunting through a dropdown of
   * raw identifiers.
   */
  _shapePicker(el) {
    const grid = document.createElement('div');
    grid.className = 'shape-picker';
    const current = el.shapeType || 'rectangle';
    for (const key of Object.keys(SHAPE_PATHS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'shape-picker-cell' + (key === current ? ' is-active' : '');
      b.title = key.replace(/-/g, ' ');
      b.innerHTML =
        `<svg viewBox="0 0 100 100" width="22" height="22" aria-hidden="true">` +
        `<path d="${SHAPE_PATHS[key]()}" fill="currentColor" opacity=".2" ` +
        `stroke="currentColor" stroke-width="6" vector-effect="non-scaling-stroke"/></svg>`;
      b.addEventListener('click', () => {
        grid.querySelectorAll('.shape-picker-cell').forEach(x => x.classList.toggle('is-active', x === b));
        this.store.updateElement(el.id, { shapeType: key });
      });
      grid.appendChild(b);
    }
    return grid;
  }

  /**
   * Convert an element to another type in place.
   *
   * The id is preserved deliberately: connectors, groups, z-order and any
   * linked project task all reference elements by id, so converting keeps
   * every one of those intact. Only the fields that belong to the old type
   * and would be meaningless on the new one are dropped.
   */
  _typeConverter(el) {
    const row = document.createElement('div');
    row.className = 'type-converter';

    for (const [type, label, glyph] of CONVERT_TARGETS) {
      if (type === el.type) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'type-converter-cell';
      b.title = `Turn this into a ${label.toLowerCase()}`;
      b.innerHTML = `${glyph}<span>${label}</span>`;
      b.addEventListener('click', () => this.convertElementType(el.id, type));
      row.appendChild(b);
    }
    return row;
  }

  /** The attachment list for the properties panel, with its add button. */
  _attachmentList(el) {
    const wrap = document.createElement('div');
    wrap.className = 'panel-attachments';

    const items = el.attachments || [];
    for (const att of items) {
      const row = document.createElement('div');
      row.className = 'panel-att-row';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'panel-att-open';
      open.title = att.url;
      open.innerHTML =
        `<i class="ph ${attachmentIconFor(att)}"></i>` +
        `<span>${Util.escapeHTML(att.name)}</span>`;
      open.addEventListener('click', () => this.attachments.open(att));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'panel-att-del';
      del.title = 'Remove';
      del.innerHTML = '<i class="ph ph-x"></i>';
      del.addEventListener('click', () => {
        this.attachments.remove(el.id, att.id);
        this.showPropertiesPanel();
      });

      row.append(open, del);
      wrap.appendChild(row);
    }

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-att-empty';
      empty.textContent = 'Nothing attached.';
      wrap.appendChild(empty);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-ghost full';
    add.innerHTML = '<i class="ph ph-paperclip"></i> Attach a file or document';
    add.addEventListener('click', e => this.attachments.menu(el.id, e));
    wrap.appendChild(add);

    return wrap;
  }

  /** Who owns this frame's area of the board. */
  _frameOwners(el) {
    const wrap = document.createElement('div');
    wrap.className = 'panel-frame-owners';

    const owners = el.assignees || [];
    const summary = document.createElement('p');
    summary.className = 'panel-att-empty';
    summary.textContent = owners.length
      ? owners.map(o => o.name || o.email).join(', ')
      : 'Nobody owns this area yet.';
    wrap.appendChild(summary);

    const assign = document.createElement('button');
    assign.type = 'button';
    assign.className = 'btn btn-ghost full';
    assign.innerHTML = `<i class="ph ph-users"></i> ${owners.length ? 'Change owners' : 'Assign to teammates'}`;
    assign.addEventListener('click', () => this.frames.openAssignPanel(el.id, assign));
    wrap.appendChild(assign);

    const overview = document.createElement('button');
    overview.type = 'button';
    overview.className = 'btn btn-ghost full';
    overview.innerHTML = '<i class="ph ph-squares-four"></i> All areas on this board';
    overview.addEventListener('click', () => this.frames.openOverview());
    wrap.appendChild(overview);

    return wrap;
  }

  /** Retype one element, keeping its id, box, text and connections. */
  convertElementType(id, type) {
    const el = this.store.get(id);
    if (!el || el.type === type || !CONVERTIBLE_TYPES.has(type)) return;

    const defaults = ELEMENT_DEFAULTS[type] || {};
    const patch = { type, style: { ...(el.style || {}), ...(defaults.style || {}) } };

    // Type-specific fields only mean something on their own type. Set the one
    // the target needs; leave the others alone rather than writing undefined
    // over them, which would put a literal `undefined` on the element.
    if (type === 'shape') patch.shapeType = el.shapeType || defaults.shapeType || 'rectangle';
    if (type === 'flowchart') patch.fcType = el.fcType || defaults.fcType || 'process';

    // Text draws no box, so a fill carried over from a sticky would paint a
    // rectangle behind bare text.
    if (type === 'text') delete patch.style.backgroundColor;

    // Everything the user chose by hand — type size, alignment, weight,
    // opacity — outranks the target type's defaults.
    for (const k of ['fontSize', 'align', 'bold', 'opacity', 'color']) {
      if (el.style?.[k] !== undefined) patch.style[k] = el.style[k];
    }

    this.store.transact('change type', () => {
      this.store.updateElement(id, patch);
      // Boxes have minimums; a 44px-tall text turned into a shape is a sliver.
      const minH = defaults.height ? Math.min(defaults.height, 80) : 0;
      if (minH && el.height < minH) this.store.updateElement(id, { height: minH });
      if (AUTO_HEIGHT_TYPES.has(type)) this.autoSize?.(id);
    });

    this.renderer.patch(this.store.get(id));
    this.connections.refreshFor(id);
    this.showPropertiesPanel();
    Modal.toast(`Changed to ${type.replace('-', ' ')}.`, 'success', 1600);
  }

  /* ================================================================
     ARRANGE
     ================================================================ */

  reorder(mode) {
    const sel = this.store.selected();
    if (!sel.length) return;
    this.store.transact('reorder', () => {
      const all = this.store.elements.slice().sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      if (mode === 'front') for (const el of sel) el.zIndex = this.store.nextZ();
      else if (mode === 'back') {
        const min = Math.min(...all.map(e => e.zIndex || 0));
        sel.forEach((el, i) => el.zIndex = min - sel.length + i);
      } else {
        const delta = mode === 'forward' ? 1.5 : -1.5;
        for (const el of sel) el.zIndex = (el.zIndex || 0) + delta;
      }
      for (const el of sel) this.renderer.place(el);
    });
  }

  align(mode) {
    const sel = this.store.selected().filter(e => !e.locked);
    if (sel.length < 2) return;
    const b = Util.boundsOf(sel);
    this.store.transact('align', () => {
      for (const el of sel) {
        if (mode === 'left') el.x = b.x;
        if (mode === 'right') el.x = b.x + b.w - el.width;
        if (mode === 'cx') el.x = b.x + (b.w - el.width) / 2;
        if (mode === 'top') el.y = b.y;
        if (mode === 'bottom') el.y = b.y + b.h - el.height;
        if (mode === 'cy') el.y = b.y + (b.h - el.height) / 2;
        this.renderer.place(el);
      }
      this.connections.refreshFor(sel.map(e => e.id));
    });
  }

  distribute(axis) {
    const sel = this.store.selected().filter(e => !e.locked);
    if (sel.length < 3) { Modal.toast('Select three or more items to distribute.', 'warn'); return; }
    const key = axis === 'h' ? 'x' : 'y';
    const size = axis === 'h' ? 'width' : 'height';
    const sorted = sel.slice().sort((a, b) => a[key] - b[key]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const span = (last[key] + last[size]) - first[key];
    const totalSize = sorted.reduce((s, e) => s + e[size], 0);
    const gap = (span - totalSize) / (sorted.length - 1);

    this.store.transact('distribute', () => {
      let cursor = first[key];
      for (const el of sorted) {
        el[key] = cursor;
        cursor += el[size] + gap;
        this.renderer.place(el);
      }
      this.connections.refreshFor(sorted.map(e => e.id));
    });
  }

  deleteSelection() {
    const sel = this.store.selected();
    const conns = [...this.store.connSelection];
    if (!sel.length && !conns.length) return;

    // Mind-map nodes take their whole branch with them.
    const mmRoots = sel.filter(e => e.type === 'mindmap');
    if (mmRoots.length) {
      this.store.transact('delete', () => {
        const ids = new Set();
        for (const n of mmRoots) { ids.add(n.id); this.mindmap.descendantIds(n.id).forEach(i => ids.add(i)); }
        for (const e of sel) if (e.type !== 'mindmap') ids.add(e.id);
        const parents = new Set(mmRoots.map(n => n.mmParent).filter(Boolean));
        this.store.removeElements([...ids], { silent: true });
        if (conns.length) this.store.removeConnections(conns, { silent: true });
        for (const p of parents) if (this.store.get(p)) this.mindmap.layoutTreeOf(p);
      });
    } else {
      this.store.transact('delete', () => {
        if (sel.length) this.store.removeElements(sel.map(e => e.id), { silent: true });
        if (conns.length) this.store.removeConnections(conns, { silent: true });
      });
    }
    this.hidePanels();
  }

  /* ================================================================
     TOP BAR
     ================================================================ */

  _bindTopBar() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    on('undo-btn', () => this.store.undo());
    on('redo-btn', () => this.store.redo());
    on('zoom-in-btn', () => this.viewport.zoomBy(1.2));
    on('zoom-out-btn', () => this.viewport.zoomBy(1 / 1.2));
    on('zoom-fit-btn', () => this.viewport.zoomToFit());
    on('zoom-reset-btn', () => this.viewport.zoomTo(1));
    on('theme-btn', () => this.theme.toggle());
    on('appearance-btn', () => this.theme.openPicker());
    on('cmdk-btn', () => this.cmdk.toggle());
    on('live-btn', () => this.live.toggle());
    on('share-board-btn', () => this.live.openShareDialog());
    on('vote-btn', () => this.workshop.toggleVoting());
    on('timer-btn', () => this.workshop.openTimer());
    on('history-btn', () => this.versions.open());
    /* Tidy-up, auto-layout and the outline have no top-bar button — they are
       reached from the command palette, the right-click menu and the
       shortcuts above. See the note in index.html. */

    // Right-clicking the theme button jumps straight to the full picker.
    document.getElementById('theme-btn')?.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.theme.openPicker();
    });

    on('grid-btn', () => {
      this.settings.gridVisible = !this.settings.gridVisible;
      this.applyGrid();
      this.saveSettings();
    });
    on('snap-btn', () => {
      this.settings.snapToGrid = !this.settings.snapToGrid;
      this.applyGrid();
      this.saveSettings();
      Modal.toast('Grid snapping ' + (this.settings.snapToGrid ? 'on' : 'off'), 'info', 1400);
    });

    on('layers-btn', () => {
      this.layersPanel.classList.toggle('hidden');
      if (!this.layersPanel.classList.contains('hidden')) this.renderLayers();
    });

    on('templates-btn', () => this.openTemplates());
    on('library-btn', () => this.library.open());
    on('gw-panel-btn', () => {
      if (this.gwPanel) this.gwPanel.toggle();
      else Modal.toast('Google Workspace panel is not available.', 'warn');
    });
    on('export-btn', () => this.openExport());
    on('import-btn', () => document.getElementById('json-input').click());
    on('save-btn', () => this.save({ server: true }));
    on('help-btn', () => this.openShortcuts());
    on('present-btn', () => this.togglePresent());
    on('clear-btn', async () => {
      if (await Modal.confirm('Clear everything on this board? You can still undo afterwards.',
        { title: 'Clear board', confirmLabel: 'Clear' })) {
        this.store.clear();
        Modal.toast('Board cleared.', 'info');
      }
    });
    on('search-btn', () => this.openSearch());

    document.getElementById('board-name').addEventListener('change', e => {
      this.store.state.name = e.target.value.trim() || 'Untitled Board';
      this._autosave();
    });

    document.getElementById('json-input').addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) this.importJSONFile(file);
      e.target.value = '';
    });

    /* context menu */
    this.contextMenu = document.getElementById('context-menu');
    this.contextMenu.addEventListener('click', e => {
      const btn = e.target.closest('[data-cmd]');
      if (!btn) return;
      this.closeContextMenu();
      this.runCommand(btn.dataset.cmd);
    });
    document.addEventListener('pointerdown', e => {
      if (!this.contextMenu.contains(e.target)) this.closeContextMenu();
    });
  }

  openContextMenu(clientX, clientY, ctx) {
    const items = [];
    if (ctx.onConnection) {
      items.push(['Edit label…', 'conn-label'], ['Delete connection', 'delete']);
    } else if (ctx.onElement) {
      const multi = this.store.selection.size > 1;
      items.push(
        ['Copy', 'copy'], ['Duplicate', 'duplicate'], ['Paste', 'paste'], null,
        ['Bring to front', 'front'], ['Send to back', 'back'], null,
      );
      if (multi) items.push(['Tidy up into a grid', 'tidy'], ['Group', 'group'], ['Wrap in a frame', 'wrap'], null);
      items.push(
        ['Add a reaction…', 'react'], ['Convert to…', 'convert'], null,
        // Scheduling something is a thought you have mid-diagram. Making
        // it require a calendar block on the canvas first turns a
        // ten-second action into a layout decision.
        ['Schedule in Google Calendar…', 'gcal-event'], null,
        ['Lock / unlock', 'lock'], ['Delete', 'delete'],
      );
    } else {
      items.push(
        ['Paste here', 'paste'], ['Select all', 'select-all'], null,
        ['Add sticky note', 'add-sticky'], ['Add text', 'add-text'],
        ['Templates…', 'templates'], null,
        ['New calendar event…', 'gcal-event'], null,
        ['Zoom to fit', 'fit'], ['Reset zoom', 'reset-zoom'],
        ['Command palette', 'cmdk'],
      );
    }

    this.contextMenu.classList.remove('ctx-reactions');
    this.contextMenu.textContent = '';
    for (const item of items) {
      if (!item) {
        const d = document.createElement('div');
        d.className = 'ctx-sep';
        this.contextMenu.appendChild(d);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.cmd = item[1];
      b.textContent = item[0];
      if (item[1] === 'delete') b.className = 'ctx-danger';
      this.contextMenu.appendChild(b);
    }

    this.contextMenu.classList.remove('hidden');
    const r = this.contextMenu.getBoundingClientRect();
    this.contextMenu.style.left = Math.min(clientX, window.innerWidth - r.width - 8) + 'px';
    this.contextMenu.style.top = Math.min(clientY, window.innerHeight - r.height - 8) + 'px';
  }

  closeContextMenu() { this.contextMenu?.classList.add('hidden'); }

  runCommand(cmd) {
    const at = this.viewport.screenToBoard(
      this._lastPointer.x - this.viewport.wrapper.getBoundingClientRect().left,
      this._lastPointer.y - this.viewport.wrapper.getBoundingClientRect().top
    );
    switch (cmd) {
      case 'copy': return this.copy();
      case 'paste': return this.paste(at);
      case 'duplicate': return this.duplicate();
      case 'delete': return this.deleteSelection();
      case 'front': return this.reorder('front');
      case 'back': return this.reorder('back');
      case 'lock': {
        const sel = this.store.selected();
        if (!sel.length) return;
        const next = !sel[0].locked;
        return this.store.transact('lock', () => {
          for (const e of sel) this.store.updateElement(e.id, { locked: next }, { silent: true });
        });
      }
      case 'select-all': return this.store.selectAll();
      case 'gcal-event':
        if (!window.GCalComposeFromSelection) {
          return Modal.toast('The calendar module did not load.', 'warn');
        }
        return window.GCalComposeFromSelection(this);
      case 'add-sticky': { const el = this.createAt('sticky-note', at.x, at.y); this.store.select([el.id]); return; }
      case 'add-text': { const el = this.createAt('text', at.x, at.y); this.store.select([el.id]); return; }
      case 'fit': return this.viewport.zoomToFit();
      case 'reset-zoom': return this.viewport.zoomTo(1);
      case 'conn-label': return this.promptConnectionLabel([...this.store.connSelection][0]);
      case 'tidy': return this.arranger.tidy();
      case 'group': return this.group();
      case 'wrap': return this.converter.wrapInFrame();
      case 'templates': return this.openTemplates();
      case 'cmdk': return this.cmdk.open();
      case 'react': {
        const id = [...this.store.selection][0];
        if (id) this.workshop.openReactionPicker(id, this._lastPointer.x, this._lastPointer.y);
        return;
      }
      case 'convert': return this.cmdk.open('Selection →');
    }
  }

  /* ================================================================
     CLIPBOARD
     ================================================================ */

  /**
   * Is this node somewhere text is being typed?
   *
   * Covers the three form tags, contentEditable, and the live blocks'
   * own editors — a code cell's textarea is a real editor and its paste
   * must reach it, not the canvas behind it.
   */
  _isTextTarget(node) {
    if (!node || node === document.body) return false;
    if (node.isContentEditable) return true;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) return true;
    return !!node.closest?.('.wb-live-ui, .is-editing');
  }

  _bindClipboard() {
    document.addEventListener('pointermove', e => {
      this._lastPointer = { x: e.clientX, y: e.clientY };
    }, { passive: true });

    document.addEventListener('paste', e => {
      // Paste belongs to the caret whenever there is one.
      //
      // This used to exempt contentEditable only, which is not where most
      // of the app's typing happens: every <input> and <textarea> — the
      // Keep token box, the invite addresses, the board name, search, a
      // dashboard's spreadsheet link, a code cell — was having its paste
      // stolen and turned into a sticky note on the canvas. The field
      // stayed empty and a note appeared behind the dialog, which is
      // unusable and looks like the dialog is broken.
      //
      // The keyboard-shortcut handler already stands down for these three
      // tags; this one simply never learned to.
      if (this._isTextTarget(e.target) || this._isTextTarget(document.activeElement)) return;

      // Nor should the canvas swallow a paste aimed at anything inside an
      // open dialog, even where the focus has not landed on a field yet.
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;

      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find(i => i.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const rect = this.viewport.wrapper.getBoundingClientRect();
        const at = this.viewport.screenToBoard(this._lastPointer.x - rect.left, this._lastPointer.y - rect.top);
        this.insertImageFile(imageItem.getAsFile(), at);
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim()) {
        try {
          const data = JSON.parse(text);
          if (data && data.__wbpro) { e.preventDefault(); return this._pastePayload(data); }
        } catch (_) { /* plain text */ }
        e.preventDefault();
        const rect = this.viewport.wrapper.getBoundingClientRect();
        const at = this.viewport.screenToBoard(this._lastPointer.x - rect.left, this._lastPointer.y - rect.top);
        const el = this.store.addElement('sticky-note', {
          x: at.x, y: at.y, content: text.slice(0, 2000),
          style: { backgroundColor: this.settings.stickyColor, fontSize: 15 },
        });
        this.store.select([el.id]);
      }
    });
  }

  copy() {
    const sel = this.store.selected();
    if (!sel.length) return;
    const ids = new Set(sel.map(e => e.id));
    const payload = {
      __wbpro: 2,
      elements: Util.clone(sel),
      connections: Util.clone(this.store.connections.filter(c => ids.has(c.from?.id) && ids.has(c.to?.id))),
    };
    this.clipboard = payload;
    navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => {});
    Modal.toast(`${sel.length} item${sel.length > 1 ? 's' : ''} copied.`, 'info', 1400);
  }

  cut() { this.copy(); this.deleteSelection(); }

  paste(at) {
    const payload = this.clipboard;
    if (!payload || !payload.elements?.length) return;
    this._pastePayload(payload, at);
  }

  _pastePayload(payload, at) {
    const b = Util.boundsOf(payload.elements);
    const target = at || this.viewport.screenToBoard(this.viewport.width / 2, this.viewport.height / 2);
    const dx = target.x - b.x - b.w / 2;
    const dy = target.y - b.y - b.h / 2;

    this.store.transact('paste', () => {
      const map = new Map();
      const created = [];
      for (const src of payload.elements) {
        const clone = Util.clone(src);
        const oldId = clone.id;
        delete clone.id;
        clone.x += dx;
        clone.y += dy;
        clone.zIndex = this.store.nextZ();
        const el = this.store.addElement(src.type, clone, { silent: true });
        map.set(oldId, el.id);
        created.push(el);
      }
      for (const el of created) {
        if (el.mmParent) el.mmParent = map.get(el.mmParent) || null;
        if (!el.mmParent && el.type === 'mindmap') el.mmRoot = true;
        if (el.mmChildren) el.mmChildren = el.mmChildren.map(c => map.get(c)).filter(Boolean);
      }
      for (const c of (payload.connections || [])) {
        const from = map.get(c.from?.id), to = map.get(c.to?.id);
        if (!from || !to) continue;
        const clone = Util.clone(c);
        delete clone.id;
        clone.from = { ...clone.from, id: from };
        clone.to = { ...clone.to, id: to };
        this.store.addConnection(clone, { silent: true });
      }
      this.store.select(created.map(e => e.id));
    });
    this.showPropertiesPanel();
  }

  /* ================================================================
     KEYBOARD
     ================================================================ */

  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      const editing = e.target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

      if (editing) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      // The Google Keep dialog is markup that is always in the document and
      // merely carries `.hidden`, so the old `.modal-overlay` test matched on
      // every single keypress and silently killed EVERY shortcut in the app —
      // undo, delete, the tool letters, all of it. Only a *visible* overlay
      // should swallow board shortcuts.
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;

      const ctrl = e.ctrlKey || e.metaKey;

      if (e.code === 'Space' && !this.interaction.spaceHeld) {
        e.preventDefault();
        this.interaction.spaceHeld = true;
        this.viewport.wrapper.classList.add('space-pan');
        return;
      }

      if (ctrl) {
        const k = e.key.toLowerCase();
        const map = {
          z: () => e.shiftKey ? this.store.redo() : this.store.undo(),
          y: () => this.store.redo(),
          c: () => this.copy(),
          x: () => this.cut(),
          v: () => { /* handled by the paste event */ },
          d: () => this.duplicate(),
          a: () => { this.store.selectAll(); this.showPropertiesPanel(); },
          s: () => this.save({ server: true }),
          e: () => this.openExport(),
          f: () => this.openSearch(),
          k: () => this.cmdk.toggle(),
          g: () => e.shiftKey ? this.ungroup() : this.group(),
          // These only bind with Shift, so a bare Ctrl+U / L / H / P is left
          // to the browser (view source, address bar, history, print).
          // Note: tidy-up is Ctrl+Shift+U, not the more obvious Ctrl+Shift+T —
          // Chrome reserves that one for "reopen closed tab" and never
          // delivers it to the page at all.
          u: () => e.shiftKey ? (this.arranger.tidy(), true) : false,
          l: () => e.shiftKey ? (this.arranger.autoLayoutFlow(), true) : false,
          h: () => e.shiftKey ? (this.versions.open(), true) : false,
          p: () => e.shiftKey ? (this.cmdk.toggle(), true) : false,
          '=': () => this.viewport.zoomBy(1.2),
          '+': () => this.viewport.zoomBy(1.2),
          '-': () => this.viewport.zoomBy(1 / 1.2),
          '0': () => this.viewport.zoomTo(1),
          '1': () => this.viewport.zoomToFit(),
          '2': () => this.viewport.zoomToSelection(),
        };
        const fn = map[k];
        if (!fn) return;
        if (fn() === false) return;          // handler declined — let the browser have it
        if (k !== 'v') e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'Delete':
          e.preventDefault();
          return this.deleteSelection();

        case 'Backspace':
          // Backspace does NOT delete element (only Del key deletes elements)
          return;

        case 'Escape':
          this.interaction.cancelGesture();
          this.store.clearSelection();
          this.hidePanels();
          this.closeContextMenu();
          this.cmdk?.close();
          if (this.workshop?.voting) this.workshop.toggleVoting();
          if (document.body.classList.contains('is-focus')) this.studio.toggleFocus();
          if (this._presenting) this.togglePresent();
          return;

        case 'F11':
          e.preventDefault();
          return this.studio.toggleFocus();

        case '?':
          e.preventDefault();
          return this.openShortcuts();

        case 'Tab': {
          const sel = this.store.selected();
          if (sel.length === 1 && sel[0].type === 'mindmap') {
            e.preventDefault();
            return this.mindmap.addChild(sel[0].id);
          }
          return;
        }

        case 'Enter': {
          const sel = this.store.selected();
          if (sel.length !== 1) return;
          e.preventDefault();
          if (sel[0].type === 'mindmap') return this.mindmap.addSibling(sel[0].id);
          const label = this.renderer.node(sel[0].id)?.querySelector('.editable');
          if (label) this.renderer.beginEdit(sel[0].id, label);
          return;
        }

        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
          if (!this.store.selection.size) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          return this.nudge(dx, dy);
        }

        case '[': return this.reorder('backward');
        case ']': return this.reorder('forward');
      }

      // If an element is selected and the user types a single character (letter, digit, punctuation),
      // start editing that element rather than activating toolbar hotkeys!
      const sel = this.store.selected();
      if (sel.length === 1 && !ctrl && !e.altKey && e.key.length === 1) {
        const el = sel[0];
        if (!el.locked) {
          if (el.type === 'algorithm') {
            e.preventDefault();
            return this.algorithm?.open(el.id);
          }
          if (el.type === 'graph') {
            e.preventDefault();
            return this.charts?.openEditor(el.id);
          }
          const label = this.renderer.node(el.id)?.querySelector('.editable');
          if (label) {
            e.preventDefault();
            return this.renderer.beginEdit(el.id, label, e.key);
          }
        }
      }

      // Tool switching hotkeys only fire when NO element is selected
      if (!this.store.selection.size) {
        const toolKeys = {
          v: 'select', h: 'hand', n: 'sticky-note', t: 'text', r: 'shape',
          c: 'connector', p: 'pen', k: 'highlighter', e: 'eraser',
          f: 'flowchart', m: 'mindmap', a: 'algorithm', g: 'graph',
          i: 'image', l: 'laser',
        };
        const tool = toolKeys[e.key.toLowerCase()];
        if (tool) { e.preventDefault(); this.setTool(tool); }
      }
    });

    document.addEventListener('keyup', e => {
      if (e.code === 'Space') {
        this.interaction.spaceHeld = false;
        this.viewport.wrapper.classList.remove('space-pan');
      }
    });
  }

  /** Arrow-key nudging now records history and re-routes connections. */
  nudge(dx, dy) {
    const sel = this.store.selected().filter(e => !e.locked);
    if (!sel.length) return;
    this.store.transact('nudge', () => {
      for (const el of sel) {
        el.x += dx;
        el.y += dy;
        this.renderer.place(el);
      }
      this.connections.refreshFor(sel.map(e => e.id));
    });
    this.overlay.sync();
    this.updatePropertiesPanel();
  }

  /**
   * Group / ungroup are separate commands now. The old single toggle meant
   * that adding one more object to an existing group silently ungrouped
   * everything instead, which is why "grouping does nothing" kept coming up.
   */
  group() {
    const sel = this.store.selected();
    if (sel.length < 2) { Modal.toast('Select two or more objects to group.', 'warn', 1800); return; }
    const gid = Util.uid('grp');
    this.store.transact('group', () => {
      for (const el of sel) this.store.updateElement(el.id, { groupId: gid }, { silent: true });
    });
    Modal.toast(`Grouped ${sel.length} objects — they now move together.`, 'success', 1800);
  }

  ungroup() {
    const sel = this.store.selected().filter(e => e.groupId);
    if (!sel.length) { Modal.toast('Nothing grouped in that selection.', 'warn', 1600); return; }
    const gids = new Set(sel.map(e => e.groupId));
    const all = this.store.elements.filter(e => gids.has(e.groupId));
    this.store.transact('ungroup', () => {
      for (const el of all) this.store.updateElement(el.id, { groupId: null }, { silent: true });
    });
    Modal.toast('Ungrouped.', 'info', 1400);
  }

  /* ================================================================
     LAYERS
     ================================================================ */

  renderLayers() {
    const host = document.getElementById('layers-list');
    host.textContent = '';
    const els = this.store.elements.slice().sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
    if (!els.length) {
      host.innerHTML = '<p class="muted">Nothing on the board yet.</p>';
      return;
    }
    for (const el of els) {
      const row = document.createElement('div');
      row.className = 'layer-row' + (this.store.selection.has(el.id) ? ' is-selected' : '');
      const name = (el.content || el.graphTitle || this._typeLabel(el.type)).slice(0, 34) || this._typeLabel(el.type);
      row.innerHTML =
        `<span class="layer-type">${this._typeGlyph(el.type)}</span>` +
        `<span class="layer-name">${Util.escapeHTML(name)}</span>` +
        `<button class="layer-btn" data-act="vis" title="Show / hide">${el.hidden ? '🙈' : '👁'}</button>` +
        `<button class="layer-btn" data-act="lock" title="Lock / unlock">${el.locked ? '🔒' : '🔓'}</button>`;

      row.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'vis') { this.store.updateElement(el.id, { hidden: !el.hidden }); this.renderLayers(); return; }
        if (act === 'lock') { this.store.updateElement(el.id, { locked: !el.locked }); this.renderLayers(); return; }
        this.store.select([el.id], { additive: e.shiftKey });
        this.showPropertiesPanel();
        this.renderLayers();
      });
      host.appendChild(row);
    }
  }

  _typeGlyph(type) {
    return ({
      'sticky-note': '<i class="ph ph-note"></i>', text: '<i class="ph ph-text-t"></i>', shape: '<i class="ph ph-square"></i>', image: '<i class="ph ph-image"></i>', frame: '<i class="ph ph-bounding-box"></i>',
      flowchart: '<i class="ph ph-git-branch"></i>', mindmap: '<i class="ph ph-brain"></i>', graph: '<i class="ph ph-chart-bar"></i>', algorithm: '<i class="ph ph-lightning"></i>',
      table: '<i class="ph ph-table"></i>', checklist: '<i class="ph ph-check-square"></i>', code: '<i class="ph ph-code"></i>', comment: '<i class="ph ph-chat-circle"></i>', embed: '<i class="ph ph-browser"></i>',
      'code-cell': '<i class="ph ph-terminal-window"></i>', 'logic-lab': '<i class="ph ph-circuitry"></i>',
      'sheet-dash': '<i class="ph ph-chart-line-up"></i>', gcal: '<i class="ph ph-calendar-dots"></i>',
    })[type] || '<i class="ph ph-question"></i>';
  }

  /* ================================================================
     SEARCH
     ================================================================ */

  openSearch() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<input class="input search-input" placeholder="Search text on this board…" />' +
      '<div class="search-results"></div>';
    const input = wrap.querySelector('input');
    const results = wrap.querySelector('.search-results');

    const run = () => {
      const q = input.value.trim().toLowerCase();
      results.textContent = '';
      if (!q) return;
      const hits = this.store.elements.filter(el => {
        const hay = [el.content, el.graphTitle,
          ...(el.algoSteps || []).map(s => s.text),
          ...(el.items || []).map(i => i.text),
          ...((el.tableData?.cells || []).flat()),
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      }).slice(0, 60);

      if (!hits.length) { results.innerHTML = '<p class="muted">No matches.</p>'; return; }
      for (const el of hits) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'search-row';
        row.innerHTML = `<span>${this._typeGlyph(el.type)}</span>` +
          `<span>${Util.escapeHTML((el.content || el.graphTitle || this._typeLabel(el.type)).slice(0, 60))}</span>`;
        row.addEventListener('click', () => {
          this.store.select([el.id]);
          this.viewport.zoomToFit({ x: el.x, y: el.y, w: el.width, h: el.height }, 200);
          handle.close();
          this.showPropertiesPanel();
        });
        results.appendChild(row);
      }
    };

    input.addEventListener('input', run);
    const handle = Modal.open({ title: '<i class="ph ph-magnifying-glass"></i> Find on board', width: 520, body: wrap, actions: [{ label: 'Close' }] });
  }

  /* ================================================================
     TEMPLATES / EXPORT / SHORTCUTS
     ================================================================ */

  openTemplates() {
    const shell = document.createElement('div');
    shell.className = 'tpl-shell';

    const side = document.createElement('div');
    side.className = 'tpl-side';
    const main = document.createElement('div');
    main.className = 'tpl-main';
    const search = document.createElement('input');
    search.className = 'input tpl-search';
    search.placeholder = 'Search templates…';
    const list = document.createElement('div');
    list.className = 'tpl-list';
    main.appendChild(search);
    main.appendChild(list);
    shell.appendChild(side);
    shell.appendChild(main);

    let cat = 'all';
    const counts = {};
    for (const t of Object.values(TEMPLATES)) counts[t.cat] = (counts[t.cat] || 0) + 1;

    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.textContent = '';
      const hits = Object.entries(TEMPLATES).filter(([, t]) =>
        (cat === 'all' || t.cat === cat) &&
        (!q || (t.name + ' ' + (t.desc || '') + ' ' + t.cat).toLowerCase().includes(q)));

      if (!hits.length) { list.innerHTML = '<p class="muted">No templates match that.</p>'; return; }

      for (const [key, tpl] of hits) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'tpl-item';
        card.innerHTML = `<span class="tpl-ic">${tpl.icon}</span>` +
          `<strong>${Util.escapeHTML(tpl.name)}</strong>` +
          `<small>${Util.escapeHTML(tpl.desc || '')}</small>`;
        card.addEventListener('click', () => { handle.close(); this.applyTemplate(key); });
        list.appendChild(card);
      }
    };

    for (const [id, label] of TEMPLATE_CATEGORIES) {
      if (id !== 'all' && !counts[id]) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tpl-cat' + (id === cat ? ' is-active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        cat = id;
        side.querySelectorAll('.tpl-cat').forEach(x => x.classList.toggle('is-active', x === b));
        render();
      });
      side.appendChild(b);
    }

    search.addEventListener('input', render);
    render();

    const handle = Modal.open({
      title: '<i class="ph ph-magic-wand"></i> Templates',
      width: 860, className: 'modal-wide', body: shell, actions: [{ label: 'Close' }],
    });
    requestAnimationFrame(() => search.focus());
  }

  applyTemplate(key) {
    const tpl = TEMPLATES[key];
    if (!tpl) return;
    const center = this.viewport.screenToBoard(this.viewport.width / 2, this.viewport.height / 2);

    this.store.transact('apply template', () => {
      const before = this.store.elements.length;
      const created = tpl.build(this) || [];
      const fresh = created.length ? created : this.store.elements.slice(before);
      if (fresh.length) {
        const b = Util.boundsOf(fresh);
        const dx = center.x - (b.x + b.w / 2);
        const dy = center.y - (b.y + b.h / 2);
        for (const el of fresh) { el.x += dx; el.y += dy; this.renderer.place(el); }
        this.store.select(fresh.map(e => e.id));
      }
    });

    this.connections.renderAll();
    this.mindmap.layoutAll();
    this.viewport.zoomToSelection();
    Modal.toast(`“${tpl.name}” added.`, 'success');
  }

  openExport() {
    const wrap = document.createElement('div');
    wrap.className = 'export-grid';
    const options = [
      ['<i class="ph ph-image"></i>', 'PNG image', 'Full board, high resolution', () => this.exporter.png({ scale: 2 })],
      ['<i class="ph ph-magic-wand"></i>', 'PNG (transparent)', 'No background fill', () => this.exporter.png({ scale: 2, transparent: true })],
      ['<i class="ph ph-bounding-box"></i>', 'PNG of selection', 'Only what is selected', () => this.exporter.png({ scale: 3, selectionOnly: true })],
      ['<i class="ph ph-vector-two"></i>', 'SVG vector', 'Scales without losing quality', () => this.exporter.svg()],
      ['<i class="ph ph-file-code"></i>', 'JSON', 'Re-importable board file', () => this.exporter.json()],
      ['<i class="ph ph-file-md"></i>', 'Markdown', 'Frames become headings, maps become lists', () => this.exporter.markdown()],
      ['<i class="ph ph-file-csv"></i>', 'CSV', 'Every table, chart and checklist', () => this.exporter.csv()],
      ['<i class="ph ph-printer"></i>', 'Print / PDF', 'Opens the print dialog', () => this.exporter.pdf()],
      ['<i class="ph ph-copy"></i>', 'Copy image', 'Straight to the clipboard', () => this.exporter.copyPNG()],
    ];
    for (const [icon, title, desc, fn] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'export-card';
      b.innerHTML = `<span class="exp-icon">${icon}</span><strong>${title}</strong><small>${desc}</small>`;
      b.addEventListener('click', () => { handle.close(); fn(); });
      wrap.appendChild(b);
    }
    const handle = Modal.open({ title: '<i class="ph ph-download-simple"></i> Export board', width: 680, body: wrap, actions: [{ label: 'Close' }] });
  }

  openShortcuts() {
    const groups = [
      ['Tools', [
        ['V', 'Select'], ['H', 'Pan'], ['N', 'Sticky note'], ['T', 'Text'],
        ['R', 'Shape'], ['C', 'Connector'], ['P', 'Pen'], ['K', 'Highlighter'],
        ['E', 'Eraser'], ['F', 'Flowchart node'], ['M', 'Mind map'],
        ['A', 'Algorithm'], ['G', 'Chart'], ['I', 'Image'], ['L', 'Laser pointer'],
      ]],
      ['Canvas', [
        ['Drag empty canvas', 'Rubber-band select'],
        ['Space + drag', 'Pan'], ['Middle-drag', 'Pan'], ['Ctrl + drag', 'Pan'],
        ['Wheel', 'Scroll'], ['Shift + wheel', 'Scroll sideways'],
        ['Ctrl + wheel', 'Zoom'], ['Ctrl + 0', 'Zoom 100%'],
        ['Ctrl + 1', 'Zoom to fit'], ['Ctrl + 2', 'Zoom to selection'],
        ['F11', 'Focus mode'],
      ]],
      ['Editing', [
        ['Shift / Ctrl + click', 'Add or remove from selection — works on connections too'],
        ['Double-click', 'Edit text'], ['Enter', 'Edit selected'],
        ['Tab', 'Mind map: add child'], ['Enter', 'Mind map: add sibling'],
        ['Alt + drag', 'Duplicate while dragging'],
        ['Ctrl (while dragging)', 'Suspend snapping'],
        ['Shift + drag', 'Constrain to one axis'],
        ['Shift + resize', 'Keep proportions'],
        ['Shift + rotate', 'Snap to 15°'],
        ['Arrows', 'Nudge 1px'], ['Shift + arrows', 'Nudge 10px'],
        ['[  /  ]', 'Send backward / forward'],
      ]],
      ['Power tools', [
        ['Ctrl + K', 'Command palette'],
        ['Ctrl + Shift + U', 'Tidy up into a grid'],
        ['Ctrl + Shift + L', 'Auto-layout connected flow'],
        ['Ctrl + Shift + H', 'Version history'],
        ['Ctrl + G', 'Group'], ['Ctrl + Shift + G', 'Ungroup'],
        ['?', 'This dialog'],
      ]],
      ['General', [
        ['Ctrl + Z', 'Undo'], ['Ctrl + Shift + Z', 'Redo'],
        ['Ctrl + C / V / X', 'Copy / paste / cut'], ['Ctrl + D', 'Duplicate'],
        ['Ctrl + A', 'Select all'],
        ['Ctrl + S', 'Save'], ['Ctrl + E', 'Export'], ['Ctrl + F', 'Find'],
        ['Delete', 'Delete selection'], ['Esc', 'Deselect / cancel'],
      ]],
    ];

    const wrap = document.createElement('div');
    wrap.className = 'shortcut-grid';
    for (const [title, rows] of groups) {
      const col = document.createElement('div');
      col.innerHTML = `<h4>${title}</h4>` + rows.map(([k, d]) =>
        `<div class="sc-row"><kbd>${Util.escapeHTML(k)}</kbd><span>${Util.escapeHTML(d)}</span></div>`).join('');
      wrap.appendChild(col);
    }
    Modal.open({ title: '<i class="ph ph-keyboard"></i> Keyboard shortcuts', width: 860, className: 'modal-wide', body: wrap, actions: [{ label: 'Close' }] });
  }

  /* ================================================================
     PRESENTATION MODE — frames become slides
     ================================================================ */

  togglePresent() {
    this._presenting = !this._presenting;
    document.body.classList.toggle('is-presenting', this._presenting);

    if (this._presenting) {
      this._slides = this.store.elements
        .filter(e => e.type === 'frame')
        .sort((a, b) => a.y - b.y || a.x - b.x);
      this._slideIndex = 0;
      this.store.clearSelection();
      this.hidePanels();
      this._showSlide(0);
      this._presentKeys = e => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); this._showSlide(this._slideIndex + 1); }
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this._showSlide(this._slideIndex - 1); }
      };
      document.addEventListener('keydown', this._presentKeys);
      this.slides?.render(this._slides, 0);
      Modal.toast(this._slides.length
        ? `Presenting ${this._slides.length} frame${this._slides.length > 1 ? 's' : ''} — arrow keys to navigate, Esc to exit.`
        : 'No frames yet — draw a frame to make a slide. Esc to exit.', 'info', 3600);
    } else {
      document.removeEventListener('keydown', this._presentKeys);
      this.slides?.clear();
      this.viewport.zoomToFit();
    }
  }

  _showSlide(i) {
    if (!this._slides?.length) return;
    this._slideIndex = Util.clamp(i, 0, this._slides.length - 1);
    const f = this._slides[this._slideIndex];
    this.viewport.zoomToFit({ x: f.x, y: f.y, w: f.width, h: f.height }, 40);
    const counter = document.getElementById('slide-counter');
    if (counter) counter.textContent = `${this._slideIndex + 1} / ${this._slides.length}`;
    this.slides?.render(this._slides, this._slideIndex);
  }

  /* ================================================================
     STORE WIRING + PERSISTENCE
     ================================================================ */

  _bindStore() {
    this.store.on('change', () => {
      this._autosave();
      this.updatePropertiesPanel();
      if (!this.layersPanel.classList.contains('hidden')) this.renderLayers();
    });

    this.store.on('history', info => {
      document.getElementById('undo-btn').disabled = !info.canUndo;
      document.getElementById('redo-btn').disabled = !info.canRedo;
    });

    this.store.on('selection', () => {
      if (this.store.selection.size) this.showPropertiesPanel();
      else if (!this.store.connSelection.size) this.hidePanels();
      if (!this.layersPanel.classList.contains('hidden')) this.renderLayers();
    });

    this.store.on('reload', () => {
      this.connections.renderAll();
      this.ink.redraw();
      this.overlay.sync();
    });

    this.store.on('stroke:add', () => this.ink.redraw());
    this.store.on('stroke:remove', () => this.ink.redraw());

    this.viewport.on('transform', () => {
      document.getElementById('zoom-level').textContent =
        Math.round(this.viewport.scale * 100) + '%';
    });

    this.viewport.on('resize', () => this.overlay.sync());
  }

  _bindFileDrop() {
    const w = this.viewport.wrapper;
    const stop = e => { e.preventDefault(); e.stopPropagation(); };

    ['dragenter', 'dragover'].forEach(ev => w.addEventListener(ev, e => {
      stop(e);
      w.classList.add('is-dropping');
    }));
    ['dragleave', 'drop'].forEach(ev => w.addEventListener(ev, e => {
      stop(e);
      if (ev === 'dragleave' && w.contains(e.relatedTarget)) return;
      w.classList.remove('is-dropping');
    }));

    w.addEventListener('drop', e => {
      // Google Workspace panel items are handled by gw-panel.js
      if (e.dataTransfer?.types?.includes('application/x-gw-item')) return;

      const rect = w.getBoundingClientRect();
      const at = this.viewport.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
      const files = Array.from(e.dataTransfer?.files || []);

      files.forEach((file, i) => {
        if (file.type.startsWith('image/')) {
          this.insertImageFile(file, { x: at.x + i * 30, y: at.y + i * 30 });
        } else if (file.name.endsWith('.json')) {
          this.importJSONFile(file);
        } else if (file.type.startsWith('text/')) {
          file.text().then(text => {
            this.store.addElement('sticky-note', {
              x: at.x + i * 30, y: at.y + i * 30, content: text.slice(0, 3000),
              style: { backgroundColor: this.settings.stickyColor, fontSize: 14 },
            });
          });
        }
      });

      if (!files.length) {
        const text = e.dataTransfer?.getData('text/plain');
        if (text) {
          this.store.addElement('sticky-note', {
            x: at.x, y: at.y, content: text.slice(0, 2000),
            style: { backgroundColor: this.settings.stickyColor, fontSize: 15 },
          });
        }
      }
    });
  }

  async importJSONFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const merged = Store.migrate(data);
      if (!merged) throw new Error('bad format');
      this._pastePayload({ __wbpro: 2, elements: merged.elements, connections: merged.connections });
      if (merged.strokes?.length) {
        this.store.transact('import ink', () => {
          for (const s of merged.strokes) this.store.addStroke({ ...s, id: Util.uid('stroke') }, { silent: true });
        });
      }
      this.viewport.zoomToFit();
      Modal.toast('Board imported.', 'success');
    } catch (err) {
      Modal.toast('That file could not be read as a board.', 'warn');
    }
  }

  /* ---- save / load ------------------------------------------------- */

  setStatus(text, kind = '') {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'save-status ' + kind;
  }

  async save({ quiet = false, server = false, sync = false } = {}) {
    if (!this.store.state.id) this.store.state.id = 'board-' + Date.now();
    const data = this.store.serialize();

    // 1. Local autosave, filed under this board id for this account.
    data.updated_at = new Date().toISOString();
    if (BoardStorage.write(data.id, data)) {
      BoardStorage.setLastBoardId(data.id);
      this.setStatus('Saved locally · ' + new Date().toLocaleTimeString(), 'ok');
    } else {
      this.setStatus('Local storage full — export to keep a copy', 'warn');
    }

    // 2. Firebase Cloud Sync with SHA-256 Checksum (if logged in with Google)
    if (window.FirebaseSync && window.FirebaseSync.isLoggedIn) {
      try {
        const cloudRes = await window.FirebaseSync.saveBoard(data);
        if (cloudRes && cloudRes.success) {
          this.setStatus('Synced with Firebase Cloud · ' + new Date().toLocaleTimeString(), 'ok');
          if (!quiet && server) {
            Modal.toast('Board securely synced to Firebase Cloud.', 'success', 2000);
          }
        }
      } catch (err) {
        console.warn('Firebase Cloud save fallback to local:', err);
      }
    }

    if (!server && !sync) return;

    // 3. Fallback Flask Server Save
    const body = JSON.stringify(data);
    if (sync && navigator.sendBeacon) {
      navigator.sendBeacon('/api/board/save', new Blob([body], { type: 'application/json' }));
      return;
    }

    fetch('/api/board/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(r => {
      if (!r.ok) throw new Error();
      if (!window.FirebaseSync || !window.FirebaseSync.isLoggedIn) {
        this.setStatus('Saved to server · ' + new Date().toLocaleTimeString(), 'ok');
        if (!quiet) Modal.toast('Board saved.', 'success', 1600);
      }
    }).catch(() => {
      if (!window.FirebaseSync || !window.FirebaseSync.isLoggedIn) {
        this.setStatus('Offline — saved locally only', 'warn');
        if (!quiet) Modal.toast('Server unreachable. Your work is saved in this browser.', 'warn');
      }
    });
  }

  /**
   * Open a board by id, from wherever it actually lives.
   *
   * Order matters: cloud, then server, then this browser's own copy. The
   * local fallback is the one that was missing — a board created inside a
   * project exists as a record long before it is ever saved anywhere, so the
   * first open always 404'd and the canvas silently kept the previous board.
   *
   * @param {string} id
   * @param {{createIfMissing?: string, projectId?: string, projectName?: string}} opts
   *        `createIfMissing` is the name to give a brand-new blank board when
   *        no copy exists anywhere. Without it, a miss is reported as one.
   * @returns {Promise<boolean>} whether the canvas now shows that board
   */
  /**
   * Resolve once somebody is actually signed in, or give up after `ms`.
   *
   * Firebase reports its initial auth state asynchronously, and a
   * Workspace-connected user is signed in a moment after that again by
   * google-account.js's bridge — so "not logged in" at page load means
   * "not yet", not "no".
   */
  async _waitForAuth(ms = 6000) {
    const fb = window.FirebaseSync;
    if (!fb) return null;
    if (fb.isLoggedIn) return fb.user;
    try { await fb.authReady; } catch (_) { /* fall through to the wait below */ }
    if (fb.isLoggedIn) return fb.user;

    return new Promise(resolve => {
      let settled = false;
      let off = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        try { off?.(); } catch (_) {}
        resolve(value);
      };
      off = fb.onUserChange(user => { if (user) finish(user); });
      setTimeout(() => finish(fb.user || null), ms);
    });
  }

  async loadBoard(id, opts = {}) {
    if (!id) return false;

    // Flush the outgoing board first, or its unsaved edits die here.
    if (this.store.state.id && this.store.state.id !== id) {
      await this.save({ quiet: true });
    }

    // 1. Firebase, if signed in.
    if (window.FirebaseSync && window.FirebaseSync.isLoggedIn) {
      try {
        const cloudData = await window.FirebaseSync.loadBoard(id);
        if (cloudData) {
          this._adoptBoard(cloudData, opts);
          this.setStatus('Opened from Firebase Cloud', 'ok');
          return true;
        }
      } catch (err) {
        console.warn('Firebase cloud load error, trying server:', err);
      }
    }

    // 2. The Flask server.
    try {
      const res = await fetch('/api/board/' + encodeURIComponent(id));
      if (res.ok) {
        this._adoptBoard(await res.json(), opts);
        this.setStatus('Board opened', 'ok');
        return true;
      }
    } catch (_) { /* offline — the local copy below may still have it */ }

    // 3. This browser's own copy of that board.
    const local = BoardStorage.read(id);
    if (local) {
      this._adoptBoard(local, opts);
      this.setStatus('Opened from this device', 'ok');
      return true;
    }

    // 3b. Missed everywhere — but on a device opening a share link for the
    //     first time, that is exactly what an unfinished sign-in looks like:
    //     step 1 ran before Firebase had reported an auth state (it resolves
    //     asynchronously, and the Workspace->Firebase bridge lands a moment
    //     later still), so the one place the board actually lives was never
    //     consulted. Waiting and retrying here is what stops step 4 creating
    //     a blank board over the top of a real shared one.
    if (window.FirebaseSync && !window.FirebaseSync.isLoggedIn) {
      const user = await this._waitForAuth();
      if (user) {
        try {
          const cloudData = await window.FirebaseSync.loadBoard(id);
          if (cloudData) {
            this._adoptBoard(cloudData, opts);
            this.setStatus('Opened from Firebase Cloud', 'ok');
            return true;
          }
        } catch (err) {
          console.warn('Firebase cloud load retry failed:', err);
        }
      }
    }

    // 4. Nothing anywhere. Start it, rather than leaving the previous
    //    board on screen pretending to be this one.
    if (opts.createIfMissing) {
      this._adoptBoard({
        id,
        name: opts.createIfMissing,
        elements: [], connections: [], strokes: [],
        created_at: new Date().toISOString(),
      }, opts);
      await this.save({ quiet: true, server: true });
      Modal.toast(`"${opts.createIfMissing}" is ready.`, 'success', 2200);
      return true;
    }

    Modal.toast('That board could not be found.', 'warn');
    return false;
  }

  _adoptBoard(data, opts = {}) {
    this.store.load(data);
    if (!this.store.state.id) this.store.state.id = data.id || 'board-' + Date.now();

    // Remember which project a board belongs to, so the header can say so
    // and a later save keeps the association.
    if (opts.projectId) this.store.state.projectId = opts.projectId;
    this.currentProjectName = opts.projectName || data.projectName || null;

    BoardStorage.setLastBoardId(this.store.state.id);
    this._paintBoardIdentity();
    this.connections.renderAll();
    this.mindmap.repairLegacy();
    this.mindmap.layoutAll();
    this.ink.redraw();
    this.viewport.zoomToFit();
    this.overlay.sync();
    if (this.store.lastRescued) {
      Modal.toast(`Parts of this board had drifted millions of pixels apart. ` +
                  `${this.store.lastRescued} item(s) were moved back together — ` +
                  'nothing was deleted. Save to keep the fix.', 'warn', 8000);
    }
    // Text boxes are content-sized, so a board saved with a different font
    // stack has to be re-measured or the labels sit clipped.
    requestAnimationFrame(() => {
      for (const el of this.store.elements) if (el.type === 'text') this.autoSize(el.id);
      this.workshop?.decorateAll();
    });
  }

  /**
   * Show which board — and which project's board — is on screen. The header
   * used to say only the board name, which is no help at all when the real
   * question is "am I even looking at the right project's canvas?".
   */
  _paintBoardIdentity() {
    const field = document.getElementById('board-name');
    if (field) field.value = this.store.state.name || 'Untitled Board';

    let chip = document.getElementById('board-project-chip');
    if (!this.currentProjectName) { chip?.remove(); return; }

    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'board-project-chip';
      chip.type = 'button';
      chip.className = 'board-project-chip';
      chip.title = 'Back to this project';
      chip.addEventListener('click', () => {
        const pid = this.store.state.projectId;
        if (pid) window.pmHub?.openProject(pid);
        else window.pmHub?.open();
      });
      field?.parentNode?.insertBefore(chip, field);
    }
    chip.innerHTML = `<i class="ph-bold ph-squares-four"></i><span></span>`;
    chip.querySelector('span').textContent = this.currentProjectName;
  }

  async newBoard() {
    if (this.store.elements.length &&
        !await Modal.confirm('Start a new board? Save or export first if you want to keep this one.',
          { title: 'New board', confirmLabel: 'New board' })) return;
    await this.save({ quiet: true });
    this.store.clear();
    this.store.state.id = 'board-' + Date.now();
    this.store.state.name = 'Untitled Board';
    this.store.state.projectId = null;
    this.currentProjectName = null;
    this._paintBoardIdentity();
    this.viewport.reset();
    BoardStorage.setLastBoardId(this.store.state.id);
    this.openTemplates();
  }

  /**
   * Decide what the canvas shows on load.
   *
   * `?board=` wins so share links work, then the last board this *account*
   * had open. Signing in or out changes the scope, so two people on one
   * machine never inherit each other's canvas.
   */
  _restore() {
    BoardStorage.migrateLegacy();

    const params = new URLSearchParams(location.search);
    const deepLink = params.get('board');
    if (deepLink) {
      // Remembered so a sign-in landing a moment later doesn't swap this
      // board out for whatever this device happened to have open last —
      // which is exactly what made a share link open the wrong board.
      this._deepLinkedBoardId = deepLink;
      this.loadBoard(deepLink, { createIfMissing: 'Untitled Board' });
      return;
    }

    const lastId = BoardStorage.lastBoardId();
    const raw = lastId ? BoardStorage.read(lastId) : BoardStorage.list()[0];
    if (!raw) {
      this.store.state.id = 'board-' + Date.now();
      this.setStatus('Ready');
      return;
    }

    this._adoptBoard(raw);
    this.setStatus('Restored your last board', 'ok');
  }

  /**
   * The signed-in account changed. Board storage is scoped per account, so
   * the canvas has to follow — otherwise the previous user's board stays on
   * screen and the next save files it under the new account.
   */
  onAccountChanged() {
    // Someone who followed a share link is here to see *that* board, for the
    // whole session. Signing in — which now happens automatically moments
    // after load, and can land while that board is still being fetched —
    // must never pull this device's own last-opened board over the top of it.
    if (this._deepLinkedBoardId) return;

    const lastId = BoardStorage.lastBoardId();
    const raw = lastId ? BoardStorage.read(lastId) : BoardStorage.list()[0];
    if (raw && raw.id !== this.store.state.id) {
      this._adoptBoard(raw);
      this.setStatus('Switched to your boards', 'ok');
    } else if (!raw) {
      this.store.clear();
      this.store.state.id = 'board-' + Date.now();
      this.store.state.name = 'Untitled Board';
      this.currentProjectName = null;
      this._paintBoardIdentity();
      this.setStatus('Ready');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new WhiteboardApp();
});
