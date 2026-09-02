/* ================================================================
   firebase-sync.js — Firebase Authentication, Cloud Sync & SHA-256 Encryption
   ================================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithCustomToken,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  writeBatch,
  arrayUnion,
  arrayRemove,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

// Your web app\'s Firebase configuration
const firebaseConfig = {
  apiKey: 'AIzaSyAxeZ1PuZc055l1QKSeZbcuhvOLzCGYwcI',
  authDomain: 'project-board-1ee28.firebaseapp.com',
  projectId: 'project-board-1ee28',
  storageBucket: 'project-board-1ee28.firebasestorage.app',
  messagingSenderId: '899608025224',
  appId: '1:899608025224:web:04d0cc494ad51bee11a73d',
  measurementId: 'G-B43C30V8V3'
};

// Initialize Firebase App & Services
const fbApp = initializeApp(firebaseConfig);
const analytics = getAnalytics(fbApp);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/* ================================================================
   SHA-256 HASHING & ENCRYPTION ENGINE
   ================================================================ */
export class CryptoEngine {
  /**
   * Compute a secure SHA-256 hash string for any text, object, or board state.
   */
  static async sha256(data) {
    const raw = typeof data === 'object' ? JSON.stringify(data) : String(data);
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Derive an AES-GCM 256-bit encryption key using PBKDF2 with SHA-256.
   */
  static async deriveKey(secret, salt = 'whiteboard-pro-secure-salt') {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt data with AES-GCM and sign with SHA-256.
   */
  static async encrypt(data, secretKey) {
    if (!secretKey) return data;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(secretKey);
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );
    const hash = await this.sha256(data);
    return {
      _encrypted: true,
      iv: Array.from(iv),
      cipher: Array.from(new Uint8Array(cipherBuffer)),
      hash
    };
  }

  /**
   * Decrypt AES-GCM data and verify SHA-256 integrity.
   */
  static async decrypt(payload, secretKey) {
    if (!payload || !payload._encrypted || !payload.cipher || !payload.iv) {
      return payload;
    }
    const key = await this.deriveKey(secretKey);
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(payload.iv) },
      key,
      new Uint8Array(payload.cipher)
    );
    const decoded = JSON.parse(new TextDecoder().decode(decryptedBuffer));
    if (payload.hash) {
      const computedHash = await this.sha256(decoded);
      if (computedHash !== payload.hash) {
        console.warn('⚠️ SHA-256 checksum mismatch! Data may have been tampered with.');
      }
    }
    return decoded;
  }
}

/* ================================================================
   FIREBASE SYNC CONTROLLER
   ================================================================ */
export class FirebaseSync {
  constructor() {
    this.auth = auth;
    this.db = db;
    this.currentUser = null;
    this.isSyncing = false;
    this._listeners = new Set();

    /**
     * Resolves once Firebase has reported the *initial* auth state — signed
     * in or definitively not. Anything that decides "is this board mine to
     * load from the cloud?" has to wait for this: onAuthStateChanged is
     * asynchronous, so at page-load `isLoggedIn` is still false even for a
     * signed-in user, and acting on that reads a shared board as missing.
     */
    this.authReady = new Promise(resolve => { this._resolveAuthReady = resolve; });

    this._initAuthListener();
    this._bindDOM();
  }

  get isLoggedIn() {
    return !!this.currentUser;
  }

  get user() {
    return this.currentUser;
  }

  onUserChange(fn) {
    this._listeners.add(fn);
    if (this.currentUser) fn(this.currentUser);
    return () => this._listeners.delete(fn);
  }

  _notify(user) {
    this._listeners.forEach(fn => {
      try { fn(user); } catch (e) { console.error(e); }
    });
  }

  _initAuthListener() {
    onAuthStateChanged(this.auth, user => {
      this.currentUser = user;
      this._resolveAuthReady?.(user);
      this._resolveAuthReady = null;
      this._updateUI(user);
      this._notify(user);

      if (user) {
        // Record login profile in Firestore
        const userRef = doc(this.db, 'users', user.uid);
        setDoc(userRef, {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
          lastLogin: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('User profile sync:', err));

        if (window.Modal && window.Modal.toast) {
          window.Modal.toast('Signed in as ' + (user.displayName || user.email), 'success', 2500);
        }
      }
    });
  }

  /**
   * Why this is not just `signInWithPopup`.
   *
   * The popup call fails for several unrelated reasons, and the old code
   * reported all of them as one opaque toast — which is why "the Google
   * login on the whiteboard does not work" was impossible to act on. Each
   * cause now names itself and, where there is a way through, takes it:
   *
   *   popup-blocked / popup-closed  → retry as a full-page redirect
   *   unauthorized-domain           → this origin is not on Firebase's
   *                                   authorised-domain list
   *   operation-not-allowed         → the Google provider is switched off
   *                                   in the Firebase console
   */
  async signInWithGoogle({ allowRedirect = true } = {}) {
    try {
      const result = await signInWithPopup(this.auth, googleProvider);
      return result.user;
    } catch (err) {
      const code = err?.code || '';
      const RETRY_AS_REDIRECT = new Set([
        'auth/popup-blocked',
        'auth/popup-closed-by-user',
        'auth/cancelled-popup-request',
        'auth/operation-not-supported-in-this-environment',
      ]);

      if (allowRedirect && RETRY_AS_REDIRECT.has(code)) {
        // The browser refused the popup. A redirect needs no popup at all.
        try {
          sessionStorage.setItem('wbpro.authRedirect', '1');
          await signInWithRedirect(this.auth, googleProvider);
          return null;                     // the page navigates away here
        } catch (redirectErr) {
          console.error('Google redirect sign-in failed:', redirectErr);
          err = redirectErr;
        }
      }

      const detail = FirebaseSync.explainAuthError(err);
      console.error('Google Sign-In Error:', err?.code, err?.message);
      if (window.Modal && window.Modal.toast) {
        window.Modal.toast(detail.message, 'warn', 7000);
      }
      throw Object.assign(err instanceof Error ? err : new Error(detail.message), { detail });
    }
  }

  /**
   * Sign into Firebase using a custom token minted server-side from the
   * already-connected Google Workspace account (see google-account.js and
   * /api/auth/firebase-token in app.py) — no popup, no second consent
   * screen. This is now the primary path; signInWithGoogle() above stays as
   * a direct-Firebase fallback for anyone who hasn't connected Workspace.
   */
  async signInWithCustomToken(token) {
    const result = await signInWithCustomToken(this.auth, token);
    return result.user;
  }

  /** Turn a Firebase auth error code into something a person can act on. */
  static explainAuthError(err) {
    const code = err?.code || '';
    const host = location.hostname || 'this domain';
    const TABLE = {
      'auth/unauthorized-domain': {
        message: `Firebase is refusing sign-in from "${host}". Add it under Authentication → Settings → Authorised domains.`,
        fix: 'https://console.firebase.google.com/project/project-board-1ee28/authentication/settings',
      },
      'auth/operation-not-allowed': {
        message: 'Google sign-in is switched off for this Firebase project. Enable it under Authentication → Sign-in method → Google.',
        fix: 'https://console.firebase.google.com/project/project-board-1ee28/authentication/providers',
      },
      'auth/popup-blocked': {
        message: 'Your browser blocked the sign-in popup. Allow popups for this site, or try again to use a full-page redirect.',
        fix: null,
      },
      'auth/popup-closed-by-user': {
        message: 'The sign-in window was closed before it finished.',
        fix: null,
      },
      'auth/network-request-failed': {
        message: 'Could not reach Google. Check the network connection and try again.',
        fix: null,
      },
      'auth/internal-error': {
        message: 'Firebase rejected the sign-in. This is usually an API key restricted to other domains, or the Identity Toolkit API being disabled.',
        fix: 'https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com',
      },
    };
    return TABLE[code] || {
      message: err?.message || 'Google sign-in failed.',
      fix: null,
    };
  }

  /**
   * Collect the result of a redirect sign-in on the way back in. Safe to
   * call unconditionally — it resolves to null when there was no redirect.
   */
  async completeRedirect() {
    if (!sessionStorage.getItem('wbpro.authRedirect')) return null;
    sessionStorage.removeItem('wbpro.authRedirect');
    try {
      const result = await getRedirectResult(this.auth);
      return result?.user || null;
    } catch (err) {
      const detail = FirebaseSync.explainAuthError(err);
      console.error('Google redirect result:', err?.code, err?.message);
      if (window.Modal && window.Modal.toast) window.Modal.toast(detail.message, 'warn', 7000);
      return null;
    }
  }

  async signOutUser() {
    try {
      await signOut(this.auth);
      if (window.Modal && window.Modal.toast) {
        window.Modal.toast('Signed out from Google', 'info', 2000);
      }
    } catch (err) {
      console.error('Sign Out Error:', err);
    }
  }

  /* ---- Cloud Storage CRUD with SHA-256 Integrity ---- */

  async saveBoard(boardData) {
    if (!this.currentUser) {
      return { success: false, reason: 'unauthenticated' };
    }

    this.isSyncing = true;
    this._setSyncStatus('Saving to Firebase Cloud…', 'syncing');

    try {
      const uid = this.currentUser.uid;
      const boardId = boardData.id || ('board-' + Date.now());
      boardData.id = boardId;

      // Compute SHA-256 checksum of user input and board state
      const dataHash = await CryptoEngine.sha256(boardData);

      const payload = {
        id: boardId,
        name: boardData.name || 'Untitled Board',
        ownerId: uid,
        ownerEmail: this.currentUser.email,
        ownerName: this.currentUser.displayName || 'User',
        data: JSON.stringify(boardData),
        dataHash: dataHash,
        elementCount: (boardData.elements ? boardData.elements.length : 0) + (boardData.strokes ? boardData.strokes.length : 0),
        updatedAt: serverTimestamp(),
        createdAt: boardData.created_at || new Date().toISOString()
      };

      // Save to user\'s private collection and main boards index
      const userBoardRef = doc(this.db, 'users', uid, 'boards', boardId);
      const publicBoardRef = doc(this.db, 'boards', boardId);

      await Promise.all([
        setDoc(userBoardRef, payload, { merge: true }),
        setDoc(publicBoardRef, payload, { merge: true })
      ]);

      this._setSyncStatus('Synced with Firebase Cloud · ' + new Date().toLocaleTimeString(), 'ok');
      return { success: true, boardId, dataHash };
    } catch (err) {
      console.error('Firebase save error:', err);
      this._setSyncStatus('Cloud sync failed — saved locally', 'warn');
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  async loadBoard(boardId) {
    if (!this.currentUser) return null;

    try {
      const uid = this.currentUser.uid;
      let snap = await getDoc(doc(this.db, 'users', uid, 'boards', boardId));
      if (!snap.exists()) {
        snap = await getDoc(doc(this.db, 'boards', boardId));
      }
      if (!snap.exists()) return null;

      const record = snap.data();
      const rawData = typeof record.data === 'string' ? JSON.parse(record.data) : record.data;

      // Verify SHA-256 Checksum
      if (record.dataHash) {
        const verifyHash = await CryptoEngine.sha256(rawData);
        if (verifyHash === record.dataHash) {
          console.info('🔒 SHA-256 Checksum Verified: Board integrity intact.');
        } else {
          console.warn('⚠️ SHA-256 Checksum mismatch during load!');
        }
      }

      return {
        ...rawData,
        _cloudHash: record.dataHash,
        _updatedAt: record.updatedAt
      };
    } catch (err) {
      console.error('Firebase load error:', err);
      return null;
    }
  }

  async listBoards() {
    if (!this.currentUser) return [];

    try {
      const uid = this.currentUser.uid;
      const q = query(
        collection(this.db, 'users', uid, 'boards')
      );
      const querySnap = await getDocs(q);
      const boards = [];

      querySnap.forEach(docSnap => {
        const b = docSnap.data();
        boards.push({
          id: b.id,
          name: b.name || 'Untitled Board',
          element_count: b.elementCount || 0,
          updated_at: (b.updatedAt && b.updatedAt.toDate) ? b.updatedAt.toDate().toISOString() : (b.createdAt || new Date().toISOString()),
          dataHash: b.dataHash,
          isCloud: true
        });
      });

      boards.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      return boards;
    } catch (err) {
      console.error('Firebase list error:', err);
      return [];
    }
  }

  async deleteBoard(boardId) {
    if (!this.currentUser) return false;

    try {
      const uid = this.currentUser.uid;
      await Promise.all([
        deleteDoc(doc(this.db, 'users', uid, 'boards', boardId)),
        deleteDoc(doc(this.db, 'boards', boardId)).catch(() => {})
      ]);
      return true;
    } catch (err) {
      console.error('Firebase delete error:', err);
      return false;
    }
  }

  /* ---- UI Wiring ---- */

  _bindDOM() {
    const loginBtn = document.getElementById('google-login-btn');
    const logoutBtn = document.getElementById('user-logout-btn');
    const profileWrap = document.getElementById('user-profile');
    const userMenu = document.getElementById('user-menu-dropdown');
    const userBoardsBtn = document.getElementById('user-boards-btn');
    const userSyncBtn = document.getElementById('user-sync-btn');

    // google-account.js unifies this button with the server-side Workspace
    // connection and claims it when it loads. This binding stays as the
    // fallback so sign-in still works if that file is missing or throws.
    loginBtn && loginBtn.addEventListener('click', () => {
      if (window.GoogleAccount?.ownsAuthButton) return;
      this.signInWithGoogle();
    });
    logoutBtn && logoutBtn.addEventListener('click', () => {
      userMenu && userMenu.classList.add('hidden');
      if (window.GoogleAccount?.ownsAuthButton) return;
      this.signOutUser();
    });

    profileWrap && profileWrap.addEventListener('click', e => {
      e.stopPropagation();
      userMenu && userMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      userMenu && userMenu.classList.add('hidden');
    });

    userBoardsBtn && userBoardsBtn.addEventListener('click', () => {
      userMenu && userMenu.classList.add('hidden');
      if (window.app && window.app.library) window.app.library.open();
    });

    userSyncBtn && userSyncBtn.addEventListener('click', () => {
      userMenu && userMenu.classList.add('hidden');
      if (window.app) {
        window.app.save({ server: true });
        if (window.Modal && window.Modal.toast) {
          window.Modal.toast('Syncing board with Firebase Cloud…', 'info', 1500);
        }
      }
    });
  }

  _updateUI(user) {
    // google-account.js renders the same header from *both* halves of the
    // Google connection. If it is running, this method would fight it: it
    // knows only about Firebase, so it would hide the profile whenever
    // Firebase was signed out — even with Drive and Gmail fully connected.
    if (window.GoogleAccount?.ownsAuthButton) return;

    const loginBtn = document.getElementById('google-login-btn');
    const profileWrap = document.getElementById('user-profile');
    const avatar = document.getElementById('user-avatar');
    const nameSpan = document.getElementById('user-name');
    const menuName = document.getElementById('user-menu-name');
    const menuEmail = document.getElementById('user-menu-email');

    if (user) {
      loginBtn && loginBtn.classList.add('hidden');
      profileWrap && profileWrap.classList.remove('hidden');
      if (avatar) {
        const fallback = 'https://www.gstatic.com/images/branding/product/1x/avatar_square_blue_512dp.png';
        avatar.onerror = () => { avatar.onerror = null; avatar.src = fallback; };
        avatar.src = user.photoURL || fallback;
      }
      if (nameSpan) nameSpan.textContent = (user.displayName ? user.displayName.split(' ')[0] : 'User');
      if (menuName) menuName.textContent = user.displayName || 'User';
      if (menuEmail) menuEmail.textContent = user.email || '';
    } else {
      loginBtn && loginBtn.classList.remove('hidden');
      profileWrap && profileWrap.classList.add('hidden');
    }
  }

  _setSyncStatus(text, kind = '') {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'save-status ' + kind;
  }
}

/* ================================================================
   BRIDGE FOR NON-MODULE SCRIPTS

   Everything else in this app is a classic <script>, which cannot use
   `import`. Rather than convert the whole codebase to modules (and
   change its load order semantics), this file — the one module in the
   build — re-exports the Firestore primitives on `window.FB` so the
   project-management layer can talk to Firestore directly.

   Load-order note: modules are deferred, so this runs *after* every
   classic script has parsed. Nothing may read `window.FB` at parse
   time; wait for the `firebase-ready` event below.
   ================================================================ */
window.FB = {
  app: fbApp, auth, db, analytics, googleProvider,
  doc, setDoc, updateDoc, getDoc, getDocs, deleteDoc,
  collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, arrayUnion, arrayRemove, serverTimestamp,
};

// Instantiate and expose globally
const firebaseSyncInstance = new FirebaseSync();
window.FirebaseSync = firebaseSyncInstance;
window.CryptoEngine = CryptoEngine;

// A redirect sign-in lands back here on a fresh page load; pick the result up
// before anything asks whether we are signed in.
firebaseSyncInstance.completeRedirect().catch(() => {});

window.dispatchEvent(new CustomEvent('firebase-ready', { detail: { fb: window.FB } }));
