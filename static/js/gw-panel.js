/* ================================================================
   gw-panel.js — Google Workspace browser inside the board
   ----------------------------------------------------------------
   Why this file exists.

   Attaching a Google Workspace file to a board object used to mean:
   open the project tab → navigate to Google Workspace → find the
   file → click "Attach to whiteboard". Three context-switches just
   to link one document.

   This module puts a dedicated panel directly on the canvas. One
   click opens a slide-out tray listing the user's Docs, Sheets,
   Slides, Calendar events and Tasks. Items are draggable: drop one
   on the board and it creates an element with the real Google
   product icon — a blue Docs icon, a green Sheets icon, a yellow
   Slides icon — not a generic sticky note. You can also drop it
   on an existing element to attach it.

   It reuses the same /api/google/* endpoints that pm/google.js
   talks to, so no new server code is needed.
   ================================================================ */

(function (global) {
  'use strict';

  /* ---- Google product SVG icons (inline, colour-accurate) ------------- */

  const GOOGLE_ICONS = {
    doc: `<svg viewBox="0 0 32 32" width="24" height="24"><path fill="#4285F4" d="M6 3a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V11l-8-8H6z"/><path fill="#F1F1F1" d="M20 3v8h8"/><path fill="#A1C2FA" d="M20 3l8 8h-8z"/><path fill="#F1F1F1" d="M9 17h14v1.5H9zm0 3h14v1.5H9zm0 3h10v1.5H9z"/></svg>`,
    sheet: `<svg viewBox="0 0 32 32" width="24" height="24"><path fill="#0F9D58" d="M6 3a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V11l-8-8H6z"/><path fill="#F1F1F1" d="M20 3v8h8"/><path fill="#87CEAC" d="M20 3l8 8h-8z"/><rect fill="#F1F1F1" x="8" y="16" width="16" height="10" rx="1"/><path fill="#0F9D58" d="M8 20h16v.5H8zm7.5 0v6h1v-6z"/></svg>`,
    slides: `<svg viewBox="0 0 32 32" width="24" height="24"><path fill="#F4B400" d="M6 3a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V11l-8-8H6z"/><path fill="#F1F1F1" d="M20 3v8h8"/><path fill="#F7D76E" d="M20 3l8 8h-8z"/><rect fill="#F1F1F1" x="8" y="16" width="16" height="10" rx="1.5"/></svg>`,
    calendar: `<svg viewBox="0 0 32 32" width="24" height="24"><rect fill="#4285F4" x="4" y="6" width="24" height="22" rx="2"/><rect fill="#fff" x="4" y="4" width="24" height="8" rx="2"/><rect fill="#EA4335" x="4" y="4" width="24" height="5" rx="2"/><circle fill="#4285F4" cx="10" cy="18" r="1.5"/><circle fill="#4285F4" cx="16" cy="18" r="1.5"/><circle fill="#4285F4" cx="22" cy="18" r="1.5"/><circle fill="#4285F4" cx="10" cy="23" r="1.5"/><circle fill="#4285F4" cx="16" cy="23" r="1.5"/><rect fill="#4285F4" x="9" y="2" width="2" height="5" rx="1"/><rect fill="#4285F4" x="21" y="2" width="2" height="5" rx="1"/></svg>`,
    task: `<svg viewBox="0 0 32 32" width="24" height="24"><circle fill="#4285F4" cx="16" cy="16" r="13"/><path fill="#fff" stroke="#fff" stroke-width="1" d="M12 16.5l3 3 6-7" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"/></svg>`,
    keep: `<svg viewBox="0 0 32 32" width="24" height="24"><path fill="#FBBC04" d="M16 3c-5 0-9 4-9 9 0 3.2 1.6 5.9 4 7.6V22a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.4c2.4-1.7 4-4.4 4-7.6 0-5-4-9-9-9z"/><rect fill="#E8710A" x="12.5" y="24.5" width="7" height="2.5" rx="1.2"/><rect fill="#E8710A" x="13.5" y="27.5" width="5" height="2" rx="1"/></svg>`,
  };
  global.GW_ICONS = GOOGLE_ICONS;

  /* ---- Google product colours for board elements ---------------------- */

  const PRODUCT_COLORS = {
    doc:      { bg: '#E8F0FE', border: '#4285F4', text: '#1A73E8', label: 'Google Doc' },
    sheet:    { bg: '#E6F4EA', border: '#0F9D58', text: '#137333', label: 'Google Sheet' },
    slides:   { bg: '#FEF7E0', border: '#F4B400', text: '#E37400', label: 'Google Slides' },
    calendar: { bg: '#E8F0FE', border: '#4285F4', text: '#1A73E8', label: 'Calendar Event' },
    task:     { bg: '#E8F0FE', border: '#4285F4', text: '#1A73E8', label: 'Google Task' },
    keep:     { bg: '#FEF7E0', border: '#FBBC04', text: '#B06000', label: 'Keep Note' },
  };

  /* ---- Phosphor icon classes for badge overlays ----------------------- */

  const PHOSPHOR_ICONS = {
    doc:      'ph-file-doc',
    sheet:    'ph-file-xls',
    slides:   'ph-projector-screen',
    calendar: 'ph-calendar-dots',
    task:     'ph-check-square',
    keep:     'ph-lightbulb-filament',
  };

  /* ---- sections shown in the panel, all loaded and visible at once ----- */

  const SECTIONS = [
    { id: 'docs',     label: 'Docs',     icon: GOOGLE_ICONS.doc,      fetch: (self, q) => self._fetchDocs(q, 'document') },
    { id: 'sheets',   label: 'Sheets',   icon: GOOGLE_ICONS.sheet,    fetch: (self, q) => self._fetchDocs(q, 'spreadsheet') },
    { id: 'slides',   label: 'Slides',   icon: GOOGLE_ICONS.slides,   fetch: (self, q) => self._fetchDocs(q, 'presentation') },
    { id: 'calendar', label: 'Calendar', icon: GOOGLE_ICONS.calendar, fetch: (self, q) => self._fetchCalendar(q) },
    { id: 'tasks',    label: 'Tasks',    icon: GOOGLE_ICONS.task,     fetch: (self, q) => self._fetchTasks(q) },
    { id: 'keep',     label: 'Keep',     icon: GOOGLE_ICONS.keep,     fetch: (self, q) => self._fetchKeep(q) },
  ];
  const CACHE_TTL_MS = 45000;

  /* ---- helper: API client (reuse pm/google.js api if available) -------- */

  async function apiGet(path, params) {
    const url = new URL(path, location.origin);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url);
    let body = {};
    try { body = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
    return body;
  }

  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 16);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString([], sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return 'Scheduled';
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const target = new Date(d); target.setHours(0, 0, 0, 0);
    const diff = Math.round((target - t) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /* ================================================================
     THE PANEL
     ================================================================ */

  class GWPanel {
    constructor(app) {
      this.app = app;
      this.isOpen = false;
      this.activeTab = 'docs';
      this._reqSeq = 0;
      this._cache = {};
      this._build();
    }

    /* ---- DOM structure ------------------------------------------------- */

    _build() {
      this.root = document.createElement('aside');
      this.root.id = 'gw-board-panel';
      this.root.className = 'gw-board-panel';
      this.root.innerHTML = `
        <div class="gwp-head">
          <div class="gwp-title">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"/><path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.98 0 12s.45 3.82 1.25 5.42l4.03-3.15z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/></svg>
            <span>Workspace</span>
          </div>
          <button type="button" class="gwp-close" title="Close (Esc)"><i class="ph ph-x"></i></button>
        </div>
        <nav class="gwp-tabs"></nav>
        <div class="gwp-search-wrap">
          <i class="ph ph-magnifying-glass"></i>
          <input type="search" class="gwp-search" placeholder="Search…" />
        </div>
        <div class="gwp-body"></div>
        <div class="gwp-footer">
          <span class="gwp-drag-hint"><i class="ph ph-hand-grabbing"></i> Drag items onto the board</span>
        </div>
      `;

      this.tabBar = this.root.querySelector('.gwp-tabs');
      this.searchInput = this.root.querySelector('.gwp-search');
      this.bodyEl = this.root.querySelector('.gwp-body');

      // Close button
      this.root.querySelector('.gwp-close').addEventListener('click', () => this.close());

      // Tabs are jump-to-section shortcuts — every section is always loaded
      // and visible in one scroll, per the "must display all workspace
      // features directly, not hidden behind clicks" requirement.
      for (const s of SECTIONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gwp-tab';
        btn.dataset.tab = s.id;
        btn.title = s.label;
        btn.innerHTML = `${s.icon}<span>${s.label}</span>`;
        btn.addEventListener('click', () => this._jumpTo(s.id));
        this.tabBar.appendChild(btn);
      }

      // Search filters the already-loaded sections client-side — instant,
      // and doesn't re-hit every Google API on each keystroke.
      let searchTimer;
      this.searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => this._renderSections(this._lastResults || [], this.searchInput.value.trim()), 120);
      });

      // Keyboard shortcut to close
      this.root.addEventListener('keydown', e => {
        if (e.key === 'Escape') { this.close(); e.stopPropagation(); }
      });

      // Wire up native drag-and-drop on the canvas for receiving items
      this._bindCanvasDrop();

      document.body.appendChild(this.root);
    }

    /* ---- open / close -------------------------------------------------- */

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    }

    async open() {
      // Check workspace connection first
      try {
        const status = await apiGet('/api/google/status');
        if (!status.connected) {
          if (global.GoogleAccount) {
            global.GoogleAccount.connect();
          } else {
            Modal?.toast('Connect your Google account first (click your profile button).', 'warn', 4000);
          }
          return;
        }
      } catch {
        Modal?.toast('Could not check Google connection status.', 'warn');
        return;
      }

      this.isOpen = true;
      this.root.classList.add('is-open');
      this._loadAll();
      this.searchInput.focus();
    }

    close() {
      this.isOpen = false;
      this.root.classList.remove('is-open');
    }

    /* ---- jump to a section (all sections are always loaded/visible) ---- */

    _jumpTo(id) {
      this.activeTab = id;
      for (const b of this.tabBar.children) b.classList.toggle('is-active', b.dataset.tab === id);
      this.bodyEl.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* ---- loading content ------------------------------------------------
       Every section loads in parallel (Promise.all) instead of one at a
       time behind a tab click, and each section's result is cached for a
       short TTL so reopening the panel or re-focusing search doesn't
       re-hit every Google API again — this is most of why the panel used
       to feel slow to open. One section failing (e.g. Keep not connected)
       no longer blanks out the rest of the panel. */

    async _loadAll(force = false) {
      const seq = ++this._reqSeq;
      if (!this._lastResults) {
        this.bodyEl.innerHTML = '<div class="gwp-loading"><div class="spinner"></div><span>Loading…</span></div>';
      }

      const now = Date.now();
      const results = await Promise.all(SECTIONS.map(async sec => {
        const cached = this._cache[sec.id];
        if (!force && cached && (now - cached.at) < CACHE_TTL_MS) {
          return { sec, items: cached.items, error: null };
        }
        try {
          const items = await sec.fetch(this, '');
          this._cache[sec.id] = { items, at: Date.now() };
          return { sec, items, error: null };
        } catch (err) {
          return { sec, items: cached ? cached.items : [], error: err };
        }
      }));

      if (seq !== this._reqSeq) return; // panel closed/reopened meanwhile
      this._lastResults = results;
      this._renderSections(results, this.searchInput.value.trim());
    }

    _renderSections(results, q) {
      this.bodyEl.textContent = '';
      const lq = q.toLowerCase();

      for (const { sec, items, error } of results) {
        const filtered = lq ? items.filter(it => (it.name || '').toLowerCase().includes(lq)) : items;

        const section = document.createElement('section');
        section.className = 'gwp-section';
        section.dataset.section = sec.id;

        const head = document.createElement('div');
        head.className = 'gwp-section-head';
        head.innerHTML = `${sec.icon}<strong>${sec.label}</strong><span class="gwp-section-count">${filtered.length}</span>`;
        if (sec.id === 'keep' && this.app?.keep) {
          const manage = document.createElement('button');
          manage.type = 'button';
          manage.className = 'gwp-section-manage';
          manage.title = 'Sign in, select multiple notes, or import in bulk';
          manage.innerHTML = '<i class="ph ph-gear-six"></i>';
          manage.addEventListener('click', () => this.app.keep.openModal());
          head.appendChild(manage);
        }
        section.appendChild(head);

        if (error) {
          const isAuthErr = error.status === 401 || error.status === 403;
          const errBox = document.createElement('div');
          errBox.className = 'gwp-error gwp-section-error';
          errBox.innerHTML = `<i class="ph-bold ph-warning-circle"></i><span>${escapeHTML(error.message || 'Could not load')}</span>`;
          if (isAuthErr) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-ghost gwp-reconnect';
            if (error.keepAuth) {
              btn.textContent = 'Connect Keep';
              btn.addEventListener('click', () => this.app?.keep?.openModal());
            } else {
              btn.textContent = 'Reconnect Google';
              btn.addEventListener('click', () => global.GoogleAccount?.connectWorkspace?.());
            }
            errBox.appendChild(btn);
          }
          section.appendChild(errBox);
        } else if (!filtered.length) {
          const empty = document.createElement('div');
          empty.className = 'gwp-empty gwp-section-empty';
          empty.innerHTML = `<span>${q ? 'No matches' : 'Nothing here yet'}</span>`;
          section.appendChild(empty);
        } else {
          const list = document.createElement('div');
          list.className = 'gwp-list';
          for (const item of filtered) list.appendChild(this._renderItem(item));
          section.appendChild(list);
        }

        this.bodyEl.appendChild(section);
      }
    }

    /* ---- data fetching ------------------------------------------------- */

    async _fetchDocs(q, type) {
      const data = await apiGet('/api/google/docs/list', { q, type });
      return (data.files || []).map(f => ({
        id: f.id,
        type: type === 'spreadsheet' ? 'sheet' : (type === 'presentation' ? 'slides' : 'doc'),
        name: f.name || 'Untitled',
        url: f.link,
        modified: f.modified,
        owner: f.owner || f.lastEditor || '',
        size: f.size,
        mimeType: f.mimeType,
        kind: f.kind,
        icon: f.icon,
      }));
    }

    async _fetchCalendar(q) {
      const data = await apiGet('/api/google/calendar/events');
      let events = data.events || [];
      if (q) {
        const lq = q.toLowerCase();
        events = events.filter(e =>
          (e.title || '').toLowerCase().includes(lq) ||
          (e.location || '').toLowerCase().includes(lq));
      }
      return events.map(e => ({
        id: e.id || e.link,
        type: 'calendar',
        name: e.title || 'Untitled event',
        url: e.link,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location,
        attendees: e.attendees,
      }));
    }

    async _fetchTasks(q) {
      const data = await apiGet('/api/google/tasks/list');
      const allTasks = [];
      for (const list of (data.lists || [])) {
        for (const t of (list.tasks || [])) {
          allTasks.push({
            id: t.id || t.title,
            type: 'task',
            name: t.title || 'Untitled task',
            url: t.link || '',
            due: t.due,
            listName: list.title,
            status: t.status,
          });
        }
      }
      if (q) {
        const lq = q.toLowerCase();
        return allTasks.filter(t =>
          t.name.toLowerCase().includes(lq) ||
          (t.listName || '').toLowerCase().includes(lq));
      }
      return allTasks;
    }

    /** Keep uses its own sign-in (a token stashed on the KeepIntegration
     *  instance, not the Workspace OAuth flow) — reuse whatever `app.keep`
     *  already holds instead of duplicating that auth here. */
    async _fetchKeep(q) {
      const ki = this.app?.keep;
      if (!ki || !ki.token || !ki.email) {
        throw Object.assign(new Error('Not connected to Google Keep.'), { status: 401, keepAuth: true });
      }
      const res = await fetch('/api/keep/notes', {
        headers: { 'X-Keep-Token': ki.token, 'X-Keep-Email': ki.email },
      });
      let body = null;
      try { body = await res.json(); } catch {}
      if (!res.ok) {
        throw Object.assign(new Error((body && body.error) || res.statusText), { status: res.status, keepAuth: true });
      }
      const notes = Array.isArray(body) ? body : [];
      const out = notes.map(n => ({
        id: n.id,
        type: 'keep',
        name: n.title || (n.content || '').slice(0, 60) || 'Untitled note',
        content: n.content || '',
        color: n.color,
      }));
      if (!q) return out;
      const lq = q.toLowerCase();
      return out.filter(n => n.name.toLowerCase().includes(lq) || n.content.toLowerCase().includes(lq));
    }

    /* ---- rendering items ----------------------------------------------- */

    _renderItem(item) {
      const row = document.createElement('div');
      row.className = 'gwp-item';
      row.draggable = true;
      row.dataset.gwItem = JSON.stringify(item);

      const colors = PRODUCT_COLORS[item.type] || PRODUCT_COLORS.doc;
      const icon = GOOGLE_ICONS[item.type] || GOOGLE_ICONS.doc;

      let meta = '';
      if (item.type === 'calendar') {
        const time = item.allDay ? 'All day' :
          new Date(item.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        meta = `${dayLabel(item.start)} · ${time}`;
        if (item.location) meta += ` · ${escapeHTML(item.location)}`;
      } else if (item.type === 'task') {
        meta = item.listName || '';
        if (item.due) meta += (meta ? ' · ' : '') + 'Due ' + when(item.due);
      } else if (item.type === 'keep') {
        meta = (item.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      } else {
        if (item.owner) meta += escapeHTML(item.owner);
        if (item.modified) meta += (meta ? ' · ' : '') + when(item.modified);
      }

      row.innerHTML = `
        <div class="gwp-item-icon" style="background:${colors.bg};border-color:${colors.border}">${icon}</div>
        <div class="gwp-item-info">
          <strong>${escapeHTML(item.name)}</strong>
          <span>${meta}</span>
        </div>
        <div class="gwp-item-actions">
          ${item.url ? `<button type="button" class="gwp-item-btn gwp-open-btn" title="Open in Google"><i class="ph ph-arrow-square-out"></i></button>` : ''}
          <button type="button" class="gwp-item-btn gwp-attach-btn" title="Attach to selected element"><i class="ph ph-paperclip"></i></button>
        </div>
      `;

      // Drag start: set transfer data
      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('application/x-gw-item', JSON.stringify(item));
        e.dataTransfer.effectAllowed = 'copy';

        // Create a nice drag ghost with the real icon
        const ghost = document.createElement('div');
        ghost.className = 'gwp-drag-ghost';
        ghost.innerHTML = `${icon}<span>${escapeHTML(item.name).slice(0, 40)}</span>`;
        ghost.style.cssText = `
          position: fixed; top: -200px; left: -200px;
          display: flex; align-items: center; gap: 8px;
          padding: 8px 14px; border-radius: 8px;
          background: ${colors.bg}; border: 2px solid ${colors.border};
          font-size: 13px; font-weight: 500; color: ${colors.text};
          box-shadow: 0 4px 20px rgba(0,0,0,.15);
          z-index: 99999; white-space: nowrap;
        `;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 20, 20);
        setTimeout(() => ghost.remove(), 0);
      });

      // Open in Google
      const openBtn = row.querySelector('.gwp-open-btn');
      if (openBtn) {
        openBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
        });
      }

      // Attach to selected element
      row.querySelector('.gwp-attach-btn').addEventListener('click', e => {
        e.stopPropagation();
        this._attachToBoard(item);
      });

      // Double-click to attach
      row.addEventListener('dblclick', () => this._attachToBoard(item));

      return row;
    }

    /* ---- attach to board ----------------------------------------------- */

    _attachToBoard(item) {
      const app = this.app;
      if (!app?.store) return;

      const colors = PRODUCT_COLORS[item.type] || PRODUCT_COLORS.doc;
      const selected = [...app.store.selection];
      let targetId = selected.length === 1 ? selected[0] : null;

      if (!targetId) {
        // Create a new styled element on the board with the real icon
        const r = app.viewport?.visibleRect?.();
        const c = r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 };

        // Add slight random offset so multiple items don't stack
        const offset = { x: (Math.random() - 0.5) * 60, y: (Math.random() - 0.5) * 60 };

        // A Keep note is content people want to actually read on the board,
        // not a link card — drop its real text and colour in, like the
        // dedicated Keep import already does.
        const isKeep = item.type === 'keep';
        const el = app.store.addElement('sticky-note', {
          x: c.x - 120 + offset.x,
          y: c.y - 50 + offset.y,
          width: 260,
          height: 100,
          content: isKeep ? (item.content || item.name) : item.name,
          style: {
            backgroundColor: isKeep ? (item.color || colors.bg) : colors.bg,
            color: isKeep ? '#16161d' : colors.text,
            fontSize: 14,
            bold: !isKeep,
          },
          meta: isKeep ? { gwType: 'keep', source: 'google-keep', keepId: item.id } : { gwType: item.type, gwIcon: true },
        });
        targetId = el.id;
        app.store.select([targetId]);
      }

      // Attach the file metadata
      if (app.attachments) {
        const kind = item.type === 'sheet' ? 'sheet' : item.type === 'slides' ? 'slides' : item.type === 'doc' ? 'doc' : 'file';
        app.attachments.add(targetId, {
          source: item.type === 'calendar' ? 'link' : (item.type === 'task' ? 'link' : 'drive'),
          kind: kind,
          name: item.name,
          url: item.url || '',
          mime: item.mimeType || '',
          icon: item.icon || '',
        });
      }

      Modal?.toast(`"${item.name}" added to the board.`, 'success', 2200);
    }

    /* ---- drop from panel onto canvas ---------------------------------- */

    _bindCanvasDrop() {
      const wrapper = document.getElementById('canvas-wrapper');
      if (!wrapper) return;

      // We need to intercept drag events specifically for our GW items
      wrapper.addEventListener('dragover', e => {
        if (!e.dataTransfer?.types?.includes('application/x-gw-item')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        wrapper.classList.add('is-gw-dropping');
      });

      wrapper.addEventListener('dragleave', e => {
        if (wrapper.contains(e.relatedTarget)) return;
        wrapper.classList.remove('is-gw-dropping');
      });

      wrapper.addEventListener('drop', e => {
        wrapper.classList.remove('is-gw-dropping');
        const raw = e.dataTransfer?.getData('application/x-gw-item');
        if (!raw) return;

        e.preventDefault();
        e.stopPropagation();

        let item;
        try { item = JSON.parse(raw); } catch { return; }

        const app = this.app;
        if (!app?.store || !app.viewport) return;

        const rect = wrapper.getBoundingClientRect();
        const boardPt = app.viewport.screenToBoard(
          e.clientX - rect.left,
          e.clientY - rect.top
        );

        const colors = PRODUCT_COLORS[item.type] || PRODUCT_COLORS.doc;

        // Create element at drop position with product-accurate styling
        const el = app.store.addElement('sticky-note', {
          x: boardPt.x - 130,
          y: boardPt.y - 50,
          width: 260,
          height: 100,
          content: item.name,
          style: {
            backgroundColor: colors.bg,
            color: colors.text,
            fontSize: 14,
            bold: true,
          },
        });

        // Check if dropped on an existing element (ignoring the one we just made)
        const hitEl = this._elementAtPoint(boardPt, el.id);
        const targetId = hitEl ? hitEl.id : el.id;

        // If dropped on existing element, remove the newly created one
        if (hitEl) {
          app.store.removeElements([el.id], { silent: true });
        } else {
          // If we kept the new element, mark it as a Google item so the renderer can show the icon
          app.store.updateElement(el.id, {
            meta: { gwType: item.type, gwIcon: true }
          });
        }

        // Attach the file
        if (app.attachments) {
          const kind = item.type === 'sheet' ? 'sheet' : item.type === 'slides' ? 'slides' : item.type === 'doc' ? 'doc' : 'file';
          app.attachments.add(targetId, {
            source: item.type === 'calendar' ? 'link' : (item.type === 'task' ? 'link' : 'drive'),
            kind: kind,
            name: item.name,
            url: item.url || '',
            mime: item.mimeType || '',
            icon: item.icon || '',
          });
        }

        app.store.select([targetId]);
        Modal?.toast(hitEl
          ? `Attached "${item.name}" to "${hitEl.content || hitEl.type}".`
          : `"${item.name}" placed on the board.`, 'success', 2200);
      });
    }

    /** Check if a board point is inside an existing element's bounds (ignoring ignoreId). */
    _elementAtPoint(pt, ignoreId = null) {
      for (const el of this.app.store.state.elements) {
        if (el.hidden || el.locked || el.id === ignoreId) continue;
        if (pt.x >= el.x && pt.x <= el.x + el.width &&
            pt.y >= el.y && pt.y <= el.y + el.height) {
          return el;
        }
      }
      return null;
    }
  }

  /* ---- export ----------------------------------------------------------- */

  global.GWPanel = GWPanel;

})(window);
