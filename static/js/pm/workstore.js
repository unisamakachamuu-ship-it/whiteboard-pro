/* ================================================================
   pm/workstore.js — Single source of truth for projects and tasks
   ----------------------------------------------------------------
   The canvas has `Store`; work items have `WorkStore`. Same contract,
   same reason: if every mutation funnels through one method, then
   undo, autosave, realtime sync, the activity feed and the email
   automations are all written once instead of once per feature.

   Nothing outside this file may mutate a task object. Views call
   `updateTask()` and re-render from the `tasks-changed` event. A view
   that reaches in and sets `task.title = x` will appear to work and
   will silently break undo, sync and notifications — which is exactly
   the failure mode the old flat task list had.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;
  const HISTORY_LIMIT = 60;

  /* ------------------------------------------------------------------
     Patch algebra

     A mutation is recorded as the minimal before/after pair. Undo is
     then just "apply `before`", and the sync adapter gets a payload
     containing only the changed fields instead of the whole task.
     ------------------------------------------------------------------ */

  function diffPatch(target, patch) {
    const before = {};
    const after = {};
    for (const [k, v] of Object.entries(patch)) {
      const cur = target[k];
      if (deepEqual(cur, v)) continue;
      before[k] = clone(cur);
      after[k] = clone(v);
    }
    return { before, after, empty: !Object.keys(after).length };
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }

  function clone(v) {
    if (v == null || typeof v !== 'object') return v;
    return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }

  /* ================================================================
     WorkStore
     ================================================================ */

  class WorkStore extends global.Emitter {
    constructor() {
      super();

      /** @type {Map<string, object>} */ this.projects = new Map();
      /** @type {Map<string, object>} */ this.tasks = new Map();

      // Secondary indexes. Rebuilt incrementally on every write rather
      // than recomputed on read — the Board view asks "tasks in status
      // X" on every drag frame, and a linear scan of 5000 tasks there
      // is the difference between 60fps and a stutter.
      this._byProject = new Map();   // projectId  -> Set<taskId>
      this._byParent = new Map();    // parentId   -> Set<taskId>
      this._byAssignee = new Map();  // uid        -> Set<taskId>
      this._byStatus = new Map();    // `${pid}:${statusId}` -> Set<taskId>

      this.activeProjectId = null;
      this.currentUser = null;       // { uid, email, displayName, photoURL }
      this.adapter = null;
      this.activity = [];            // newest first, capped

      this._history = [];
      this._hIndex = -1;
      this._tx = null;               // in-flight transaction
      this._txDepth = 0;
      this._pending = new Set();     // task ids with an unsettled remote write
      this._deferredRemote = new Map();
      this._ready = false;
    }

    /* ---- Lifecycle --------------------------------------------------- */

    /**
     * Attach a persistence adapter. Adapters are hot-swappable: signing
     * in swaps the local adapter for the Firestore one and the views
     * never know it happened.
     */
    async connect(adapter, user) {
      if (this.adapter && this.adapter.dispose) {
        try { await this.adapter.dispose(); } catch (e) { console.warn('[workstore] adapter dispose', e); }
      }
      this.adapter = adapter;
      this.currentUser = user || null;
      this._ready = false;

      adapter.onProjects(list => this._ingestProjects(list));
      adapter.onTasks((projectId, list, meta) => this._ingestTasks(projectId, list, meta));

      await adapter.start();
      this._ready = true;
      this.emit('ready', { adapter: adapter.kind });
      return this;
    }

    get isReady() { return this._ready; }
    get backend() { return this.adapter ? this.adapter.kind : 'none'; }

    /* ---- Reads ------------------------------------------------------- */

    project(id) { return this.projects.get(id || this.activeProjectId) || null; }
    get activeProject() { return this.projects.get(this.activeProjectId) || null; }
    task(id) { return this.tasks.get(id) || null; }

    allProjects() {
      return [...this.projects.values()].sort((a, b) =>
        (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    /** Every task in a project, including subtasks and archived ones. */
    projectTasks(projectId = this.activeProjectId) {
      const ids = this._byProject.get(projectId);
      if (!ids) return [];
      const out = [];
      for (const id of ids) {
        const t = this.tasks.get(id);
        if (t) out.push(t);
      }
      return out;
    }

    /** Top-level tasks only — subtasks are rendered nested under a parent. */
    rootTasks(projectId = this.activeProjectId) {
      return this.projectTasks(projectId).filter(t => !t.parentId);
    }

    subtasks(taskId) {
      const ids = this._byParent.get(taskId);
      if (!ids) return [];
      const out = [];
      for (const id of ids) {
        const t = this.tasks.get(id);
        if (t) out.push(t);
      }
      return S.sortTasks(out, 'manual');
    }

    /** Every descendant, depth-first — used by delete and by rollups. */
    descendants(taskId, acc = []) {
      for (const st of this.subtasks(taskId)) {
        acc.push(st);
        this.descendants(st.id, acc);
      }
      return acc;
    }

    tasksInStatus(projectId, statusId) {
      const ids = this._byStatus.get(`${projectId}:${statusId}`);
      if (!ids) return [];
      const out = [];
      for (const id of ids) {
        const t = this.tasks.get(id);
        if (t && !t.archived) out.push(t);
      }
      return S.sortTasks(out, 'manual');
    }

    /** Cross-project: everything assigned to someone. Powers "My work". */
    tasksForUser(userKey, { includeDone = false } = {}) {
      const ids = this._byAssignee.get(userKey);
      if (!ids) return [];
      const out = [];
      for (const id of ids) {
        const t = this.tasks.get(id);
        if (!t || t.archived) continue;
        const p = this.projects.get(t.projectId);
        if (!includeDone && p && S.isDone(p, t)) continue;
        out.push(t);
      }
      return out;
    }

    /** A member record by uid *or* email — invited members have no uid yet. */
    member(projectId, key) {
      const p = this.projects.get(projectId);
      if (!p || !key) return null;
      return p.members.find(m => m.uid === key || m.email === key) || null;
    }

    memberKey(m) { return m.uid || m.email; }

    /**
     * Roles are stored as the lowercase ids in S.ROLES, but records written
     * by older builds (and by the Flask fallback) carry display strings such
     * as "Owner", "Admin" or "Editor". S.roleCan() does not recognise those,
     * silently falls back to `viewer`, and the whole project becomes
     * read-only — no invites, no delete. Normalise on read.
     */
    normaliseRole(role) {
      const raw = String(role || '').trim().toLowerCase();
      if (S.ROLES[raw]) return raw;
      const ALIASES = {
        editor: 'member', edit: 'member', contributor: 'member', collaborator: 'member',
        manager: 'admin', administrator: 'admin', lead: 'admin',
        read: 'viewer', 'read-only': 'viewer', readonly: 'viewer', observer: 'viewer',
      };
      return ALIASES[raw] || 'viewer';
    }

    /**
     * The current user's role in a project, for permission checks.
     *
     * Signed out there is no identity to match a member record against, and
     * local projects are created with no members at all — so every check
     * resolved to `viewer` and the owner was locked out of their own
     * project. A project with nobody in it has no access boundary to
     * enforce: whoever is holding the machine is the owner.
     */
    myRole(projectId = this.activeProjectId) {
      const p = this.projects.get(projectId);
      const active = p ? p.members.filter(m => m.status !== 'removed') : [];

      // Nobody is on the project (local/solo project) — no boundary to enforce.
      if (!active.length) return 'owner';

      const u = this.currentUser;
      if (!u) {
        // Signed out on the local adapter: this is a single-user machine and
        // the data lives in this browser. Claim the strongest role present so
        // the project stays manageable; a Firestore-backed project is only
        // ever reachable while signed in, so this cannot leak shared data.
        if (!this.adapter || this.adapter.kind !== 'firestore') {
          return active.some(m => this.normaliseRole(m.role) === 'owner') ? 'owner' : 'admin';
        }
        return 'viewer';
      }

      const m = this.member(projectId, u.uid) || this.member(projectId, (u.email || '').toLowerCase());
      if (m) return this.normaliseRole(m.role);

      // Signed in, but this project predates the account (created locally,
      // never had an owner written). Adopt it rather than lock it.
      if (!this.adapter || this.adapter.kind !== 'firestore') return 'owner';
      return 'viewer';
    }

    can(action, projectId = this.activeProjectId) {
      return S.roleCan(this.myRole(projectId), action);
    }

    /** Filter + sort + group in one pass, the way every view consumes data. */
    query(projectId, { filter, sort = 'manual', dir = 'asc', group = 'status', roots = true } = {}) {
      const p = this.projects.get(projectId);
      if (!p) return { groups: new Map(), flat: [], total: 0 };

      let tasks = roots ? this.rootTasks(projectId) : this.projectTasks(projectId);
      tasks = tasks.filter(t => S.matchesFilter(p, t, filter));
      tasks = S.sortTasks(tasks, sort, dir);

      return { groups: S.groupTasks(tasks, group), flat: tasks, total: tasks.length };
    }

    /* ---- Transactions ------------------------------------------------ */

    /**
     * Group several mutations into one undo step and one network write.
     * Nestable — only the outermost call flushes.
     */
    transact(label, fn) {
      this._txDepth++;
      if (this._txDepth === 1) {
        this._tx = { label, ops: [], touched: new Set(), activity: [] };
      }
      let result;
      try {
        result = fn();
      } finally {
        this._txDepth--;
        if (this._txDepth === 0) this._flush();
      }
      return result;
    }

    _flush() {
      const tx = this._tx;
      this._tx = null;
      if (!tx || !tx.ops.length) return;

      this._pushHistory(tx);
      this._persist(tx);

      if (tx.activity.length) {
        this.activity.unshift(...tx.activity);
        if (this.activity.length > 400) this.activity.length = 400;
        this.emit('activity', tx.activity);
      }

      this.emit('tasks-changed', { ids: [...tx.touched], label: tx.label });
      this.emit('change', { label: tx.label });
    }

    /** Record one op inside the current transaction, opening one if needed. */
    _op(op) {
      if (this._txDepth === 0) {
        return this.transact(op.label || 'edit', () => this._op(op));
      }
      this._tx.ops.push(op);
      if (op.taskId) this._tx.touched.add(op.taskId);
      if (op.activity) this._tx.activity.push(op.activity);
      return op;
    }

    /* ---- Task mutations ---------------------------------------------- */

    createTask(props = {}) {
      const projectId = props.projectId || this.activeProjectId;
      const p = this.projects.get(projectId);
      if (!p) { console.warn('[workstore] createTask with no project'); return null; }

      const statusId = props.statusId || p.statuses[0]?.id || 'todo';
      const siblings = props.parentId
        ? this.subtasks(props.parentId)
        : this.tasksInStatus(projectId, statusId);

      const task = S.makeTask({
        ...props,
        projectId,
        statusId,
        listId: props.listId || p.lists[0]?.id || null,
        createdBy: this.currentUser?.uid || null,
        order: props.order || S.orderAfterAll(siblings.map(t => t.order)),
      });

      // Insert BEFORE recording the op. Outside an explicit transaction
      // `_op` opens and flushes one synchronously, and the flush reads the
      // task back out of the index to build the write payload — so an op
      // recorded first would persist `undefined`.
      this._insert(task);

      this._op({
        kind: 'create',
        taskId: task.id,
        label: 'create task',
        task: clone(task),
        activity: this._activity('created', task, { title: task.title }),
      });

      this._notify('task.created', { task });
      return task;
    }

    updateTask(id, patch, opts = {}) {
      const t = this.tasks.get(id);
      if (!t) return null;

      const d = diffPatch(t, patch);
      if (d.empty) return t;

      // Completion timestamps are derived, never passed in by callers —
      // one place decides when a task became done.
      if ('statusId' in d.after) {
        const p = this.projects.get(t.projectId);
        const wasDone = S.isComplete(p, t);
        const willBeDone = S.isComplete(p, { ...t, statusId: d.after.statusId });
        if (willBeDone && !wasDone) { d.before.completedAt = t.completedAt; d.after.completedAt = S.nowISO(); }
        if (!willBeDone && wasDone) { d.before.completedAt = t.completedAt; d.after.completedAt = null; }
      }

      d.before.updatedAt = t.updatedAt;
      d.after.updatedAt = S.nowISO();

      // Describe the change while the task still holds its old values, then
      // apply, then record — same ordering rule as createTask: the flush
      // inside `_op` reads the task back, so it must see the new state.
      const activity = opts.silentActivity ? null : this._describeChange(t, d.after);
      this._applyPatch(t, d.after);

      this._op({
        kind: 'update',
        taskId: id,
        label: opts.label || 'edit task',
        before: d.before,
        after: d.after,
        activity,
      });

      this._notifyForChange(t, d.before, d.after);
      return t;
    }

    deleteTask(id, opts = {}) {
      const t = this.tasks.get(id);
      if (!t) return false;

      return this.transact('delete task', () => {
        // Depth-first so children are recorded before their parent —
        // undo then replays parents first and never orphans a child.
        for (const child of this.descendants(id).reverse()) {
          this._op({ kind: 'delete', taskId: child.id, task: clone(child) });
          this._remove(child.id);
        }

        // Dangling dependency references would render as ghost rows in
        // the Timeline view, so strip them from the other side too.
        for (const other of this.projectTasks(t.projectId)) {
          if (other.id === id) continue;
          if (!(other.dependencies || []).some(dep => dep.taskId === id)) continue;
          this.updateTask(other.id, {
            dependencies: other.dependencies.filter(dep => dep.taskId !== id),
          }, { silentActivity: true });
        }

        this._op({
          kind: 'delete',
          taskId: id,
          task: clone(t),
          activity: opts.silentActivity ? null : this._activity('deleted', t, { title: t.title }),
        });
        this._remove(id);
        this._notify('task.deleted', { task: t });
        return true;
      });
    }

    duplicateTask(id, { withSubtasks = true } = {}) {
      const src = this.tasks.get(id);
      if (!src) return null;

      return this.transact('duplicate task', () => {
        const copy = this.createTask({
          ...clone(src),
          id: undefined,
          title: src.title + ' (copy)',
          comments: [],
          timeEntries: [],
          boardRefs: [],
          calendarEventId: null,
          completedAt: null,
          createdAt: undefined,
        });
        if (withSubtasks) {
          for (const st of this.subtasks(id)) {
            this.createTask({ ...clone(st), id: undefined, parentId: copy.id, comments: [], timeEntries: [] });
          }
        }
        return copy;
      });
    }

    /**
     * Move a task to a status and/or a position. This is the drag-drop
     * entry point, so it must be exact: `beforeId`/`afterId` are the
     * neighbours in the *destination* column after the drop.
     */
    moveTask(id, { statusId, listId, sprintId, parentId, beforeId, afterId } = {}) {
      const t = this.tasks.get(id);
      if (!t) return null;

      const patch = {};
      if (statusId != null && statusId !== t.statusId) patch.statusId = statusId;
      if (listId !== undefined && listId !== t.listId) patch.listId = listId;
      if (sprintId !== undefined && sprintId !== t.sprintId) patch.sprintId = sprintId;
      if (parentId !== undefined && parentId !== t.parentId) {
        if (parentId === id || this._isDescendantOf(parentId, id)) {
          console.warn('[workstore] refusing to nest a task inside its own subtree');
        } else {
          patch.parentId = parentId;
        }
      }

      if (beforeId || afterId) {
        const prev = afterId ? this.tasks.get(afterId) : null;
        const next = beforeId ? this.tasks.get(beforeId) : null;
        patch.order = S.orderBetween(prev?.order || '', next?.order || '');
      }

      return this.updateTask(id, patch, { label: 'move task' });
    }

    _isDescendantOf(maybeChildId, ancestorId) {
      let cur = this.tasks.get(maybeChildId);
      const guard = new Set();
      while (cur && cur.parentId && !guard.has(cur.id)) {
        guard.add(cur.id);
        if (cur.parentId === ancestorId) return true;
        cur = this.tasks.get(cur.parentId);
      }
      return false;
    }

    /* ---- Assignment -------------------------------------------------- */

    assign(taskId, memberKeys) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      const next = S.dedupe(Array.isArray(memberKeys) ? memberKeys : [memberKeys]);
      const added = next.filter(k => !t.assignees.includes(k));
      const removed = t.assignees.filter(k => !next.includes(k));

      const res = this.updateTask(taskId, { assignees: next }, { label: 'assign' });
      for (const key of added) this._notify('task.assigned', { task: t, memberKey: key });
      for (const key of removed) this._notify('task.unassigned', { task: t, memberKey: key });
      return res;
    }

    toggleAssignee(taskId, memberKey) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      const has = t.assignees.includes(memberKey);
      return this.assign(taskId, has
        ? t.assignees.filter(a => a !== memberKey)
        : [...t.assignees, memberKey]);
    }

    /** Assign to whoever currently has the least open estimated work. */
    autoAssign(taskId) {
      const t = this.tasks.get(taskId);
      const p = t && this.projects.get(t.projectId);
      if (!p) return null;
      const load = S.workloadFor(p, this.projectTasks(p.id), p.members.filter(m => m.status === 'active'));
      if (!load.length) return null;
      const lightest = load.reduce((min, b) => (b.utilisation < min.utilisation ? b : min), load[0]);
      return this.assign(taskId, [this.memberKey(lightest.member)]);
    }

    toggleWatcher(taskId, memberKey) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      const has = t.watchers.includes(memberKey);
      return this.updateTask(taskId, {
        watchers: has ? t.watchers.filter(w => w !== memberKey) : [...t.watchers, memberKey],
      }, { label: 'watch', silentActivity: true });
    }

    /* ---- Rich sub-objects -------------------------------------------- */

    addComment(taskId, text) {
      const t = this.tasks.get(taskId);
      if (!t || !String(text).trim()) return null;
      const c = S.makeComment(this.currentUser?.uid || this.currentUser?.email || 'anon', text);

      // Wrapped so the edit and its activity entry land in ONE undo step.
      // Left unwrapped, the trailing activity op would open a transaction of
      // its own and undo would need two presses to remove one comment.
      this.transact('comment', () => {
        this.updateTask(taskId, { comments: [...t.comments, c] }, { label: 'comment', silentActivity: true });
        this._op({ kind: 'noop', taskId, activity: this._activity('commented', t, { text: c.text.slice(0, 120) }) });
      });

      this._notify('task.commented', { task: t, comment: c });
      if (c.mentions.length) this._notify('task.mentioned', { task: t, comment: c, mentions: c.mentions });
      return c;
    }

    editComment(taskId, commentId, text) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      return this.updateTask(taskId, {
        comments: t.comments.map(c => c.id === commentId
          ? { ...c, text: String(text), editedAt: S.nowISO(), mentions: S.extractMentions(text) }
          : c),
      }, { label: 'edit comment', silentActivity: true });
    }

    deleteComment(taskId, commentId) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      return this.updateTask(taskId, {
        comments: t.comments.filter(c => c.id !== commentId),
      }, { label: 'delete comment', silentActivity: true });
    }

    reactToComment(taskId, commentId, emoji) {
      const t = this.tasks.get(taskId);
      const me = this.currentUser?.uid || 'anon';
      if (!t) return null;
      return this.updateTask(taskId, {
        comments: t.comments.map(c => {
          if (c.id !== commentId) return c;
          const list = c.reactions?.[emoji] || [];
          const next = list.includes(me) ? list.filter(u => u !== me) : [...list, me];
          const reactions = { ...c.reactions };
          if (next.length) reactions[emoji] = next; else delete reactions[emoji];
          return { ...c, reactions };
        }),
      }, { label: 'react', silentActivity: true });
    }

    addChecklistItem(taskId, text) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      const item = S.makeChecklistItem(text);
      this.updateTask(taskId, { checklist: [...t.checklist, item] }, { label: 'add checklist item', silentActivity: true });
      return item;
    }

    updateChecklistItem(taskId, itemId, patch) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      return this.updateTask(taskId, {
        checklist: t.checklist.map(i => (i.id === itemId ? { ...i, ...patch } : i)),
      }, { label: 'checklist', silentActivity: true });
    }

    removeChecklistItem(taskId, itemId) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      return this.updateTask(taskId, {
        checklist: t.checklist.filter(i => i.id !== itemId),
      }, { label: 'checklist', silentActivity: true });
    }

    /** Promote a checklist item into a real subtask, carrying its text. */
    promoteChecklistItem(taskId, itemId) {
      const t = this.tasks.get(taskId);
      const item = t && t.checklist.find(i => i.id === itemId);
      if (!item) return null;
      return this.transact('promote to subtask', () => {
        const sub = this.createTask({
          projectId: t.projectId,
          parentId: taskId,
          title: item.text,
          listId: t.listId,
          assignees: item.assignee ? [item.assignee] : [],
          statusId: item.done
            ? (this.projects.get(t.projectId).statuses.find(s => s.kind === 'done')?.id || t.statusId)
            : t.statusId,
        });
        this.removeChecklistItem(taskId, itemId);
        return sub;
      });
    }

    logTime(taskId, minutes, note = '') {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      const entry = S.makeTimeEntry(this.currentUser?.uid || 'anon', minutes, note);
      this.transact('log time', () => {
        this.updateTask(taskId, { timeEntries: [...t.timeEntries, entry] }, { label: 'log time', silentActivity: true });
        this._op({ kind: 'noop', taskId, activity: this._activity('logged time', t, { minutes }) });
      });
      return entry;
    }

    removeTimeEntry(taskId, entryId) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      return this.updateTask(taskId, {
        timeEntries: t.timeEntries.filter(e => e.id !== entryId),
      }, { label: 'time', silentActivity: true });
    }

    /**
     * Link two tasks. Writes both sides so either task can answer
     * "what am I waiting on?" without a full scan.
     */
    addDependency(taskId, otherId, type = 'blocked_by') {
      const t = this.tasks.get(taskId);
      const o = this.tasks.get(otherId);
      if (!t || !o || taskId === otherId) return null;
      const inverse = S.DEPENDENCY_TYPES[type]?.inverse || 'relates';

      return this.transact('link tasks', () => {
        if (!t.dependencies.some(d => d.taskId === otherId && d.type === type)) {
          this.updateTask(taskId, { dependencies: [...t.dependencies, { type, taskId: otherId }] },
            { label: 'link', silentActivity: true });
        }
        if (!o.dependencies.some(d => d.taskId === taskId && d.type === inverse)) {
          this.updateTask(otherId, { dependencies: [...o.dependencies, { type: inverse, taskId }] },
            { label: 'link', silentActivity: true });
        }
      });
    }

    removeDependency(taskId, otherId) {
      const t = this.tasks.get(taskId);
      const o = this.tasks.get(otherId);
      return this.transact('unlink tasks', () => {
        if (t) this.updateTask(taskId, { dependencies: t.dependencies.filter(d => d.taskId !== otherId) }, { silentActivity: true });
        if (o) this.updateTask(otherId, { dependencies: o.dependencies.filter(d => d.taskId !== taskId) }, { silentActivity: true });
      });
    }

    /** Tasks that must finish before this one can start. */
    blockers(taskId) {
      const t = this.tasks.get(taskId);
      if (!t) return [];
      const p = this.projects.get(t.projectId);
      return (t.dependencies || [])
        .filter(d => d.type === 'blocked_by')
        .map(d => this.tasks.get(d.taskId))
        .filter(x => x && !S.isDone(p, x));
    }

    isBlocked(taskId) { return this.blockers(taskId).length > 0; }

    addAttachment(taskId, att) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      const record = { id: S.uid('att'), addedAt: S.nowISO(), addedBy: this.currentUser?.uid || null, ...att };
      this.updateTask(taskId, { attachments: [...t.attachments, record] }, { label: 'attach', silentActivity: true });
      return record;
    }

    removeAttachment(taskId, attId) {
      const t = this.tasks.get(taskId);
      if (!t) return null;
      return this.updateTask(taskId, {
        attachments: t.attachments.filter(a => a.id !== attId),
      }, { label: 'attach', silentActivity: true });
    }

    setCustomField(taskId, fieldId, value) {
      const t = this.tasks.get(taskId);
      const p = t && this.projects.get(t.projectId);
      if (!t || !p) return null;
      const def = p.customFields.find(f => f.id === fieldId);
      const coerce = def && S.FIELD_TYPES[def.type]?.coerce;
      return this.updateTask(taskId, {
        custom: { ...t.custom, [fieldId]: coerce ? coerce(value) : value },
      }, { label: 'custom field', silentActivity: true });
    }

    /* ---- Project mutations ------------------------------------------- */

    createProject(props = {}) {
      const p = S.makeProject({ ...props, createdBy: this.currentUser?.uid || null });

      // The creator is always the owner — an ownerless project is
      // unrecoverable, since only an owner can grant roles. This ran only
      // when signed in, so every project made signed-out was born with an
      // empty member list and its creator could neither invite nor delete it.
      const u = this.currentUser;
      const already = u && p.members.some(m => m.uid === u.uid);
      if (!already && !p.members.some(m => this.normaliseRole(m.role) === 'owner')) {
        p.members.unshift(S.makeMember({
          uid: u?.uid || null,
          email: u?.email || '',
          name: u?.displayName || u?.email || 'You',
          photoURL: u?.photoURL || '',
          role: 'owner',
          status: 'active',
          joinedAt: S.nowISO(),
        }));
      }
      this._denormaliseMembers(p);

      this.projects.set(p.id, p);
      this._byProject.set(p.id, new Set());
      this.adapter?.saveProject(p);
      this.emit('projects-changed', { ids: [p.id] });
      this._notify('project.created', { project: p });
      return p;
    }

    updateProject(id, patch) {
      const p = this.projects.get(id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: S.nowISO() });
      this._denormaliseMembers(p);
      this.adapter?.saveProject(p);
      this.emit('projects-changed', { ids: [id] });
      return p;
    }

    async deleteProject(id) {
      const p = this.projects.get(id);
      if (!p) return false;
      for (const t of this.projectTasks(id)) this._remove(t.id);
      this.projects.delete(id);
      this._byProject.delete(id);
      await this.adapter?.deleteProject(id);
      if (this.activeProjectId === id) this.activeProjectId = null;
      this.emit('projects-changed', { ids: [id], deleted: true });
      return true;
    }

    /** Keep the flat arrays Firestore rules and queries depend on in step. */
    _denormaliseMembers(p) {
      p.memberUids = p.members.filter(m => m.uid && m.status !== 'removed').map(m => m.uid);
      p.memberEmails = p.members.filter(m => m.email && m.status !== 'removed').map(m => m.email.toLowerCase());
    }

    addMember(projectId, props) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      const email = (props.email || '').toLowerCase();
      const existing = p.members.find(m => m.email === email || (props.uid && m.uid === props.uid));
      if (existing) {
        Object.assign(existing, { role: props.role || existing.role, status: props.status || existing.status });
        this.updateProject(projectId, {});
        return existing;
      }
      const m = S.makeMember(props);
      p.members.push(m);
      this.updateProject(projectId, { members: p.members });
      this._notify('member.invited', { project: p, member: m });
      return m;
    }

    updateMember(projectId, key, patch) {
      const p = this.projects.get(projectId);
      const m = this.member(projectId, key);
      if (!p || !m) return null;
      // Removing the last owner would lock everyone out of role
      // management, so refuse rather than let the UI do it.
      if (this.normaliseRole(m.role) === 'owner' && patch.role && patch.role !== 'owner') {
        const owners = p.members.filter(x => this.normaliseRole(x.role) === 'owner' && x.status !== 'removed');
        if (owners.length <= 1) {
          this.emit('error', { message: 'A project must keep at least one owner.' });
          return null;
        }
      }
      Object.assign(m, patch);
      this.updateProject(projectId, { members: p.members });
      return m;
    }

    removeMember(projectId, key) {
      const p = this.projects.get(projectId);
      const m = this.member(projectId, key);
      if (!p || !m) return false;
      if (this.normaliseRole(m.role) === 'owner' && p.members.filter(x => this.normaliseRole(x.role) === 'owner' && x.status !== 'removed').length <= 1) {
        this.emit('error', { message: 'A project must keep at least one owner.' });
        return false;
      }

      return this.transact('remove member', () => {
        m.status = 'removed';
        // Unassign, so the Workload view does not keep charging time to
        // someone who is gone.
        for (const t of this.projectTasks(projectId)) {
          if (t.assignees.includes(key)) {
            this.updateTask(t.id, { assignees: t.assignees.filter(a => a !== key) }, { silentActivity: true });
          }
        }
        this.updateProject(projectId, { members: p.members });
        return true;
      });
    }

    /* ---- Statuses, lists, sprints, fields ---------------------------- */

    addStatus(projectId, props) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      const s = { id: props.id || S.uid('st'), name: props.name || 'New status', color: props.color || '#929aab', kind: props.kind || 'todo' };
      p.statuses.push(s);
      this.updateProject(projectId, { statuses: p.statuses });
      return s;
    }

    updateStatus(projectId, statusId, patch) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      p.statuses = p.statuses.map(s => (s.id === statusId ? { ...s, ...patch } : s));
      this.updateProject(projectId, { statuses: p.statuses });
      return p.statuses;
    }

    /** Deleting a status re-homes its tasks; nothing is ever stranded. */
    removeStatus(projectId, statusId, moveToId) {
      const p = this.projects.get(projectId);
      if (!p || p.statuses.length <= 1) return false;
      const target = moveToId || p.statuses.find(s => s.id !== statusId)?.id;

      return this.transact('remove status', () => {
        for (const t of this.tasksInStatus(projectId, statusId)) {
          this.updateTask(t.id, { statusId: target }, { silentActivity: true });
        }
        p.statuses = p.statuses.filter(s => s.id !== statusId);
        this.updateProject(projectId, { statuses: p.statuses });
        return true;
      });
    }

    reorderStatuses(projectId, orderedIds) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      const byId = new Map(p.statuses.map(s => [s.id, s]));
      p.statuses = orderedIds.map(id => byId.get(id)).filter(Boolean)
        .concat(p.statuses.filter(s => !orderedIds.includes(s.id)));
      this.updateProject(projectId, { statuses: p.statuses });
      return p.statuses;
    }

    addList(projectId, props) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      const l = S.makeList({ ...props, order: S.orderAfterAll(p.lists.map(x => x.order)) });
      p.lists.push(l);
      this.updateProject(projectId, { lists: p.lists });
      return l;
    }

    addSprint(projectId, props) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      const s = S.makeSprint(props);
      p.sprints.push(s);
      this.updateProject(projectId, { sprints: p.sprints });
      return s;
    }

    addCustomField(projectId, props) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      const f = {
        id: props.id || S.uid('fld'),
        name: props.name || 'Field',
        type: props.type || 'text',
        options: props.options || [],
        showInList: props.showInList !== false,
      };
      p.customFields.push(f);
      this.updateProject(projectId, { customFields: p.customFields });
      return f;
    }

    removeCustomField(projectId, fieldId) {
      const p = this.projects.get(projectId);
      if (!p) return false;
      return this.transact('remove field', () => {
        p.customFields = p.customFields.filter(f => f.id !== fieldId);
        for (const t of this.projectTasks(projectId)) {
          if (t.custom && fieldId in t.custom) {
            const custom = { ...t.custom };
            delete custom[fieldId];
            this.updateTask(t.id, { custom }, { silentActivity: true });
          }
        }
        this.updateProject(projectId, { customFields: p.customFields });
        return true;
      });
    }

    /* ---- Bulk operations --------------------------------------------- */

    /** One undo step and one batched write for "select 40 rows, set due date". */
    bulk(taskIds, patch, label = 'bulk edit') {
      return this.transact(label, () => {
        for (const id of taskIds) this.updateTask(id, patch, { label, silentActivity: true });
        this._op({
          kind: 'noop',
          activity: { id: S.uid('act'), verb: label, at: S.nowISO(), actor: this.currentUser?.uid || null, detail: { count: taskIds.length } },
        });
      });
    }

    bulkDelete(taskIds) {
      return this.transact('delete tasks', () => {
        for (const id of taskIds) this.deleteTask(id, { silentActivity: true });
      });
    }

    /* ---- Index maintenance ------------------------------------------- */

    _insert(task) {
      this.tasks.set(task.id, task);
      addTo(this._byProject, task.projectId, task.id);
      if (task.parentId) addTo(this._byParent, task.parentId, task.id);
      addTo(this._byStatus, `${task.projectId}:${task.statusId}`, task.id);
      for (const a of task.assignees) addTo(this._byAssignee, a, task.id);
    }

    _remove(id) {
      const t = this.tasks.get(id);
      if (!t) return;
      this.tasks.delete(id);
      delFrom(this._byProject, t.projectId, id);
      if (t.parentId) delFrom(this._byParent, t.parentId, id);
      delFrom(this._byStatus, `${t.projectId}:${t.statusId}`, id);
      for (const a of t.assignees) delFrom(this._byAssignee, a, id);
      this._byParent.delete(id);
    }

    /** Apply a field patch and repair only the indexes it invalidates. */
    _applyPatch(task, patch) {
      if ('statusId' in patch && patch.statusId !== task.statusId) {
        delFrom(this._byStatus, `${task.projectId}:${task.statusId}`, task.id);
        addTo(this._byStatus, `${task.projectId}:${patch.statusId}`, task.id);
      }
      if ('parentId' in patch && patch.parentId !== task.parentId) {
        if (task.parentId) delFrom(this._byParent, task.parentId, task.id);
        if (patch.parentId) addTo(this._byParent, patch.parentId, task.id);
      }
      if ('assignees' in patch) {
        for (const a of task.assignees) delFrom(this._byAssignee, a, task.id);
        for (const a of patch.assignees) addTo(this._byAssignee, a, task.id);
      }
      Object.assign(task, clone(patch));
    }

    /* ---- Undo / redo -------------------------------------------------- */

    _pushHistory(tx) {
      if (this._hIndex < this._history.length - 1) {
        this._history.length = this._hIndex + 1;
      }
      this._history.push(tx);
      if (this._history.length > HISTORY_LIMIT) this._history.shift();
      this._hIndex = this._history.length - 1;
      this.emit('history', this.historyState);
    }

    get historyState() {
      return {
        canUndo: this._hIndex >= 0,
        canRedo: this._hIndex < this._history.length - 1,
        undoLabel: this._history[this._hIndex]?.label || '',
        redoLabel: this._history[this._hIndex + 1]?.label || '',
      };
    }

    undo() {
      if (this._hIndex < 0) return false;
      const tx = this._history[this._hIndex--];
      // Reverse order: the last op applied is the first undone, so a
      // create-then-edit pair unwinds cleanly.
      for (const op of [...tx.ops].reverse()) this._invert(op);
      this._afterTimeTravel(tx, 'undo');
      return true;
    }

    redo() {
      if (this._hIndex >= this._history.length - 1) return false;
      const tx = this._history[++this._hIndex];
      for (const op of tx.ops) this._replay(op);
      this._afterTimeTravel(tx, 'redo');
      return true;
    }

    _invert(op) {
      if (op.kind === 'create') { this._remove(op.taskId); this.adapter?.deleteTask(op.taskId); }
      else if (op.kind === 'delete') { this._insert(clone(op.task)); this.adapter?.saveTask(this.tasks.get(op.taskId)); }
      else if (op.kind === 'update') {
        const t = this.tasks.get(op.taskId);
        if (t) { this._applyPatch(t, op.before); this.adapter?.patchTask(op.taskId, op.before, t); }
      }
    }

    _replay(op) {
      if (op.kind === 'create') { this._insert(clone(op.task)); this.adapter?.saveTask(this.tasks.get(op.taskId)); }
      else if (op.kind === 'delete') { this._remove(op.taskId); this.adapter?.deleteTask(op.taskId); }
      else if (op.kind === 'update') {
        const t = this.tasks.get(op.taskId);
        if (t) { this._applyPatch(t, op.after); this.adapter?.patchTask(op.taskId, op.after, t); }
      }
    }

    _afterTimeTravel(tx, how) {
      this.emit('history', this.historyState);
      this.emit('tasks-changed', { ids: [...tx.touched], label: `${how} ${tx.label}` });
      this.emit('change', { label: `${how} ${tx.label}` });
    }

    /* ---- Persistence -------------------------------------------------- */

    _persist(tx) {
      if (!this.adapter) return;
      const writes = [];
      for (const op of tx.ops) {
        if (op.kind === 'delete') { writes.push({ kind: 'delete', id: op.taskId }); continue; }

        const live = this.tasks.get(op.taskId);
        if (!live) {
          // A create or update whose task is not in the index means the
          // caller mutated in the wrong order. Refusing here beats writing
          // `undefined` into the adapter and corrupting the record.
          console.warn('[workstore] skipping write for a task that is not in the index:', op.kind, op.taskId);
          continue;
        }

        if (op.kind === 'create') writes.push({ kind: 'set', id: op.taskId, data: live });
        else if (op.kind === 'update') writes.push({ kind: 'patch', id: op.taskId, data: op.after, full: live });
      }
      if (!writes.length) return;

      for (const w of writes) this._pending.add(w.id);
      Promise.resolve(this.adapter.commit(writes, { projectId: this.activeProjectId }))
        .catch(err => {
          console.error('[workstore] persist failed', err);
          this.emit('sync-error', { error: err, writes });
        })
        .finally(() => {
          for (const w of writes) this._pending.delete(w.id);
          this._drainDeferred();
        });
    }

    /* ---- Ingest from adapter (realtime) ------------------------------- */

    _ingestProjects(list) {
      const ids = [];
      const seen = new Set();
      for (const raw of list) {
        const p = S.makeProject(raw);
        // Re-hydrating through the factory guarantees new fields exist
        // on records written by an older version of the app.
        p.id = raw.id;
        p.members = (raw.members || []).map(S.makeMember);
        this._denormaliseMembers(p);
        this.projects.set(p.id, p);
        if (!this._byProject.has(p.id)) this._byProject.set(p.id, new Set());
        ids.push(p.id);
        seen.add(p.id);
      }
      // Drop projects that vanished remotely (deleted, or access revoked).
      for (const id of [...this.projects.keys()]) {
        if (!seen.has(id)) {
          this.projects.delete(id);
          for (const t of this.projectTasks(id)) this._remove(t.id);
          this._byProject.delete(id);
        }
      }
      this.emit('projects-changed', { ids });
    }

    _ingestTasks(projectId, list, meta = {}) {
      const incoming = new Map();
      for (const raw of list) {
        const t = S.makeTask(raw);
        t.id = raw.id;
        incoming.set(t.id, t);
      }

      // A task we are mid-write on is skipped: the server copy is by
      // definition older than what the user just did, and clobbering it
      // makes fields visibly snap back mid-typing.
      const deferred = [];
      for (const id of incoming.keys()) {
        if (this._pending.has(id)) deferred.push(id);
      }
      if (deferred.length) {
        this._deferredRemote.set(projectId, { list, meta });
      }

      const existing = this._byProject.get(projectId) || new Set();
      const changed = [];

      for (const [id, t] of incoming) {
        if (this._pending.has(id)) continue;
        const cur = this.tasks.get(id);
        if (!cur) { this._insert(t); changed.push(id); continue; }
        if (cur.updatedAt !== t.updatedAt) {
          this._remove(id);
          this._insert(t);
          changed.push(id);
        }
      }

      if (!meta.partial) {
        for (const id of [...existing]) {
          if (!incoming.has(id) && !this._pending.has(id)) { this._remove(id); changed.push(id); }
        }
      }

      if (changed.length) this.emit('tasks-changed', { ids: changed, remote: true });
    }

    _drainDeferred() {
      if (!this._deferredRemote.size || this._pending.size) return;
      const snapshot = [...this._deferredRemote.entries()];
      this._deferredRemote.clear();
      for (const [projectId, { list, meta }] of snapshot) this._ingestTasks(projectId, list, meta);
    }

    /* ---- Activity & notifications -------------------------------------- */

    _activity(verb, task, detail = {}) {
      return {
        id: S.uid('act'),
        verb,
        at: S.nowISO(),
        actor: this.currentUser?.uid || this.currentUser?.email || null,
        projectId: task?.projectId || this.activeProjectId,
        taskId: task?.id || null,
        taskTitle: task?.title || '',
        detail,
      };
    }

    /** Turn a field patch into human-readable activity, or null if dull. */
    _describeChange(task, after) {
      const keys = Object.keys(after).filter(k => k !== 'updatedAt' && k !== 'completedAt');
      if (!keys.length) return null;

      const p = this.projects.get(task.projectId);
      if (keys.includes('statusId')) {
        const to = p?.statuses.find(s => s.id === after.statusId);
        return this._activity('moved', task, { to: to?.name || after.statusId });
      }
      if (keys.includes('assignees')) return this._activity('reassigned', task, { assignees: after.assignees });
      if (keys.includes('dueDate')) return this._activity('rescheduled', task, { dueDate: after.dueDate });
      if (keys.includes('priority')) return this._activity('reprioritised', task, { priority: after.priority });
      if (keys.length === 1 && keys[0] === 'order') return null;   // drag-reorder is noise
      return this._activity('updated', task, { fields: keys });
    }

    /**
     * Fan out to automations. Emitted, never awaited — an email
     * provider being down must not roll back a task edit.
     */
    _notify(event, payload) {
      try { this.emit('notify', { event, ...payload }); }
      catch (err) { console.warn('[workstore] notify handler threw', err); }
    }

    _notifyForChange(task, before, after) {
      if ('statusId' in after) {
        const p = this.projects.get(task.projectId);
        if (p && S.isComplete(p, task)) this._notify('task.completed', { task });
        else this._notify('task.status', { task, from: before.statusId, to: after.statusId });
      }
      if ('dueDate' in after) this._notify('task.due', { task, dueDate: after.dueDate });
    }

    /* ---- Serialisation ------------------------------------------------- */

    exportProject(projectId) {
      const p = this.projects.get(projectId);
      if (!p) return null;
      return {
        version: 1,
        exportedAt: S.nowISO(),
        project: clone(p),
        tasks: this.projectTasks(projectId).map(clone),
      };
    }

    importProject(payload, { asNew = true } = {}) {
      if (!payload || !payload.project) return null;
      const idMap = new Map();

      return this.transact('import project', () => {
        const p = this.createProject({
          ...payload.project,
          id: asNew ? undefined : payload.project.id,
          name: asNew ? payload.project.name + ' (imported)' : payload.project.name,
        });

        // Two passes: create every task first so cross-references
        // (parents, dependencies) can be remapped once all ids exist.
        for (const raw of payload.tasks || []) {
          const t = this.createTask({ ...raw, id: undefined, projectId: p.id, parentId: null, dependencies: [] });
          idMap.set(raw.id, t.id);
        }
        for (const raw of payload.tasks || []) {
          const newId = idMap.get(raw.id);
          if (!newId) continue;
          const patch = {};
          if (raw.parentId && idMap.has(raw.parentId)) patch.parentId = idMap.get(raw.parentId);
          if (raw.dependencies?.length) {
            patch.dependencies = raw.dependencies
              .filter(d => idMap.has(d.taskId))
              .map(d => ({ type: d.type, taskId: idMap.get(d.taskId) }));
          }
          if (Object.keys(patch).length) this.updateTask(newId, patch, { silentActivity: true });
        }
        return p;
      });
    }
  }

  /* ---- Set-in-Map helpers -------------------------------------------- */

  function addTo(map, key, val) {
    if (key == null) return;
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(val);
  }

  function delFrom(map, key, val) {
    if (key == null) return;
    const s = map.get(key);
    if (!s) return;
    s.delete(val);
    if (!s.size) map.delete(key);
  }

  global.WorkStore = WorkStore;
  global.PMWorkStore = new WorkStore();

})(window);
