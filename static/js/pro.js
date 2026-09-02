/* ================================================================
   pro.js — algorithm blocks, charts, and the shared modal helper
   ================================================================ */

/* ----------------------------------------------------------------
   Modal — one implementation, reused by every dialog
   ---------------------------------------------------------------- */
const Modal = {
  _stack: [],

  open({ title, body, actions = [], width = 560, className = '', onClose }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal ' + className;
    box.style.maxWidth = width + 'px';

    const head = document.createElement('div');
    head.className = 'modal-head';
    head.innerHTML = `<h3>${title}</h3>`;
    const close = document.createElement('button');
    close.className = 'modal-x';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    head.appendChild(close);
    box.appendChild(head);

    const content = document.createElement('div');
    content.className = 'modal-body';
    if (typeof body === 'string') content.innerHTML = body;
    else if (body) content.appendChild(body);
    box.appendChild(content);

    if (actions.length) {
      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost');
        btn.textContent = a.label;
        btn.addEventListener('click', async () => {
          if (!a.onClick) {
            handle.close();
            return;
          }
          btn.disabled = true;
          try {
            const keep = await a.onClick(content, handle);
            if (keep !== true) handle.close();
          } catch (err) {
            console.error('Modal action error:', err);
          } finally {
            btn.disabled = false;
          }
        });
        foot.appendChild(btn);
      }
      box.appendChild(foot);
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const handle = {
      overlay, box, content,
      close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        Modal._stack = Modal._stack.filter(h => h !== handle);
        if (onClose) onClose();
      },
    };

    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); handle.close(); }
    };
    document.addEventListener('keydown', onKey, true);
    close.addEventListener('click', () => handle.close());
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) handle.close(); });

    Modal._stack.push(handle);
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      content.querySelector('input, textarea, button')?.focus();
    });
    return handle;
  },

  confirm(message, { title = 'Confirm', confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
      let done = false;
      Modal.open({
        title,
        width: 420,
        body: `<p class="modal-text">${Util.escapeHTML(message)}</p>`,
        actions: [
          { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
          { label: confirmLabel, primary: true, onClick: () => { done = true; resolve(true); } },
        ],
        onClose: () => { if (!done) resolve(false); },
      });
    });
  },

  prompt(message, value = '', { title = 'Input', placeholder = '', multiline = false } = {}) {
    return new Promise(resolve => {
      let done = false;
      const wrap = document.createElement('div');
      wrap.innerHTML = `<label class="field"><span>${Util.escapeHTML(message)}</span></label>`;
      const input = document.createElement(multiline ? 'textarea' : 'input');
      input.className = 'input';
      input.value = value;
      input.placeholder = placeholder;
      if (multiline) input.rows = 5;
      wrap.querySelector('.field').appendChild(input);

      const h = Modal.open({
        title, width: 460, body: wrap,
        actions: [
          { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
          { label: 'OK', primary: true, onClick: () => { done = true; resolve(input.value); } },
        ],
        onClose: () => { if (!done) resolve(null); },
      });
      requestAnimationFrame(() => { input.focus(); input.select?.(); });
      if (!multiline) {
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { done = true; resolve(input.value); h.close(); }
        });
      }
    });
  },

  toast(message, kind = 'info', ms = 2600) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast toast-' + kind;
    t.textContent = message;
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(() => {
      t.classList.remove('is-in');
      setTimeout(() => t.remove(), 250);
    }, ms);
  },
};

/* ================================================================
   AlgorithmManager
   ================================================================ */
class AlgorithmManager {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this._editing = null;
  }

  static THEMES = {
    dark:    { name: '🌙 Dark',    bg: '#1e1e24', headerBg: '#2a2a33', text: '#d4d4d8', border: '#3a3a45' },
    midnight:{ name: '🌌 Midnight',bg: '#0d1117', headerBg: '#161b22', text: '#c9d1d9', border: '#30363d' },
    ocean:   { name: '🌊 Ocean',   bg: '#0d1b2a', headerBg: '#152736', text: '#e0e1dd', border: '#2b4257' },
    forest:  { name: '🌲 Forest',  bg: '#16241a', headerBg: '#1f3325', text: '#d4e7d4', border: '#2f4a37' },
    sunset:  { name: '🌅 Sunset',  bg: '#2a170e', headerBg: '#3a2418', text: '#f0dcc8', border: '#54372a' },
    purple:  { name: '💜 Purple',  bg: '#1a1030', headerBg: '#251742', text: '#e0d4f0', border: '#3f2b63' },
    light:   { name: '☀️ Light',   bg: '#fbfcfe', headerBg: '#eef1f6', text: '#1a1a2e', border: '#d8dee9' },
    paper:   { name: '📄 Paper',   bg: '#fdf6e3', headerBg: '#f2e9d0', text: '#3b3222', border: '#e0d4b4' },
  };

  static STEP_META = {
    start:     { icon: '▶', color: '#6aa9ff', label: 'START' },
    end:       { icon: '⏹', color: '#ff9e6d', label: 'END' },
    condition: { icon: '◇', color: '#d99bdb', label: 'IF' },
    loop:      { icon: '↻', color: '#e6d97a', label: 'LOOP' },
    io:        { icon: '⇄', color: '#5fd4bb', label: 'I/O' },
    declare:   { icon: '≡', color: '#93cdfa', label: 'VAR' },
    call:      { icon: '⇢', color: '#b6a6ff', label: 'CALL' },
    process:   { icon: '▸', color: '#cfd3dc', label: 'PROC' },
    comment:   { icon: '#', color: '#7aa87f', label: 'NOTE' },
    blank:     { icon: ' ', color: '#666', label: '' },
  };

  /** Language-agnostic line classifier used for icons, colours and export. */
  static classifyLine(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return 'blank';
    if (/^(#|\/\/|--|;|\/\*|\*)/.test(t)) return 'comment';
    if (/^(def |function |func |class |procedure |algorithm |sub |method |begin\b|start\b)/.test(t)) return 'start';
    if (/^(return\b|end\b|stop\b|exit\b|halt\b|break\b|yield\b)/.test(t)) return 'end';
    if (/^(if\b|else\b|elif\b|elseif\b|switch\b|case\b|when\b|otherwise\b|match\b)/.test(t)) return 'condition';
    if (/^(for\b|foreach\b|while\b|do\b|loop\b|repeat\b|until\b)/.test(t)) return 'loop';
    if (/^(input\b|output\b|read\b|write\b|print\b|display\b|scan\b|prompt\b|console\.|printf|cout|cin|puts)/.test(t)) return 'io';
    if (/^(set\b|let\b|var\b|const\b|int\b|float\b|double\b|string\b|bool\b|char\b|array\b|dim\b)/.test(t) || /^[a-z_][\w.\[\]]*\s*(=|:=|<-)\s*/.test(t)) return 'declare';
    if (/^[a-z_][\w.]*\s*\(/.test(t)) return 'call';
    return 'process';
  }

  static parse(code) {
    return String(code || '').split('\n').map(text => ({
      text,
      type: AlgorithmManager.classifyLine(text),
    }));
  }

  create(x, y, opts = {}) {
    const steps = AlgorithmManager.parse(opts.code != null ? opts.code : DEFAULT_ALGO);
    const el = this.store.addElement('algorithm', {
      x, y,
      width: 400,
      height: this.heightFor(steps),
      content: opts.title || 'Algorithm',
      algoTheme: opts.theme || this.app.settings.algoTheme || 'dark',
      algoSteps: steps,
      algoLang: opts.lang || 'pseudocode',
    });
    return el;
  }

  heightFor(steps) {
    return Math.max(120, 44 + Math.max(steps.length, 1) * 21 + 16);
  }

  /* ---- editor ------------------------------------------------------ */

  open(elId) {
    const el = this.store.get(elId);
    if (!el) return;
    this._editing = elId;

    const wrap = document.createElement('div');
    wrap.className = 'algo-editor';
    wrap.innerHTML = `
      <div class="algo-row">
        <input class="input algo-title" placeholder="Algorithm name" />
        <select class="input algo-lang" style="max-width:170px">
          <option value="pseudocode">Pseudocode</option>
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
          <option value="java">Java</option>
          <option value="c">C / C++</option>
          <option value="sql">SQL</option>
        </select>
      </div>
      <div class="algo-themes"></div>
      <div class="algo-main">
        <textarea class="algo-code" spellcheck="false" placeholder="Write your algorithm or pseudocode…"></textarea>
        <div class="algo-preview"></div>
      </div>
      <div class="algo-legend"></div>
      <label class="algo-check"><input type="checkbox" class="algo-autosize" checked /> Resize block to fit</label>
    `;

    const titleInput = wrap.querySelector('.algo-title');
    const langSelect = wrap.querySelector('.algo-lang');
    const codeArea = wrap.querySelector('.algo-code');
    const preview = wrap.querySelector('.algo-preview');
    const themeRow = wrap.querySelector('.algo-themes');
    const legend = wrap.querySelector('.algo-legend');
    const autosize = wrap.querySelector('.algo-autosize');

    titleInput.value = el.content || 'Algorithm';
    langSelect.value = el.algoLang || 'pseudocode';
    codeArea.value = (el.algoSteps || []).map(s => s.text).join('\n');

    let theme = el.algoTheme || 'dark';
    for (const [key, t] of Object.entries(AlgorithmManager.THEMES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'algo-theme' + (key === theme ? ' is-active' : '');
      b.dataset.theme = key;
      b.textContent = t.name;
      b.style.background = t.bg;
      b.style.color = t.text;
      b.style.borderColor = t.border;
      themeRow.appendChild(b);
    }
    themeRow.addEventListener('click', e => {
      const b = e.target.closest('[data-theme]');
      if (!b) return;
      theme = b.dataset.theme;
      themeRow.querySelectorAll('.algo-theme').forEach(x => x.classList.toggle('is-active', x === b));
      render();
    });

    for (const [key, meta] of Object.entries(AlgorithmManager.STEP_META)) {
      if (key === 'blank') continue;
      const s = document.createElement('span');
      s.className = 'algo-legend-item';
      s.style.color = meta.color;
      s.textContent = `${meta.icon} ${meta.label}`;
      legend.appendChild(s);
    }

    const render = () => {
      const t = AlgorithmManager.THEMES[theme];
      const steps = AlgorithmManager.parse(codeArea.value);
      preview.innerHTML = '';
      const block = document.createElement('div');
      block.className = 'algo-pv-block';
      block.style.background = t.bg;
      block.style.color = t.text;
      block.style.borderColor = t.border;

      const head = document.createElement('div');
      head.className = 'algo-pv-head';
      head.style.background = t.headerBg;
      head.style.borderBottomColor = t.border;
      head.textContent = '⚡ ' + (titleInput.value || 'Algorithm');
      block.appendChild(head);

      const body = document.createElement('div');
      body.className = 'algo-pv-body';
      steps.forEach((s, i) => {
        const meta = AlgorithmManager.STEP_META[s.type];
        const indent = (s.text.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
        const row = document.createElement('div');
        row.className = 'algo-pv-step';
        row.style.paddingLeft = (10 + indent * 7) + 'px';
        row.innerHTML =
          `<span class="algo-pv-ln">${i + 1}</span>` +
          `<span class="algo-pv-ic" style="color:${meta.color}">${meta.icon}</span>` +
          `<span style="color:${meta.color}">${Util.escapeHTML(s.text.trim()) || '&nbsp;'}</span>`;
        body.appendChild(row);
      });
      block.appendChild(body);
      preview.appendChild(block);
    };

    codeArea.addEventListener('input', render);
    titleInput.addEventListener('input', render);

    // Tab inserts an indent instead of leaving the textarea.
    codeArea.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = codeArea.selectionStart, en = codeArea.selectionEnd;
      const v = codeArea.value;
      if (e.shiftKey) {
        const lineStart = v.lastIndexOf('\n', s - 1) + 1;
        if (v.slice(lineStart, lineStart + 2) === '  ') {
          codeArea.value = v.slice(0, lineStart) + v.slice(lineStart + 2);
          codeArea.selectionStart = codeArea.selectionEnd = Math.max(lineStart, s - 2);
        }
      } else {
        codeArea.value = v.slice(0, s) + '  ' + v.slice(en);
        codeArea.selectionStart = codeArea.selectionEnd = s + 2;
      }
      render();
    });

    render();

    Modal.open({
      title: '⚡ Algorithm editor',
      width: 980,
      className: 'modal-wide',
      body: wrap,
      actions: [
        {
          label: 'Generate flowchart',
          onClick: () => {
            this.toFlowchart(elId, AlgorithmManager.parse(codeArea.value), titleInput.value);
            return false;
          },
        },
        { label: 'Cancel' },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            const steps = AlgorithmManager.parse(codeArea.value);
            const patch = {
              content: titleInput.value.trim() || 'Algorithm',
              algoTheme: theme,
              algoLang: langSelect.value,
              algoSteps: steps,
            };
            if (autosize.checked) {
              patch.height = this.heightFor(steps);
              const longest = steps.reduce((m, s) => Math.max(m, s.text.length), 10);
              patch.width = Util.clamp(longest * 8.2 + 90, 280, 900);
            }
            this.app.settings.algoTheme = theme;
            this.store.updateElement(elId, patch);
          },
        },
      ],
      onClose: () => { this._editing = null; },
    });
  }

  /**
   * Turns the algorithm into a real, connected flowchart on the board —
   * start/end pills, diamonds for conditions, loop-back edges and all.
   */
  toFlowchart(algoId, steps, title) {
    const source = this.store.get(algoId);
    if (!source) return;

    const usable = steps.filter(s => s.type !== 'blank' && s.type !== 'comment');
    if (!usable.length) { Modal.toast('Nothing to convert — write some steps first.', 'warn'); return; }

    const baseX = source.x + source.width + 120;
    const baseY = source.y;
    const NODE_W = 220, NODE_H = 72, GAP = 46;

    this.store.transact('generate flowchart', () => {
      const created = [];
      let y = baseY;

      const start = this.store.addElement('flowchart', {
        x: baseX, y, width: NODE_W, height: 56, fcType: 'startend',
        content: (title || 'Algorithm') + ' — start',
        style: { backgroundColor: '#e8f5e9', borderColor: '#2e7d32', borderWidth: 2 },
      }, { silent: true });
      created.push(start);
      y += 56 + GAP;

      const indentOf = s => (s.text.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;

      for (const step of usable) {
        const type = step.type;
        const fcType =
          type === 'condition' ? 'decision' :
          type === 'loop'      ? 'prep' :
          type === 'io'        ? 'data' :
          type === 'end'       ? 'startend' :
          type === 'call'      ? 'manual' : 'process';

        const palette = {
          decision: { backgroundColor: '#fff3e0', borderColor: '#ef6c00' },
          prep:     { backgroundColor: '#ede7f6', borderColor: '#5e35b1' },
          data:     { backgroundColor: '#e3f2fd', borderColor: '#1565c0' },
          startend: { backgroundColor: '#ffebee', borderColor: '#c62828' },
          manual:   { backgroundColor: '#f1f8e9', borderColor: '#558b2f' },
          process:  { backgroundColor: '#ffffff', borderColor: '#16161d' },
        }[fcType];

        const h = fcType === 'decision' ? 96 : NODE_H;
        const node = this.store.addElement('flowchart', {
          x: baseX + indentOf(step) * 12,
          y, width: NODE_W, height: h, fcType,
          content: step.text.trim(),
          style: { ...palette, borderWidth: 2, fontSize: 13 },
        }, { silent: true });
        created.push(node);
        y += h + GAP;
      }

      const end = this.store.addElement('flowchart', {
        x: baseX, y, width: NODE_W, height: 56, fcType: 'startend',
        content: 'End',
        style: { backgroundColor: '#eceff1', borderColor: '#37474f', borderWidth: 2 },
      }, { silent: true });
      created.push(end);

      // Wire the sequence together, and give every decision a labelled
      // "No" branch that skips the following step.
      for (let i = 0; i < created.length - 1; i++) {
        const a = created[i], b = created[i + 1];
        this.store.addConnection({
          from: { id: a.id, port: 'bottom' },
          to:   { id: b.id, port: 'top' },
          routing: 'orthogonal',
          arrowEnd: true,
          label: a.fcType === 'decision' ? 'Yes' : '',
          style: { color: '#4a5568', width: 2 },
        }, { silent: true });

        if (a.fcType === 'decision' && created[i + 2]) {
          this.store.addConnection({
            from: { id: a.id, port: 'right' },
            to:   { id: created[i + 2].id, port: 'right' },
            routing: 'orthogonal',
            arrowEnd: true,
            label: 'No',
            style: { color: '#a0455b', width: 2, dash: '6 4' },
          }, { silent: true });
        }
      }

      this.store.select(created.map(c => c.id));
    });

    this.app.viewport.zoomToSelection();
    Modal.toast('Flowchart generated from the algorithm.', 'success');
  }
}

const DEFAULT_ALGO = `def bubble_sort(a, n):
  for i = 0 to n-1:
    for j = 0 to n-i-2:
      if a[j] > a[j+1]:
        swap(a[j], a[j+1])
  return a`;

/* ================================================================
   ChartManager — canvas charts with a real data editor
   ================================================================ */
const CHART_PALETTE = [
  '#4262ff', '#00b894', '#f39c12', '#e74c3c',
  '#9b59b6', '#00a8b5', '#e8618c', '#5a6acf',
];

class ChartManager {
  constructor(app) {
    this.app = app;
    this.store = app.store;
  }

  static SAMPLE = [
    { label: 'Q1', value: 42 },
    { label: 'Q2', value: 68 },
    { label: 'Q3', value: 31 },
    { label: 'Q4', value: 85 },
  ];

  create(x, y, type = 'bar') {
    return this.store.addElement('graph', {
      x, y,
      graphType: type,
      graphTitle: type[0].toUpperCase() + type.slice(1) + ' chart',
      graphData: Util.clone(ChartManager.SAMPLE).map((d, i) => ({ ...d, color: CHART_PALETTE[i % CHART_PALETTE.length] })),
      graphOptions: { showValues: true, showGrid: true, showLegend: type === 'pie' || type === 'donut' },
    });
  }

  draw(el, canvas) {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width || el.width - 24, 40);
    const h = Math.max(rect.height || el.height - 60, 40);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = (el.graphData || []).filter(d => d && d.label != null);
    if (!data.length) {
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', w / 2, h / 2);
      return;
    }
    data.forEach((d, i) => { if (!d.color) d.color = CHART_PALETTE[i % CHART_PALETTE.length]; });

    const opts = el.graphOptions || {};
    const css = getComputedStyle(document.body);
    const ink = css.getPropertyValue('--clr-text').trim() || '#16161d';
    const muted = css.getPropertyValue('--clr-text-muted').trim() || '#9aa3b2';
    const grid = css.getPropertyValue('--clr-border').trim() || '#e3e6ec';

    const painter = {
      bar: this._bar, hbar: this._hbar, line: this._line, area: this._line,
      pie: this._pie, donut: this._pie, scatter: this._scatter,
    }[el.graphType] || this._bar;

    painter.call(this, ctx, w, h, data, { ...opts, ink, muted, grid, type: el.graphType });
  }

  _axes(ctx, w, h, pad, max, o) {
    ctx.strokeStyle = o.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = o.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i;
      const y = h - pad.b - ((h - pad.t - pad.b) * i / ticks);
      if (o.showGrid !== false) {
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(w - pad.r, y);
        ctx.stroke();
      }
      ctx.fillText(this._fmt(v), pad.l - 6, y);
    }
  }

  _fmt(v) {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return Math.round(v * 100) / 100;
  }

  _bar(ctx, w, h, data, o) {
    const pad = { l: 42, r: 12, t: 14, b: 30 };
    const max = Math.max(...data.map(d => +d.value || 0), 1);
    this._axes(ctx, w, h, pad, max, o);

    const aw = w - pad.l - pad.r;
    const ah = h - pad.t - pad.b;
    const slot = aw / data.length;
    const bw = Math.max(4, Math.min(slot * 0.62, 64));

    ctx.textAlign = 'center';
    data.forEach((d, i) => {
      const v = +d.value || 0;
      const bh = (v / max) * ah;
      const x = pad.l + slot * i + (slot - bw) / 2;
      const y = h - pad.b - bh;

      ctx.fillStyle = d.color;
      const r = Math.min(5, bw / 2);
      ctx.beginPath();
      ctx.moveTo(x, y + bh);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + bw - r, y);
      ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
      ctx.lineTo(x + bw, y + bh);
      ctx.closePath();
      ctx.fill();

      if (o.showValues !== false && bh > 14) {
        ctx.fillStyle = o.ink;
        ctx.textBaseline = 'bottom';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(this._fmt(v), x + bw / 2, y - 3);
      }
      ctx.fillStyle = o.muted;
      ctx.textBaseline = 'top';
      ctx.fillText(String(d.label).slice(0, 10), x + bw / 2, h - pad.b + 6);
    });
  }

  _hbar(ctx, w, h, data, o) {
    const pad = { l: 76, r: 34, t: 10, b: 14 };
    const max = Math.max(...data.map(d => +d.value || 0), 1);
    const aw = w - pad.l - pad.r;
    const ah = h - pad.t - pad.b;
    const slot = ah / data.length;
    const bh = Math.max(4, Math.min(slot * 0.62, 34));

    ctx.font = '10px Inter, sans-serif';
    data.forEach((d, i) => {
      const v = +d.value || 0;
      const bw = (v / max) * aw;
      const y = pad.t + slot * i + (slot - bh) / 2;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(pad.l, y, bw, bh, 4) : ctx.rect(pad.l, y, bw, bh);
      ctx.fill();

      ctx.fillStyle = o.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(d.label).slice(0, 12), pad.l - 8, y + bh / 2);

      if (o.showValues !== false) {
        ctx.fillStyle = o.ink;
        ctx.textAlign = 'left';
        ctx.fillText(this._fmt(v), pad.l + bw + 6, y + bh / 2);
      }
    });
  }

  _line(ctx, w, h, data, o) {
    const pad = { l: 42, r: 14, t: 14, b: 30 };
    const values = data.map(d => +d.value || 0);
    const max = Math.max(...values, 1);
    this._axes(ctx, w, h, pad, max, o);

    const aw = w - pad.l - pad.r;
    const ah = h - pad.t - pad.b;
    const step = data.length > 1 ? aw / (data.length - 1) : 0;
    const pt = i => ({ x: pad.l + step * i, y: h - pad.b - (values[i] / max) * ah });
    const color = data[0].color || CHART_PALETTE[0];

    if (o.type === 'area') {
      const g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      g.addColorStop(0, color + '66');
      g.addColorStop(1, color + '05');
      ctx.beginPath();
      ctx.moveTo(pad.l, h - pad.b);
      data.forEach((_, i) => { const p = pt(i); ctx.lineTo(p.x, p.y); });
      ctx.lineTo(pad.l + step * (data.length - 1), h - pad.b);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }

    ctx.beginPath();
    data.forEach((_, i) => { const p = pt(i); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    data.forEach((d, i) => {
      const p = pt(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = d.color || color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = o.muted;
      ctx.textBaseline = 'top';
      ctx.fillText(String(d.label).slice(0, 8), p.x, h - pad.b + 6);
      if (o.showValues !== false) {
        ctx.fillStyle = o.ink;
        ctx.textBaseline = 'bottom';
        ctx.fillText(this._fmt(values[i]), p.x, p.y - 8);
      }
    });
  }

  _pie(ctx, w, h, data, o) {
    const total = data.reduce((s, d) => s + Math.abs(+d.value || 0), 0) || 1;
    const legendW = o.showLegend !== false ? Math.min(130, w * 0.36) : 0;
    const cx = (w - legendW) / 2;
    const cy = h / 2;
    const r = Math.max(10, Math.min(cx, cy) - 12);
    const inner = o.type === 'donut' ? r * 0.58 : 0;

    let a0 = -Math.PI / 2;
    data.forEach(d => {
      const slice = (Math.abs(+d.value || 0) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a0 + slice);
      ctx.closePath();
      ctx.fillStyle = d.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      a0 += slice;
    });

    if (inner) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx, cy, inner, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = o.ink;
      ctx.font = '600 14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this._fmt(total), cx, cy);
    }

    if (legendW) {
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lh = Math.min(20, (h - 12) / data.length);
      let y = cy - (data.length * lh) / 2 + lh / 2;
      const lx = w - legendW + 6;
      data.forEach(d => {
        ctx.fillStyle = d.color;
        ctx.fillRect(lx, y - 4, 9, 9);
        ctx.fillStyle = o.muted;
        const pct = Math.round((Math.abs(+d.value || 0) / total) * 100);
        ctx.fillText(`${String(d.label).slice(0, 11)} ${pct}%`, lx + 14, y);
        y += lh;
      });
    }
  }

  _scatter(ctx, w, h, data, o) {
    const pad = { l: 42, r: 14, t: 14, b: 30 };
    const xs = data.map((d, i) => (+d.x != null && !isNaN(+d.x)) ? +d.x : i);
    const ys = data.map(d => +d.value || 0);
    const maxX = Math.max(...xs, 1), maxY = Math.max(...ys, 1);
    this._axes(ctx, w, h, pad, maxY, o);

    const aw = w - pad.l - pad.r, ah = h - pad.t - pad.b;
    data.forEach((d, i) => {
      const px = pad.l + (xs[i] / maxX) * aw;
      const py = h - pad.b - (ys[i] / maxY) * ah;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
    });
  }

  /* ---- data editor ------------------------------------------------- */

  openEditor(elId) {
    const el = this.store.get(elId);
    if (!el) return;

    let rows = Util.clone(el.graphData || []);
    let type = el.graphType || 'bar';
    let options = { showValues: true, showGrid: true, showLegend: true, ...(el.graphOptions || {}) };

    const wrap = document.createElement('div');
    wrap.className = 'chart-editor';
    wrap.innerHTML = `
      <div class="chart-row">
        <input class="input chart-title" placeholder="Chart title" />
        <select class="input chart-type" style="max-width:160px">
          <option value="bar">Bar</option>
          <option value="hbar">Horizontal bar</option>
          <option value="line">Line</option>
          <option value="area">Area</option>
          <option value="pie">Pie</option>
          <option value="donut">Donut</option>
          <option value="scatter">Scatter</option>
        </select>
      </div>
      <div class="chart-main">
        <div class="chart-data">
          <div class="chart-data-head"><span>Label</span><span>Value</span><span>Colour</span><span></span></div>
          <div class="chart-rows"></div>
          <button type="button" class="btn btn-ghost chart-add">+ Add row</button>
        </div>
        <div class="chart-preview"><canvas></canvas></div>
      </div>
      <div class="chart-opts">
        <label><input type="checkbox" class="opt-values" /> Show values</label>
        <label><input type="checkbox" class="opt-grid" /> Show grid</label>
        <label><input type="checkbox" class="opt-legend" /> Show legend</label>
        <button type="button" class="btn btn-ghost chart-paste">Paste CSV…</button>
      </div>
    `;

    const titleInput = wrap.querySelector('.chart-title');
    const typeSelect = wrap.querySelector('.chart-type');
    const rowsHost = wrap.querySelector('.chart-rows');
    const canvas = wrap.querySelector('canvas');
    const optValues = wrap.querySelector('.opt-values');
    const optGrid = wrap.querySelector('.opt-grid');
    const optLegend = wrap.querySelector('.opt-legend');

    titleInput.value = el.graphTitle || 'Chart';
    typeSelect.value = type;
    optValues.checked = options.showValues !== false;
    optGrid.checked = options.showGrid !== false;
    optLegend.checked = options.showLegend !== false;

    const preview = () => {
      this.draw({
        ...el, graphType: type, graphData: rows,
        graphOptions: {
          showValues: optValues.checked,
          showGrid: optGrid.checked,
          showLegend: optLegend.checked,
        },
      }, canvas);
    };

    const renderRows = () => {
      rowsHost.textContent = '';
      rows.forEach((r, i) => {
        if (!r.color) r.color = CHART_PALETTE[i % CHART_PALETTE.length];
        const row = document.createElement('div');
        row.className = 'chart-data-row';
        row.innerHTML = `
          <input class="input" data-k="label" value="${Util.escapeHTML(r.label ?? '')}" />
          <input class="input" data-k="value" type="number" step="any" value="${r.value ?? 0}" />
          <input class="color" data-k="color" type="color" value="${r.color}" />
          <button type="button" class="row-del" title="Remove">×</button>
        `;
        row.addEventListener('input', e => {
          const k = e.target.dataset.k;
          if (!k) return;
          rows[i][k] = k === 'value' ? parseFloat(e.target.value) || 0 : e.target.value;
          preview();
        });
        row.querySelector('.row-del').addEventListener('click', () => {
          rows.splice(i, 1);
          renderRows();
          preview();
        });
        rowsHost.appendChild(row);
      });
    };

    wrap.querySelector('.chart-add').addEventListener('click', () => {
      rows.push({ label: 'Item ' + (rows.length + 1), value: 0, color: CHART_PALETTE[rows.length % CHART_PALETTE.length] });
      renderRows();
      preview();
    });

    wrap.querySelector('.chart-paste').addEventListener('click', async () => {
      const text = await Modal.prompt(
        'Paste rows as "label, value" — one per line.', '',
        { title: 'Paste data', multiline: true, placeholder: 'Jan, 120\nFeb, 145\nMar, 98' }
      );
      if (text == null) return;
      const parsed = text.split('\n').map(l => l.split(/[,\t;]/))
        .filter(p => p.length >= 2 && p[0].trim())
        .map((p, i) => ({
          label: p[0].trim(),
          value: parseFloat(p[1]) || 0,
          color: CHART_PALETTE[i % CHART_PALETTE.length],
        }));
      if (!parsed.length) { Modal.toast('Could not read any rows from that.', 'warn'); return; }
      rows = parsed;
      renderRows();
      preview();
    });

    typeSelect.addEventListener('change', () => { type = typeSelect.value; preview(); });
    [optValues, optGrid, optLegend].forEach(c => c.addEventListener('change', preview));

    renderRows();
    requestAnimationFrame(preview);

    Modal.open({
      title: '📊 Chart data',
      width: 900,
      className: 'modal-wide',
      body: wrap,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            this.store.updateElement(elId, {
              graphTitle: titleInput.value.trim() || 'Chart',
              graphType: type,
              graphData: rows,
              graphOptions: {
                showValues: optValues.checked,
                showGrid: optGrid.checked,
                showLegend: optLegend.checked,
              },
            });
          },
        },
      ],
    });
  }
}

window.Modal = Modal;
window.AlgorithmManager = AlgorithmManager;
window.ChartManager = ChartManager;
window.CHART_PALETTE = CHART_PALETTE;
