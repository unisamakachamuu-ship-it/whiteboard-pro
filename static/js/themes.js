/* ================================================================
   themes.js — colour themes, canvas patterns, sticky palettes
   ================================================================
   The old build had a single boolean light/dark toggle wired straight
   into applyTheme(). Themes are now a registry: each entry names the
   CSS `data-theme` value, whether it reads as dark (so element defaults
   and chart ink can adapt), and a sticky-note palette that actually
   looks right on that canvas.
   ================================================================ */

const THEMES = {
  /* Apple's system palette, both appearances. Listed first because this is
     the app's flagship look: iOS grouped backgrounds, SF type, continuous
     corners and translucent chrome. The sticky palettes are the iOS system
     colours at the tint Apple uses for filled backgrounds. */
  ios: {
    name: 'iOS Light', hint: 'Apple system · light', dark: false,
    preview: ['#ffffff', '#f2f2f7', '#007aff'],
    sticky: ['#ffe8a3', '#ffd9a8', '#ffc4bd', '#f8c8dc', '#d9c9f7', '#b8dcff', '#a9ecdd', '#c8eeb0', '#ffffff'],
  },
  'ios-dark': {
    name: 'iOS Dark', hint: 'Apple system · dark', dark: true,
    preview: ['#1c1c1e', '#000000', '#0a84ff'],
    sticky: ['#4a4020', '#4a3722', '#4a2724', '#43263a', '#2f2a52', '#14304f', '#0f3f3a', '#26401f', '#2c2c2e'],
  },

  light: {
    name: 'Daylight', hint: 'Clean neutral', dark: false,
    preview: ['#ffffff', '#f4f5f8', '#4262ff'],
    sticky: ['#ffe66d', '#ffd6a5', '#ffadad', '#fdcfe8', '#d8c7ff', '#bde0fe', '#b8f2e6', '#d9f7be', '#ffffff'],
  },
  dark: {
    name: 'Graphite', hint: 'Balanced dark', dark: true,
    preview: ['#1e212a', '#191c24', '#6b86ff'],
    sticky: ['#4a4321', '#4a3a26', '#4a2b30', '#452a3d', '#332a4d', '#233348', '#1f3f3c', '#2b3d24', '#2a2e39'],
  },
  midnight: {
    name: 'Midnight', hint: 'GitHub-dark inspired', dark: true,
    preview: ['#161b22', '#010409', '#58a6ff'],
    sticky: ['#3d3416', '#3f2f1a', '#421f24', '#3a1f36', '#261f45', '#132a44', '#0f3a35', '#1c3620', '#21262d'],
  },
  dracula: {
    name: 'Dracula', hint: 'Purple neon', dark: true,
    preview: ['#2f313f', '#21222c', '#bd93f9'],
    sticky: ['#4d4526', '#4d3a26', '#4d262b', '#452643', '#372a52', '#25384d', '#1f4a3a', '#2f4a26', '#383a4a'],
  },
  nord: {
    name: 'Nord', hint: 'Arctic blue', dark: true,
    preview: ['#3b4252', '#272c36', '#88c0d0'],
    sticky: ['#4d4630', '#4d3d2e', '#4a2f34', '#42303f', '#333b52', '#2c3f52', '#2b4643', '#3a472f', '#434c5e'],
  },
  forest: {
    name: 'Forest', hint: 'Deep green', dark: true,
    preview: ['#16241a', '#0b130f', '#5ec98a'],
    sticky: ['#3f3d1c', '#3d3320', '#3d2124', '#372135', '#252542', '#1b3345', '#154038', '#25401f', '#1d2f22'],
  },
  cobalt: {
    name: 'Cobalt', hint: 'High-energy blue', dark: true,
    preview: ['#0b3a5c', '#002240', '#ffc600'],
    sticky: ['#4d4014', '#4d3416', '#4d1f2b', '#3f1f42', '#241f52', '#0e4670', '#0d4a4a', '#1f4a26', '#0e4670'],
  },
  paper: {
    name: 'Paper', hint: 'Warm cream', dark: false,
    preview: ['#fffdf7', '#f6efe0', '#b5651d'],
    sticky: ['#fbeaa8', '#fadfbe', '#f7c7bd', '#f3cfdd', '#ddcdf0', '#c8ddf2', '#c1e8de', '#dcebbd', '#fffdf7'],
  },
  solar: {
    name: 'Solarized', hint: 'Low-glare warm', dark: false,
    preview: ['#fffbef', '#f2ecd8', '#268bd2'],
    sticky: ['#f4e2a1', '#f6d9b0', '#f3c1b6', '#eecbd8', '#d8cdec', '#c6dcee', '#bee5dc', '#d9e8b4', '#fffbef'],
  },
  ocean: {
    name: 'Ocean', hint: 'Cool light teal', dark: false,
    preview: ['#ffffff', '#eaf4f8', '#0a7ea4'],
    sticky: ['#ffeaa0', '#ffd9b0', '#ffb8b8', '#ffcfe6', '#d9cbff', '#bfe2ff', '#aeeee1', '#d3f5b7', '#ffffff'],
  },
  rose: {
    name: 'Rosé', hint: 'Soft blush', dark: false,
    preview: ['#ffffff', '#fdf0f4', '#d6336c'],
    sticky: ['#ffe9a8', '#ffdcb8', '#ffc0c6', '#ffcbe0', '#e4d0ff', '#cfe3ff', '#bdf0e4', '#dcf4c0', '#ffffff'],
  },
  contrast: {
    name: 'High contrast', hint: 'Maximum legibility', dark: false,
    preview: ['#ffffff', '#ffffff', '#0000ff'],
    sticky: ['#ffff00', '#ff9900', '#ff3333', '#ff66cc', '#9966ff', '#3399ff', '#00cccc', '#66ff33', '#ffffff'],
  },
};

/* Themes that ship as a light/dark pair, so the appearance toggle keeps the
   design language and only changes the appearance. */
const THEME_PAIRS = {
  ios: 'ios-dark',
  'ios-dark': 'ios',
  light: 'dark',
  dark: 'light',
};

const CANVAS_PATTERNS = [
  { id: 'dots',  label: 'Dots',   css: 'radial-gradient(circle, #98a0b0 1.2px, transparent 1.2px)' },
  { id: 'grid',  label: 'Grid',   css: 'linear-gradient(to right, #98a0b0 1px, transparent 1px), linear-gradient(to bottom, #98a0b0 1px, transparent 1px)' },
  { id: 'lines', label: 'Ruled',  css: 'linear-gradient(to bottom, #98a0b0 1px, transparent 1px)' },
  { id: 'iso',   label: 'Iso',    css: 'linear-gradient(30deg, #98a0b0 1px, transparent 1px), linear-gradient(150deg, #98a0b0 1px, transparent 1px)' },
  { id: 'none',  label: 'Plain',  css: 'none' },
];

class ThemeManager {
  constructor(app) {
    this.app = app;
    this.apply(app.settings.theme || 'light', { silent: true });
  }

  get current() { return this.app.settings.theme || 'light'; }
  get def() { return THEMES[this.current] || THEMES.light; }
  get isDark() { return !!this.def.dark; }

  /** Sticky palette for the active theme. */
  get stickyColors() { return this.def.sticky; }

  apply(id, { silent = false } = {}) {
    if (!THEMES[id]) id = 'light';
    const prev = this.app.settings.theme;
    this.app.settings.theme = id;
    document.documentElement.dataset.theme = id;
    document.documentElement.style.colorScheme = THEMES[id].dark ? 'dark' : 'light';

    // Keep the sticky-note default readable when moving between families.
    if (prev && prev !== id) {
      const before = THEMES[prev] || THEMES.light;
      const i = before.sticky.indexOf(this.app.settings.stickyColor);
      if (i >= 0) this.app.settings.stickyColor = THEMES[id].sticky[i];
    }

    this.app.saveSettings();
    this._refreshButton();

    if (silent) return;
    // Charts, connectors and the minimap paint from computed CSS tokens, so
    // they have to be repainted by hand when those tokens change.
    this.app.minimap?.render();
    this.app.connections?.refreshTheme?.();
    for (const el of this.app.store.elements) {
      if (el.type !== 'graph') continue;
      const c = this.app.renderer.node(el.id)?.querySelector('canvas');
      if (c) this.app.charts.draw(el, c);
    }
    // A text/stroke colour explicitly chosen against a light canvas can go
    // illegible on a dark one (Util.themedColor, consulted inside render.js's
    // per-type paint code) — re-run every element's paint step so that
    // adaptation actually takes effect when the appearance flips.
    if (!prev || THEMES[prev]?.dark !== THEMES[id].dark) {
      for (const el of this.app.store.elements) this.app.renderer.patch(el);
    }
    this.app._renderSubMenu?.(this.app.activeTool);
  }

  setPattern(id) {
    this.app.settings.canvasPattern = id;
    this.app.viewport.wrapper.dataset.pattern = id;
    this.app.saveSettings();
  }

  /**
   * Cycles light <-> dark for the one-click toolbar button.
   *
   * Themes that come as a matched pair (iOS light / iOS dark) swap to their
   * counterpart, so toggling appearance never also changes the design
   * language out from under you. Everything else falls back to the last
   * theme used in the other family.
   */
  toggle() {
    const pair = THEME_PAIRS[this.current];
    if (pair) { this.apply(pair); this._rememberPair(); return; }

    if (this.isDark) this.apply(this.app.settings.lastLightTheme || 'ios');
    else {
      this.app.settings.lastLightTheme = this.current;
      this.apply(this.app.settings.lastDarkTheme || 'ios-dark');
    }
    this._rememberPair();
  }

  _rememberPair() {
    if (this.isDark) this.app.settings.lastDarkTheme = this.current;
    else this.app.settings.lastLightTheme = this.current;
    this.app.saveSettings();
  }

  _refreshButton() {
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = this.isDark ? '<i class="ph ph-sun"></i>' : '<i class="ph ph-moon"></i>';
  }

  /* ---- picker ------------------------------------------------------- */

  openPicker() {
    const wrap = document.createElement('div');

    const pHead = document.createElement('h4');
    pHead.className = 'panel-title';
    pHead.textContent = 'Canvas pattern';
    wrap.appendChild(pHead);

    const pRow = document.createElement('div');
    pRow.className = 'pattern-row';
    for (const p of CANVAS_PATTERNS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pattern-btn' + (p.id === (this.app.settings.canvasPattern || 'dots') ? ' is-active' : '');
      b.style.backgroundImage = p.css;
      b.innerHTML = `<span>${p.label}</span>`;
      b.addEventListener('click', () => {
        this.setPattern(p.id);
        pRow.querySelectorAll('.pattern-btn').forEach(x => x.classList.toggle('is-active', x === b));
      });
      pRow.appendChild(b);
    }
    wrap.appendChild(pRow);

    const tHead = document.createElement('h4');
    tHead.className = 'panel-title';
    tHead.textContent = 'Theme';
    wrap.appendChild(tHead);

    const grid = document.createElement('div');
    grid.className = 'theme-grid';
    for (const [id, t] of Object.entries(THEMES)) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'theme-card' + (id === this.current ? ' is-active' : '');
      card.innerHTML =
        `<span class="theme-swatch" style="background:${t.preview[1]}">` +
        `<i style="background:${t.preview[0]}"></i>` +
        `<i style="background:${t.preview[1]}"></i>` +
        `<i style="background:${t.sticky[0]}"></i>` +
        `<span class="tsw-dot" style="background:${t.preview[2]}"></span></span>` +
        `<span class="theme-name">${Util.escapeHTML(t.name)}<small>${Util.escapeHTML(t.hint)}</small></span>`;
      card.addEventListener('click', () => {
        this.apply(id);
        grid.querySelectorAll('.theme-card').forEach(x => x.classList.toggle('is-active', x === card));
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);

    Modal.open({
      title: '<i class="ph ph-palette"></i> Appearance',
      width: 720, className: 'modal-wide', body: wrap,
      actions: [{ label: 'Done', primary: true }],
    });
  }
}

window.THEMES = THEMES;
window.THEME_PAIRS = THEME_PAIRS;
window.CANVAS_PATTERNS = CANVAS_PATTERNS;
window.ThemeManager = ThemeManager;
