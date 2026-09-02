/* ================================================================
   pm/boot.js — Wiring: adapter selection, auth, automation dispatch
   ----------------------------------------------------------------
   Boot order matters here.

   1. Start immediately on the LocalAdapter so the workspace is usable
      before Firebase has even loaded. Signed-out users get a fully
      working single-device tool.
   2. When the Firebase module finishes (it is deferred, so it lands
      after every classic script) and reports a signed-in user, swap to
      the FirestoreAdapter.
   3. Offer to migrate anything created while signed out, rather than
      silently abandoning it on the old adapter.

   Signing out swaps back. Nothing is deleted in either direction.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;
  const U = global.PMUI;

  const MIGRATE_ASKED = 'pm.migrate.asked.v1';

  const PMBoot = {
    store: null,
    hub: null,
    localAdapter: null,
    _mode: 'none',

    async init(app) {
      this.store = global.PMWorkStore;

      // 1. Local first — instant, offline-safe.
      this.localAdapter = new global.PMAdapters.LocalAdapter();
      await this.store.connect(this.localAdapter, null);
      this._mode = 'local';

      // 2. The hub can render now.
      this.hub = new global.PMHub(this.store, app || global.app || null);
      global.pmHub = this.hub;

      this._wireAutomations();
      this._wireCanvasBridge(app);
      this._chooseLanding();

      // 3. Upgrade to Firestore when Firebase is ready and someone is in.
      const attach = () => this._watchAuth();
      if (global.FirebaseSync) attach();
      else global.addEventListener('firebase-ready', attach, { once: true });

      return this;
    },

    /**
     * What the app shows on load.
     *
     * It used to drop straight onto a whiteboard, which is the wrong door:
     * a board only means something inside a project, and landing on a bare
     * canvas is what made every project look like it shared one board.
     * Projects is now the front page. A `?board=` link still goes straight
     * to that canvas, and `?project=` is handled by the hub's own router.
     */
    _chooseLanding() {
      const params = new URLSearchParams(location.search);
      if (params.get('board')) return;                 // deep link to a canvas
      if (params.get('project')) return;               // the hub router opens it

      const pref = global.app?.settings?.landing || 'projects';
      if (pref === 'canvas') return;

      this.hub.showDashboard();
      this.hub.open();
    },

    /* ---- Auth-driven adapter swap ------------------------------------- */

    _watchAuth() {
      global.FirebaseSync.onUserChange(async user => {
        if (user && this._mode !== 'firestore') await this._goCloud(user);
        else if (!user && this._mode === 'firestore') await this._goLocal();
        else if (user) this.store.currentUser = normaliseUser(user);
      });
    },

    async _goCloud(user) {
      const fb = global.FB;
      if (!fb) { console.warn('[pm] Firebase bridge missing; staying local'); return; }

      // Capture the local data *before* swapping — the adapter's own
      // dispose() flushes but does not hand anything back.
      const localDump = this.localAdapter.dump();

      const adapter = new global.PMAdapters.FirestoreAdapter(fb, user);
      await this.store.connect(adapter, normaliseUser(user));
      this._mode = 'firestore';
      this.store.activeProjectId && adapter.watchProject(this.store.activeProjectId);

      U.toast('Projects are now syncing with Firebase.', 'success', 2600);
      await this._maybeMigrate(adapter, localDump, user);
    },

    async _goLocal() {
      await this.store.connect(this.localAdapter, null);
      this._mode = 'local';
      U.toast('Signed out — showing projects saved on this device.', 'info', 3000);
    },

    /**
     * Offer once per project set. Asking on every sign-in would be
     * nagging; never asking would strand work.
     */
    async _maybeMigrate(adapter, dump, user) {
      const orphans = (dump.projects || []).filter(p =>
        !this.store.project(p.id) &&
        (dump.tasks[p.id]?.length || p.name !== 'New project'));
      if (!orphans.length) return;

      let asked = [];
      try { asked = JSON.parse(localStorage.getItem(MIGRATE_ASKED) || '[]'); } catch {}
      const fresh = orphans.filter(p => !asked.includes(p.id));
      if (!fresh.length) return;

      const taskCount = fresh.reduce((n, p) => n + (dump.tasks[p.id]?.length || 0), 0);
      const yes = await U.confirm(
        `${fresh.length} project${fresh.length > 1 ? 's' : ''} and ${taskCount} task${taskCount === 1 ? '' : 's'} were created on this device before you signed in. Upload them to your account so your team can see them?`,
        { title: 'Upload local projects?', okLabel: 'Upload' });

      localStorage.setItem(MIGRATE_ASKED, JSON.stringify([...asked, ...fresh.map(p => p.id)]));
      if (!yes) return;

      try {
        const ids = await adapter.migrate({ projects: fresh, tasks: dump.tasks }, normaliseUser(user));
        U.toast(`Uploaded ${ids.length} project${ids.length > 1 ? 's' : ''}.`, 'success');
      } catch (err) {
        console.error('[pm] migration failed', err);
        U.toast('Upload failed. Your local copy is untouched.', 'warn', 5000);
      }
    },

    /* ---- Automation dispatch -------------------------------------------- */

    /**
     * The WorkStore emits domain events; this turns the ones the
     * project has opted into via settings.autoEmail into server calls.
     * Fire-and-forget by design — a mail failure must never surface as
     * a failed task edit.
     */
    _wireAutomations() {
      const post = (path, body) => fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(err => console.debug('[pm] automation call failed', path, err));

      this.store.on('notify', payload => {
        const { event, task } = payload;
        const project = task ? this.store.project(task.projectId) : payload.project;
        const auto = project?.settings?.autoEmail || {};
        const link = task
          ? `${location.origin}${location.pathname}?project=${project.id}&task=${task.id}`
          : `${location.origin}${location.pathname}?project=${project?.id || ''}`;

        const actor = this.store.currentUser?.displayName || this.store.currentUser?.email || 'A teammate';
        const emailOf = key => this.store.member(project?.id, key)?.email;

        if (event === 'task.assigned' && auto.onAssign) {
          const to = emailOf(payload.memberKey);
          // Nobody needs an email telling them they assigned themselves.
          if (to && to !== this.store.currentUser?.email) {
            post('/api/pm/notify', {
              kind: 'assigned', to, actor, link,
              projectName: project.name, taskTitle: task.title,
              dueDate: task.dueDate, priority: task.priority,
            });
          }
        }

        if (event === 'task.mentioned' && auto.onMention) {
          const recipients = (payload.mentions || [])
            .map(handle => project.members.find(m =>
              (m.email || '').toLowerCase().startsWith(handle.toLowerCase()) ||
              (m.name || '').replace(/\s+/g, '').toLowerCase() === handle.toLowerCase()))
            .filter(m => m && m.email && m.email !== this.store.currentUser?.email);

          for (const m of recipients) {
            post('/api/pm/notify', {
              kind: 'mention', to: m.email, actor, link,
              projectName: project.name, taskTitle: task.title,
              comment: payload.comment.text,
            });
          }
        }

        if (event === 'task.completed' && auto.onStatusDone) {
          const watchers = [...new Set([...(task.watchers || []), ...(task.assignees || [])])]
            .map(emailOf).filter(e => e && e !== this.store.currentUser?.email);
          for (const to of watchers) {
            post('/api/pm/notify', { kind: 'completed', to, actor, link, projectName: project.name, taskTitle: task.title });
          }
        }
      });
    },

    /* ---- Canvas bridge -------------------------------------------------- */

    /**
     * Keeps a whiteboard sticky note and its task in step. A note
     * carrying `meta.pmTaskId` is a live view of that task: rename the
     * note, the task is renamed.
     */
    _wireCanvasBridge(app) {
      if (!app?.store?.on) return;

      app.store.on('change', ({ label }) => {
        if (!label || !/update element|edit/.test(label)) return;
        for (const el of app.store.state.elements) {
          const taskId = el.meta?.pmTaskId;
          if (!taskId) continue;
          const task = this.store.task(taskId);
          if (!task) continue;

          const firstLine = String(el.content || '').split('\n')[0].trim();
          if (firstLine && firstLine !== task.title) {
            this.store.updateTask(taskId, { title: firstLine }, { label: 'rename from canvas' });
          }
        }
      });

      // Deleting a linked note should not delete the task — that would
      // be a surprising amount of destruction from one Delete key — but
      // the dangling attachment is worth cleaning up.
      app.store.on('change', ({ label }) => {
        if (label !== 'delete') return;
        for (const t of this.store.tasks.values()) {
          const stale = (t.attachments || []).filter(a =>
            a.kind === 'board' && a.boardId === app.store.state.id && !app.store.get(a.elementId));
          for (const a of stale) this.store.removeAttachment(t.id, a.id);
        }
      });
    },
  };

  function normaliseUser(u) {
    return { uid: u.uid, email: (u.email || '').toLowerCase(), displayName: u.displayName || u.email, photoURL: u.photoURL || null };
  }

  global.PMBoot = PMBoot;

  // Boot once the whiteboard app exists (it creates window.app at the
  // end of app.js). If it never does, boot standalone anyway.
  function start() {
    if (global.__pmStarted) return;
    global.__pmStarted = true;
    PMBoot.init(global.app).catch(err => console.error('[pm] boot failed', err));
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 0);
  else global.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));

})(window);
