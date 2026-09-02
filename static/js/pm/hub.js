/* ================================================================
   pm/hub.js — The project workspace shell
   ----------------------------------------------------------------
   Owns navigation, the filter bar, view switching and the member
   panel. It holds the one piece of state the views share — which
   project, which view, which filter — and hands it to them through a
   small context object.

   The hub does not know how a Board draws a card, and a Board does not
   know the hub has a sidebar. That separation is what lets a sixth
   view be added later by writing one class and appending it to
   `PMViews.registry`.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;
  const U = global.PMUI;
  const { h, esc } = U;

  const LS_STATE = 'pm.hub.state.v1';

  class PMHub {
    constructor(store, app) {
      this.store = store;
      this.app = app;                       // the whiteboard app, may be null
      this.view = null;
      this.selection = new Set();
      this._lastClicked = null;

      this.state = {
        projectId: null,
        viewId: 'board',
        group: 'status',
        sort: 'manual',
        dir: 'asc',
        filter: { hideDone: false },
        collapsed: [],
        screen: 'dashboard',                // dashboard | project | mywork
      };
      this._restoreState();

      this._build();
      this.taskPanel = new global.PMTaskPanel(store, this);
      this._wireStore();
      this._route();
    }

    /* ---- Persistence of UI state -------------------------------------- */

    _restoreState() {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_STATE) || '{}');
        Object.assign(this.state, saved, { filter: { ...this.state.filter, ...(saved.filter || {}) } });
      } catch {}
    }

    _saveState() {
      try { localStorage.setItem(LS_STATE, JSON.stringify(this.state)); } catch {}
    }

    /* ---- DOM ----------------------------------------------------------- */

    _build() {
      this.root = h('div', { id: 'pm-hub', class: 'pm-hub hidden' }, [
        this._sidebar(),
        h('main', { class: 'pm-main' }, [
          this.topbarEl = h('header', { class: 'pm-top' }),
          this.filterbarEl = h('div', { class: 'pm-filterbar hidden' }),
          this.stageEl = h('div', { class: 'pm-stage' }),
          this.bulkbarEl = h('div', { class: 'pm-bulkbar hidden' }),
        ]),
      ]);
      document.body.append(this.root);
      this._injectTopbarButton();

      document.addEventListener('keydown', e => this._onKey(e));
    }

    _sidebar() {
      this.projListEl = h('nav', { class: 'pm-side-projects' });
      this.sideStatsEl = h('div', { class: 'pm-side-stats' });

      return h('aside', { class: 'pm-side' }, [
        h('div', { class: 'pm-side-brand' }, [
          h('span', { class: 'pm-side-logo' }, [h('i', { class: 'ph-bold ph-squares-four' })]),
          h('div', {}, [h('strong', { text: 'Workspace' }), h('small', { class: 'pm-backend-badge', text: 'local' })]),
        ]),

        h('div', { class: 'pm-side-nav' }, [
          this._sideBtn('ph-house', 'All projects', () => this.showDashboard(), 'dashboard'),
          this._sideBtn('ph-user-focus', 'My work', () => this.showMyWork(), 'mywork'),
          this._sideBtn('ph-bell', 'Inbox', () => this.showInbox(), 'inbox'),
          this._sideBtn('ph-google-logo', 'Google Workspace', () => this.showWorkspace(), 'workspace'),
        ]),

        h('div', { class: 'pm-side-head' }, [
          h('span', { text: 'Projects' }),
          h('button', { type: 'button', class: 'pm-side-add', title: 'New project', onclick: () => this.promptCreateProject() },
            [h('i', { class: 'ph-bold ph-plus' })]),
        ]),
        this.projListEl,
        this.sideStatsEl,

        h('div', { class: 'pm-side-foot' }, [
          this.googleBtnEl = h('button', {
            type: 'button', class: 'pm-side-back pm-google-btn',
            onclick: () => this._googleMenu(),
          }, [h('i', { class: 'ph-bold ph-google-logo' }), h('span', { text: 'Google' })]),
          h('button', { type: 'button', class: 'pm-side-back', onclick: () => this.close() },
            [h('i', { class: 'ph-bold ph-arrow-left' }), 'Back to canvas']),
        ]),
      ]);
    }

    /**
     * Keeps the sidebar's Google chip honest: the account it is signed in as,
     * or the reason it is not. It used to say a flat "Google" whether the
     * integration was connected, half-connected or entirely unconfigured,
     * which is a large part of why a broken connection went unnoticed.
     */
    async _refreshGoogleChip() {
      if (!this.googleBtnEl || !global.PMGoogle) return;
      const s = await global.PMGoogle.api.status();
      const label = this.googleBtnEl.querySelector('span');
      if (!label) return;

      this.googleBtnEl.classList.toggle('is-connected', !!s.connected && !s.needsReconsent);
      this.googleBtnEl.classList.toggle('is-warning', !!s.needsReconsent || (s.configured && !s.connected));

      if (!s.configured) { label.textContent = 'Google · not set up'; return; }
      if (!s.connected) { label.textContent = 'Connect Google'; return; }
      if (s.needsReconsent) { label.textContent = 'Google · reconnect'; return; }
      label.textContent = s.account?.email || 'Google · connected';
    }

    /**
     * The sidebar chip. Every branch now leads somewhere: unconfigured and
     * disconnected both route to the Workspace screen, which explains itself
     * in full, rather than to a modal that dead-ends.
     */
    async _googleMenu() {
      const G = global.PMGoogle;
      if (!G) { this.showWorkspace(); return; }
      const status = await G.api.status({ fresh: true });

      if (!status.configured || !status.connected) { this.showWorkspace(); return; }

      // The 127.0.0.1-vs-localhost split is invisible until it breaks
      // something, so say it out loud wherever the user is looking.
      const hostWarning = status.hostMismatch
        ? [{ header: '⚠ Open this app at ' + new URL(status.redirectUri).host }, '-']
        : [];

      U.menu(this.googleBtnEl, [
        ...hostWarning,
        { header: status.account?.email || 'Google · connected' },
        status.needsReconsent
          ? { label: 'Finish connecting', icon: 'ph-warning-circle', onClick: () => this.showWorkspace() }
          : null,
        { label: 'Open Workspace', icon: 'ph-squares-four', onClick: () => this.showWorkspace('overview') },
        { label: 'Drive', icon: 'ph-hard-drives', onClick: () => this.showWorkspace('drive') },
        { label: 'Mail', icon: 'ph-envelope-simple', onClick: () => this.showWorkspace('mail') },
        { label: 'Calendar', icon: 'ph-calendar-dots', onClick: () => this.showWorkspace('calendar') },
        '-',
        {
          label: 'Push all dated tasks to Calendar', icon: 'ph-calendar-plus',
          disabled: !this.state.projectId,
          onClick: () => this._pushAllToCalendar(),
        },
        '-',
        {
          label: 'Disconnect', icon: 'ph-plugs', danger: true,
          onClick: async () => {
            await G.api.disconnect();
            this._gw = null;
            U.toast('Google disconnected.', 'info');
            this._refreshGoogleChip();
          },
        },
      ].filter(Boolean), { side: 'top', width: 260 });
    }

    async _pushAllToCalendar() {
      const p = this.store.project(this.state.projectId);
      if (!p) return;
      const dated = this.store.projectTasks(p.id)
        .filter(t => t.dueDate && !t.archived && !S.isDone(p, t));
      if (!dated.length) { U.toast('No open tasks have a due date.', 'info'); return; }
      if (!await U.confirm(`Create or update ${dated.length} Google Calendar event(s)?`,
        { title: 'Sync to Calendar', okLabel: 'Sync' })) return;

      let done = 0, failed = 0;
      // Sequential on purpose: Calendar rate-limits bursts, and a partial
      // failure halfway through is easier to reason about than a scattered one.
      for (const t of dated) {
        (await this.pushToCalendar(t.id, { quiet: true })) ? done++ : failed++;
      }
      U.toast(failed
        ? `Synced ${done} task(s); ${failed} failed.`
        : `Synced ${done} task(s) to Calendar.`, failed ? 'warn' : 'success', 4000);
    }

    _sideBtn(icon, label, onclick, screen) {
      const b = h('button', { type: 'button', class: 'pm-side-item', data: { screen }, onclick }, [
        h('i', { class: `ph-bold ${icon}` }), label,
      ]);
      return b;
    }

    /** Adds the Projects button to the whiteboard's own top bar. */
    _injectTopbarButton() {
      const group = document.querySelector('.topbar-group');
      if (!group || document.getElementById('pm-open-btn')) return;
      const btn = h('button', {
        type: 'button', class: 'btn btn-ghost', id: 'pm-open-btn',
        title: 'Open the project workspace (Ctrl+Shift+P)',
        onclick: () => this.open(),
      }, [h('i', { class: 'ph-bold ph-squares-four' }), h('span', { text: 'Projects' })]);
      group.insertBefore(btn, group.children[1] || null);
    }

    /* ---- Store wiring --------------------------------------------------- */

    _wireStore() {
      this.store.on('projects-changed', () => { this._renderSidebar(); this._renderScreen(); });
      this.store.on('tasks-changed', () => { this._renderScreen(); this._renderBulkbar(); });
      this.store.on('ready', ({ adapter }) => {
        const badge = this.root.querySelector('.pm-backend-badge');
        if (badge) {
          badge.textContent = adapter === 'firestore' ? 'Firebase · live' : 'This device';
          badge.className = 'pm-backend-badge ' + (adapter === 'firestore' ? 'is-cloud' : 'is-local');
        }
        this._renderSidebar();
        this._renderScreen();
      });
      this.store.on('error', ({ message }) => U.toast(message, 'warn'));
      this.store.on('sync-error', () => U.toast('Could not sync that change. It is saved on this device.', 'warn', 4000));
    }

    /* ---- Context handed to views ---------------------------------------- */

    get viewCtx() {
      return {
        store: this.store,
        hub: this,
        getState: () => this.state,
        setSort: key => {
          this.state.dir = this.state.sort === key && this.state.dir === 'asc' ? 'desc' : 'asc';
          this.state.sort = key;
          this._saveState();
          this._renderScreen();
        },
        toggleCollapsed: key => {
          const i = this.state.collapsed.indexOf(key);
          if (i >= 0) this.state.collapsed.splice(i, 1); else this.state.collapsed.push(key);
          this._saveState();
          this._renderScreen();
        },
        isSelected: id => this.selection.has(id),
        toggleSelected: (id, range) => this._toggleSelected(id, range),
        selectMany: ids => { ids.forEach(i => this.selection.add(i)); this._renderScreen(); this._renderBulkbar(); },
        applyFilter: (patch, viewId) => {
          Object.assign(this.state.filter, patch);
          if (viewId) this.state.viewId = viewId;
          this._saveState();
          this._renderScreen();
        },
        newTask: () => this.quickAddTask(),
      };
    }

    /* ---- Navigation ------------------------------------------------------ */

    open() {
      this.root.classList.remove('hidden');
      document.body.classList.add('pm-open');
      requestAnimationFrame(() => this.root.classList.add('is-open'));
      this._renderSidebar();
      this._renderScreen();
    }

    close() {
      this.root.classList.remove('is-open');
      document.body.classList.remove('pm-open');
      setTimeout(() => this.root.classList.add('hidden'), 180);
      U.Pop.close();
    }

    get isOpen() { return !this.root.classList.contains('hidden'); }

    showDashboard() {
      this.state.screen = 'dashboard';
      this.state.projectId = null;
      this._saveState();
      this._renderSidebar();
      this._renderScreen();
    }

    showMyWork() {
      this.state.screen = 'mywork';
      this._saveState();
      this._renderSidebar();
      this._renderScreen();
    }

    showInbox() {
      this.state.screen = 'inbox';
      this._saveState();
      this._renderSidebar();
      this._renderScreen();
    }

    showWorkspace(tab) {
      this.state.screen = 'workspace';
      if (tab) localStorage.setItem('pm.google.tab.v1', tab);
      this._saveState();
      this._renderSidebar();
      this.open();
    }

    openProject(id, viewId) {
      const p = this.store.project(id);
      if (!p) return;
      this.state.projectId = id;
      this.state.screen = 'project';
      if (viewId) this.state.viewId = viewId;
      else if (p.settings?.defaultView) this.state.viewId = p.settings.defaultView;
      this.store.activeProjectId = id;
      this.store.adapter?.watchProject?.(id);
      this.selection.clear();
      this._saveState();
      this._syncURL();
      this.open();
    }

    _syncURL() {
      const url = new URL(location.href);
      if (this.state.projectId) url.searchParams.set('project', this.state.projectId);
      else url.searchParams.delete('project');
      history.replaceState(null, '', url);
    }

    _route() {
      const params = new URLSearchParams(location.search);
      const pid = params.get('project');
      const tid = params.get('task');
      if (!pid) return;

      // The deep link may arrive before the adapter has loaded that
      // project, so wait for it rather than silently doing nothing.
      const tryOpen = () => {
        if (!this.store.project(pid)) return false;
        this.openProject(pid);
        if (tid) setTimeout(() => this.store.task(tid) && this.taskPanel.open(tid), 300);
        return true;
      };
      if (tryOpen()) return;
      const off = this.store.on('projects-changed', () => { if (tryOpen()) off(); });
    }

    /* ---- Sidebar rendering ------------------------------------------------ */

    _renderSidebar() {
      for (const b of this.root.querySelectorAll('.pm-side-item')) {
        b.classList.toggle('is-active', b.dataset.screen === this.state.screen);
      }

      const projects = this.store.allProjects();
      this.projListEl.replaceChildren(...projects.map(p => {
        const health = S.projectHealth(p, this.store.projectTasks(p.id));
        return h('button', {
          type: 'button',
          class: `pm-side-proj${p.id === this.state.projectId ? ' is-active' : ''}`,
          onclick: () => this.openProject(p.id),
          oncontextmenu: e => { e.preventDefault(); this._projectMenu(e.currentTarget, p); },
        }, [
          h('span', { class: 'pm-side-proj-ic', style: { background: p.color } }, [h('i', { class: `ph-bold ${p.icon}` })]),
          h('span', { class: 'pm-side-proj-name', text: p.name }),
          health.overdue ? h('span', { class: 'pm-side-proj-warn', title: `${health.overdue} overdue` , text: String(health.overdue) }) : null,
        ]);
      }));

      if (!projects.length) {
        this.projListEl.append(h('p', { class: 'pm-side-empty', text: 'No projects yet.' }));
      }

      // A three-number summary of everything the user can see.
      const all = projects.flatMap(p => this.store.projectTasks(p.id));
      const me = this._meKey();
      const mine = this.store.tasksForUser(me);
      const overdue = all.filter(t => S.isOverdue(this.store.project(t.projectId), t)).length;
      this.sideStatsEl.replaceChildren(
        h('div', { class: 'pm-side-stat' }, [h('b', { text: String(mine.length) }), 'assigned to me']),
        h('div', { class: `pm-side-stat${overdue ? ' is-bad' : ''}` }, [h('b', { text: String(overdue) }), 'overdue']),
      );

      // Cheap: the status call is cached for a few seconds behind PMGoogle.
      this._refreshGoogleChip();
    }

    /* ---- Screen rendering -------------------------------------------------- */

    _renderScreen() {
      if (!this.isOpen) return;
      if (this.state.screen === 'dashboard') return this._renderDashboard();
      if (this.state.screen === 'mywork') return this._renderMyWork();
      if (this.state.screen === 'inbox') return this._renderInbox();
      if (this.state.screen === 'workspace') return this._renderWorkspace();
      return this._renderProject();
    }

    /* -- Google Workspace ---------------------------------------------------- */

    /**
     * Rendered by pm/google.js. The screen is stateful (open mailbox, Drive
     * folder trail, active sub-tab), so the instance is kept and reused
     * instead of being rebuilt on every store event.
     */
    _renderWorkspace() {
      this.filterbarEl.classList.add('hidden');
      this.topbarEl.replaceChildren(
        h('div', { class: 'pm-top-title' }, [
          h('h1', { text: 'Google Workspace' }),
          h('p', { text: 'Your Drive, documents, mail, calendar and tasks, in the same place as your projects.' }),
        ]),
        h('div', { class: 'pm-top-actions' }, [
          h('button', {
            type: 'button', class: 'btn btn-ghost',
            onclick: () => window.open('https://drive.google.com', '_blank', 'noopener,noreferrer'),
          }, [h('i', { class: 'ph ph-arrow-square-out' }), 'Open Google']),
        ]),
      );

      if (!global.PMGoogle) {
        this.stageEl.replaceChildren(h('div', { class: 'pm-empty pm-empty-big' }, [
          h('i', { class: 'ph ph-plug' }),
          h('h3', { text: 'The Google module did not load' }),
          h('p', { text: 'static/js/pm/google.js is missing from the page. Hard-refresh, and check the script tags in templates/index.html.' }),
        ]));
        return;
      }

      // Re-render only when the screen is entered fresh; a store event that
      // fires while the user is reading an email must not blow the pane away.
      if (!this._gw) this._gw = new global.PMGoogle.GoogleWorkspace(this);
      if (this.stageEl.firstElementChild?.classList.contains('gw') && this._gw.stage === this.stageEl) return;
      this._gw.render(this.stageEl);
    }

    /* -- Dashboard ---------------------------------------------------------- */

    _renderDashboard() {
      this.filterbarEl.classList.add('hidden');
      this.topbarEl.replaceChildren(
        h('div', { class: 'pm-top-title' }, [h('h1', { text: 'All projects' }), h('p', { text: 'Every workspace you have access to.' })]),
        h('div', { class: 'pm-top-actions' }, [
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: e => this._importPop(e.currentTarget) },
            [h('i', { class: 'ph ph-upload-simple' }), 'Import']),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.promptCreateProject() },
            [h('i', { class: 'ph-bold ph-plus' }), 'New project']),
        ]),
      );

      const projects = this.store.allProjects();
      if (!projects.length) {
        this.stageEl.replaceChildren(h('div', { class: 'pm-empty pm-empty-big' }, [
          h('i', { class: 'ph ph-squares-four' }),
          h('h3', { text: 'Start your first project' }),
          h('p', { text: 'A project holds tasks, people, whiteboards and a shared timeline. Pick a template or start blank.' }),
          h('button', { type: 'button', class: 'btn btn-primary', text: 'Create a project', onclick: () => this.promptCreateProject() }),
        ]));
        return;
      }

      const grid = h('div', { class: 'pm-proj-grid' });
      for (const p of projects) grid.append(this._projectCard(p));
      this.stageEl.replaceChildren(this._portfolioStrip(projects), grid);
    }

    /** Roll-up numbers across every project the user can see. */
    _portfolioStrip(projects) {
      let total = 0, done = 0, overdue = 0, people = new Set();
      for (const p of projects) {
        const hp = S.projectHealth(p, this.store.projectTasks(p.id));
        total += hp.total; done += hp.done; overdue += hp.overdue;
        for (const m of p.members) if (m.status !== 'removed') people.add(m.email || m.uid);
      }
      const pct = total ? Math.round((done / total) * 100) : 0;

      const stat = (icon, value, label, cls = '') => h('div', { class: `pm-stat ${cls}` }, [
        h('span', { class: 'pm-stat-ic' }, [h('i', { class: `ph-bold ${icon}` })]),
        h('div', {}, [h('b', { text: String(value) }), h('span', { text: label })]),
      ]);

      return h('div', { class: 'pm-portfolio' }, [
        stat('ph-folders', projects.length, 'projects'),
        stat('ph-check-square', `${pct}%`, `${done} of ${total} done`),
        stat('ph-warning-circle', overdue, 'overdue', overdue ? 'is-bad' : ''),
        stat('ph-users-three', people.size, 'people'),
      ]);
    }

    _projectCard(p) {
      const tasks = this.store.projectTasks(p.id);
      const health = S.projectHealth(p, tasks);
      const members = p.members.filter(m => m.status !== 'removed');

      return h('article', {
        class: 'pm-proj-card',
        style: { '--pc': p.color },
        onclick: () => this.openProject(p.id),
        oncontextmenu: e => { e.preventDefault(); this._projectMenu(e.currentTarget, p); },
      }, [
        h('header', {}, [
          h('span', { class: 'pm-proj-ic', style: { background: p.color } }, [h('i', { class: `ph-bold ${p.icon}` })]),
          h('div', { class: 'pm-proj-headtext' }, [
            h('h3', { text: p.name }),
            h('p', { text: p.description || 'No description' }),
          ]),
          h('button', {
            type: 'button', class: 'pm-proj-menu pm-no-drag',
            onclick: e => { e.stopPropagation(); this._projectMenu(e.currentTarget, p); },
          }, [h('i', { class: 'ph ph-dots-three' })]),
        ]),

        h('div', { class: `pm-proj-health is-${health.label.replace(/\s+/g, '-')}` }, [
          h('span', { class: 'pm-proj-health-dot' }),
          h('span', { text: health.label }),
          health.overdue ? h('span', { class: 'pm-proj-overdue', text: `${health.overdue} overdue` }) : null,
        ]),

        h('div', { class: 'pm-proj-progress' }, [
          h('div', { class: 'pm-proj-progress-row' }, [
            h('span', { text: `${health.done}/${health.total} tasks` }),
            h('b', { text: health.pct + '%' }),
          ]),
          h('span', { html: U.progressBarHTML(health.pct, { color: p.color, height: 6 }) }),
        ]),

        h('footer', {}, [
          h('span', { class: 'pm-proj-avs', html: U.avatarStackHTML(members, { max: 4, size: 26 }) }),
          h('div', { class: 'pm-proj-footmeta' }, [
            health.unassigned ? h('span', { class: 'pm-proj-tag', title: 'Open tasks with nobody on them' },
              [h('i', { class: 'ph ph-user-circle-dashed' }), String(health.unassigned)]) : null,
            p.boards?.length ? h('span', { class: 'pm-proj-tag', title: 'Whiteboards' },
              [h('i', { class: 'ph ph-chalkboard' }), String(p.boards.length)]) : null,
          ]),
        ]),
      ]);
    }

    /* -- Project workspace --------------------------------------------------- */

    _renderProject() {
      const p = this.store.project(this.state.projectId);
      if (!p) return this.showDashboard();

      this._renderProjectTopbar(p);
      this._renderFilterbar(p);
      this._mountView(p);
      this._renderBulkbar();
    }

    _renderProjectTopbar(p) {
      const tabs = h('div', { class: 'pm-view-tabs' }, global.PMViews.registry.map(V => h('button', {
        type: 'button',
        class: `pm-view-tab${this.state.viewId === V.viewId ? ' is-active' : ''}`,
        onclick: () => { this.state.viewId = V.viewId; this._saveState(); this._renderProject(); },
      }, [h('i', { class: `ph ${V.icon}` }), V.label])));

      tabs.append(h('button', {
        type: 'button', class: 'pm-view-tab', title: 'Whiteboards attached to this project',
        onclick: e => this._boardsPop(e.currentTarget),
      }, [h('i', { class: 'ph ph-chalkboard' }), 'Boards', p.boards?.length ? h('span', { class: 'pm-tab-count', text: String(p.boards.length) }) : null]));

      this.topbarEl.replaceChildren(
        h('div', { class: 'pm-top-crumb' }, [
          h('button', { type: 'button', class: 'pm-crumb-back', onclick: () => this.showDashboard() }, [h('i', { class: 'ph ph-arrow-left' })]),
          h('span', { class: 'pm-proj-ic sm', style: { background: p.color } }, [h('i', { class: `ph-bold ${p.icon}` })]),
          h('h1', { text: p.name }),
          h('button', {
            type: 'button', class: 'pm-crumb-menu',
            onclick: e => this._projectMenu(e.currentTarget, p),
          }, [h('i', { class: 'ph ph-caret-down' })]),
        ]),
        tabs,
        h('div', { class: 'pm-top-actions' }, [
          this._memberButton(p),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.quickAddTask() },
            [h('i', { class: 'ph-bold ph-plus' }), 'New task']),
        ]),
      );
    }

    _memberButton(p) {
      const members = p.members.filter(m => m.status !== 'removed');
      return h('button', {
        type: 'button', class: 'pm-members-btn', title: 'Team members',
        onclick: () => this.openMembersPanel(p.id),
      }, [
        h('span', { html: U.avatarStackHTML(members, { max: 4, size: 26 }) }),
        h('i', { class: 'ph ph-user-plus' }),
      ]);
    }

    _renderFilterbar(p) {
      this.filterbarEl.classList.remove('hidden');
      const f = this.state.filter;
      const activeCount = countActiveFilters(f);

      const search = h('input', {
        class: 'pm-fb-search', type: 'search', placeholder: 'Search tasks…', value: f.text || '',
      });
      search.addEventListener('input', debounce(() => {
        this.state.filter.text = search.value;
        this._saveState();
        this._mountView(p);
      }, 180));

      this.filterbarEl.replaceChildren(
        h('div', { class: 'pm-fb-left' }, [
          h('i', { class: 'ph ph-magnifying-glass' }), search,
        ]),

        h('div', { class: 'pm-fb-right' }, [
          this._fbChip('ph-users', 'Assignee', f.assignees?.length,
            e => U.memberPicker(e.currentTarget, [{ uid: '__none', name: 'Unassigned', email: '', color: '#929aab', status: 'active' }, ...p.members],
              f.assignees || [], keys => { this.state.filter.assignees = keys; this._saveState(); this._mountView(p); }, { title: 'Filter by assignee' })),

          this._fbChip('ph-flag', 'Priority', f.priorities?.length,
            e => U.menu(e.currentTarget, S.PRIORITIES.map(pr => ({
              label: pr.name, icon: pr.icon, keepOpen: true,
              checked: (f.priorities || []).includes(pr.id),
              onClick: () => { this.state.filter.priorities = toggle(f.priorities || [], pr.id); this._saveState(); this._mountView(p); },
            })))),

          this._fbChip('ph-tag', 'Tag', f.tags?.length,
            e => U.tagPicker(e.currentTarget, p.tags || [], f.tags || [],
              tags => { this.state.filter.tags = tags; this._saveState(); this._mountView(p); })),

          h('button', {
            type: 'button', class: `pm-chip${f.overdueOnly ? ' is-on' : ''}`,
            onclick: () => { this.state.filter.overdueOnly = !f.overdueOnly; this._saveState(); this._mountView(p); },
          }, [h('i', { class: 'ph ph-warning-circle' }), 'Overdue']),

          h('button', {
            type: 'button', class: `pm-chip${f.hideDone ? ' is-on' : ''}`,
            onclick: () => { this.state.filter.hideDone = !f.hideDone; this._saveState(); this._mountView(p); },
          }, [h('i', { class: 'ph ph-eye-slash' }), 'Hide done']),

          activeCount ? h('button', {
            type: 'button', class: 'pm-chip is-clear',
            onclick: () => { this.state.filter = { hideDone: false }; this._saveState(); this._renderProject(); },
          }, [h('i', { class: 'ph ph-x' }), `Clear ${activeCount}`]) : null,

          h('span', { class: 'pm-fb-sep' }),

          h('button', {
            type: 'button', class: 'pm-chip',
            onclick: e => U.menu(e.currentTarget, [
              { header: 'Group by' },
              ...['status', 'assignee', 'priority', 'list', 'sprint', 'dueWeek', 'none'].map(g => ({
                label: GROUP_LABELS[g], icon: 'ph-rows', checked: this.state.group === g,
                onClick: () => { this.state.group = g; this._saveState(); this._renderProject(); },
              })),
            ], { align: 'end' }),
          }, [h('i', { class: 'ph ph-rows' }), GROUP_LABELS[this.state.group]]),

          h('button', {
            type: 'button', class: 'pm-chip',
            onclick: e => U.menu(e.currentTarget, [
              { header: 'Sort by' },
              ...Object.keys(S.SORTERS).map(k => ({
                label: SORT_LABELS[k] || k, icon: 'ph-sort-ascending', checked: this.state.sort === k,
                onClick: () => { this.state.sort = k; this._saveState(); this._mountView(p); },
              })),
              '-',
              {
                label: this.state.dir === 'asc' ? 'Ascending' : 'Descending', icon: 'ph-arrows-down-up',
                onClick: () => { this.state.dir = this.state.dir === 'asc' ? 'desc' : 'asc'; this._saveState(); this._mountView(p); },
              },
            ], { align: 'end' }),
          }, [h('i', { class: 'ph ph-sort-ascending' }), SORT_LABELS[this.state.sort] || this.state.sort]),
        ]),
      );
    }

    _fbChip(icon, label, count, onclick) {
      return h('button', { type: 'button', class: `pm-chip${count ? ' is-on' : ''}`, onclick }, [
        h('i', { class: `ph ${icon}` }), label,
        count ? h('span', { class: 'pm-chip-count', text: String(count) }) : null,
      ]);
    }

    _mountView(p) {
      const V = global.PMViews.registry.find(x => x.viewId === this.state.viewId) || global.PMViews.BoardView;
      if (this.view && this.view.constructor === V) { this.view.render(); return; }
      this.view?.destroy();
      this.view = new V(this.viewCtx);
      this.view.mount(this.stageEl);
    }

    /* -- My work ------------------------------------------------------------- */

    _renderMyWork() {
      this.filterbarEl.classList.add('hidden');
      const me = this._meKey();
      const mine = this.store.tasksForUser(me);

      this.topbarEl.replaceChildren(
        h('div', { class: 'pm-top-title' }, [
          h('h1', { text: 'My work' }),
          h('p', { text: `${mine.length} open task${mine.length === 1 ? '' : 's'} across every project.` }),
        ]),
      );

      const buckets = [
        { key: 'overdue', label: 'Overdue', icon: 'ph-warning-circle', cls: 'is-bad', test: t => S.isOverdue(this.store.project(t.projectId), t) },
        { key: 'today', label: 'Due today', icon: 'ph-sun', test: t => S.daysUntil(t.dueDate) === 0 },
        { key: 'week', label: 'Next 7 days', icon: 'ph-calendar-blank', test: t => { const d = S.daysUntil(t.dueDate); return d > 0 && d <= 7; } },
        { key: 'later', label: 'Later', icon: 'ph-clock-afternoon', test: t => { const d = S.daysUntil(t.dueDate); return d !== null && d > 7; } },
        { key: 'undated', label: 'No due date', icon: 'ph-tray', test: t => !t.dueDate },
      ];

      const wrap = h('div', { class: 'pm-mywork' });
      const used = new Set();

      for (const b of buckets) {
        const list = mine.filter(t => !used.has(t.id) && b.test(t));
        list.forEach(t => used.add(t.id));
        if (!list.length) continue;

        wrap.append(h('section', { class: `pm-mw-bucket ${b.cls || ''}` }, [
          h('h3', {}, [h('i', { class: `ph ${b.icon}` }), b.label, h('span', { class: 'pm-col-count', text: String(list.length) })]),
          h('div', { class: 'pm-mw-rows' }, S.sortTasks(list, 'dueDate').map(t => this._myWorkRow(t))),
        ]));
      }

      if (!mine.length) {
        wrap.append(this._emptyBox('ph-confetti', 'Nothing on your plate',
          'No open tasks are assigned to you right now.'));
      }
      this.stageEl.replaceChildren(wrap);
    }

    _myWorkRow(t) {
      const p = this.store.project(t.projectId);
      const status = S.statusOf(p, t);
      return h('div', { class: 'pm-mw-row', onclick: () => this.taskPanel.open(t.id) }, [
        h('button', {
          type: 'button', class: 'pm-lr-check pm-no-drag',
          onclick: e => {
            e.stopPropagation();
            const done = p.statuses.find(s => s.kind === 'done');
            this.store.updateTask(t.id, { statusId: (S.isDone(p, t) ? p.statuses[0] : done || p.statuses.at(-1)).id });
          },
        }, [h('i', { class: `ph ${S.isDone(p, t) ? 'ph-check-circle' : 'ph-circle'}` })]),
        h('span', { class: 'pm-mw-title', text: t.title }),
        h('button', {
          type: 'button', class: 'pm-mw-proj pm-no-drag', style: { '--pc': p.color },
          onclick: e => { e.stopPropagation(); this.openProject(p.id); },
        }, [h('i', { class: `ph ${p.icon}` }), p.name]),
        h('span', { class: 'pm-mw-status', html: U.statusPillHTML(status) }),
        h('span', { class: 'pm-mw-due', html: U.dueChipHTML(p, t) }),
        h('span', { class: 'pm-mw-prio', html: U.priorityChipHTML(t.priority, { compact: true }) }),
      ]);
    }

    /* -- Inbox --------------------------------------------------------------- */

    _renderInbox() {
      this.filterbarEl.classList.add('hidden');
      const me = this._meKey();

      // "Relevant to me" = assigned, watching, mentioned, or authored a
      // comment on it. Anything else is somebody else's noise.
      const items = [];
      for (const p of this.store.allProjects()) {
        for (const t of this.store.projectTasks(p.id)) {
          const watching = t.watchers.includes(me) || t.assignees.includes(me);
          for (const c of t.comments) {
            const mentioned = (c.mentions || []).some(x => me.includes(x) || x.includes((this.store.currentUser?.displayName || '').replace(/\s+/g, '')));
            if (c.authorId === me) continue;
            if (!watching && !mentioned) continue;
            items.push({ project: p, task: t, comment: c, mentioned });
          }
        }
      }
      items.sort((a, b) => (b.comment.at || '').localeCompare(a.comment.at || ''));

      this.topbarEl.replaceChildren(h('div', { class: 'pm-top-title' }, [
        h('h1', { text: 'Inbox' }),
        h('p', { text: 'Comments and mentions on tasks you follow.' }),
      ]));

      if (!items.length) {
        this.stageEl.replaceChildren(this._emptyBox('ph-tray', 'Inbox zero', 'No new comments on tasks you are watching.'));
        return;
      }

      this.stageEl.replaceChildren(h('div', { class: 'pm-inbox' }, items.slice(0, 100).map(it => {
        const author = this.store.member(it.project.id, it.comment.authorId) || { name: 'Someone' };
        return h('button', { type: 'button', class: `pm-inbox-row${it.mentioned ? ' is-mention' : ''}`, onclick: () => this.taskPanel.open(it.task.id) }, [
          h('span', { html: U.avatarHTML(author, 32) }),
          h('div', { class: 'pm-inbox-body' }, [
            h('div', { class: 'pm-inbox-head' }, [
              h('strong', { text: author.name || author.email }),
              it.mentioned ? h('span', { class: 'pm-inbox-badge', text: 'mentioned you' }) : null,
              h('span', { class: 'pm-inbox-on', text: `on ${it.task.title}` }),
              h('time', { text: U.relativeTime(it.comment.at) }),
            ]),
            h('div', { class: 'pm-inbox-text', html: U.renderRichText(it.comment.text, it.project.members) }),
          ]),
        ]);
      })));
    }

    _emptyBox(icon, title, body) {
      return h('div', { class: 'pm-empty pm-empty-big' }, [
        h('i', { class: `ph ${icon}` }), h('h3', { text: title }), h('p', { text: body }),
      ]);
    }

    /* ---- Bulk selection ------------------------------------------------------ */

    _toggleSelected(id, range) {
      if (range && this._lastClicked && this.view?.tasks) {
        // Shift-click selects the run between the two rows, matching
        // every file manager anyone has ever used.
        const flat = this.view.tasks();
        const a = flat.findIndex(t => t.id === this._lastClicked);
        const b = flat.findIndex(t => t.id === id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selection.add(flat[i].id);
          this._lastClicked = id;
          this._renderScreen();
          this._renderBulkbar();
          return;
        }
      }
      this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
      this._lastClicked = id;
      this._renderScreen();
      this._renderBulkbar();
    }

    _renderBulkbar() {
      const n = this.selection.size;
      if (!n) { this.bulkbarEl.classList.add('hidden'); return; }

      const p = this.store.project(this.state.projectId);
      if (!p) return;
      const ids = [...this.selection];
      this.bulkbarEl.classList.remove('hidden');

      const act = (icon, label, onclick) => h('button', { type: 'button', class: 'pm-bulk-btn', onclick }, [h('i', { class: `ph ${icon}` }), label]);

      this.bulkbarEl.replaceChildren(
        h('span', { class: 'pm-bulk-count', text: `${n} selected` }),
        act('ph-users', 'Assign', e => U.memberPicker(e.currentTarget, p.members, [],
          keys => this.store.bulk(ids, { assignees: keys }, 'bulk assign'))),
        act('ph-circle', 'Status', e => U.statusPicker(e.currentTarget, p.statuses, null,
          sid => this.store.bulk(ids, { statusId: sid }, 'bulk status'))),
        act('ph-flag', 'Priority', e => U.priorityPicker(e.currentTarget, null,
          pr => this.store.bulk(ids, { priority: pr }, 'bulk priority'))),
        act('ph-calendar-blank', 'Due date', e => U.datePicker(e.currentTarget, null,
          iso => this.store.bulk(ids, { dueDate: iso }, 'bulk due date'))),
        act('ph-archive', 'Archive', () => this.store.bulk(ids, { archived: true }, 'bulk archive')),
        h('span', { class: 'pm-fb-sep' }),
        h('button', {
          type: 'button', class: 'pm-bulk-btn is-danger',
          onclick: async () => {
            if (await U.confirm(`Delete ${n} task${n > 1 ? 's' : ''}? This cannot be undone from another device.`,
              { title: 'Delete tasks?', okLabel: 'Delete', danger: true })) {
              this.store.bulkDelete(ids);
              this.selection.clear();
              this._renderScreen();
              this._renderBulkbar();
            }
          },
        }, [h('i', { class: 'ph ph-trash' }), 'Delete']),
        h('button', {
          type: 'button', class: 'pm-bulk-close', title: 'Clear selection',
          onclick: () => { this.selection.clear(); this._renderScreen(); this._renderBulkbar(); },
        }, [h('i', { class: 'ph ph-x' })]),
      );
    }

    /* ---- Members panel --------------------------------------------------------- */

    openMembersPanel(projectId) {
      const p = this.store.project(projectId);
      if (!p) return;
      const canManage = this.store.can('member.edit', projectId);

      const list = h('div', { class: 'pm-mem-list' });
      const draw = () => {
        list.replaceChildren(...p.members.filter(m => m.status !== 'removed').map(m => {
          const key = this.store.memberKey(m);
          const role = this.store.normaliseRole(m.role);
          const load = this.store.tasksForUser(key).filter(t => t.projectId === p.id);
          return h('div', { class: 'pm-mem-row' }, [
            h('span', { html: U.avatarHTML(m, 38) }),
            h('div', { class: 'pm-mem-meta' }, [
              h('strong', { text: m.name || m.email }),
              h('small', { text: m.email }),
            ]),
            h('span', { class: 'pm-mem-load', title: 'Open tasks in this project', text: `${load.length} open` }),
            m.status === 'invited' ? h('span', { class: 'pm-mem-pending', text: 'invite pending' }) : null,
            h('button', {
              type: 'button', class: 'pm-mem-role', disabled: !canManage,
              onclick: e => U.menu(e.currentTarget, Object.entries(S.ROLES).map(([id, r]) => ({
                label: r.name, icon: 'ph-shield-check', checked: role === id,
                onClick: () => { this.store.updateMember(p.id, key, { role: id }); draw(); },
              })), { align: 'end', width: 170 }),
            }, [S.ROLES[role]?.name || role, h('i', { class: 'ph ph-caret-down' })]),
            canManage && role !== 'owner' ? h('button', {
              type: 'button', class: 'pm-tp-mini', title: 'Remove from project',
              onclick: async () => {
                if (await U.confirm(`${m.name || m.email} will lose access and be unassigned from their tasks.`,
                  { title: 'Remove member?', okLabel: 'Remove', danger: true })) {
                  this.store.removeMember(p.id, key);
                  draw();
                }
              },
            }, [h('i', { class: 'ph ph-user-minus' })]) : null,
          ]);
        }));
      };
      draw();

      const emailInput = h('input', { class: 'input', type: 'email', placeholder: 'name@gmail.com, another@company.com' });
      const roleSel = h('select', { class: 'input' }, [
        h('option', { value: 'member', text: 'Member — can create and edit tasks' }),
        h('option', { value: 'admin', text: 'Admin — can also manage people' }),
        h('option', { value: 'guest', text: 'Guest — comment on assigned tasks' }),
        h('option', { value: 'viewer', text: 'Viewer — read only' }),
      ]);

      const invite = async () => {
        const raw = emailInput.value.trim();
        if (!raw) return;
        const emails = raw.split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@'));
        if (!emails.length) { U.toast('Enter at least one valid email address.', 'warn'); return; }

        for (const email of emails) {
          this.store.addMember(p.id, { email, role: roleSel.value, status: 'invited' });
        }
        emailInput.value = '';
        draw();
        await this._sendInvites(p, emails, roleSel.value);
      };

      emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') invite(); });

      // Whether mail can go out at all, stated before the invite is sent
      // rather than guessed at afterwards. "I added a member and no email
      // arrived" had no way to be diagnosed from the UI: there was nothing
      // anywhere that said which route mail took, or whether there was one.
      const mailLine = h('p', { class: 'pm-mail-route', text: 'Checking how email is sent…' });
      this._paintMailRoute(mailLine);

      const body = h('div', { class: 'pm-mem-panel' }, [
        canManage ? h('div', { class: 'pm-mem-invite' }, [
          h('h4', { text: 'Invite teammates' }),
          h('p', { text: 'They get an email with a direct link. Once they sign in with Google, their account links automatically.' }),
          h('div', { class: 'pm-mem-invite-row' }, [emailInput, roleSel,
            h('button', { type: 'button', class: 'btn btn-primary', text: 'Send invite', onclick: invite })]),
          mailLine,
        ]) : null,
        h('h4', { text: `Members (${p.members.filter(m => m.status !== 'removed').length})` }),
        list,
      ].filter(Boolean));

      this._modal(`People on ${p.name}`, body, { width: 620 });
    }

    /**
     * Say which route invitations take, and offer to prove it.
     *
     * The test button sends one real message to the connected account's own
     * address and reports the result, which turns "did that work?" from a
     * guess into a five-second answer.
     */
    async _paintMailRoute(node) {
      let s;
      try {
        s = await (await fetch('/api/pm/email/status')).json();
      } catch {
        node.textContent = 'Could not reach the server to check email.';
        return;
      }

      node.textContent = '';
      if (!s.configured) {
        node.dataset.state = 'off';
        node.append(
          h('i', { class: 'ph-bold ph-warning-circle' }),
          h('span', { text: 'Nothing will be emailed — this server has no way to send mail. Connect Google in the sidebar and accept the Gmail permission; that alone is enough.' }),
        );
        return;
      }

      node.dataset.state = 'ok';
      node.append(
        h('i', { class: 'ph-bold ph-check-circle' }),
        h('span', { text: s.route === 'gmail'
          ? `Invitations are sent from ${s.gmail?.from || 'your connected Google account'}.`
          : `Invitations are sent over SMTP as ${s.smtp?.from || s.server}.` }),
        h('button', {
          type: 'button', class: 'pm-mail-test', text: 'Send a test',
          onclick: async ev => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Sending…';
            try {
              const r = await fetch('/api/pm/email/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
              });
              const d = await r.json();
              U.toast(d.ok
                ? `Test email sent to ${d.to}. If it is not in the inbox, check spam.`
                : `Could not send: ${d.error || d.fix || 'unknown error'}`,
                d.ok ? 'success' : 'warn', 7000);
            } catch {
              U.toast('The server did not answer the test request.', 'warn');
            }
            btn.disabled = false;
            btn.textContent = 'Send a test';
          },
        }),
      );
    }

    async _sendInvites(project, emails, role) {
      const inviter = this.store.currentUser?.displayName || this.store.currentUser?.email || 'A teammate';
      const link = `${location.origin}${location.pathname}?project=${encodeURIComponent(project.id)}`;
      try {
        const res = await fetch('/api/pm/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails, role, inviter, projectId: project.id, projectName: project.name, link }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'failed');

        // The server now sends small batches before it answers and reports
        // what actually happened, per address. Reporting "not configured"
        // off the SMTP setting alone is what made a delivered invitation
        // look like a failed one — mail was going out through the connected
        // Google account the whole time.
        const n = emails.length;
        const plural = n > 1 ? 'es' : '';

        if (data.mode === 'simulated') {
          U.toast(`${n} member${n > 1 ? 's' : ''} added, but nothing was emailed — this server has no way to send mail yet. ` +
            (data.hint || 'Connect Google and accept the Gmail permission.'), 'warn', 8000);
        } else if (data.failed > 0) {
          const why = data.results?.find(r => !r.sent)?.error;
          U.toast(`${data.sent} of ${n} invitation${plural} sent. ${data.failed} failed${why ? ': ' + why : '.'}`,
            'warn', 8000);
        } else if (data.queued) {
          U.toast(`${n} invitation${plural} queued — they go out in the background.`, 'info', 4000);
        } else {
          U.toast(`Invitation${plural} sent to ${n} address${plural}` +
            (data.from ? ` from ${data.from}.` : '.'), 'success', 4500);
        }
      } catch (err) {
        U.toast('Member added, but the invitation email could not be sent.', 'warn', 4000);
      }
    }

    /* ---- Project creation & menus ------------------------------------------------ */

    promptCreateProject() {
      const name = h('input', { class: 'input', placeholder: 'Project name' });
      const desc = h('input', { class: 'input', placeholder: 'What is this project for? (optional)' });
      const invites = h('input', { class: 'input', placeholder: 'Invite by email, comma separated (optional)' });

      let preset = 'simple';
      const presetRow = h('div', { class: 'pm-preset-row' },
        Object.entries(S.PIPELINE_PRESETS).map(([k, v]) => h('button', {
          type: 'button', class: `pm-preset${k === preset ? ' is-on' : ''}`,
          onclick: e => {
            preset = k;
            presetRow.querySelectorAll('.pm-preset').forEach(b => b.classList.remove('is-on'));
            e.currentTarget.classList.add('is-on');
          },
        }, [
          h('strong', { text: v.name }),
          h('span', { class: 'pm-preset-dots' }, v.statuses.map(s => h('i', { style: { background: s.color } }))),
        ])));

      let color = '#4262ff';
      const colorRow = h('div', { class: 'pm-color-row' },
        ['#4262ff', '#17a673', '#e8912b', '#e0455e', '#a855f7', '#06b6d4', '#ec4899', '#767f92'].map(c => h('button', {
          type: 'button', class: `pm-color-dot${c === color ? ' is-on' : ''}`, style: { background: c },
          onclick: e => {
            color = c;
            colorRow.querySelectorAll('.pm-color-dot').forEach(b => b.classList.remove('is-on'));
            e.currentTarget.classList.add('is-on');
          },
        })));

      let templateId = null;
      const templates = global.PMTemplates ? global.PMTemplates.list() : [];
      const tplSel = templates.length ? h('select', { class: 'input' }, [
        h('option', { value: '', text: 'Start empty' }),
        ...templates.map(t => h('option', { value: t.id, text: `${t.name} — ${t.tasks.length} starter tasks` })),
      ]) : null;
      tplSel?.addEventListener('change', () => { templateId = tplSel.value || null; });

      const body = h('div', { class: 'pm-form' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Name' }), name]),
        h('label', { class: 'field' }, [h('span', { text: 'Description' }), desc]),
        h('label', { class: 'field' }, [h('span', { text: 'Workflow' }), presetRow]),
        tplSel ? h('label', { class: 'field' }, [h('span', { text: 'Start from a template' }), tplSel]) : null,
        h('label', { class: 'field' }, [h('span', { text: 'Colour' }), colorRow]),
        h('label', { class: 'field' }, [h('span', { text: 'Invite people' }), invites]),
      ].filter(Boolean));

      const close = this._modal('New project', body, {
        width: 560,
        primary: {
          label: 'Create project',
          onClick: async () => {
            const n = name.value.trim();
            if (!n) { name.focus(); U.toast('Give the project a name.', 'warn'); return false; }

            const p = this.store.createProject({ name: n, description: desc.value.trim(), preset, color });

            if (templateId && global.PMTemplates) global.PMTemplates.apply(this.store, p.id, templateId);

            const emails = invites.value.split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@'));
            for (const email of emails) this.store.addMember(p.id, { email, role: 'member', status: 'invited' });
            if (emails.length) this._sendInvites(p, emails, 'member');

            this.openProject(p.id);
            return true;
          },
        },
      });
      name.focus();
    }

    _projectMenu(anchor, p) {
      U.menu(anchor, [
        { label: 'Open', icon: 'ph-arrow-square-out', onClick: () => this.openProject(p.id) },
        { label: 'People', icon: 'ph-users', onClick: () => this.openMembersPanel(p.id) },
        { label: 'Settings', icon: 'ph-gear', onClick: () => this.openProjectSettings(p.id) },
        '-',
        // Each board belongs to this project and reopens as itself. Listing
        // them here means the whiteboard is reachable without first opening
        // the project — the step people kept missing.
        ...(p.boards || []).slice(0, 6).map(b => ({
          label: b.name || b.id, icon: 'ph-chalkboard',
          onClick: () => this.openBoard(b.id, p.id),
        })),
        { label: 'New whiteboard for this project', icon: 'ph-plus', onClick: () => this.createProjectBoard(p.id) },
        { label: 'Export as JSON', icon: 'ph-download-simple', onClick: () => this._export(p) },
        '-',
        {
          label: 'Delete project', icon: 'ph-trash', danger: true,
          disabled: !this.store.can('project.edit', p.id),
          onClick: async () => {
            const n = this.store.projectTasks(p.id).length;
            if (await U.confirm(`"${p.name}" and its ${n} task${n === 1 ? '' : 's'} will be permanently deleted.`,
              { title: 'Delete project?', okLabel: 'Delete everything', danger: true })) {
              await this.store.deleteProject(p.id);
              this.showDashboard();
            }
          },
        },
      ], { align: 'end', width: 250 });
    }

    openProjectSettings(projectId) {
      const p = this.store.project(projectId);
      if (!p) return;

      const name = h('input', { class: 'input', value: p.name });
      const desc = h('input', { class: 'input', value: p.description });
      const autoEmail = p.settings?.autoEmail || {};

      const toggleRow = (key, label, hint) => h('label', { class: 'pm-toggle-row' }, [
        h('input', {
          type: 'checkbox', checked: !!autoEmail[key],
          onchange: e => this.store.updateProject(p.id, {
            settings: { ...p.settings, autoEmail: { ...autoEmail, [key]: e.target.checked } },
          }),
        }),
        h('div', {}, [h('strong', { text: label }), h('small', { text: hint })]),
      ]);

      const statusEditor = h('div', { class: 'pm-status-editor' }, p.statuses.map(s => h('div', { class: 'pm-status-edit-row' }, [
        h('input', { type: 'color', class: 'pm-color-input', value: s.color, onchange: e => this.store.updateStatus(p.id, s.id, { color: e.target.value }) }),
        h('input', { class: 'input', value: s.name, onchange: e => this.store.updateStatus(p.id, s.id, { name: e.target.value.trim() || s.name }) }),
        h('select', { class: 'input', onchange: e => this.store.updateStatus(p.id, s.id, { kind: e.target.value }) },
          S.STATUS_KINDS.map(k => h('option', { value: k, text: k, selected: k === s.kind }))),
        h('span', { class: 'pm-status-edit-count', text: `${this.store.tasksInStatus(p.id, s.id).length} tasks` }),
      ])));

      const fieldsEditor = h('div', { class: 'pm-fields-editor' });
      const drawFields = () => {
        fieldsEditor.replaceChildren(
          ...(p.customFields || []).map(f => h('div', { class: 'pm-field-row' }, [
            h('i', { class: 'ph ph-textbox' }),
            h('strong', { text: f.name }),
            h('span', { class: 'pm-field-type', text: S.FIELD_TYPES[f.type]?.name || f.type }),
            h('button', {
              type: 'button', class: 'pm-tp-mini', title: 'Remove field',
              onclick: async () => {
                if (await U.confirm(`"${f.name}" and its values on every task will be removed.`, { title: 'Remove field?', okLabel: 'Remove', danger: true })) {
                  this.store.removeCustomField(p.id, f.id);
                  drawFields();
                }
              },
            }, [h('i', { class: 'ph ph-x' })]),
          ])),
          h('button', {
            type: 'button', class: 'pm-tp-add-btn',
            onclick: e => {
              const fname = h('input', { class: 'input', placeholder: 'Field name' });
              const ftype = h('select', { class: 'input' }, Object.entries(S.FIELD_TYPES).map(([k, v]) => h('option', { value: k, text: v.name })));
              const opts = h('input', { class: 'input', placeholder: 'Options, comma separated (dropdown only)' });
              U.Pop.open(e.currentTarget, h('div', {}, [
                h('div', { class: 'pm-pop-title', text: 'New field' }), fname, ftype, opts,
                h('button', {
                  type: 'button', class: 'btn btn-primary pm-pop-go', text: 'Add field',
                  onclick: () => {
                    if (!fname.value.trim()) return;
                    this.store.addCustomField(p.id, {
                      name: fname.value.trim(), type: ftype.value,
                      options: opts.value.split(',').map(x => x.trim()).filter(Boolean),
                    });
                    U.Pop.close();
                    drawFields();
                  },
                }),
              ]), { width: 260, className: 'pm-pop-form' });
            },
          }, [h('i', { class: 'ph ph-plus' }), 'Add a custom field']),
        );
      };
      drawFields();

      const body = h('div', { class: 'pm-form' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Name' }), name]),
        h('label', { class: 'field' }, [h('span', { text: 'Description' }), desc]),

        h('h4', { class: 'pm-form-h', text: 'Statuses' }),
        statusEditor,

        h('h4', { class: 'pm-form-h', text: 'Custom fields' }),
        fieldsEditor,

        h('h4', { class: 'pm-form-h', text: 'Email automation' }),
        toggleRow('onAssign', 'When someone is assigned', 'Email the assignee with the task and its due date.'),
        toggleRow('onMention', 'When someone is @mentioned', 'Email them the comment.'),
        toggleRow('onDueSoon', 'Due-date reminders', 'A morning email listing what is due today.'),
        toggleRow('onStatusDone', 'When a task is completed', 'Notify watchers.'),
      ]);

      this._modal(`${p.name} settings`, body, {
        width: 640,
        primary: {
          label: 'Save', onClick: () => {
            this.store.updateProject(p.id, { name: name.value.trim() || p.name, description: desc.value.trim() });
            return true;
          },
        },
      });
    }

    _export(p) {
      const payload = this.store.exportProject(p.id);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      global.Util?.download
        ? global.Util.download(blob, `${(p.name || 'project').replace(/[^\w-]+/g, '_')}.json`)
        : window.open(URL.createObjectURL(blob));
    }

    _importPop(anchor) {
      const input = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const payload = JSON.parse(await file.text());
          const p = this.store.importProject(payload);
          if (p) { U.toast(`Imported "${p.name}".`, 'success'); this.openProject(p.id); }
        } catch (err) {
          U.toast('That file is not a valid project export.', 'warn');
        }
      });
      document.body.append(input);
      input.click();
      setTimeout(() => input.remove(), 1000);
    }

    /* ---- Whiteboard integration ------------------------------------------------- */

    _boardsPop(anchor) {
      const p = this.store.project(this.state.projectId);
      if (!p) return;
      const current = this.app?.store?.state?.id;

      const items = (p.boards || []).map(b => ({
        label: b.name || b.id,
        icon: b.id === current ? 'ph-chalkboard-simple' : 'ph-chalkboard',
        checked: b.id === current,
        onClick: () => this.openBoard(b.id, p.id),
      }));
      if (!items.length) items.push({ header: 'This project has no whiteboard yet' });

      items.push('-', {
        label: 'New whiteboard', icon: 'ph-plus',
        onClick: () => this.createProjectBoard(p.id),
      });
      U.menu(anchor || this.topbarEl.querySelector('.pm-view-tab:last-of-type'), items, { width: 260 });
    }

    createProjectBoard(projectId) {
      const p = this.store.project(projectId);
      if (!p) return;

      const input = h('input', {
        type: 'text', class: 'input',
        value: `${p.name} — canvas ${(p.boards?.length || 0) + 1}`,
      });

      this._modal('New whiteboard', h('div', { class: 'pm-form' }, [
        h('label', { class: 'field' }, [h('span', { text: 'Name' }), input]),
        h('p', { class: 'pm-setup-note', text: 'The board belongs to this project. Opening it later always brings back exactly this canvas.' }),
      ]), {
        width: 460,
        primary: {
          label: 'Create',
          onClick: () => {
            const name = input.value.trim();
            if (!name) return false;
            // Board ids must survive safe_board_id() on the server, which
            // only accepts [A-Za-z0-9_-]. S.uid() can contain neither, but
            // strip defensively — a rejected id is a 400 the user cannot read.
            const id = ('board_' + S.uid('b').slice(2, 12)).replace(/[^A-Za-z0-9_-]/g, '');
            const board = { id, name, projectId, createdAt: S.nowISO() };
            this.store.updateProject(projectId, { boards: [...(p.boards || []), board] });
            this.openBoard(id, projectId, { create: name });
          },
        },
      });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    }

    /**
     * Open a project's whiteboard.
     *
     * The old version called app.loadBoard() and walked away. When the board
     * had never been saved — every board created from a project, since
     * creating one only wrote a record into the project — the server answered
     * 404, the canvas was left showing whatever was already on it, and every
     * project appeared to share one whiteboard. Passing `create` lets the
     * canvas start a genuinely blank board under that id instead.
     */
    async openBoard(boardId, projectId, { create = null } = {}) {
      if (!this.app?.loadBoard) { U.toast('The whiteboard is not loaded.', 'warn'); return; }

      const p = this.store.project(projectId || this.state.projectId);
      const record = (p?.boards || []).find(b => b.id === boardId);

      this.close();
      const ok = await this.app.loadBoard(boardId, {
        createIfMissing: create || record?.name || 'Untitled Board',
        projectId: p?.id || null,
        projectName: p?.name || null,
      });
      if (ok && p) this.store.updateProject(p.id, { lastBoardId: boardId });
    }

    /** The middle of what the user is currently looking at, in board space. */
    _canvasCentre() {
      const r = this.app?.viewport?.visibleRect?.();
      return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 };
    }

    _focusElement(el) {
      if (!el || !this.app?.viewport) return;
      this.app.viewport.centerOn(el.x + (el.width || 0) / 2, el.y + (el.height || 0) / 2);
    }

    /** Drop a task onto the canvas as a sticky note wired back to the task. */
    sendTaskToCanvas(taskId) {
      const t = this.store.task(taskId);
      if (!t || !this.app?.store) { U.toast('Open a whiteboard first.', 'warn'); return; }
      const p = this.store.project(t.projectId);
      const status = S.statusOf(p, t);
      const assignees = (t.assignees || [])
        .map(k => this.store.member(p.id, k)).filter(Boolean).map(m => m.name).join(', ');

      const centre = this._canvasCentre();
      const el = this.app.store.addElement('sticky-note', {
        x: centre.x - 110, y: centre.y - 90, width: 220, height: 180,
        content: `${t.title}${t.dueDate ? `\n\nDue ${t.dueDate}` : ''}${assignees ? `\n${assignees}` : ''}`,
        style: { backgroundColor: status.color + '33' },
        meta: { pmTaskId: t.id, pmProjectId: t.projectId },
      });

      this.store.addAttachment(t.id, {
        kind: 'board', boardId: this.app.store.state.id, elementId: el.id,
        name: 'Sticky on ' + (this.app.store.state.name || 'board'),
      });
      this.close();
      this._focusElement(el);
      U.toast('Task placed on the whiteboard.', 'success');
    }

    revealOnCanvas(boardId, elementId) {
      if (!this.app) return;
      this.close();

      const focus = () => {
        const el = this.app.store.get(elementId);
        if (!el) { U.toast('That object is no longer on the board.', 'warn'); return; }
        this.app.store.select(elementId);
        this._focusElement(el);
      };

      if (this.app.store.state.id === boardId) focus();
      // Loading a board is async; wait for it to land rather than guessing.
      else Promise.resolve(this.app.loadBoard?.(boardId)).then(() => setTimeout(focus, 120));
    }

    /**
     * Mirror a task's due date into Google Calendar. The returned event id is
     * stored on the task, so pushing again updates that event rather than
     * littering the calendar with duplicates.
     */
    async pushToCalendar(taskId, { quiet = false } = {}) {
      const t = this.store.task(taskId);
      if (!t) return false;
      if (!t.dueDate) { if (!quiet) U.toast('Give the task a due date first.', 'warn'); return false; }

      const status = await global.PMGoogle?.api.status();
      if (!status?.configured) {
        if (!quiet) { U.toast('Google is not set up on this server yet.', 'info', 4000); this.showWorkspace(); }
        return false;
      }
      if (!status.connected) { return quiet ? false : this.connectGoogle(); }

      const p = this.store.project(t.projectId);
      const attendees = (t.assignees || [])
        .map(k => this.store.member(p.id, k)?.email).filter(Boolean);

      try {
        const res = await fetch('/api/google/calendar/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: t.title,
            description: t.description,
            dueDate: t.dueDate,
            dueTime: t.dueTime,
            eventId: t.calendarEventId,
            attendees,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            link: `${location.origin}${location.pathname}?project=${t.projectId}&task=${t.id}`,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          // The server turns the common Google failures (API not enabled,
          // missing scope, expired token) into a `fix` line worth showing in
          // full rather than as a toast that vanishes.
          if (!quiet) this._googleError(data);
          return false;
        }

        const wasLinked = !!t.calendarEventId;
        this.store.updateTask(t.id, { calendarEventId: data.eventId }, { silentActivity: true });
        if (!quiet) U.toast(wasLinked ? 'Calendar event updated.' : 'Added to Google Calendar.', 'success');
        return true;
      } catch (err) {
        if (!quiet) U.toast('Could not reach the server: ' + err.message, 'warn', 5000);
        return false;
      }
    }

    /** Show an actionable Google failure, with its console link clickable. */
    _googleError(data) {
      if (!data?.fix) { U.toast(data?.error || 'Google request failed.', 'warn', 5000); return; }

      const linkified = esc(data.fix).replace(
        /(https?:\/\/[^\s]+)/,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

      this._modal('Google needs one more step', h('div', { class: 'pm-form' }, [
        h('p', { text: data.error }),
        h('p', { class: 'pm-setup-note', html: linkified }),
      ]), { width: 560 });
    }

    /**
     * Open the OAuth popup. The flow itself lives in pm/google.js so there is
     * exactly one implementation of it — the duplicate that used to live here
     * had its own status cache and could disagree with the Workspace screen
     * about whether the account was connected.
     */
    async connectGoogle() {
      const G = global.PMGoogle;
      if (!G) { U.toast('The Google module did not load. Hard-refresh the page.', 'warn'); return false; }
      const ok = await G.api.connect();
      if (ok) U.toast('Google connected.', 'success');
      this._refreshGoogleChip();
      return ok;
    }

    /** Attach a Google Keep note, reusing the whiteboard's existing Keep login. */
    attachFromKeep(taskId) {
      const keep = this.app?.keep;
      if (!keep) { U.toast('The Google Keep integration is not loaded.', 'warn'); return; }
      this.close();
      keep.openModal();
      U.toast('Pick your notes — they will import onto the canvas, then attach them from there.', 'info', 6000);
    }

    attachFromBoard(taskId) {
      if (!this.app?.store) { U.toast('Open a whiteboard first.', 'warn'); return; }
      const selected = this.app.store.selected?.() || [];
      if (!selected.length) { U.toast('Select an object on the whiteboard first, then attach.', 'info', 4000); return; }
      for (const el of selected) {
        this.store.addAttachment(taskId, {
          kind: 'board', boardId: this.app.store.state.id, elementId: el.id,
          name: (el.content || el.type || 'Object').toString().slice(0, 40),
        });
      }
      U.toast(`Attached ${selected.length} object(s).`, 'success');
    }

    /* ---- Misc --------------------------------------------------------------------- */

    quickAddTask() {
      const p = this.store.project(this.state.projectId);
      if (!p) { this.promptCreateProject(); return; }
      const t = this.store.createTask({ projectId: p.id, title: 'New task' });
      this.taskPanel.open(t.id);
    }

    onPanelClosed() { this._renderScreen(); }

    _meKey() {
      const u = this.store.currentUser;
      return u ? (u.uid || u.email) : 'anon';
    }

    _onKey(e) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

      if (e.key.toLowerCase() === 'p' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        this.isOpen ? this.close() : this.open();
        return;
      }
      if (!this.isOpen || typing) return;

      if (e.key === 'Escape' && this.selection.size && !U.Pop.isOpen && !this.taskPanel.taskId) {
        this.selection.clear(); this._renderScreen(); this._renderBulkbar(); return;
      }
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.quickAddTask(); return; }
      if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.shiftKey ? this.store.redo() : this.store.undo();
        return;
      }
      // 1–5 switch views, matching the tab order.
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= global.PMViews.registry.length && this.state.screen === 'project') {
        this.state.viewId = global.PMViews.registry[n - 1].viewId;
        this._saveState();
        this._renderProject();
      }
    }

    /** A modal built on the same shell as the rest of the app. */
    _modal(title, body, { width = 520, primary = null } = {}) {
      const overlay = h('div', { class: 'pm-modal-overlay' });
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };

      const box = h('div', { class: 'pm-modal', style: { maxWidth: width + 'px' } }, [
        h('div', { class: 'pm-modal-head' }, [
          h('h3', { text: title }),
          h('button', { type: 'button', class: 'pm-modal-x', onclick: close }, [h('i', { class: 'ph ph-x' })]),
        ]),
        h('div', { class: 'pm-modal-body' }, [body]),
        h('div', { class: 'pm-modal-foot' }, [
          h('button', { type: 'button', class: 'btn btn-ghost', text: primary ? 'Cancel' : 'Close', onclick: close }),
          primary ? h('button', {
            type: 'button', class: 'btn btn-primary', text: primary.label,
            onclick: async () => { if (await primary.onClick() !== false) close(); },
          }) : null,
        ]),
      ]);

      overlay.append(box);
      overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });
      const onKey = e => { if (e.key === 'Escape' && !U.Pop.isOpen) close(); };
      document.addEventListener('keydown', onKey, true);
      document.body.append(overlay);
      return close;
    }
  }

  /* ---- helpers ---------------------------------------------------------------- */

  const GROUP_LABELS = {
    status: 'Status', assignee: 'Assignee', priority: 'Priority',
    list: 'List', sprint: 'Sprint', dueWeek: 'Due week', tag: 'Tag', none: 'No grouping',
  };

  const SORT_LABELS = {
    manual: 'Manual', title: 'Name', priority: 'Priority', dueDate: 'Due date',
    startDate: 'Start date', created: 'Created', updated: 'Last updated', estimate: 'Estimate',
  };

  function toggle(arr, v) { return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]; }

  function countActiveFilters(f) {
    let n = 0;
    if (f.text) n++;
    for (const k of ['assignees', 'priorities', 'tags', 'statusIds', 'listIds', 'sprintIds']) if (f[k]?.length) n++;
    for (const k of ['overdueOnly', 'unassignedOnly', 'noDueDate', 'dueBefore', 'dueAfter']) if (f[k]) n++;
    return n;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  global.PMHub = PMHub;

})(window);
