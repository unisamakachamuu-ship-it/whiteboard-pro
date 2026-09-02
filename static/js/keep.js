/* ================================================================
   KeepIntegration – Google Keep import UI & API communication
   ================================================================ */

/*
 * Why the sign-in here looks the way it does.
 *
 * Google Keep has no public API for a personal account, and the App
 * Password route every guide describes was closed: a *correct* App
 * Password is now rejected exactly like a wrong one. That is why "I used
 * an App Password and it still says login failed" was the normal
 * experience rather than a mistake.
 *
 * What still works is the Android sign-in — a one-time `oauth_token` from
 * the browser, traded server-side for a long-lived master token. It is a
 * fiddly minute of work, so it is done exactly once: the master token
 * comes back to the client and is kept here, and every later import
 * resumes from it silently.
 */
const KEEP_STORE = 'wbpro.keep.session.v1';

class KeepIntegration {
  constructor(app) {
    this.app = app;
    this.isAuthenticated = false;
    this.token = null;
    this.email = null;
    this.notes = [];
    this._restore();
    this._bindUI();
  }

  /** A saved master token means the modal can go straight to the notes. */
  _restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEEP_STORE) || 'null');
      if (saved?.token && saved?.email) {
        this.token = saved.token;
        this.email = saved.email;
        this.isAuthenticated = true;
      }
    } catch (_) { /* a corrupt entry just means signing in again */ }
  }

  _remember() {
    try {
      localStorage.setItem(KEEP_STORE, JSON.stringify({ token: this.token, email: this.email }));
    } catch (_) {}
  }

  _forget() {
    try { localStorage.removeItem(KEEP_STORE); } catch (_) {}
    this.token = null;
    this.isAuthenticated = false;
  }

  _bindUI() {
    // The modal itself is opened from the Workspace panel's Keep section now
    // (GWPanel calls app.keep.openModal() directly) — there is no standalone
    // toolbar button anymore.

    // Close modal
    document.querySelector('#keep-modal .modal-close')?.addEventListener('click', () => this.closeModal());

    // Login
    document.getElementById('keep-login-btn')?.addEventListener('click', () => this.login());

    // Select all
    document.getElementById('keep-select-all')?.addEventListener('click', () => this.toggleSelectAll());

    // Import
    document.getElementById('keep-import-btn')?.addEventListener('click', () => this.importSelected());

    // Search filter
    document.getElementById('keep-search')?.addEventListener('input', (e) => this.filterNotes(e.target.value));

    // Close on overlay click
    document.getElementById('keep-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'keep-modal') this.closeModal();
    });

    /* ---- live two-way sync ---- */

    document.getElementById('keep-live-toggle')?.addEventListener('change', e => {
      const sync = this.app.keepSync;
      if (!sync) return;
      // start() can refuse (no token), so the switch follows what actually
      // happened rather than what was clicked.
      const on = e.target.checked ? sync.start() : (sync.stop(), false);
      e.target.checked = !!on;
    });

    document.getElementById('keep-sync-now')?.addEventListener('click', async () => {
      const sync = this.app.keepSync;
      if (!sync) return;
      if (!sync.enabled) { Modal.toast('Switch live sync on first.', 'info', 2500); return; }
      await sync.pull();
      await sync.push();
    });

    document.getElementById('keep-push-selection')?.addEventListener('click', () => {
      this.app.keepSync?.createFromSelection();
    });
  }

  /** Reflect the sync engine's live state in the dialog. */
  _wireSyncStatus() {
    const sync = this.app.keepSync;
    const toggle = document.getElementById('keep-live-toggle');
    const status = document.getElementById('keep-live-status');
    const box = document.getElementById('keep-live');
    if (!sync || !toggle || this._syncWired) return;
    this._syncWired = true;

    sync.onChange(s => {
      toggle.checked = s.enabled;
      if (box) box.dataset.state = s.status;
      if (!status) return;

      if (!s.enabled) {
        status.textContent = 'Edits on the board are written back to Keep, and changes made in Keep appear here.';
        return;
      }
      if (s.conflicts.size) {
        status.textContent = `${s.conflicts.size} note(s) changed in both places — nothing was overwritten.`;
        return;
      }
      const when = s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : null;
      status.textContent = s.status === 'error'
        ? s.detail
        : `${s.detail || 'On'}${when ? ` · last checked ${when}` : ''}`;
    });

    // One click through to the side-by-side comparison when there is one.
    status?.addEventListener('click', () => {
      if (sync.conflicts.size) sync.openConflicts();
    });
  }

  openModal() {
    document.getElementById('keep-modal').classList.remove('hidden');

    // Auto-fill email if already signed into Google via Workspace or Firebase
    const emailInput = document.getElementById('keep-email');
    const knownEmail = this.email || window.GoogleAccount?.identity?.email;
    if (knownEmail && !emailInput.value) {
      emailInput.value = knownEmail;
    }

    // A remembered token goes straight to fetching, rather than showing a
    // sign-in form to someone who has already signed in.
    if (this.isAuthenticated && this.token) {
      this.fetchNotes();
    } else {
      this._showStep('login');
    }
  }

  closeModal() {
    document.getElementById('keep-modal').classList.add('hidden');
  }

  _showStep(step) {
    document.querySelectorAll('.keep-step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`keep-step-${step}`).classList.remove('hidden');
  }

  /* -------- Authentication -------- */

  async login() {
    const email = document.getElementById('keep-email').value.trim();
    const secret = document.getElementById('keep-password').value.trim();
    const errorEl = document.getElementById('keep-error');

    if (!email || !secret) {
      errorEl.textContent = 'Enter your Google email and one of the three credentials.';
      errorEl.classList.remove('hidden');
      return;
    }

    errorEl.classList.add('hidden');
    this._showStep('loading');

    // The three credentials are told apart by their own prefixes rather
    // than by three separate boxes the user has to choose between —
    // choosing wrongly was itself a way to fail.
    const body = { email };
    if (secret.startsWith('oauth2_4/')) body.oauth_token = secret;
    else if (secret.startsWith('aas_et/')) body.master_token = secret;
    else body.password = secret;

    try {
      const res = await fetch('/api/keep/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        this._showStep('login');
        this._showError(data);
        return;
      }

      this.token = data.token;
      this.email = email;
      this.isAuthenticated = true;
      this._remember();
      document.getElementById('keep-password').value = '';
      await this.fetchNotes();
    } catch (err) {
      this._showStep('login');
      errorEl.textContent = 'Could not reach the server. Is it still running?';
      errorEl.classList.remove('hidden');
    }
  }

  /**
   * Show the fix, not just the failure. The server sends `fix` for every
   * cause it can name, and opens the browser-token instructions itself
   * when an App Password is the thing that was rejected — which is now
   * the expected outcome, not user error.
   */
  _showError(data) {
    const errorEl = document.getElementById('keep-error');
    errorEl.textContent = [data.error, data.fix].filter(Boolean).join(' ')
      || 'Sign-in failed.';
    errorEl.classList.remove('hidden');
    if (data.needsBrowserToken) {
      const help = document.getElementById('keep-help');
      if (help) help.open = true;
    }
  }

  /* -------- Fetch Notes -------- */

  async fetchNotes() {
    this._showStep('loading');
    try {
      const headers = this.token ? { 'X-Keep-Token': this.token, 'X-Keep-Email': this.email } : {};
      const res = await fetch('/api/keep/notes', { headers });
      const data = await res.json();

      if (!res.ok) {
        // A stored token that no longer works must not strand the user on
        // a form that keeps failing — drop it and ask for a fresh one.
        if (res.status === 401 || /token/i.test(data.error || '')) this._forget();
        this._showStep('login');
        this._showError(data);
        return;
      }

      this.notes = data;
      this._renderNotesList(this.notes);
      this._showStep('notes');
      this._wireSyncStatus();
    } catch (err) {
      this._showStep('login');
      document.getElementById('keep-error').textContent = 'Failed to fetch notes.';
      document.getElementById('keep-error').classList.remove('hidden');
    }
  }

  /* -------- Render Notes List -------- */

  _renderNotesList(notes) {
    const list = document.getElementById('keep-notes-list');
    list.innerHTML = '';

    if (!notes.length) {
      list.innerHTML = '<p style="padding:16px;color:#9ca3af;">No notes found.</p>';
      return;
    }

    notes.forEach(note => {
      const item = document.createElement('div');
      item.className = 'keep-note-item';
      item.innerHTML = `
        <input type="checkbox" data-note-id="${note.id}" />
        <span class="note-color-dot" style="background:${note.color}"></span>
        <div class="note-preview">
          <div class="note-title">${this._escapeHtml(note.title || 'Untitled')}</div>
          <div class="note-snippet">${this._escapeHtml((note.content || '').slice(0, 100))}</div>
        </div>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          const cb = item.querySelector('input[type="checkbox"]');
          cb.checked = !cb.checked;
        }
      });
      list.appendChild(item);
    });
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* -------- Filter -------- */

  filterNotes(query) {
    const q = query.toLowerCase();
    const filtered = this.notes.filter(n =>
      (n.title || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q)
    );
    this._renderNotesList(filtered);
  }

  /* -------- Select All -------- */

  toggleSelectAll() {
    const checkboxes = document.querySelectorAll('#keep-notes-list input[type="checkbox"]');
    const allChecked = Array.from(checkboxes).every(c => c.checked);
    checkboxes.forEach(c => c.checked = !allChecked);
  }

  /* -------- Import Selected -------- */

  async importSelected() {
    const checkboxes = document.querySelectorAll('#keep-notes-list input[type="checkbox"]:checked');
    const noteIds = Array.from(checkboxes).map(c => c.dataset.noteId);

    if (!noteIds.length) {
      Modal.toast('Select at least one note to import.', 'warn');
      return;
    }

    try {
      const res = await fetch('/api/keep/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Keep-Token': this.token, 'X-Keep-Email': this.email } : {}),
        },
        body: JSON.stringify({ note_ids: noteIds }),
      });
      const data = await res.json();

      if (!res.ok) {
        Modal.toast(data.error || 'Import failed.', 'warn');
        return;
      }

      // Add imported elements to the board, centred on the current view.
      if (data.elements && data.elements.length) {
        const view = this.app.viewport.screenToBoard(
          this.app.viewport.width / 2, this.app.viewport.height / 2);
        const bounds = Util.boundsOf(data.elements);
        const dx = view.x - (bounds.x + bounds.w / 2);
        const dy = view.y - (bounds.y + bounds.h / 2);

        this.app.store.transact('import from Keep', () => {
          const created = data.elements.map(el => {
            const clone = { ...el, x: el.x + dx, y: el.y + dy };
            delete clone.id;
            const made = this.app.store.addElement('sticky-note', clone, { silent: true });
            // Record what the board and Keep currently agree on, so live
            // sync can tell a real edit from the import itself. Without
            // this baseline the first poll would see every note as changed.
            if (made.meta?.keepId && window.KeepSync?.fingerprint) {
              made.meta.keepHash = window.KeepSync.fingerprint(made);
            }
            return made;
          });
          this.app.store.select(created.map(c => c.id));
        });
        this.app.viewport.zoomToSelection();
      }

      this.closeModal();
      Modal.toast(`Imported ${data.count} note${data.count === 1 ? '' : 's'} from Google Keep.`
        + (this.app.keepSync?.enabled ? ' Live sync is on — edits go both ways.' : ''), 'success');
    } catch (err) {
      Modal.toast('Import failed — see the console for details.', 'warn');
      console.error(err);
    }
  }

  /* -------- Logout -------- */

  async logout() {
    await fetch('/api/keep/logout', { method: 'POST' });
    this._forget();
    this.notes = [];
  }
}

window.KeepIntegration = KeepIntegration;
