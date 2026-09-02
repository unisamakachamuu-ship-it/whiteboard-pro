/* ================================================================
   connections.js — universal connector engine
   ================================================================
   Fixes carried over from the old flowchart.js / board.renderConnection:

   * The arrowhead angle used `Math.atan2(y2-(y1+y2)/2, x2-x2)`. `x2-x2`
     is always 0, and the polygon was hardcoded pointing left, so every
     arrow pointed the wrong way. Heads are now derived from the real
     direction of the final path segment.

   * Orthogonal routing ignored which port you attached to and always
     went through the mid-Y. Routing is now port-direction aware.

   * Only flowchart nodes could be connected. ANY element can now be an
     endpoint — algorithm blocks, shapes, stickies, charts, images.

   * The SVG host is given a ±SVG_EXTENT coordinate space so nothing is
     clipped. A 100%×100% <svg> silently hid every connection outside the
     first screen, which is why long flows and mind maps "broke".
   ================================================================ */

const PORT_DIRS = {
  top:    { x: 0, y: -1 },
  right:  { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left:   { x: -1, y: 0 },
  center: { x: 0, y: 0 },
};

class ConnectionLayer {
  constructor(app) {
    this.app = app;
    this.store = app.store;

    this.svg = document.getElementById('svg-layer');

    /* An inline <svg> gets `overflow: hidden` from the UA stylesheet, which
       is exactly what silently clipped every connection past the first
       screen. `overflow: visible` (set in CSS and re-asserted here) lifts
       that clip, so a 1×1 host can carry marks anywhere in board space
       without allocating a giant layer. A generous viewBox-free viewport is
       kept as a belt-and-braces fallback for engines that ignore it. */
    this.svg.setAttribute('width', '1');
    this.svg.setAttribute('height', '1');
    this.svg.style.overflow = 'visible';

    this.root = document.createElementNS(NS, 'g');
    this.svg.appendChild(this.root);

    // Verify the clip is actually lifted; if not, fall back to a large
    // explicit viewport with a shifted origin.
    requestAnimationFrame(() => this._verifyNoClipping());

    this.tempGroup = document.createElementNS(NS, 'g');
    this.tempGroup.setAttribute('class', 'conn-temp');
    this.root.appendChild(this.tempGroup);

    /** @type {Map<string, SVGGElement>} */
    this.groups = new Map();

    this.store.on('connection:add',    c => this.render(c));
    this.store.on('connection:update', c => this.render(c));
    this.store.on('connection:remove', c => this.remove(c.id));
    this.store.on('reload',            () => this.renderAll());
    this.store.on('selection',         () => this._syncSelection());
  }

  /**
   * Probe: draw a mark well outside the 1×1 host and check the browser
   * still reports a render box for it. If an engine insists on clipping,
   * switch to an explicitly huge viewport with a translated origin.
   */
  _verifyNoClipping() {
    const probe = document.createElementNS(NS, 'rect');
    probe.setAttribute('x', 4000);
    probe.setAttribute('y', 4000);
    probe.setAttribute('width', 10);
    probe.setAttribute('height', 10);
    probe.setAttribute('fill', 'none');
    this.root.appendChild(probe);

    let clipped = false;
    try {
      const r = probe.getBoundingClientRect();
      clipped = r.width === 0 && r.height === 0;
    } catch (_) { clipped = true; }
    probe.remove();

    if (!clipped) return;
    this.useExtendedViewport();
  }

  /** Fallback host: an explicit ±SVG_EXTENT viewport with a shifted origin. */
  useExtendedViewport() {
    this.svg.setAttribute('width', SVG_EXTENT * 2);
    this.svg.setAttribute('height', SVG_EXTENT * 2);
    this.svg.style.left = -SVG_EXTENT + 'px';
    this.svg.style.top = -SVG_EXTENT + 'px';
    this.root.setAttribute('transform', `translate(${SVG_EXTENT},${SVG_EXTENT})`);
  }

  /* ---- geometry ---------------------------------------------------- */

  /** Absolute board point + outward normal for a port on an element. */
  portPoint(el, port) {
    const w = el.width || 0, h = el.height || 0;
    let p, dir;
    switch (port) {
      case 'top':    p = { x: el.x + w / 2, y: el.y };         dir = PORT_DIRS.top; break;
      case 'right':  p = { x: el.x + w,     y: el.y + h / 2 }; dir = PORT_DIRS.right; break;
      case 'bottom': p = { x: el.x + w / 2, y: el.y + h };     dir = PORT_DIRS.bottom; break;
      case 'left':   p = { x: el.x,         y: el.y + h / 2 }; dir = PORT_DIRS.left; break;
      default:       p = { x: el.x + w / 2, y: el.y + h / 2 }; dir = PORT_DIRS.center; break;
    }
    if (el.rotation) {
      const c = { x: el.x + w / 2, y: el.y + h / 2 };
      p = Util.rotatePoint(p.x, p.y, c.x, c.y, el.rotation);
      const r = el.rotation * Math.PI / 180;
      dir = {
        x: dir.x * Math.cos(r) - dir.y * Math.sin(r),
        y: dir.x * Math.sin(r) + dir.y * Math.cos(r),
      };
    }
    return { x: p.x, y: p.y, dir };
  }

  /** Best port on `el` when facing `toward` (board point). */
  autoPort(el, toward) {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const dx = toward.x - cx;
    const dy = toward.y - cy;
    // Compare against the box aspect so wide boxes prefer left/right.
    const ax = Math.abs(dx) / Math.max(el.width / 2, 1);
    const ay = Math.abs(dy) / Math.max(el.height / 2, 1);
    if (ax >= ay) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'bottom' : 'top';
  }

  /** Resolve one end of a connection to a concrete board point + normal. */
  endpointOf(conn, which) {
    const end = conn[which];
    if (!end) return null;

    if (end.id) {
      const el = this.store.get(end.id);
      if (!el) return null;
      let port = end.port;
      if (!port || port === 'auto') {
        const other = conn[which === 'from' ? 'to' : 'from'];
        let target;
        if (other?.id) {
          const oel = this.store.get(other.id);
          target = oel
            ? { x: oel.x + oel.width / 2, y: oel.y + oel.height / 2 }
            : { x: el.x, y: el.y };
        } else {
          target = { x: other?.x || 0, y: other?.y || 0 };
        }
        port = this.autoPort(el, target);
      }
      return this.portPoint(el, port);
    }

    return { x: end.x || 0, y: end.y || 0, dir: PORT_DIRS.center };
  }

  /* ---- routing ------------------------------------------------------ */

  _routePoints(a, b, routing) {
    if (routing === 'straight') return [a, b];

    const d1 = (a.dir && (a.dir.x || a.dir.y)) ? a.dir : this._impliedDir(a, b);
    const d2 = (b.dir && (b.dir.x || b.dir.y)) ? b.dir : this._impliedDir(b, a);

    if (routing === 'curved') return [a, b, d1, d2];   // handled by caller

    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const off = Math.min(Math.max(22, dist * 0.18), 36);

    const s = { x: a.x + d1.x * off, y: a.y + d1.y * off };
    const e = { x: b.x + d2.x * off, y: b.y + d2.y * off };
    const pts = [a, s];

    const startHorizontal = Math.abs(d1.x) > Math.abs(d1.y);
    const endHorizontal   = Math.abs(d2.x) > Math.abs(d2.y);

    if (startHorizontal && endHorizontal) {
      if (Math.abs(s.y - e.y) > 8) {
        const mx = (s.x + e.x) / 2;
        pts.push({ x: mx, y: s.y }, { x: mx, y: e.y });
      }
    } else if (!startHorizontal && !endHorizontal) {
      if (Math.abs(s.x - e.x) > 8) {
        const my = (s.y + e.y) / 2;
        pts.push({ x: s.x, y: my }, { x: e.x, y: my });
      }
    } else if (startHorizontal) {
      pts.push({ x: e.x, y: s.y });
    } else {
      pts.push({ x: s.x, y: e.y });
    }

    pts.push(e, b);
    return this._dedupe(pts);
  }

  _impliedDir(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
    return { x: 0, y: Math.sign(dy) || 1 };
  }

  _dedupe(pts) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) continue;
      out.push({ x: p.x, y: p.y });
    }
    return out.length >= 2 ? out : pts.map(p => ({ x: p.x, y: p.y }));
  }

  /** Polyline -> path string with smooth, natural rounded corners. */
  _polylinePath(pts, radius = 16) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;

    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
      const inLen  = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
      const r = Math.min(radius, inLen / 2, outLen / 2);
      if (r < 2) { d += ` L${cur.x.toFixed(1)},${cur.y.toFixed(1)}`; continue; }
      const p1 = { x: cur.x + (prev.x - cur.x) * (r / inLen),  y: cur.y + (prev.y - cur.y) * (r / inLen) };
      const p2 = { x: cur.x + (next.x - cur.x) * (r / outLen), y: cur.y + (next.y - cur.y) * (r / outLen) };
      d += ` L${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${cur.x.toFixed(1)},${cur.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` L${last.x.toFixed(1)},${last.y.toFixed(1)}`;
    return d;
  }

  _curvePath(a, b, d1, d2) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);

    let dir1 = (d1 && (d1.x || d1.y)) ? d1 : null;
    let dir2 = (d2 && (d2.x || d2.y)) ? d2 : null;

    if (!dir1 && !dir2) {
      const isHorizontal = Math.abs(dx) >= Math.abs(dy);
      dir1 = isHorizontal ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
      dir2 = isHorizontal ? { x: -Math.sign(dx) || -1, y: 0 } : { x: 0, y: -Math.sign(dy) || -1 };
    } else if (!dir1) {
      dir1 = { x: -dir2.x, y: -dir2.y };
    } else if (!dir2) {
      dir2 = { x: -dir1.x, y: -dir1.y };
    }

    // Natural curve tension scaled by distance
    const dot = dir1.x * (-dir2.x) + dir1.y * (-dir2.y);
    const k = Util.clamp(dist * (dot < 0 ? 0.45 : 0.38), 28, 220);

    const c1 = { x: a.x + dir1.x * k, y: a.y + dir1.y * k };
    const c2 = { x: b.x + dir2.x * k, y: b.y + dir2.y * k };
    return {
      d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`,
      c1, c2
    };
  }

  /* ---- rendering ------------------------------------------------------ */

  renderAll() {
    for (const [id, g] of this.groups) { g.remove(); }
    this.groups.clear();
    for (const c of this.store.connections) this.render(c);
  }

  remove(id) {
    const g = this.groups.get(id);
    if (g) g.remove();
    this.groups.delete(id);
  }

  /** Re-route every connection touching these element ids. */
  refreshFor(elementIds) {
    const set = new Set(Array.isArray(elementIds) ? elementIds : [elementIds]);
    for (const c of this.store.connections) {
      if (set.has(c.from?.id) || set.has(c.to?.id)) this.render(c);
    }
  }

  render(conn) {
    const a = this.endpointOf(conn, 'from');
    const b = this.endpointOf(conn, 'to');
    if (!a || !b) { this.remove(conn.id); return; }

    let g = this.groups.get(conn.id);
    if (!g) {
      g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'conn');
      g.dataset.connId = conn.id;

      const hit = document.createElementNS(NS, 'path');
      hit.setAttribute('class', 'conn-hit');
      g.appendChild(hit);

      const line = document.createElementNS(NS, 'path');
      line.setAttribute('class', 'conn-line');
      g.appendChild(line);

      const head = document.createElementNS(NS, 'path');
      head.setAttribute('class', 'conn-head-end');
      g.appendChild(head);

      const tail = document.createElementNS(NS, 'path');
      tail.setAttribute('class', 'conn-head-start');
      g.appendChild(tail);

      const labelBg = document.createElementNS(NS, 'rect');
      labelBg.setAttribute('class', 'conn-label-bg');
      g.appendChild(labelBg);

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', 'conn-label');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'middle');
      g.appendChild(label);

      this.root.insertBefore(g, this.tempGroup);
      this.groups.set(conn.id, g);
    }

    const style = conn.style || {};
    // A connector with no explicit colour used to fall back to a hardcoded
    // near-black, which vanished into every dark theme and left the label
    // unreadable against the canvas. Resolve the theme's ink instead, so an
    // untouched connector always contrasts with whatever canvas it is on.
    const color = style.color || this.themeInk();
    const width = style.width || 2;

    let d, endDir, startDir, mid;

    if (conn.routing === 'curved') {
      const d1 = (a.dir.x || a.dir.y) ? a.dir : this._impliedDir(a, b);
      const d2 = (b.dir.x || b.dir.y) ? b.dir : this._impliedDir(b, a);
      const c = this._curvePath(a, b, d1, d2);
      d = c.d;
      // Head direction = tangent at the curve's end (b − c2).
      endDir = this._norm({ x: b.x - c.c2.x, y: b.y - c.c2.y });
      startDir = this._norm({ x: a.x - c.c1.x, y: a.y - c.c1.y });
      mid = this._bezierPoint(a, c.c1, c.c2, b, 0.5);
    } else {
      const pts = this._routePoints(a, b, conn.routing || 'orthogonal');
      d = this._polylinePath(pts, conn.routing === 'straight' ? 0 : 10);
      const n = pts.length;
      endDir   = this._norm({ x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y });
      startDir = this._norm({ x: pts[0].x - pts[1].x,         y: pts[0].y - pts[1].y });
      mid = this._polylineMidpoint(pts);
    }

    const line = g.querySelector('.conn-line');
    line.setAttribute('d', d);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', width);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    if (style.dash) line.setAttribute('stroke-dasharray', style.dash);
    else line.removeAttribute('stroke-dasharray');

    g.querySelector('.conn-hit').setAttribute('d', d);

    // Arrowheads, oriented by the ACTUAL segment direction.
    const size = Math.max(7, 5 + width * 2);
    const head = g.querySelector('.conn-head-end');
    if (conn.arrowEnd !== false) {
      head.setAttribute('d', this._arrowPath(b, endDir, size));
      head.setAttribute('fill', color);
      head.style.display = '';
    } else head.style.display = 'none';

    const tail = g.querySelector('.conn-head-start');
    if (conn.arrowStart) {
      tail.setAttribute('d', this._arrowPath(a, startDir, size));
      tail.setAttribute('fill', color);
      tail.style.display = '';
    } else tail.style.display = 'none';

    // Label
    const label = g.querySelector('.conn-label');
    const labelBg = g.querySelector('.conn-label-bg');
    if (conn.label) {
      label.textContent = conn.label;
      label.setAttribute('x', mid.x.toFixed(1));
      label.setAttribute('y', mid.y.toFixed(1));
      label.setAttribute('fill', color);
      label.style.display = '';
      const w = Math.max(conn.label.length * 7 + 14, 26);
      labelBg.setAttribute('x', (mid.x - w / 2).toFixed(1));
      labelBg.setAttribute('y', (mid.y - 11).toFixed(1));
      labelBg.setAttribute('width', w);
      labelBg.setAttribute('height', 22);
      labelBg.setAttribute('rx', 6);
      labelBg.style.display = '';
    } else {
      label.style.display = 'none';
      labelBg.style.display = 'none';
    }

    g.classList.toggle('is-selected', this.store.connSelection.has(conn.id));
  }

  /**
   * The active theme's connector ink, read from CSS so a theme only ever has
   * to declare `--clr-connector` (or `--clr-text`) to restyle every
   * connector on the board. Cached — this is read once per connector per
   * render and getComputedStyle is not free.
   */
  themeInk() {
    const theme = document.documentElement.dataset.theme || '';
    if (this._inkTheme === theme && this._ink) return this._ink;

    // Read it off a probe rather than with getPropertyValue: a custom
    // property that is itself defined as `var(--clr-text)` comes back as the
    // literal string "var(--clr-text)", which is not a paintable colour.
    // `color` on a real element is always resolved down to an rgb() triple.
    if (!this._inkProbe) {
      this._inkProbe = document.createElement('span');
      this._inkProbe.style.cssText =
        'position:absolute;width:0;height:0;visibility:hidden;color:var(--clr-connector,#16161d)';
      document.body.appendChild(this._inkProbe);
    }
    const resolved = getComputedStyle(this._inkProbe).color;
    this._ink = (resolved && resolved !== 'rgba(0, 0, 0, 0)') ? resolved : '#16161d';
    this._inkTheme = theme;
    return this._ink;
  }

  /** Re-ink every connector that has no colour of its own. */
  refreshTheme() {
    this._ink = null;
    for (const c of this.store.connections) {
      if (!c.style?.color) this.render(c);
    }
  }

  _syncSelection() {
    for (const [id, g] of this.groups) {
      g.classList.toggle('is-selected', this.store.connSelection.has(id));
    }
  }

  _norm(v) {
    const len = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / len, y: v.y / len };
  }

  _arrowPath(tip, dir, size = 10) {
    const angle = Math.atan2(dir.y, dir.x);
    const spread = 0.46;
    const len = size * 1.15;
    const p1x = tip.x - len * Math.cos(angle - spread);
    const p1y = tip.y - len * Math.sin(angle - spread);
    const p2x = tip.x - len * Math.cos(angle + spread);
    const p2y = tip.y - len * Math.sin(angle + spread);
    const cx = tip.x - len * 0.72 * Math.cos(angle);
    const cy = tip.y - len * 0.72 * Math.sin(angle);
    return `M${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${p1x.toFixed(1)},${p1y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)} Z`;
  }

  _bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  _polylineMidpoint(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let target = total / 2, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (acc + seg >= target) {
        const t = seg === 0 ? 0 : (target - acc) / seg;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
                 y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      }
      acc += seg;
    }
    return pts[Math.floor(pts.length / 2)];
  }

  /* ---- draft (drag-to-connect preview) --------------------------------- */

  showDraft(a, b, routing = 'orthogonal', color = '#4262ff') {
    this.tempGroup.textContent = '';
    const pts = routing === 'curved'
      ? null
      : this._routePoints(a, b, routing);

    const path = document.createElementNS(NS, 'path');
    let d, endDir;
    if (routing === 'curved') {
      const d1 = (a.dir?.x || a.dir?.y) ? a.dir : this._impliedDir(a, b);
      const d2 = (b.dir?.x || b.dir?.y) ? b.dir : this._impliedDir(b, a);
      const c = this._curvePath(a, b, d1, d2);
      d = c.d;
      endDir = this._norm({ x: b.x - c.c2.x, y: b.y - c.c2.y });
    } else {
      d = this._polylinePath(pts, 10);
      const n = pts.length;
      endDir = this._norm({ x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y });
    }
    path.setAttribute('d', d);
    path.setAttribute('class', 'conn-draft');
    path.setAttribute('stroke', color);
    this.tempGroup.appendChild(path);

    const head = document.createElementNS(NS, 'path');
    head.setAttribute('d', this._arrowPath(b, endDir, 9));
    head.setAttribute('fill', color);
    this.tempGroup.appendChild(head);
  }

  hideDraft() { this.tempGroup.textContent = ''; }
}

window.ConnectionLayer = ConnectionLayer;
window.PORT_DIRS = PORT_DIRS;
