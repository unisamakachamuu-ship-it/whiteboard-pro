/* ================================================================
   pm/google.js — the Google Workspace screen
   ----------------------------------------------------------------
   Why this file exists.

   The server has had Calendar, Docs and Drive endpoints for a while,
   but nothing in the interface ever called them, and the OAuth scopes
   it asked for could not read the user's own data anyway. Signing in
   therefore "worked" and showed nothing — the connection was real and
   the data was unreachable.

   This module is the missing half: one client for /api/google/*, and
   one screen that renders Drive, Docs, Gmail, Calendar and Tasks. It
   fails loudly and specifically. Every panel can be in one of four
   states — loading, empty, error-with-a-fix, or content — and never
   silently blank, because a blank panel is what hid the original bug
   for so long.
   ================================================================ */

(function (global) {
  'use strict';

  const U = global.PMUI;
  const { h, esc } = U;

  /* ================================================================
     CLIENT
     ================================================================ */

  const api = {
    /** Status is read on nearly every interaction; hold it briefly. */
    _statusCache: null,
    _statusAt: 0,

    async get(path, params) {
      const url = new URL(path, location.origin);
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
      }
      const res = await fetch(url);
      let body = {};
      try { body = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
      return body;
    },

    async post(path, payload) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      let body = {};
      try { body = await res.json(); } catch {}
      if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
      return body;
    },

    async status({ fresh = false } = {}) {
      if (!fresh && this._statusCache && Date.now() - this._statusAt < 8000) return this._statusCache;
      try {
        this._statusCache = await this.get('/api/google/status');
        this._statusAt = Date.now();
      } catch {
        this._statusCache = { configured: false, connected: false,
          reason: 'The server did not answer. Is it still running?' };
      }
      return this._statusCache;
    },

    invalidate() { this._statusCache = null; },

    drive(params)         { return this.get('/api/google/drive/list', params); },
    driveAbout()          { return this.get('/api/google/drive/about'); },
    docs(params)          { return this.get('/api/google/docs/list', params); },
    mail(params)          { return this.get('/api/google/gmail/list', params); },
    mailMessage(id)       { return this.get('/api/google/gmail/message/' + encodeURIComponent(id)); },
    mailLabels()          { return this.get('/api/google/gmail/labels'); },
    events(params)        { return this.get('/api/google/calendar/events', params); },
    calendars()           { return this.get('/api/google/calendar/calendars'); },
    tasks(params)         { return this.get('/api/google/tasks/list', params); },
    createTask(payload)   { return this.post('/api/google/tasks/create', payload); },
    createDoc(payload)    { return this.post('/api/google/docs/create', payload); },
    disconnect()          { this.invalidate(); return this.post('/api/google/disconnect'); },

    /** Opens the consent popup; resolves true once the callback reports back. */
    connect() {
      return new Promise(async resolve => {
        let url, error;
        try { ({ url, error } = await this.get('/api/google/auth')); }
        catch (err) { error = err.message; }

        if (!url) {
          U.toast(error || 'Google is not configured on this server.', 'warn', 5000);
          return resolve(false);
        }

        const popup = window.open(url, 'google-oauth', 'width=520,height=700');
        if (!popup) {
          U.toast('Your browser blocked the sign-in window. Allow pop-ups for this site.', 'warn', 6000);
          return resolve(false);
        }

        const finish = ok => {
          window.removeEventListener('message', onMessage);
          clearInterval(poll);
          this.invalidate();
          resolve(ok);
        };
        const onMessage = e => { if (e.data?.type === 'google-connected') finish(true); };
        window.addEventListener('message', onMessage);

        // The window can also just be closed. Re-check status before giving
        // up: on some browsers the postMessage is lost but the token landed.
        const poll = setInterval(async () => {
          if (popup && !popup.closed) return;
          clearInterval(poll);
          this.invalidate();
          const s = await this.status({ fresh: true });
          finish(!!s.connected && !s.needsReconsent);
        }, 700);
      });
    },
  };

  /* ================================================================
     SMALL PRESENTATION HELPERS
     ================================================================ */

  const KIND_ICON = {
    doc: 'ph-file-doc', sheet: 'ph-file-xls', slides: 'ph-projector-screen',
    form: 'ph-list-checks', drawing: 'ph-pen-nib', folder: 'ph-folder',
    pdf: 'ph-file-pdf', image: 'ph-image', video: 'ph-file-video',
    audio: 'ph-file-audio', file: 'ph-file',
  };
  const KIND_TINT = {
    doc: '#4285f4', sheet: '#0f9d58', slides: '#f4b400', form: '#7627bb',
    drawing: '#f4511e', folder: '#5f6368', pdf: '#ea4335', image: '#9334e6',
    video: '#e8710a', audio: '#12b5cb', file: '#5f6368',
  };

  function bytes(n) {
    if (n === null || n === undefined) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
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
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /** A skeleton, an empty note, or an error with its fix — never nothing. */
  function skeleton(rows = 3) {
    return h('div', { class: 'gw-skeleton' },
      Array.from({ length: rows }, () => h('div', { class: 'gw-skel-row' })));
  }

  function emptyNote(icon, title, note) {
    return h('div', { class: 'gw-empty' }, [
      h('i', { class: `ph ${icon}` }),
      h('strong', { text: title }),
      note ? h('span', { text: note }) : null,
    ]);
  }

  /**
   * Google's real failures are "the API is off in the console" and "you did
   * not grant that permission". Both come back with a `fix`, and both are
   * one click to resolve — so render the fix, with its console link live.
   */
  function errorNote(err, onReconnect) {
    const body = err?.body || err || {};
    const fix = body.fix || '';
    const linked = esc(fix).replace(/(https?:\/\/\S+)/,
      '<a href="$1" target="_blank" rel="noopener noreferrer">Open Google Cloud console</a>');

    return h('div', { class: 'gw-error' }, [
      h('i', { class: 'ph-bold ph-warning-circle' }),
      h('div', {}, [
        h('strong', { text: body.error || err?.message || 'That request failed.' }),
        fix ? h('p', { html: linked }) : null,
        onReconnect && /permission|scope|expired|reconnect/i.test((body.error || '') + fix)
          ? h('button', { type: 'button', class: 'btn btn-ghost gw-mini', onclick: onReconnect },
              [h('i', { class: 'ph ph-arrows-clockwise' }), 'Reconnect Google'])
          : null,
      ]),
    ]);
  }

  function openExternal(url) {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  /* ================================================================
     THE SCREEN
     ================================================================ */

  const TABS = [
    { id: 'overview', label: 'Overview', icon: 'ph-squares-four' },
    { id: 'drive',    label: 'Drive',    icon: 'ph-hard-drives',  needs: 'drive' },
    { id: 'docs',     label: 'Docs',     icon: 'ph-file-doc',     needs: 'docs' },
    { id: 'mail',     label: 'Mail',     icon: 'ph-envelope-simple', needs: 'gmail' },
    { id: 'calendar', label: 'Calendar', icon: 'ph-calendar-dots', needs: 'calendar' },
    { id: 'tasks',    label: 'Tasks',    icon: 'ph-check-square',  needs: 'tasks' },
    // Keep is deliberately not gated on `needs`: it does not run on the
    // OAuth connection at all. On a personal account the Keep API is not
    // available at any price, so this tab talks to the App-Password /
    // browser-token session instead — which is why it can be present and
    // working while every scope-gated tab above is locked.
    { id: 'keep',     label: 'Keep',     icon: 'ph-lightbulb' },
  ];

  const LS_TAB = 'pm.google.tab.v1';

  class GoogleWorkspace {
    /**
     * @param {object} hub    the PMHub, for toasts, modals and task actions
     * @param {HTMLElement} mount  the hub stage to render into
     */
    constructor(hub) {
      this.hub = hub;
      this.tab = localStorage.getItem(LS_TAB) || 'overview';
      this.status = null;
      this.drive = { q: '', filter: 'all', trail: [], nextPage: null };
      this.docs = { q: '', type: 'document' };
      this.mail = { label: 'INBOX', q: '', openId: null };
      this._reqSeq = 0;
    }

    /* ---- entry point ---------------------------------------------------- */

    async render(stage) {
      this.stage = stage;
      stage.replaceChildren(h('div', { class: 'gw' }, [skeleton(4)]));

      this.status = await api.status({ fresh: true });
      this._paint();
    }

    _paint() {
      if (!this.stage) return;
      const s = this.status || {};

      if (!s.configured) return this.stage.replaceChildren(this._setupCard(s));
      if (!s.connected) return this.stage.replaceChildren(this._connectCard());

      this.root = h('div', { class: 'gw' }, [
        this._header(),
        s.needsReconsent ? this._reconsentBanner() : null,
        this._tabBar(),
        this.panelEl = h('div', { class: 'gw-panel' }),
      ]);
      this.stage.replaceChildren(this.root);
      this._openTab(this.tab);
    }

    /* ---- states before there is anything to show ------------------------- */

    _setupCard(s) {
      const origin = location.origin;
      return h('div', { class: 'gw gw-gate' }, [
        h('div', { class: 'gw-gate-card' }, [
          h('span', { class: 'gw-gate-mark' }, [h('i', { class: 'ph-bold ph-google-logo' })]),
          h('h2', { text: 'Connect Google Workspace' }),
          h('p', { text: s.reason || 'This server has no Google credentials yet, so Drive, Docs, Gmail and Calendar cannot be reached.' }),
          h('ol', { class: 'gw-steps' }, [
            h('li', { html: 'Open <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer">console.cloud.google.com</a> and pick or create a project.' }),
            h('li', { text: 'APIs & Services → Library → enable Drive, Docs, Gmail, Calendar and Tasks.' }),
            h('li', { text: 'OAuth consent screen → External → add your own Google account under Test users.' }),
            h('li', { html: `Credentials → OAuth client ID → Web application, redirect URI <code>${esc(origin)}/api/google/callback</code>` }),
            h('li', { html: 'Put <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code>, then restart the server.' }),
          ]),
        ]),
      ]);
    }

    _connectCard() {
      return h('div', { class: 'gw gw-gate' }, [
        h('div', { class: 'gw-gate-card' }, [
          h('span', { class: 'gw-gate-mark' }, [h('i', { class: 'ph-bold ph-google-logo' })]),
          h('h2', { text: 'Sign in to your Google account' }),
          h('p', { text: 'Your Drive files, Docs, inbox, calendar and tasks appear here once you connect. Nothing leaves this server.' }),
          h('ul', { class: 'gw-perm-list' }, [
            this._perm('ph-hard-drives', 'Drive', 'See your files, so you can attach them to tasks'),
            this._perm('ph-file-doc', 'Docs', 'List your documents and create new ones'),
            this._perm('ph-envelope-simple', 'Gmail', 'Read your inbox and send task notifications'),
            this._perm('ph-calendar-dots', 'Calendar', 'Show your agenda and mirror task due dates'),
            this._perm('ph-check-square', 'Tasks', 'Sync tasks both ways'),
          ]),
          h('button', {
            type: 'button', class: 'btn btn-primary gw-connect',
            onclick: () => this._doConnect(),
          }, [h('i', { class: 'ph-bold ph-google-logo' }), 'Connect Google account']),
          h('p', { class: 'gw-fineprint', text: 'Accept every permission on the consent screen. Skipping one leaves that panel empty.' }),
        ]),
      ]);
    }

    _perm(icon, name, why) {
      return h('li', {}, [
        h('i', { class: `ph ${icon}` }),
        h('div', {}, [h('strong', { text: name }), h('span', { text: why })]),
      ]);
    }

    /**
     * The specific failure the user hit: an old token that authenticates but
     * was never granted read access. Impossible to diagnose from an empty
     * list, trivial once it is named.
     */
    _reconsentBanner() {
      return h('div', { class: 'gw-banner' }, [
        h('i', { class: 'ph-bold ph-warning-circle' }),
        h('div', {}, [
          h('strong', { text: 'Reconnect to finish setting up' }),
          h('p', { text: this.status.reconsentHint }),
        ]),
        h('button', {
          type: 'button', class: 'btn btn-primary gw-mini',
          onclick: () => this._doConnect(),
        }, 'Reconnect'),
      ]);
    }

    async _doConnect() {
      const ok = await api.connect();
      this.status = await api.status({ fresh: true });
      if (ok && !this.status.needsReconsent) {
        U.toast('Google connected — your workspace is loading.', 'success');
      } else if (this.status.connected && this.status.needsReconsent) {
        U.toast('Some permissions were not granted. Reconnect and accept all of them.', 'warn', 6000);
      }
      this._paint();
      this.hub._renderSidebar?.();
    }

    /* ---- chrome ----------------------------------------------------------- */

    _header() {
      const acct = this.status.account || {};
      const initial = (acct.name || acct.email || '?').trim().charAt(0).toUpperCase();

      return h('header', { class: 'gw-head' }, [
        h('div', { class: 'gw-id' }, [
          acct.picture
            ? h('img', { class: 'gw-avatar', src: acct.picture, alt: '', referrerpolicy: 'no-referrer' })
            : h('span', { class: 'gw-avatar gw-avatar-fallback', text: initial }),
          h('div', { class: 'gw-id-text' }, [
            h('strong', { text: acct.name || 'Google account' }),
            h('span', { text: acct.email || 'Connected' }),
          ]),
          h('span', { class: 'gw-live' }, [h('i', { class: 'ph-fill ph-circle' }), 'Connected']),
        ]),

        h('div', { class: 'gw-head-actions' }, [
          this.storageEl = h('div', { class: 'gw-storage' }),
          h('button', {
            type: 'button', class: 'icon-btn', title: 'Refresh everything',
            onclick: () => this._openTab(this.tab, { force: true }),
          }, [h('i', { class: 'ph ph-arrows-clockwise' })]),
          h('button', {
            type: 'button', class: 'icon-btn', title: 'Account',
            onclick: e => this._accountMenu(e.currentTarget),
          }, [h('i', { class: 'ph ph-dots-three-vertical' })]),
        ]),
      ]);
    }

    _accountMenu(anchor) {
      U.menu(anchor, [
        { header: this.status.account?.email || 'Google' },
        { label: 'Open Google Drive', icon: 'ph-arrow-square-out', onClick: () => openExternal('https://drive.google.com') },
        { label: 'Manage app access', icon: 'ph-shield-check', onClick: () => openExternal('https://myaccount.google.com/permissions') },
        '-',
        { label: 'Reconnect / switch account', icon: 'ph-arrows-clockwise', onClick: () => this._doConnect() },
        {
          label: 'Disconnect', icon: 'ph-plugs', danger: true,
          onClick: async () => {
            if (!await U.confirm('Disconnect this Google account? Your files and mail stay untouched — this app just stops reading them.',
              { title: 'Disconnect Google', okLabel: 'Disconnect', danger: true })) return;
            await api.disconnect();
            this.status = await api.status({ fresh: true });
            U.toast('Google disconnected.', 'info');
            this._paint();
          },
        },
      ], { width: 250, align: 'end' });
    }

    _tabBar() {
      const avail = this.status.available || {};
      return h('nav', { class: 'gw-tabs' }, TABS.map(t => {
        const blocked = t.needs && avail[t.needs] === false;
        return h('button', {
          type: 'button',
          class: `gw-tab${this.tab === t.id ? ' is-active' : ''}${blocked ? ' is-blocked' : ''}`,
          data: { tab: t.id },
          title: blocked ? 'This permission was not granted — reconnect to enable it' : t.label,
          onclick: () => this._openTab(t.id),
        }, [
          h('i', { class: `ph ${t.icon}` }),
          h('span', { text: t.label }),
          blocked ? h('i', { class: 'ph-fill ph-lock-simple gw-tab-lock' }) : null,
        ]);
      }));
    }

    _openTab(id, { force = false } = {}) {
      if (!TABS.some(t => t.id === id)) id = 'overview';
      this.tab = id;
      localStorage.setItem(LS_TAB, id);
      for (const b of this.root.querySelectorAll('.gw-tab')) {
        b.classList.toggle('is-active', b.dataset.tab === id);
      }
      if (force) api.invalidate();

      const seq = ++this._reqSeq;
      this.panelEl.replaceChildren(skeleton(5));
      const done = node => { if (seq === this._reqSeq) this.panelEl.replaceChildren(node); };

      ({
        overview: () => this._renderOverview(done),
        drive: () => this._renderDrive(done),
        docs: () => this._renderDocs(done),
        mail: () => this._renderMail(done),
        calendar: () => this._renderCalendar(done),
        tasks: () => this._renderTasks(done),
        keep: () => this._renderKeep(done),
      })[id]();

      if (id === 'overview' || id === 'drive') this._loadStorage();
    }

    async _loadStorage() {
      if (!this.storageEl || this.storageEl.dataset.loaded) return;
      try {
        const a = await api.driveAbout();
        this.storageEl.dataset.loaded = '1';
        if (!a.limit) {
          this.storageEl.replaceChildren(h('span', { class: 'gw-storage-text', text: `${bytes(a.usage)} used` }));
          return;
        }
        const pct = Math.min(100, Math.round((a.usage / a.limit) * 100));
        this.storageEl.replaceChildren(
          h('div', { class: 'gw-storage-bar', title: `${bytes(a.usage)} of ${bytes(a.limit)}` },
            [h('span', { style: { width: pct + '%' }, class: pct > 90 ? 'is-full' : '' })]),
          h('span', { class: 'gw-storage-text', text: `${bytes(a.usage)} of ${bytes(a.limit)}` }),
        );
      } catch { /* storage is decoration; a failure here is not worth a banner */ }
    }

    /* ================================================================
       OVERVIEW
       ================================================================ */

    /**
     * The five surfaces load in parallel, each into its own card.
     *
     * A single server-side roll-up was tidier to write and much worse to use:
     * one blocking request meant the whole screen waited on the slowest API,
     * and Gmail is always the slowest. Here the shells paint immediately and
     * each card resolves on its own — a Drive that is switched off in the
     * Cloud console no longer holds up the calendar.
     */
    _renderOverview(done) {
      const avail = this.status.available || {};

      const specs = [
        {
          key: 'drive', title: 'Recent in Drive', perm: 'Google Drive',
          icon: 'ph-hard-drives', tab: 'drive',
          load: () => api.drive({ filter: 'recent', limit: 8 }),
          rows: d => (d.files || []).map(f => this._driveRow(f, { compact: true })),
          empty: 'Nothing opened recently.',
        },
        {
          key: 'docs', title: 'Your documents', perm: 'Google Docs',
          icon: 'ph-file-doc', tab: 'docs',
          load: () => api.docs({}),
          rows: d => (d.files || []).slice(0, 8).map(f => this._driveRow(f, { compact: true })),
          empty: 'No Google Docs in this account yet.',
        },
        {
          key: 'gmail', title: 'Inbox', perm: 'Gmail',
          icon: 'ph-envelope-simple', tab: 'mail',
          load: () => api.mail({ limit: 6 }),
          rows: d => (d.messages || []).map(m => this._mailRow(m, { compact: true })),
          empty: 'Your inbox is empty.',
        },
        {
          key: 'calendar', title: 'Coming up', perm: 'Google Calendar',
          icon: 'ph-calendar-dots', tab: 'calendar',
          load: () => api.events(),
          rows: d => (d.events || []).slice(0, 8).map(e => this._eventRow(e)),
          empty: 'Nothing scheduled.',
        },
        {
          key: 'tasks', title: 'Google Tasks', perm: 'Google Tasks',
          icon: 'ph-check-square', tab: 'tasks',
          load: () => api.tasks(),
          rows: d => (d.lists || []).flatMap(l => (l.tasks || []).slice(0, 6).map(t =>
            h('div', { class: 'gw-row' }, [
              h('span', { class: 'gw-row-ic', style: { color: '#4285f4' } }, [h('i', { class: 'ph ph-circle' })]),
              h('div', { class: 'gw-row-main' }, [
                h('strong', { text: t.title }),
                h('span', { text: l.title + (t.due ? ' · due ' + when(t.due) : '') }),
              ]),
            ]))),
          empty: 'No open tasks.',
        },
      ];

      const grid = h('div', { class: 'gw-grid' });
      const seq = this._reqSeq;

      for (const spec of specs) {
        const body = h('div', { class: 'gw-card-body' }, [skeleton(3)]);
        grid.append(this._card(spec, body));

        if (avail[spec.key] === false) {
          body.replaceChildren(errorNote({
            body: {
              error: `This connection was not granted permission for ${spec.perm}.`,
              fix: 'Reconnect Google and accept every permission.',
            },
          }, () => this._doConnect()));
          continue;
        }

        spec.load().then(data => {
          if (seq !== this._reqSeq) return;
          const rows = spec.rows(data);
          body.replaceChildren(rows.length
            ? h('div', { class: 'gw-rows' }, rows)
            : emptyNote(spec.icon, spec.empty, null));
        }).catch(err => {
          if (seq !== this._reqSeq) return;
          body.replaceChildren(errorNote(err, () => this._doConnect()));
        });
      }

      done(grid);
    }

    /** One overview card: heading, a jump to the full tab, and a live body. */
    _card(spec, body) {
      return h('section', { class: 'gw-card' }, [
        h('header', {}, [
          h('span', { class: 'gw-card-ic' }, [h('i', { class: `ph-bold ${spec.icon}` })]),
          h('h3', { text: spec.title }),
          h('button', {
            type: 'button', class: 'gw-card-more',
            onclick: () => this._openTab(spec.tab),
          }, ['Open', h('i', { class: 'ph ph-caret-right' })]),
        ]),
        body,
      ]);
    }

    /* ================================================================
       DRIVE
       ================================================================ */

    async _renderDrive(done) {
      const filters = [
        ['all', 'My Drive'], ['everything', 'Everything'], ['recent', 'Recent'],
        ['starred', 'Starred'], ['shared', 'Shared with me'], ['folder', 'Folders'],
        ['doc', 'Docs'], ['sheet', 'Sheets'], ['slides', 'Slides'],
        ['pdf', 'PDFs'], ['image', 'Images'],
      ];

      const search = h('input', {
        type: 'search', class: 'input gw-search', placeholder: 'Search all of Drive…',
        value: this.drive.q,
      });
      search.addEventListener('input', debounce(() => {
        this.drive.q = search.value.trim();
        this.drive.trail = [];
        this._loadDriveList();
      }, 320));

      const chips = h('div', { class: 'gw-chips' }, filters.map(([id, label]) =>
        h('button', {
          type: 'button', class: `gw-chip${this.drive.filter === id ? ' is-active' : ''}`,
          data: { chip: id },
          onclick: () => {
            this.drive.filter = id;
            this.drive.trail = [];
            for (const c of chips.children) c.classList.toggle('is-active', c.dataset.chip === id);
            this._loadDriveList();
          },
        }, label)));

      this.driveCrumbEl = h('div', { class: 'gw-crumbs' });
      this.driveListEl = h('div', { class: 'gw-list' }, [skeleton(6)]);

      done(h('div', { class: 'gw-view' }, [
        h('div', { class: 'gw-toolbar' }, [search, chips]),
        this.driveCrumbEl,
        this.driveListEl,
      ]));

      this._loadDriveList();
    }

    /**
     * `more` appends the next page instead of replacing the list. Without
     * it the view showed one page and stopped, which is what "some files
     * and folders are not showing" was: they were on page two, and there
     * was no way to ask for page two.
     */
    async _loadDriveList({ more = false } = {}) {
      const el = this.driveListEl;
      if (!el) return;
      if (!more) {
        el.replaceChildren(skeleton(6));
        this.drive.nextPage = null;
        this._renderCrumbs();
      }

      const folder = this.drive.trail.at(-1)?.id || '';
      const seq = more ? this._reqSeq : ++this._reqSeq;
      try {
        const data = await api.drive({
          q: this.drive.q,
          filter: folder ? 'all' : this.drive.filter,
          folder,
          page: more ? this.drive.nextPage : null,
        });
        if (seq !== this._reqSeq) return;

        const files = data.files || [];
        this.drive.nextPage = data.nextPage || null;

        const rows = more
          ? el.querySelector('.gw-rows')
          : h('div', { class: 'gw-rows' });

        if (!more && !files.length) {
          el.replaceChildren(emptyNote('ph-hard-drives',
            this.drive.q ? `Nothing in Drive matches "${this.drive.q}".` : 'This folder is empty.',
            this.drive.q ? null : 'Files you create or that are shared with you will appear here.'));
          return;
        }

        if (rows) rows.append(...files.map(f => this._driveRow(f)));
        if (!more) el.replaceChildren(rows);

        // Rebuild the footer each time so it reflects the new page token.
        el.querySelector('.gw-more')?.remove();
        if (this.drive.nextPage) {
          const btn = h('button', {
            type: 'button', class: 'btn btn-ghost full gw-more',
            onclick: () => {
              btn.disabled = true;
              btn.textContent = 'Loading…';
              this._loadDriveList({ more: true });
            },
          }, 'Load more files');
          el.appendChild(btn);
        }
      } catch (err) {
        if (seq !== this._reqSeq) return;
        if (more) {
          el.querySelector('.gw-more')?.remove();
          U.toast('Could not load more files.', 'warn');
        } else {
          el.replaceChildren(errorNote(err, () => this._doConnect()));
        }
      }
    }

    _renderCrumbs() {
      if (!this.driveCrumbEl) return;
      if (!this.drive.trail.length) return this.driveCrumbEl.replaceChildren();
      this.driveCrumbEl.replaceChildren(
        h('button', {
          type: 'button', class: 'gw-crumb',
          onclick: () => { this.drive.trail = []; this._loadDriveList(); },
        }, [h('i', { class: 'ph ph-house' }), 'My Drive']),
        ...this.drive.trail.flatMap((f, i) => [
          h('i', { class: 'ph ph-caret-right gw-crumb-sep' }),
          h('button', {
            type: 'button', class: 'gw-crumb',
            onclick: () => { this.drive.trail = this.drive.trail.slice(0, i + 1); this._loadDriveList(); },
          }, f.name),
        ]),
      );
    }

    _driveRow(f, { compact = false } = {}) {
      const isFolder = f.kind === 'folder';
      const open = () => {
        if (isFolder) { this.drive.trail.push({ id: f.id, name: f.name }); this._loadDriveList(); }
        else openExternal(f.link);
      };

      return h('div', {
        class: `gw-row${compact ? ' is-compact' : ''}`,
        ondblclick: open,
        onclick: compact ? open : undefined,
      }, [
        h('span', { class: 'gw-row-ic', style: { color: KIND_TINT[f.kind] || KIND_TINT.file } },
          [h('i', { class: `ph-fill ${KIND_ICON[f.kind] || KIND_ICON.file}` })]),

        h('div', { class: 'gw-row-main' }, [
          h('strong', { text: f.name }),
          h('span', {
            text: [
              isFolder ? 'Folder' : (f.kind === 'doc' ? 'Google Doc' : f.kind.toUpperCase()),
              f.lastEditor || f.owner,
              when(f.modified),
              f.size ? bytes(f.size) : null,
            ].filter(Boolean).join(' · '),
          }),
        ]),

        f.starred ? h('i', { class: 'ph-fill ph-star gw-row-star', title: 'Starred' }) : null,

        compact ? null : h('div', { class: 'gw-row-actions' }, [
          h('button', {
            type: 'button', class: 'icon-btn', title: isFolder ? 'Open folder' : 'Open in Google',
            onclick: e => { e.stopPropagation(); open(); },
          }, [h('i', { class: `ph ${isFolder ? 'ph-folder-open' : 'ph-arrow-square-out'}` })]),
          isFolder ? null : h('button', {
            type: 'button', class: 'icon-btn', title: 'Attach to a task',
            onclick: e => { e.stopPropagation(); this._attachToTask(f); },
          }, [h('i', { class: 'ph ph-paperclip' })]),
          isFolder ? null : h('button', {
            type: 'button', class: 'icon-btn', title: 'Attach to the whiteboard',
            onclick: e => { e.stopPropagation(); this._sendLinkToCanvas(f); },
          }, [h('i', { class: 'ph ph-chalkboard' })]),
        ]),
      ]);
    }

    /* ================================================================
       DOCS
       ================================================================ */

    async _renderDocs(done) {
      const types = [['document', 'Docs'], ['spreadsheet', 'Sheets'], ['presentation', 'Slides']];

      const search = h('input', {
        type: 'search', class: 'input gw-search', placeholder: 'Search your documents…',
        value: this.docs.q,
      });
      search.addEventListener('input', debounce(() => {
        this.docs.q = search.value.trim(); this._loadDocs();
      }, 320));

      const chips = h('div', { class: 'gw-chips' }, types.map(([id, label]) =>
        h('button', {
          type: 'button', class: `gw-chip${this.docs.type === id ? ' is-active' : ''}`,
          data: { chip: id },
          onclick: () => {
            this.docs.type = id;
            for (const c of chips.children) c.classList.toggle('is-active', c.dataset.chip === id);
            this._loadDocs();
          },
        }, label)));

      this.docsListEl = h('div', { class: 'gw-list' }, [skeleton(6)]);

      done(h('div', { class: 'gw-view' }, [
        h('div', { class: 'gw-toolbar' }, [
          search, chips,
          h('button', {
            type: 'button', class: 'btn btn-primary gw-mini',
            onclick: () => this._newDoc(),
          }, [h('i', { class: 'ph-bold ph-plus' }), 'New doc']),
        ]),
        this.docsListEl,
      ]));

      this._loadDocs();
    }

    async _loadDocs() {
      const el = this.docsListEl;
      if (!el) return;
      el.replaceChildren(skeleton(6));
      const seq = ++this._reqSeq;
      try {
        const data = await api.docs({ q: this.docs.q, type: this.docs.type });
        if (seq !== this._reqSeq) return;
        const files = data.files || [];
        el.replaceChildren(files.length
          ? h('div', { class: 'gw-rows' }, files.map(f => this._driveRow(f)))
          : emptyNote('ph-file-doc', 'Nothing here yet.',
              'Documents you own or that are shared with you will be listed here.'));
      } catch (err) {
        if (seq !== this._reqSeq) return;
        el.replaceChildren(errorNote(err, () => this._doConnect()));
      }
    }

    async _newDoc() {
      const nameInput = h('input', { type: 'text', class: 'input', placeholder: 'Document title', value: 'Untitled document' });
      const bodyInput = h('textarea', { class: 'input', rows: 6, placeholder: 'Optional starting content…' });

      this.hub._modal('New Google Doc', h('div', { class: 'pm-form' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Title' }), nameInput]),
        h('label', { class: 'field' }, [h('span', { text: 'Content' }), bodyInput]),
      ]), {
        width: 520,
        primary: {
          label: 'Create',
          onClick: async () => {
            try {
              const res = await api.createDoc({ title: nameInput.value.trim() || 'Untitled document', content: bodyInput.value });
              U.toast('Document created.', 'success');
              openExternal(res.url);
              this._loadDocs();
            } catch (err) {
              this.hub._googleError(err.body || { error: err.message });
              return false;
            }
          },
        },
      });
    }

    /* ================================================================
       MAIL
       ================================================================ */

    async _renderMail(done) {
      const search = h('input', {
        type: 'search', class: 'input gw-search', placeholder: 'Search mail (from:, subject:, is:unread …)',
        value: this.mail.q,
      });
      search.addEventListener('input', debounce(() => {
        this.mail.q = search.value.trim(); this._loadMail();
      }, 380));

      this.mailRailEl = h('nav', { class: 'gw-rail' }, [skeleton(5)]);
      this.mailListEl = h('div', { class: 'gw-maillist' }, [skeleton(6)]);
      this.mailReadEl = h('div', { class: 'gw-read' }, [
        emptyNote('ph-envelope-open', 'Pick a message', 'Its contents appear here.'),
      ]);

      done(h('div', { class: 'gw-view gw-mail' }, [
        h('div', { class: 'gw-toolbar' }, [
          search,
          h('button', {
            type: 'button', class: 'btn btn-ghost gw-mini',
            onclick: () => openExternal('https://mail.google.com'),
          }, [h('i', { class: 'ph ph-arrow-square-out' }), 'Open Gmail']),
        ]),
        h('div', { class: 'gw-mail-cols' }, [this.mailRailEl, this.mailListEl, this.mailReadEl]),
      ]));

      this._loadLabels();
      this._loadMail();
    }

    async _loadLabels() {
      try {
        const { labels } = await api.mailLabels();
        const order = ['INBOX', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH'];
        const pick = labels
          .filter(l => l.system ? order.includes(l.id) : l.total > 0)
          .sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

        this.mailRailEl.replaceChildren(...pick.map(l => h('button', {
          type: 'button',
          class: `gw-rail-item${this.mail.label === l.id ? ' is-active' : ''}`,
          onclick: e => {
            this.mail.label = l.id;
            for (const b of this.mailRailEl.children) b.classList.remove('is-active');
            e.currentTarget.classList.add('is-active');
            this._loadMail();
          },
        }, [
          h('span', { text: prettyLabel(l.name) }),
          l.unread ? h('b', { class: 'gw-rail-count', text: String(l.unread) }) : null,
        ])));
      } catch (err) {
        this.mailRailEl.replaceChildren(errorNote(err, () => this._doConnect()));
      }
    }

    async _loadMail() {
      const el = this.mailListEl;
      if (!el) return;
      el.replaceChildren(skeleton(6));
      const seq = ++this._reqSeq;
      try {
        const data = await api.mail({ label: this.mail.label, q: this.mail.q });
        if (seq !== this._reqSeq) return;
        const msgs = data.messages || [];
        el.replaceChildren(msgs.length
          ? h('div', { class: 'gw-rows' }, msgs.map(m => this._mailRow(m)))
          : emptyNote('ph-envelope-simple',
              this.mail.q ? 'No messages match that search.' : 'Nothing in this mailbox.'));
      } catch (err) {
        if (seq !== this._reqSeq) return;
        el.replaceChildren(errorNote(err, () => this._doConnect()));
      }
    }

    _mailRow(m, { compact = false } = {}) {
      const row = h('div', {
        class: `gw-row gw-mailrow${m.unread ? ' is-unread' : ''}${compact ? ' is-compact' : ''}`,
        onclick: () => (compact ? openExternal(m.link) : this._readMail(m, row)),
      }, [
        h('span', { class: 'gw-row-ic gw-mail-ic' },
          [h('i', { class: `ph${m.unread ? '-fill' : ''} ph-envelope${m.unread ? '' : '-open'}` })]),
        h('div', { class: 'gw-row-main' }, [
          h('strong', { text: m.from }),
          h('span', { class: 'gw-mail-subj', text: m.subject }),
          h('span', { class: 'gw-mail-snip', text: m.snippet }),
        ]),
        h('time', { class: 'gw-row-time', text: when(m.date) }),
      ]);
      return row;
    }

    async _readMail(m, row) {
      for (const r of this.mailListEl.querySelectorAll('.gw-mailrow')) r.classList.remove('is-open');
      row?.classList.add('is-open');
      this.mailReadEl.replaceChildren(skeleton(4));
      try {
        const full = await api.mailMessage(m.id);
        this.mailReadEl.replaceChildren(h('article', { class: 'gw-read-body' }, [
          h('h3', { text: full.subject }),
          h('div', { class: 'gw-read-meta' }, [
            h('span', { text: full.from }),
            h('time', { text: when(full.date) }),
          ]),
          h('div', { class: 'gw-read-actions' }, [
            h('button', { type: 'button', class: 'btn btn-ghost gw-mini', onclick: () => openExternal(full.link) },
              [h('i', { class: 'ph ph-arrow-square-out' }), 'Open in Gmail']),
            h('button', {
              type: 'button', class: 'btn btn-ghost gw-mini',
              onclick: () => this._taskFromMail(full),
            }, [h('i', { class: 'ph ph-plus-circle' }), 'Make a task']),
          ]),
          h('pre', { class: 'gw-read-text', text: full.body }),
        ]));
      } catch (err) {
        this.mailReadEl.replaceChildren(errorNote(err, () => this._doConnect()));
      }
    }

    /* ================================================================
       CALENDAR
       ================================================================ */

    async _renderCalendar(done) {
      let data, cals = [];
      try {
        [data, cals] = await Promise.all([
          api.events(),
          api.calendars().then(r => r.calendars || []).catch(() => []),
        ]);
      } catch (err) { return done(errorNote(err, () => this._doConnect())); }

      const events = data.events || [];
      if (!events.length) {
        return done(h('div', { class: 'gw-view' }, [
          emptyNote('ph-calendar-dots', 'Nothing on the calendar', 'Events for the next 60 days would appear here.'),
        ]));
      }

      // Group by day so the agenda reads like a calendar rather than a list.
      const byDay = new Map();
      for (const e of events) {
        const key = String(e.start).slice(0, 10);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(e);
      }

      done(h('div', { class: 'gw-view' }, [
        cals.length ? h('div', { class: 'gw-chips gw-callist' }, cals.map(c =>
          h('span', { class: 'gw-chip is-static' }, [
            h('i', { class: 'ph-fill ph-circle', style: { color: c.color || 'var(--clr-primary)' } }),
            c.name + (c.primary ? ' · primary' : ''),
          ]))) : null,

        h('div', { class: 'gw-agenda' }, [...byDay.entries()].map(([day, list]) =>
          h('section', { class: 'gw-day' }, [
            h('header', {}, [
              h('strong', { text: dayLabel(day) }),
              h('span', { text: `${list.length} event${list.length === 1 ? '' : 's'}` }),
            ]),
            h('div', { class: 'gw-rows' }, list.map(e => this._eventRow(e))),
          ]))),
      ]));
    }

    /* ================================================================
       KEEP
       ----------------------------------------------------------------
       The odd one out, and worth saying why it sits here anyway.

       Every other tab reads the server's OAuth connection. Keep cannot:
       keep.googleapis.com is a Workspace-only enterprise service, so on a
       personal account there is no scope that would ever work. This tab
       talks to the separate Keep session instead — the master token the
       import dialog obtained — which is why it can be fully working while
       the tabs above are still asking to be connected.

       It belongs in this screen regardless. "Where are my Google things"
       is one question, and answering it with "Keep is somewhere else"
       was the wrong answer.
       ================================================================ */

    get _keepClient() { return window.app?.keep || null; }
    get _keepSync() { return window.app?.keepSync || null; }

    async _renderKeep(done) {
      const client = this._keepClient;
      const sync = this._keepSync;

      if (!client?.token || !client?.email) {
        return done(h('div', { class: 'gw-view' }, [
          h('div', { class: 'gw-gate-card gw-keep-gate' }, [
            h('span', { class: 'gw-gate-mark' }, [h('i', { class: 'ph-bold ph-lightbulb' })]),
            h('h2', { text: 'Connect Google Keep' }),
            h('p', { text: 'Keep does not run on the OAuth connection the other tabs use — on a personal account Google offers no such API. It signs in separately, once, and the token is then remembered on this device.' }),
            h('button', {
              type: 'button', class: 'btn btn-primary gw-connect',
              onclick: () => {
                this.hub.close?.();
                window.app?.keep?.openModal();
              },
            }, [h('i', { class: 'ph-bold ph-lightbulb' }), 'Open the Keep sign-in']),
          ]),
        ]));
      }

      let notes = [];
      let error = null;
      try {
        const res = await fetch('/api/keep/state', {
          headers: { 'X-Keep-Token': client.token, 'X-Keep-Email': client.email },
        });
        const data = await res.json();
        if (!res.ok) throw new Error([data.error, data.fix].filter(Boolean).join(' — '));
        notes = data.notes || [];
      } catch (err) {
        error = err.message;
      }

      const onBoard = new Set(
        (window.app?.store?.state.elements || [])
          .map(e => e.meta?.keepId).filter(Boolean));

      const syncRow = h('div', { class: 'gw-keep-sync' }, [
        h('i', { class: 'ph-bold ' + (sync?.enabled ? 'ph-arrows-clockwise' : 'ph-pause-circle') }),
        h('div', {}, [
          h('strong', { text: sync?.enabled ? 'Live two-way sync is on' : 'Live two-way sync is off' }),
          h('span', {
            text: sync?.enabled
              ? 'Edits here are written to Keep, and changes made in the Keep app appear on the board.'
              : 'Notes import as a snapshot. Switch sync on to keep both sides in step.',
          }),
        ]),
        h('button', {
          type: 'button', class: 'btn btn-primary gw-mini',
          onclick: () => { sync?.toggle(); this._openTab('keep'); },
        }, sync?.enabled ? 'Turn off' : 'Turn on'),
        sync?.conflicts?.size
          ? h('button', {
              type: 'button', class: 'btn gw-mini',
              onclick: () => sync.openConflicts(),
            }, `Resolve ${sync.conflicts.size}`)
          : null,
      ].filter(Boolean));

      if (error) {
        return done(h('div', { class: 'gw-view' }, [syncRow, errorNote({ message: error })]));
      }

      done(h('div', { class: 'gw-view' }, [
        syncRow,
        h('div', { class: 'gw-keep-head' }, [
          h('span', { text: `${notes.length} note${notes.length === 1 ? '' : 's'} · ${onBoard.size} on this board` }),
          h('button', {
            type: 'button', class: 'btn gw-mini',
            onclick: () => { this.hub.close?.(); window.app?.keep?.openModal(); },
          }, 'Import notes to the board'),
        ]),
        notes.length
          ? h('div', { class: 'gw-keep-grid' }, notes.map(n => this._keepCard(n, onBoard.has(n.id))))
          : emptyNote('ph-lightbulb', 'No notes in Keep', 'Anything you add in the Keep app shows up here.'),
      ]));
    }

    _keepCard(n, isOnBoard) {
      const body = (n.content || '').slice(0, 260);
      return h('article', {
        class: 'gw-keep-card' + (isOnBoard ? ' is-on-board' : ''),
        style: { borderTopColor: n.color || 'var(--clr-border)' },
        title: isOnBoard ? 'This note is on the board' : 'Not on this board yet',
      }, [
        n.pinned ? h('i', { class: 'ph-fill ph-push-pin gw-keep-pin' }) : null,
        n.title ? h('h4', { text: n.title }) : null,
        h('p', { text: body || '(empty note)' }),
        h('footer', {}, [
          h('span', { text: n.updated ? 'edited ' + when(n.updated) : '' }),
          isOnBoard ? h('span', { class: 'gw-keep-badge', text: 'on board' }) : null,
        ].filter(Boolean)),
      ].filter(Boolean));
    }

    _eventRow(e) {
      const time = e.allDay
        ? 'All day'
        : new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return h('div', { class: 'gw-row gw-eventrow', onclick: () => openExternal(e.link) }, [
        h('span', { class: 'gw-event-time', text: time }),
        h('div', { class: 'gw-row-main' }, [
          h('strong', { text: e.title }),
          h('span', {
            text: [e.location, e.attendees ? `${e.attendees} guest${e.attendees === 1 ? '' : 's'}` : null]
              .filter(Boolean).join(' · ') || dayLabel(e.start),
          }),
        ]),
        h('i', { class: 'ph ph-arrow-square-out gw-row-go' }),
      ]);
    }

    /* ================================================================
       TASKS
       ================================================================ */

    async _renderTasks(done) {
      let data;
      try { data = await api.tasks(); }
      catch (err) { return done(errorNote(err, () => this._doConnect())); }

      const lists = data.lists || [];
      const total = lists.reduce((n, l) => n + l.tasks.length, 0);
      if (!total) {
        return done(h('div', { class: 'gw-view' }, [
          emptyNote('ph-check-square', 'No open Google Tasks',
            'Push a project task here from its task panel and it will show up.'),
        ]));
      }

      done(h('div', { class: 'gw-view' }, [
        h('div', { class: 'gw-grid' }, lists.map(l => h('section', { class: 'gw-card' }, [
          h('header', {}, [
            h('span', { class: 'gw-card-ic' }, [h('i', { class: 'ph-bold ph-check-square' })]),
            h('h3', { text: l.title }),
            h('span', { class: 'gw-count', text: String(l.tasks.length) }),
          ]),
          l.tasks.length
            ? h('div', { class: 'gw-rows' }, l.tasks.map(t => h('div', { class: 'gw-row' }, [
                h('span', { class: 'gw-row-ic' }, [h('i', { class: 'ph ph-circle' })]),
                h('div', { class: 'gw-row-main' }, [
                  h('strong', { text: t.title }),
                  t.due ? h('span', { text: 'Due ' + when(t.due) }) : null,
                ]),
              ])))
            : emptyNote('ph-check-square', 'Nothing open in this list'),
        ]))),
      ]));
    }

    /* ================================================================
       CROSS-SURFACE ACTIONS
       ================================================================ */

    /** Attach a Drive file to a project task, picked from a list. */
    _attachToTask(file) {
      const store = this.hub.store;
      const projects = store.allProjects();
      const options = projects.flatMap(p =>
        store.projectTasks(p.id).filter(t => !t.archived).map(t => ({ p, t })));

      if (!options.length) {
        U.toast('Create a task first, then attach this file to it.', 'info', 4000);
        return;
      }

      const search = h('input', { type: 'search', class: 'input', placeholder: 'Find a task…' });
      const list = h('div', { class: 'gw-picklist' });

      const draw = () => {
        const term = search.value.trim().toLowerCase();
        const shown = options
          .filter(o => !term || o.t.title.toLowerCase().includes(term) || o.p.name.toLowerCase().includes(term))
          .slice(0, 60);
        list.replaceChildren(...(shown.length ? shown.map(o => h('button', {
          type: 'button', class: 'gw-pick',
          onclick: () => {
            store.addAttachment(o.t.id, {
              kind: 'link', url: file.link, name: file.name, source: 'google-drive',
            });
            U.toast(`Attached to "${o.t.title}".`, 'success');
            close();
          },
        }, [
          h('span', { class: 'gw-pick-proj', style: { background: o.p.color } }),
          h('div', {}, [h('strong', { text: o.t.title }), h('span', { text: o.p.name })]),
        ])) : [emptyNote('ph-magnifying-glass', 'No task matches that.')]));
      };

      search.addEventListener('input', draw);
      draw();

      const close = this.hub._modal(`Attach "${file.name}"`, h('div', { class: 'pm-form' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Task' }), search]),
        list,
      ]), { width: 520 });
    }

    /** Turn a mail message into a project task. */
    _taskFromMail(msg) {
      const store = this.hub.store;
      const projects = store.allProjects();
      if (!projects.length) { U.toast('Create a project first.', 'info'); return; }

      const select = h('select', { class: 'input' }, projects.map(p =>
        h('option', { value: p.id, text: p.name })));
      if (this.hub.state.projectId) select.value = this.hub.state.projectId;
      const title = h('input', { type: 'text', class: 'input', value: msg.subject });

      this.hub._modal('New task from this email', h('div', { class: 'pm-form' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Project' }), select]),
        h('label', { class: 'field' }, [h('span', { text: 'Title' }), title]),
      ]), {
        width: 500,
        primary: {
          label: 'Create task',
          onClick: () => {
            const task = store.createTask({
              projectId: select.value,
              title: title.value.trim() || msg.subject,
              description: `From ${msg.from}\n\n${(msg.body || '').slice(0, 1200)}`,
            });
            if (task) {
              store.addAttachment(task.id, { kind: 'link', url: msg.link, name: 'Email: ' + msg.subject, source: 'gmail' });
              U.toast('Task created.', 'success');
            }
          },
        },
      });
    }

    /**
     * Put a Drive file on the active whiteboard.
     *
     * This used to drop a sticky note with the file's URL typed into its
     * text — a note *about* a file, which you could not open, and which
     * broke the moment anyone edited the note. It now creates a real
     * attachment, so the object carries the file the same way anything else
     * on the board does.
     *
     * If something is selected, the file attaches to that object. Otherwise
     * it gets a note of its own to hang from.
     */
    _sendLinkToCanvas(file) {
      const app = this.hub.app;
      if (!app?.store) { U.toast('Open a whiteboard first.', 'warn'); return; }

      // Older call sites passed (name, url).
      if (typeof file === 'string') file = { name: file, link: arguments[1] };

      const att = {
        source: 'drive',
        kind: file.kind || 'file',
        name: file.name || 'Drive file',
        url: file.link || file.url || '',
        mime: file.mimeType || '',
        size: file.size || null,
        icon: file.icon || '',
      };

      const selected = [...app.store.selection];
      let targetId = selected.length === 1 ? selected[0] : null;

      if (!targetId) {
        const r = app.viewport?.visibleRect?.();
        const c = r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 };
        const el = app.store.addElement('sticky-note', {
          x: c.x - 110, y: c.y - 70, width: 220, height: 140,
          content: att.name,
        });
        targetId = el.id;
        app.store.select([targetId]);
      }

      if (app.attachments) {
        app.attachments.add(targetId, att);
      } else {
        // attachments.js is optional; fall back to the old behaviour rather
        // than silently doing nothing.
        app.store.updateElement(targetId, { meta: { source: 'google-drive', url: att.url } });
        U.toast('Link added to the whiteboard.', 'success');
      }

      this.hub.close();
    }
  }

  /* ---- helpers ---------------------------------------------------------- */

  function prettyLabel(name) {
    if (!name) return 'Label';
    return name
      .replace(/^CATEGORY_/, '')
      .split('/').pop()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  global.PMGoogle = { api, GoogleWorkspace };

})(window);
