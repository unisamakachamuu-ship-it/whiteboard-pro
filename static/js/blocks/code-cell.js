/* ================================================================
   code-cell.js — a runnable notebook cell as a board object
   ----------------------------------------------------------------
   A `code` block on this board was always just coloured text. This is
   the same idea with a kernel behind it: write Python or JavaScript,
   press Ctrl+Enter, see real output — stdout, the value of the last
   expression, a pandas table, a matplotlib figure — pinned to the
   canvas next to the diagram that explains it.

   What makes it a notebook rather than a snippet runner:

     · State carries between cells. Define a function in one, call it
       from another, in the order you laid them out on the board.
     · Output is part of the board. It saves, reloads and exports with
       everything else, so a board is still readable without re-running
       anything.
     · Cells run in reading order — top to bottom, then left to right —
       which is the order a board is read in, so "Run all" means what
       it looks like it means.

   Model:
     { type:'code-cell', language, content, outputs:[{kind,value}],
       runCount, lastMs, collapsed }
   ================================================================ */

(function (global) {
  'use strict';

  /* Board JSON is loaded in full on every open, so a cell that printed a
     megabyte of logs would make the whole board slow to load. Keep the
     tail — that is the part someone actually reads. */
  const MAX_OUTPUT_CHARS = 40000;
  const MAX_OUTPUT_ITEMS = 60;

  const LANGUAGES = [
    { id: 'python', label: 'Python', hint: 'Ctrl+Enter to run · %pip install <package> works' },
    { id: 'javascript', label: 'JavaScript', hint: 'Ctrl+Enter to run · top-level await is fine' },
  ];

  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
    return n;
  };

  const toast = (msg, kind = 'info', ms = 3000) =>
    (global.Modal?.toast || global.PMUI?.toast || ((m) => console.info(m)))(msg, kind, ms);

  /* ================================================================
     One cell
     ================================================================ */

  class CodeCell {
    constructor(app, element, node) {
      this.app = app;
      this.store = app.store;
      this.id = element.id;
      this.node = node;
      this.type = 'code-cell';
      this.running = false;
      this._unwatchKernel = null;

      this._build(element);
      this.update(element);
    }

    get element() { return this.store.get(this.id); }

    /* ---- construction ------------------------------------------------ */

    _build(element) {
      this.node.textContent = '';

      /* -- header ------------------------------------------------------ */
      this.langSel = el('select', {
        class: 'wb-cell-lang wb-live-ui',
        title: 'Language',
        onchange: () => {
          this.store.updateElement(this.id, { language: this.langSel.value });
          if (this.app.settings) {
            this.app.settings.codeCellLanguage = this.langSel.value;
            this.app.saveSettings?.();
          }
          this._paintHint();
        },
      }, LANGUAGES.map(l => el('option', { value: l.id, text: l.label })));

      this.countEl = el('span', { class: 'wb-cell-count', title: 'Times this cell has run' });
      this.statusEl = el('span', { class: 'wb-cell-status' });

      this.runBtn = el('button', {
        type: 'button', class: 'wb-cell-btn is-run', title: 'Run this cell  (Ctrl+Enter)',
        onclick: () => this.run(),
      }, [el('i', { class: 'ph-fill ph-play' }), el('span', { text: 'Run' })]);

      const menuBtn = el('button', {
        type: 'button', class: 'wb-cell-btn', title: 'Cell actions',
        onclick: e => this._menu(e.currentTarget),
      }, [el('i', { class: 'ph ph-dots-three-vertical' })]);

      this.head = el('div', { class: 'wb-cell-head wb-live-ui' }, [
        el('span', { class: 'wb-cell-dot' }),
        this.langSel,
        this.countEl,
        el('span', { class: 'wb-cell-spacer' }),
        this.statusEl,
        this.runBtn,
        menuBtn,
      ]);

      /* -- editor ------------------------------------------------------ */
      this.editor = el('textarea', {
        class: 'wb-cell-editor wb-live-ui',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocorrect: 'off',
        wrap: 'off',
        placeholder: 'Write code here, then press Ctrl+Enter',
      });
      this.editor.addEventListener('keydown', e => this._onKey(e));
      this.editor.addEventListener('input', () => {
        this._autoGrow();
        this._commitSoon();
      });
      this.editor.addEventListener('blur', () => this._commit());
      // The gutter is decorative but it is what makes a traceback's
      // "line 7" mean something without counting.
      this.gutter = el('div', { class: 'wb-cell-gutter' });
      this.editor.addEventListener('scroll', () => {
        this.gutter.scrollTop = this.editor.scrollTop;
      });

      this.hint = el('div', { class: 'wb-cell-hint' });

      /* -- output ------------------------------------------------------ */
      this.outEl = el('div', { class: 'wb-cell-out wb-live-ui' });

      this.node.appendChild(this.head);
      this.node.appendChild(el('div', { class: 'wb-cell-editwrap' }, [this.gutter, this.editor]));
      this.node.appendChild(this.hint);
      this.node.appendChild(this.outEl);

      // The kernel is shared by every Python cell on the board, so its
      // download progress belongs on all of them at once.
      this._unwatchKernel = global.WBKernels.PyKernel.onStatus(() => this._paintStatus());
    }

    /* ---- model <-> view ---------------------------------------------- */

    update(element) {
      if (!element) return;

      if (this.langSel.value !== (element.language || 'python')) {
        this.langSel.value = element.language || 'python';
      }
      // Never fight the caret: if the user is typing, the textarea is the
      // truth and the model catches up on the next commit.
      if (document.activeElement !== this.editor && this.editor.value !== (element.content || '')) {
        this.editor.value = element.content || '';
        this._autoGrow();
      }
      this.countEl.textContent = element.runCount ? `[${element.runCount}]` : '[ ]';
      this._paintHint();
      this._paintStatus();
      this._paintOutputs(element.outputs || []);
      this._renderGutter();
    }

    _paintHint() {
      const lang = LANGUAGES.find(l => l.id === this.langSel.value) || LANGUAGES[0];
      this.hint.textContent = lang.hint;
    }

    _paintStatus() {
      const element = this.element;
      const isPy = (this.langSel.value || 'python') === 'python';
      const k = global.WBKernels.PyKernel;

      if (this.running) {
        this.statusEl.textContent = 'Running…';
        this.statusEl.dataset.state = 'busy';
      } else if (isPy && k.status === 'loading') {
        this.statusEl.textContent = k.detail;
        this.statusEl.dataset.state = 'busy';
      } else if (isPy && k.status === 'failed') {
        this.statusEl.textContent = 'Python unavailable';
        this.statusEl.dataset.state = 'bad';
      } else if (element?.lastMs != null) {
        this.statusEl.textContent = element.lastMs < 1000
          ? `${element.lastMs} ms` : `${(element.lastMs / 1000).toFixed(1)} s`;
        this.statusEl.dataset.state = element.lastError ? 'bad' : 'ok';
      } else {
        this.statusEl.textContent = '';
        this.statusEl.dataset.state = '';
      }
      this.node.classList.toggle('is-running', this.running);
      this.runBtn.disabled = this.running;
    }

    _paintOutputs(outputs) {
      this.outEl.textContent = '';
      this.outEl.classList.toggle('is-empty', !outputs.length);
      if (!outputs.length) return;

      for (const o of outputs) {
        if (o.kind === 'image') {
          this.outEl.appendChild(el('img', { class: 'wb-out-img', src: o.value, alt: 'Cell output' }));
        } else if (o.kind === 'html') {
          // The HTML here is produced by the user's own code in their own
          // browser — a DataFrame's _repr_html_, or something they passed
          // to display(). It is rendered, not escaped, because rendering
          // it is the entire point of the feature.
          this.outEl.appendChild(el('div', { class: 'wb-out-html', html: o.value }));
        } else {
          this.outEl.appendChild(el('pre', { class: 'wb-out wb-out-' + o.kind, text: o.value }));
        }
      }
    }

    _renderGutter() {
      const lines = (this.editor.value || '').split('\n').length;
      if (this.gutter._n === lines) return;
      this.gutter._n = lines;
      this.gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }

    _autoGrow() {
      this._renderGutter();
    }

    _commitSoon() {
      clearTimeout(this._commitTimer);
      this._commitTimer = setTimeout(() => this._commit(), 400);
    }

    _commit() {
      clearTimeout(this._commitTimer);
      const current = this.element;
      if (!current || current.content === this.editor.value) return;
      this.store.updateElement(this.id, { content: this.editor.value });
    }

    /* ---- keys --------------------------------------------------------- */

    _onKey(e) {
      // The board's own shortcuts already stand down inside a textarea;
      // this is only about the keys a code editor owes you.
      e.stopPropagation();

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this._commit();
        this.run();
        return;
      }
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        this._commit();
        this.run();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); this.editor.blur(); return; }

      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.editor;
        if (e.shiftKey) {
          // Outdent the touched lines by up to four spaces.
          const start = value.lastIndexOf('\n', a - 1) + 1;
          const block = value.slice(start, b).replace(/^ {1,4}/gm, '');
          this.editor.setRangeText(block, start, b, 'end');
        } else if (a !== b) {
          const start = value.lastIndexOf('\n', a - 1) + 1;
          const block = value.slice(start, b).replace(/^/gm, '    ');
          this.editor.setRangeText(block, start, b, 'end');
        } else {
          this.editor.setRangeText('    ', a, b, 'end');
        }
        this._autoGrow();
        this._commitSoon();
        return;
      }

      if (e.key === 'Enter') {
        // Keep the indent, and add one after a line that opens a block.
        const { selectionStart: a, value } = this.editor;
        const lineStart = value.lastIndexOf('\n', a - 1) + 1;
        const line = value.slice(lineStart, a);
        const indent = (/^[ \t]*/.exec(line) || [''])[0];
        const opens = /[:{([]\s*$/.test(line);
        if (indent || opens) {
          e.preventDefault();
          this.editor.setRangeText('\n' + indent + (opens ? '    ' : ''), a, this.editor.selectionEnd, 'end');
          this._autoGrow();
          this._commitSoon();
        }
      }
    }

    /* ---- running ------------------------------------------------------ */

    async run() {
      if (this.running) return;
      this._commit();

      const element = this.element;
      if (!element) return;
      const code = element.content || '';
      if (!code.trim()) {
        this.store.updateElement(this.id, { outputs: [], lastError: null, lastMs: null });
        return;
      }

      this.running = true;
      this._paintStatus();
      this._paintOutputs([{ kind: 'out', value: '…' }]);

      const lang = element.language || 'python';
      let res;
      try {
        res = lang === 'javascript'
          ? await global.WBKernels.JsKernel.run(code, this._jsApi())
          : await global.WBKernels.PyKernel.run(code);
      } catch (err) {
        res = { outputs: [{ kind: 'error', value: String(err?.stack || err) }], error: String(err), ms: 0 };
      }

      this.running = false;

      this.store.updateElement(this.id, {
        outputs: trimOutputs(res.outputs),
        runCount: (element.runCount || 0) + 1,
        lastMs: res.ms,
        lastError: res.error || null,
      });

      return res;
    }

    /**
     * What a JavaScript cell can reach beyond the language itself.
     *
     * `board` is deliberately a small, explicit surface rather than the
     * live Store: a cell is for computing over what is on the canvas, and
     * handing it the mutable store would make an ordinary typo capable of
     * destroying the board it is sitting on.
     */
    _jsApi() {
      const store = this.store;
      const app = this.app;
      return {
        board: {
          get name() { return store.state.name; },
          elements: () => store.state.elements.map(e => ({ ...e })),
          byType: type => store.state.elements.filter(e => e.type === type).map(e => ({ ...e })),
          text: () => store.state.elements.map(e => e.content).filter(Boolean),
          /** Tables and dashboards on the board, as arrays of rows. */
          tables: () => store.state.elements
            .filter(e => e.type === 'table')
            .map(e => (e.tableData?.cells || []).map(r => [...r])),
          /** Drop a sticky note back onto the canvas with a result. */
          note: (text, opts = {}) => {
            const src = store.get(this.id);
            const created = store.addElement('sticky-note', {
              x: (src?.x || 0) + (src?.width || 560) + 40,
              y: (src?.y || 0) + (opts.offsetY || 0),
              content: String(text),
              style: { backgroundColor: opts.color || '#ffe66d', fontSize: 15 },
            });
            return created.id;
          },
        },
        /** Fetch through the app's own origin — same-origin API calls. */
        api: async (path, init) => {
          const r = await fetch(path, init);
          const ct = r.headers.get('content-type') || '';
          return ct.includes('json') ? r.json() : r.text();
        },
        app,
      };
    }

    /* ---- menu ---------------------------------------------------------- */

    _menu(anchor) {
      const items = [
        ['ph-play-circle', 'Run every cell on this board', () => CodeCells.runAll(this.app)],
        ['ph-eraser', 'Clear this output', () => this.store.updateElement(this.id, {
          outputs: [], lastError: null, lastMs: null, runCount: 0,
        })],
        ['ph-arrow-counter-clockwise', 'Restart the kernel (forget all variables)', () => {
          global.WBKernels.PyKernel.reset();
          global.WBKernels.JsKernel.reset();
          toast('Kernel restarted. Variables from earlier runs are gone.', 'info', 3500);
          this._paintStatus();
        }],
        ['ph-copy', 'Copy the code', async () => {
          try {
            await navigator.clipboard.writeText(this.element?.content || '');
            toast('Code copied.', 'success', 1800);
          } catch { toast('The browser would not allow clipboard access.', 'warn'); }
        }],
      ];

      document.querySelector('.wb-cell-menu')?.remove();
      const rect = anchor.getBoundingClientRect();
      const menu = el('div', { class: 'wb-cell-menu' }, items.map(([icon, label, run]) =>
        el('button', {
          type: 'button', class: 'wb-cell-menu-item',
          onclick: () => { menu.remove(); run(); },
        }, [el('i', { class: 'ph ' + icon }), el('span', { text: label })])));

      menu.style.left = Math.min(rect.left, innerWidth - 300) + 'px';
      menu.style.top = (rect.bottom + 6) + 'px';
      document.body.appendChild(menu);

      setTimeout(() => document.addEventListener('pointerdown', function close(ev) {
        if (menu.contains(ev.target)) return;
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }, true), 0);
    }

    destroy() {
      clearTimeout(this._commitTimer);
      this._unwatchKernel?.();
      document.querySelector('.wb-cell-menu')?.remove();
    }
  }

  /** Keep boards loadable: cap what a runaway loop can write into one. */
  function trimOutputs(outputs) {
    const kept = outputs.slice(-MAX_OUTPUT_ITEMS);
    let budget = MAX_OUTPUT_CHARS;
    const out = [];
    for (let i = kept.length - 1; i >= 0; i--) {
      const o = kept[i];
      const text = String(o.value ?? '');
      if (o.kind === 'image') { out.unshift(o); continue; }
      if (text.length <= budget) {
        out.unshift(o);
        budget -= text.length;
      } else {
        out.unshift({ kind: o.kind, value: '…output truncated…\n' + text.slice(-Math.max(budget, 0)) });
        break;
      }
    }
    return out;
  }

  /* ================================================================
     Board-level
     ================================================================ */

  const CodeCells = {
    /** Every live cell currently mounted, keyed by element id. */
    instances: new Map(),

    /**
     * Run the whole board in reading order.
     *
     * Cells share one kernel, so order decides the result. Top-to-bottom
     * then left-to-right is how the board is read, and banding the rows
     * (rather than sorting on raw y) keeps two cells placed side by side
     * in the order they look like they are in.
     */
    async runAll(app) {
      const cells = app.store.state.elements
        .filter(e => e.type === 'code-cell')
        .sort((a, b) => {
          const band = 120;
          const ra = Math.round(a.y / band), rb = Math.round(b.y / band);
          return ra !== rb ? ra - rb : a.x - b.x;
        });

      if (!cells.length) { toast('There are no code cells on this board.', 'info'); return; }
      toast(`Running ${cells.length} cell${cells.length > 1 ? 's' : ''} in reading order…`, 'info', 2500);

      let failed = 0;
      for (const c of cells) {
        const inst = this.instances.get(c.id);
        if (!inst) continue;
        const res = await inst.run();
        if (res?.error) failed++;
      }

      toast(failed
        ? `${cells.length - failed} of ${cells.length} cells ran; ${failed} raised an error.`
        : `All ${cells.length} cells ran cleanly.`, failed ? 'warn' : 'success', 4000);
    },
  };

  global.WBCodeCells = CodeCells;

  /* ================================================================
     Renderer hook
     ================================================================ */

  function install() {
    const proto = global.Renderer?.prototype;
    if (!proto || proto._codeCell) return;

    proto._codeCell = function (element, node) {
      const cell = new CodeCell(this.app, element, node);
      CodeCells.instances.set(element.id, cell);
      node.__live = {
        type: 'code-cell',
        update: e => cell.update(e),
        destroy: () => { cell.destroy(); CodeCells.instances.delete(element.id); },
      };
    };
  }

  if (global.Renderer) install();
  else global.addEventListener('DOMContentLoaded', install, { once: true });
})(window);
