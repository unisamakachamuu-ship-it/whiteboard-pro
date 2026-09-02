/* ================================================================
   extras.js — exporters and the board library
   ================================================================
   The previous exportAsPNG() only copied the pen-stroke canvas, so every
   sticky note, shape, chart and connection was missing from the image.
   This exporter walks the real board and paints every element type, and
   also emits SVG, Markdown and CSV.

   (The template library used to live here too; it now has its own file,
   templates.js, because two of its keys were silently colliding.)
   ================================================================ */

class Exporter {
  constructor(app) {
    this.app = app;
    this.store = app.store;
  }

  /* ---- JSON --------------------------------------------------------- */

  json() {
    const data = { ...this.store.serialize(), exported_at: new Date().toISOString() };
    Util.download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      Util.safeName(this.store.state.name) + '.json');
    Modal.toast('Board exported as JSON.', 'success');
  }

  /* ---- geometry helpers --------------------------------------------- */

  _bounds(selectionOnly) {
    const els = selectionOnly ? this.store.selected() : this.store.elements;
    const items = [];
    for (const e of els) {
      if (Number.isFinite(e.x) && Number.isFinite(e.y)) {
        items.push({ x: e.x, y: e.y, width: Util.num(e.width, 100), height: Util.num(e.height, 100) });
      }
    }
    if (!selectionOnly) {
      for (const s of this.store.strokes) {
        const b = s.bbox || Store.strokeBBox(s.points);
        if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
          items.push({ x: b.x, y: b.y, width: Util.num(b.w, 10), height: Util.num(b.h, 10) });
        }
      }
      for (const c of this.store.connections) {
        const a = this.app.connections?.endpointOf(c, 'from');
        const z = this.app.connections?.endpointOf(c, 'to');
        if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) items.push({ x: a.x, y: a.y, width: 0, height: 0 });
        if (z && Number.isFinite(z.x) && Number.isFinite(z.y)) items.push({ x: z.x, y: z.y, width: 0, height: 0 });
      }
    }
    const b = Util.boundsOf(items);
    if (!b || !Number.isFinite(b.w) || !Number.isFinite(b.h) || b.w <= 0 || b.h <= 0) {
      return null;
    }
    const pad = 48;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }

  /* ---- PNG ------------------------------------------------------------ */

  async png({ scale = 2, transparent = false, selectionOnly = false } = {}) {
    try {
      const bounds = this._bounds(selectionOnly);
      if (!bounds) { Modal.toast('Nothing on the board to export yet.', 'warn'); return; }

      const maxPixels = 32e6;                        // keep well inside canvas limits
      let s = scale;
      while (bounds.w * s * bounds.h * s > maxPixels && s > 0.5) s -= 0.25;

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bounds.w * s));
      canvas.height = Math.max(1, Math.round(bounds.h * s));
      const ctx = canvas.getContext('2d');

      if (!transparent) {
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--clr-canvas').trim() || '#f4f5f8';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      ctx.setTransform(s, 0, 0, s, -bounds.x * s, -bounds.y * s);
      await this.paintBoard(ctx, selectionOnly);

      const blob = await new Promise((res, rej) => {
        try {
          canvas.toBlob(b => b ? res(b) : rej(new Error('Canvas export produced empty data')), 'image/png');
        } catch (err) {
          rej(err);
        }
      });
      Util.download(blob, Util.safeName(this.store.state.name) + '.png');
      Modal.toast('PNG exported successfully.', 'success');
    } catch (err) {
      console.error('[export] PNG export failed', err);
      Modal.toast('Could not export PNG: ' + (err.message || 'unknown error'), 'warn');
    }
  }

  async copyPNG() {
    try {
      const bounds = this._bounds(false);
      if (!bounds) { Modal.toast('Nothing on the board to copy.', 'warn'); return; }
      const s = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bounds.w * s));
      canvas.height = Math.max(1, Math.round(bounds.h * s));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(s, 0, 0, s, -bounds.x * s, -bounds.y * s);
      await this.paintBoard(ctx, false);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('Could not create image blob');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      Modal.toast('Board image copied to clipboard.', 'success');
    } catch (err) {
      console.error('[export] copy PNG failed', err);
      Modal.toast('Clipboard image copy not available or failed.', 'warn');
    }
  }

  /** Paints strokes, connections and every element onto a 2D context. */
  async paintBoard(ctx, selectionOnly) {
    const store = this.store;

    // 1. ink
    for (const stroke of store.strokes) {
      if (selectionOnly) break;
      try { this.app.ink._paint(ctx, stroke); } catch (_) {}
    }

    // 2. connections — reuse the exact SVG path data the board renders
    for (const conn of store.connections) {
      try {
        const g = this.app.connections?.groups?.get(conn.id);
        if (!g || g.style.display === 'none') continue;
        const line = g.querySelector('.conn-line');
        if (!line) continue;
        ctx.save();
        ctx.strokeStyle = line.getAttribute('stroke') || '#16161d';
        ctx.lineWidth = parseFloat(line.getAttribute('stroke-width')) || 2;
        ctx.lineCap = 'round';
        const dash = line.getAttribute('stroke-dasharray');
        if (dash) ctx.setLineDash(dash.split(/[\s,]+/).map(Number));
        const d = line.getAttribute('d');
        if (d) { try { ctx.stroke(new Path2D(d)); } catch (_) {} }
        ctx.setLineDash([]);
        for (const cls of ['.conn-head-end', '.conn-head-start']) {
          const head = g.querySelector(cls);
          if (!head || head.style.display === 'none') continue;
          ctx.fillStyle = head.getAttribute('fill') || '#16161d';
          const hd = head.getAttribute('d');
          if (hd) { try { ctx.fill(new Path2D(hd)); } catch (_) {} }
        }
        if (conn.label) {
          const label = g.querySelector('.conn-label');
          if (label) {
            const x = parseFloat(label.getAttribute('x')) || 0;
            const y = parseFloat(label.getAttribute('y')) || 0;
            ctx.fillStyle = '#ffffff';
            const w = Math.max(conn.label.length * 7 + 12, 22);
            ctx.fillRect(x - w / 2, y - 10, w, 20);
            ctx.fillStyle = conn.style?.color || '#16161d';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(conn.label, x, y);
          }
        }
        ctx.restore();
      } catch (connErr) {
        console.warn('[export] skipping connection due to render error', connErr);
      }
    }

    // 3. elements, painted back-to-front
    const els = (selectionOnly ? store.selected() : store.elements)
      .filter(e => !e.hidden)
      .slice()
      .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    for (const el of els) {
      try {
        await this._paintElement(ctx, el);
      } catch (elErr) {
        console.warn('[export] error painting element', el.type, elErr);
      }
    }
  }

  async _paintElement(ctx, el) {
    ctx.save();
    ctx.globalAlpha = el.style?.opacity != null ? el.style.opacity : 1;
    if (el.rotation) {
      ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
      ctx.rotate(el.rotation * Math.PI / 180);
      ctx.translate(-(el.x + el.width / 2), -(el.y + el.height / 2));
    }

    const style = el.style || {};
    switch (el.type) {
      case 'sticky-note': {
        const bg = style.backgroundColor || '#ffe66d';
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 8);
        ctx.fillStyle = bg;
        ctx.shadowColor = 'rgba(0,0,0,.12)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        this._text(ctx, el.content, el.x + 14, el.y + 14, el.width - 28, el.height - 28, {
          size: style.fontSize || 15,
          color: style.color || Util.readableText(bg),
          align: style.align || 'left',
          bold: style.bold,
        });
        break;
      }
      case 'text':
        this._text(ctx, el.content, el.x + 6, el.y + 4, el.width - 12, el.height, {
          size: style.fontSize || 20,
          color: style.color || '#16161d',
          align: style.align || 'left',
          bold: style.bold,
        });
        break;

      case 'shape':
      case 'flowchart': {
        const table = el.type === 'shape' ? SHAPE_PATHS : FLOWCHART_PATHS;
        const key = el.type === 'shape' ? (el.shapeType || 'rectangle') : (el.fcType || 'process');
        const d = (table[key] || table.rectangle || table.process)();
        ctx.save();
        ctx.translate(el.x, el.y);
        ctx.scale(el.width / 100, el.height / 100);
        const p = new Path2D(d);
        ctx.restore();
        // Re-apply as a transformed Path2D so stroke width stays uniform.
        const m = new DOMMatrix().translate(el.x, el.y).scale(el.width / 100, el.height / 100);
        const scaled = new Path2D();
        scaled.addPath(p, m);
        if (style.backgroundColor && style.backgroundColor !== 'transparent') {
          ctx.fillStyle = style.backgroundColor;
          ctx.fill(scaled);
        }
        if (style.borderWidth !== 0) {
          ctx.strokeStyle = style.borderColor || '#16161d';
          ctx.lineWidth = style.borderWidth != null ? style.borderWidth : 2;
          ctx.stroke(scaled);
        }
        const label = el.content || (el.type === 'flowchart' ? FLOWCHART_LABELS[key] : '');
        if (label) {
          this._text(ctx, label, el.x + 10, el.y + el.height / 2 - 10, el.width - 20, el.height, {
            size: style.fontSize || 14,
            color: style.color || Util.readableText(style.backgroundColor),
            align: 'center', middle: true, boxH: el.height, boxY: el.y,
          });
        }
        break;
      }

      case 'image': {
        const img = await this._loadImage(el.src);
        if (img) {
          ctx.save();
          this._roundRect(ctx, el.x, el.y, el.width, el.height, 6);
          ctx.clip();
          const fit = style.fit || 'contain';
          const ir = img.width / img.height;
          const br = el.width / el.height;
          let dw = el.width, dh = el.height, dx = el.x, dy = el.y;
          if (fit === 'contain' ? ir > br : ir < br) { dh = el.width / ir; dy = el.y + (el.height - dh) / 2; }
          else { dw = el.height * ir; dx = el.x + (el.width - dw) / 2; }
          ctx.drawImage(img, dx, dy, dw, dh);
          ctx.restore();
        }
        break;
      }

      case 'frame':
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.fillRect(el.x, el.y, el.width, el.height);
        ctx.setLineDash([8, 5]);
        ctx.strokeStyle = '#b6bdcb';
        ctx.lineWidth = 2;
        ctx.strokeRect(el.x, el.y, el.width, el.height);
        ctx.setLineDash([]);
        ctx.fillStyle = '#6b7280';
        ctx.font = '600 13px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(el.content || 'Frame', el.x, el.y - 7);
        break;

      case 'mindmap': {
        const bg = style.backgroundColor || '#4262ff';
        this._roundRect(ctx, el.x, el.y, el.width, el.height, el.height / 2);
        ctx.fillStyle = bg;
        ctx.fill();
        this._text(ctx, el.content || 'Topic', el.x + 14, el.y, el.width - 28, el.height, {
          size: style.fontSize || (el.mmRoot ? 16 : 14),
          color: Util.readableText(bg), align: 'center', bold: true,
          middle: true, boxY: el.y, boxH: el.height,
        });
        break;
      }

      case 'graph': {
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 10);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#e3e6ec';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#16161d';
        ctx.font = '600 13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(el.graphTitle || 'Chart', el.x + el.width / 2, el.y + 10);

        const off = document.createElement('canvas');
        off.style.width = (el.width - 24) + 'px';
        off.style.height = (el.height - 46) + 'px';
        off.width = el.width - 24;
        off.height = el.height - 46;
        this.app.charts.draw(el, off);
        ctx.drawImage(off, el.x + 12, el.y + 34, el.width - 24, el.height - 46);
        break;
      }

      case 'algorithm': {
        const theme = AlgorithmManager.THEMES[el.algoTheme] || AlgorithmManager.THEMES.dark;
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 8);
        ctx.fillStyle = theme.bg;
        ctx.fill();
        ctx.strokeStyle = theme.border;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.save();
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 8);
        ctx.clip();
        ctx.fillStyle = theme.headerBg;
        ctx.fillRect(el.x, el.y, el.width, 30);
        ctx.fillStyle = theme.text;
        ctx.font = '700 12px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡ ' + (el.content || 'Algorithm'), el.x + 10, el.y + 15);

        ctx.font = '12px "Courier New", monospace';
        let y = el.y + 42;
        for (let i = 0; i < (el.algoSteps || []).length; i++) {
          const step = el.algoSteps[i];
          const meta = AlgorithmManager.STEP_META[step.type] || AlgorithmManager.STEP_META.process;
          const indent = (step.text.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
          ctx.fillStyle = '#6b7280';
          ctx.fillText(String(i + 1).padStart(2, ' '), el.x + 8, y);
          ctx.fillStyle = meta.color;
          ctx.fillText(meta.icon, el.x + 32, y);
          ctx.fillText(step.text.trim(), el.x + 48 + indent * 7, y);
          y += 21;
          if (y > el.y + el.height - 6) break;
        }
        ctx.restore();
        break;
      }

      case 'table': {
        const data = el.tableData || { rows: 0, cols: 0, cells: [] };
        const cw = el.width / Math.max(data.cols, 1);
        const rh = el.height / Math.max(data.rows, 1);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(el.x, el.y, el.width, el.height);
        ctx.strokeStyle = '#d9dde5';
        ctx.lineWidth = 1;
        ctx.font = '12px Inter, sans-serif';
        ctx.textBaseline = 'middle';
        for (let r = 0; r < data.rows; r++) {
          for (let c = 0; c < data.cols; c++) {
            const x = el.x + c * cw, y = el.y + r * rh;
            if (r === 0) { ctx.fillStyle = '#f1f3f8'; ctx.fillRect(x, y, cw, rh); }
            ctx.strokeRect(x, y, cw, rh);
            ctx.fillStyle = '#16161d';
            ctx.font = (r === 0 ? '600 ' : '') + '12px Inter, sans-serif';
            ctx.textAlign = 'left';
            const txt = String(data.cells?.[r]?.[c] ?? '');
            ctx.fillText(txt.slice(0, 22), x + 8, y + rh / 2);
          }
        }
        break;
      }

      case 'checklist': {
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 8);
        ctx.fillStyle = style.backgroundColor || '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#e3e6ec';
        ctx.stroke();
        ctx.fillStyle = '#16161d';
        ctx.font = '600 14px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(el.content || 'Checklist', el.x + 12, el.y + 12);
        ctx.font = '13px Inter, sans-serif';
        let y = el.y + 38;
        for (const item of (el.items || [])) {
          ctx.strokeStyle = '#b6bdcb';
          ctx.strokeRect(el.x + 12, y, 14, 14);
          if (item.done) {
            ctx.fillStyle = '#4262ff';
            ctx.fillRect(el.x + 12, y, 14, 14);
            ctx.fillStyle = '#fff';
            ctx.fillText('✓', el.x + 15, y + 1);
          }
          ctx.fillStyle = item.done ? '#9aa3b2' : '#16161d';
          ctx.fillText(String(item.text || '').slice(0, 40), el.x + 34, y);
          y += 22;
          if (y > el.y + el.height - 10) break;
        }
        break;
      }

      case 'comment': {
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 10);
        ctx.fillStyle = style.backgroundColor || '#fff2b8';
        ctx.fill();
        ctx.fillStyle = '#6b7280';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText((el.author || 'You') + (el.resolved ? ' · resolved' : ''), el.x + 12, el.y + 10);
        this._text(ctx, el.content, el.x + 12, el.y + 28, el.width - 24, el.height - 36,
          { size: 13, color: '#16161d', align: 'left' });
        break;
      }

      case 'code': {
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 8);
        ctx.fillStyle = '#0f1117';
        ctx.fill();
        ctx.fillStyle = '#d6deeb';
        ctx.font = '12px "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let y = el.y + 12;
        for (const line of String(el.content || '').split('\n')) {
          ctx.fillText(line, el.x + 12, y);
          y += 18;
          if (y > el.y + el.height - 8) break;
        }
        break;
      }

      default: {
        this._roundRect(ctx, el.x, el.y, el.width, el.height, 6);
        ctx.fillStyle = '#eef1f6';
        ctx.fill();
        ctx.fillStyle = '#6b7280';
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(el.type, el.x + el.width / 2, el.y + el.height / 2);
      }
    }
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _text(ctx, text, x, y, maxW, maxH, o = {}) {
    if (!text) return;
    const size = o.size || 14;
    ctx.font = `${o.bold ? '700 ' : ''}${size}px Inter, -apple-system, sans-serif`;
    ctx.fillStyle = o.color || '#16161d';
    ctx.textBaseline = 'top';

    const lines = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const word of para.split(' ')) {
        const test = cur ? cur + ' ' + word : word;
        if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = word; }
        else cur = test;
      }
      lines.push(cur);
    }

    const lh = size * 1.42;
    let startY = y;
    if (o.middle) startY = (o.boxY ?? y) + ((o.boxH ?? maxH) - lines.length * lh) / 2;

    ctx.textAlign = o.align === 'center' ? 'center' : o.align === 'right' ? 'right' : 'left';
    const tx = o.align === 'center' ? x + maxW / 2 : o.align === 'right' ? x + maxW : x;

    for (let i = 0; i < lines.length; i++) {
      const ly = startY + i * lh;
      if (maxH && ly > y + maxH) break;
      ctx.fillText(lines[i], tx, ly);
    }
  }

  _loadImage(src) {
    return new Promise(resolve => {
      if (!src) return resolve(null);
      const img = new Image();
      if (!src.startsWith('data:') && !src.startsWith('blob:')) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => resolve(img);
      img.onerror = () => {
        // Fallback without crossOrigin
        const img2 = new Image();
        img2.onload = () => resolve(img2);
        img2.onerror = () => resolve(null);
        img2.src = src;
      };
      img.src = src;
    });
  }

  /* ---- SVG --------------------------------------------------------- */

  svg() {
    try {
      const bounds = this._bounds(false);
      if (!bounds) { Modal.toast('Nothing on the board to export yet.', 'warn'); return; }

      const parts = [];
      parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(bounds.w)}" height="${Math.round(bounds.h)}" viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}">`);
      parts.push(`<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="#f4f5f8"/>`);

      // ink
      for (const s of this.store.strokes) {
        if (!s.points?.length) continue;
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        parts.push(`<path d="${d}" fill="none" stroke="${s.color || '#16161d'}" stroke-width="${s.width || 3}" stroke-linecap="round" stroke-linejoin="round"${s.tool === 'highlighter' ? ' opacity="0.35"' : ''}/>`);
      }

      // connections (straight from the live DOM so routing matches exactly)
      for (const conn of this.store.connections) {
        const g = this.app.connections?.groups?.get(conn.id);
        if (!g || g.style.display === 'none') continue;
        parts.push(g.innerHTML.replace(/class="conn-hit"[^>]*>/g, 'class="conn-hit" fill="none" stroke="none">'));
      }

      // elements
      const els = this.store.elements.filter(e => !e.hidden)
        .slice().sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

      for (const el of els) {
        const style = el.style || {};
        const rot = el.rotation
          ? ` transform="rotate(${el.rotation} ${el.x + el.width / 2} ${el.y + el.height / 2})"` : '';
        parts.push(`<g${rot} opacity="${style.opacity != null ? style.opacity : 1}">`);

        if (el.type === 'shape' || el.type === 'flowchart') {
          const table = el.type === 'shape' ? SHAPE_PATHS : FLOWCHART_PATHS;
          const key = el.type === 'shape' ? (el.shapeType || 'rectangle') : (el.fcType || 'process');
          const d = (table[key] || table.rectangle || table.process)();
          parts.push(`<g transform="translate(${el.x},${el.y}) scale(${el.width / 100},${el.height / 100})">` +
            `<path d="${d}" fill="${style.backgroundColor || 'none'}" stroke="${style.borderColor || '#16161d'}" stroke-width="${style.borderWidth ?? 2}" vector-effect="non-scaling-stroke"/></g>`);
          const label = el.content || (el.type === 'flowchart' ? FLOWCHART_LABELS[key] : '');
          if (label) parts.push(this._svgText(label, el, style, 'center'));
        } else if (el.type === 'image') {
          parts.push(`<image href="${Util.escapeHTML(el.src || '')}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" preserveAspectRatio="xMidYMid meet"/>`);
        } else if (el.type === 'mindmap') {
          const bg = style.backgroundColor || '#4262ff';
          parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.height / 2}" fill="${bg}"/>`);
          parts.push(this._svgText(el.content || 'Topic', el, { ...style, color: Util.readableText(bg) }, 'center'));
        } else if (el.type === 'frame') {
          parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="rgba(255,255,255,.5)" stroke="#b6bdcb" stroke-width="2" stroke-dasharray="8 5"/>`);
          parts.push(`<text x="${el.x}" y="${el.y - 7}" font-family="Inter,sans-serif" font-size="13" font-weight="600" fill="#6b7280">${Util.escapeHTML(el.content || 'Frame')}</text>`);
        } else if (el.type === 'code') {
          parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="8" fill="#0f1117" stroke="#1f2430"/>`);
          parts.push(this._svgText(el.content || '', el, { ...style, color: '#d6deeb', fontSize: 12 }, 'left'));
        } else {
          const bg = style.backgroundColor ||
            (el.type === 'algorithm' ? (AlgorithmManager.THEMES[el.algoTheme] || AlgorithmManager.THEMES.dark).bg : '#ffffff');
          parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="8" fill="${bg}" stroke="#e3e6ec"/>`);
          const txt = el.type === 'algorithm'
            ? (el.algoSteps || []).map(s => s.text || '').join('\n')
            : (el.content || el.graphTitle || '');
          if (txt) parts.push(this._svgText(txt, el, style, style.align || 'left'));
        }
        parts.push('</g>');
      }

      parts.push('</svg>');
      Util.download(new Blob([parts.join('\n')], { type: 'image/svg+xml' }),
        Util.safeName(this.store.state.name) + '.svg');
      Modal.toast('SVG exported successfully.', 'success');
    } catch (err) {
      console.error('[export] SVG export failed', err);
      Modal.toast('Could not export SVG: ' + (err.message || 'unknown error'), 'warn');
    }
  }

  _svgText(text, el, style, align) {
    const size = style.fontSize || 14;
    const color = style.color || Util.readableText(style.backgroundColor);
    const lines = String(text || '').split('\n');
    const lh = size * 1.4;
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const x = align === 'center' ? el.x + el.width / 2 : align === 'right' ? el.x + el.width - 10 : el.x + 12;
    const y0 = align === 'center'
      ? el.y + el.height / 2 - (lines.length - 1) * lh / 2 + size * 0.35
      : el.y + 14 + size * 0.8;
    return `<text font-family="Inter,-apple-system,sans-serif" font-size="${size}" fill="${color}" text-anchor="${anchor}">` +
      lines.map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${Util.escapeHTML(l)}</tspan>`).join('') +
      '</text>';
  }

  /** Opens a print dialog with the board image — the practical "PDF" path. */
  async pdf() {
    try {
      const bounds = this._bounds(false);
      if (!bounds) { Modal.toast('Nothing on the board to export yet.', 'warn'); return; }
      const s = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bounds.w * s));
      canvas.height = Math.max(1, Math.round(bounds.h * s));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(s, 0, 0, s, -bounds.x * s, -bounds.y * s);
      await this.paintBoard(ctx, false);

      const win = window.open('', '_blank');
      if (!win) { Modal.toast('Allow pop-ups to print or save as PDF.', 'warn'); return; }
      const landscape = bounds.w >= bounds.h;
      win.document.write(
        `<html><head><title>${Util.escapeHTML(this.store.state.name)}</title>` +
        `<style>@page{size:${landscape ? 'landscape' : 'portrait'};margin:10mm}` +
        `body{margin:0}img{width:100%}</style></head><body>` +
        `<img src="${canvas.toDataURL('image/png')}" onload="window.focus();window.print()"/>` +
        `</body></html>`
      );
      win.document.close();
    } catch (err) {
      console.error('[export] PDF print failed', err);
      Modal.toast('Could not generate PDF print view.', 'warn');
    }
  }

  /* ---- Markdown ------------------------------------------------------ */

  /**
   * Reading order = frames first (each becomes a heading with the elements
   * inside it), then everything that sits loose on the board, top-to-bottom
   * and left-to-right. Mind maps become nested bullet lists.
   */
  markdown() {
    try {
      const store = this.store;
      const lines = ['# ' + (store.state.name || 'Untitled Board'), ''];
      const used = new Set();

      const inside = (frame, el) => Util.rectContains(
        { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        { x: el.x, y: el.y, w: el.width, h: el.height });

      const readingOrder = list => list.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));

      const emit = el => {
        if (used.has(el.id)) return;
        used.add(el.id);
        switch (el.type) {
          case 'text':
            lines.push((el.style?.fontSize || 20) >= 24 ? '## ' + (el.content || '') : (el.content || ''), '');
            break;
          case 'sticky-note': case 'comment':
            lines.push('> ' + String(el.content || '').replace(/\n/g, '\n> '), '');
            break;
          case 'checklist':
            lines.push('**' + (el.content || 'Checklist') + '**');
            for (const it of (el.items || [])) lines.push(`- [${it.done ? 'x' : ' '}] ${it.text || ''}`);
            lines.push('');
            break;
          case 'table': {
            const d = el.tableData || { rows: 0, cols: 0, cells: [] };
            for (let r = 0; r < d.rows; r++) {
              const row = [];
              for (let c = 0; c < d.cols; c++) row.push(String(d.cells?.[r]?.[c] ?? '').replace(/\|/g, '\\|'));
              lines.push('| ' + row.join(' | ') + ' |');
              if (r === 0) lines.push('| ' + row.map(() => '---').join(' | ') + ' |');
            }
            lines.push('');
            break;
          }
          case 'code':
            lines.push('```' + (el.language || ''), String(el.content || ''), '```', '');
            break;
          case 'algorithm':
            lines.push('**' + (el.content || 'Algorithm') + '**', '```',
              (el.algoSteps || []).map(s => s.text || '').join('\n'), '```', '');
            break;
          case 'flowchart': case 'shape':
            if (el.content) lines.push('- ' + el.content);
            break;
          case 'graph':
            lines.push('**' + (el.graphTitle || 'Chart') + '**', '', '| Label | Value |', '| --- | --- |');
            for (const d of (el.graphData || [])) lines.push(`| ${d.label} | ${d.value} |`);
            lines.push('');
            break;
          case 'mindmap': {
            if (el.mmParent) break;                    // only roots start a tree
            const walk = (id, depth) => {
              const n = store.get(id);
              if (!n) return;
              used.add(id);
              lines.push('  '.repeat(depth) + '- ' + (n.content || 'Topic'));
              for (const cid of (n.mmChildren || [])) walk(cid, depth + 1);
            };
            walk(el.id, 0);
            lines.push('');
            break;
          }
          default: break;
        }
      };

      const frames = readingOrder(store.elements.filter(e => e.type === 'frame'));
      for (const f of frames) {
        used.add(f.id);
        lines.push('## ' + (f.content || 'Frame'), '');
        for (const el of readingOrder(store.elements.filter(e => e.type !== 'frame' && inside(f, e)))) emit(el);
      }
      const loose = readingOrder(store.elements.filter(e => !used.has(e.id)));
      if (loose.length && frames.length) lines.push('## Loose notes', '');
      for (const el of loose) emit(el);

      Util.download(new Blob([lines.join('\n')], { type: 'text/markdown' }),
        Util.safeName(store.state.name) + '.md');
      Modal.toast('Board exported as Markdown.', 'success');
    } catch (err) {
      console.error('[export] Markdown export failed', err);
      Modal.toast('Could not export Markdown.', 'warn');
    }
  }

  /* ---- CSV ----------------------------------------------------------- */

  /** Every table and chart on the board, concatenated into one CSV. */
  csv() {
    const esc = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const blocks = [];
    for (const el of this.store.elements) {
      if (el.type === 'table') {
        const d = el.tableData || { rows: 0, cols: 0, cells: [] };
        const rows = [];
        for (let r = 0; r < d.rows; r++) {
          const row = [];
          for (let c = 0; c < d.cols; c++) row.push(esc(d.cells?.[r]?.[c] ?? ''));
          rows.push(row.join(','));
        }
        blocks.push('# ' + (el.content || 'Table') + '\n' + rows.join('\n'));
      } else if (el.type === 'graph') {
        const rows = ['label,value'];
        for (const d of (el.graphData || [])) rows.push(esc(d.label) + ',' + esc(d.value));
        blocks.push('# ' + (el.graphTitle || 'Chart') + '\n' + rows.join('\n'));
      } else if (el.type === 'checklist') {
        const rows = ['done,item'];
        for (const it of (el.items || [])) rows.push((it.done ? 'yes' : 'no') + ',' + esc(it.text));
        blocks.push('# ' + (el.content || 'Checklist') + '\n' + rows.join('\n'));
      }
    }
    if (!blocks.length) { Modal.toast('No tables, charts or checklists to export.', 'warn'); return; }
    Util.download(new Blob([blocks.join('\n\n')], { type: 'text/csv' }),
      Util.safeName(this.store.state.name) + '.csv');
    Modal.toast('CSV exported.', 'success');
  }
}

/* ================================================================
   BoardLibrary — save / open / delete boards on the server
   ================================================================ */
class BoardLibrary {
  constructor(app) { this.app = app; }

  async open() {
    const isCloud = window.FirebaseSync && window.FirebaseSync.isLoggedIn;
    const body = document.createElement('div');
    body.innerHTML = '<div class="board-list"><p class="muted">Loading boards…</p></div>';
    const handle = Modal.open({
      title: isCloud ? '☁️ My Cloud Boards (Firebase)' : '📁 Saved Boards',
      width: 640,
      body,
      actions: [{ label: 'Close' }],
    });

    let cloudBoards = [];
    let serverBoards = [];

    // 1. Fetch Cloud Boards from Firebase Firestore
    if (isCloud) {
      try {
        cloudBoards = await window.FirebaseSync.listBoards();
      } catch (e) {
        console.warn('Firebase list error:', e);
      }
    }

    // 2. Fetch Server Boards
    try {
      const res = await fetch('/api/boards');
      if (res.ok) serverBoards = await res.json();
    } catch (_) { /* offline */ }

    // Merge boards (cloud boards take priority)
    const seenIds = new Set();
    const boards = [];

    for (const cb of cloudBoards) {
      seenIds.add(cb.id);
      boards.push({ ...cb, isCloud: true });
    }
    for (const sb of serverBoards) {
      if (!seenIds.has(sb.id)) {
        boards.push({ ...sb, isCloud: false });
      }
    }

    const list = body.querySelector('.board-list');
    list.textContent = '';

    const newBtn = document.createElement('button');
    newBtn.className = 'board-card board-new';
    newBtn.type = 'button';
    newBtn.innerHTML = '<span class="board-icon">＋</span><span><strong>New board</strong><small>Start fresh canvas</small></span>';
    newBtn.addEventListener('click', () => { handle.close(); this.app.newBoard(); });
    list.appendChild(newBtn);

    if (!boards.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = isCloud
        ? 'No saved boards in your Firebase Cloud account yet. Click "Save" to sync your first board!'
        : 'No saved boards yet. Sign in with Google to enable automatic cloud backup.';
      list.appendChild(p);
    }

    for (const b of boards) {
      const card = document.createElement('div');
      card.className = 'board-card';
      const cloudBadge = b.isCloud ? '<span class="cloud-pill" title="Synced in Firebase Cloud"><i class="ph-bold ph-cloud-check"></i></span>' : '';
      const hashBadge = b.dataHash ? `<small class="mono" style="opacity:.65;font-size:10px" title="SHA-256 Integrity: ${b.dataHash}">🔒 SHA-256: ${b.dataHash.slice(0, 8)}…</small>` : '';

      card.innerHTML =
        `<span class="board-icon">${b.isCloud ? '☁️' : '🗂'}</span>` +
        `<span style="flex:1"><strong>${Util.escapeHTML(b.name || 'Untitled')} ${cloudBadge}</strong>` +
        `<small>${b.element_count || 0} items · ${new Date(b.updated_at || Date.now()).toLocaleString()}</small>` +
        `${hashBadge}</span>`;

      const del = document.createElement('button');
      del.className = 'board-del';
      del.type = 'button';
      del.title = 'Delete board';
      del.textContent = '🗑';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        if (!await Modal.confirm(`Delete “${b.name}”? This cannot be undone.`, { title: 'Delete board', confirmLabel: 'Delete' })) return;
        if (b.isCloud && window.FirebaseSync) {
          await window.FirebaseSync.deleteBoard(b.id);
        }
        await fetch('/api/board/' + b.id, { method: 'DELETE' }).catch(() => {});
        card.remove();
        Modal.toast('Board deleted.', 'success');
      });
      card.appendChild(del);

      card.addEventListener('click', async () => {
        handle.close();
        await this.app.loadBoard(b.id);
      });
      list.appendChild(card);
    }
  }
}

window.Exporter = Exporter;
window.BoardLibrary = BoardLibrary;
