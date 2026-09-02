/* ================================================================
   attachments.js — files and documents on board objects
   ----------------------------------------------------------------
   Why this file exists.

   A project task could already carry a Drive file. A whiteboard object
   could carry nothing at all: the only bridge from Google Workspace to
   the canvas dropped a sticky note with a URL typed into its text,
   which is a note about a file, not a file.

   This adds a real attachment list to every board object. An object
   can hold any mix of:

     drive   a Drive file or Google Doc, opened in Google
     upload  a local file, uploaded to /static/uploads
     link    a plain URL

   Attachments live on the element as `el.attachments`, so they travel
   through the Store like everything else — which means undo, autosave,
   version history, JSON export and realtime sync all cover them
   without a line of extra code. That is the whole reason they are
   element data rather than a side table.
   ================================================================ */

(function (global) {
  'use strict';

  const KIND_ICON = {
    doc: 'ph-file-doc', sheet: 'ph-file-xls', slides: 'ph-file-ppt',
    pdf: 'ph-file-pdf', image: 'ph-file-image', video: 'ph-file-video',
    audio: 'ph-file-audio', folder: 'ph-folder', form: 'ph-list-checks',
    drawing: 'ph-pen-nib', archive: 'ph-file-zip', link: 'ph-link-simple',
    file: 'ph-file',
  };

  const EXT_KIND = {
    pdf: 'pdf',
    doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', txt: 'doc', md: 'doc',
    xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
    ppt: 'slides', pptx: 'slides', odp: 'slides',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
    bmp: 'image', tiff: 'image', heic: 'image',
    mp4: 'video', mov: 'video', webm: 'video', avi: 'video', mkv: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
    zip: 'archive', gz: 'archive', tar: 'archive', '7z': 'archive', rar: 'archive',
  };

  function kindOf(name = '', fallback = 'file') {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return EXT_KIND[ext] || fallback;
  }

  function iconFor(att) {
    return KIND_ICON[att.kind] || KIND_ICON.file;
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }

  class Attachments {
    constructor(app) {
      this.app = app;
      this.store = app.store;
    }

    /* ---- model ------------------------------------------------------- */

    list(elementId) {
      return this.store.get(elementId)?.attachments || [];
    }

    add(elementId, att) {
      const el = this.store.get(elementId);
      if (!el) return null;

      const record = {
        id: 'att_' + Math.random().toString(36).slice(2, 10),
        kind: att.kind || kindOf(att.name),
        source: att.source || 'link',      // drive | upload | link
        name: att.name || att.url || 'Attachment',
        url: att.url || '',
        mime: att.mime || '',
        size: att.size || null,
        icon: att.icon || '',
        addedAt: new Date().toISOString(),
      };

      // Attaching the same file twice is nearly always a double click.
      const existing = (el.attachments || []).find(a => a.url && a.url === record.url);
      if (existing) {
        global.Modal?.toast(`"${existing.name}" is already attached.`, 'info', 2200);
        return existing;
      }

      // updateElement emits `element:update`, which the renderer is already
      // listening to — no explicit patch needed, and a second one would just
      // rebuild the node twice.
      this.store.updateElement(elementId, { attachments: [...(el.attachments || []), record] });
      global.Modal?.toast(`Attached "${record.name}".`, 'success', 2200);
      return record;
    }

    remove(elementId, attId) {
      const el = this.store.get(elementId);
      if (!el) return;
      this.store.updateElement(elementId, {
        attachments: (el.attachments || []).filter(a => a.id !== attId),
      });
    }

    open(att) {
      if (!att?.url) return;
      global.open(att.url, '_blank', 'noopener,noreferrer');
    }

    /* ---- pickers ----------------------------------------------------- */

    /** The menu behind the paperclip: one entry per source. */
    menu(elementId, anchorEvent) {
      const items = [
        ['ph-google-drive-logo', 'From Google Drive…', () => this.pickFromDrive(elementId)],
        ['ph-file-doc', 'From Google Docs…', () => this.pickFromDrive(elementId, { docsOnly: true })],
        ['ph-upload-simple', 'Upload a file…', () => this.pickLocal(elementId)],
        ['ph-link-simple', 'Paste a link…', () => this.pickLink(elementId)],
      ];

      const menu = document.createElement('div');
      menu.className = 'att-menu';
      for (const [icon, label, fn] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'att-menu-item';
        b.innerHTML = `<i class="ph ${icon}"></i><span>${label}</span>`;
        b.addEventListener('click', () => { close(); fn(); });
        menu.appendChild(b);
      }

      document.body.appendChild(menu);
      const r = anchorEvent?.currentTarget?.getBoundingClientRect?.();
      const x = r ? r.left : (anchorEvent?.clientX || 100);
      const y = r ? r.bottom + 6 : (anchorEvent?.clientY || 100);
      menu.style.left = Math.min(x, innerWidth - menu.offsetWidth - 12) + 'px';
      menu.style.top = Math.min(y, innerHeight - menu.offsetHeight - 12) + 'px';

      function close() {
        menu.remove();
        document.removeEventListener('pointerdown', onAway, true);
      }
      function onAway(e) { if (!menu.contains(e.target)) close(); }
      setTimeout(() => document.addEventListener('pointerdown', onAway, true), 0);
    }

    /** Upload from disk and attach the stored URL. */
    pickLocal(elementId) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);

      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        input.remove();
        if (!files.length) return;

        for (const file of files) {
          const form = new FormData();
          form.append('file', file);
          try {
            const res = await fetch('/api/upload/file', { method: 'POST', body: form });
            const data = await res.json();
            if (!res.ok) {
              global.Modal?.toast(
                `${file.name}: ${data.error || 'upload failed'}${data.fix ? ' — ' + data.fix : ''}`,
                'warn', 6000);
              continue;
            }
            this.add(elementId, {
              source: 'upload',
              name: data.name || file.name,
              url: data.url,
              size: data.size,
              mime: file.type,
              kind: kindOf(data.name || file.name),
            });
          } catch (err) {
            global.Modal?.toast(`${file.name}: could not reach the server.`, 'warn', 5000);
          }
        }
      });

      input.click();
    }

    async pickLink(elementId) {
      const url = await global.Modal.prompt(
        'Paste a link. Anything with an address works — a Google Doc, a Figma file, a ticket.',
        '', { title: 'Attach a link', placeholder: 'https://…' });
      if (!url) return;
      const trimmed = url.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        global.Modal.toast('That does not look like a web address.', 'warn');
        return;
      }
      let name = trimmed;
      try { name = decodeURIComponent(new URL(trimmed).hostname.replace(/^www\./, '')); } catch {}
      this.add(elementId, { source: 'link', kind: 'link', name, url: trimmed });
    }

    /**
     * Browse Drive without leaving the canvas.
     *
     * This talks to the same /api/google/drive/list the Workspace screen
     * uses, so folder navigation, search and the type filters behave
     * identically — and a fix to one is a fix to both.
     */
    async pickFromDrive(elementId, { docsOnly = false } = {}) {
      const state = { q: '', trail: [], filter: docsOnly ? 'doc' : 'all', nextPage: null };

      const search = document.createElement('input');
      search.className = 'input';
      search.type = 'search';
      search.placeholder = docsOnly ? 'Search your documents…' : 'Search all of Drive…';

      const crumbs = document.createElement('div');
      crumbs.className = 'att-crumbs';

      const list = document.createElement('div');
      list.className = 'att-picker-list';

      const body = document.createElement('div');
      body.className = 'att-picker';
      body.append(search, crumbs, list);

      // Modal.open returns the handle that owns this dialog; there is no
      // Modal.close(), so anything that dismisses it has to go through here.
      const modal = global.Modal.open({
        title: docsOnly ? 'Attach a Google Doc' : 'Attach from Google Drive',
        body,
        width: 620,
        actions: [{ label: 'Done' }],
      });

      const setBusy = () => {
        list.innerHTML = '<div class="att-picker-busy">Loading…</div>';
      };

      const drawCrumbs = () => {
        crumbs.textContent = '';
        if (!state.trail.length && !state.q) return;
        const home = document.createElement('button');
        home.type = 'button';
        home.className = 'att-crumb';
        home.innerHTML = '<i class="ph ph-house"></i> My Drive';
        home.addEventListener('click', () => { state.trail = []; load(); });
        crumbs.appendChild(home);
        state.trail.forEach((f, i) => {
          const sep = document.createElement('i');
          sep.className = 'ph ph-caret-right att-crumb-sep';
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'att-crumb';
          b.textContent = f.name;
          b.addEventListener('click', () => { state.trail = state.trail.slice(0, i + 1); load(); });
          crumbs.append(sep, b);
        });
      };

      const load = async ({ more = false } = {}) => {
        if (!more) { setBusy(); drawCrumbs(); state.nextPage = null; }

        const folder = state.trail.at(-1)?.id || '';
        const params = new URLSearchParams({
          filter: folder ? 'all' : state.filter,
        });
        if (state.q) params.set('q', state.q);
        if (folder) params.set('folder', folder);
        if (more && state.nextPage) params.set('page', state.nextPage);

        try {
          const res = await fetch('/api/google/drive/list?' + params);
          const data = await res.json();

          if (!res.ok) {
            list.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'att-picker-error';
            err.innerHTML =
              `<p><strong>${escapeHTML(data.error || 'Drive could not be read.')}</strong></p>` +
              (data.fix ? `<p>${escapeHTML(data.fix)}</p>` : '') +
              (res.status === 401
                ? '<button type="button" class="btn btn-primary" data-connect>Connect Google</button>'
                : '');
            err.querySelector('[data-connect]')?.addEventListener('click', () => {
              modal.close();
              global.GoogleAccount?.connectWorkspace();
            });
            list.appendChild(err);
            return;
          }

          state.nextPage = data.nextPage || null;
          if (!more) list.textContent = '';
          list.querySelector('.att-picker-more')?.remove();

          const files = data.files || [];
          if (!files.length && !more) {
            list.innerHTML = `<div class="att-picker-busy">${
              state.q ? 'Nothing matches that search.' : 'This folder is empty.'}</div>`;
            return;
          }

          for (const f of files) list.appendChild(row(f));

          if (state.nextPage) {
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.className = 'btn btn-ghost full att-picker-more';
            moreBtn.textContent = 'Load more';
            moreBtn.addEventListener('click', () => {
              moreBtn.disabled = true;
              moreBtn.textContent = 'Loading…';
              load({ more: true });
            });
            list.appendChild(moreBtn);
          }
        } catch {
          list.innerHTML = '<div class="att-picker-error">Could not reach the server.</div>';
        }
      };

      const row = (f) => {
        const isFolder = f.kind === 'folder';
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'att-picker-row';
        el.innerHTML =
          `<i class="ph ${KIND_ICON[f.kind] || KIND_ICON.file}"></i>` +
          `<span class="att-picker-name">${escapeHTML(f.name || 'Untitled')}</span>` +
          `<small>${isFolder ? 'Folder' : [f.kind, humanSize(f.size)].filter(Boolean).join(' · ')}</small>` +
          (isFolder ? '<i class="ph ph-caret-right"></i>' : '<i class="ph ph-paperclip"></i>');

        el.addEventListener('click', () => {
          if (isFolder) {
            state.trail.push({ id: f.id, name: f.name });
            state.q = '';
            search.value = '';
            load();
            return;
          }
          this.add(elementId, {
            source: 'drive',
            kind: f.kind,
            name: f.name,
            url: f.link,
            mime: f.mimeType,
            size: f.size,
            icon: f.icon,
          });
          modal.close();
        });
        return el;
      };

      let t;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.q = search.value.trim(); state.trail = []; load(); }, 300);
      });

      load();
      setTimeout(() => search.focus(), 60);
      return modal;
    }

    /* ---- the popover shown from an object's badge --------------------- */

    showPopover(elementId, anchor) {
      document.querySelector('.att-popover')?.remove();

      const el = this.store.get(elementId);
      if (!el) return;
      const items = el.attachments || [];

      const pop = document.createElement('div');
      pop.className = 'att-popover';

      const head = document.createElement('div');
      head.className = 'att-popover-head';
      head.innerHTML = `<strong>Attached</strong><span>${items.length}</span>`;
      pop.appendChild(head);

      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'att-popover-empty';
        empty.textContent = 'Nothing attached yet.';
        pop.appendChild(empty);
      }

      for (const att of items) {
        const rowEl = document.createElement('div');
        rowEl.className = 'att-popover-row';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'att-popover-open';
        openBtn.title = att.url;
        openBtn.innerHTML =
          `<i class="ph ${iconFor(att)}"></i>` +
          `<span>${escapeHTML(att.name)}</span>` +
          `<small>${escapeHTML([sourceLabel(att), humanSize(att.size)].filter(Boolean).join(' · '))}</small>`;
        openBtn.addEventListener('click', () => this.open(att));

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'att-popover-del';
        del.title = 'Remove attachment';
        del.innerHTML = '<i class="ph ph-x"></i>';
        del.addEventListener('click', () => {
          this.remove(elementId, att.id);
          this.showPopover(elementId, anchor);
        });

        rowEl.append(openBtn, del);
        pop.appendChild(rowEl);
      }

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-ghost full';
      addBtn.innerHTML = '<i class="ph ph-plus"></i> Attach something';
      addBtn.addEventListener('click', e => { pop.remove(); this.menu(elementId, e); });
      pop.appendChild(addBtn);

      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 12)) + 'px';
      pop.style.top = Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 12) + 'px';

      const away = e => {
        if (pop.contains(e.target) || anchor.contains(e.target)) return;
        pop.remove();
        document.removeEventListener('pointerdown', away, true);
      };
      setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    }
  }

  function sourceLabel(att) {
    return { drive: 'Google Drive', upload: 'Uploaded', link: 'Link' }[att.source] || '';
  }

  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.Attachments = Attachments;
  global.ATTACHMENT_ICONS = KIND_ICON;
  global.attachmentKindOf = kindOf;
  global.attachmentIconFor = iconFor;
  global.attachmentHumanSize = humanSize;
})(window);
