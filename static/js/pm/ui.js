/* ================================================================
   pm/ui.js — Shared UI atoms for the project-management layer
   ----------------------------------------------------------------
   Small, dumb, reusable. An atom renders markup or returns an element;
   it never reads the WorkStore and never writes to it. Views own the
   data flow, atoms own the pixels — so an avatar looks identical in
   the List view, the Board card, the Timeline bar and the canvas.

   Popovers here all share one dismissal owner (`Pop.close()`), which
   is what stops the classic bug where two pickers are open at once and
   the second one's outside-click handler eats the first one's click.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;
  const esc = global.Util ? global.Util.escapeHTML : (s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  /* ------------------------------------------------------------------
     Element helper — terser than document.createElement chains and it
     keeps the markup readable inside view code.
     ------------------------------------------------------------------ */

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'data' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /* ------------------------------------------------------------------
     Avatars
     ------------------------------------------------------------------ */

  /** @param {object} member  a PMSchema member record */
  function avatarHTML(member, size = 24) {
    if (!member) {
      return `<span class="pm-av pm-av-empty" style="--av:${size}px" title="Unassigned"><i class="ph ph-user"></i></span>`;
    }
    const title = esc(`${member.name || member.email}${member.status === 'invited' ? ' · invited' : ''}`);
    const ring = member.status === 'invited' ? ' is-invited' : '';
    if (member.photoURL) {
      return `<img class="pm-av${ring}" style="--av:${size}px" src="${esc(member.photoURL)}" alt="" title="${title}" loading="lazy" />`;
    }
    return `<span class="pm-av${ring}" style="--av:${size}px;background:${member.color || S.avatarColor(member.email || '')}" title="${title}">${esc(S.initialsOf(member))}</span>`;
  }

  /**
   * Overlapping avatars with a "+n" overflow chip.
   * `members` may contain nulls for assignees who have left the project;
   * they render as the empty slot rather than breaking the row.
   */
  function avatarStackHTML(members, { max = 3, size = 24 } = {}) {
    if (!members || !members.length) return avatarHTML(null, size);
    const shown = members.slice(0, max);
    const rest = members.length - shown.length;
    const parts = shown.map(m => avatarHTML(m, size));
    if (rest > 0) {
      parts.push(`<span class="pm-av pm-av-more" style="--av:${size}px" title="${rest} more">+${rest}</span>`);
    }
    return `<span class="pm-av-stack">${parts.join('')}</span>`;
  }

  /* ------------------------------------------------------------------
     Chips
     ------------------------------------------------------------------ */

  function statusPillHTML(status, { compact = false } = {}) {
    if (!status) return '';
    return `<span class="pm-status-pill${compact ? ' is-compact' : ''}" style="--st:${status.color}">
      <span class="pm-status-dot"></span>${compact ? '' : esc(status.name)}
    </span>`;
  }

  function priorityChipHTML(priorityId, { compact = false } = {}) {
    const p = S.PRIORITY_BY_ID[priorityId];
    if (!p) return compact ? '' : '<span class="pm-prio is-none" title="No priority"><i class="ph ph-flag"></i></span>';
    return `<span class="pm-prio" style="--pc:${p.color}" title="${esc(p.name)} priority">
      <i class="ph-fill ${p.icon}"></i>${compact ? '' : esc(p.name)}
    </span>`;
  }

  /** Due date, coloured by urgency. Returns '' for an undated task. */
  function dueChipHTML(project, task) {
    if (!task.dueDate) return '';
    const overdue = S.isOverdue(project, task);
    const soon = S.isDueSoon(project, task);
    const cls = overdue ? 'is-overdue' : soon ? 'is-soon' : '';
    const time = task.dueTime ? ` ${esc(task.dueTime)}` : '';
    return `<span class="pm-due ${cls}" title="Due ${esc(task.dueDate)}${time}">
      <i class="ph ${overdue ? 'ph-warning-circle' : 'ph-calendar-blank'}"></i>${esc(S.formatDueDate(task.dueDate))}
    </span>`;
  }

  function tagChipHTML(tag) {
    return `<span class="pm-tag" style="--tg:${S.avatarColor(tag)}">${esc(tag)}</span>`;
  }

  function progressBarHTML(pct, { color = 'var(--clr-primary)', height = 4 } = {}) {
    return `<span class="pm-progress" style="--ph:${height}px"><span class="pm-progress-fill" style="width:${S.clamp(pct, 0, 100)}%;background:${color}"></span></span>`;
  }

  /* ------------------------------------------------------------------
     Popover host

     One popover at a time, positioned against an anchor element and
     flipped into the viewport when it would overflow.
     ------------------------------------------------------------------ */

  const Pop = {
    _el: null,
    _onClose: null,
    _anchor: null,

    open(anchor, content, { align = 'start', side = 'bottom', width = null, className = '' } = {}) {
      this.close();

      const el = h('div', { class: `pm-pop ${className}`, role: 'dialog' });
      if (width) el.style.width = typeof width === 'number' ? width + 'px' : width;
      el.append(content);
      document.body.append(el);

      this._el = el;
      this._anchor = anchor;
      this.position(side, align);

      // Deferred so the click that opened the popover does not
      // immediately close it.
      setTimeout(() => {
        document.addEventListener('pointerdown', this._outside, true);
        document.addEventListener('keydown', this._onKey, true);
      }, 0);
      window.addEventListener('resize', this._reposition, true);
      window.addEventListener('scroll', this._reposition, true);

      const focusable = el.querySelector('input, textarea, button, [tabindex]');
      if (focusable) focusable.focus();
      return el;
    },

    position(side = 'bottom', align = 'start') {
      const el = this._el, anchor = this._anchor;
      if (!el || !anchor) return;
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const pad = 8;

      let top = side === 'top' ? a.top - r.height - 6 : a.bottom + 6;
      let left = align === 'end' ? a.right - r.width : align === 'center' ? a.left + a.width / 2 - r.width / 2 : a.left;

      // Flip rather than clip: a picker half off the bottom of the
      // screen is unusable, but one above the anchor reads fine.
      if (top + r.height > innerHeight - pad) {
        const above = a.top - r.height - 6;
        top = above > pad ? above : Math.max(pad, innerHeight - r.height - pad);
      }
      if (top < pad) top = pad;
      left = S.clamp(left, pad, Math.max(pad, innerWidth - r.width - pad));

      el.style.top = top + 'px';
      el.style.left = left + 'px';
    },

    _reposition: () => Pop.position(),

    _outside: (e) => {
      if (!Pop._el) return;
      if (Pop._el.contains(e.target)) return;
      if (Pop._anchor && Pop._anchor.contains(e.target)) return;
      Pop.close();
    },

    _onKey: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); Pop.close(); }
    },

    close() {
      if (!this._el) return;
      document.removeEventListener('pointerdown', this._outside, true);
      document.removeEventListener('keydown', this._onKey, true);
      window.removeEventListener('resize', this._reposition, true);
      window.removeEventListener('scroll', this._reposition, true);
      this._el.remove();
      this._el = null;
      this._anchor = null;
      if (this._onClose) { const fn = this._onClose; this._onClose = null; fn(); }
    },

    get isOpen() { return !!this._el; },
  };

  /* ------------------------------------------------------------------
     Menu — a list of actions
     ------------------------------------------------------------------ */

  function menu(anchor, items, opts = {}) {
    const list = h('div', { class: 'pm-menu' });
    for (const it of items) {
      if (it === '-' || it?.divider) { list.append(h('div', { class: 'pm-menu-sep' })); continue; }
      if (it.header) { list.append(h('div', { class: 'pm-menu-header', text: it.header })); continue; }

      const row = h('button', {
        type: 'button',
        class: `pm-menu-item${it.danger ? ' is-danger' : ''}${it.checked ? ' is-checked' : ''}${it.disabled ? ' is-disabled' : ''}`,
        disabled: !!it.disabled,
        onclick: (e) => {
          e.stopPropagation();
          if (it.disabled) return;
          if (!it.keepOpen) Pop.close();
          it.onClick?.(e);
        },
      }, [
        h('i', { class: `ph ${it.icon || 'ph-dot'}` }),
        h('span', { class: 'pm-menu-label', text: it.label }),
        it.hint ? h('kbd', { class: 'pm-menu-hint', text: it.hint }) : null,
        it.checked ? h('i', { class: 'ph ph-check pm-menu-check' }) : null,
      ]);
      list.append(row);
    }
    return Pop.open(anchor, list, { width: opts.width || 220, align: opts.align, side: opts.side, className: 'pm-pop-menu' });
  }

  /* ------------------------------------------------------------------
     Member picker — the thing the old build had no way to do at all
     ------------------------------------------------------------------ */

  /**
   * @param {HTMLElement} anchor
   * @param {object[]} members    project member records
   * @param {string[]} selected   member keys (uid or email)
   * @param {(keys:string[]) => void} onChange  fired on every toggle
   */
  function memberPicker(anchor, members, selected, onChange, { multi = true, title = 'Assign to' } = {}) {
    let picked = [...selected];
    const active = members.filter(m => m.status !== 'removed');

    const search = h('input', { class: 'pm-pop-search input', placeholder: 'Search people…', type: 'text' });
    const listEl = h('div', { class: 'pm-pick-list' });
    const wrap = h('div', {}, [
      h('div', { class: 'pm-pop-title', text: title }),
      search,
      listEl,
    ]);

    function keyOf(m) { return m.uid || m.email; }

    function draw(filter = '') {
      listEl.innerHTML = '';
      const q = filter.trim().toLowerCase();
      const hits = active.filter(m =>
        !q || (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q));

      if (!hits.length) {
        listEl.append(h('div', { class: 'pm-pick-empty', text: 'Nobody matches that.' }));
      }

      for (const m of hits) {
        const k = keyOf(m);
        const on = picked.includes(k);
        const row = h('button', {
          type: 'button',
          class: `pm-pick-row${on ? ' is-on' : ''}`,
          onclick: () => {
            if (multi) picked = on ? picked.filter(x => x !== k) : [...picked, k];
            else picked = on ? [] : [k];
            onChange(picked);
            if (!multi) { Pop.close(); return; }
            draw(search.value);
          },
        }, [
          h('span', { class: 'pm-pick-av', html: avatarHTML(m, 26) }),
          h('span', { class: 'pm-pick-meta' }, [
            h('strong', { text: m.name || m.email }),
            h('small', { text: `${m.email}${m.status === 'invited' ? ' · invited' : ''}` }),
          ]),
          h('i', { class: `ph ${on ? 'ph-check-circle' : 'ph-circle'} pm-pick-tick` }),
        ]);
        listEl.append(row);
      }

      if (multi && picked.length) {
        listEl.append(h('button', {
          type: 'button', class: 'pm-pick-clear',
          onclick: () => { picked = []; onChange(picked); draw(search.value); },
        }, [h('i', { class: 'ph ph-x' }), 'Clear all']));
      }
    }

    search.addEventListener('input', () => draw(search.value));
    draw();
    return Pop.open(anchor, wrap, { width: 260, className: 'pm-pop-pick' });
  }

  /* ------------------------------------------------------------------
     Status picker
     ------------------------------------------------------------------ */

  function statusPicker(anchor, statuses, currentId, onPick) {
    return menu(anchor, statuses.map(s => ({
      label: s.name,
      icon: 'ph-circle',
      checked: s.id === currentId,
      onClick: () => onPick(s.id),
    })), { width: 200 });
  }

  function priorityPicker(anchor, current, onPick) {
    const items = S.PRIORITIES.slice().reverse().map(p => ({
      label: p.name, icon: p.icon, checked: current === p.id, onClick: () => onPick(p.id),
    }));
    items.push('-', { label: 'No priority', icon: 'ph-prohibit', checked: !current, onClick: () => onPick(null) });
    return menu(anchor, items, { width: 190 });
  }

  /* ------------------------------------------------------------------
     Date picker — a real month grid, because a bare <input type=date>
     cannot show "3 tasks due that day" or offer Tomorrow / Next week.
     ------------------------------------------------------------------ */

  function datePicker(anchor, currentISO, onPick, { allowClear = true, title = 'Due date', withTime = false, currentTime = null } = {}) {
    let cursor = S.parseDate(currentISO) || new Date();
    cursor.setDate(1);
    let time = currentTime || '';

    const head = h('div', { class: 'pm-cal-head' });
    const grid = h('div', { class: 'pm-cal-grid' });
    const quick = h('div', { class: 'pm-cal-quick' });
    const timeRow = withTime ? h('div', { class: 'pm-cal-time' }) : null;

    const wrap = h('div', {}, [
      h('div', { class: 'pm-pop-title', text: title }),
      quick, head, grid, timeRow,
    ].filter(Boolean));

    function iso(d) {
      // Local-date formatting: toISOString() would shift the day for
      // anyone west of UTC, which silently books tasks a day early.
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function commit(value) {
      onPick(value, withTime ? (time || null) : undefined);
      if (!withTime) Pop.close();
      else drawAll();
    }

    function drawQuick() {
      quick.innerHTML = '';
      const now = new Date();
      const mk = (label, offsetDays) => {
        const d = new Date(now);
        d.setDate(now.getDate() + offsetDays);
        return h('button', { type: 'button', class: 'pm-cal-chip', text: label, onclick: () => commit(iso(d)) });
      };
      quick.append(mk('Today', 0), mk('Tomorrow', 1), mk('Next week', 7));
      if (allowClear && currentISO) {
        quick.append(h('button', {
          type: 'button', class: 'pm-cal-chip is-clear',
          onclick: () => { time = ''; commit(null); },
        }, [h('i', { class: 'ph ph-x' }), 'Clear']));
      }
    }

    function drawHead() {
      head.innerHTML = '';
      head.append(
        h('button', { type: 'button', class: 'pm-cal-nav', onclick: () => { cursor.setMonth(cursor.getMonth() - 1); drawGrid(); } },
          [h('i', { class: 'ph ph-caret-left' })]),
        h('strong', { text: cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
        h('button', { type: 'button', class: 'pm-cal-nav', onclick: () => { cursor.setMonth(cursor.getMonth() + 1); drawGrid(); } },
          [h('i', { class: 'ph ph-caret-right' })]),
      );
    }

    function drawGrid() {
      drawHead();
      grid.innerHTML = '';
      for (const d of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
        grid.append(h('span', { class: 'pm-cal-dow', text: d }));
      }

      const first = new Date(cursor);
      const lead = (first.getDay() + 6) % 7;           // Monday-first
      const start = new Date(first);
      start.setDate(1 - lead);

      const todayISO = iso(new Date());
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dISO = iso(d);
        const cls = [
          'pm-cal-day',
          d.getMonth() !== cursor.getMonth() ? 'is-out' : '',
          dISO === todayISO ? 'is-today' : '',
          dISO === currentISO ? 'is-sel' : '',
        ].filter(Boolean).join(' ');
        grid.append(h('button', { type: 'button', class: cls, text: d.getDate(), onclick: () => commit(dISO) }));
      }
    }

    function drawTime() {
      if (!timeRow) return;
      timeRow.innerHTML = '';
      const inp = h('input', { type: 'time', class: 'input', value: time || '' });
      inp.addEventListener('change', () => {
        time = inp.value;
        onPick(currentISO || iso(new Date()), time || null);
      });
      timeRow.append(h('label', { class: 'pm-cal-time-lbl' }, ['Time', inp]),
        h('button', { type: 'button', class: 'btn btn-primary pm-cal-done', text: 'Done', onclick: () => Pop.close() }));
    }

    function drawAll() { drawQuick(); drawGrid(); drawTime(); }
    drawAll();
    return Pop.open(anchor, wrap, { width: 268, className: 'pm-pop-cal' });
  }

  /* ------------------------------------------------------------------
     Tag editor
     ------------------------------------------------------------------ */

  function tagPicker(anchor, allTags, selected, onChange) {
    let picked = [...selected];
    const input = h('input', { class: 'pm-pop-search input', placeholder: 'Add or search a tag…' });
    const listEl = h('div', { class: 'pm-pick-list' });
    const wrap = h('div', {}, [h('div', { class: 'pm-pop-title', text: 'Tags' }), input, listEl]);

    function draw() {
      listEl.innerHTML = '';
      const q = input.value.trim().toLowerCase();
      const pool = [...new Set([...allTags, ...picked])].filter(t => !q || t.toLowerCase().includes(q));

      for (const t of pool.sort()) {
        const on = picked.includes(t);
        listEl.append(h('button', {
          type: 'button', class: `pm-pick-row${on ? ' is-on' : ''}`,
          onclick: () => { picked = on ? picked.filter(x => x !== t) : [...picked, t]; onChange(picked); draw(); },
        }, [
          h('span', { class: 'pm-tag', style: { '--tg': S.avatarColor(t) }, text: t }),
          h('i', { class: `ph ${on ? 'ph-check-circle' : 'ph-circle'} pm-pick-tick` }),
        ]));
      }

      const q2 = input.value.trim();
      if (q2 && !pool.some(t => t.toLowerCase() === q2.toLowerCase())) {
        listEl.append(h('button', {
          type: 'button', class: 'pm-pick-row is-create',
          onclick: () => { picked = [...picked, q2]; onChange(picked); input.value = ''; draw(); },
        }, [h('i', { class: 'ph ph-plus' }), `Create "${q2}"`]));
      }
    }

    input.addEventListener('input', draw);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      if (!v) return;
      if (!picked.includes(v)) picked = [...picked, v];
      onChange(picked);
      input.value = '';
      draw();
    });
    draw();
    return Pop.open(anchor, wrap, { width: 240, className: 'pm-pop-pick' });
  }

  /* ------------------------------------------------------------------
     Inline text editing — click a title, type, blur or Enter to save.
     Escape reverts, which people expect and almost no web app does.
     ------------------------------------------------------------------ */

  function editInline(el, value, onSave, { multiline = false, placeholder = '' } = {}) {
    const original = value;
    const input = multiline
      ? h('textarea', { class: 'pm-inline-edit', placeholder, rows: 3 })
      : h('input', { class: 'pm-inline-edit', type: 'text', placeholder });
    input.value = value;

    el.replaceChildren(input);
    input.focus();
    input.select?.();

    let settled = false;
    const finish = (save) => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      onSave(save && next !== original ? next : null, next);
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(true));

    if (multiline) {
      const grow = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
      input.addEventListener('input', grow);
      grow();
    }
    return input;
  }

  /* ------------------------------------------------------------------
     Confirm dialog — Promise-based, so callers read top to bottom.
     ------------------------------------------------------------------ */

  function confirm(message, { title = 'Are you sure?', okLabel = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
      const overlay = h('div', { class: 'pm-confirm-overlay' });
      const box = h('div', { class: 'pm-confirm' }, [
        h('h4', { text: title }),
        h('p', { text: message }),
        h('div', { class: 'pm-confirm-actions' }, [
          h('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', onclick: () => done(false) }),
          h('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: okLabel, onclick: () => done(true) }),
        ]),
      ]);
      overlay.append(box);
      overlay.addEventListener('pointerdown', e => { if (e.target === overlay) done(false); });
      document.body.append(overlay);
      box.querySelector('.btn-primary, .btn-danger')?.focus();

      const onKey = e => {
        if (e.key === 'Escape') done(false);
        if (e.key === 'Enter') done(true);
      };
      document.addEventListener('keydown', onKey, true);

      function done(v) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(v);
      }
    });
  }

  function toast(msg, kind = 'info', ms = 2600) {
    if (global.Modal?.toast) return global.Modal.toast(msg, kind, ms);
    console.log(`[pm:${kind}]`, msg);
  }

  /* ------------------------------------------------------------------
     Drag-and-drop kit

     HTML5 drag events are unreliable for a Kanban board (no drag image
     control on Firefox, no touch support). Pointer events with a
     manual ghost work everywhere, including tablets.
     ------------------------------------------------------------------ */

  function makeDraggable(el, { handle, data, onStart, onMove, onDrop, threshold = 4 } = {}) {
    const grip = handle ? el.querySelector(handle) : el;
    if (!grip) return () => {};

    let start = null, ghost = null, dragging = false;

    function down(e) {
      if (e.button !== 0) return;
      if (e.target.closest('input, textarea, button, a, select, .pm-no-drag')) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      grip.setPointerCapture(e.pointerId);
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    }

    function move(e) {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;

      if (!dragging) {
        if (Math.hypot(dx, dy) < threshold) return;   // a click, not a drag
        dragging = true;
        const r = el.getBoundingClientRect();
        ghost = el.cloneNode(true);
        ghost.classList.add('pm-drag-ghost');
        Object.assign(ghost.style, {
          position: 'fixed', width: r.width + 'px', left: r.left + 'px', top: r.top + 'px',
          pointerEvents: 'none', zIndex: 9999,
        });
        document.body.append(ghost);
        el.classList.add('pm-dragging');
        document.body.classList.add('pm-is-dragging');
        onStart?.(data, e);
      }

      ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(1.5deg)`;
      // The ghost sits under the cursor, so ask the document what is
      // beneath it with the ghost temporarily ignored.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      onMove?.(data, under, e);
    }

    function up(e) {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      try { grip.releasePointerCapture(e.pointerId); } catch {}

      if (dragging) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        ghost?.remove();
        el.classList.remove('pm-dragging');
        document.body.classList.remove('pm-is-dragging');
        onDrop?.(data, under, e);
      }
      start = null; ghost = null; dragging = false;
    }

    grip.addEventListener('pointerdown', down);
    return () => grip.removeEventListener('pointerdown', down);
  }

  /* ------------------------------------------------------------------
     Formatting helpers used across views
     ------------------------------------------------------------------ */

  function relativeTime(iso) {
    const d = S.parseDate(iso);
    if (!d) return '';
    const secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 45) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.round(secs / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /** Minimal, safe Markdown: bold, italic, code, links, @mentions, lists. */
  function renderRichText(text, members = []) {
    let out = esc(text || '');
    out = out.replace(/```([\s\S]*?)```/g, (_, c) => `<pre class="pm-code">${c.trim()}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    out = out.replace(/@([\w.+-]+@[\w-]+\.[\w.]+|[\w][\w.-]{1,30})/g, (m, handle) => {
      const hit = members.find(x =>
        (x.email || '').toLowerCase() === handle.toLowerCase() ||
        (x.name || '').toLowerCase().replace(/\s+/g, '') === handle.toLowerCase());
      return `<span class="pm-mention${hit ? ' is-known' : ''}">@${esc(hit?.name || handle)}</span>`;
    });

    out = out.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
    out = out.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul class="pm-rt-list">$1</ul>');
    return out.replace(/\n/g, '<br/>');
  }

  global.PMUI = {
    h, esc,
    avatarHTML, avatarStackHTML,
    statusPillHTML, priorityChipHTML, dueChipHTML, tagChipHTML, progressBarHTML,
    Pop, menu, memberPicker, statusPicker, priorityPicker, datePicker, tagPicker,
    editInline, confirm, toast, makeDraggable, relativeTime, renderRichText,
  };

})(window);
