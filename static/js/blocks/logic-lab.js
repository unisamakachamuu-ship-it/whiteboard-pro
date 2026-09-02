/* ================================================================
   logic-lab.js — a working logic circuit on the board
   ----------------------------------------------------------------
   Not a picture of gates: a circuit that is actually evaluated. Flip
   an input and every wire, gate and lamp downstream changes on the
   same frame, because the whole network is re-solved on every edit.

   How it is solved.

   A combinational circuit is a fixed point, so the evaluator relaxes
   rather than sorts: hold every node's output, recompute all of them
   from their inputs, repeat until nothing changes. That takes at most
   one pass per gate on a feedback-free circuit and — unlike a
   topological sort — it does not fall over when you wire an output
   back to an input.

   Feedback is worth supporting, because that is how an SR latch is
   built and a latch is the first interesting thing anyone draws. Two
   cross-coupled NOR gates settle in three passes. A NOT gate wired to
   itself never settles at all, and the circuit says so ("oscillating")
   instead of silently showing whichever value the loop stopped on.

   Model:
     circuit: {
       nodes: [{ id, kind, x, y, label, value }],
       wires: [{ id, from, to: { node, port } }]
     }
   ================================================================ */

(function (global) {
  'use strict';

  /* ================================================================
     Gates
     ================================================================ */

  const GATES = {
    IN:   { ins: 0, label: 'Input',  kind: 'io' },
    OUT:  { ins: 1, label: 'Output', kind: 'io' },
    AND:  { ins: 2, label: 'AND',  op: v => v.every(Boolean) ? 1 : 0 },
    OR:   { ins: 2, label: 'OR',   op: v => v.some(Boolean) ? 1 : 0 },
    NOT:  { ins: 1, label: 'NOT',  op: v => v[0] ? 0 : 1 },
    XOR:  { ins: 2, label: 'XOR',  op: v => v.filter(Boolean).length % 2 },
    NAND: { ins: 2, label: 'NAND', op: v => v.every(Boolean) ? 0 : 1 },
    NOR:  { ins: 2, label: 'NOR',  op: v => v.some(Boolean) ? 0 : 1 },
    XNOR: { ins: 2, label: 'XNOR', op: v => v.filter(Boolean).length % 2 ? 0 : 1 },
  };

  const GATE_W = 58;
  const GATE_H = 42;
  const PORT_R = 5;

  /** Where a node's pins sit, in the node's own coordinates. */
  function pins(node) {
    const n = GATES[node.kind]?.ins ?? 0;
    const ins = Array.from({ length: n }, (_, i) => ({
      x: 0, y: GATE_H * (i + 1) / (n + 1),
    }));
    const out = node.kind === 'OUT' ? null : { x: GATE_W, y: GATE_H / 2 };
    return { ins, out };
  }

  /* ================================================================
     Evaluation
     ================================================================ */

  /**
   * Solve the circuit.
   *
   * Returns a value per node plus `stable`. An unstable result is still
   * returned — a half-settled ring oscillator is more informative on
   * screen than a blank canvas — but it is flagged so the UI can say so.
   */
  function solve(circuit, maxPasses = 64) {
    const nodes = circuit.nodes || [];
    const wires = circuit.wires || [];

    const values = new Map();
    for (const n of nodes) values.set(n.id, n.kind === 'IN' ? (n.value ? 1 : 0) : 0);

    // Which wire feeds each (node, port). Later wires win, so re-wiring a
    // pin replaces rather than shorts.
    const feed = new Map();
    for (const w of wires) feed.set(w.to.node + ':' + w.to.port, w.from);

    let stable = false;
    for (let pass = 0; pass < maxPasses && !stable; pass++) {
      stable = true;
      for (const n of nodes) {
        const spec = GATES[n.kind];
        if (!spec || n.kind === 'IN') continue;

        const inputs = Array.from({ length: spec.ins }, (_, i) => {
          const src = feed.get(n.id + ':' + i);
          return src ? (values.get(src) ?? 0) : 0;
        });

        // An OUT is a probe: it shows whatever reaches it.
        const next = n.kind === 'OUT' ? (inputs[0] ?? 0) : spec.op(inputs);
        if (values.get(n.id) !== next) { values.set(n.id, next); stable = false; }
      }
    }

    return { values, stable };
  }

  /**
   * Every input combination and what comes out — the thing you would
   * otherwise work out on paper to check the circuit is right.
   */
  function truthTable(circuit, limit = 8) {
    const ins = (circuit.nodes || []).filter(n => n.kind === 'IN');
    const outs = (circuit.nodes || []).filter(n => n.kind === 'OUT');
    if (!ins.length || !outs.length) return null;
    if (ins.length > limit) return { tooWide: true, count: ins.length };

    const rows = [];
    for (let mask = 0; mask < (1 << ins.length); mask++) {
      const probe = {
        ...circuit,
        nodes: circuit.nodes.map(n => n.kind === 'IN'
          ? { ...n, value: (mask >> ins.indexOf(n)) & 1 }
          : n),
      };
      const { values } = solve(probe);
      rows.push({
        in: ins.map((_, i) => (mask >> i) & 1),
        out: outs.map(o => values.get(o.id) ?? 0),
      });
    }
    return { ins, outs, rows };
  }

  /* ================================================================
     The widget
     ================================================================ */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
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

  let seq = 0;
  const uid = p => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

  class LogicLab {
    constructor(app, element, node) {
      this.app = app;
      this.store = app.store;
      this.id = element.id;
      this.node = node;
      this.type = 'logic-lab';

      this.pending = null;      // an output pin waiting for its input pin
      this.dragging = null;
      this.showTable = false;

      this._build();
      this.update(element);
    }

    get element() { return this.store.get(this.id); }
    get circuit() {
      const c = this.element?.circuit;
      return (c && Array.isArray(c.nodes)) ? c : { nodes: [], wires: [] };
    }

    _write(circuit) {
      this.store.updateElement(this.id, { circuit });
    }

    /* ---- chrome -------------------------------------------------------- */

    _build() {
      this.node.textContent = '';

      const palette = el('div', { class: 'wb-lab-palette wb-live-ui' },
        [...Object.keys(GATES)].map(kind => el('button', {
          type: 'button', class: 'wb-lab-chip', title: `Add ${GATES[kind].label}`,
          onclick: () => this._add(kind),
        }, [document.createTextNode(GATES[kind].label)])));

      this.stateEl = el('span', { class: 'wb-lab-state' });

      this.head = el('div', { class: 'wb-lab-head wb-live-ui' }, [
        el('span', { class: 'wb-lab-title', text: 'Logic circuit' }),
        this.stateEl,
        el('span', { class: 'wb-cell-spacer' }),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Show the full truth table',
          onclick: () => { this.showTable = !this.showTable; this._paint(); },
        }, [el('i', { class: 'ph ph-table' }), el('span', { text: 'Truth table' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Remove every gate and wire',
          onclick: () => this._write({ nodes: [], wires: [] }),
        }, [el('i', { class: 'ph ph-trash' })]),
      ]);

      this.svg = svgEl('svg', { class: 'wb-lab-svg wb-live-ui' });
      this.wireLayer = svgEl('g', { class: 'wb-lab-wires' });
      this.nodeLayer = svgEl('g', { class: 'wb-lab-nodes' });
      this.ghost = svgEl('path', { class: 'wb-lab-ghost' });
      this.svg.append(this.wireLayer, this.ghost, this.nodeLayer);

      this.svg.addEventListener('pointerdown', e => this._onDown(e));
      this.svg.addEventListener('pointermove', e => this._onMove(e));
      this.svg.addEventListener('pointerup', e => this._onUp(e));
      this.svg.addEventListener('pointerleave', () => this._cancelPending());

      this.tableWrap = el('div', { class: 'wb-lab-table wb-live-ui' });
      this.hint = el('div', { class: 'wb-lab-hint' });

      this.node.append(this.head, palette,
        el('div', { class: 'wb-lab-stage' }, [this.svg]),
        this.tableWrap, this.hint);
    }

    /* ---- editing ------------------------------------------------------- */

    _add(kind) {
      const c = this.circuit;
      // Stack new gates down the left in a lane of their own rather than
      // dropping them all on the same pixel.
      const count = c.nodes.length;
      const node = {
        id: uid('n'),
        kind,
        x: 30 + (count % 5) * 108,
        y: 30 + Math.floor(count / 5) * 78,
        value: 0,
      };
      this._write({ ...c, nodes: [...c.nodes, node] });
    }

    _remove(nodeId) {
      const c = this.circuit;
      this._write({
        nodes: c.nodes.filter(n => n.id !== nodeId),
        wires: c.wires.filter(w => w.from !== nodeId && w.to.node !== nodeId),
      });
    }

    _toggleInput(nodeId) {
      const c = this.circuit;
      this._write({
        ...c,
        nodes: c.nodes.map(n => n.id === nodeId ? { ...n, value: n.value ? 0 : 1 } : n),
      });
    }

    _connect(fromNode, toNode, toPort) {
      if (fromNode === toNode) return;
      const c = this.circuit;
      // One wire per input pin: a pin driven twice has no defined value, so
      // the newer connection replaces the older one instead of both showing.
      const wires = c.wires.filter(w => !(w.to.node === toNode && w.to.port === toPort));
      wires.push({ id: uid('w'), from: fromNode, to: { node: toNode, port: toPort } });
      this._write({ ...c, wires });
    }

    _cancelPending() {
      if (!this.pending) return;
      this.pending = null;
      this.ghost.removeAttribute('d');
    }

    /* ---- pointer ------------------------------------------------------- */

    /**
     * Screen pixels → circuit coordinates.
     *
     * Two transforms sit between them: the board's own zoom/pan, and the
     * viewBox scaling that fits the circuit into whatever size the element
     * has been dragged to. getScreenCTM composes both, so this stays
     * correct at any zoom — reading the bounding rect and dividing by the
     * board scale gets the first one and silently ignores the second.
     */
    _point(e) {
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      return { x: pt.x, y: pt.y };
    }

    _onDown(e) {
      e.stopPropagation();
      const target = e.target.closest('[data-lab]');
      if (!target) { this._cancelPending(); return; }

      const kind = target.dataset.lab;
      const nodeId = target.dataset.node;

      if (kind === 'wire') {
        const c = this.circuit;
        this._write({ ...c, wires: c.wires.filter(w => w.id !== target.dataset.wire) });
        return;
      }
      if (kind === 'kill') { this._remove(nodeId); return; }
      if (kind === 'switch') { this._toggleInput(nodeId); return; }

      if (kind === 'out-pin') {
        this.pending = { from: nodeId, at: this._point(e) };
        return;
      }
      if (kind === 'in-pin') {
        if (this.pending) {
          this._connect(this.pending.from, nodeId, +target.dataset.port);
          this._cancelPending();
        }
        return;
      }
      if (kind === 'body') {
        const node = this.circuit.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const p = this._point(e);
        this.dragging = { id: nodeId, dx: p.x - node.x, dy: p.y - node.y, moved: false };
        this.svg.setPointerCapture?.(e.pointerId);
      }
    }

    _onMove(e) {
      if (this.pending) {
        const p = this._point(e);
        const a = this._pinPoint(this.pending.from, 'out');
        if (a) this.ghost.setAttribute('d', wirePath(a, p));
        return;
      }
      if (!this.dragging) return;

      const p = this._point(e);
      const c = this.circuit;
      const x = Math.max(4, Math.round(p.x - this.dragging.dx));
      const y = Math.max(4, Math.round(p.y - this.dragging.dy));
      this.dragging.moved = true;
      // Written straight through so wires follow the gate as it moves.
      this.store.updateElement(this.id, {
        circuit: { ...c, nodes: c.nodes.map(n => n.id === this.dragging.id ? { ...n, x, y } : n) },
      }, { silent: true });
      this._paint();
    }

    _onUp(e) {
      if (this.dragging) {
        this.svg.releasePointerCapture?.(e.pointerId);
        // Commit once, so a drag is one undo step rather than sixty.
        if (this.dragging.moved) this._write(this.circuit);
        this.dragging = null;
      }
    }

    _pinPoint(nodeId, which, port = 0) {
      const n = this.circuit.nodes.find(x => x.id === nodeId);
      if (!n) return null;
      const p = pins(n);
      const pin = which === 'out' ? p.out : p.ins[port];
      return pin ? { x: n.x + pin.x, y: n.y + pin.y } : null;
    }

    /* ---- painting ------------------------------------------------------ */

    update() { this._paint(); }

    _paint() {
      const c = this.circuit;
      const { values, stable } = solve(c);
      this._values = values;

      this._paintWires(c, values);
      this._paintNodes(c, values);
      this._paintState(c, stable);
      this._paintTable();
      this._paintHint(c);
    }

    _paintState(c, stable) {
      const gates = c.nodes.filter(n => !GATES[n.kind] || GATES[n.kind].kind !== 'io').length;
      if (!c.nodes.length) {
        this.stateEl.textContent = '';
        this.stateEl.dataset.state = '';
      } else if (!stable) {
        this.stateEl.textContent = 'oscillating — a loop never settles';
        this.stateEl.dataset.state = 'bad';
      } else {
        this.stateEl.textContent = `${gates} gate${gates === 1 ? '' : 's'} · settled`;
        this.stateEl.dataset.state = 'ok';
      }
    }

    _paintHint(c) {
      if (!c.nodes.length) {
        this.hint.textContent = 'Add an Input, a gate and an Output above, then drag from the pin on the right of one to the pin on the left of the next.';
      } else if (!c.wires.length) {
        this.hint.textContent = 'Click the pin on a gate’s right edge, then the pin on another gate’s left edge, to wire them.';
      } else {
        this.hint.textContent = 'Click an input switch to flip it · click a wire to cut it · drag gates to arrange them.';
      }
    }

    _paintWires(c, values) {
      this.wireLayer.textContent = '';
      for (const w of c.wires) {
        const a = this._pinPoint(w.from, 'out');
        const b = this._pinPoint(w.to.node, 'in', w.to.port);
        if (!a || !b) continue;
        const on = (values.get(w.from) ?? 0) === 1;

        // A fat transparent line under the visible one: a 2px wire is
        // almost impossible to click, and cutting one is a normal edit.
        this.wireLayer.appendChild(svgEl('path', {
          d: wirePath(a, b), class: 'wb-lab-wire-hit',
          'data-lab': 'wire', 'data-wire': w.id,
        }));
        this.wireLayer.appendChild(svgEl('path', {
          d: wirePath(a, b), class: 'wb-lab-wire' + (on ? ' is-on' : ''),
        }));
      }
      this.ghost.removeAttribute('d');
    }

    _paintNodes(c, values) {
      this.nodeLayer.textContent = '';

      for (const n of c.nodes) {
        const spec = GATES[n.kind];
        if (!spec) continue;
        const v = values.get(n.id) ?? 0;

        const g = svgEl('g', { class: 'wb-lab-node', transform: `translate(${n.x},${n.y})` });

        if (n.kind === 'IN') {
          g.appendChild(svgEl('rect', {
            class: 'wb-lab-switch' + (v ? ' is-on' : ''), 'data-lab': 'switch', 'data-node': n.id,
            x: 0, y: 6, width: 46, height: GATE_H - 12, rx: 15,
          }));
          g.appendChild(svgEl('circle', {
            class: 'wb-lab-knob', cx: v ? 33 : 13, cy: GATE_H / 2, r: 9,
            'data-lab': 'switch', 'data-node': n.id,
          }));
          g.appendChild(text(v ? '1' : '0', v ? 14 : 34, GATE_H / 2 + 4, 'wb-lab-bit'));
        } else if (n.kind === 'OUT') {
          g.appendChild(svgEl('circle', {
            class: 'wb-lab-lamp' + (v ? ' is-on' : ''), cx: 22, cy: GATE_H / 2, r: 15,
            'data-lab': 'body', 'data-node': n.id,
          }));
          g.appendChild(text(String(v), 22, GATE_H / 2 + 5, 'wb-lab-lampbit' + (v ? ' is-on' : '')));
        } else {
          g.appendChild(svgEl('path', {
            class: 'wb-lab-gate' + (v ? ' is-on' : ''), d: gatePath(n.kind),
            'data-lab': 'body', 'data-node': n.id,
          }));
          if (/^(NAND|NOR|XNOR|NOT)$/.test(n.kind)) {
            g.appendChild(svgEl('circle', { class: 'wb-lab-bubble', cx: 46, cy: GATE_H / 2, r: 5 }));
          }
          g.appendChild(text(spec.label, 22, GATE_H / 2 + 4, 'wb-lab-glabel'));
        }

        // Pins
        const p = pins(n);
        p.ins.forEach((pin, i) => {
          g.appendChild(svgEl('circle', {
            class: 'wb-lab-pin is-in', cx: pin.x, cy: pin.y, r: PORT_R,
            'data-lab': 'in-pin', 'data-node': n.id, 'data-port': i,
          }));
        });
        if (p.out) {
          g.appendChild(svgEl('circle', {
            class: 'wb-lab-pin is-out' + (v ? ' is-on' : '') +
              (this.pending?.from === n.id ? ' is-arming' : ''),
            cx: p.out.x, cy: p.out.y, r: PORT_R,
            'data-lab': 'out-pin', 'data-node': n.id,
          }));
        }

        // Delete affordance, top-right of the gate.
        const kill = svgEl('g', { class: 'wb-lab-kill', 'data-lab': 'kill', 'data-node': n.id });
        kill.appendChild(svgEl('circle', { cx: GATE_W - 6, cy: -2, r: 7 }));
        kill.appendChild(text('×', GATE_W - 6, 2, 'wb-lab-killx'));
        g.appendChild(kill);

        this.nodeLayer.appendChild(g);
      }

      // Keep the drawing area at least as large as the circuit inside it.
      const maxX = Math.max(360, ...c.nodes.map(n => n.x + GATE_W + 40));
      const maxY = Math.max(200, ...c.nodes.map(n => n.y + GATE_H + 40));
      this.svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
      this.svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    }

    _paintTable() {
      this.tableWrap.textContent = '';
      this.tableWrap.classList.toggle('is-open', this.showTable);
      if (!this.showTable) return;

      const t = truthTable(this.circuit);
      if (!t) {
        this.tableWrap.appendChild(el('p', {
          class: 'wb-lab-note',
          text: 'A truth table needs at least one Input and one Output.',
        }));
        return;
      }
      if (t.tooWide) {
        this.tableWrap.appendChild(el('p', {
          class: 'wb-lab-note',
          text: `${t.count} inputs would be ${2 ** t.count} rows. Eight is the limit.`,
        }));
        return;
      }

      const name = (n, i, p) => n.label || `${p}${i + 1}`;
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          ...t.ins.map((n, i) => el('th', { text: name(n, i, 'IN ') })),
          ...t.outs.map((n, i) => el('th', { class: 'is-out', text: name(n, i, 'OUT ') })),
        ])]),
        el('tbody', {}, t.rows.map(r => el('tr', {}, [
          ...r.in.map(v => el('td', { text: String(v) })),
          ...r.out.map(v => el('td', { class: 'is-out' + (v ? ' is-on' : ''), text: String(v) })),
        ]))),
      ]);
      this.tableWrap.appendChild(table);
    }

    destroy() { this.dragging = null; this.pending = null; }
  }

  /* ---- drawing helpers ------------------------------------------------- */

  function text(str, x, y, cls) {
    const t = svgEl('text', { x, y, class: cls, 'text-anchor': 'middle' });
    t.textContent = str;
    return t;
  }

  /**
   * A cubic with horizontal tangents at both ends: wires leave a pin
   * sideways and arrive sideways, which is what makes a dense circuit
   * readable rather than a bundle of diagonals.
   */
  function wirePath(a, b) {
    const dx = Math.max(28, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  /** IEEE distinctive shapes — the ones on every logic diagram. */
  function gatePath(kind) {
    const H = GATE_H;
    switch (kind) {
      case 'NOT':
        return `M4,2 L40,${H / 2} L4,${H - 2} Z`;
      case 'OR': case 'NOR':
        return `M2,2 Q22,2 42,${H / 2} Q22,${H - 2} 2,${H - 2} Q14,${H / 2} 2,2 Z`;
      case 'XOR': case 'XNOR':
        return `M6,2 Q26,2 46,${H / 2} Q26,${H - 2} 6,${H - 2} Q18,${H / 2} 6,2 Z` +
               `M-2,2 Q10,${H / 2} -2,${H - 2}`;
      default:  // AND, NAND
        return `M4,2 H22 A${(H - 4) / 2},${(H - 4) / 2} 0 0 1 22,${H - 2} H4 Z`;
    }
  }

  /* ---- a circuit worth opening with ------------------------------------ */

  /**
   * A half adder. Two inputs, XOR for the sum, AND for the carry — small
   * enough to read at a glance and the standard first thing anyone builds,
   * so the block explains itself the moment it lands on the board.
   */
  LogicLab.starterCircuit = function () {
    const A = uid('n'), B = uid('n'), X = uid('n'), N = uid('n'), S = uid('n'), C = uid('n');
    return {
      nodes: [
        { id: A, kind: 'IN',  x: 24,  y: 40,  label: 'A', value: 1 },
        { id: B, kind: 'IN',  x: 24,  y: 130, label: 'B', value: 0 },
        { id: X, kind: 'XOR', x: 170, y: 52 },
        { id: N, kind: 'AND', x: 170, y: 140 },
        { id: S, kind: 'OUT', x: 300, y: 52,  label: 'Sum' },
        { id: C, kind: 'OUT', x: 300, y: 140, label: 'Carry' },
      ],
      wires: [
        { id: uid('w'), from: A, to: { node: X, port: 0 } },
        { id: uid('w'), from: B, to: { node: X, port: 1 } },
        { id: uid('w'), from: A, to: { node: N, port: 0 } },
        { id: uid('w'), from: B, to: { node: N, port: 1 } },
        { id: uid('w'), from: X, to: { node: S, port: 0 } },
        { id: uid('w'), from: N, to: { node: C, port: 0 } },
      ],
    };
  };

  LogicLab.solve = solve;
  LogicLab.truthTable = truthTable;
  global.LogicLab = LogicLab;

  /* ---- renderer hook ---------------------------------------------------- */

  function install() {
    const proto = global.Renderer?.prototype;
    if (!proto || proto._logicLab) return;
    proto._logicLab = function (element, node) {
      const lab = new LogicLab(this.app, element, node);
      node.__live = {
        type: 'logic-lab',
        update: e => lab.update(e),
        destroy: () => lab.destroy(),
      };
    };
  }

  if (global.Renderer) install();
  else global.addEventListener('DOMContentLoaded', install, { once: true });
})(window);
