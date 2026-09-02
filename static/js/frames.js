/* ================================================================
   frames.js — frames as areas of responsibility
   ----------------------------------------------------------------
   Why this file exists.

   A frame already marked out a region of the board, and presentation
   mode already treated each one as a slide. What it could not do was
   say whose region it was.

   That is the missing piece between the whiteboard and the project
   side: you draw a frame around the part of the board that is one
   person's job — "checkout flow", "onboarding copy", "the API" — and
   assign it to them. From then on:

     · the frame shows their avatars in its corner
     · they can list every area assigned to them and fly to it
     · the objects inside a frame are known to belong to that area, so
       a frame can be turned into real tracked tasks in one step

   The member list comes from the project the board belongs to, so the
   people here are the same people as on the project's tasks — not a
   second, parallel roster that drifts out of step.
   ================================================================ */

(function (global) {
  'use strict';

  const AVATAR_COLORS = [
    '#4262ff', '#e8590c', '#2b8a3e', '#c2255c', '#7048e8',
    '#0c8599', '#e67700', '#5c940d', '#a61e4d', '#364fc7',
  ];

  function colorFor(key) {
    let hash = 0;
    for (let i = 0; i < String(key).length; i++) {
      hash = (hash * 31 + String(key).charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  class Frames {
    constructor(app) {
      this.app = app;
      this.store = app.store;
    }

    /* ---- who is available to assign ---------------------------------- */

    /**
     * The people on this board's project.
     *
     * The project workspace owns the roster, and it may not be loaded — the
     * canvas boots before it. Fall back through what is available so the
     * picker is never empty when there is *someone* to show: the project,
     * then the signed-in user, then nobody with an explanation.
     */
    members() {
      const store = global.PMWorkStore || global.workStore;
      const projectId = this.store.state.projectId;

      if (store && projectId) {
        const p = store.project?.(projectId);
        if (p?.members?.length) {
          return p.members
            .filter(m => m.status !== 'removed')
            .map(m => ({
              uid: m.uid || null,
              email: m.email || '',
              name: m.name || m.email || 'Teammate',
              photoURL: m.photoURL || '',
              color: m.color || colorFor(m.uid || m.email),
            }));
        }
      }

      const me = global.GoogleAccount?.identity;
      if (me) {
        return [{
          uid: me.uid, email: me.email, name: me.name,
          photoURL: me.photo, color: colorFor(me.email || 'me'),
        }];
      }
      return [];
    }

    /* ---- assignment -------------------------------------------------- */

    assignees(frameId) {
      return this.store.get(frameId)?.assignees || [];
    }

    isAssigned(frameId, member) {
      const key = member.uid || member.email;
      return this.assignees(frameId).some(a => (a.uid || a.email) === key);
    }

    toggle(frameId, member) {
      const el = this.store.get(frameId);
      if (!el) return;
      const key = member.uid || member.email;
      const current = el.assignees || [];
      const has = current.some(a => (a.uid || a.email) === key);

      // The renderer redraws on `element:update`, which this emits.
      this.store.updateElement(frameId, {
        assignees: has
          ? current.filter(a => (a.uid || a.email) !== key)
          : [...current, member],
      });
    }

    /* ---- the assign popover ------------------------------------------ */

    openAssignPanel(frameId, anchor) {
      document.querySelector('.frame-assign')?.remove();

      const el = this.store.get(frameId);
      if (!el || el.type !== 'frame') return;

      const people = this.members();
      const pop = document.createElement('div');
      pop.className = 'frame-assign';

      const head = document.createElement('div');
      head.className = 'frame-assign-head';
      head.innerHTML = `<strong>Who owns this area?</strong>` +
        `<small>${escapeHTML(el.content || 'Frame')}</small>`;
      pop.appendChild(head);

      if (!people.length) {
        const empty = document.createElement('p');
        empty.className = 'frame-assign-empty';
        empty.textContent = this.store.state.projectId
          ? 'This project has no members yet. Add people in Projects → the project menu → People.'
          : 'This board is not part of a project yet, so there is no team to assign from.';
        pop.appendChild(empty);
      }

      const list = document.createElement('div');
      list.className = 'frame-assign-list';
      for (const m of people) {
        const on = this.isAssigned(frameId, m);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'frame-assign-row' + (on ? ' is-on' : '');
        row.innerHTML =
          avatarHTML(m) +
          `<span class="frame-assign-name"><strong>${escapeHTML(m.name)}</strong>` +
          `<small>${escapeHTML(m.email)}</small></span>` +
          `<i class="ph ${on ? 'ph-check-circle' : 'ph-circle'}"></i>`;
        row.addEventListener('click', () => {
          this.toggle(frameId, m);
          this.openAssignPanel(frameId, anchor);
        });
        list.appendChild(row);
      }
      pop.appendChild(list);

      const foot = document.createElement('div');
      foot.className = 'frame-assign-foot';

      const tasksBtn = document.createElement('button');
      tasksBtn.type = 'button';
      tasksBtn.className = 'btn btn-ghost full';
      tasksBtn.innerHTML = '<i class="ph ph-list-checks"></i> Create tasks from this area';
      tasksBtn.addEventListener('click', () => { pop.remove(); this.createTasks(frameId); });
      foot.appendChild(tasksBtn);
      pop.appendChild(foot);

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

    /* ---- frame contents ---------------------------------------------- */

    /** Every element whose centre falls inside the frame. */
    contents(frameId) {
      const f = this.store.get(frameId);
      if (!f) return [];
      return this.store.elements.filter(el => {
        if (el.id === frameId || el.type === 'frame') return false;
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        return cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height;
      });
    }

    /**
     * Turn an area into tracked work.
     *
     * One task per object that carries text, assigned to whoever owns the
     * frame, in the project the board belongs to. This is the point of
     * assigning a frame: the area stops being a drawing and becomes work
     * someone is accountable for.
     */
    async createTasks(frameId) {
      const frame = this.store.get(frameId);
      const store = global.PMWorkStore || global.workStore;
      const projectId = this.store.state.projectId;

      if (!store || !projectId) {
        global.Modal?.toast(
          'This board is not part of a project yet, so there is nowhere to put the tasks.',
          'warn', 5000);
        return;
      }

      const owners = (frame.assignees || []).map(a => a.uid || a.email).filter(Boolean);
      const items = this.contents(frameId).filter(el => (el.content || '').trim());

      if (!items.length) {
        global.Modal?.toast('Nothing inside this frame has any text to make a task from.', 'info', 4000);
        return;
      }

      const ok = await global.Modal.confirm(
        `${items.length} object${items.length === 1 ? '' : 's'} inside "${frame.content || 'this frame'}" ` +
        `will become task${items.length === 1 ? '' : 's'}` +
        (owners.length ? `, assigned to ${(frame.assignees).map(a => a.name || a.email).join(', ')}.` : '.'),
        { title: 'Create tasks from this area', confirmLabel: 'Create tasks' });
      if (!ok) return;

      let made = 0;
      for (const el of items) {
        const title = (el.content || '').trim().split('\n')[0].slice(0, 140);
        if (!title) continue;
        try {
          const task = store.createTask({
            projectId,
            title,
            assignees: owners,
            // Keep the link both ways so the task can fly back to the object.
            boardRefs: [{ boardId: this.store.state.id, elementId: el.id }],
            description: `From the "${frame.content || 'Frame'}" area of the whiteboard.`,
          });
          if (task) made++;
        } catch (err) {
          console.error('[frames] could not create task', err);
        }
      }

      global.Modal?.toast(
        made ? `Created ${made} task${made === 1 ? '' : 's'} in this project.`
             : 'No tasks were created — see the console.',
        made ? 'success' : 'warn', 4000);
    }

    /* ---- overview ----------------------------------------------------- */

    /** Every frame on the board with who owns it — the "areas" view. */
    all() {
      return this.store.elements
        .filter(el => el.type === 'frame')
        .map(f => ({
          id: f.id,
          name: f.content || 'Untitled area',
          assignees: f.assignees || [],
          count: this.contents(f.id).length,
        }));
    }

    openOverview() {
      const areas = this.all();
      const body = document.createElement('div');
      body.className = 'frame-overview';

      if (!areas.length) {
        body.innerHTML =
          '<p class="modal-text">No frames on this board yet. Press <kbd>F</kbd> and drag ' +
          'to mark out an area, then assign it to someone.</p>';
      }

      for (const a of areas) {
        const row = document.createElement('div');
        row.className = 'frame-overview-row';

        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'frame-overview-go';
        go.innerHTML =
          `<span class="frame-overview-name"><strong>${escapeHTML(a.name)}</strong>` +
          `<small>${a.count} object${a.count === 1 ? '' : 's'}</small></span>`;
        go.addEventListener('click', () => {
          handle.close();
          this.app.store.select([a.id]);
          this.app.viewport?.zoomToSelection?.();
        });

        const who = document.createElement('div');
        who.className = 'frame-overview-who';
        if (a.assignees.length) {
          who.innerHTML = a.assignees.map(avatarHTML).join('');
          who.title = a.assignees.map(m => m.name || m.email).join(', ');
        } else {
          who.innerHTML = '<span class="frame-overview-none">Unassigned</span>';
        }

        const assign = document.createElement('button');
        assign.type = 'button';
        assign.className = 'btn btn-ghost';
        assign.textContent = a.assignees.length ? 'Change' : 'Assign';
        assign.addEventListener('click', () => this.openAssignPanel(a.id, assign));

        row.append(go, who, assign);
        body.appendChild(row);
      }

      const handle = global.Modal.open({
        title: 'Areas & owners',
        body,
        width: 560,
        actions: [{ label: 'Done' }],
      });
      return handle;
    }
  }

  function avatarHTML(m) {
    if (m.photoURL) {
      return `<span class="frame-av" style="background-image:url('${escapeHTML(m.photoURL)}')"></span>`;
    }
    const initial = escapeHTML((m.name || m.email || '?').trim().charAt(0).toUpperCase());
    const bg = escapeHTML(m.color || colorFor(m.uid || m.email));
    return `<span class="frame-av" style="background:${bg}">${initial}</span>`;
  }

  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.Frames = Frames;
})(window);
