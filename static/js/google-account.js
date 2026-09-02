/* ================================================================
   google-account.js — one Google identity for the whole app
   ----------------------------------------------------------------
   Why this file exists.

   The app had two unrelated Google logins and no idea they were
   related:

     1. Firebase Authentication, behind the "Google Sign in" button in
        the whiteboard's top bar. It provides the *identity* used for
        realtime sync, project membership and permissions.

     2. A server-side OAuth 2.0 connection (/api/google/*), reached
        only from the Google Workspace screen inside Projects. It
        provides the *data* — Drive, Docs, Gmail, Calendar, Tasks.

   Signing into one told you nothing about the other. You could be
   connected to Workspace with a full set of scopes and still see
   "Google Sign in" on the whiteboard, and clicking it opened a second,
   unexplained consent screen for a different product. When the popup
   was blocked — which is the default in a lot of setups — it failed
   silently, which is what "the other Google login does not work"
   meant.

   This module makes the two halves one account:

     · One button. It connects whichever half is missing, and says
       which half it is working on.
     · One status. The chip reports the weakest of the two, so
       "connected" always means both.
     · One identity. Whichever half is connected supplies the name,
       email and avatar, so the header is never blank while the other
       half is still negotiating.
     · Failures name themselves and link to the console page that
       fixes them, instead of a generic "sign-in failed".

   It owns the markup already in the top bar (#google-login-btn,
   #user-profile and the dropdown) rather than adding any of its own.
   ================================================================ */

(function (global) {
  'use strict';

  const POLL_AFTER_CONNECT_MS = 1200;

  class GoogleAccount {
    constructor() {
      /** Tells firebase-sync.js to stand down: this module drives the button. */
      this.ownsAuthButton = true;

      this.workspace = null;      // last /api/google/status payload
      this.firebaseUser = null;
      this._listeners = new Set();
      this._statusInFlight = null;

      this.el = {
        box:      document.getElementById('auth-box'),
        loginBtn: document.getElementById('google-login-btn'),
        profile:  document.getElementById('user-profile'),
        avatar:   document.getElementById('user-avatar'),
        name:     document.getElementById('user-name'),
        pill:     document.getElementById('cloud-pill'),
        menu:     document.getElementById('user-menu-dropdown'),
        menuName: document.getElementById('user-menu-name'),
        menuMail: document.getElementById('user-menu-email'),
        logout:   document.getElementById('user-logout-btn'),
      };

      this._bind();
      this.refresh();
    }

    /* ---- state ------------------------------------------------------- */

    /** The account to show and attribute work to, from whichever half has one. */
    get identity() {
      if (this.firebaseUser) {
        return {
          email: this.firebaseUser.email || '',
          name: this.firebaseUser.displayName || this.firebaseUser.email || 'You',
          photo: this.firebaseUser.photoURL || '',
          uid: this.firebaseUser.uid,
        };
      }
      // /api/google/status calls this `account`. Reading only `profile` — a
      // name the server never sent — meant a fully connected Workspace
      // account produced no identity at all, so the header kept rendering
      // "Google Sign in" next to a working connection. Clicking it opened a
      // *second*, unrelated consent flow, which is the duplicate button and
      // the OAuth error it ended in. Both names are accepted now.
      const p = this.workspace?.account || this.workspace?.profile;
      if (p) return { email: p.email || '', name: p.name || p.email || 'You', photo: p.picture || '', uid: null };
      return null;
    }

    /** The Google account the server holds a token for, under either name. */
    get workspaceProfile() {
      return this.workspace?.account || this.workspace?.profile || null;
    }

    get signedIn()          { return !!this.firebaseUser; }
    get workspaceConnected() { return !!this.workspace?.connected; }

    /** True when the stored token predates the current scope list. */
    get workspaceStale() {
      return this.workspaceConnected && (this.workspace.missingScopes || []).length > 0;
    }

    get workspaceConfigured() { return !!this.workspace?.configured; }

    /**
     * One word for the pair, always the weaker half:
     *   'off'        neither half connected
     *   'partial'    one half only, or scopes missing
     *   'connected'  both halves, full scopes
     */
    get state() {
      if (!this.signedIn && !this.workspaceConnected) return 'off';
      if (!this.signedIn || !this.workspaceConnected || this.workspaceStale) return 'partial';
      return 'connected';
    }

    /** The two halves disagree about who is logged in. */
    get mismatch() {
      const a = (this.firebaseUser?.email || '').toLowerCase();
      const b = (this.workspaceProfile?.email || '').toLowerCase();
      return !!(a && b && a !== b);
    }

    onChange(fn) {
      this._listeners.add(fn);
      try { fn(this); } catch (e) { console.error(e); }
      return () => this._listeners.delete(fn);
    }

    _emit() {
      for (const fn of this._listeners) {
        try { fn(this); } catch (e) { console.error('[google-account]', e); }
      }
      global.dispatchEvent(new CustomEvent('google-account-change', { detail: this }));
    }

    /* ---- wiring ------------------------------------------------------ */

    _bind() {
      const { loginBtn, profile, menu, logout } = this.el;

      loginBtn && loginBtn.addEventListener('click', () => this.connect());

      profile && profile.addEventListener('click', e => {
        e.stopPropagation();
        this._renderMenu();
        menu && menu.classList.toggle('hidden');
      });
      document.addEventListener('click', () => menu && menu.classList.add('hidden'));

      logout && logout.addEventListener('click', e => {
        e.stopPropagation();
        menu && menu.classList.add('hidden');
        this.disconnect();
      });

      // Firebase publishes its user asynchronously and may not have parsed yet.
      const attach = () => {
        const fb = global.FirebaseSync;
        if (!fb) return false;
        fb.onUserChange(user => {
          this.firebaseUser = user || null;
          // Signing in on one half often means the other was just done too.
          if (user) this.refresh({ fresh: true });
          else this._render();
        });
        return true;
      };
      if (!attach()) global.addEventListener('firebase-ready', attach, { once: true });

      // The OAuth callback page closes itself and posts back to the opener.
      global.addEventListener('message', e => {
        if (e.origin !== location.origin) return;
        if (e.data && e.data.type === 'google-connected') this.refresh({ fresh: true });
      });

      // Primary path, not just a fallback: accounts.google.com's
      // Cross-Origin-Opener-Policy header severs window.opener for a
      // popup that navigates there, so postMessage(window.opener, ...)
      // can silently never arrive even from a real, successfully-closing
      // popup. BroadcastChannel isn't tied to that reference at all.
      if ('BroadcastChannel' in global) {
        try {
          const bc = new BroadcastChannel('wbpro-google-oauth');
          bc.onmessage = e => { if (e.data?.type === 'google-connected') this.refresh({ fresh: true }); };
        } catch (_) { /* unsupported in this browser — postMessage/polling still cover it */ }
      }
    }

    /* ---- server half -------------------------------------------------- */

    async refresh({ fresh = false } = {}) {
      if (this._statusInFlight && !fresh) return this._statusInFlight;
      this._statusInFlight = (async () => {
        try {
          const res = await fetch('/api/google/status', { headers: { Accept: 'application/json' } });
          this.workspace = res.ok ? await res.json() : { configured: false, connected: false };
        } catch {
          this.workspace = { configured: false, connected: false, unreachable: true };
        }
        this._render();
        this._emit();
        // Workspace connected but Firebase isn't signed in yet — bridge it
        // automatically instead of waiting for something to ask for a
        // second sign-in. Self-limiting: signing in fires onUserChange,
        // which calls refresh({fresh:true}) again, and by then signedIn is
        // true so this check is skipped — no loop. Silent here (no toast) —
        // this runs on every passive refresh, not just an explicit click;
        // connect() surfaces the same result with a toast when it's the
        // user's own click driving it.
        if (this.workspaceConnected && !this.signedIn) this._bridgeFirebaseIdentity();
        return this.workspace;
      })();
      try { return await this._statusInFlight; }
      finally { this._statusInFlight = null; }
    }

    /**
     * Connect whichever half is missing — and only ever show ONE Google
     * consent screen to do it. Workspace first, since it is the half that
     * is usually already half-configured and its consent screen explains
     * what is being granted; Firebase sign-in then happens automatically
     * from that same connection via _bridgeFirebaseIdentity(), never a
     * second popup.
     */
    async connect() {
      if (!this.workspaceConnected || this.workspaceStale) {
        if (!this.workspaceConfigured) {
          this._toast(
            'Google is not configured on the server yet. Put GOOGLE_CLIENT_ID and ' +
            'GOOGLE_CLIENT_SECRET in .env and restart, then try again.', 'warn', 8000);
        } else {
          this.connectWorkspace();       // refresh() bridges Firebase automatically once it lands
        }
        return;
      }

      const result = await this._bridgeFirebaseIdentity();
      if (result.ok) {
        this._toast(`Signed in as ${result.user.email}.`, 'success', 3000);
      } else if (result.reason === 'not-configured') {
        this._toast(
          'Live sync and sharing need one more one-time setup step on the server ' +
          '(a Firebase Admin service account key) — see the README, or ask whoever ' +
          'runs this server to add it.', 'warn', 8000);
      } else if (result.reason === 'stale-connection') {
        this._toast('Reconnect Google Workspace once to enable sharing/live sync — Drive, Gmail and Calendar keep working the whole time.', 'warn', 7000);
        this.connectWorkspace();
      } else {
        this._toast('Could not sign in for live sync/sharing: ' + (result.message || 'unknown error'), 'warn', 7000);
      }
    }

    /**
     * Sign into Firebase from the already-connected Workspace account — the
     * server mints a custom token for that same Google identity
     * (/api/auth/firebase-token) and this exchanges it, no popup involved.
     * Concurrent calls share one in-flight attempt rather than racing.
     */
    async _bridgeFirebaseIdentity() {
      if (this._bridging) return this._bridging;
      this._bridging = (async () => {
        const fb = global.FirebaseSync;
        if (!fb) return { ok: false, reason: 'error', message: 'Cloud sync is unavailable — firebase-sync.js did not load.' };
        try {
          const res = await fetch('/api/auth/firebase-token', { headers: { Accept: 'application/json' } });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const reason = res.status === 501 ? 'not-configured' : res.status === 409 ? 'stale-connection' : 'error';
            return { ok: false, reason, message: data.error };
          }
          const user = await fb.signInWithCustomToken(data.token);
          return { ok: true, user };
        } catch (err) {
          return { ok: false, reason: 'error', message: err?.message };
        } finally {
          this._bridging = null;
        }
      })();
      return this._bridging;
    }

    /**
     * Open the server OAuth flow in a popup, falling back to this tab.
     *
     * /api/google/auth answers with {url: <google auth url>} as JSON — it
     * does not redirect — so the popup has to be pointed at that JSON
     * endpoint first, read the URL out of the response, and only THEN be
     * navigated to Google. Opening the popup on the JSON endpoint directly
     * just showed the raw JSON text and never reached Google at all.
     *
     * The blank popup is opened synchronously, before the `await`, so it
     * still counts as a direct result of the click and isn't popup-blocked
     * — opening it only after an async fetch resolves would be.
     */
    async connectWorkspace() {
      const w = 520, hgt = 640;
      const left = Math.max(0, (screen.width - w) / 2);
      const top = Math.max(0, (screen.height - hgt) / 2);

      let win = null;
      try {
        win = global.open('about:blank', 'wbpro-google-oauth',
          `width=${w},height=${hgt},left=${left},top=${top},menubar=no,toolbar=no`);
      } catch { /* handled below */ }

      let data;
      try {
        const res = await fetch('/api/google/auth', { headers: { Accept: 'application/json' } });
        data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.url) throw new Error(data?.error || 'Could not start Google sign-in.');
      } catch (err) {
        win?.close();
        this._toast(err?.message || 'Could not start Google sign-in.', 'warn', 6000);
        return;
      }

      if (!win || win.closed) {
        // Popups are blocked. Same-tab navigation always works; the callback
        // page sends the browser back here when it is done.
        this._toast('Opening Google in this tab…', 'info', 2500);
        location.href = data.url;
        return;
      }

      win.location.href = data.url;
      this._toast('Approve every permission on the Google screen — skipping one leaves that panel empty.', 'info', 6000);

      // The popup is cross-origin while it is on Google, so its state cannot
      // be read; poll for it closing and then re-read the server status.
      const timer = setInterval(() => {
        if (!win.closed) return;
        clearInterval(timer);
        setTimeout(() => this.refresh({ fresh: true }), POLL_AFTER_CONNECT_MS);
      }, 600);
    }

    /* ---- Firebase half ------------------------------------------------ */

    async signIn() {
      const fb = global.FirebaseSync;
      if (!fb) {
        this._toast('Cloud sync is unavailable — firebase-sync.js did not load.', 'warn', 5000);
        return null;
      }
      // Say this before the popup rather than after it fails: the consent
      // screen appears, the user grants everything, and only then does
      // Firebase reject the origin — which reads as "I signed in and it
      // gave an OAuth error".
      if (this.signInBlockedHere) {
        this._toast(
          `Firebase will refuse sign-in from "${location.hostname}" — only localhost is on its ` +
          `authorised-domain list. Open the app at http://localhost:${location.port || 5000} ` +
          `instead, or add this host under Authentication → Settings → Authorised domains.`,
          'warn', 9000);
        return null;
      }
      try {
        const user = await fb.signInWithGoogle();
        if (user) this._toast(`Signed in as ${user.email}.`, 'success', 3000);
        return user;
      } catch (err) {
        // signInWithGoogle already explained itself. Make clear that the
        // Workspace half is unaffected, so the user knows what still works.
        if (this.workspaceConnected) {
          this._toast('Your Drive, Docs and Gmail are still connected — only cloud sync and sharing need this sign-in.', 'info', 6000);
        }
        return null;
      }
    }

    async disconnect({ workspace = true, firebase = true } = {}) {
      if (firebase && global.FirebaseSync?.isLoggedIn) {
        await global.FirebaseSync.signOutUser();
      }
      if (workspace && this.workspaceConnected) {
        try {
          await fetch('/api/google/disconnect', { method: 'POST' });
        } catch { /* the local half is already gone; report below */ }
      }
      await this.refresh({ fresh: true });
      this._toast('Disconnected from Google.', 'info', 2500);
    }

    /* ---- rendering ---------------------------------------------------- */

    _render() {
      const { loginBtn, profile, avatar, name, pill } = this.el;
      const id = this.identity;
      const state = this.state;

      if (!id) {
        loginBtn && loginBtn.classList.remove('hidden');
        profile && profile.classList.add('hidden');
        if (loginBtn) {
          const label = loginBtn.querySelector('span');
          if (label) label.textContent = 'Google Sign in';
          loginBtn.title = 'Connect Google — cloud sync plus Drive, Docs, Gmail and Calendar';
        }
        this.el.box?.setAttribute('data-google-state', 'off');
        return;
      }

      loginBtn && loginBtn.classList.add('hidden');
      profile && profile.classList.remove('hidden');
      this.el.box?.setAttribute('data-google-state', state);

      if (avatar) {
        const FALLBACK_AVATAR = 'https://www.gstatic.com/images/branding/product/1x/avatar_square_blue_512dp.png';
        // A Google profile photo URL can fail to load hotlinked (rate limits,
        // revoked sharing, transient errors) — fall back instead of leaving
        // a broken-image icon sitting where the avatar should be.
        avatar.onerror = () => { avatar.onerror = null; avatar.src = FALLBACK_AVATAR; };
        avatar.src = id.photo || FALLBACK_AVATAR;
        avatar.alt = id.name;
      }
      if (name) name.textContent = (id.name || 'You').split(' ')[0];

      if (pill) {
        const LOOK = {
          connected: ['ph-bold ph-cloud-check', 'Google connected — sync, Drive, Docs, Gmail and Calendar'],
          partial:   ['ph-bold ph-warning-circle', this._partialReason()],
          off:       ['ph-bold ph-cloud-slash', 'Not connected to Google'],
        };
        const [icon, title] = LOOK[state] || LOOK.off;
        pill.innerHTML = `<i class="${icon}"></i>`;
        pill.title = title;
        pill.dataset.state = state;
      }
    }

    _partialReason() {
      if (this.mismatch) {
        return `Two different Google accounts: ${this.firebaseUser?.email} for sync, ` +
               `${this.workspaceProfile?.email} for Drive. Sign out and connect once.`;
      }
      if (!this.workspaceConfigured) return 'Drive, Docs and Gmail are not configured on the server.';
      if (!this.workspaceConnected)  return 'Signed in, but Drive, Docs and Gmail are not connected yet.';
      if (this.workspaceStale)       return 'Connected before some permissions were added — reconnect to grant them.';
      if (!this.signedIn)            return 'Drive is connected, but cloud sync and sharing need a sign-in.';
      return 'Partly connected.';
    }

    /** The dropdown is rebuilt on open so it always states the live position. */
    _renderMenu() {
      const { menu, menuName, menuMail } = this.el;
      if (!menu) return;
      const id = this.identity;
      if (menuName) menuName.textContent = id?.name || 'You';
      if (menuMail) menuMail.textContent = id?.email || '';

      let rows = menu.querySelector('.google-account-rows');
      if (!rows) {
        rows = document.createElement('div');
        rows.className = 'google-account-rows';
        menu.querySelector('.user-menu-divider')?.after(rows);
      }
      rows.textContent = '';

      const row = (ok, label, detail, action) => {
        const el = document.createElement(action ? 'button' : 'div');
        el.className = 'google-account-row' + (ok ? ' is-ok' : ' is-off');
        if (action) { el.type = 'button'; el.addEventListener('click', e => { e.stopPropagation(); menu.classList.add('hidden'); action(); }); }
        el.innerHTML =
          `<i class="ph-bold ${ok ? 'ph-check-circle' : 'ph-warning-circle'}"></i>` +
          `<span><strong>${label}</strong><small>${detail}</small></span>`;
        rows.appendChild(el);
      };

      row(this.signedIn, 'Cloud sync & sharing',
        this.signedIn ? 'Signed in' : 'Sign in to sync boards and invite people',
        this.signedIn ? null : () => this.connect());

      const wsOk = this.workspaceConnected && !this.workspaceStale;
      row(wsOk, 'Drive, Docs, Gmail, Calendar',
        !this.workspaceConfigured ? 'Not configured on the server'
          : !this.workspaceConnected ? 'Connect to attach files to the board'
          : this.workspaceStale ? 'Reconnect to grant the added permissions'
          : 'Connected',
        (this.workspaceConfigured && !wsOk) ? () => this.connectWorkspace() : null);

      if (this.mismatch) {
        const warn = document.createElement('div');
        warn.className = 'google-account-row is-off';
        warn.innerHTML = `<i class="ph-bold ph-warning-circle"></i><span><strong>Two accounts</strong>` +
          `<small>${this._partialReason()}</small></span>`;
        rows.appendChild(warn);
      }
    }

    /**
     * Whether Firebase can sign in from where the page is being served.
     *
     * Firebase authorises `localhost` out of the box and nothing else on
     * loopback, so the identical app on 127.0.0.1 fails with
     * auth/unauthorized-domain. The server now folds every loopback alias
     * onto one canonical host, which makes this unreachable in the normal
     * case — but a LAN address is deliberately left alone, and there the
     * check still earns its place by explaining the failure before the user
     * hits it.
     */
    get signInBlockedHere() {
      const h = location.hostname;
      return !(h === 'localhost' || h.endsWith('.firebaseapp.com') || h.endsWith('.web.app'));
    }

    _toast(msg, kind = 'info', ms = 3000) {
      if (global.Modal?.toast) global.Modal.toast(msg, kind, ms);
      else if (global.PMUI?.toast) global.PMUI.toast(msg, kind, ms);
      else console.info('[google-account]', msg);
    }
  }

  function boot() {
    if (!document.getElementById('auth-box')) return;   // not the board page
    try {
      global.GoogleAccount = new GoogleAccount();
    } catch (err) {
      console.error('[google-account] failed to start; the original button still works', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
