/* ================================================================
   voice-boot.js — wires the voice channel to the board UI
   ----------------------------------------------------------------
   Kept apart from voice.js so the phone page can load the channel
   itself without dragging in any of the board's chrome.
   ================================================================ */

(function (global) {
  'use strict';

  const PEER_COLORS = ['#4262ff', '#e8618c', '#00b894', '#f39c12', '#9b59b6', '#00a8b5', '#e74c3c', '#5a6acf'];

  const toast = (m, k = 'info', ms = 3500) =>
    (global.Modal?.toast || (x => console.info(x)))(m, k, ms);

  /** Who this browser is in the room. Reuses the signed-in identity when
   *  there is one, so a person shows up under their real name. */
  function identity() {
    const fb = global.FirebaseSync;
    if (fb?.isLoggedIn) {
      const u = fb.user;
      return {
        id: u.uid,
        name: u.displayName || u.email || 'Someone',
        color: PEER_COLORS[[...u.uid].reduce((s, c) => s + c.charCodeAt(0), 0) % PEER_COLORS.length],
      };
    }
    let id = null;
    try { id = sessionStorage.getItem('wbpro.voice.anonId'); } catch (_) {}
    if (!id) {
      id = 'guest-' + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem('wbpro.voice.anonId', id); } catch (_) {}
    }
    return { id, name: 'Guest', color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] };
  }

  /* ---- "talk from your phone" -------------------------------------------- */

  const VoicePhoneLink = {
    /**
     * The phone has to reach this machine over the network, and
     * "localhost" on a phone means the phone. Offer the LAN address the
     * server reports instead, since that is the one that can actually
     * resolve from another device.
     */
    async _url(boardId) {
      let host = location.host;
      try {
        const res = await fetch('/api/network/hosts', { headers: { Accept: 'application/json' } });
        if (res.ok) {
          const data = await res.json();
          const lan = (data.hosts || []).find(h => h.lan);
          if (lan) host = `${lan.host}:${lan.port}`;
        }
      } catch (_) { /* fall back to whatever this page is on */ }
      return `${location.protocol}//${host}/voice/${encodeURIComponent(boardId)}`;
    },

    async open(boardId) {
      boardId = boardId || global.app?.store?.state?.id;
      if (!boardId) { toast('Open or save a board first.', 'warn'); return; }
      const url = await this._url(boardId);

      const body = document.createElement('div');
      body.className = 'voice-phone-body';

      const qrBox = document.createElement('div');
      qrBox.className = 'voice-qr';
      body.appendChild(qrBox);

      const p = document.createElement('p');
      p.className = 'wb-cal-note';
      p.textContent = 'Scan this with your phone to join the voice channel from it — useful when the computer has no microphone. The phone joins as its own participant; mute this computer to avoid echo.';
      body.appendChild(p);

      const linkRow = document.createElement('div');
      linkRow.className = 'voice-phone-link';
      const linkInput = document.createElement('input');
      linkInput.className = 'input';
      linkInput.readOnly = true;
      linkInput.value = url;
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); copyBtn.textContent = 'Copied'; }
        catch (_) { linkInput.select(); }
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
      linkRow.append(linkInput, copyBtn);
      body.appendChild(linkRow);

      if (location.protocol !== 'https:' && !/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
        const warn = document.createElement('p');
        warn.className = 'wb-cal-note';
        warn.style.color = 'var(--clr-warning, #e0a02c)';
        warn.textContent = 'Note: phones only allow microphone access over HTTPS. Over plain http on a LAN address the phone will refuse the mic — put the server behind HTTPS to use this.';
        body.appendChild(warn);
      }

      global.Modal?.open({
        title: '<i class="ph ph-device-mobile"></i> Talk from your phone',
        width: 420, body,
        actions: [{ label: 'Done' }],
      });

      this._paintQR(qrBox, url);
    },

    /** QR is a convenience; the link underneath always works without it. */
    _paintQR(box, url) {
      const draw = () => {
        try {
          box.textContent = '';
          new global.QRCode(box, { text: url, width: 190, height: 190, correctLevel: global.QRCode.CorrectLevel.M });
        } catch (err) {
          box.textContent = 'Use the link below.';
        }
      };
      if (global.QRCode) return draw();
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = draw;
      s.onerror = () => { box.textContent = 'Use the link below.'; };
      document.head.appendChild(s);
    },
  };

  global.VoicePhoneLink = VoicePhoneLink;

  /* ---- board wiring -------------------------------------------------------- */

  function boot() {
    const app = global.app;
    if (!app?.store) { setTimeout(boot, 400); return; }
    if (app.voice) return;

    const btn = document.getElementById('voice-btn');

    const ensure = () => {
      if (app.voice) return app.voice;
      app.voice = new global.VoiceChannel({ boardId: app.store.state.id, me: identity() });
      app.voice.onChange(v => {
        btn?.classList.toggle('is-on', v.joined);
        if (btn) {
          btn.title = v.joined
            ? `Voice channel — ${v.participantCount} connected. Click to leave.`
            : 'Start a voice channel for this board';
        }
      });
      return app.voice;
    };

    btn?.addEventListener('click', async () => {
      const v = ensure();
      if (v.joined) { await v.leave(); return; }
      // The room is the board, so a board nobody else can open is a room
      // nobody else can join — worth saying before they wonder why they
      // are alone in it.
      if (!global.FirebaseSync?.isLoggedIn) {
        toast('Sign in and share this board first — the voice channel is per board, so the other person has to be able to open it.', 'info', 6000);
      }
      const ok = await v.join();
      if (ok) toast('Voice channel on. Anyone else on this board can join it.', 'success', 3500);
    });

    // Right-click the button for the phone option without joining first.
    btn?.addEventListener('contextmenu', e => {
      e.preventDefault();
      VoicePhoneLink.open(app.store.state.id);
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 0);
  else global.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
})(window);
