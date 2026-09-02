/* ================================================================
   pm/views.js — Board, List, Calendar, Timeline, Workload
   ----------------------------------------------------------------
   Five ways to look at the same tasks. They share one filter object
   and one store, so a filter set on List survives a jump to Calendar,
   and a drag on the Board is the same `store.moveTask()` call as a
   drag on the Timeline.

   Each view implements:
       mount(hostEl)   attach and do first paint
       render()        repaint from the store (called on every change)
       destroy()       release listeners

   Views never keep their own copy of task data. They read from the
   store on every render. That is slightly more work per frame and it
   is the reason a remote edit from a teammate shows up correctly
   instead of fighting a stale local cache.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;
  const U = global.PMUI;
  const { h, esc } = U;

  /* ================================================================
     BaseView
     ================================================================ */

  class BaseView {
    constructor(ctx) {
      this.ctx = ctx;                 // { store, hub, getState, setState }
      this.store = ctx.store;
      this.hub = ctx.hub;
      this.el = null;
      this._unsub = [];
    }
    get state() { return this.ctx.getState(); }
    get project() { return this.store.project(this.state.projectId); }

    /** Tasks for this view, already filtered and sorted. */
    tasks({ roots = true } = {}) {
      const p = this.project;
      if (!p) return [];
      const st = this.state;
      let list = roots ? this.store.rootTasks(p.id) : this.store.projectTasks(p.id);
      list = list.filter(t => S.matchesFilter(p, t, st.filter));
      return S.sortTasks(list, st.sort, st.dir);
    }

    members() { return (this.project?.members || []).filter(m => m.status !== 'removed'); }
    membersOf(keys) {
      const p = this.project;
      return (keys || []).map(k => this.store.member(p.id, k)).filter(Boolean);
    }

    mount(host) {
      this.el = h('div', { class: `pm-view-body pm-view-${this.constructor.viewId}` });
      host.replaceChildren(this.el);
      this.render();
      return this;
    }

    destroy() {
      for (const off of this._unsub) { try { off(); } catch {} }
      this._unsub = [];
      this.el?.remove();
      this.el = null;
    }

    openTask(id) { this.hub.taskPanel.open(id); }

    emptyState(icon, title, body, action) {
      return h('div', { class: 'pm-empty' }, [
        h('i', { class: `ph ${icon}` }),
        h('h3', { text: title }),
        h('p', { text: body }),
        action,
      ]);
    }
  }

  /* ================================================================
     BoardView — Kanban
     ================================================================ */

  class BoardView extends BaseView {
    static viewId = 'board';
    static label = 'Board';
    static icon = 'ph-kanban';

    render() {
      const p = this.project;
      if (!p) return;
      const scrollLeft = this.el.querySelector('.pm-board')?.scrollLeft || 0;

      const groupKey = this.state.group === 'status' ? 'status' : this.state.group;
      const columns = this._columns(groupKey);
      const board = h('div', { class: 'pm-board' });

      for (const col of columns) board.append(this._column(col, p));

      if (groupKey === 'status' && this.store.can('project.edit', p.id)) {
        board.append(h('button', {
          type: 'button', class: 'pm-col-add',
          onclick: e => this._addStatusPop(e.currentTarget, p),
        }, [h('i', { class: 'ph ph-plus' }), 'Add status']));
      }

      this.el.replaceChildren(board);
      board.scrollLeft = scrollLeft;
    }

    /** Column descriptors for whichever grouping is active. */
    _columns(groupKey) {
      const p = this.project;
      const all = this.tasks();
      const grouped = S.groupTasks(all, groupKey);

      if (groupKey === 'status') {
        return p.statuses.map(s => ({
          key: s.id, name: s.name, color: s.color, kind: s.kind,
          tasks: S.sortTasks(grouped.get(s.id) || [], 'manual'),
          wip: p.settings?.wipLimits?.[s.id] || null,
          droppable: { statusId: s.id },
        }));
      }

      if (groupKey === 'assignee') {
        const cols = this.members().map(m => ({
          key: this.store.memberKey(m), name: m.name || m.email, color: m.color,
          avatar: m, tasks: grouped.get(this.store.memberKey(m)) || [],
          droppable: { assignee: this.store.memberKey(m) },
        }));
        cols.unshift({ key: '__none', name: 'Unassigned', color: '#929aab', tasks: grouped.get('__none') || [], droppable: { assignee: null } });
        return cols;
      }

      if (groupKey === 'priority') {
        const cols = S.PRIORITIES.slice().reverse().map(pr => ({
          key: pr.id, name: pr.name, color: pr.color,
          tasks: grouped.get(pr.id) || [], droppable: { priority: pr.id },
        }));
        cols.push({ key: '__none', name: 'No priority', color: '#929aab', tasks: grouped.get('__none') || [], droppable: { priority: null } });
        return cols;
      }

      if (groupKey === 'list') {
        return p.lists.map(l => ({
          key: l.id, name: l.name, color: l.color,
          tasks: grouped.get(l.id) || [], droppable: { listId: l.id },
        }));
      }

      if (groupKey === 'sprint') {
        const cols = p.sprints.map(s => ({
          key: s.id, name: s.name, color: '#4262ff',
          tasks: grouped.get(s.id) || [], droppable: { sprintId: s.id },
        }));
        cols.unshift({ key: '__none', name: 'Backlog', color: '#929aab', tasks: grouped.get('__none') || [], droppable: { sprintId: null } });
        return cols;
      }

      return [...grouped.entries()].map(([k, tasks]) => ({ key: k, name: k === '__all' ? 'All tasks' : k, color: '#4262ff', tasks }));
    }

    _column(col, p) {
      const over = col.wip && col.tasks.length > col.wip;
      const collapsed = this.state.collapsed?.includes(col.key);

      const head = h('div', { class: `pm-col-head${over ? ' is-over-wip' : ''}` }, [
        h('button', {
          type: 'button', class: 'pm-col-collapse', title: collapsed ? 'Expand' : 'Collapse',
          onclick: () => this.ctx.toggleCollapsed(col.key),
        }, [h('i', { class: `ph ${collapsed ? 'ph-caret-right' : 'ph-caret-down'}` })]),
        col.avatar ? h('span', { class: 'pm-col-av', html: U.avatarHTML(col.avatar, 20) })
                   : h('span', { class: 'pm-col-dot', style: { background: col.color } }),
        h('span', { class: 'pm-col-name', text: col.name }),
        h('span', { class: 'pm-col-count', text: String(col.tasks.length) + (col.wip ? `/${col.wip}` : '') }),
        h('button', {
          type: 'button', class: 'pm-col-menu', title: 'Column options',
          onclick: e => this._columnMenu(e.currentTarget, col, p),
        }, [h('i', { class: 'ph ph-dots-three' })]),
      ]);

      const body = h('div', { class: 'pm-col-body', data: { drop: JSON.stringify(col.droppable || {}), colkey: col.key } });

      if (!collapsed) {
        for (const t of col.tasks) body.append(this._card(t, p, col));

        if (this.store.can('task.create', p.id)) {
          body.append(h('button', {
            type: 'button', class: 'pm-card-add',
            onclick: e => this._quickAdd(e.currentTarget, col, p),
          }, [h('i', { class: 'ph ph-plus' }), 'Add task']));
        }
      }

      const colEl = h('div', {
        class: `pm-col${collapsed ? ' is-collapsed' : ''}${over ? ' is-over-wip' : ''}`,
        data: { colkey: col.key },
      }, [head, body]);

      if (over) {
        head.append(h('span', { class: 'pm-wip-warn', title: `Over the WIP limit of ${col.wip}` }, [h('i', { class: 'ph-fill ph-warning' })]));
      }
      return colEl;
    }

    _card(t, p, col) {
      const status = S.statusOf(p, t);
      const subs = this.store.subtasks(t.id);
      const blocked = this.store.isBlocked(t.id);
      const ck = S.checklistProgress(t);
      const overdue = S.isOverdue(p, t);
      const logged = S.loggedMinutes(t);

      const card = h('article', {
        class: `pm-card${overdue ? ' is-overdue' : ''}${blocked ? ' is-blocked' : ''}${S.isDone(p, t) ? ' is-done' : ''}`,
        data: { taskid: t.id },
        tabindex: '0',
      });

      card.append(
        h('div', { class: 'pm-card-top' }, [
          h('span', { class: 'pm-card-strip', style: { background: status.color } }),
          t.priority ? h('span', { class: 'pm-card-prio', html: U.priorityChipHTML(t.priority, { compact: true }) }) : null,
          blocked ? h('span', { class: 'pm-card-flag', title: 'Blocked by another task' }, [h('i', { class: 'ph-fill ph-warning-octagon' })]) : null,
        ]),
        h('p', { class: 'pm-card-title', text: t.title }),
      );

      if (t.tags.length) {
        card.append(h('div', { class: 'pm-card-tags', html: t.tags.slice(0, 3).map(U.tagChipHTML).join('') }));
      }

      const metaBits = [];
      if (t.dueDate) metaBits.push(U.dueChipHTML(p, t));
      if (subs.length) metaBits.push(`<span class="pm-card-meta-bit" title="Subtasks"><i class="ph ph-tree-structure"></i>${subs.filter(s => S.isDone(p, s)).length}/${subs.length}</span>`);
      if (ck) metaBits.push(`<span class="pm-card-meta-bit" title="Checklist"><i class="ph ph-check-square-offset"></i>${ck.done}/${ck.total}</span>`);
      if (t.comments.length) metaBits.push(`<span class="pm-card-meta-bit" title="Comments"><i class="ph ph-chat-circle"></i>${t.comments.length}</span>`);
      if (t.attachments.length) metaBits.push(`<span class="pm-card-meta-bit" title="Attachments"><i class="ph ph-paperclip"></i>${t.attachments.length}</span>`);
      if (logged) metaBits.push(`<span class="pm-card-meta-bit" title="Time logged"><i class="ph ph-clock"></i>${esc(S.formatMinutes(logged))}</span>`);

      card.append(h('div', { class: 'pm-card-foot' }, [
        h('div', { class: 'pm-card-meta', html: metaBits.join('') }),
        h('button', {
          type: 'button', class: 'pm-card-assign pm-no-drag',
          title: t.assignees.length ? 'Change assignees' : 'Assign someone',
          html: U.avatarStackHTML(this.membersOf(t.assignees), { max: 3, size: 22 }),
          onclick: e => {
            e.stopPropagation();
            U.memberPicker(e.currentTarget, p.members, t.assignees, keys => this.store.assign(t.id, keys));
          },
        }),
      ]));

      if (subs.length) {
        card.append(h('div', { class: 'pm-card-progress', html: U.progressBarHTML(S.progressOf(p, t, subs), { color: status.color }) }));
      }

      card.addEventListener('click', e => {
        if (e.target.closest('.pm-no-drag')) return;
        this.openTask(t.id);
      });
      card.addEventListener('keydown', e => { if (e.key === 'Enter') this.openTask(t.id); });
      card.addEventListener('contextmenu', e => { e.preventDefault(); this._cardMenu(card, t, p); });

      if (this.store.can('task.edit', p.id)) this._wireDrag(card, t, col);
      return card;
    }

    /** Drag a card between columns and to a position within one. */
    _wireDrag(card, task, col) {
      let marker = null;

      const clearMarker = () => { marker?.remove(); marker = null; };

      U.makeDraggable(card, {
        data: { taskId: task.id, from: col.key },

        onMove: (_data, under) => {
          const body = under?.closest('.pm-col-body');
          this.el.querySelectorAll('.pm-col-body.is-drop').forEach(x => x.classList.remove('is-drop'));
          if (!body) { clearMarker(); return; }
          body.classList.add('is-drop');

          // Insert a placeholder at the nearest card boundary so the
          // drop position is visible before the pointer is released.
          const cards = [...body.querySelectorAll('.pm-card:not(.pm-dragging)')];
          const y = (window.event?.clientY) ?? 0;
          const next = cards.find(c => {
            const r = c.getBoundingClientRect();
            return y < r.top + r.height / 2;
          });
          if (!marker) marker = h('div', { class: 'pm-drop-marker' });
          body.insertBefore(marker, next || body.querySelector('.pm-card-add'));
        },

        onDrop: (_data, under) => {
          this.el.querySelectorAll('.pm-col-body.is-drop').forEach(x => x.classList.remove('is-drop'));
          const body = under?.closest('.pm-col-body');
          if (!body) { clearMarker(); return; }

          const target = this._columns(this.state.group).find(c => c.key === body.dataset.colkey);
          if (!target) { clearMarker(); return; }

          // Neighbours are read from the marker position, so the drop
          // lands exactly where the placeholder showed it would.
          let beforeId = null, afterId = null;
          if (marker && marker.parentElement === body) {
            const prevCard = marker.previousElementSibling?.closest('.pm-card');
            const nextCard = marker.nextElementSibling?.closest('.pm-card');
            afterId = prevCard?.dataset.taskid || null;
            beforeId = nextCard?.dataset.taskid || null;
          }
          clearMarker();

          const move = { beforeId, afterId };
          const d = target.droppable || {};
          if ('statusId' in d) move.statusId = d.statusId;
          if ('listId' in d) move.listId = d.listId;
          if ('sprintId' in d) move.sprintId = d.sprintId;

          if ('assignee' in d) {
            this.store.assign(task.id, d.assignee ? [d.assignee] : []);
          } else if ('priority' in d) {
            this.store.updateTask(task.id, { priority: d.priority });
          }
          this.store.moveTask(task.id, move);
        },
      });
    }

    _quickAdd(anchor, col, p) {
      const holder = anchor.parentElement;
      const input = h('input', { class: 'pm-card-add-input', placeholder: 'Task name, Enter to add' });
      const row = h('div', { class: 'pm-card pm-card-new' }, [input]);
      holder.insertBefore(row, anchor);
      input.focus();

      // createTask() triggers a synchronous full board re-render (tasks-changed),
      // so `row`/`input` are detached the instant it returns — reusing them
      // afterward silently did nothing, which read as "Enter doesn't add the
      // next task". `done` also guards against the blur handler (fired when
      // the detached input loses focus) re-committing the same text a second
      // time, or committing text the user had just cancelled with Escape.
      let done = false;
      const commit = (keepOpen) => {
        if (done) return;
        const v = input.value.trim();
        if (!v) { row.remove(); return; }
        done = true;
        const props = { projectId: p.id, title: v };
        const d = col.droppable || {};
        if ('statusId' in d) props.statusId = d.statusId;
        if ('listId' in d) props.listId = d.listId;
        if ('sprintId' in d) props.sprintId = d.sprintId;
        if ('assignee' in d && d.assignee) props.assignees = [d.assignee];
        if ('priority' in d) props.priority = d.priority;
        this.store.createTask(props);
        if (keepOpen) {
          const freshAnchor = this.el.querySelector(`[data-colkey="${CSS.escape(col.key)}"] .pm-card-add`);
          if (freshAnchor) this._quickAdd(freshAnchor, col, p);
        } else {
          row.remove();
        }
      };

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { done = true; row.remove(); }
      });
      input.addEventListener('blur', () => setTimeout(() => commit(false), 120));
    }

    _columnMenu(anchor, col, p) {
      const items = [];
      if (this.state.group === 'status') {
        items.push(
          { label: 'Rename status', icon: 'ph-pencil-simple', onClick: () => this._renameStatus(col, p) },
          { label: 'Set WIP limit', icon: 'ph-gauge', onClick: () => this._setWip(col, p) },
          '-',
        );
      }
      items.push(
        { label: 'Select all in column', icon: 'ph-selection-all', onClick: () => this.ctx.selectMany(col.tasks.map(t => t.id)) },
        { label: 'Sort by priority', icon: 'ph-sort-descending', onClick: () => this._sortColumn(col, 'priority') },
        { label: 'Sort by due date', icon: 'ph-calendar-blank', onClick: () => this._sortColumn(col, 'dueDate') },
      );
      if (this.state.group === 'status' && p.statuses.length > 1 && this.store.can('project.edit', p.id)) {
        items.push('-', {
          label: 'Delete status', icon: 'ph-trash', danger: true,
          onClick: async () => {
            if (await U.confirm(`Tasks in "${col.name}" will move to the first status.`, { title: 'Delete status?', okLabel: 'Delete', danger: true })) {
              this.store.removeStatus(p.id, col.key);
            }
          },
        });
      }
      U.menu(anchor, items, { align: 'end', width: 220 });
    }

    /** Rewrite the manual order of one column to match a field sort. */
    _sortColumn(col, key) {
      const sorted = S.sortTasks(col.tasks, key, key === 'priority' ? 'asc' : 'asc');
      this.store.transact('sort column', () => {
        let prev = '';
        for (const t of sorted) {
          const next = S.orderBetween(prev, '');
          this.store.updateTask(t.id, { order: next }, { silentActivity: true });
          prev = next;
        }
      });
    }

    _renameStatus(col, p) {
      const next = prompt('Status name', col.name);
      if (next && next.trim()) this.store.updateStatus(p.id, col.key, { name: next.trim() });
    }

    _setWip(col, p) {
      const cur = p.settings?.wipLimits?.[col.key] || '';
      const next = prompt(`Maximum tasks in "${col.name}" (blank for no limit)`, cur);
      if (next === null) return;
      const n = parseInt(next, 10);
      const limits = { ...(p.settings?.wipLimits || {}) };
      if (isNaN(n) || n <= 0) delete limits[col.key]; else limits[col.key] = n;
      this.store.updateProject(p.id, { settings: { ...p.settings, wipLimits: limits } });
    }

    _addStatusPop(anchor, p) {
      const name = h('input', { class: 'input', placeholder: 'Status name' });
      const kindSel = h('select', { class: 'input' }, S.STATUS_KINDS.map(k => h('option', { value: k, text: k })));
      kindSel.value = 'todo';
      const colorInp = h('input', { type: 'color', class: 'pm-color-input', value: '#4262ff' });

      U.Pop.open(anchor, h('div', {}, [
        h('div', { class: 'pm-pop-title', text: 'New status' }),
        name,
        h('label', { class: 'pm-pop-label' }, ['Behaves like', kindSel]),
        h('label', { class: 'pm-pop-label' }, ['Colour', colorInp]),
        h('button', {
          type: 'button', class: 'btn btn-primary pm-pop-go', text: 'Add status',
          onclick: () => {
            if (!name.value.trim()) return;
            this.store.addStatus(p.id, { name: name.value.trim(), kind: kindSel.value, color: colorInp.value });
            U.Pop.close();
          },
        }),
      ]), { width: 240, className: 'pm-pop-form' });
    }

    _cardMenu(anchor, t, p) {
      U.menu(anchor, [
        { label: 'Open', icon: 'ph-arrow-square-out', onClick: () => this.openTask(t.id) },
        { label: 'Assign…', icon: 'ph-user-plus', onClick: () => U.memberPicker(anchor, p.members, t.assignees, keys => this.store.assign(t.id, keys)) },
        { label: 'Due date…', icon: 'ph-calendar-blank', onClick: () => U.datePicker(anchor, t.dueDate, iso => this.store.updateTask(t.id, { dueDate: iso })) },
        { label: 'Priority…', icon: 'ph-flag', onClick: () => U.priorityPicker(anchor, t.priority, id => this.store.updateTask(t.id, { priority: id })) },
        '-',
        { label: 'Duplicate', icon: 'ph-copy', onClick: () => this.store.duplicateTask(t.id) },
        { label: 'Send to whiteboard', icon: 'ph-chalkboard', onClick: () => this.hub.sendTaskToCanvas?.(t.id) },
        '-',
        {
          label: 'Delete', icon: 'ph-trash', danger: true,
          onClick: async () => {
            if (await U.confirm(`"${t.title}" will be deleted.`, { title: 'Delete task?', okLabel: 'Delete', danger: true })) this.store.deleteTask(t.id);
          },
        },
      ], { width: 220 });
    }
  }

  /* ================================================================
     ListView — a dense, editable table
     ================================================================ */

  class ListView extends BaseView {
    static viewId = 'list';
    static label = 'List';
    static icon = 'ph-list-bullets';

    constructor(ctx) {
      super(ctx);
      this.expanded = new Set();
    }

    render() {
      const p = this.project;
      if (!p) return;
      // The whole list is torn down and rebuilt on every task change
      // (see tasks-changed in hub.js), which used to reset scroll to the
      // top and drop any in-progress focus/picker on every single click —
      // reads as the list "crashing". Restore both across the rebuild.
      const scrollTop = this.el.scrollTop || 0;
      const focused = document.activeElement;
      const focusedGroup = focused?.closest?.('[data-groupkey]')?.dataset.groupkey;
      const focusedWasAdd = focused?.classList?.contains('pm-list-add');

      const grouped = S.groupTasks(this.tasks(), this.state.group);
      const wrap = h('div', { class: 'pm-list' });
      wrap.append(this._headerRow(p));

      const order = this._groupOrder(p, grouped);
      if (!order.length) {
        wrap.append(this.emptyState('ph-list-checks', 'Nothing here yet',
          'Create a task, or clear your filters to see everything.',
          h('button', { type: 'button', class: 'btn btn-primary', text: 'New task', onclick: () => this.ctx.newTask() })));
      }

      for (const g of order) {
        const tasks = grouped.get(g.key) || [];
        if (!tasks.length && this.state.group !== 'status') continue;
        wrap.append(this._groupHeader(g, tasks, p));
        const body = h('div', { class: 'pm-list-group', data: { groupkey: g.key } });
        for (const t of tasks) this._renderRow(body, t, p, 0);
        if (this.store.can('task.create', p.id)) body.append(this._addRow(g, p));
        wrap.append(body);
      }

      this.el.replaceChildren(wrap);
      this.el.scrollTop = scrollTop;
      if (focusedWasAdd && focusedGroup) {
        const fresh = wrap.querySelector(`[data-groupkey="${CSS.escape(focusedGroup)}"] .pm-list-add`);
        if (fresh) fresh.focus();
      }
    }

    _groupOrder(p, grouped) {
      const k = this.state.group;
      if (k === 'status') return p.statuses.map(s => ({ key: s.id, name: s.name, color: s.color, seed: { statusId: s.id } }));
      if (k === 'priority') return [...S.PRIORITIES].reverse().map(x => ({ key: x.id, name: x.name, color: x.color, seed: { priority: x.id } }))
        .concat([{ key: '__none', name: 'No priority', color: '#929aab', seed: {} }]);
      if (k === 'assignee') return [{ key: '__none', name: 'Unassigned', color: '#929aab', seed: {} }]
        .concat(this.members().map(m => ({ key: this.store.memberKey(m), name: m.name || m.email, color: m.color, avatar: m, seed: { assignees: [this.store.memberKey(m)] } })));
      if (k === 'list') return p.lists.map(l => ({ key: l.id, name: l.name, color: l.color, seed: { listId: l.id } }));
      if (k === 'sprint') return [{ key: '__none', name: 'Backlog', color: '#929aab', seed: {} }]
        .concat(p.sprints.map(s => ({ key: s.id, name: s.name, color: '#4262ff', seed: { sprintId: s.id } })));
      if (k === 'none') return [{ key: '__all', name: 'All tasks', color: '#4262ff', seed: {} }];
      return [...grouped.keys()].map(key => ({ key, name: key === '__none' ? 'None' : key, color: '#4262ff', seed: {} }));
    }

    _headerRow(p) {
      const cols = this._columns(p);
      return h('div', { class: 'pm-list-head', style: { '--cols': cols.map(c => c.width).join(' ') } },
        cols.map(c => h('button', {
          type: 'button',
          class: `pm-lh${this.state.sort === c.sort ? ' is-sorted' : ''}`,
          disabled: !c.sort,
          onclick: () => c.sort && this.ctx.setSort(c.sort),
        }, [
          c.label,
          this.state.sort === c.sort ? h('i', { class: `ph ph-caret-${this.state.dir === 'asc' ? 'up' : 'down'}` }) : null,
        ])));
    }

    _columns(p) {
      const base = [
        { key: 'title', label: 'Task', width: 'minmax(240px, 3fr)', sort: 'title' },
        { key: 'assignees', label: 'Assignees', width: '130px' },
        { key: 'status', label: 'Status', width: '140px' },
        { key: 'priority', label: 'Priority', width: '110px', sort: 'priority' },
        { key: 'dueDate', label: 'Due', width: '110px', sort: 'dueDate' },
        { key: 'estimate', label: 'Estimate', width: '96px', sort: 'estimate' },
      ];
      for (const f of (p.customFields || []).filter(f => f.showInList)) {
        base.push({ key: 'cf:' + f.id, label: f.name, width: '120px', field: f });
      }
      base.push({ key: 'actions', label: '', width: '40px' });
      return base;
    }

    _groupHeader(g, tasks, p) {
      const done = tasks.filter(t => S.isDone(p, t)).length;
      return h('div', { class: 'pm-list-group-head' }, [
        g.avatar ? h('span', { html: U.avatarHTML(g.avatar, 20) }) : h('span', { class: 'pm-col-dot', style: { background: g.color } }),
        h('strong', { text: g.name }),
        h('span', { class: 'pm-col-count', text: String(tasks.length) }),
        tasks.length ? h('span', { class: 'pm-list-group-prog', html: U.progressBarHTML(Math.round((done / tasks.length) * 100), { color: g.color }) }) : null,
      ]);
    }

    _renderRow(host, t, p, depth) {
      host.append(this._row(t, p, depth));
      if (!this.expanded.has(t.id)) return;
      for (const st of this.store.subtasks(t.id)) {
        if (!S.matchesFilter(p, st, this.state.filter)) continue;
        this._renderRow(host, st, p, depth + 1);
      }
    }

    _row(t, p, depth) {
      const cols = this._columns(p);
      const status = S.statusOf(p, t);
      const subs = this.store.subtasks(t.id);
      const selected = this.ctx.isSelected(t.id);
      const blocked = this.store.isBlocked(t.id);

      const row = h('div', {
        class: `pm-lr${selected ? ' is-selected' : ''}${S.isDone(p, t) ? ' is-done' : ''}${S.isOverdue(p, t) ? ' is-overdue' : ''}`,
        style: { '--cols': cols.map(c => c.width).join(' '), '--depth': depth },
        data: { taskid: t.id },
      });

      // -- Task cell
      const titleCell = h('div', { class: 'pm-lc pm-lc-title' }, [
        h('input', {
          type: 'checkbox', class: 'pm-lr-select pm-no-drag', checked: selected,
          onclick: e => { e.stopPropagation(); this.ctx.toggleSelected(t.id, e.shiftKey); },
        }),
        subs.length
          ? h('button', {
              type: 'button', class: 'pm-lr-twisty pm-no-drag',
              onclick: e => {
                e.stopPropagation();
                this.expanded.has(t.id) ? this.expanded.delete(t.id) : this.expanded.add(t.id);
                this.render();
              },
            }, [h('i', { class: `ph ph-caret-${this.expanded.has(t.id) ? 'down' : 'right'}` })])
          : h('span', { class: 'pm-lr-twisty is-empty' }),
        h('button', {
          type: 'button', class: 'pm-lr-check pm-no-drag', title: S.isDone(p, t) ? 'Reopen' : 'Complete',
          onclick: e => {
            e.stopPropagation();
            const done = p.statuses.find(s => s.kind === 'done');
            const open = p.statuses.find(s => s.kind === 'todo') || p.statuses[0];
            this.store.updateTask(t.id, { statusId: S.isDone(p, t) ? open.id : (done || p.statuses.at(-1)).id });
          },
        }, [h('i', { class: `ph ${S.isDone(p, t) ? 'ph-check-circle' : 'ph-circle'}` })]),
        blocked ? h('i', { class: 'ph-fill ph-warning-octagon pm-lr-blocked', title: 'Blocked' }) : null,
        h('span', { class: 'pm-lr-title', text: t.title }),
        t.tags.length ? h('span', { class: 'pm-lr-tags', html: t.tags.slice(0, 2).map(U.tagChipHTML).join('') }) : null,
        t.comments.length ? h('span', { class: 'pm-lr-badge', title: 'Comments' }, [h('i', { class: 'ph ph-chat-circle' }), String(t.comments.length)]) : null,
      ]);

      // Double-click the title to rename without leaving the list.
      titleCell.querySelector('.pm-lr-title').addEventListener('dblclick', e => {
        e.stopPropagation();
        U.editInline(e.currentTarget, t.title, next => {
          if (next) this.store.updateTask(t.id, { title: next });
          this.render();
        });
      });
      row.append(titleCell);

      // -- Assignees
      row.append(h('div', { class: 'pm-lc' }, [h('button', {
        type: 'button', class: 'pm-lc-btn pm-no-drag',
        html: U.avatarStackHTML(this.membersOf(t.assignees), { max: 3, size: 22 }),
        onclick: e => { e.stopPropagation(); U.memberPicker(e.currentTarget, p.members, t.assignees, keys => this.store.assign(t.id, keys)); },
      })]));

      // -- Status
      row.append(h('div', { class: 'pm-lc' }, [h('button', {
        type: 'button', class: 'pm-lc-btn pm-no-drag', html: U.statusPillHTML(status),
        onclick: e => { e.stopPropagation(); U.statusPicker(e.currentTarget, p.statuses, t.statusId, id => this.store.updateTask(t.id, { statusId: id })); },
      })]));

      // -- Priority
      row.append(h('div', { class: 'pm-lc' }, [h('button', {
        type: 'button', class: 'pm-lc-btn pm-no-drag', html: U.priorityChipHTML(t.priority, { compact: false }),
        onclick: e => { e.stopPropagation(); U.priorityPicker(e.currentTarget, t.priority, id => this.store.updateTask(t.id, { priority: id })); },
      })]));

      // -- Due
      row.append(h('div', { class: 'pm-lc' }, [h('button', {
        type: 'button', class: 'pm-lc-btn pm-no-drag',
        html: t.dueDate ? U.dueChipHTML(p, t) : '<span class="pm-lc-dim">—</span>',
        onclick: e => { e.stopPropagation(); U.datePicker(e.currentTarget, t.dueDate, (iso, time) => this.store.updateTask(t.id, { dueDate: iso, dueTime: time ?? t.dueTime }), { withTime: true, currentTime: t.dueTime }); },
      })]));

      // -- Estimate / logged
      const logged = S.loggedMinutes(t);
      row.append(h('div', { class: 'pm-lc pm-lc-est' }, [
        h('span', { text: t.estimateMinutes ? S.formatMinutes(t.estimateMinutes) : '—' }),
        logged ? h('small', { class: logged > (t.estimateMinutes || Infinity) ? 'is-over' : '', text: S.formatMinutes(logged) }) : null,
      ]));

      // -- Custom fields
      for (const c of cols.filter(c => c.field)) {
        const v = t.custom?.[c.field.id];
        row.append(h('div', { class: 'pm-lc pm-lc-dim', text: formatFieldValue(c.field, v, this) }));
      }

      // -- Row menu
      row.append(h('div', { class: 'pm-lc' }, [h('button', {
        type: 'button', class: 'pm-lc-btn pm-no-drag',
        onclick: e => { e.stopPropagation(); this._rowMenu(e.currentTarget, t, p); },
      }, [h('i', { class: 'ph ph-dots-three' })])]));

      row.addEventListener('click', e => {
        if (e.target.closest('.pm-no-drag')) return;
        this.openTask(t.id);
      });
      return row;
    }

    _addRow(g, p) {
      const input = h('input', { class: 'pm-list-add', placeholder: '+ New task' });
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        this.store.createTask({ projectId: p.id, title: input.value.trim(), ...(g.seed || {}) });
        input.value = '';
      });
      return h('div', { class: 'pm-list-addrow' }, [input]);
    }

    _rowMenu(anchor, t, p) {
      U.menu(anchor, [
        { label: 'Open details', icon: 'ph-arrow-square-out', onClick: () => this.openTask(t.id) },
        { label: 'Add subtask', icon: 'ph-plus', onClick: () => { const s = this.store.createTask({ projectId: p.id, parentId: t.id, title: 'New subtask' }); this.expanded.add(t.id); this.openTask(s.id); } },
        { label: 'Duplicate', icon: 'ph-copy', onClick: () => this.store.duplicateTask(t.id) },
        '-',
        { label: 'Auto-assign', icon: 'ph-scales', onClick: () => this.store.autoAssign(t.id) },
        { label: 'Send to whiteboard', icon: 'ph-chalkboard', onClick: () => this.hub.sendTaskToCanvas?.(t.id) },
        { label: t.archived ? 'Unarchive' : 'Archive', icon: 'ph-archive', onClick: () => this.store.updateTask(t.id, { archived: !t.archived }) },
        '-',
        {
          label: 'Delete', icon: 'ph-trash', danger: true,
          onClick: async () => {
            if (await U.confirm(`"${t.title}" will be deleted.`, { title: 'Delete task?', okLabel: 'Delete', danger: true })) this.store.deleteTask(t.id);
          },
        },
      ], { align: 'end', width: 220 });
    }
  }

  /* ================================================================
     CalendarView — month grid, drag to reschedule
     ================================================================ */

  class CalendarView extends BaseView {
    static viewId = 'calendar';
    static label = 'Calendar';
    static icon = 'ph-calendar-blank';

    constructor(ctx) {
      super(ctx);
      this.cursor = new Date();
      this.cursor.setDate(1);
    }

    render() {
      const p = this.project;
      if (!p) return;

      const tasks = this.tasks({ roots: false }).filter(t => t.dueDate || t.startDate);
      const byDay = new Map();
      for (const t of tasks) {
        const key = (t.dueDate || t.startDate).slice(0, 10);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(t);
      }

      const grid = h('div', { class: 'pm-cal-month' });
      for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
        grid.append(h('div', { class: 'pm-calm-dow', text: d }));
      }

      const first = new Date(this.cursor);
      const lead = (first.getDay() + 6) % 7;
      const start = new Date(first);
      start.setDate(1 - lead);
      const todayKey = isoLocal(new Date());

      for (let i = 0; i < 42; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const key = isoLocal(day);
        const outside = day.getMonth() !== this.cursor.getMonth();
        const list = byDay.get(key) || [];

        const cell = h('div', {
          class: `pm-calm-day${outside ? ' is-out' : ''}${key === todayKey ? ' is-today' : ''}`,
          data: { day: key },
        }, [
          h('div', { class: 'pm-calm-daynum' }, [
            h('span', { text: String(day.getDate()) }),
            this.store.can('task.create', p.id) ? h('button', {
              type: 'button', class: 'pm-calm-add', title: 'Add a task due this day',
              onclick: () => {
                const t = this.store.createTask({ projectId: p.id, title: 'New task', dueDate: key });
                this.openTask(t.id);
              },
            }, [h('i', { class: 'ph ph-plus' })]) : null,
          ]),
        ]);

        for (const t of list.slice(0, 4)) cell.append(this._pill(t, p));
        if (list.length > 4) {
          cell.append(h('button', {
            type: 'button', class: 'pm-calm-more', text: `+${list.length - 4} more`,
            onclick: e => U.menu(e.currentTarget, list.slice(4).map(t => ({
              label: t.title, icon: 'ph-circle', onClick: () => this.openTask(t.id),
            })), { width: 240 }),
          }));
        }
        grid.append(cell);
      }

      this.el.replaceChildren(h('div', { class: 'pm-calm-wrap' }, [this._nav(), grid]));
    }

    _nav() {
      const label = this.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      return h('div', { class: 'pm-calm-nav' }, [
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { this.cursor.setMonth(this.cursor.getMonth() - 1); this.render(); } }, [h('i', { class: 'ph ph-caret-left' })]),
        h('strong', { text: label }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { this.cursor.setMonth(this.cursor.getMonth() + 1); this.render(); } }, [h('i', { class: 'ph ph-caret-right' })]),
        h('button', { type: 'button', class: 'btn btn-ghost', text: 'Today', onclick: () => { this.cursor = new Date(); this.cursor.setDate(1); this.render(); } }),
      ]);
    }

    _pill(t, p) {
      const status = S.statusOf(p, t);
      const pill = h('button', {
        type: 'button',
        class: `pm-calm-pill${S.isOverdue(p, t) ? ' is-overdue' : ''}${S.isDone(p, t) ? ' is-done' : ''}`,
        style: { '--st': status.color },
        title: `${t.title}${t.dueTime ? ' · ' + t.dueTime : ''}`,
        onclick: () => this.openTask(t.id),
      }, [
        h('span', { class: 'pm-status-dot' }),
        t.dueTime ? h('small', { text: t.dueTime }) : null,
        h('span', { class: 'pm-calm-pill-title', text: t.title }),
        t.assignees.length ? h('span', { class: 'pm-calm-pill-av', html: U.avatarHTML(this.membersOf(t.assignees)[0], 16) }) : null,
      ]);

      if (this.store.can('task.edit', p.id)) {
        U.makeDraggable(pill, {
          data: { taskId: t.id },
          onDrop: (_d, under) => {
            const cell = under?.closest('.pm-calm-day');
            if (cell?.dataset.day && cell.dataset.day !== t.dueDate) {
              this.store.updateTask(t.id, { dueDate: cell.dataset.day });
            }
          },
        });
      }
      return pill;
    }
  }

  /* ================================================================
     TimelineView — Gantt with dependency arrows
     ================================================================ */

  class TimelineView extends BaseView {
    static viewId = 'timeline';
    static label = 'Timeline';
    static icon = 'ph-chart-bar-horizontal';

    constructor(ctx) {
      super(ctx);
      this.dayWidth = 32;
      this.origin = null;
    }

    render() {
      const p = this.project;
      if (!p) return;

      const tasks = S.topoSort(this.tasks({ roots: false }).filter(t => t.startDate || t.dueDate));
      if (!tasks.length) {
        this.el.replaceChildren(this.emptyState('ph-chart-bar-horizontal', 'No dated tasks',
          'Give tasks a start or due date and they will appear on the timeline.'));
        return;
      }

      // Pad the window so bars are never flush against the edge.
      const dates = tasks.flatMap(t => [t.startDate, t.dueDate].filter(Boolean)).map(S.parseDate);
      const min = new Date(Math.min(...dates)); min.setDate(min.getDate() - 3);
      const max = new Date(Math.max(...dates)); max.setDate(max.getDate() + 5);
      this.origin = min;
      const days = Math.max(14, Math.round((max - min) / 86400000) + 1);

      const scale = h('div', { class: 'pm-gantt-scale', style: { '--dw': this.dayWidth + 'px', '--days': days } });
      const todayKey = isoLocal(new Date());
      for (let i = 0; i < days; i++) {
        const d = new Date(min); d.setDate(min.getDate() + i);
        const weekend = d.getDay() === 0 || d.getDay() === 6;
        const monthStart = d.getDate() === 1;
        scale.append(h('div', {
          class: `pm-gantt-tick${weekend ? ' is-weekend' : ''}${isoLocal(d) === todayKey ? ' is-today' : ''}${monthStart ? ' is-month' : ''}`,
        }, [
          monthStart ? h('span', { class: 'pm-gantt-month', text: d.toLocaleDateString(undefined, { month: 'short' }) }) : null,
          h('small', { text: String(d.getDate()) }),
        ]));
      }

      const rows = h('div', { class: 'pm-gantt-rows' });
      const barPos = new Map();

      tasks.forEach((t, i) => {
        const { offset, span } = this._span(t, min, days);
        const status = S.statusOf(p, t);
        barPos.set(t.id, { row: i, offset, span });

        const bar = h('div', {
          class: `pm-gantt-bar${S.isOverdue(p, t) ? ' is-overdue' : ''}${S.isDone(p, t) ? ' is-done' : ''}`,
          style: { '--o': offset, '--s': span, '--st': status.color },
          title: `${t.title}\n${t.startDate || '?'} → ${t.dueDate || '?'}`,
          onclick: () => this.openTask(t.id),
        }, [
          h('span', { class: 'pm-gantt-grip pm-gantt-grip-l', title: 'Drag to change the start date' }),
          h('span', { class: 'pm-gantt-bar-label', text: t.title }),
          t.assignees.length ? h('span', { class: 'pm-gantt-av', html: U.avatarStackHTML(this.membersOf(t.assignees), { max: 2, size: 18 }) }) : null,
          h('span', { class: 'pm-gantt-grip pm-gantt-grip-r', title: 'Drag to change the due date' }),
        ]);

        this._wireBarDrag(bar, t, min);

        rows.append(h('div', { class: 'pm-gantt-row', style: { '--days': days } }, [
          h('div', { class: 'pm-gantt-name', title: t.title }, [
            h('span', { class: 'pm-col-dot', style: { background: status.color } }),
            h('span', { text: t.title }),
          ]),
          h('div', { class: 'pm-gantt-lane', style: { '--dw': this.dayWidth + 'px', '--days': days } }, [bar]),
        ]));
      });

      this.el.replaceChildren(h('div', { class: 'pm-gantt' }, [
        h('div', { class: 'pm-gantt-head' }, [h('div', { class: 'pm-gantt-name-head', text: 'Task' }), scale]),
        h('div', { class: 'pm-gantt-scroll' }, [rows, this._arrows(tasks, barPos, days)]),
      ]));
    }

    _span(t, min, days) {
      const s = S.parseDate(t.startDate) || S.parseDate(t.dueDate);
      const e = S.parseDate(t.dueDate) || s;
      const offset = Math.max(0, Math.round((s - min) / 86400000));
      const span = S.clamp(Math.round((e - s) / 86400000) + 1, 1, days - offset);
      return { offset, span };
    }

    /** SVG overlay drawing blocked_by arrows between bars. */
    _arrows(tasks, barPos, days) {
      const paths = [];
      const rowH = 34, dw = this.dayWidth, nameW = 220;

      for (const t of tasks) {
        for (const dep of t.dependencies || []) {
          if (dep.type !== 'blocked_by') continue;
          const from = barPos.get(dep.taskId);
          const to = barPos.get(t.id);
          if (!from || !to) continue;

          const x1 = nameW + (from.offset + from.span) * dw;
          const y1 = from.row * rowH + rowH / 2;
          const x2 = nameW + to.offset * dw;
          const y2 = to.row * rowH + rowH / 2;
          const midX = Math.max(x1 + 10, x2 - 10);

          paths.push(`<path d="M${x1} ${y1} H${midX} V${y2} H${x2}" />`);
        }
      }
      if (!paths.length) return null;

      const svg = h('svg', { class: 'pm-gantt-arrows', width: nameW + days * dw, height: tasks.length * rowH });
      svg.innerHTML = `
        <defs><marker id="pm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker></defs>
        <g fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#pm-arrow)">${paths.join('')}</g>`;
      return svg;
    }

    /** Drag the body to shift both dates; drag a grip to resize one end. */
    _wireBarDrag(bar, t, min) {
      if (!this.store.can('task.edit', this.project.id)) return;
      const dw = this.dayWidth;

      const apply = (mode, deltaDays) => {
        if (!deltaDays) return;
        const s = S.parseDate(t.startDate) || S.parseDate(t.dueDate);
        const e = S.parseDate(t.dueDate) || s;
        const patch = {};

        if (mode === 'move') {
          if (t.startDate) patch.startDate = shiftISO(s, deltaDays);
          if (t.dueDate) patch.dueDate = shiftISO(e, deltaDays);
        } else if (mode === 'start') {
          const next = shiftISO(s, deltaDays);
          if (!t.dueDate || next <= t.dueDate) patch.startDate = next;
        } else {
          const next = shiftISO(e, deltaDays);
          if (!t.startDate || next >= t.startDate) patch.dueDate = next;
        }
        if (Object.keys(patch).length) this.store.updateTask(t.id, patch);
      };

      let mode = 'move', startX = 0, live = false;

      bar.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        mode = e.target.classList.contains('pm-gantt-grip-l') ? 'start'
             : e.target.classList.contains('pm-gantt-grip-r') ? 'end' : 'move';
        startX = e.clientX;
        live = false;
        bar.setPointerCapture(e.pointerId);

        const move = ev => {
          const d = Math.round((ev.clientX - startX) / dw);
          if (!live && Math.abs(ev.clientX - startX) < 4) return;
          live = true;
          bar.style.setProperty('--drag', String(d));
          bar.classList.add('is-dragging');
        };
        const up = ev => {
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.classList.remove('is-dragging');
          bar.style.removeProperty('--drag');
          try { bar.releasePointerCapture(ev.pointerId); } catch {}
          if (live) { apply(mode, Math.round((ev.clientX - startX) / dw)); }
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
      });

      // A drag that moved the bar must not also count as a click-to-open.
      bar.addEventListener('click', e => { if (live) { e.stopPropagation(); live = false; } }, true);
    }
  }

  /* ================================================================
     WorkloadView — who is drowning
     ================================================================ */

  class WorkloadView extends BaseView {
    static viewId = 'workload';
    static label = 'Workload';
    static icon = 'ph-users-three';

    constructor(ctx) {
      super(ctx);
      this.windowDays = 14;
    }

    render() {
      const p = this.project;
      if (!p) return;

      const from = isoLocal(S.today());
      const toDate = new Date(S.today());
      toDate.setDate(toDate.getDate() + this.windowDays - 1);
      const load = S.workloadFor(p, this.tasks({ roots: false }), this.members(), { from, to: isoLocal(toDate) })
        .sort((a, b) => b.utilisation - a.utilisation);

      const head = h('div', { class: 'pm-wl-head' }, [
        h('h3', { text: `Capacity over the next ${this.windowDays} days` }),
        h('div', { class: 'pm-wl-range' }, [7, 14, 30].map(n => h('button', {
          type: 'button', class: `pm-chip${this.windowDays === n ? ' is-on' : ''}`, text: `${n}d`,
          onclick: () => { this.windowDays = n; this.render(); },
        }))),
      ]);

      const rows = h('div', { class: 'pm-wl-rows' });
      for (const b of load) {
        const over = b.utilisation > 100;
        const near = b.utilisation > 80 && !over;

        rows.append(h('div', { class: `pm-wl-row${over ? ' is-over' : near ? ' is-near' : ''}` }, [
          h('div', { class: 'pm-wl-who' }, [
            h('span', { html: U.avatarHTML(b.member, 34) }),
            h('div', {}, [
              h('strong', { text: b.member.name || b.member.email }),
              h('small', { text: `${b.tasks.length} open · ${S.formatMinutes(Math.round(b.minutes))} of ${Math.round(b.capacityMinutes / 60)}h` }),
            ]),
          ]),

          h('div', { class: 'pm-wl-bar' }, [
            h('div', { class: 'pm-wl-fill', style: { width: Math.min(100, b.utilisation) + '%' } }),
            over ? h('div', { class: 'pm-wl-over', style: { width: Math.min(60, b.utilisation - 100) + '%' } }) : null,
            h('span', { class: 'pm-wl-pct', text: b.utilisation + '%' }),
          ]),

          h('div', { class: 'pm-wl-spark' }, b.perDay.map((m, i) => {
            const dayCap = (b.capacityMinutes / this.windowDays) || 1;
            const pct = S.clamp((m / dayCap) * 100, 0, 160);
            const d = new Date(S.today()); d.setDate(d.getDate() + i);
            return h('span', {
              class: `pm-wl-day${pct > 100 ? ' is-over' : ''}`,
              style: { '--v': Math.min(100, pct) + '%' },
              title: `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${S.formatMinutes(Math.round(m))}`,
            });
          })),

          h('div', { class: 'pm-wl-actions' }, [
            b.overdue ? h('span', { class: 'pm-wl-overdue', title: 'Overdue tasks' }, [h('i', { class: 'ph-fill ph-warning' }), String(b.overdue)]) : null,
            h('button', {
              type: 'button', class: 'btn btn-ghost', text: 'View tasks',
              onclick: () => this.ctx.applyFilter({ assignees: [this.store.memberKey(b.member)] }, 'list'),
            }),
          ]),
        ]));
      }

      const unassigned = this.tasks({ roots: false }).filter(t => !t.assignees.length && !S.isDone(p, t));
      const footer = unassigned.length ? h('div', { class: 'pm-wl-unassigned' }, [
        h('i', { class: 'ph ph-user-circle-dashed' }),
        h('span', { text: `${unassigned.length} open task${unassigned.length > 1 ? 's' : ''} have nobody on them` }),
        h('button', {
          type: 'button', class: 'btn btn-primary', text: 'Distribute evenly',
          onclick: () => this._distribute(unassigned),
        }),
      ]) : null;

      this.el.replaceChildren(h('div', { class: 'pm-wl' }, [head, rows, footer].filter(Boolean)));
    }

    /** Greedy fill: repeatedly give the next task to whoever is lightest. */
    async _distribute(tasks) {
      const p = this.project;
      const active = this.members().filter(m => m.status === 'active');
      if (!active.length) { U.toast('No active members to assign to.', 'warn'); return; }
      if (!await U.confirm(`Spread ${tasks.length} unassigned tasks across ${active.length} people by current load?`,
        { title: 'Distribute tasks', okLabel: 'Distribute' })) return;

      const load = new Map(S.workloadFor(p, this.store.projectTasks(p.id), active)
        .map(b => [this.store.memberKey(b.member), b.minutes]));

      this.store.transact('distribute tasks', () => {
        for (const t of S.sortTasks(tasks, 'priority', 'asc')) {
          let bestKey = null, best = Infinity;
          for (const [k, v] of load) if (v < best) { best = v; bestKey = k; }
          if (!bestKey) break;
          this.store.assign(t.id, [bestKey]);
          load.set(bestKey, best + (t.estimateMinutes || 60));
        }
      });
      U.toast(`Assigned ${tasks.length} tasks.`, 'success');
    }
  }

  /* ---- helpers --------------------------------------------------------- */

  function isoLocal(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function shiftISO(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return isoLocal(d);
  }

  function formatFieldValue(field, v, view) {
    if (v == null || v === '') return '—';
    if (field.type === 'checkbox') return v ? 'Yes' : 'No';
    if (field.type === 'money') return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    if (field.type === 'percent') return v + '%';
    if (field.type === 'rating') return '★'.repeat(v) + '☆'.repeat(5 - v);
    if (field.type === 'multi') return Array.isArray(v) ? v.join(', ') : String(v);
    if (field.type === 'people') return view.membersOf(v).map(m => m.name).join(', ') || '—';
    return String(v);
  }

  global.PMViews = {
    BaseView, BoardView, ListView, CalendarView, TimelineView, WorkloadView,
    registry: [BoardView, ListView, CalendarView, TimelineView, WorkloadView],
  };

})(window);
