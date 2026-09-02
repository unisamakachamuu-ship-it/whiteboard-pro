/* ================================================================
   sheet-dash.js — a live Google Sheets dashboard on the board
   ----------------------------------------------------------------
   Point it at a spreadsheet, give it a range, and it becomes a set of
   KPI tiles, charts and tables that re-read the sheet on a timer. The
   spreadsheet stays the system of record — the place the numbers are
   maintained, by whoever maintains them — and the board becomes the
   place they are read.

   Three things it does that a screenshot of a chart does not:

     · It refreshes. A stale dashboard is worse than none, so every
       panel carries the time it was last read, and a failed refresh
       says why rather than quietly showing yesterday's numbers as
       though they were today's.
     · It types its columns. Numbers, dates and text are told apart
       from the data itself, so a column of "1,240" and "1.2k" still
       sums, and a date axis is ordered rather than alphabetical.
     · It draws its own charts. No chart library, so nothing to load
       from a CDN before the board can render, and the marks inherit
       the board's theme instead of fighting it.

   Model:
     { type:'sheet-dash', title, sheetId, sheetTitle, range, refreshSec,
       widgets: [...], filter: { column, op, value }, cache: { ... } }
   ================================================================ */

(function (global) {
  'use strict';

  const MIN_REFRESH = 15;
  const MAX_CACHED_ROWS = 400;      // what gets saved with the board

  /* A categorical ramp that stays legible on light and dark board
     backgrounds and keeps adjacent series apart for the common forms of
     colour blindness. */
  const SERIES = ['#4262ff', '#17a673', '#e8912b', '#a855f7', '#06b6d4',
                  '#e0455e', '#ec4899', '#0ea5e9', '#84cc16', '#f59e0b'];

  const AGGS = {
    sum:   { label: 'Sum',      fn: v => v.reduce((a, b) => a + b, 0) },
    avg:   { label: 'Average',  fn: v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 },
    min:   { label: 'Minimum',  fn: v => v.length ? Math.min(...v) : 0 },
    max:   { label: 'Maximum',  fn: v => v.length ? Math.max(...v) : 0 },
    last:  { label: 'Latest',   fn: v => v.length ? v[v.length - 1] : 0 },
    count: { label: 'Count',    fn: v => v.length },
  };

  const WIDGETS = [
    ['kpi',   'KPI tile',   'ph-number-square-one'],
    ['line',  'Line chart', 'ph-chart-line'],
    ['bar',   'Bar chart',  'ph-chart-bar'],
    ['area',  'Area chart', 'ph-chart-line-up'],
    ['pie',   'Donut',      'ph-chart-donut'],
    ['gauge', 'Gauge',      'ph-gauge'],
    ['table', 'Data table', 'ph-table'],
  ];

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, text) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
    return n;
  };
  const toast = (m, k = 'info', ms = 3000) =>
    (global.Modal?.toast || global.PMUI?.toast || (x => console.info(x)))(m, k, ms);

  let seq = 0;
  const uid = p => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

  /* ================================================================
     Reading a sheet
     ================================================================ */

  /**
   * "1,240", "£1,240.50", "(320)", "12%" and "1.2k" are all numbers a
   * spreadsheet routinely holds as text. Refusing them would make half
   * the real columns in a real sheet un-chartable, so they are parsed
   * rather than rejected — and anything genuinely non-numeric still
   * comes back null so the column is classified as text.
   */
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v == null) return null;

    let s = String(v).trim();
    if (!s) return null;

    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }        // (320) = -320

    const percent = s.endsWith('%');
    if (percent) s = s.slice(0, -1);

    let mult = 1;
    const suffix = /([kKmMbB])$/.exec(s);
    if (suffix) {
      mult = { k: 1e3, m: 1e6, b: 1e9 }[suffix[1].toLowerCase()];
      s = s.slice(0, -1);
    }

    s = s.replace(/[^0-9.\-+eE]/g, '');
    if (!s || !/[0-9]/.test(s)) return null;

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return sign * n * mult / (percent ? 100 : 1);
  }

  function toDate(v) {
    if (v instanceof Date) return v;
    const s = String(v ?? '').trim();
    if (!s || /^\d+(\.\d+)?$/.test(s)) return null;   // a bare number is not a date
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  /**
   * Header row + typed columns. A column is numeric when most of its
   * non-empty cells parse as numbers — "most" rather than "all", because
   * one stray "n/a" in three hundred rows should not demote a whole
   * revenue column to text.
   *
   * The bar is 60%, not 70%: on a short pilot table of five rows a single
   * "n/a" is already 20% of the column, and at 70% that column silently
   * stopped being chartable. 60% still refuses a text column that happens
   * to hold a couple of numbers.
   */
  function readGrid(values) {
    const grid = values || [];
    if (!grid.length) return { columns: [], rows: [] };

    const header = grid[0].map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    const body = grid.slice(1).filter(r => r.some(c => String(c ?? '').trim() !== ''));

    const columns = header.map((name, i) => {
      const cells = body.map(r => r[i]).filter(c => String(c ?? '').trim() !== '');
      const nums = cells.filter(c => toNumber(c) !== null).length;
      const dates = cells.filter(c => toDate(c) !== null).length;
      let type = 'text';
      if (cells.length && nums / cells.length >= 0.6) type = 'number';
      else if (cells.length && dates / cells.length >= 0.6) type = 'date';
      return { index: i, name, type };
    });

    const rows = body.map(r => columns.map(c => r[c.index] ?? ''));
    return { columns, rows };
  }

  function applyFilter(data, filter) {
    if (!filter?.column) return data;
    const col = data.columns.find(c => c.name === filter.column);
    if (!col) return data;

    const raw = filter.value ?? '';
    const num = toNumber(raw);
    const test = cell => {
      const s = String(cell ?? '').toLowerCase();
      const n = toNumber(cell);
      switch (filter.op) {
        case '=':  return num != null && n != null ? n === num : s === String(raw).toLowerCase();
        case '!=': return num != null && n != null ? n !== num : s !== String(raw).toLowerCase();
        case '>':  return n != null && num != null && n > num;
        case '<':  return n != null && num != null && n < num;
        default:   return s.includes(String(raw).toLowerCase());
      }
    };
    return { columns: data.columns, rows: data.rows.filter(r => test(r[col.index])) };
  }

  function columnValues(data, name) {
    const col = data.columns.find(c => c.name === name);
    if (!col) return [];
    return data.rows.map(r => r[col.index]);
  }

  function numbersOf(data, name) {
    return columnValues(data, name).map(toNumber).filter(v => v !== null);
  }

  function formatNumber(n, opts = {}) {
    if (n == null || !Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    const compact = opts.compact !== false && abs >= 10000;
    const s = new Intl.NumberFormat(undefined, compact
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { maximumFractionDigits: abs < 10 ? 2 : abs < 1000 ? 1 : 0 }).format(n);
    return (opts.prefix || '') + s + (opts.suffix || '');
  }

  /* ================================================================
     Charts — small, dependency-free, theme-aware
     ================================================================ */

  const Chart = {
    /** Cartesian charts share an axis frame; only the marks differ. */
    xy(kind, { labels, series, width, height }) {
      const pad = { t: 14, r: 16, b: 28, l: 46 };
      const w = Math.max(160, width), h = Math.max(120, height);
      const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;

      const all = series.flatMap(s => s.values).filter(v => v != null);
      let lo = Math.min(0, ...all);
      let hi = Math.max(...all, 0);
      if (lo === hi) { hi = lo + 1; }
      const span = hi - lo;
      // A little headroom so the top mark is not welded to the frame.
      hi += span * 0.08;

      const svg = svgEl('svg', {
        class: 'wb-chart', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none',
      });

      const X = i => pad.l + (labels.length <= 1 ? iw / 2 : (i * iw) / (labels.length - 1));
      const XBand = i => pad.l + (i + 0.5) * (iw / Math.max(1, labels.length));
      const Y = v => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

      /* -- gridlines and the value axis -- */
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = lo + ((hi - lo) * i) / ticks;
        const y = Y(v);
        svg.appendChild(svgEl('line', {
          class: 'wb-chart-grid', x1: pad.l, x2: w - pad.r, y1: y, y2: y,
        }));
        svg.appendChild(svgEl('text', {
          class: 'wb-chart-tick', x: pad.l - 7, y: y + 3.5, 'text-anchor': 'end',
        }, formatNumber(v)));
      }

      /* -- marks -- */
      if (kind === 'bar') {
        const band = iw / Math.max(1, labels.length);
        const gap = Math.min(8, band * 0.25);
        const bw = Math.max(2, (band - gap) / series.length);
        series.forEach((s, si) => {
          s.values.forEach((v, i) => {
            if (v == null) return;
            const y = Y(v), zero = Y(Math.max(lo, 0));
            svg.appendChild(svgEl('rect', {
              class: 'wb-chart-bar',
              x: pad.l + i * band + gap / 2 + si * bw,
              y: Math.min(y, zero), width: bw, height: Math.max(1, Math.abs(zero - y)),
              rx: Math.min(3, bw / 2), fill: s.color,
            }, undefined));
          });
        });
      } else {
        series.forEach(s => {
          const pts = s.values.map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`)).filter(Boolean);
          if (!pts.length) return;
          if (kind === 'area') {
            svg.appendChild(svgEl('path', {
              class: 'wb-chart-area', fill: s.color, 'fill-opacity': 0.16,
              d: `M${X(0)},${Y(Math.max(lo, 0))} L${pts.join(' L')} L${X(s.values.length - 1)},${Y(Math.max(lo, 0))} Z`,
            }));
          }
          svg.appendChild(svgEl('path', {
            class: 'wb-chart-line', stroke: s.color, fill: 'none',
            d: `M${pts.join(' L')}`,
          }));
          if (s.values.length <= 40) {
            s.values.forEach((v, i) => v != null && svg.appendChild(svgEl('circle', {
              class: 'wb-chart-dot', cx: X(i), cy: Y(v), r: 2.6, fill: s.color,
            })));
          }
        });
      }

      /* -- category axis: thin it out rather than letting it overlap -- */
      const step = Math.max(1, Math.ceil(labels.length / Math.floor(iw / 62)));
      labels.forEach((lab, i) => {
        if (i % step) return;
        svg.appendChild(svgEl('text', {
          class: 'wb-chart-tick', x: kind === 'bar' ? XBand(i) : X(i),
          y: h - 9, 'text-anchor': 'middle',
        }, String(lab).slice(0, 12)));
      });

      return svg;
    },

    donut({ slices, width, height }) {
      const size = Math.min(width, height);
      const r = size / 2 - 6, inner = r * 0.58;
      const cx = width / 2, cy = height / 2;
      const total = slices.reduce((a, s) => a + Math.abs(s.value), 0) || 1;

      const svg = svgEl('svg', { class: 'wb-chart', viewBox: `0 0 ${width} ${height}` });
      let angle = -Math.PI / 2;

      for (const s of slices) {
        const sweep = (Math.abs(s.value) / total) * Math.PI * 2;
        if (sweep <= 0) continue;
        const end = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
        svg.appendChild(svgEl('path', {
          class: 'wb-chart-slice', fill: s.color,
          d: `M${p(r, angle)} A${r},${r} 0 ${large} 1 ${p(r, end)} ` +
             `L${p(inner, end)} A${inner},${inner} 0 ${large} 0 ${p(inner, angle)} Z`,
        }));
        angle = end;
      }

      svg.appendChild(svgEl('text', {
        class: 'wb-chart-centre', x: cx, y: cy + 2, 'text-anchor': 'middle',
      }, formatNumber(total)));
      svg.appendChild(svgEl('text', {
        class: 'wb-chart-centre-sub', x: cx, y: cy + 18, 'text-anchor': 'middle',
      }, 'total'));
      return svg;
    },

    gauge({ value, min, max, width, height, color }) {
      const w = width, h = height;
      const cx = w / 2, cy = h * 0.78, r = Math.min(w / 2, h * 0.78) - 12;
      const frac = Math.max(0, Math.min(1, (value - min) / ((max - min) || 1)));

      const arc = (from, to) => {
        const a0 = Math.PI + Math.PI * from, a1 = Math.PI + Math.PI * to;
        return `M${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} ` +
               `A${r},${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}`;
      };

      const svg = svgEl('svg', { class: 'wb-chart', viewBox: `0 0 ${w} ${h}` });
      svg.appendChild(svgEl('path', { class: 'wb-gauge-track', d: arc(0, 1) }));
      if (frac > 0) svg.appendChild(svgEl('path', { class: 'wb-gauge-fill', d: arc(0, frac), stroke: color }));
      svg.appendChild(svgEl('text', {
        class: 'wb-gauge-value', x: cx, y: cy - 4, 'text-anchor': 'middle',
      }, formatNumber(value)));
      svg.appendChild(svgEl('text', {
        class: 'wb-chart-tick', x: cx - r, y: cy + 16, 'text-anchor': 'middle',
      }, formatNumber(min)));
      svg.appendChild(svgEl('text', {
        class: 'wb-chart-tick', x: cx + r, y: cy + 16, 'text-anchor': 'middle',
      }, formatNumber(max)));
      return svg;
    },
  };

  /* ================================================================
     The dashboard widget
     ================================================================ */

  class SheetDash {
    constructor(app, element, node) {
      this.app = app;
      this.store = app.store;
      this.id = element.id;
      this.node = node;
      this.type = 'sheet-dash';

      this.data = null;           // { columns, rows }
      this.loading = false;
      this.error = null;
      this.fetchedAt = null;
      this._timer = null;
      this._sort = null;

      this._build();
      this._restoreCache(element);
      this.update(element);
      if (element.sheetId) this.refresh({ quiet: true });
      this._schedule(element);
    }

    get element() { return this.store.get(this.id); }
    get widgets() { return this.element?.widgets || []; }

    _write(props) { this.store.updateElement(this.id, props); }

    /**
     * The last read is saved with the board so it opens showing numbers
     * rather than a spinner — and so it still says something useful when
     * the Google connection is gone.
     */
    _restoreCache(element) {
      const c = element.cache;
      if (c?.columns && c?.rows) {
        this.data = { columns: c.columns, rows: c.rows };
        this.fetchedAt = c.fetchedAt || null;
      }
    }

    /* ---- chrome -------------------------------------------------------- */

    _build() {
      this.node.textContent = '';

      this.titleEl = el('input', {
        class: 'wb-dash-title wb-live-ui', placeholder: 'Dashboard title',
        onchange: () => this._write({ title: this.titleEl.value }),
      });

      this.stampEl = el('span', { class: 'wb-dash-stamp' });

      this.head = el('div', { class: 'wb-dash-head wb-live-ui' }, [
        el('i', { class: 'ph-fill ph-chart-line-up wb-dash-mark' }),
        this.titleEl,
        this.stampEl,
        el('span', { class: 'wb-cell-spacer' }),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Read the sheet again now',
          onclick: () => this.refresh(),
        }, [el('i', { class: 'ph ph-arrows-clockwise' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Download the current data as CSV',
          onclick: () => this._exportCsv(),
        }, [el('i', { class: 'ph ph-download-simple' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn is-run', title: 'Add a panel',
          onclick: e => this._addMenu(e.currentTarget),
        }, [el('i', { class: 'ph-bold ph-plus' }), el('span', { text: 'Panel' })]),
      ]);

      this.sourceBar = el('div', { class: 'wb-dash-source wb-live-ui' });
      this.body = el('div', { class: 'wb-dash-body wb-live-ui' });

      this.node.append(this.head, this.sourceBar, this.body);
    }

    /* ---- source -------------------------------------------------------- */

    _paintSource() {
      const e = this.element;
      // A refresh tick lands every few seconds. Rebuilding this row while
      // someone is halfway through pasting a spreadsheet link would throw
      // away both the text and the caret, so the live row wins until they
      // are done with it.
      if (isTyping(this.sourceBar)) return;
      this.sourceBar.textContent = '';

      const idInput = el('input', {
        class: 'wb-dash-input is-wide',
        placeholder: 'Paste a Google Sheets link, or pick one →',
        value: e.sheetUrl || e.sheetId || '',
        onchange: () => this._setSheet(idInput.value),
      });

      const rangeInput = el('input', {
        class: 'wb-dash-input',
        placeholder: 'Sheet1!A1:H500',
        value: e.range || '',
        title: 'Which cells to read. Leave blank for the first tab.',
        onchange: () => { this._write({ range: rangeInput.value }); this.refresh(); },
      });

      const every = el('select', {
        class: 'wb-dash-input is-narrow', title: 'How often to re-read the sheet',
        onchange: () => {
          this._write({ refreshSec: +every.value });
          this._schedule(this.element);
        },
      }, [15, 30, 60, 300, 900, 0].map(s => el('option', {
        value: s, text: s ? `every ${s < 60 ? s + 's' : s / 60 + ' min'}` : 'manual only',
        selected: (e.refreshSec ?? 60) === s,
      })));

      this.sourceBar.append(
        idInput,
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Choose from your Google Drive',
          onclick: () => this._pickSheet(),
        }, [el('i', { class: 'ph ph-folder-open' })]),
        rangeInput,
        every,
      );

      if (this.data?.columns?.length) this.sourceBar.appendChild(this._filterControls());
    }

    _filterControls() {
      const f = this.element.filter || {};
      const cols = this.data.columns;

      const colSel = el('select', { class: 'wb-dash-input is-narrow' }, [
        el('option', { value: '', text: 'no filter' }),
        ...cols.map(c => el('option', { value: c.name, text: c.name, selected: f.column === c.name })),
      ]);
      const opSel = el('select', { class: 'wb-dash-input is-tiny' },
        ['contains', '=', '!=', '>', '<'].map(o =>
          el('option', { value: o, text: o, selected: (f.op || 'contains') === o })));
      const valInput = el('input', { class: 'wb-dash-input is-narrow', placeholder: 'value', value: f.value || '' });

      const apply = () => {
        this._write({ filter: { column: colSel.value, op: opSel.value, value: valInput.value } });
        this._paintBody();
      };
      colSel.addEventListener('change', apply);
      opSel.addEventListener('change', apply);
      valInput.addEventListener('change', apply);

      return el('span', { class: 'wb-dash-filter' }, [
        el('i', { class: 'ph ph-funnel' }), colSel, opSel, valInput,
      ]);
    }

    async _setSheet(value) {
      const raw = (value || '').trim();
      if (!raw) { this._write({ sheetId: '', sheetUrl: '', sheetTitle: '' }); this._paint(); return; }

      this._write({ sheetUrl: raw, sheetId: raw });
      this.loading = true; this._paint();

      try {
        const meta = await this._get('/api/google/sheets/meta', { id: raw });
        this._write({
          sheetId: meta.id, sheetUrl: meta.link, sheetTitle: meta.title,
          tabs: meta.tabs?.map(t => t.title) || [],
          range: this.element.range || (meta.tabs?.[0]?.title ? `${meta.tabs[0].title}!A1:Z1000` : ''),
          title: this.element.title && this.element.title !== 'Live dashboard'
            ? this.element.title : (meta.title || 'Live dashboard'),
        });
        await this.refresh();
      } catch (err) {
        this.error = err.message;
        this.loading = false;
        this._paint();
      }
    }

    async _pickSheet() {
      let list;
      try {
        list = await this._get('/api/google/sheets/list', {});
      } catch (err) {
        toast(err.message, 'warn', 6000);
        return;
      }
      const sheets = list.sheets || [];
      if (!sheets.length) { toast('No spreadsheets found in your Drive.', 'info'); return; }

      const overlay = el('div', { class: 'wb-dash-picker' });
      const close = () => overlay.remove();
      overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });

      overlay.appendChild(el('div', { class: 'wb-dash-picker-card' }, [
        el('h3', { text: 'Choose a spreadsheet' }),
        el('div', { class: 'wb-dash-picker-list' }, sheets.map(s => el('button', {
          type: 'button', class: 'wb-dash-picker-row',
          onclick: () => { close(); this._setSheet(s.id); },
        }, [
          el('i', { class: 'ph ph-file-xls' }),
          el('span', {}, [
            el('strong', { text: s.name }),
            el('small', { text: s.modified ? 'edited ' + new Date(s.modified).toLocaleString() : '' }),
          ]),
        ]))),
        el('button', { type: 'button', class: 'wb-cell-btn', text: 'Cancel', onclick: close }),
      ]));
      document.body.appendChild(overlay);
    }

    async _get(path, params) {
      const url = path + '?' + new URLSearchParams(params).toString();
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error([body.error, body.fix].filter(Boolean).join(' — ')
          || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return body;
    }

    /* ---- data ---------------------------------------------------------- */

    _schedule(element) {
      clearInterval(this._timer);
      const secs = element?.refreshSec ?? 60;
      if (!secs || !element?.sheetId) return;
      this._timer = setInterval(() => this.refresh({ quiet: true }),
        Math.max(MIN_REFRESH, secs) * 1000);
    }

    async refresh({ quiet = false } = {}) {
      const e = this.element;
      if (!e?.sheetId) { if (!quiet) toast('Point this dashboard at a spreadsheet first.', 'info'); return; }
      if (this.loading) return;

      this.loading = true;
      this.error = null;
      if (!quiet) this._paintStamp();

      try {
        const res = await this._get('/api/google/sheets/values', {
          id: e.sheetId, range: e.range || '',
        });
        this.data = readGrid(res.values);
        this.fetchedAt = res.fetchedAt || new Date().toISOString();

        // Cache with the board, bounded — a 50k-row sheet must not turn
        // into a 50k-row board file.
        this._write({
          cache: {
            columns: this.data.columns,
            rows: this.data.rows.slice(0, MAX_CACHED_ROWS),
            fetchedAt: this.fetchedAt,
            truncated: this.data.rows.length > MAX_CACHED_ROWS,
          },
        });
      } catch (err) {
        this.error = err.message;
        if (!quiet) toast(err.message, 'warn', 7000);
      } finally {
        this.loading = false;
        this._paint();
      }
    }

    _view() {
      if (!this.data) return null;
      return applyFilter(this.data, this.element?.filter);
    }

    _exportCsv() {
      const view = this._view();
      if (!view?.rows.length) { toast('There is nothing to export yet.', 'info'); return; }
      const esc = v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [view.columns.map(c => esc(c.name)).join(','),
        ...view.rows.map(r => r.map(esc).join(','))].join('\n');
      const name = (this.element.title || 'dashboard').replace(/[^\w-]+/g, '-') + '.csv';
      global.Util?.download
        ? global.Util.download(new Blob([csv], { type: 'text/csv' }), name)
        : downloadFallback(csv, name);
      toast(`Exported ${view.rows.length} rows.`, 'success', 2500);
    }

    /* ---- panels -------------------------------------------------------- */

    _addMenu(anchor) {
      document.querySelector('.wb-cell-menu')?.remove();
      const rect = anchor.getBoundingClientRect();
      const menu = el('div', { class: 'wb-cell-menu' }, WIDGETS.map(([kind, label, icon]) =>
        el('button', {
          type: 'button', class: 'wb-cell-menu-item',
          onclick: () => { menu.remove(); this._addWidget(kind); },
        }, [el('i', { class: 'ph ' + icon }), el('span', { text: label })])));
      menu.style.left = Math.min(rect.left - 60, innerWidth - 260) + 'px';
      menu.style.top = (rect.bottom + 6) + 'px';
      document.body.appendChild(menu);
      setTimeout(() => document.addEventListener('pointerdown', function close(ev) {
        if (menu.contains(ev.target)) return;
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }, true), 0);
    }

    /** Sensible defaults from the data, so a new panel is never blank. */
    _addWidget(kind) {
      const view = this._view();
      const nums = view?.columns.filter(c => c.type === 'number') || [];
      const cats = view?.columns.filter(c => c.type !== 'number') || [];

      const w = {
        id: uid('w'), kind, span: kind === 'kpi' || kind === 'gauge' ? 1 : 2,
        title: WIDGETS.find(x => x[0] === kind)?.[1] || 'Panel',
      };
      if (kind === 'kpi' || kind === 'gauge') {
        w.column = nums[0]?.name || '';
        w.agg = kind === 'gauge' ? 'last' : 'sum';
        w.title = w.column || w.title;
      } else if (kind === 'table') {
        w.limit = 12;
        w.span = 3;
      } else {
        w.xColumn = (cats[0] || view?.columns[0])?.name || '';
        w.yColumns = nums.slice(0, 2).map(c => c.name);
        w.title = w.yColumns.join(' · ') || w.title;
      }

      this._write({ widgets: [...this.widgets, w] });
    }

    _updateWidget(id, patch) {
      this._write({ widgets: this.widgets.map(w => w.id === id ? { ...w, ...patch } : w) });
    }

    _removeWidget(id) {
      this._write({ widgets: this.widgets.filter(w => w.id !== id) });
    }

    /* ---- painting ------------------------------------------------------ */

    update(element) {
      if (!element) return;
      if (document.activeElement !== this.titleEl) {
        this.titleEl.value = element.title || '';
      }
      this._restoreCacheIfNewer(element);
      this._paint();
    }

    _restoreCacheIfNewer(element) {
      const c = element.cache;
      if (!c?.rows) return;
      if (!this.fetchedAt || (c.fetchedAt && c.fetchedAt > this.fetchedAt)) {
        this.data = { columns: c.columns, rows: c.rows };
        this.fetchedAt = c.fetchedAt;
      }
    }

    _paint() {
      this._paintSource();
      this._paintStamp();
      this._paintBody();
    }

    _paintStamp() {
      if (this.loading) {
        this.stampEl.textContent = 'reading…';
        this.stampEl.dataset.state = 'busy';
      } else if (this.error) {
        this.stampEl.textContent = 'refresh failed';
        this.stampEl.dataset.state = 'bad';
        this.stampEl.title = this.error;
      } else if (this.fetchedAt) {
        this.stampEl.textContent = 'updated ' + relative(this.fetchedAt);
        this.stampEl.dataset.state = 'ok';
        this.stampEl.title = new Date(this.fetchedAt).toLocaleString();
      } else {
        this.stampEl.textContent = '';
        this.stampEl.dataset.state = '';
      }
    }

    _paintBody() {
      // Only a caret needs protecting. A <select> or a button has already
      // committed its change by the time this runs, and skipping the
      // repaint for those would mean picking a new column did nothing
      // visible — the exact opposite of what the guard is for.
      if (isTyping(this.body)) return;
      this.body.textContent = '';
      const e = this.element;

      if (!e.sheetId) { this.body.appendChild(this._emptyState()); return; }

      if (this.error) {
        this.body.appendChild(el('div', { class: 'wb-dash-error' }, [
          el('i', { class: 'ph-bold ph-warning-circle' }),
          el('div', {}, [
            el('strong', { text: 'Could not read the sheet' }),
            el('p', { text: this.error }),
          ]),
        ]));
      }

      const view = this._view();
      if (!view) {
        this.body.appendChild(el('p', { class: 'wb-dash-note', text: 'Loading the sheet…' }));
        return;
      }
      if (!view.rows.length) {
        this.body.appendChild(el('p', {
          class: 'wb-dash-note',
          text: this.element.filter?.column
            ? 'No rows match the filter.'
            : 'That range came back empty. Check the range, or that the tab name is right.',
        }));
      }

      const widgets = this.widgets;
      if (!widgets.length) {
        this.body.appendChild(el('div', { class: 'wb-dash-note' }, [
          document.createTextNode(`${view.rows.length} rows · ${view.columns.length} columns read. `),
          el('button', {
            type: 'button', class: 'wb-dash-link', text: 'Add your first panel',
            onclick: () => this._autoBuild(view),
          }),
          document.createTextNode(' — or build one from the Panel menu.'),
        ]));
        return;
      }

      const grid = el('div', { class: 'wb-dash-grid' });
      for (const w of widgets) grid.appendChild(this._panel(w, view));
      this.body.appendChild(grid);
    }

    _emptyState() {
      return el('div', { class: 'wb-dash-empty' }, [
        el('i', { class: 'ph ph-google-drive-logo' }),
        el('strong', { text: 'Connect this panel to a Google Sheet' }),
        el('p', { text: 'Paste a spreadsheet link above, or browse your Drive. The dashboard re-reads it on a timer, so the board always shows the current numbers.' }),
      ]);
    }

    /** One click that turns a fresh sheet into a dashboard worth looking at. */
    _autoBuild(view) {
      const nums = view.columns.filter(c => c.type === 'number');
      const cats = view.columns.filter(c => c.type !== 'number');
      const widgets = [];

      for (const c of nums.slice(0, 3)) {
        widgets.push({ id: uid('w'), kind: 'kpi', span: 1, title: c.name, column: c.name, agg: 'sum' });
      }
      if (nums.length && (cats.length || view.columns.length)) {
        widgets.push({
          id: uid('w'), kind: 'bar', span: 2, title: nums[0].name + ' by ' + (cats[0] || view.columns[0]).name,
          xColumn: (cats[0] || view.columns[0]).name, yColumns: [nums[0].name],
        });
      }
      if (nums.length > 1) {
        widgets.push({
          id: uid('w'), kind: 'line', span: 2, title: 'Trend',
          xColumn: (cats[0] || view.columns[0]).name,
          yColumns: nums.slice(0, 3).map(c => c.name),
        });
      }
      widgets.push({ id: uid('w'), kind: 'table', span: 3, title: 'Data', limit: 12 });

      this._write({ widgets });
      toast('Built a starting dashboard. Every panel can be re-pointed from its own header.', 'success', 4500);
    }

    _panel(w, view) {
      const card = el('div', { class: `wb-dash-card span-${w.span || 2}` });

      const title = el('input', {
        class: 'wb-dash-card-title wb-live-ui', value: w.title || '',
        onchange: ev => this._updateWidget(w.id, { title: ev.target.value }),
      });

      card.appendChild(el('div', { class: 'wb-dash-card-head' }, [
        title,
        el('button', {
          type: 'button', class: 'wb-dash-mini', title: 'Panel settings',
          onclick: () => { card.classList.toggle('is-config'); },
        }, [el('i', { class: 'ph ph-sliders-horizontal' })]),
        el('button', {
          type: 'button', class: 'wb-dash-mini', title: 'Remove this panel',
          onclick: () => this._removeWidget(w.id),
        }, [el('i', { class: 'ph ph-x' })]),
      ]));

      card.appendChild(this._panelConfig(w, view));

      const chartHost = el('div', { class: 'wb-dash-card-body' });
      card.appendChild(chartHost);

      // The SVG needs pixel dimensions, and the card has none until it is
      // in the document and laid out.
      requestAnimationFrame(() => {
        const box = chartHost.getBoundingClientRect();
        const scale = this.app.viewport?.scale || 1;
        const width = Math.max(160, box.width / scale);
        const height = Math.max(110, box.height / scale);
        chartHost.textContent = '';
        try {
          chartHost.appendChild(this._render(w, view, width, height));
        } catch (err) {
          console.error('[dash]', err);
          chartHost.appendChild(el('p', { class: 'wb-dash-note', text: 'This panel could not be drawn from the current columns.' }));
        }
      });

      return card;
    }

    _panelConfig(w, view) {
      const wrap = el('div', { class: 'wb-dash-config wb-live-ui' });
      const names = view.columns.map(c => c.name);
      const nums = view.columns.filter(c => c.type === 'number').map(c => c.name);

      const pick = (label, value, options, onPick) => el('label', { class: 'wb-dash-field' }, [
        el('span', { text: label }),
        el('select', { class: 'wb-dash-input', onchange: ev => onPick(ev.target.value) },
          options.map(o => el('option', { value: o, text: o || '—', selected: o === value }))),
      ]);

      if (w.kind === 'kpi' || w.kind === 'gauge') {
        wrap.append(
          pick('Column', w.column, ['', ...nums], v => this._updateWidget(w.id, { column: v })),
          pick('Aggregate', w.agg, Object.keys(AGGS), v => this._updateWidget(w.id, { agg: v })),
        );
        if (w.kind === 'gauge') {
          wrap.appendChild(el('label', { class: 'wb-dash-field' }, [
            el('span', { text: 'Target' }),
            el('input', {
              class: 'wb-dash-input', type: 'number', value: w.target ?? '',
              placeholder: 'auto',
              onchange: ev => this._updateWidget(w.id, { target: ev.target.value === '' ? null : +ev.target.value }),
            }),
          ]));
        }
      } else if (w.kind === 'table') {
        wrap.appendChild(el('label', { class: 'wb-dash-field' }, [
          el('span', { text: 'Rows' }),
          el('input', {
            class: 'wb-dash-input', type: 'number', min: 1, max: 200, value: w.limit || 12,
            onchange: ev => this._updateWidget(w.id, { limit: Math.max(1, +ev.target.value || 12) }),
          }),
        ]));
      } else {
        wrap.appendChild(pick('X axis', w.xColumn, names, v => this._updateWidget(w.id, { xColumn: v })));
        wrap.appendChild(el('label', { class: 'wb-dash-field is-multi' }, [
          el('span', { text: 'Series' }),
          el('div', { class: 'wb-dash-checks' }, nums.map(n => {
            const on = (w.yColumns || []).includes(n);
            return el('button', {
              type: 'button', class: 'wb-dash-check' + (on ? ' is-on' : ''), text: n,
              onclick: () => {
                const next = on ? w.yColumns.filter(x => x !== n) : [...(w.yColumns || []), n];
                this._updateWidget(w.id, { yColumns: next });
              },
            });
          })),
        ]));
      }

      wrap.appendChild(pick('Width', String(w.span || 2), ['1', '2', '3'],
        v => this._updateWidget(w.id, { span: +v })));

      return wrap;
    }

    _render(w, view, width, height) {
      switch (w.kind) {
        case 'kpi':   return this._kpi(w, view);
        case 'gauge': return this._gauge(w, view, width, height);
        case 'table': return this._table(w, view);
        case 'pie':   return this._pie(w, view, width, height);
        default:      return this._xy(w, view, width, height);
      }
    }

    _kpi(w, view) {
      const values = numbersOf(view, w.column);
      const agg = AGGS[w.agg] || AGGS.sum;
      const value = values.length ? agg.fn(values) : null;

      // Compared with the same aggregate over everything but the last row:
      // the honest reading of "how did this change" for a sheet that is
      // appended to over time.
      let delta = null;
      if (values.length > 1 && w.agg !== 'count') {
        const before = agg.fn(values.slice(0, -1));
        if (before) delta = ((value - before) / Math.abs(before)) * 100;
      }

      return el('div', { class: 'wb-kpi' }, [
        el('div', { class: 'wb-kpi-value', text: value == null ? '—' : formatNumber(value) }),
        el('div', { class: 'wb-kpi-meta' }, [
          el('span', { text: `${agg.label}${w.column ? ' of ' + w.column : ''}` }),
          delta == null ? null : el('span', {
            class: 'wb-kpi-delta ' + (delta >= 0 ? 'is-up' : 'is-down'),
            text: `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}%`,
          }),
        ].filter(Boolean)),
        el('div', { class: 'wb-kpi-sub', text: `${values.length} value${values.length === 1 ? '' : 's'}` }),
      ]);
    }

    _gauge(w, view, width, height) {
      const values = numbersOf(view, w.column);
      const agg = AGGS[w.agg] || AGGS.last;
      const value = values.length ? agg.fn(values) : 0;
      const max = w.target ?? (values.length ? Math.max(...values) * 1.1 : 100);
      return Chart.gauge({
        value, min: 0, max: max || 1, width, height,
        color: value >= (w.target ?? max) * 0.9 ? SERIES[1] : SERIES[0],
      });
    }

    _xy(w, view, width, height) {
      const labels = columnValues(view, w.xColumn).map(v => String(v ?? ''));
      const series = (w.yColumns || []).map((name, i) => ({
        name,
        color: SERIES[i % SERIES.length],
        values: columnValues(view, name).map(toNumber),
      }));

      if (!series.length || !labels.length) {
        return el('p', { class: 'wb-dash-note', text: 'Choose an X axis and at least one numeric series in this panel’s settings.' });
      }

      const wrap = el('div', { class: 'wb-chart-wrap' });
      wrap.appendChild(Chart.xy(w.kind, { labels, series, width, height: height - 22 }));
      wrap.appendChild(el('div', { class: 'wb-chart-legend' }, series.map(s =>
        el('span', {}, [
          el('i', { style: { background: s.color } }),
          document.createTextNode(s.name),
        ]))));
      return wrap;
    }

    _pie(w, view, width, height) {
      const labels = columnValues(view, w.xColumn).map(v => String(v ?? ''));
      const name = (w.yColumns || [])[0];
      const values = columnValues(view, name).map(toNumber);

      if (!name || !labels.length) {
        return el('p', { class: 'wb-dash-note', text: 'A donut needs a label column and one numeric series.' });
      }

      // Group by label, so five rows of "North" become one slice.
      const totals = new Map();
      labels.forEach((lab, i) => {
        const v = values[i];
        if (v == null) return;
        totals.set(lab, (totals.get(lab) || 0) + v);
      });
      const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9);
      const slices = top.map(([label, value], i) => ({ label, value, color: SERIES[i % SERIES.length] }));

      const wrap = el('div', { class: 'wb-chart-wrap' });
      wrap.appendChild(Chart.donut({ slices, width: width * 0.6, height: height - 22 }));
      wrap.appendChild(el('div', { class: 'wb-chart-legend is-column' }, slices.map(s =>
        el('span', {}, [el('i', { style: { background: s.color } }), document.createTextNode(s.label)]))));
      return wrap;
    }

    _table(w, view) {
      const sort = this._sort?.[w.id];
      let rows = view.rows;
      if (sort) {
        const ci = view.columns.findIndex(c => c.name === sort.column);
        const numeric = view.columns[ci]?.type === 'number';
        rows = [...rows].sort((a, b) => {
          const x = numeric ? (toNumber(a[ci]) ?? 0) : String(a[ci] ?? '');
          const y = numeric ? (toNumber(b[ci]) ?? 0) : String(b[ci] ?? '');
          return (x > y ? 1 : x < y ? -1 : 0) * (sort.dir === 'desc' ? -1 : 1);
        });
      }
      rows = rows.slice(0, w.limit || 12);

      return el('div', { class: 'wb-dash-tablewrap' }, [
        el('table', { class: 'wb-dash-table' }, [
          el('thead', {}, [el('tr', {}, view.columns.map(c => el('th', {
            class: c.type === 'number' ? 'is-num' : '',
            text: c.name + (sort?.column === c.name ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''),
            onclick: () => {
              this._sort = this._sort || {};
              const cur = this._sort[w.id];
              this._sort[w.id] = { column: c.name, dir: cur?.column === c.name && cur.dir === 'asc' ? 'desc' : 'asc' };
              this._paintBody();
            },
          })))]),
          el('tbody', {}, rows.map(r => el('tr', {}, r.map((cell, i) => el('td', {
            class: view.columns[i]?.type === 'number' ? 'is-num' : '',
            text: String(cell ?? ''),
          }))))),
        ]),
        view.rows.length > rows.length
          ? el('p', { class: 'wb-dash-more', text: `${view.rows.length - rows.length} more rows` })
          : null,
      ].filter(Boolean));
    }

    destroy() {
      clearInterval(this._timer);
      document.querySelector('.wb-dash-picker')?.remove();
      document.querySelector('.wb-cell-menu')?.remove();
    }
  }

  /** True when a caret is inside `host` and would be lost by a repaint. */
  function isTyping(host) {
    const a = document.activeElement;
    return !!a && a.tagName === 'INPUT' && host.contains(a);
  }

  function relative(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const secs = Math.round((Date.now() - then) / 1000);
    if (secs < 10) return 'just now';
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + ' min ago';
    if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString();
  }

  function downloadFallback(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.WBSheetDash = { SheetDash, readGrid, toNumber, Chart };

  /* ---- renderer hook ---------------------------------------------------- */

  function install() {
    const proto = global.Renderer?.prototype;
    if (!proto || proto._sheetDash) return;
    proto._sheetDash = function (element, node) {
      const dash = new SheetDash(this.app, element, node);
      node.__live = {
        type: 'sheet-dash',
        update: e => dash.update(e),
        destroy: () => dash.destroy(),
      };
    };
  }

  if (global.Renderer) install();
  else global.addEventListener('DOMContentLoaded', install, { once: true });
})(window);
