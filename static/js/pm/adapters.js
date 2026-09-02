/* ================================================================
   pm/adapters.js — Persistence back ends for the WorkStore
   ----------------------------------------------------------------
   Two implementations of one interface:

     LocalAdapter      Flask REST + localStorage. Works signed-out and
                       offline. Single user, no realtime.
     FirestoreAdapter  Firestore with live listeners. Multi-user, real
                       collaboration, works across machines.

   The WorkStore holds exactly one adapter and never branches on which.
   Signing in swaps Local for Firestore and migrates anything that was
   created while signed out, so work is never stranded on one device.

   Adapter contract
     kind              string, for the UI badge
     start()           load initial data, open listeners
     onProjects(fn)    fn(projectArray)             — full replace
     onTasks(fn)       fn(projectId, taskArray, {partial}) — full replace unless partial
     watchProject(id)  begin streaming that project's tasks
     commit(writes)    [{kind:'set'|'patch'|'delete', id, data, full}]
     saveProject(p) / deleteProject(id)
     saveTask(t) / patchTask(id, patch, full) / deleteTask(id)
     dispose()
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;

  /** Fields Firestore must never receive: undefined values throw. */
  function scrub(obj) {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = scrub(v);
    }
    return out;
  }

  /* ================================================================
     BaseAdapter — shared plumbing
     ================================================================ */

  class BaseAdapter {
    constructor() {
      this._onProjects = () => {};
      this._onTasks = () => {};
      this._watched = new Set();
    }
    onProjects(fn) { this._onProjects = fn; }
    onTasks(fn) { this._onTasks = fn; }

    // Convenience wrappers so callers can write one task without
    // hand-rolling a writes array.
    saveTask(t) { return this.commit([{ kind: 'set', id: t.id, data: t }]); }
    patchTask(id, patch, full) { return this.commit([{ kind: 'patch', id, data: patch, full }]); }
    deleteTask(id) { return this.commit([{ kind: 'delete', id }]); }

    async dispose() {}
  }

  /* ================================================================
     LocalAdapter — Flask + localStorage
     ================================================================ */

  const LS_PROJECTS = 'pm.projects.v1';
  const LS_TASKS = 'pm.tasks.v1';

  class LocalAdapter extends BaseAdapter {
    constructor({ baseUrl = '' } = {}) {
      super();
      this.kind = 'local';
      this.baseUrl = baseUrl;
      this.online = true;
      this._projects = new Map();
      this._tasks = new Map();          // projectId -> Map<taskId, task>
      this._flushTimer = null;
      this._dirtyProjects = new Set();
      this._dirtyTasks = new Map();     // projectId -> Set<taskId>
      this._deleted = new Map();        // projectId -> Set<taskId>
    }

    async start() {
      // localStorage first so the UI paints instantly, then reconcile
      // with the server. A cold server or a dead network then degrades
      // to "your data is still here" instead of an empty screen.
      this._readCache();
      this._emitAll();

      try {
        const res = await fetch(this.baseUrl + '/api/pm/projects');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const payload = await res.json();
        this._projects = new Map((payload.projects || []).map(p => [p.id, p]));
        this._tasks = new Map();
        for (const [pid, list] of Object.entries(payload.tasks || {})) {
          this._tasks.set(pid, new Map(list.map(t => [t.id, t])));
        }
        this.online = true;
        this._writeCache();
        this._emitAll();
      } catch (err) {
        this.online = false;
        console.info('[pm] server unavailable, running from local cache');
      }
      return this;
    }

    watchProject(id) {
      const list = [...(this._tasks.get(id) || new Map()).values()];
      this._onTasks(id, list, {});
    }

    _emitAll() {
      this._onProjects([...this._projects.values()]);
      for (const [pid, m] of this._tasks) this._onTasks(pid, [...m.values()], {});
    }

    _readCache() {
      try {
        const p = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]');
        this._projects = new Map(p.map(x => [x.id, x]));
        const t = JSON.parse(localStorage.getItem(LS_TASKS) || '{}');
        this._tasks = new Map(Object.entries(t).map(([pid, list]) => [pid, new Map(list.map(x => [x.id, x]))]));
      } catch { /* corrupt cache is not worth crashing over */ }
    }

    _writeCache() {
      try {
        localStorage.setItem(LS_PROJECTS, JSON.stringify([...this._projects.values()]));
        const obj = {};
        for (const [pid, m] of this._tasks) obj[pid] = [...m.values()];
        localStorage.setItem(LS_TASKS, JSON.stringify(obj));
      } catch (err) {
        console.warn('[pm] local cache full — export to keep a copy');
      }
    }

    saveProject(p) {
      this._projects.set(p.id, JSON.parse(JSON.stringify(p)));
      this._dirtyProjects.add(p.id);
      this._schedule();
    }

    async deleteProject(id) {
      this._projects.delete(id);
      this._tasks.delete(id);
      this._writeCache();
      if (!this.online) return;
      try { await fetch(`${this.baseUrl}/api/pm/project/${id}`, { method: 'DELETE' }); }
      catch { this.online = false; }
    }

    commit(writes, { projectId } = {}) {
      for (const w of writes) {
        const pid = w.data?.projectId || w.full?.projectId || projectId || this._findProjectOf(w.id);
        if (!pid) continue;
        if (!this._tasks.has(pid)) this._tasks.set(pid, new Map());
        const bucket = this._tasks.get(pid);

        if (w.kind === 'delete') {
          bucket.delete(w.id);
          addTo(this._deleted, pid, w.id);
          delFrom(this._dirtyTasks, pid, w.id);
        } else {
          const next = w.kind === 'set'
            ? JSON.parse(JSON.stringify(w.data))
            : { ...(bucket.get(w.id) || w.full || {}), ...w.data };
          bucket.set(w.id, next);
          addTo(this._dirtyTasks, pid, w.id);
        }
      }
      this._schedule();
      return Promise.resolve();
    }

    _findProjectOf(taskId) {
      for (const [pid, m] of this._tasks) if (m.has(taskId)) return pid;
      return null;
    }

    /**
     * Write-behind. Typing in a task title fires a patch per keystroke;
     * batching them into one request every 600ms is the difference
     * between 40 requests and one.
     */
    _schedule() {
      this._writeCache();
      if (this._flushTimer) return;
      this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flushToServer(); }, 600);
    }

    async _flushToServer() {
      const payload = {
        projects: [...this._dirtyProjects].map(id => this._projects.get(id)).filter(Boolean),
        tasks: [],
        deleted: [],
      };
      for (const [pid, ids] of this._dirtyTasks) {
        for (const id of ids) {
          const t = this._tasks.get(pid)?.get(id);
          if (t) payload.tasks.push(t);
        }
      }
      for (const [pid, ids] of this._deleted) {
        for (const id of ids) payload.deleted.push({ projectId: pid, id });
      }
      if (!payload.projects.length && !payload.tasks.length && !payload.deleted.length) return;

      try {
        const res = await fetch(this.baseUrl + '/api/pm/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        this._dirtyProjects.clear();
        this._dirtyTasks.clear();
        this._deleted.clear();
        this.online = true;
      } catch (err) {
        // Stay dirty and retry on the next write. The localStorage copy
        // is already current, so nothing is lost in the meantime.
        this.online = false;
      }
    }

    /** Everything held locally, for migration into Firestore on sign-in. */
    dump() {
      const tasks = {};
      for (const [pid, m] of this._tasks) tasks[pid] = [...m.values()];
      return { projects: [...this._projects.values()], tasks };
    }

    async dispose() {
      if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
      await this._flushToServer();
    }
  }

  /* ================================================================
     FirestoreAdapter — realtime, multi-user
     ================================================================

     Layout
       projects/{projectId}                  the project document
       projects/{projectId}/tasks/{taskId}   one document per task
       users/{uid}                           profile + invite claiming

     Tasks are a subcollection rather than an array on the project so
     two people editing two different tasks never write the same
     document, and so a 2000-task project does not ship 2000 tasks to
     every listener on every keystroke.
     ================================================================ */

  class FirestoreAdapter extends BaseAdapter {
    constructor(fb, user) {
      super();
      this.kind = 'firestore';
      this.fb = fb;                 // the window.FB bridge from firebase-sync.js
      this.user = user;
      this._unsubProjects = null;
      this._unsubTasks = new Map(); // projectId -> unsubscribe
      this._writeQueue = [];
      this._writeTimer = null;
    }

    async start() {
      const { db, collection, query, where, onSnapshot } = this.fb;
      const uid = this.user.uid;
      const email = (this.user.email || '').toLowerCase();

      // Two listeners because Firestore cannot OR across fields: one
      // for projects you are a member of by uid, one for projects you
      // were invited to by email before you ever signed in. Results are
      // merged client-side.
      const byUid = query(collection(db, 'projects'), where('memberUids', 'array-contains', uid));
      const byEmail = query(collection(db, 'projects'), where('memberEmails', 'array-contains', email));

      const seen = { uid: new Map(), email: new Map() };
      const publish = () => {
        const merged = new Map([...seen.email, ...seen.uid]);
        this._onProjects([...merged.values()]);
      };

      const unsubA = onSnapshot(byUid, snap => {
        seen.uid = new Map();
        snap.forEach(d => seen.uid.set(d.id, { ...d.data(), id: d.id }));
        publish();
        this._claimInvites([...seen.email.values()]);
      }, err => this._err('projects(uid)', err));

      const unsubB = onSnapshot(byEmail, snap => {
        seen.email = new Map();
        snap.forEach(d => seen.email.set(d.id, { ...d.data(), id: d.id }));
        publish();
        this._claimInvites([...seen.email.values()]);
      }, err => this._err('projects(email)', err));

      this._unsubProjects = () => { unsubA(); unsubB(); };
      return this;
    }

    /**
     * An invite is created against an email address. The first time
     * that person signs in we stamp their uid onto the member record,
     * which is what promotes them from "invited" to a real collaborator
     * the security rules will let write.
     */
    async _claimInvites(projects) {
      const { db, doc, updateDoc } = this.fb;
      const uid = this.user.uid;
      const email = (this.user.email || '').toLowerCase();

      for (const p of projects) {
        const members = p.members || [];
        const mine = members.find(m => (m.email || '').toLowerCase() === email && !m.uid);
        if (!mine) continue;

        const next = members.map(m => (m === mine || ((m.email || '').toLowerCase() === email && !m.uid)
          ? { ...m, uid, status: 'active', joinedAt: new Date().toISOString(),
              name: m.name || this.user.displayName || email,
              photoURL: m.photoURL || this.user.photoURL || null }
          : m));

        try {
          await updateDoc(doc(db, 'projects', p.id), {
            members: scrub(next),
            memberUids: [...new Set([...(p.memberUids || []), uid])],
          });
        } catch (err) {
          // Rules may reject this until the owner's write lands. Not
          // fatal: the next snapshot retries.
          console.debug('[pm] invite claim deferred for', p.id);
        }
      }
    }

    watchProject(projectId) {
      if (!projectId || this._unsubTasks.has(projectId)) return;
      const { db, collection, onSnapshot } = this.fb;

      const unsub = onSnapshot(
        collection(db, 'projects', projectId, 'tasks'),
        snap => {
          const list = [];
          snap.forEach(d => list.push({ ...d.data(), id: d.id }));
          this._onTasks(projectId, list, {});
        },
        err => this._err('tasks/' + projectId, err)
      );
      this._unsubTasks.set(projectId, unsub);
    }

    unwatchProject(projectId) {
      const unsub = this._unsubTasks.get(projectId);
      if (unsub) { unsub(); this._unsubTasks.delete(projectId); }
    }

    async saveProject(p) {
      const { db, doc, setDoc } = this.fb;
      const data = scrub({ ...p, updatedAt: new Date().toISOString() });
      try {
        await setDoc(doc(db, 'projects', p.id), data, { merge: true });
      } catch (err) { this._err('saveProject', err); throw err; }
    }

    async deleteProject(id) {
      const { db, doc, deleteDoc, collection, getDocs, writeBatch } = this.fb;
      this.unwatchProject(id);
      try {
        // Firestore does not cascade: the subcollection has to be
        // cleared explicitly or the tasks become unreachable orphans
        // that still cost storage.
        const snap = await getDocs(collection(db, 'projects', id, 'tasks'));
        const docs = [];
        snap.forEach(d => docs.push(d.ref));
        for (let i = 0; i < docs.length; i += 400) {
          const batch = writeBatch(db);
          for (const ref of docs.slice(i, i + 400)) batch.delete(ref);
          await batch.commit();
        }
        await deleteDoc(doc(db, 'projects', id));
      } catch (err) { this._err('deleteProject', err); throw err; }
    }

    /**
     * Writes are queued and flushed on a microtask-ish delay so a drag
     * that touches three tasks becomes one batch, not three round trips.
     * Firestore batches cap at 500 operations.
     */
    commit(writes, { projectId } = {}) {
      for (const w of writes) {
        this._writeQueue.push({ ...w, projectId: w.data?.projectId || w.full?.projectId || projectId });
      }
      if (this._writeTimer) return this._writePromise;

      this._writePromise = new Promise((resolve, reject) => {
        this._writeTimer = setTimeout(() => {
          this._writeTimer = null;
          this._flushWrites().then(resolve, reject);
        }, 120);
      });
      return this._writePromise;
    }

    async _flushWrites() {
      const { db, doc, writeBatch } = this.fb;
      const queue = this._writeQueue;
      this._writeQueue = [];
      if (!queue.length) return;

      // Collapse repeated writes to the same task — the last one wins.
      const byKey = new Map();
      for (const w of queue) {
        if (!w.projectId) { console.warn('[pm] write with no projectId', w.id); continue; }
        const key = `${w.projectId}/${w.id}`;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, { ...w }); continue; }
        if (w.kind === 'delete') { byKey.set(key, { ...w }); continue; }
        if (prev.kind === 'delete') continue;
        byKey.set(key, {
          ...prev,
          kind: prev.kind === 'set' ? 'set' : w.kind,
          data: { ...prev.data, ...w.data },
          full: w.full || prev.full,
        });
      }

      const ops = [...byKey.values()];
      for (let i = 0; i < ops.length; i += 400) {
        const batch = writeBatch(db);
        for (const w of ops.slice(i, i + 400)) {
          const ref = doc(db, 'projects', w.projectId, 'tasks', w.id);
          if (w.kind === 'delete') batch.delete(ref);
          else if (w.kind === 'set') batch.set(ref, scrub(w.data));
          else batch.set(ref, scrub(w.data), { merge: true });
        }
        await batch.commit();
      }
    }

    /** Bulk-upload work created while signed out. */
    async migrate({ projects = [], tasks = {} }, currentUser) {
      const out = [];
      for (const p of projects) {
        const owned = {
          ...p,
          createdBy: p.createdBy || currentUser.uid,
          members: (p.members?.length ? p.members : [S.makeMember({
            uid: currentUser.uid, email: currentUser.email,
            name: currentUser.displayName, photoURL: currentUser.photoURL,
            role: 'owner', status: 'active',
          })]).map(m => (m.email === currentUser.email ? { ...m, uid: currentUser.uid, status: 'active' } : m)),
        };
        owned.memberUids = [...new Set([currentUser.uid, ...(owned.memberUids || [])])];
        owned.memberEmails = owned.members.map(m => (m.email || '').toLowerCase()).filter(Boolean);

        await this.saveProject(owned);
        const list = tasks[p.id] || [];
        if (list.length) {
          await this.commit(list.map(t => ({ kind: 'set', id: t.id, data: t })), { projectId: p.id });
          await this._flushWrites();
        }
        out.push(owned.id);
      }
      return out;
    }

    _err(where, err) {
      console.error(`[pm/firestore] ${where}:`, err);
      if (err?.code === 'permission-denied') {
        global.Modal?.toast?.('Firestore denied that. Publish the security rules from firestore.rules.', 'warn', 6000);
      }
    }

    async dispose() {
      if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
      await this._flushWrites().catch(() => {});
      this._unsubProjects?.();
      for (const unsub of this._unsubTasks.values()) unsub();
      this._unsubTasks.clear();
    }
  }

  /* ---- helpers -------------------------------------------------------- */

  function addTo(map, key, val) {
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(val);
  }
  function delFrom(map, key, val) {
    const s = map.get(key);
    if (s) { s.delete(val); if (!s.size) map.delete(key); }
  }

  global.PMAdapters = { BaseAdapter, LocalAdapter, FirestoreAdapter, scrub };

})(window);
