/* ================================================================
   gcal-block.js — Google Calendar, live, on the board
   ----------------------------------------------------------------
   Not a screenshot of an agenda and not a read-only feed: events
   created, moved, retitled or deleted here are written to Google
   Calendar, and anything changed in Google appears here on the next
   refresh.

   Two views, because they answer different questions:

     Agenda   what is next — a dated list, the thing you actually read
     Week     where the gaps are — seven columns you can drag inside

   Editing safely
   --------------
   Every event carries an `etag`. An update sends it back as
   `If-Match`, so if the event moved on in Google since the board last
   read it, Google refuses the write and the board says so instead of
   silently discarding whichever edit lost the race. That is the whole
   difference between a calendar you can trust and one you check twice.

   Model:
     { type:'gcal', calendarId, view, days, title, cache, refreshSec }
   ================================================================ */

(function (global) {
  'use strict';

  const MIN_REFRESH = 30;
  const DAY_MS = 86400000;
  const HOUR_START = 7;          // the week grid shows a working day, not
  const HOUR_END = 22;           // 24 rows of mostly-empty night

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

  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  function humanDay(d) {
    const today = startOfDay(new Date());
    const diff = Math.round((startOfDay(d) - today) / DAY_MS);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }

  const timeOf = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  /** Local wall-clock ISO, which is what the Calendar API wants with a timeZone. */
  function localISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
           `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  }

  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  class GCalBlock {
    constructor(app, element, node) {
      this.app = app;
      this.store = app.store;
      this.id = element.id;
      this.node = node;
      this.type = 'gcal';

      this.events = [];
      this.calendars = [];
      this.loading = false;
      this.error = null;
      this.fetchedAt = null;
      this._timer = null;
      this._anchor = startOfDay(new Date());

      this._build();
      const c = element.cache;
      if (c?.events) { this.events = c.events; this.fetchedAt = c.fetchedAt; }
      this.update(element);
      this.refresh({ quiet: true });
      this._schedule(element);
    }

    get element() { return this.store.get(this.id); }
    get view() { return this.element?.view || 'agenda'; }
    _write(props) { this.store.updateElement(this.id, props); }

    /* ---- chrome -------------------------------------------------------- */

    _build() {
      this.node.textContent = '';

      this.calSel = el('select', {
        class: 'wb-cal-select wb-live-ui', title: 'Which calendar',
        onchange: () => { this._write({ calendarId: this.calSel.value }); this.refresh(); },
      });

      this.stampEl = el('span', { class: 'wb-dash-stamp' });

      const viewBtn = (id, label, icon) => el('button', {
        type: 'button', class: 'wb-cal-view' + (this.view === id ? ' is-on' : ''),
        title: label, 'data-view': id,
        onclick: () => { this._write({ view: id }); this._paint(); },
      }, [el('i', { class: 'ph ' + icon })]);

      this.viewRow = el('span', { class: 'wb-cal-views' }, [
        viewBtn('agenda', 'Agenda', 'ph-list-bullets'),
        viewBtn('week', 'Week', 'ph-calendar-blank'),
      ]);

      this.head = el('div', { class: 'wb-cal-head wb-live-ui' }, [
        el('i', { class: 'ph-fill ph-calendar-dots wb-cal-mark' }),
        this.calSel,
        this.stampEl,
        el('span', { class: 'wb-cell-spacer' }),
        this.viewRow,
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Back',
          onclick: () => this._move(-1),
        }, [el('i', { class: 'ph ph-caret-left' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Today',
          onclick: () => { this._anchor = startOfDay(new Date()); this.refresh(); },
        }, [el('span', { text: 'Today' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Forward',
          onclick: () => this._move(1),
        }, [el('i', { class: 'ph ph-caret-right' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn', title: 'Read Google Calendar again now',
          onclick: () => this.refresh(),
        }, [el('i', { class: 'ph ph-arrows-clockwise' })]),
        el('button', {
          type: 'button', class: 'wb-cell-btn is-run', title: 'Create an event in Google Calendar',
          onclick: () => this.compose(),
        }, [el('i', { class: 'ph-bold ph-plus' }), el('span', { text: 'Event' })]),
      ]);

      this.body = el('div', { class: 'wb-cal-body wb-live-ui' });
      this.node.append(this.head, this.body);
    }

    _move(direction) {
      const span = this.view === 'week' ? 7 : (this.element?.days || 14);
      this._anchor = new Date(this._anchor.getTime() + direction * span * DAY_MS);
      this.refresh();
    }

    /* ---- data ---------------------------------------------------------- */

    _range() {
      if (this.view === 'week') {
        const from = new Date(this._anchor);
        from.setDate(from.getDate() - from.getDay());       // Sunday
        const to = new Date(from.getTime() + 7 * DAY_MS);
        return { from, to };
      }
      const from = new Date(this._anchor);
      const to = new Date(from.getTime() + (this.element?.days || 14) * DAY_MS);
      return { from, to };
    }

    _schedule(element) {
      clearInterval(this._timer);
      const secs = element?.refreshSec ?? 120;
      if (!secs) return;
      this._timer = setInterval(() => this.refresh({ quiet: true }), Math.max(MIN_REFRESH, secs) * 1000);
    }

    async _get(path, params) {
      const res = await fetch(path + '?' + new URLSearchParams(params), { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error([body.error, body.fix].filter(Boolean).join(' — ') || `Request failed (${res.status})`);
      return body;
    }

    async refresh({ quiet = false } = {}) {
      if (this.loading) return;
      this.loading = true;
      this.error = null;
      if (!quiet) this._paintStamp();

      const { from, to } = this._range();
      try {
        if (!this.calendars.length) {
          try {
            const c = await this._get('/api/google/calendar/calendars', {});
            this.calendars = c.calendars || [];
          } catch { /* the event list is what matters; the picker can wait */ }
        }

        const res = await this._get('/api/google/calendar/events', {
          from: from.toISOString(), to: to.toISOString(),
          calendarId: this.element?.calendarId || 'primary',
        });
        this.events = res.events || [];
        this.fetchedAt = res.syncedAt || new Date().toISOString();
        // Cached with the board so it opens showing the agenda rather than
        // a spinner, and still says something if Google is unreachable.
        this._write({ cache: { events: this.events.slice(0, 300), fetchedAt: this.fetchedAt } });
      } catch (err) {
        this.error = err.message;
        if (!quiet) toast(err.message, 'warn', 7000);
      } finally {
        this.loading = false;
        this._paint();
      }
    }

    /* ---- writing ------------------------------------------------------- */

    compose(existing = null, presetDate = null) {
      return composeEvent({
        existing, presetDate,
        calendarId: this.element?.calendarId || 'primary',
        onSaved: () => this.refresh({ quiet: true }),
      });
    }

    /* ---- painting ------------------------------------------------------ */

    update(element) {
      if (!element) return;
      this._paintCalendars(element);
      this._paint();
    }

    _paintCalendars(element) {
      const want = element.calendarId || 'primary';
      const have = [...this.calSel.options].map(o => o.value).join('|');
      const next = this.calendars.length
        ? this.calendars.map(c => c.id).join('|')
        : want;
      if (have === next && this.calSel.value === want) return;

      this.calSel.textContent = '';
      if (!this.calendars.length) {
        this.calSel.appendChild(el('option', { value: 'primary', text: 'My calendar' }));
      } else {
        for (const c of this.calendars) {
          this.calSel.appendChild(el('option', { value: c.id, text: c.name }));
        }
      }
      this.calSel.value = want;
    }

    _paint() {
      this._paintStamp();
      for (const b of this.viewRow.querySelectorAll('.wb-cal-view')) {
        b.classList.toggle('is-on', b.dataset.view === this.view);
      }
      if (document.activeElement && this.body.contains(document.activeElement)) return;
      this.body.textContent = '';

      if (this.error) {
        this.body.appendChild(el('div', { class: 'wb-dash-error' }, [
          el('i', { class: 'ph-bold ph-warning-circle' }),
          el('div', {}, [
            el('strong', { text: 'Could not read Google Calendar' }),
            el('p', { text: this.error }),
          ]),
        ]));
      }

      this.body.appendChild(this.view === 'week' ? this._week() : this._agenda());
    }

    _paintStamp() {
      const { from, to } = this._range();
      const label = this.view === 'week'
        ? `${from.toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${new Date(to - DAY_MS).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
        : `next ${this.element?.days || 14} days`;

      if (this.loading) { this.stampEl.textContent = 'reading…'; this.stampEl.dataset.state = 'busy'; return; }
      if (this.error) { this.stampEl.textContent = 'offline'; this.stampEl.dataset.state = 'bad'; return; }
      this.stampEl.textContent = label;
      this.stampEl.dataset.state = 'ok';
      this.stampEl.title = this.fetchedAt ? 'Last read ' + new Date(this.fetchedAt).toLocaleTimeString() : '';
    }

    _agenda() {
      const wrap = el('div', { class: 'wb-cal-agenda' });
      if (!this.events.length) {
        wrap.appendChild(el('div', { class: 'wb-dash-empty' }, [
          el('i', { class: 'ph ph-calendar-blank' }),
          el('strong', { text: 'Nothing scheduled' }),
          el('p', { text: 'Press Event to add something — it is written straight to Google Calendar.' }),
        ]));
        return wrap;
      }

      const byDay = new Map();
      for (const ev of this.events) {
        const k = dayKey(new Date(ev.start));
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(ev);
      }

      for (const [k, list] of [...byDay.entries()].sort()) {
        const d = new Date(k + 'T00:00:00');
        const isToday = dayKey(new Date()) === k;
        wrap.appendChild(el('div', { class: 'wb-cal-daygroup' + (isToday ? ' is-today' : '') }, [
          el('div', { class: 'wb-cal-dayhead' }, [
            el('strong', { text: humanDay(d) }),
            el('span', { text: `${list.length} event${list.length === 1 ? '' : 's'}` }),
          ]),
          ...list.map(ev => this._row(ev)),
        ]));
      }
      return wrap;
    }

    _row(ev) {
      return el('button', {
        type: 'button', class: 'wb-cal-row' + (ev.allDay ? ' is-allday' : ''),
        title: 'Edit this event',
        onclick: () => this.compose(ev),
      }, [
        el('span', { class: 'wb-cal-time', text: ev.allDay ? 'All day' : timeOf(ev.start) }),
        el('span', { class: 'wb-cal-bar' }),
        el('span', { class: 'wb-cal-meta' }, [
          el('strong', { text: ev.title }),
          ev.location ? el('small', { text: ev.location }) : null,
        ].filter(Boolean)),
        ev.attendees?.length
          ? el('span', { class: 'wb-cal-people', text: `${ev.attendees.length}` })
          : null,
      ].filter(Boolean));
    }

    _week() {
      const { from } = this._range();
      const grid = el('div', { class: 'wb-cal-week' });

      const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * DAY_MS));
      const todayKey = dayKey(new Date());

      for (const d of days) {
        const k = dayKey(d);
        const list = this.events
          .filter(ev => dayKey(new Date(ev.start)) === k)
          .sort((a, b) => new Date(a.start) - new Date(b.start));

        grid.appendChild(el('div', { class: 'wb-cal-col' + (k === todayKey ? ' is-today' : '') }, [
          el('div', { class: 'wb-cal-colhead' }, [
            el('strong', { text: d.toLocaleDateString([], { weekday: 'short' }) }),
            el('span', { text: String(d.getDate()) }),
          ]),
          el('div', {
            class: 'wb-cal-slots',
            // Clicking empty space in a day is the fastest way anyone adds
            // an event to a week view; pre-fill the day it was clicked on.
            onclick: e => {
              if (e.target.closest('.wb-cal-chip')) return;
              const at = new Date(d);
              at.setHours(Math.min(HOUR_END - 1, Math.max(HOUR_START, new Date().getHours())), 0, 0, 0);
              this.compose(null, at);
            },
          }, list.length
            ? list.map(ev => el('button', {
                type: 'button', class: 'wb-cal-chip' + (ev.allDay ? ' is-allday' : ''),
                title: `${ev.title}\n${ev.allDay ? 'All day' : timeOf(ev.start) + ' – ' + timeOf(ev.end)}`,
                onclick: e => { e.stopPropagation(); this.compose(ev); },
              }, [
                el('span', { class: 'wb-cal-chip-time', text: ev.allDay ? '' : timeOf(ev.start) }),
                el('span', { class: 'wb-cal-chip-title', text: ev.title }),
              ]))
            : [el('span', { class: 'wb-cal-empty', text: '+' })]),
        ]));
      }
      return grid;
    }

    destroy() { clearInterval(this._timer); }
  }

  /* ================================================================
     The shared event composer
     ----------------------------------------------------------------
     Lives outside the block on purpose. Scheduling something is a
     thought you have while looking at the board — mid-sticky, mid-
     diagram — and requiring a calendar block on the canvas first turns
     a ten-second action into a layout decision. So the same form is
     reachable from the block, from the right-click menu on any object
     (pre-filled with its text), and from the command palette.
     ================================================================ */

  async function saveEvent(payload, calendarId = 'primary') {
    const res = await fetch('/api/google/calendar/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, calendarId, timeZone: TZ }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error([data.error, data.fix].filter(Boolean).join(' — ') || 'Save failed');
      err.conflict = !!data.conflict;
      err.authError = res.status === 401 || res.status === 403;
      throw err;
    }
    return data.event;
  }

  async function deleteEvent(ev) {
    const res = await fetch('/api/google/calendar/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: ev.id, calendarId: ev.calendarId }),
    });
    if (!res.ok) throw new Error('Delete failed');
  }

  function composeEvent({ existing = null, presetDate = null, prefill = {},
                          calendarId = 'primary', onSaved = null } = {}) {
    if (!global.Modal?.open) { toast('The dialog system is not ready yet.', 'warn'); return; }

    const isNew = !existing;
    const base = existing
      ? new Date(existing.start)
      // Round up to the next half hour: nobody schedules things at 14:37.
      : (presetDate || new Date(Math.ceil(Date.now() / 1800000) * 1800000));
    const endBase = existing?.end ? new Date(existing.end) : new Date(base.getTime() + 3600000);

    const title = el('input', {
      class: 'input', placeholder: 'What is it?',
      value: existing?.title || prefill.title || '',
    });
    const date = el('input', { type: 'date', class: 'input', value: dayKey(base) });
    const from = el('input', { type: 'time', class: 'input', value: `${pad(base.getHours())}:${pad(base.getMinutes())}` });
    const to = el('input', { type: 'time', class: 'input', value: `${pad(endBase.getHours())}:${pad(endBase.getMinutes())}` });
    const whole = el('input', { type: 'checkbox' });
    whole.checked = !!existing?.allDay;
    const where = el('input', { class: 'input', placeholder: 'Location (optional)', value: existing?.location || '' });
    const notes = el('textarea', { class: 'input', rows: 3, placeholder: 'Notes (optional)' });
    notes.value = existing?.description || prefill.description || '';

    const times = el('div', { class: 'wb-cal-times' }, [from, el('span', { text: '→' }), to]);
    const syncTimes = () => { times.style.display = whole.checked ? 'none' : ''; };
    whole.addEventListener('change', syncTimes);
    syncTimes();

    const body = el('div', { class: 'wb-cal-form' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Title' }), title]),
      el('label', { class: 'field' }, [el('span', { text: 'Date' }), date]),
      el('label', { class: 'wb-cal-allday' }, [whole, el('span', { text: 'All day' })]),
      times,
      el('label', { class: 'field' }, [el('span', { text: 'Location' }), where]),
      el('label', { class: 'field' }, [el('span', { text: 'Notes' }), notes]),
      existing?.link ? el('p', { class: 'wb-cal-note' }, [
        el('a', { href: existing.link, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Google Calendar ↗' }),
      ]) : null,
    ].filter(Boolean));

    const commit = async () => {
      if (!date.value || !title.value.trim()) {
        toast('A title and a date are needed.', 'warn');
        return false;
      }
      const payload = {
        eventId: existing?.id, etag: existing?.etag,
        title: title.value.trim(), description: notes.value, location: where.value,
        allDay: whole.checked,
      };
      if (whole.checked) {
        payload.start = date.value;
      } else {
        payload.start = `${date.value}T${from.value || '09:00'}:00`;
        payload.end = `${date.value}T${to.value || '10:00'}:00`;
      }

      try {
        const saved = await saveEvent(payload, existing?.calendarId || calendarId);
        toast(isNew ? 'Event created in Google Calendar.' : 'Event updated in Google Calendar.',
          'success', 2800);
        onSaved?.(saved);
      } catch (err) {
        // A 401 here means Workspace (not Keep — a separate connection) was
        // never linked, or its calendar scope lapsed. A plain toast used to
        // be a dead end; offer the actual fix instead.
        if (err.authError && global.GoogleAccount?.connectWorkspace) {
          global.Modal?.open?.({
            title: 'Connect Google Workspace',
            body: el('p', {
              text: 'Calendar needs Google Workspace connected — that\'s separate from a Keep sign-in. Connect it now to save this event?',
            }),
            actions: [
              { label: 'Not now' },
              { label: 'Connect', primary: true, onClick: () => global.GoogleAccount.connectWorkspace() },
            ],
          });
        } else {
          toast(err.message, 'warn', err.conflict ? 9000 : 7000);
        }
        if (err.conflict) onSaved?.(null);
      }
    };

    const actions = [{ label: 'Cancel' }];
    if (existing) {
      actions.push({
        label: 'Delete', danger: true,
        onClick: async () => {
          const ok = await (global.PMUI?.confirm
            ? global.PMUI.confirm(`"${existing.title}" will be deleted from Google Calendar.`,
                { title: 'Delete event?', okLabel: 'Delete', danger: true })
            : Promise.resolve(global.confirm(`Delete "${existing.title}" from Google Calendar?`)));
          if (!ok) return false;
          try { await deleteEvent(existing); toast('Event deleted.', 'info', 2200); onSaved?.(null); }
          catch (err) { toast(err.message, 'warn', 5000); }
        },
      });
    }
    actions.push({ label: isNew ? 'Create' : 'Save', primary: true, onClick: commit });

    global.Modal.open({
      title: isNew ? '<i class="ph ph-calendar-plus"></i> New calendar event'
                   : '<i class="ph ph-calendar-check"></i> Edit event',
      width: 460, body, actions,
    });

    if (isNew) setTimeout(() => title.focus(), 60);
  }

  /**
   * Schedule the current selection.
   *
   * The object's own text becomes the title, so "meet the supplier" on a
   * sticky becomes that event with one right-click and a date.
   */
  function composeFromSelection(app) {
    const sel = app?.store?.selected?.() || [];
    const first = sel.find(e => (e.content || '').trim());
    const text = String(first?.content || '').trim();
    const [line, ...rest] = text.split('\n');

    composeEvent({
      prefill: {
        title: (line || '').slice(0, 120),
        description: rest.join('\n').slice(0, 2000),
      },
      onSaved: () => {
        // Any calendar block on this board should show it immediately.
        for (const elm of app.store.state.elements) {
          if (elm.type !== 'gcal') continue;
          app.renderer.node(elm.id)?.__live && app.renderer.patch(elm);
        }
        document.querySelectorAll('.board-element.type-gcal').forEach(n => n.__gcal?.refresh?.({ quiet: true }));
      },
    });
  }

  global.GCalBlock = GCalBlock;
  global.GCalCompose = composeEvent;
  global.GCalComposeFromSelection = composeFromSelection;

  function install() {
    const proto = global.Renderer?.prototype;
    if (!proto || proto._gcal) return;
    proto._gcal = function (element, node) {
      const cal = new GCalBlock(this.app, element, node);
      // Published on the node so an event created elsewhere — the
      // right-click menu, the command palette — can tell every calendar
      // block on the board to re-read, rather than leaving them stale
      // until their own timer comes round.
      node.__gcal = cal;
      node.__live = { type: 'gcal', update: e => cal.update(e), destroy: () => cal.destroy() };
    };
  }

  if (global.Renderer) install();
  else global.addEventListener('DOMContentLoaded', install, { once: true });
})(window);
