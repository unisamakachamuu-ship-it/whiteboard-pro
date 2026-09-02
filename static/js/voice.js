/* ================================================================
   voice.js — live voice channel for a board
   ----------------------------------------------------------------
   Talking while you draw, without leaving the board for a separate
   call. Audio goes peer-to-peer over WebRTC; only the handshake
   (who is here, SDP offers/answers, ICE candidates) travels through
   Firestore, which is already the transport everything else here
   uses and needs no extra service to stand up.

   Topology is a full mesh: every participant holds one connection to
   every other. That is the right shape for the handful of people who
   fit around one board — no media server to run, no relay hop to add
   latency — and it is why the participant list is capped rather than
   left open-ended.

   Who calls whom matters. Both sides of a pair discovering each other
   simultaneously and both sending an offer is the classic way a mesh
   deadlocks ("glare"), so the rule here is that the lexicographically
   smaller peer id always makes the offer and the larger one always
   answers. It needs no negotiation of its own and both sides reach
   the same conclusion independently.

   A phone can join this channel on its own, from /voice/<boardId>,
   for the very common case of a desktop with no usable microphone.
   It is a full participant, not a companion device — which keeps it
   simple, and means a phone works even when nothing else does.
   ================================================================ */

(function (global) {
  'use strict';

  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  // A mesh is n*(n-1) connections. Past a handful that stops being
  // kind to CPU and uplink, and the honest thing is to say so rather
  // than let the audio quietly fall apart.
  const MAX_PEERS = 8;

  // Presence rows go stale when a tab is killed rather than closed.
  const HEARTBEAT_MS = 4000;
  const STALE_MS = 15000;

  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
    return n;
  };

  const toast = (m, k = 'info', ms = 3500) =>
    (global.Modal?.toast || global.PMUI?.toast || (x => console.info(x)))(m, k, ms);

  class VoiceChannel {
    /**
     * @param {object} opts
     * @param {string} opts.boardId   room to join
     * @param {object} opts.me        { id, name, color }
     * @param {boolean} [opts.headless] no floating UI (the phone page draws its own)
     */
    constructor({ boardId, me, headless = false }) {
      this.boardId = boardId;
      this.me = me;
      this.headless = headless;

      this.joined = false;
      this.muted = false;
      this.stream = null;
      this.peers = new Map();      // peerId -> { pc, audio, name, color, level }
      this.roster = new Map();     // peerId -> presence row
      this._unsubs = [];
      this._timers = [];
      this._watchers = new Set();

      this._fb = global.FB || null;
      if (!this.headless) this._buildUI();
    }

    onChange(fn) { this._watchers.add(fn); fn(this); return () => this._watchers.delete(fn); }
    _emit() { for (const fn of this._watchers) { try { fn(this); } catch (e) { console.error(e); } } }

    get participantCount() { return this.peers.size + (this.joined ? 1 : 0); }

    /* ---- lifecycle ---------------------------------------------------- */

    async join() {
      if (this.joined) return true;
      const FB = this._fb || global.FB;
      if (!FB) { toast('Voice needs cloud sync, which has not loaded yet.', 'warn'); return false; }
      this._fb = FB;

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      } catch (err) {
        this._explainMicFailure(err);
        return false;
      }

      this.joined = true;
      this._meterLocal();

      const { db, doc, collection } = FB;
      this._roomRef = collection(db, 'boards', this.boardId, 'voice');
      this._meRef = doc(this._roomRef, this.me.id);
      this._signalsRef = collection(db, 'boards', this.boardId, 'voiceSignals');

      await this._announce();
      this._watchRoster();
      this._watchSignals();

      this._timers.push(setInterval(() => this._announce(), HEARTBEAT_MS));
      this._timers.push(setInterval(() => this._reap(), HEARTBEAT_MS));

      // A closed tab should not leave a ghost in the room.
      this._onUnload = () => this.leave({ quick: true });
      global.addEventListener('beforeunload', this._onUnload);

      this._render();
      this._emit();
      return true;
    }

    async leave({ quick = false } = {}) {
      if (!this.joined) return;
      this.joined = false;

      for (const [, p] of this.peers) this._teardownPeer(p);
      this.peers.clear();

      this.stream?.getTracks().forEach(t => t.stop());
      this.stream = null;

      for (const un of this._unsubs) { try { un(); } catch (_) {} }
      this._unsubs = [];
      for (const t of this._timers) clearInterval(t);
      this._timers = [];
      if (this._levelRaf) cancelAnimationFrame(this._levelRaf);
      this._levelRaf = null;
      try { this._audioCtx?.close(); } catch (_) {}
      this._audioCtx = null;

      global.removeEventListener('beforeunload', this._onUnload || (() => {}));

      const FB = this._fb;
      if (FB && this._meRef) {
        // On unload there is no time to await anything; fire and hope.
        FB.deleteDoc(this._meRef).catch(() => {});
        if (!quick) await this._clearMySignals().catch(() => {});
      }

      this._render();
      this._emit();
    }

    toggleMute() {
      this.muted = !this.muted;
      for (const track of this.stream?.getAudioTracks() || []) track.enabled = !this.muted;
      this._render();
      this._emit();
      return this.muted;
    }

    _explainMicFailure(err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        toast('Microphone permission was refused. Allow it in the address bar, then join again.', 'warn', 7000);
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        toast('No microphone found on this device. Use "Join from phone" to talk through your phone instead.', 'warn', 8000);
      } else if (!global.isSecureContext) {
        toast('Browsers only allow microphone access over HTTPS or on localhost. Open the board at localhost, or put it behind HTTPS.', 'warn', 9000);
      } else {
        toast('Could not open the microphone: ' + (err?.message || name || 'unknown error'), 'warn', 7000);
      }
    }

    /* ---- presence ------------------------------------------------------ */

    async _announce() {
      const FB = this._fb;
      if (!FB || !this._meRef) return;
      try {
        await FB.setDoc(this._meRef, {
          name: this.me.name || 'Someone',
          color: this.me.color || '#4262ff',
          muted: !!this.muted,
          kind: this.headless ? 'phone' : 'desktop',
          seenAt: Date.now(),
        }, { merge: true });
      } catch (err) {
        console.warn('[voice] presence write failed', err);
      }
    }

    _watchRoster() {
      const FB = this._fb;
      this._unsubs.push(FB.onSnapshot(this._roomRef, snap => {
        const live = new Map();
        snap.forEach(d => {
          const row = d.data() || {};
          if (Date.now() - (row.seenAt || 0) > STALE_MS) return;
          live.set(d.id, row);
        });
        this.roster = live;

        for (const [id, row] of live) {
          if (id === this.me.id) continue;
          if (this.peers.has(id)) {
            const p = this.peers.get(id);
            p.name = row.name; p.color = row.color; p.remoteMuted = !!row.muted;
            continue;
          }
          if (this.peers.size + 1 >= MAX_PEERS) {
            toast(`Voice is limited to ${MAX_PEERS} people at once.`, 'warn', 5000);
            break;
          }
          this._connectTo(id, row);
        }

        // Anyone who left the roster should stop being connected to.
        for (const [id, p] of [...this.peers]) {
          if (!live.has(id)) { this._teardownPeer(p); this.peers.delete(id); }
        }

        this._render();
        this._emit();
      }, err => console.warn('[voice] roster listener', err)));
    }

    _reap() {
      let changed = false;
      for (const [id, p] of [...this.peers]) {
        const row = this.roster.get(id);
        if (!row || Date.now() - (row.seenAt || 0) > STALE_MS) {
          this._teardownPeer(p);
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) { this._render(); this._emit(); }
    }

    /* ---- signalling ----------------------------------------------------- */

    /** Deterministic and symmetric: both ends agree without asking. */
    _isOfferer(otherId) { return String(this.me.id) < String(otherId); }

    async _signal(to, payload) {
      const FB = this._fb;
      try {
        await FB.setDoc(FB.doc(this._signalsRef, `${this.me.id}__${to}__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`), {
          from: this.me.id, to, at: Date.now(), ...payload,
        });
      } catch (err) {
        console.warn('[voice] signal write failed', err);
      }
    }

    _watchSignals() {
      const FB = this._fb;
      const q = FB.query(this._signalsRef, FB.where('to', '==', this.me.id));
      this._unsubs.push(FB.onSnapshot(q, snap => {
        snap.docChanges().forEach(async ch => {
          if (ch.type !== 'added') return;
          const msg = ch.doc.data() || {};
          // Consumed once; the room would otherwise accumulate handshake
          // litter that replays on the next join.
          FB.deleteDoc(ch.doc.ref).catch(() => {});
          if (Date.now() - (msg.at || 0) > 60000) return;
          try { await this._handleSignal(msg); }
          catch (err) { console.warn('[voice] signal handling failed', err); }
        });
      }, err => console.warn('[voice] signal listener', err)));
    }

    async _handleSignal(msg) {
      const from = msg.from;
      if (!from || from === this.me.id) return;

      let p = this.peers.get(from);
      if (!p) {
        const row = this.roster.get(from) || {};
        p = this._createPeer(from, row);
      }

      if (msg.sdp) {
        const desc = new RTCSessionDescription(msg.sdp);
        if (desc.type === 'offer') {
          await p.pc.setRemoteDescription(desc);
          await this._drainPendingIce(p);
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          await this._signal(from, { sdp: { type: answer.type, sdp: answer.sdp } });
        } else if (desc.type === 'answer') {
          if (p.pc.signalingState === 'have-local-offer') {
            await p.pc.setRemoteDescription(desc);
            await this._drainPendingIce(p);
          }
        }
      }

      if (msg.ice) {
        const candidate = new RTCIceCandidate(msg.ice);
        // ICE can outrun the description it belongs to; hold it rather
        // than throwing it away, or the connection silently never forms.
        if (p.pc.remoteDescription && p.pc.remoteDescription.type) {
          await p.pc.addIceCandidate(candidate).catch(err => console.warn('[voice] ice add', err));
        } else {
          p.pendingIce.push(candidate);
        }
      }
    }

    async _drainPendingIce(p) {
      while (p.pendingIce.length) {
        const c = p.pendingIce.shift();
        await p.pc.addIceCandidate(c).catch(err => console.warn('[voice] ice drain', err));
      }
    }

    /* ---- peer connections ------------------------------------------------ */

    _createPeer(id, row) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const audio = new Audio();
      audio.autoplay = true;
      audio.playsInline = true;

      const p = {
        id, pc, audio,
        name: row.name || 'Someone',
        color: row.color || '#4262ff',
        remoteMuted: !!row.muted,
        level: 0,
        state: 'connecting',
        pendingIce: [],
      };
      this.peers.set(id, p);

      for (const track of this.stream?.getTracks() || []) pc.addTrack(track, this.stream);

      pc.onicecandidate = e => {
        if (e.candidate) this._signal(id, { ice: e.candidate.toJSON() });
      };

      pc.ontrack = e => {
        p.remoteStream = e.streams[0];
        audio.srcObject = e.streams[0];
        // Autoplay policies block this until the page has been interacted
        // with; joining is itself a click, so this normally just works.
        audio.play().catch(err => console.warn('[voice] playback blocked', err));
        this._meterRemote(p);
        this._render();
      };

      pc.onconnectionstatechange = () => {
        p.state = pc.connectionState;
        if (pc.connectionState === 'failed') {
          // Almost always a NAT that plain STUN cannot punch through.
          console.warn('[voice] connection to', id, 'failed');
        }
        this._render();
        this._emit();
      };

      return p;
    }

    async _connectTo(id, row) {
      const p = this._createPeer(id, row);
      if (!this._isOfferer(id)) return;   // they will call us
      try {
        const offer = await p.pc.createOffer({ offerToReceiveAudio: true });
        await p.pc.setLocalDescription(offer);
        await this._signal(id, { sdp: { type: offer.type, sdp: offer.sdp } });
      } catch (err) {
        console.warn('[voice] offer failed', err);
      }
    }

    _teardownPeer(p) {
      try { p.pc.close(); } catch (_) {}
      try { p.audio.pause(); p.audio.srcObject = null; } catch (_) {}
      if (p.analyserRaf) cancelAnimationFrame(p.analyserRaf);
    }

    async _clearMySignals() {
      const FB = this._fb;
      try {
        const q = FB.query(this._signalsRef, FB.where('from', '==', this.me.id));
        const snap = await FB.getDocs(q);
        snap.forEach(d => FB.deleteDoc(d.ref).catch(() => {}));
      } catch (_) { /* best effort */ }
    }

    /* ---- speaking indicators --------------------------------------------- */

    _ctx() {
      if (!this._audioCtx) {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return null;
        this._audioCtx = new Ctx();
      }
      return this._audioCtx;
    }

    /** Cheap RMS meter — enough to light up "who is talking". */
    _attachMeter(stream, onLevel) {
      const ctx = this._ctx();
      if (!ctx || !stream) return null;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let raf = null;
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    _meterLocal() {
      this._stopLocalMeter?.();
      this._stopLocalMeter = this._attachMeter(this.stream, lvl => {
        this.myLevel = this.muted ? 0 : lvl;
        this._paintLevels();
      });
    }

    _meterRemote(p) {
      p.stopMeter?.();
      p.stopMeter = this._attachMeter(p.remoteStream, lvl => {
        p.level = lvl;
        this._paintLevels();
      });
    }

    /* ---- UI ---------------------------------------------------------------- */

    _buildUI() {
      this.root = el('div', { class: 'voice-bar hidden' });
      document.body.appendChild(this.root);
    }

    _paintLevels() {
      if (!this.root) return;
      const set = (id, lvl) => {
        const n = this.root.querySelector(`[data-voice-chip="${CSS.escape(String(id))}"]`);
        if (n) n.classList.toggle('is-talking', lvl > 0.12);
      };
      set(this.me.id, this.myLevel || 0);
      for (const [id, p] of this.peers) set(id, p.level || 0);
    }

    _render() {
      if (!this.root) return;
      this.root.classList.toggle('hidden', !this.joined);
      if (!this.joined) { this.root.textContent = ''; return; }

      this.root.textContent = '';

      const chip = (id, name, color, opts = {}) => el('span', {
        class: 'voice-chip' + (opts.muted ? ' is-muted' : '') + (opts.pending ? ' is-pending' : ''),
        style: { background: color },
        title: opts.title || name,
        'data-voice-chip': id,
      }, [
        el('span', { class: 'voice-chip-initial', text: (name || '?')[0].toUpperCase() }),
        opts.muted ? el('i', { class: 'ph-fill ph-microphone-slash voice-chip-mute' }) : null,
      ]);

      this.root.append(el('span', { class: 'voice-label' }, [
        el('i', { class: 'ph-fill ph-waveform' }),
        el('span', { text: `Voice · ${this.participantCount}` }),
      ]));

      this.root.append(chip(this.me.id, this.me.name, this.me.color, {
        muted: this.muted, title: `${this.me.name} (you)`,
      }));
      for (const [id, p] of this.peers) {
        this.root.append(chip(id, p.name, p.color, {
          muted: p.remoteMuted,
          pending: p.state !== 'connected',
          title: p.state === 'connected' ? p.name : `${p.name} — connecting…`,
        }));
      }

      const muteBtn = el('button', {
        type: 'button', class: 'voice-btn' + (this.muted ? ' is-on' : ''),
        title: this.muted ? 'Unmute (you are muted)' : 'Mute your microphone',
        onclick: () => this.toggleMute(),
      });
      muteBtn.innerHTML = `<i class="ph-fill ${this.muted ? 'ph-microphone-slash' : 'ph-microphone'}"></i>`;
      this.root.append(muteBtn);

      const phoneBtn = el('button', {
        type: 'button', class: 'voice-btn', title: 'Talk from your phone instead',
        onclick: () => global.VoicePhoneLink?.open(this.boardId),
      });
      phoneBtn.innerHTML = '<i class="ph ph-device-mobile"></i>';
      this.root.append(phoneBtn);

      const leaveBtn = el('button', {
        type: 'button', class: 'voice-btn is-leave', title: 'Leave the voice channel',
        onclick: () => this.leave(),
      });
      leaveBtn.innerHTML = '<i class="ph-fill ph-phone-x"></i>';
      this.root.append(leaveBtn);
    }
  }

  global.VoiceChannel = VoiceChannel;
})(window);
