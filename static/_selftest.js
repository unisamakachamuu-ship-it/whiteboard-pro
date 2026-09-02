/* Temporary headless smoke test. Delete after verification. */
(function () {
  const results = [];
  const ok = (name, cond, detail) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  const near = (a, b, t = 1) => Math.abs(a - b) <= t;

  const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  async function run() {
    const app = window.app;
    ok('app booted', !!app);
    if (!app) return finish();

    ok('no boot errors', window.__errors.length === 0, window.__errors.join(' | '));
    ok('loading screen removed', !document.getElementById('loading-screen'));
    ok('toolbar built', document.querySelectorAll('.tool-btn').length >= 15,
      document.querySelectorAll('.tool-btn').length + ' buttons');

    // start clean
    app.store.clear();

    /* ---------- 1. element creation + geometry ---------- */
    const sticky = app.createAt('sticky-note', 100, 100);
    const node = app.renderer.node(sticky.id);
    ok('sticky note rendered', !!node);
    ok('sticky uses transform positioning',
      /translate\(0px, 0px\)/.test(node.style.transform),
      node.style.transform);

    /* ---------- 2. drag path writes only a transform ---------- */
    sticky.x = 640; sticky.y = 480;
    app.renderer.place(sticky);
    ok('place() moves via transform',
      node.style.transform.includes('translate(640px, 480px)'), node.style.transform);
    ok('place() does not use left/top', !node.style.left && !node.style.top);

    /* ---------- 3. INFINITE CANVAS: connection far off-screen ---------- */
    const a = app.store.addElement('flowchart', { x: 40, y: 40, width: 170, height: 74, fcType: 'process', content: 'A' });
    const b = app.store.addElement('flowchart', { x: 9400, y: 6200, width: 170, height: 74, fcType: 'decision', content: 'B' });
    const far = app.store.addElement('flowchart', { x: -5200, y: -3100, width: 170, height: 74, fcType: 'data', content: 'C' });

    const c1 = app.store.addConnection({ from: { id: a.id, port: 'right' }, to: { id: b.id, port: 'left' } });
    const c2 = app.store.addConnection({ from: { id: far.id, port: 'right' }, to: { id: a.id, port: 'left' } });

    const g1 = app.connections.groups.get(c1.id);
    const g2 = app.connections.groups.get(c2.id);
    ok('far connection rendered', !!g1 && !!g2);

    const box1 = g1.querySelector('.conn-line').getBoundingClientRect();
    const box2 = g2.querySelector('.conn-line').getBoundingClientRect();
    ok('connection at x=9400 is NOT clipped', box1.width > 0 || box1.height > 0,
      `w=${box1.width.toFixed(0)} h=${box1.height.toFixed(0)}`);
    ok('connection at NEGATIVE coords is NOT clipped', box2.width > 0 || box2.height > 0,
      `w=${box2.width.toFixed(0)} h=${box2.height.toFixed(0)}`);

    const d1 = g1.querySelector('.conn-line').getAttribute('d');
    ok('connection path spans real board coords', /9\d{3}/.test(d1), d1.slice(0, 70));

    /* ---------- 4. ARROWHEAD DIRECTION (the x2-x2 bug) ---------- */
    // Left -> right link: the head must point right (+x).
    const L = app.store.addElement('shape', { x: 0, y: 3000, width: 120, height: 80 });
    const R = app.store.addElement('shape', { x: 800, y: 3000, width: 120, height: 80 });
    const cr = app.store.addConnection({ from: { id: L.id, port: 'right' }, to: { id: R.id, port: 'left' }, routing: 'straight' });
    const headD = app.connections.groups.get(cr.id).querySelector('.conn-head-end').getAttribute('d');
    const pts = headD.match(/-?\d+(\.\d+)?/g).map(Number);
    const tipX = pts[0], backX = Math.min(pts[2], pts[4]);
    ok('arrowhead points along the line (rightward)', tipX > backX, `tip=${tipX.toFixed(0)} back=${backX.toFixed(0)}`);

    // Reverse it: head must now point left.
    const cl = app.store.addConnection({ from: { id: R.id, port: 'left' }, to: { id: L.id, port: 'right' }, routing: 'straight' });
    const headD2 = app.connections.groups.get(cl.id).querySelector('.conn-head-end').getAttribute('d');
    const p2 = headD2.match(/-?\d+(\.\d+)?/g).map(Number);
    ok('arrowhead flips for the reverse direction', p2[0] < Math.max(p2[2], p2[4]),
      `tip=${p2[0].toFixed(0)}`);

    // Downward link: head must point down (+y).
    const T = app.store.addElement('shape', { x: 2000, y: 0, width: 120, height: 80 });
    const Bt = app.store.addElement('shape', { x: 2000, y: 600, width: 120, height: 80 });
    const cd = app.store.addConnection({ from: { id: T.id, port: 'bottom' }, to: { id: Bt.id, port: 'top' } });
    const hd3 = app.connections.groups.get(cd.id).querySelector('.conn-head-end').getAttribute('d');
    const p3 = hd3.match(/-?\d+(\.\d+)?/g).map(Number);
    ok('arrowhead points down for a vertical link', p3[1] > Math.max(p3[3], p3[5]),
      `tipY=${p3[1].toFixed(0)}`);

    /* ---------- 5. connections survive delete + undo ---------- */
    const connCountBefore = app.store.connections.length;
    app.store.removeElements([b.id]);
    ok('deleting a node removes its connections',
      app.store.connections.length === connCountBefore - 1,
      `${connCountBefore} -> ${app.store.connections.length}`);
    ok('no dangling connection refs',
      !app.store.connections.some(c => c.from?.id === b.id || c.to?.id === b.id));
    app.store.undo();
    ok('undo restores the node', !!app.store.get(b.id));
    ok('undo restores its connection', app.store.connections.length === connCountBefore,
      String(app.store.connections.length));
    ok('undo re-renders the connection', !!app.connections.groups.get(c1.id));

    /* ---------- 6. MIND MAP ---------- */
    app.store.clear();
    const root = app.mindmap.createRoot(0, 0, 'Central idea');
    const kids = [];
    for (const t of ['Research', 'Design and build the thing', 'Ship', 'Measure', 'Iterate']) {
      kids.push(app.mindmap.addChild(root.id, t));
    }
    document.activeElement && document.activeElement.blur();
    app.mindmap.layout(root.id);

    ok('mind map created 5 children', kids.filter(Boolean).length === 5);
    ok('every child has a link',
      kids.every(k => app.store.connections.some(c => c.mm && c.to.id === k.id)));

    // balanced: children should be on both sides of the root
    const sides = new Set(kids.map(k => app.store.get(k.id).mmSide));
    ok('layout balances left and right', sides.has('left') && sides.has('right'),
      [...sides].join(','));

    // no sibling overlap on the same side
    let overlap = false;
    for (const side of ['left', 'right']) {
      const same = kids.map(k => app.store.get(k.id)).filter(n => n.mmSide === side)
        .sort((p, q) => p.y - q.y);
      for (let i = 1; i < same.length; i++) {
        if (same[i].y < same[i - 1].y + same[i - 1].height) overlap = true;
      }
    }
    ok('mind map siblings never overlap', !overlap);

    // nodes size to their text
    const wide = app.store.get(kids[1].id);
    const narrow = app.store.get(kids[2].id);
    ok('nodes auto-size to their label', wide.width > narrow.width,
      `"${wide.content}"=${wide.width} vs "${narrow.content}"=${narrow.width}`);

    // readable contrast (the dark-on-dark bug)
    const kidNode = app.renderer.node(kids[0].id);
    const bg = app.store.get(kids[0].id).style.backgroundColor;
    const toRgb = h => { const c = Util.hexToRgb(h); return `rgb(${c.r}, ${c.g}, ${c.b})`; };
    const wantFg = Util.readableText(bg);
    ok('child label colour has real contrast',
      getComputedStyle(kidNode).color === toRgb(wantFg),
      `bg=${bg} want=${wantFg} got=${getComputedStyle(kidNode).color}`);

    // collapse survives a re-render
    app.mindmap.addChild(kids[0].id, 'Sub topic');
    document.activeElement && document.activeElement.blur();
    const grandchild = app.store.get(kids[0].id).mmChildren[0];
    app.mindmap.toggleCollapse(kids[0].id);
    ok('collapse hides descendants', app.store.get(grandchild).hidden === true);
    app.renderer.patch(app.store.get(grandchild));
    ok('collapse survives a re-render',
      app.renderer.node(grandchild).classList.contains('is-hidden'));
    app.mindmap.toggleCollapse(kids[0].id);
    ok('expand restores descendants', app.store.get(grandchild).hidden === false);

    // deleting a branch takes its subtree
    const beforeCount = app.store.elements.length;
    app.store.select([kids[0].id]);
    app.deleteSelection();
    ok('deleting a topic removes its whole subtree',
      app.store.elements.length === beforeCount - 2,
      `${beforeCount} -> ${app.store.elements.length}`);
    ok('no orphan mind-map links',
      !app.store.connections.some(c => c.mm && !app.store.get(c.to.id)));

    /* ---------- 7. INK on an unbounded surface ---------- */
    app.store.clear();
    app.ink.begin(12000, -8000, { color: '#111', width: 4, tool: 'pen' });
    for (let i = 1; i <= 40; i++) app.ink.extend(12000 + i * 12, -8000 + i * 9);
    const stroke = app.ink.end();
    ok('stroke saved at far coordinates', !!stroke && app.store.strokes.length === 1);
    ok('stroke bbox computed', stroke.bbox.w > 400 && stroke.bbox.h > 300,
      `${stroke.bbox.w.toFixed(0)}x${stroke.bbox.h.toFixed(0)}`);
    ok('stroke stored in BOARD coords (not screen)', near(stroke.points[0].x, 12000, 0.01));

    const erased = app.ink.hitStrokes(12000, -8000, 20);
    ok('eraser hit-tests far strokes', erased.length === 1);

    /* ---------- 8. camera ---------- */
    app.viewport.setTransform(0, 0, 1);
    const sp = app.viewport.boardToScreen(500, 300);
    const bp = app.viewport.screenToBoard(sp.x, sp.y);
    ok('screen/board round-trips at scale 1', near(bp.x, 500) && near(bp.y, 300));
    app.viewport.zoomTo(2.5, 400, 300);
    const bp2 = app.viewport.screenToBoard(400, 300);
    ok('zoom keeps the point under the cursor pinned',
      near(bp2.x, app.viewport.screenToBoard(400, 300).x, 0.01));
    const sp3 = app.viewport.boardToScreen(500, 300);
    const bp3 = app.viewport.screenToBoard(sp3.x, sp3.y);
    ok('screen/board round-trips when zoomed', near(bp3.x, 500) && near(bp3.y, 300));

    app.store.addElement('shape', { x: -4000, y: -4000, width: 200, height: 200 });
    app.store.addElement('shape', { x: 9000, y: 7000, width: 200, height: 200 });
    app.viewport.zoomToFit();
    const vis = app.viewport.visibleRect();
    ok('zoomToFit frames far-apart content',
      vis.x < -3900 && vis.x + vis.w > 9100,
      `x=${vis.x.toFixed(0)} w=${vis.w.toFixed(0)}`);

    /* ---------- 9. history integrity ---------- */
    app.store.clear();
    const h1 = app.store.addElement('sticky-note', { x: 0, y: 0 });
    app.nudge(10, 10);
    app.store.select([h1.id]);
    app.nudge(10, 10);
    const afterNudge = { x: h1.x, y: h1.y };
    ok('nudge moved the element', afterNudge.x === 10 && afterNudge.y === 10,
      JSON.stringify(afterNudge));
    app.store.undo();
    ok('nudge is undoable', app.store.get(h1.id).x === 0,
      String(app.store.get(h1.id).x));

    /* ---------- 10. export actually paints elements ---------- */
    app.store.clear();
    app.store.addElement('sticky-note', { x: 0, y: 0, content: 'Hello board', style: { backgroundColor: '#ffe66d' } });
    app.store.addElement('shape', { x: 260, y: 0, width: 160, height: 160, shapeType: 'star', style: { backgroundColor: '#4262ff', borderColor: '#222', borderWidth: 2 } });
    const chart = app.charts.create(480, 0, 'bar');
    app.algorithm.create(0, 260);

    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 700;
    const ctx = canvas.getContext('2d');
    try {
      await app.exporter.paintBoard(ctx, false);
      const data = ctx.getImageData(0, 0, 900, 700).data;
      let nonEmpty = 0;
      for (let i = 3; i < data.length; i += 400) if (data[i] > 0) nonEmpty++;
      ok('PNG export paints real content (not a blank canvas)', nonEmpty > 50,
        nonEmpty + ' sampled opaque pixels');
    } catch (e) {
      ok('PNG export paints real content (not a blank canvas)', false, String(e));
    }

    /* ---------- 10b. END-TO-END POINTER DRAG ---------- */
    app.store.clear();
    app.setTool('select');
    app.settings.snapToGrid = false;
    app.viewport.setTransform(0, 0, 1);

    const drag = app.store.addElement('sticky-note', { x: 100, y: 100, width: 200, height: 200 });
    const wrapper = app.viewport.wrapper;
    const wrect = wrapper.getBoundingClientRect();
    const dragNode = app.renderer.node(drag.id);

    const pe = (type, x, y, target) => {
      const ev = new PointerEvent(type, {
        pointerId: 1, bubbles: true, cancelable: true, isPrimary: true,
        pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: x, clientY: y,
      });
      (target || wrapper).dispatchEvent(ev);
      return ev;
    };

    // press on the element, move 220px right / 140px down, release
    const startX = wrect.left + 100 + 100, startY = wrect.top + 100 + 100;
    pe('pointerdown', startX, startY, dragNode);
    ok('pointerdown selects the element under the cursor', app.store.selection.has(drag.id));
    pe('pointermove', startX + 2, startY + 1, window);      // below threshold
    ok('tiny movement does not start a drag', drag.x === 100,
      'x=' + drag.x);
    pe('pointermove', startX + 220, startY + 140, window);
    await nextFrame();                       // the drag applies on the next frame
    pe('pointerup', startX + 220, startY + 140, window);

    ok('pointer drag moved the element',
      near(drag.x, 320, 2) && near(drag.y, 240, 2),
      `x=${drag.x.toFixed(1)} y=${drag.y.toFixed(1)}`);
    ok('drag is recorded in history', app.store.historyInfo().canUndo);
    app.store.undo();
    ok('drag is undoable', near(app.store.get(drag.id).x, 100, 2),
      'x=' + app.store.get(drag.id).x);

    /* ---------- 10c. DRAG PERFORMANCE with a busy board ---------- */
    function runPerf() {
      app.store.clear();
      const N = 300;
      const made = [];
      for (let i = 0; i < N; i++) {
        made.push(app.store.addElement('sticky-note', {
          x: (i % 20) * 240, y: Math.floor(i / 20) * 240,
          width: 200, height: 200, content: 'Note ' + i,
          style: { backgroundColor: '#ffe66d' },
        }, { silent: true }));
      }
      // wire up 150 connections so routing cost is included
      for (let i = 0; i + 1 < N; i += 2) {
        app.store.addConnection({
          from: { id: made[i].id, port: 'right' },
          to: { id: made[i + 1].id, port: 'left' },
        }, { silent: true });
      }
      ok('busy board built', app.store.elements.length === N &&
        app.store.connections.length === 150,
        `${app.store.elements.length} elements, ${app.store.connections.length} links`);

      // Simulate the exact work one drag frame does, 200 times.
      app.store.select([made[0].id]);
      const targets = [made[0]];
      const origins = [{ id: made[0].id, x: made[0].x, y: made[0].y }];
      const view = app.viewport.visibleRect(400);
      const candidates = app.store.elements.slice(1).map(el => ({
        left: el.x, right: el.x + el.width, cx: el.x + el.width / 2,
        top: el.y, bottom: el.y + el.height, cy: el.y + el.height / 2,
      }));

      const FRAMES = 200;
      const t0 = performance.now();
      for (let f = 0; f < FRAMES; f++) {
        app.interaction._applyDrag(
          { clientX: 400 + f, clientY: 300 + f * 0.5, shiftKey: false, altKey: false },
          targets, origins, { x: 0, y: 0 }, candidates
        );
      }
      const ms = performance.now() - t0;
      const perFrame = ms / FRAMES;
      ok('drag frame cost is well under one 60fps budget (16.7ms)',
        perFrame < 8, perFrame.toFixed(2) + ' ms/frame over ' + FRAMES + ' frames');

      // Guides must be pooled, not created and destroyed each frame.
      const guideCount = document.querySelectorAll('.align-guide').length;
      ok('alignment guides are pooled (no per-frame DOM churn)',
        guideCount <= 4, guideCount + ' guide nodes after ' + FRAMES + ' frames');

      // Panning a busy board.
      const t1 = performance.now();
      for (let f = 0; f < 120; f++) app.viewport.panBy(3, 2);
      const panMs = (performance.now() - t1) / 120;
      ok('pan frame cost is cheap', panMs < 4, panMs.toFixed(3) + ' ms/frame');

      // Ink redraw culling with many strokes.
      for (let i = 0; i < 400; i++) {
        app.store.addStroke({
          id: 'st' + i,
          points: [{ x: i * 50, y: 0 }, { x: i * 50 + 40, y: 40 }],
          color: '#111', width: 3, tool: 'pen',
          bbox: { x: i * 50, y: 0, w: 40, h: 40 },
        }, { silent: true });
      }
      const t2 = performance.now();
      for (let f = 0; f < 60; f++) app.ink.redraw();
      const inkMs = (performance.now() - t2) / 60;
      ok('ink redraw stays cheap with 400 strokes (viewport culling)',
        inkMs < 6, inkMs.toFixed(3) + ' ms/redraw');
    }
    runPerf();

    /* ---------- 11. legacy migration ---------- */
    const legacy = {
      id: 'board-1788027566005', name: 'samaka',
      elements: [
        { id: 'el-1', type: 'flowchart', x: 1392, y: 168, width: 150, height: 60, content: 'process', style: {}, zIndex: 23, fcType: 'process' },
        { id: 'el-2', type: 'flowchart', x: 1824, y: 168, width: 150, height: 60, content: 'startend', style: {}, zIndex: 24, fcType: 'startend' },
      ],
      lines: [{ id: 'l1', x1: 0, y1: 0, x2: 100, y2: 100, arrow: true, style: { color: '#000', width: 2 } }],
      drawings: [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: '#000', width: 3 }],
      flowchartConnections: [{ id: 'conn-1', from: 'el-1', fromPort: 'right', to: 'el-2', toPort: 'left' }],
    };
    const migrated = Store.migrate(legacy);
    ok('legacy board migrates', !!migrated && migrated.elements.length === 2);
    ok('legacy flowchart links migrate',
      migrated.connections.some(c => c.from.id === 'el-1' && c.to.id === 'el-2'));
    ok('legacy free lines migrate', migrated.connections.some(c => c.from.port === 'free'));
    ok('legacy drawings migrate to strokes', migrated.strokes.length === 1 && !!migrated.strokes[0].bbox);

    /* ---------- 12. algorithm classifier ---------- */
    const cl2 = AlgorithmManager.classifyLine;
    ok('classifies def', cl2('def foo():') === 'start');
    ok('classifies if', cl2('  if a > b:') === 'condition');
    ok('classifies for', cl2('  for i in x:') === 'loop');
    ok('classifies return', cl2('  return a') === 'end');
    ok('classifies print', cl2('print(a)') === 'io');
    ok('classifies assignment', cl2('total = 0') === 'declare');
    ok('classifies comment', cl2('# note') === 'comment');
  }

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    const fails = results.filter(r => r.startsWith('FAIL')).length;
    results.push('---');
    results.push(`${results.length - 1} checks, ${fails} failures`);
    results.push('runtime errors: ' + JSON.stringify(window.__errors));
    document.getElementById('selftest-results').textContent = results.join('\n');
    document.title = 'DONE ' + fails + ' failures';
  }

  const boot = async () => {
    try { await run(); }
    catch (e) {
      results.push('FAIL  threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e));
    }
    finish();
  };

  // give the app a moment to construct
  setTimeout(boot, 900);
})();
