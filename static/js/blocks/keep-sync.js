/* ================================================================
   keep-sync.js — the board and Google Keep as one document
   ----------------------------------------------------------------
   Import was a snapshot: notes landed on the canvas and the two
   copies drifted apart from that second onwards. This keeps them the
   same thing. Edit a sticky here and the note changes in Keep; edit
   it on your phone and the sticky changes here.

   How a sticky maps to a note
   ---------------------------
   The first line of the sticky is the note's title, everything after
   it is the body — but ONLY for notes that already have a title. A
   Keep note with no title shows on the board as its body alone, and
   splitting that back would promote its first line to a title,
   restructuring a note the user never touched. So titlelessness is
   remembered and preserved.

   Deciding who wins
   -----------------
   Every note carries an `updated` stamp from Keep, and the board
   remembers two things per sticky: the stamp it last reconciled
   (`keepUpdated`) and a hash of the version both sides last agreed on
   (`keepHash`).

     remote moved, local clean  →  pull. Silent, this is the normal case.
     local moved, remote same   →  push. Debounced, so typing is one write.
     both moved                 →  CONFLICT. Neither side is overwritten;
                                   the user is shown both and picks.
     no baseline yet            →  ADOPT. Take Keep's copy and record the
                                   baseline, so the note starts agreeing.

   That last case matters more than it looks. A note imported before
   sync existed has no baseline, so "has the board edited this?" is
   unanswerable — and answering "yes" made every incoming change look
   like a conflict, which is why edits made in the Keep app never
   appeared on the board.

   Nothing here starts on its own — sync is off until switched on, and
   it stops the moment the Keep token stops working.
   ================================================================ */

(function (global) {
  'use strict';

  const PULL_MS = 20000;            // how often to ask Keep what changed
  const PUSH_DEBOUNCE_MS = 2500;    // typing settles before a write goes out
  const FOCUS_MIN_GAP_MS = 5000;    // don't re-poll on every alt-tab
  const ENABLED_KEY = 'wbpro.keep.live.v1';

  /* A separator that cannot occur inside a note, so a title ending in a
     space cannot hash the same as a body starting with one. */
  const SEP = '␟';             // ␟, printable, safe in source

  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
    return n;
  };
  const toast = (m, k = 'info', ms = 3000) =>
    (global.Modal?.toast || global.PMUI?.toast || (x => console.info(x)))(m, k, ms);

  /** Cheap, stable, and enough to tell "changed" from "did not". */
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h);
  }

  /** first line → title, the rest → body. */
  function split(content) {
    const text = String(content || '');
    const nl = text.indexOf('\n');
    if (nl === -1) return { title: text.trim(), body: '' };
    return { title: text.slice(0, nl).trim(), body: text.slice(nl + 1).replace(/^\n+/, '') };
  }

  function join(title, body) {
    const t = String(title || '').trim();
    const b = String(body || '');
    if (!t) return b;
    return b ? `${t}\n\n${b}` : t;
  }

  /** What this sticky would look like as a Keep note. */
  function project(elm) {
    const titled = elm.meta?.keepTitled !== false;
    const parts = titled ? split(elm.content) : { title: '', body: String(elm.content || '') };
    return { ...parts, color: elm.style?.backgroundColor || '' };
  }

  /**
   * The agreement hash.
   *
   * Both directions MUST derive it from the same shape. Hashing the local
   * content one way and the remote fields another way was a real bug: for
   * an untitled note the two never matched, so it looked permanently
   * edited, was pushed on every cycle, and never accepted an incoming
   * change.
   */
  function fingerprintOf(p) {
    return hash(`${p.title || ''}${SEP}${p.body || ''}${SEP}${p.color || ''}`);
  }

  const fingerprint = elm => fingerprintOf(project(elm));
  const remoteFingerprint = note =>
    fingerprintOf({ title: note.title, body: note.content, color: note.color });

  /** How a remote note renders on the board. */
  const remoteContent = note => join(note.title, note.content);

  class KeepSync {
    constructor(app) {
      this.app = app;
      this.store = app.store;
      this.enabled = false;
      this.status = 'off';         // off | idle | pulling | pushing | error
      this.detail = '';
      this.lastSync = null;
      this.conflicts = new Map();  // elementId -> remote note
      this._timer = null;
      this._pushTimer = null;
      this._dirty = new Set();
      this._watchers = new Set();
      this._busy = false;
      this._lastFocusPull = 0;
      this._failStreak = 0;
      this._authBanner = null;

      this.store.on('change', ({ label }) => this._onBoardChange(label));

      // Coming back to the tab is the moment someone has just finished
      // editing on their phone. Waiting out the rest of the interval then
      // is what makes sync feel broken even when it is working.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this._pullOnFocus();
      });
      global.addEventListener('focus', () => this._pullOnFocus());

      try {
        if (localStorage.getItem(ENABLED_KEY) === '1') {
          setTimeout(() => { if (this.hasToken) this.start({ quiet: true }); }, 1500);
        }
      } catch (_) {}
    }

    _pullOnFocus() {
      if (!this.enabled) return;
      const now = Date.now();
      if (now - this._lastFocusPull < FOCUS_MIN_GAP_MS) return;
      this._lastFocusPull = now;
      this.pull({ quiet: true });
    }

    /* ---- session ------------------------------------------------------- */

    get keep() { return this.app.keep || global.app?.keep; }
    get hasToken() { return !!(this.keep?.token && this.keep?.email); }

    get headers() {
      return {
        'Content-Type': 'application/json',
        'X-Keep-Token': this.keep.token,
        'X-Keep-Email': this.keep.email,
      };
    }

    onChange(fn) { this._watchers.add(fn); fn(this); return () => this._watchers.delete(fn); }

    _emit(status, detail = '') {
      this.status = status;
      this.detail = detail;
      for (const fn of this._watchers) { try { fn(this); } catch (e) { console.error(e); } }
    }

    /* ---- lifecycle ------------------------------------------------------ */

    start({ quiet = false } = {}) {
      if (!this.hasToken) {
        if (!quiet) toast('Connect to Google Keep first — the Keep button in the top bar.', 'warn', 5000);
        return false;
      }
      this.enabled = true;
      try { localStorage.setItem(ENABLED_KEY, '1'); } catch (_) {}
      this._emit('idle', 'Live sync on');
      if (!quiet) toast('Live sync with Google Keep is on. Edits go both ways.', 'success', 4000);
      this._hideAuthBanner();
      this._failStreak = 0;

      this._scheduleNextPull(0);
      return true;
    }

    stop({ quiet = false } = {}) {
      this.enabled = false;
      try { localStorage.setItem(ENABLED_KEY, '0'); } catch (_) {}
      clearTimeout(this._timer);
      clearTimeout(this._pushTimer);
      this._emit('off', '');
      if (!quiet) toast('Live sync with Keep is off. Your notes are untouched on both sides.', 'info', 3500);
    }

    toggle() { return this.enabled ? (this.stop(), false) : this.start(); }

    /** Self-rescheduling poll loop (replaces a fixed setInterval) so a run
     *  of failures backs off instead of hammering a struggling connection
     *  every 20s forever — a single successful pull resets it. */
    _scheduleNextPull(delay) {
      clearTimeout(this._timer);
      this._timer = setTimeout(async () => {
        await this.pull({ quiet: true });
        if (this.enabled) this._scheduleNextPull(this._nextPullDelay());
      }, delay);
    }

    _nextPullDelay() {
      if (!this._failStreak) return PULL_MS;
      return Math.min(PULL_MS * Math.pow(2, Math.min(this._failStreak, 4)), 300000);
    }

    /* ---- bindings -------------------------------------------------------- */

    /** Every sticky on this board that is a view of a Keep note. */
    bound() {
      return this.store.state.elements.filter(e => e.meta?.keepId);
    }

    _onBoardChange(label) {
      if (!this.enabled || this._busy) return;
      // A pull writes through the store too; without this guard that write
      // would immediately be queued as a local edit and pushed straight
      // back, which is how sync loops start.
      if (label === 'keep sync') return;

      for (const elm of this.bound()) {
        if (elm.meta.keepHash && fingerprint(elm) !== elm.meta.keepHash) this._dirty.add(elm.id);
      }
      if (!this._dirty.size) return;

      clearTimeout(this._pushTimer);
      this._pushTimer = setTimeout(() => this.push({ quiet: true }), PUSH_DEBOUNCE_MS);
      this._emit('idle', `${this._dirty.size} note${this._dirty.size === 1 ? '' : 's'} to send`);
    }

    /* ---- pull ------------------------------------------------------------ */

    async pull({ quiet = false } = {}) {
      if (!this.enabled || !this.hasToken || this._busy) return;
      this._busy = true;
      this._emit('pulling', 'Reading Keep…');

      try {
        const res = await fetch('/api/keep/state', { headers: this.headers });
        const data = await res.json();
        if (!res.ok) throw Object.assign(new Error(data.error || 'Keep read failed'), { data });

        const remote = new Map(data.notes.map(n => [n.id, n]));
        let pulled = 0, adopted = 0, conflicted = 0, gone = 0;

        this.store.transact('keep sync', () => {
          for (const elm of this.bound()) {
            const note = remote.get(elm.meta.keepId);
            if (!note) { gone++; this._flagMissing(elm); continue; }

            const rFinger = remoteFingerprint(note);
            const baseline = elm.meta.keepHash;

            // No baseline: imported before sync existed, so "did the board
            // edit this?" cannot be answered. Take Keep's copy and record
            // the baseline — after this the note tracks properly. Treating
            // it as a conflict instead is what stopped phone edits landing.
            if (!baseline) {
              this._adopt(elm, note, rFinger);
              if (fingerprint(elm) !== rFinger) adopted++;
              continue;
            }

            const remoteMoved = rFinger !== baseline;
            const localMoved = fingerprint(elm) !== baseline;

            if (!remoteMoved) continue;
            if (localMoved) { this.conflicts.set(elm.id, note); conflicted++; continue; }

            this._adopt(elm, note, rFinger);
            pulled++;
          }
        });

        this._failStreak = 0;
        this.lastSync = data.syncedAt || new Date().toISOString();
        this._emit(conflicted ? 'error' : 'idle',
          conflicted ? `${conflicted} conflict${conflicted === 1 ? '' : 's'}` : 'Up to date');

        if (pulled || adopted) this.app.renderer?.rebuildAll?.();
        if (pulled && !quiet) toast(`${pulled} note${pulled === 1 ? '' : 's'} updated from Keep.`, 'info', 3000);
        if (adopted) {
          toast(`${adopted} note${adopted === 1 ? '' : 's'} refreshed from Keep and now kept in step.`, 'info', 4500);
        }
        if (conflicted) this._announceConflicts();
        if (gone && !quiet) {
          toast(`${gone} note${gone === 1 ? ' is' : 's are'} no longer in Keep. The sticky stays on the board, marked.`, 'warn', 6000);
        }
      } catch (err) {
        this._emit('error', err.message);
        if (err.data?.fix) {
          this._tokenTrouble(err);
        } else {
          this._failStreak++;
          if (!quiet) toast(err.message, 'warn', 5000);
        }
      } finally {
        this._busy = false;
      }
    }

    /** Write Keep's version onto the sticky and record the agreement. */
    _adopt(elm, note, rFinger) {
      this.store.updateElement(elm.id, {
        content: remoteContent(note),
        style: { ...(elm.style || {}), backgroundColor: note.color || elm.style?.backgroundColor },
        meta: {
          ...elm.meta,
          keepTitled: !!(note.title && note.title.trim()),
          keepUpdated: note.updated,
          keepHash: rFinger ?? remoteFingerprint(note),
          keepMissing: false,
        },
      }, { silent: true });
      this._dirty.delete(elm.id);
      this.conflicts.delete(elm.id);
    }

    _flagMissing(elm) {
      if (elm.meta.keepMissing) return;
      this.store.updateElement(elm.id, { meta: { ...elm.meta, keepMissing: true } }, { silent: true });
    }

    /* ---- push ------------------------------------------------------------ */

    async push({ quiet = false, force = false } = {}) {
      if (!this.enabled || !this.hasToken || this._busy) return;

      const changes = [];
      for (const elm of this.bound()) {
        if (!this._dirty.has(elm.id) && !force) continue;
        if (this.conflicts.has(elm.id) && !force) continue;
        const p = project(elm);
        changes.push({
          keepId: elm.meta.keepId,
          baseUpdated: elm.meta.keepUpdated,
          title: p.title,
          content: p.body,
          color: p.color,
        });
      }
      if (!changes.length) return;

      this._busy = true;
      this._emit('pushing', `Sending ${changes.length}…`);

      try {
        const res = await fetch('/api/keep/push', {
          method: 'POST', headers: this.headers,
          body: JSON.stringify({ changes, force }),
        });
        const data = await res.json();
        if (!res.ok) throw Object.assign(new Error(data.error || 'Keep write failed'), { data });

        const byId = new Map(this.bound().map(e => [e.meta.keepId, e]));

        this.store.transact('keep sync', () => {
          for (const row of data.updated || []) {
            const elm = byId.get(row.keepId);
            if (!elm) continue;
            this.store.updateElement(elm.id, {
              meta: { ...elm.meta, keepUpdated: row.updated, keepHash: fingerprint(elm) },
            }, { silent: true });
            this._dirty.delete(elm.id);
            this.conflicts.delete(elm.id);
          }
        });

        for (const c of data.conflicts || []) {
          const elm = byId.get(c.keepId);
          if (elm) this.conflicts.set(elm.id, c.remote);
        }
        for (const id of data.missing || []) {
          const elm = byId.get(id);
          if (elm) this._flagMissing(elm);
        }

        this.lastSync = data.syncedAt;
        const n = (data.updated || []).length;
        const conflicts = (data.conflicts || []).length;
        this._emit(conflicts ? 'error' : 'idle', conflicts ? `${conflicts} conflict(s)` : 'Up to date');

        if (n && !quiet) toast(`${n} note${n === 1 ? '' : 's'} saved to Keep.`, 'success', 2500);
        if (conflicts) this._announceConflicts();
      } catch (err) {
        this._emit('error', err.message);
        if (err.data?.fix) this._tokenTrouble(err);
        else if (!quiet) toast(err.message, 'warn', 5000);
      } finally {
        this._busy = false;
      }
    }

    /**
     * Send stickies that are NOT yet in Keep.
     *
     * Deliberately explicit rather than automatic: a board has hundreds of
     * stickies and almost none of them are notes you want in Keep. Sync
     * that decides for you fills Keep with rubbish, and it is your Keep.
     */
    async createFromSelection() {
      if (!this.hasToken) { toast('Connect to Google Keep first.', 'warn'); return; }

      const picked = this.store.selected().filter(e => e.type === 'sticky-note' && !e.meta?.keepId);
      if (!picked.length) {
        toast('Select one or more sticky notes that are not already linked to Keep.', 'info', 4500);
        return;
      }

      const creates = picked.map(e => {
        const { title, body } = split(e.content);
        return { localId: e.id, title, content: body, color: e.style?.backgroundColor };
      });

      this._emit('pushing', `Creating ${creates.length}…`);
      try {
        const res = await fetch('/api/keep/push', {
          method: 'POST', headers: this.headers, body: JSON.stringify({ creates }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Keep write failed');

        this.store.transact('keep sync', () => {
          for (const row of data.created || []) {
            const elm = this.store.get(row.localId);
            if (!elm) continue;
            const note = row.note || {};
            this.store.updateElement(elm.id, {
              meta: {
                ...(elm.meta || {}),
                source: 'google-keep',
                keepId: row.keepId,
                keepUpdated: row.updated,
                keepTitled: !!(note.title && note.title.trim()),
                keepHash: note.id ? remoteFingerprint(note) : fingerprint(elm),
              },
            }, { silent: true });
          }
        });

        const n = (data.created || []).length;
        this._emit('idle', 'Up to date');
        toast(`${n} note${n === 1 ? '' : 's'} created in Google Keep and now kept in step.`, 'success', 4000);
        this.app.renderer?.rebuildAll?.();
      } catch (err) {
        this._emit('error', err.message);
        toast(err.message, 'warn', 5000);
      }
    }

    /* ---- conflicts -------------------------------------------------------- */

    _announceConflicts() {
      const n = this.conflicts.size;
      if (!n) return;
      toast(`${n} note${n === 1 ? '' : 's'} changed in both places. Nothing was overwritten — open the Keep dialog to choose.`,
        'warn', 9000);
    }

    /** Show both versions side by side and let a person decide. */
    openConflicts() {
      if (!this.conflicts.size) { toast('No conflicts.', 'info', 2000); return; }

      const wrap = el('div', { class: 'keep-conflicts' });

      for (const [elementId, remote] of this.conflicts) {
        const elm = this.store.get(elementId);
        if (!elm) { this.conflicts.delete(elementId); continue; }

        const row = el('div', { class: 'keep-conflict' }, [
          el('h4', { text: project(elm).title || remote.title || 'Untitled note' }),
          el('div', { class: 'keep-conflict-cols' }, [
            el('div', { class: 'keep-conflict-col' }, [
              el('strong', { text: 'On this board' }),
              el('pre', { text: elm.content || '(empty)' }),
              el('button', {
                type: 'button', class: 'btn btn-primary',
                onclick: async () => {
                  this.conflicts.delete(elementId);
                  this._dirty.add(elementId);
                  row.remove();
                  await this.push({ force: true });
                },
              }, [document.createTextNode('Keep this, overwrite Keep')]),
            ]),
            el('div', { class: 'keep-conflict-col' }, [
              el('strong', { text: 'In Google Keep' }),
              el('pre', { text: remoteContent(remote) || '(empty)' }),
              el('button', {
                type: 'button', class: 'btn',
                onclick: () => {
                  this.store.transact('keep sync', () => {
                    this._adopt(this.store.get(elementId), remote, remoteFingerprint(remote));
                  });
                  this.app.renderer?.rebuildAll?.();
                  row.remove();
                  if (!this.conflicts.size) this._emit('idle', 'Up to date');
                },
              }, [document.createTextNode('Use Keep’s version')]),
            ]),
          ]),
        ]);
        wrap.appendChild(row);
      }

      global.Modal?.open({
        title: '<i class="ph ph-git-merge"></i> Notes changed in both places',
        width: 720, body: wrap, actions: [{ label: 'Close' }],
      });
    }

    _tokenTrouble(err) {
      this.stop({ quiet: true });
      toast(`${err.message} ${err.data?.fix || ''}`, 'warn', 8000);
      // A single toast is easy to miss, and sync then stays silently off
      // (surviving reload) until someone happens to reopen the Keep
      // modal — this stays on screen until they act instead.
      this._showAuthBanner(err);
    }

    _showAuthBanner(err) {
      if (this._authBanner) return;
      const bar = el('div', {
        class: 'keep-sync-banner',
        style: {
          position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
          zIndex: 9999, display: 'flex', alignItems: 'center', gap: '10px',
          padding: '10px 14px', borderRadius: '10px',
          background: 'var(--clr-surface, #24242c)', color: 'var(--clr-text, #f2f2f5)',
          border: '1px solid var(--clr-warning, #e0a02c)',
          boxShadow: '0 6px 24px rgba(0,0,0,.25)', fontSize: '13px', maxWidth: '90vw',
        },
      }, [
        el('i', { class: 'ph-fill ph-warning-circle', style: { color: 'var(--clr-warning, #e0a02c)', fontSize: '16px' } }),
        el('span', { text: `Keep live sync turned off — ${err.message}` }),
        el('button', {
          type: 'button', text: 'Reconnect', class: 'btn btn-ghost',
          style: { padding: '4px 10px', fontSize: '12px' },
          onclick: () => { this._hideAuthBanner(); this.app.keep?.openModal(); },
        }),
        (() => {
          const b = el('button', {
            type: 'button',
            style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' },
            onclick: () => this._hideAuthBanner(),
          });
          b.innerHTML = '<i class="ph ph-x"></i>';
          return b;
        })(),
      ]);
      document.body.appendChild(bar);
      this._authBanner = bar;
    }

    _hideAuthBanner() {
      this._authBanner?.remove();
      this._authBanner = null;
    }
  }

  // The importer needs the same functions this module compares against, so
  // that a freshly imported note starts out agreeing with Keep rather than
  // looking edited on the very first poll.
  KeepSync.fingerprint = fingerprint;
  KeepSync.remoteFingerprint = remoteFingerprint;
  KeepSync.project = project;
  KeepSync.split = split;
  KeepSync.join = join;

  global.KeepSync = KeepSync;

  /* ---- boot ------------------------------------------------------------- */

  function boot() {
    const app = global.app;
    if (!app?.store) { setTimeout(boot, 400); return; }
    if (app.keepSync) return;
    app.keepSync = new KeepSync(app);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 0);
  else global.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
})(window);
