/* ================================================================
   templates.js — the template library
   ================================================================
   Templates used to live inline in extras.js, where two keys ("kanban"
   and "swot") were declared twice — the first definition of each was
   silently discarded by the object literal. They now live here, keyed
   uniquely, tagged with a category and a one-line description so the
   gallery can filter and search them.

   A template's build(app) returns the elements it created. Every
   element is added with { silent: true } because applyTemplate() wraps
   the whole build in a single transaction (one undo step).
   ================================================================ */

/* ---- tiny builders so every template reads like a layout, not code -- */
const T = {
  el(app, type, props) { return app.store.addElement(type, props, { silent: true }); },

  frame(app, x, y, w, h, title, bg) {
    return T.el(app, 'frame', { x, y, width: w, height: h, content: title, style: { backgroundColor: bg } });
  },

  sticky(app, x, y, w, h, text, bg) {
    return T.el(app, 'sticky-note', {
      x, y, width: w, height: h, content: text,
      style: { backgroundColor: bg || app.settings.stickyColor, fontSize: 14 },
    });
  },

  text(app, x, y, w, text, size = 18, style = {}) {
    return T.el(app, 'text', {
      x, y, width: w, height: Math.round(size * 1.6) + 10, content: text,
      style: { fontSize: size, ...style },
    });
  },

  shape(app, x, y, w, h, shapeType, style, content = '') {
    return T.el(app, 'shape', { x, y, width: w, height: h, shapeType, content, style });
  },

  fc(app, x, y, w, h, fcType, content, style = {}) {
    return T.el(app, 'flowchart', {
      x, y, width: w, height: h, fcType, content,
      style: { backgroundColor: '#ffffff', borderColor: '#16161d', borderWidth: 2, fontSize: 13, ...style },
    });
  },

  check(app, x, y, w, h, title, items) {
    return T.el(app, 'checklist', {
      x, y, width: w, height: h, content: title,
      items: items.map(t => (typeof t === 'string' ? { text: t, done: false } : t)),
    });
  },

  table(app, x, y, w, cells) {
    return T.el(app, 'table', {
      x, y, width: w, height: Math.max(80, cells.length * 40 + 34),
      tableData: { rows: cells.length, cols: cells[0].length, cells },
    });
  },

  link(app, a, b, ap = 'bottom', bp = 'top', label = '', style = {}) {
    return app.store.addConnection({
      from: { id: a.id, port: ap }, to: { id: b.id, port: bp },
      routing: 'orthogonal', arrowEnd: true, label,
      style: { color: '#5a6274', width: 2, ...style },
    }, { silent: true });
  },

  /** A titled column of frame + heading, used by every board-style template. */
  column(app, out, i, title, color, { w = 280, h = 540, gap = 24, y = 0 } = {}) {
    const x = i * (w + gap);
    out.push(T.frame(app, x, y, w, h, title, color));
    return { x, y, w, h };
  },
};

const TEMPLATE_CATEGORIES = [
  ['all', 'All templates'],
  ['start', 'Get started'],
  ['agile', 'Agile & delivery'],
  ['strategy', 'Strategy'],
  ['diagram', 'Diagrams'],
  ['algo', 'Algorithms'],
  ['plan', 'Planning'],
  ['design', 'Design & research'],
  ['data', 'Data'],
  ['study', 'Study & notes'],
];

const TEMPLATES = {

  /* ============================ START ============================ */

  blank: {
    name: 'Blank board', icon: '<i class="ph ph-file-dashed"></i>', cat: 'start',
    desc: 'A clean infinite canvas.',
    build: () => [],
  },

  brainstorm: {
    name: 'Brainstorm mind map', icon: '<i class="ph ph-brain"></i>', cat: 'start',
    desc: 'Central idea with five starter branches.',
    build(app) {
      const root = app.mindmap.createRoot(0, 0, 'Central idea');
      for (const t of ['Why', 'What', 'How', 'Who', 'Risks']) app.mindmap.addChild(root.id, t, { focus: false });
      app.mindmap.layout(root.id);
      return [];
    },
  },

  sticky_wall: {
    name: 'Sticky wall', icon: '<i class="ph ph-squares-four"></i>', cat: 'start',
    desc: 'A 5×4 grid of empty notes to fill fast.',
    build(app) {
      const out = [];
      const colors = app.theme.stickyColors;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 5; c++) {
          out.push(T.sticky(app, c * 200, r * 200, 180, 180, '', colors[(r + c) % colors.length]));
        }
      }
      return out;
    },
  },

  daily_standup: {
    name: 'Daily stand-up', icon: '<i class="ph ph-sun-horizon"></i>', cat: 'agile',
    desc: 'Yesterday / today / blockers, per person.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -70, 620, 'Daily stand-up — ' + new Date().toLocaleDateString(), 28, { bold: true }));
      ['Yesterday', 'Today', 'Blockers'].forEach((t, i) => {
        const c = T.column(app, out, i, t, i === 2 ? '#ffe0e0' : '#eef1f6', { w: 300, h: 460 });
        out.push(T.sticky(app, c.x + 18, 60, 264, 110, '', app.theme.stickyColors[i]));
      });
      return out;
    },
  },

  /* ============================ AGILE ============================ */

  kanban: {
    name: 'Kanban board', icon: '<i class="ph ph-kanban"></i>', cat: 'agile',
    desc: 'Backlog → In progress → Review → Done with WIP hints.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -74, 520, 'Project board', 30, { bold: true }));
      const cols = [
        ['Backlog', '#eef1f6'], ['In progress  (WIP 3)', '#dbe8ff'],
        ['Review  (WIP 2)', '#fff0cf'], ['Done', '#d7f5e3'],
      ];
      cols.forEach(([title, color], i) => T.column(app, out, i, title, color, { w: 290, h: 620 }));
      const card = (col, row, text, color) =>
        out.push(T.sticky(app, col * 314 + 16, 56 + row * 128, 258, 112, text, color));
      const p = app.theme.stickyColors;
      card(0, 0, 'Write API documentation', p[0]);
      card(0, 1, 'Design the empty state', p[0]);
      card(1, 0, 'Implement sign-in flow', p[5]);
      card(2, 0, 'Review pagination PR', p[1]);
      card(3, 0, 'Set up CI pipeline', p[7]);
      return out;
    },
  },

  retro: {
    name: 'Sprint retro', icon: '<i class="ph ph-arrows-clockwise"></i>', cat: 'agile',
    desc: 'Went well / went badly / ideas / actions.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -74, 520, 'Sprint retrospective', 30, { bold: true }));
      [['😀 Went well', '#d7f5e3'], ['😕 Went badly', '#ffe0e0'],
       ['💡 Ideas', '#dbe8ff'], ['✅ Actions', '#fff0cf']]
        .forEach(([t, c], i) => T.column(app, out, i, t, c, { w: 300, h: 480 }));
      return out;
    },
  },

  retro_sailboat: {
    name: 'Sailboat retro', icon: '<i class="ph ph-sailboat"></i>', cat: 'agile',
    desc: 'Wind, anchors, rocks and the island you are sailing to.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -70, 700, 'Sailboat retrospective', 28, { bold: true }));
      out.push(T.frame(app, 0, 0, 340, 300, '💨 Wind — what pushed us forward', '#dbe8ff'));
      out.push(T.frame(app, 364, 0, 340, 300, '⚓ Anchors — what held us back', '#ffe0e0'));
      out.push(T.frame(app, 0, 324, 340, 300, '🪨 Rocks — risks ahead', '#fff0cf'));
      out.push(T.frame(app, 364, 324, 340, 300, '🏝 Island — the goal', '#d7f5e3'));
      return out;
    },
  },

  sprint_planning: {
    name: 'Sprint planning', icon: '<i class="ph ph-calendar-check"></i>', cat: 'agile',
    desc: 'Goal, capacity, candidate stories and commitment.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -70, 640, 'Sprint planning', 30, { bold: true }));
      out.push(T.sticky(app, 0, 0, 320, 150, 'Sprint goal:\n\n', app.theme.stickyColors[0]));
      out.push(T.check(app, 344, 0, 300, 220, 'Capacity', ['Team days available', 'Holidays / PTO', 'Support rota', 'Carry-over work']));
      out.push(T.frame(app, 0, 250, 320, 420, 'Candidates', '#eef1f6'));
      out.push(T.frame(app, 344, 250, 320, 420, 'Committed', '#d7f5e3'));
      out.push(T.table(app, 690, 0, 480, [
        ['Story', 'Points', 'Owner'], ['', '', ''], ['', '', ''], ['', '', ''],
      ]));
      return out;
    },
  },

  story_map: {
    name: 'User story map', icon: '<i class="ph ph-map-trifold"></i>', cat: 'agile',
    desc: 'Activities across the top, releases down the side.',
    build(app) {
      const out = [];
      const acts = ['Discover', 'Sign up', 'Configure', 'Use daily', 'Share'];
      out.push(T.text(app, 0, -74, 640, 'Story map', 30, { bold: true }));
      acts.forEach((a, i) => out.push(T.text(app, 200 + i * 220, -20, 200, a, 17, { bold: true, align: 'center' })));
      ['Release 1', 'Release 2', 'Later'].forEach((r, row) => {
        out.push(T.text(app, 0, row * 190 + 30, 180, r, 16, { bold: true, align: 'right' }));
        out.push(T.frame(app, 196, row * 190, acts.length * 220 - 20, 170, '', row === 0 ? '#d7f5e3' : row === 1 ? '#dbe8ff' : '#eef1f6'));
      });
      return out;
    },
  },

  /* ============================ STRATEGY ============================ */

  swot: {
    name: 'SWOT analysis', icon: '<i class="ph ph-target"></i>', cat: 'strategy',
    desc: 'Strengths, weaknesses, opportunities, threats.',
    build(app) {
      const out = [];
      const cells = [
        ['Strengths', '#d7f5e3', '#22c55e', 0, 0], ['Weaknesses', '#ffe0e0', '#f43f5e', 1, 0],
        ['Opportunities', '#dbe8ff', '#3b82f6', 0, 1], ['Threats', '#fff0cf', '#f59e0b', 1, 1],
      ];
      const W = 360, H = 300, GAP = 24;
      for (const [title, bg, border, cx, cy] of cells) {
        const x = cx * (W + GAP), y = cy * (H + GAP);
        out.push(T.shape(app, x, y, W, H, 'rounded', { backgroundColor: bg, borderColor: border, borderWidth: 3 }));
        out.push(T.text(app, x + 20, y + 16, W - 40, title, 22, { bold: true, color: border }));
      }
      return out;
    },
  },

  business_model: {
    name: 'Business Model Canvas', icon: '<i class="ph ph-briefcase"></i>', cat: 'strategy',
    desc: 'The classic nine-block Osterwalder canvas.',
    build(app) {
      const out = [];
      const W = 230, H = 220, G = 10;
      const put = (title, col, row, colSpan = 1, rowSpan = 1, bg = '#eef1f6') =>
        out.push(T.frame(app, col * (W + G), row * (H + G),
          W * colSpan + G * (colSpan - 1), H * rowSpan + G * (rowSpan - 1), title, bg));
      put('Key partners', 0, 0, 1, 2, '#e8eaf6');
      put('Key activities', 1, 0, 1, 1, '#e3f2fd');
      put('Key resources', 1, 1, 1, 1, '#e3f2fd');
      put('Value propositions', 2, 0, 1, 2, '#fff3e0');
      put('Customer relationships', 3, 0, 1, 1, '#f3e5f5');
      put('Channels', 3, 1, 1, 1, '#f3e5f5');
      put('Customer segments', 4, 0, 1, 2, '#e8f5e9');
      put('Cost structure', 0, 2, 2, 1, '#fbe9e7');
      put('Revenue streams', 2, 2, 3, 1, '#e0f2f1');
      return out;
    },
  },

  lean_canvas: {
    name: 'Lean Canvas', icon: '<i class="ph ph-rocket-launch"></i>', cat: 'strategy',
    desc: 'Problem-first canvas for a new product bet.',
    build(app) {
      const out = [];
      const W = 240, H = 230, G = 10;
      const put = (t, c, r, cs = 1, rs = 1, bg = '#eef1f6') =>
        out.push(T.frame(app, c * (W + G), r * (H + G), W * cs + G * (cs - 1), H * rs + G * (rs - 1), t, bg));
      put('Problem', 0, 0, 1, 2, '#ffe0e0');
      put('Solution', 1, 0, 1, 1, '#dbe8ff');
      put('Key metrics', 1, 1, 1, 1, '#dbe8ff');
      put('Unique value proposition', 2, 0, 1, 2, '#fff0cf');
      put('Unfair advantage', 3, 0, 1, 1, '#f3e5f5');
      put('Channels', 3, 1, 1, 1, '#f3e5f5');
      put('Customer segments', 4, 0, 1, 2, '#d7f5e3');
      put('Cost structure', 0, 2, 2, 1, '#eceff1');
      put('Revenue streams', 2, 2, 3, 1, '#e0f2f1');
      return out;
    },
  },

  eisenhower: {
    name: 'Eisenhower matrix', icon: '<i class="ph ph-crosshair"></i>', cat: 'plan',
    desc: 'Urgent × important, with the four verdicts.',
    build(app) {
      const out = [];
      const W = 340, H = 300, G = 16;
      const quads = [
        ['Do now\nUrgent + important', '#ffe0e0', 0, 0],
        ['Schedule\nImportant, not urgent', '#d7f5e3', 1, 0],
        ['Delegate\nUrgent, not important', '#fff0cf', 0, 1],
        ['Delete\nNeither', '#eef1f6', 1, 1],
      ];
      for (const [t, bg, cx, cy] of quads) out.push(T.frame(app, cx * (W + G), cy * (H + G), W, H, t.split('\n')[0], bg));
      out.push(T.text(app, 0, -52, W * 2 + G, 'Urgent  ⟶', 16, { bold: true, align: 'center' }));
      out.push(T.text(app, -190, H, 170, 'Important  ⟶', 16, { bold: true, align: 'right' }));
      return out;
    },
  },

  impact_effort: {
    name: 'Impact / effort matrix', icon: '<i class="ph ph-chart-scatter"></i>', cat: 'strategy',
    desc: 'Quick wins, big bets, fill-ins and time sinks.',
    build(app) {
      const out = [];
      const W = 340, H = 300, G = 14;
      [['Big bets', '#dbe8ff', 0, 0], ['Quick wins', '#d7f5e3', 1, 0],
       ['Time sinks', '#eef1f6', 0, 1], ['Fill-ins', '#fff0cf', 1, 1]]
        .forEach(([t, bg, cx, cy]) => out.push(T.frame(app, cx * (W + G), cy * (H + G), W, H, t, bg)));
      out.push(T.text(app, -180, 0, 160, 'High impact', 15, { bold: true, align: 'right' }));
      out.push(T.text(app, -180, H + G, 160, 'Low impact', 15, { bold: true, align: 'right' }));
      out.push(T.text(app, 0, H * 2 + G + 16, W, 'High effort', 15, { bold: true, align: 'center' }));
      out.push(T.text(app, W + G, H * 2 + G + 16, W, 'Low effort', 15, { bold: true, align: 'center' }));
      return out;
    },
  },

  okr: {
    name: 'OKR planner', icon: '<i class="ph ph-flag-banner"></i>', cat: 'plan',
    desc: 'One objective, measurable key results, tracked.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -70, 700, 'Objectives & key results', 30, { bold: true }));
      for (let i = 0; i < 2; i++) {
        const y = i * 320;
        out.push(T.sticky(app, 0, y, 320, 130, `Objective ${i + 1}:\n`, app.theme.stickyColors[i]));
        out.push(T.table(app, 350, y, 560, [
          ['Key result', 'Baseline', 'Target', 'Now'],
          ['', '', '', ''], ['', '', '', ''], ['', '', '', ''],
        ]));
      }
      return out;
    },
  },

  risk_matrix: {
    name: 'Risk matrix', icon: '<i class="ph ph-warning"></i>', cat: 'plan',
    desc: '3×3 likelihood × impact heat grid.',
    build(app) {
      const out = [];
      const heat = [['#d7f5e3', '#fff0cf', '#ffd9d9'], ['#fff0cf', '#ffd9d9', '#ffbdbd'], ['#ffd9d9', '#ffbdbd', '#ff9d9d']];
      const labels = ['Low', 'Medium', 'High'];
      const S = 210, G = 8;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          out.push(T.shape(app, c * (S + G), r * (S + G), S, S, 'rectangle',
            { backgroundColor: heat[r][c], borderColor: '#00000018', borderWidth: 1 }));
        }
        out.push(T.text(app, -160, r * (S + G) + S / 2 - 16, 140, labels[2 - r], 14, { bold: true, align: 'right' }));
        out.push(T.text(app, r * (S + G), 3 * (S + G) + 12, S, labels[r], 14, { bold: true, align: 'center' }));
      }
      out.push(T.text(app, -160, -50, 300, 'Likelihood ↑   Impact →', 15, { bold: true }));
      return out;
    },
  },

  raci: {
    name: 'RACI chart', icon: '<i class="ph ph-users-three"></i>', cat: 'plan',
    desc: 'Who is responsible, accountable, consulted, informed.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -66, 620, 'RACI matrix', 28, { bold: true }));
      out.push(T.table(app, 0, 0, 820, [
        ['Task / deliverable', 'Person A', 'Person B', 'Person C', 'Person D'],
        ['', 'R', 'A', 'C', 'I'], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''],
      ]));
      out.push(T.sticky(app, 848, 0, 240, 200,
        'R — Responsible\nA — Accountable\nC — Consulted\nI — Informed', app.theme.stickyColors[5]));
      return out;
    },
  },

  /* ============================ DIAGRAMS ============================ */

  flow: {
    name: 'Flowchart starter', icon: '<i class="ph ph-git-branch"></i>', cat: 'diagram',
    desc: 'Start, input, decision, error loop and end — all wired.',
    build(app) {
      const start = T.fc(app, 0, 0, 190, 58, 'startend', 'Start', { backgroundColor: '#e8f5e9', borderColor: '#2e7d32' });
      const input = T.fc(app, 0, 128, 190, 70, 'data', 'Read input', { backgroundColor: '#e3f2fd', borderColor: '#1565c0' });
      const check = T.fc(app, 0, 268, 190, 100, 'decision', 'Valid?', { backgroundColor: '#fff3e0', borderColor: '#ef6c00' });
      const ok = T.fc(app, 0, 438, 190, 70, 'process', 'Process data');
      const err = T.fc(app, 280, 268, 190, 70, 'process', 'Show error', { backgroundColor: '#ffebee', borderColor: '#c62828' });
      const end = T.fc(app, 0, 578, 190, 58, 'startend', 'End', { backgroundColor: '#eceff1', borderColor: '#37474f' });
      T.link(app, start, input);
      T.link(app, input, check);
      T.link(app, check, ok, 'bottom', 'top', 'Yes');
      T.link(app, check, err, 'right', 'left', 'No');
      T.link(app, err, input, 'top', 'right');
      T.link(app, ok, end);
      return [start, input, check, ok, err, end];
    },
  },

  arch_diagram: {
    name: 'System architecture', icon: '<i class="ph ph-hard-drives"></i>', cat: 'diagram',
    desc: 'Client, gateway, services, cache and database.',
    build(app) {
      const mk = (t, x, y, bg, border) =>
        T.shape(app, x, y, 210, 110, 'rounded', { backgroundColor: bg, borderColor: border, borderWidth: 2, fontSize: 15, bold: true }, t);
      const client = mk('Web / mobile client', 0, 160, '#e3f2fd', '#1565c0');
      const gw = mk('API gateway', 290, 160, '#f3e5f5', '#6a1b9a');
      const auth = mk('Auth service', 580, 20, '#fff3e0', '#ef6c00');
      const core = mk('Core service', 580, 160, '#e8f5e9', '#2e7d32');
      const cache = mk('Redis cache', 580, 300, '#ffebee', '#c62828');
      const db = mk('PostgreSQL', 870, 160, '#eceff1', '#37474f');
      T.link(app, client, gw, 'right', 'left', 'HTTPS');
      T.link(app, gw, auth, 'right', 'left', 'JWT');
      T.link(app, gw, core, 'right', 'left', 'REST');
      T.link(app, core, cache, 'bottom', 'top', 'get/set');
      T.link(app, core, db, 'right', 'left', 'SQL');
      return [client, gw, auth, core, cache, db];
    },
  },

  erd: {
    name: 'Entity relationship', icon: '<i class="ph ph-database"></i>', cat: 'diagram',
    desc: 'Three tables with keys and cardinality labels.',
    build(app) {
      const t = (x, y, title, rows) => T.table(app, x, y, 260, [[title, 'type'], ...rows]);
      const users = t(0, 0, 'users', [['id  (PK)', 'uuid'], ['email', 'text'], ['created_at', 'timestamp']]);
      const orders = t(360, 0, 'orders', [['id  (PK)', 'uuid'], ['user_id  (FK)', 'uuid'], ['total', 'numeric']]);
      const items = t(720, 0, 'order_items', [['id  (PK)', 'uuid'], ['order_id  (FK)', 'uuid'], ['sku', 'text']]);
      T.link(app, users, orders, 'right', 'left', '1 — ∞');
      T.link(app, orders, items, 'right', 'left', '1 — ∞');
      return [users, orders, items];
    },
  },

  org_chart: {
    name: 'Org chart', icon: '<i class="ph ph-tree-structure"></i>', cat: 'diagram',
    desc: 'A three-level reporting tree, auto-wired.',
    build(app) {
      const box = (x, y, name, role, bg) =>
        T.shape(app, x, y, 200, 84, 'rounded', { backgroundColor: bg, borderColor: '#00000022', borderWidth: 2, fontSize: 14, bold: true }, `${name}\n${role}`);
      const ceo = box(340, 0, 'Name', 'CEO', '#dbe8ff');
      const leads = ['Engineering', 'Product', 'Operations'].map((r, i) => box(i * 240, 190, 'Name', r + ' lead', '#d7f5e3'));
      const out = [ceo, ...leads];
      leads.forEach(l => T.link(app, ceo, l, 'bottom', 'top'));
      leads.forEach((l, i) => {
        for (let k = 0; k < 2; k++) {
          const n = box(i * 240 + (k ? 20 : -20), 380 + k * 110, 'Name', 'Team member', '#eef1f6');
          out.push(n);
          T.link(app, l, n, 'bottom', 'top');
        }
      });
      return out;
    },
  },

  fishbone: {
    name: 'Fishbone (Ishikawa)', icon: '<i class="ph ph-fish"></i>', cat: 'diagram',
    desc: 'Six-bone cause-and-effect analysis.',
    build(app) {
      const out = [];
      const spine = T.shape(app, 0, 290, 900, 20, 'rectangle', { backgroundColor: '#16161d', borderWidth: 0 });
      out.push(spine);
      const effect = T.shape(app, 920, 240, 220, 120, 'rounded', { backgroundColor: '#ffe0e0', borderColor: '#c62828', borderWidth: 3, fontSize: 16, bold: true }, 'Problem statement');
      out.push(effect);
      const bones = ['People', 'Process', 'Tools', 'Materials', 'Environment', 'Measurement'];
      bones.forEach((b, i) => {
        const top = i < 3;
        const x = 90 + (i % 3) * 280;
        const y = top ? 80 : 420;
        const node = T.shape(app, x, y, 200, 70, 'rounded', { backgroundColor: top ? '#dbe8ff' : '#fff0cf', borderColor: '#00000022', borderWidth: 2, fontSize: 15, bold: true }, b);
        out.push(node);
        app.store.addConnection({
          from: { id: node.id, port: top ? 'bottom' : 'top' },
          to: { id: spine.id, port: top ? 'top' : 'bottom' },
          routing: 'straight', arrowEnd: true, style: { color: '#5a6274', width: 2 },
        }, { silent: true });
      });
      return out;
    },
  },

  decision_tree: {
    name: 'Decision tree', icon: '<i class="ph ph-tree-view"></i>', cat: 'diagram',
    desc: 'Two levels of yes/no branching with outcomes.',
    build(app) {
      const q = (x, y, t) => T.fc(app, x, y, 200, 96, 'decision', t, { backgroundColor: '#fff3e0', borderColor: '#ef6c00' });
      const o = (x, y, t, bg) => T.fc(app, x, y, 190, 62, 'startend', t, { backgroundColor: bg, borderColor: '#00000033' });
      const root = q(330, 0, 'First question?');
      const yes = q(80, 200, 'Follow-up A?');
      const no = q(580, 200, 'Follow-up B?');
      const outs = [o(0, 400, 'Outcome 1', '#d7f5e3'), o(210, 400, 'Outcome 2', '#dbe8ff'),
                    o(500, 400, 'Outcome 3', '#fff0cf'), o(710, 400, 'Outcome 4', '#ffe0e0')];
      T.link(app, root, yes, 'left', 'top', 'Yes');
      T.link(app, root, no, 'right', 'top', 'No');
      T.link(app, yes, outs[0], 'bottom', 'top', 'Yes');
      T.link(app, yes, outs[1], 'bottom', 'top', 'No');
      T.link(app, no, outs[2], 'bottom', 'top', 'Yes');
      T.link(app, no, outs[3], 'bottom', 'top', 'No');
      return [root, yes, no, ...outs];
    },
  },

  swimlane: {
    name: 'Swimlane process', icon: '<i class="ph ph-rows"></i>', cat: 'diagram',
    desc: 'Three lanes with a handoff already drawn.',
    build(app) {
      const out = [];
      const lanes = [['Customer', '#e3f2fd'], ['Support', '#fff3e0'], ['Engineering', '#e8f5e9']];
      lanes.forEach(([n, c], i) => {
        out.push(T.frame(app, 0, i * 220, 1100, 200, n, c));
      });
      const a = T.fc(app, 60, 40, 180, 64, 'startend', 'Reports issue', { backgroundColor: '#ffffff' });
      const b = T.fc(app, 340, 260, 180, 64, 'process', 'Triage ticket');
      const c = T.fc(app, 640, 480, 180, 64, 'process', 'Ship fix');
      T.link(app, a, b, 'right', 'top');
      T.link(app, b, c, 'right', 'top');
      out.push(a, b, c);
      return out;
    },
  },

  /* ============================ ALGORITHMS ============================ */

  algorithm: {
    name: 'Binary search', icon: '<i class="ph ph-magnifying-glass"></i>', cat: 'algo',
    desc: 'Annotated pseudocode block, ready to convert to a flowchart.',
    build(app) {
      return [app.algorithm.create(0, 0, {
        title: 'Binary search  ·  O(log n)',
        code: `def binary_search(a, target):
  lo = 0
  hi = len(a) - 1
  while lo <= hi:
    mid = (lo + hi) // 2
    if a[mid] == target:
      return mid
    if a[mid] < target:
      lo = mid + 1
    else:
      hi = mid - 1
  return -1`,
      })];
    },
  },

  algorithm_bfs: {
    name: 'Breadth-first search', icon: '<i class="ph ph-graph"></i>', cat: 'algo',
    desc: 'Queue-based graph traversal.',
    build(app) {
      return [app.algorithm.create(0, 0, {
        title: 'BFS  ·  O(V + E)',
        code: `def bfs(graph, start):
  visited = set([start])
  queue = [start]
  while queue:
    vertex = queue.pop(0)
    print(vertex)
    for neighbor in graph[vertex]:
      if neighbor not in visited:
        visited.add(neighbor)
        queue.append(neighbor)
  return visited`,
      })];
    },
  },

  algorithm_dijkstra: {
    name: 'Dijkstra shortest path', icon: '<i class="ph ph-path"></i>', cat: 'algo',
    desc: 'Priority-queue relaxation with a distance table.',
    build(app) {
      const el = app.algorithm.create(0, 0, {
        title: 'Dijkstra  ·  O(E log V)',
        code: `def dijkstra(graph, source):
  dist = {v: INFINITY for v in graph}
  dist[source] = 0
  pq = [(0, source)]
  while pq:
    d, u = heappop(pq)
    if d > dist[u]:
      continue
    for v, w in graph[u]:
      if d + w < dist[v]:
        dist[v] = d + w
        heappush(pq, (dist[v], v))
  return dist`,
      });
      const t = T.table(app, el.width + 60, 0, 400, [
        ['Node', 'Distance', 'Previous'], ['A', '0', '—'], ['B', '∞', ''], ['C', '∞', ''],
      ]);
      return [el, t];
    },
  },

  algorithm_dp: {
    name: 'Dynamic programming', icon: '<i class="ph ph-grid-nine"></i>', cat: 'algo',
    desc: 'Knapsack with the DP table beside it.',
    build(app) {
      const el = app.algorithm.create(0, 0, {
        title: '0/1 Knapsack  ·  O(nW)',
        code: `def knapsack(weights, values, W):
  n = len(weights)
  dp = [[0] * (W + 1) for _ in range(n + 1)]
  for i = 1 to n:
    for w = 0 to W:
      dp[i][w] = dp[i-1][w]
      if weights[i-1] <= w:
        take = values[i-1] + dp[i-1][w - weights[i-1]]
        dp[i][w] = max(dp[i][w], take)
  return dp[n][W]`,
      });
      const t = T.table(app, el.width + 60, 0, 460, [
        ['i \\ w', '0', '1', '2', '3'], ['0', '0', '0', '0', '0'],
        ['1', '0', '', '', ''], ['2', '0', '', '', ''],
      ]);
      return [el, t];
    },
  },

  complexity_cheatsheet: {
    name: 'Complexity cheat sheet', icon: '<i class="ph ph-chart-line-up"></i>', cat: 'algo',
    desc: 'Big-O table plus a growth chart.',
    build(app) {
      const t = T.table(app, 0, 0, 620, [
        ['Algorithm', 'Best', 'Average', 'Worst', 'Space'],
        ['Quick sort', 'n log n', 'n log n', 'n²', 'log n'],
        ['Merge sort', 'n log n', 'n log n', 'n log n', 'n'],
        ['Heap sort', 'n log n', 'n log n', 'n log n', '1'],
        ['Binary search', '1', 'log n', 'log n', '1'],
        ['Hash lookup', '1', '1', 'n', 'n'],
      ]);
      const chart = app.charts.create(660, 0, 'line');
      app.store.updateElement(chart.id, {
        graphTitle: 'Operations at n = 1000',
        graphData: [
          { label: 'log n', value: 10 }, { label: 'n', value: 1000 },
          { label: 'n log n', value: 10000 }, { label: 'n²', value: 1000000 },
        ],
      }, { silent: true });
      return [t, chart];
    },
  },

  /* ============================ DESIGN / RESEARCH ============================ */

  user_journey: {
    name: 'User journey map', icon: '<i class="ph ph-path"></i>', cat: 'design',
    desc: 'Five stages × four research rows.',
    build(app) {
      const cols = ['Awareness', 'Consideration', 'Acquisition', 'Service', 'Loyalty'];
      const rows = ['Actions', 'Touchpoints', 'Emotions', 'Pain points'];
      const W = 220, H = 140, GAP = 16, ROW_H = 160;
      const out = [];
      cols.forEach((c, i) => out.push(T.text(app, 200 + i * (W + GAP), -62, W, c, 19, { bold: true, align: 'center' })));
      rows.forEach((r, i) => out.push(T.text(app, 0, i * ROW_H + 44, 180, r, 17, { bold: true, align: 'right' })));
      const p = app.theme.stickyColors;
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < cols.length; c++) {
          out.push(T.sticky(app, 200 + c * (W + GAP), r * ROW_H, W, H, '', p[r % p.length]));
        }
      }
      return out;
    },
  },

  empathy_map: {
    name: 'Empathy map', icon: '<i class="ph ph-heart"></i>', cat: 'design',
    desc: 'Says / thinks / does / feels around a persona.',
    build(app) {
      const out = [];
      const W = 320, H = 260, G = 14;
      [['Says 💬', '#dbe8ff', 0, 0], ['Thinks 💭', '#e8f5e9', 1, 0],
       ['Does 🏃', '#fff0cf', 0, 1], ['Feels ❤️', '#ffe0e0', 1, 1]]
        .forEach(([t, bg, cx, cy]) => out.push(T.frame(app, cx * (W + G), cy * (H + G), W, H, t, bg)));
      out.push(T.shape(app, W - 60 + G / 2, H - 50 + G / 2, 130, 110, 'circle',
        { backgroundColor: '#ffffff', borderColor: '#4262ff', borderWidth: 3, fontSize: 14, bold: true }, 'Persona'));
      return out;
    },
  },

  five_whys: {
    name: '5 Whys', icon: '<i class="ph ph-question"></i>', cat: 'design',
    desc: 'Drill from symptom to root cause in five steps.',
    build(app) {
      const out = [];
      const p = T.sticky(app, 0, 0, 300, 130, 'Problem:\n', '#ffe0e0');
      out.push(p);
      let prev = p;
      for (let i = 1; i <= 5; i++) {
        const n = T.sticky(app, 0, i * 180, 300, 130, `Why ${i}?\n`, app.theme.stickyColors[(i + 4) % app.theme.stickyColors.length]);
        T.link(app, prev, n);
        out.push(n);
        prev = n;
      }
      const root = T.sticky(app, 0, 6 * 180, 300, 130, 'Root cause:\n', '#d7f5e3');
      T.link(app, prev, root);
      out.push(root);
      return out;
    },
  },

  moodboard: {
    name: 'Moodboard', icon: '<i class="ph ph-images"></i>', cat: 'design',
    desc: 'Frames for imagery, type, colour and tone of voice.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -70, 500, 'Moodboard', 30, { bold: true }));
      out.push(T.frame(app, 0, 0, 620, 420, 'Imagery — drop pictures here', '#f4f5f8'));
      out.push(T.frame(app, 644, 0, 300, 200, 'Type', '#eef1f6'));
      out.push(T.frame(app, 644, 220, 300, 200, 'Colour', '#eef1f6'));
      out.push(T.sticky(app, 0, 444, 620, 160, 'Tone of voice:\n', app.theme.stickyColors[4]));
      return out;
    },
  },

  /* ============================ PLANNING ============================ */

  roadmap: {
    name: 'Quarterly roadmap', icon: '<i class="ph ph-calendar-blank"></i>', cat: 'plan',
    desc: 'Four quarters × three swim rows.',
    build(app) {
      const out = [];
      const rows = ['Now', 'Next', 'Later'];
      const W = 280, H = 190, G = 14;
      out.push(T.text(app, 0, -74, 700, new Date().getFullYear() + ' roadmap', 30, { bold: true }));
      ['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, i) =>
        out.push(T.text(app, 180 + i * (W + G), -22, W, q, 18, { bold: true, align: 'center' })));
      rows.forEach((r, ri) => {
        out.push(T.text(app, 0, ri * (H + G) + H / 2 - 18, 160, r, 17, { bold: true, align: 'right' }));
        for (let i = 0; i < 4; i++) {
          out.push(T.frame(app, 180 + i * (W + G), ri * (H + G), W, H, '', ri === 0 ? '#d7f5e3' : ri === 1 ? '#dbe8ff' : '#eef1f6'));
        }
      });
      return out;
    },
  },

  gantt: {
    name: 'Gantt-style plan', icon: '<i class="ph ph-chart-bar-horizontal"></i>', cat: 'plan',
    desc: 'Task rows with draggable duration bars over a week grid.',
    build(app) {
      const out = [];
      const tasks = ['Discovery', 'Design', 'Build', 'Test', 'Launch'];
      const COL = 110, ROW = 62;
      out.push(T.text(app, 0, -70, 700, 'Delivery plan', 28, { bold: true }));
      for (let w = 0; w < 8; w++) {
        out.push(T.text(app, 220 + w * COL, -26, COL, 'W' + (w + 1), 13, { align: 'center', bold: true }));
        out.push(T.shape(app, 220 + w * COL, 0, COL, tasks.length * ROW, 'rectangle',
          { backgroundColor: w % 2 ? '#00000000' : '#00000008', borderColor: '#00000012', borderWidth: 1 }));
      }
      tasks.forEach((t, i) => {
        out.push(T.text(app, 0, i * ROW + 14, 200, t, 15, { bold: true, align: 'right' }));
        out.push(T.shape(app, 220 + i * COL, i * ROW + 10, COL * 2 - 12, ROW - 22, 'rounded',
          { backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length], borderWidth: 0, fontSize: 12, color: '#fff' }, t));
      });
      return out;
    },
  },

  weekly_planner: {
    name: 'Weekly planner', icon: '<i class="ph ph-calendar-dots"></i>', cat: 'plan',
    desc: 'Seven day columns plus a parking lot.',
    build(app) {
      const out = [];
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      days.forEach((d, i) => T.column(app, out, i, d, i > 4 ? '#eef1f6' : '#dbe8ff', { w: 210, h: 560, gap: 12 }));
      out.push(T.check(app, 0, 590, 300, 220, 'Parking lot', ['', '', '']));
      return out;
    },
  },

  meeting: {
    name: 'Meeting notes', icon: '<i class="ph ph-notebook"></i>', cat: 'study',
    desc: 'Agenda checklist plus an action table.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, 0, 520, 'Meeting — ' + new Date().toLocaleDateString(), 28, { bold: true }));
      out.push(T.check(app, 0, 80, 320, 220, 'Agenda',
        ['Review last actions', 'Status update', 'Decisions needed', 'Next steps']));
      out.push(T.table(app, 360, 80, 480, [
        ['Action', 'Owner', 'Due'], ['', '', ''], ['', '', ''], ['', '', ''],
      ]));
      out.push(T.sticky(app, 0, 330, 320, 180, 'Decisions:\n', app.theme.stickyColors[7]));
      return out;
    },
  },

  /* ============================ DATA / STUDY ============================ */

  dashboard: {
    name: 'Data dashboard', icon: '<i class="ph ph-chart-bar"></i>', cat: 'data',
    desc: 'Four live charts under a title.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -66, 460, 'Quarterly dashboard', 30, { bold: true }));
      ['bar', 'line', 'donut', 'hbar'].forEach((t, i) => {
        out.push(app.charts.create((i % 2) * 460, Math.floor(i / 2) * 340, t));
      });
      return out;
    },
  },

  compare: {
    name: 'Comparison table', icon: '<i class="ph ph-scales"></i>', cat: 'data',
    desc: 'Option scoring grid with a pros/cons pair.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -66, 620, 'Option comparison', 28, { bold: true }));
      out.push(T.table(app, 0, 0, 760, [
        ['Criterion', 'Option A', 'Option B', 'Option C'],
        ['Cost', '', '', ''], ['Effort', '', '', ''],
        ['Risk', '', '', ''], ['Score', '', '', ''],
      ]));
      out.push(T.check(app, 790, 0, 280, 200, '👍 Pros', ['', '', '']));
      out.push(T.check(app, 790, 220, 280, 200, '👎 Cons', ['', '', '']));
      return out;
    },
  },

  cornell: {
    name: 'Cornell notes', icon: '<i class="ph ph-note-pencil"></i>', cat: 'study',
    desc: 'Cue column, note area and a summary strip.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -62, 620, 'Topic', 26, { bold: true }));
      out.push(T.frame(app, 0, 0, 240, 520, 'Cues / questions', '#fff0cf'));
      out.push(T.frame(app, 260, 0, 620, 520, 'Notes', '#ffffff'));
      out.push(T.frame(app, 0, 540, 880, 180, 'Summary', '#dbe8ff'));
      return out;
    },
  },

  lesson_plan: {
    name: 'Lesson plan', icon: '<i class="ph ph-chalkboard-teacher"></i>', cat: 'study',
    desc: 'Objectives, timings, materials and assessment.',
    build(app) {
      const out = [];
      out.push(T.text(app, 0, -66, 700, 'Lesson plan', 28, { bold: true }));
      out.push(T.check(app, 0, 0, 320, 230, 'Learning objectives', ['', '', '']));
      out.push(T.check(app, 344, 0, 320, 230, 'Materials', ['', '', '']));
      out.push(T.table(app, 0, 254, 664, [
        ['Time', 'Activity', 'Grouping'],
        ['0–10', 'Warm-up', 'Whole class'], ['10–30', 'Main task', 'Pairs'], ['30–40', 'Plenary', 'Whole class'],
      ]));
      out.push(T.sticky(app, 690, 0, 300, 230, 'Assessment:\n', app.theme.stickyColors[6]));
      return out;
    },
  },

  study_map: {
    name: 'Revision mind map', icon: '<i class="ph ph-graduation-cap"></i>', cat: 'study',
    desc: 'Subject root with definition/example/practice branches.',
    build(app) {
      const root = app.mindmap.createRoot(0, 0, 'Subject');
      for (const t of ['Definitions', 'Key formulas', 'Worked examples', 'Common mistakes', 'Practice questions']) {
        app.mindmap.addChild(root.id, t, { focus: false });
      }
      app.mindmap.layout(root.id);
      return [];
    },
  },
};

window.TEMPLATES = TEMPLATES;
window.TEMPLATE_CATEGORIES = TEMPLATE_CATEGORIES;
window.T = T;
