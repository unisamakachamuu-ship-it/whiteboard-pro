/* ================================================================
   pm/task-panel.js — The task detail drawer
   ----------------------------------------------------------------
   Everything about one task in one place: who owns it, when it is due,
   what blocks it, what has been said about it, and how long it took.

   This is the screen the old build could not have, because a task was
   `{id, text, done}`. It is deliberately the only place that edits the
   deep structure of a task — views edit the shallow fields inline and
   open this for the rest.

   Every control writes through `store.<verb>()`. Nothing here mutates
   a task object, so undo, sync and the email automations all see it.
   ================================================================ */

(function (global) {
  'use strict';

  const S = global.PMSchema;
  const U = global.PMUI;
  const { h, esc } = U;

  class TaskPanel {
    constructor(store, hub) {
      this.store = store;
      this.hub = hub;
      this.taskId = null;
      this.el = null;
      this._unsub = [];
      this._build();
    }

    /* ---- Shell ------------------------------------------------------- */

    _build() {
      this.el = h('aside', { class: 'pm-task-panel hidden', role: 'complementary', 'aria-label': 'Task details' });
      this.scrim = h('div', { class: 'pm-task-scrim hidden', onclick: () => this.close() });
      document.body.append(this.scrim, this.el);

      // Re-render on any change touching this task, so two people
      // editing the same task see each other live.
      this._unsub.push(this.store.on('tasks-changed', ({ ids }) => {
        if (this.taskId && ids?.includes(this.taskId)) this.render();
      }));
      this._unsub.push(this.store.on('projects-changed', () => { if (this.taskId) this.render(); }));

      document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !this.taskId) return;
        if (U.Pop.isOpen) return;                    // let the popover close first
        if (document.activeElement?.closest('.pm-task-panel input, .pm-task-panel textarea')) return;
        this.close();
      });
    }

    open(taskId) {
      this.taskId = taskId;
      this.el.classList.remove('hidden');
      this.scrim.classList.remove('hidden');
      requestAnimationFrame(() => this.el.classList.add('is-open'));
      this.render();
      this.el.scrollTop = 0;
    }

    close() {
      this.taskId = null;
      this.el.classList.remove('is-open');
      this.scrim.classList.add('hidden');
      setTimeout(() => { if (!this.taskId) this.el.classList.add('hidden'); }, 180);
      U.Pop.close();
      this.hub?.onPanelClosed?.();
    }

    get task() { return this.store.task(this.taskId); }
    get project() { const t = this.task; return t ? this.store.project(t.projectId) : null; }

    /** Resolve assignee keys to member records; unknown keys become null slots. */
    membersOf(keys) {
      const p = this.project;
      return (keys || []).map(k => this.store.member(p.id, k)).filter(Boolean);
    }

    /* ---- Render ------------------------------------------------------ */

    render() {
      const t = this.task, p = this.project;
      if (!t || !p) { this.close(); return; }

      const status = S.statusOf(p, t);
      const subs = this.store.subtasks(t.id);
      const blockers = this.store.blockers(t.id);
      const logged = S.loggedMinutes(t);
      const progress = S.progressOf(p, t, subs);
      const parent = t.parentId ? this.store.task(t.parentId) : null;
      const canEdit = this.store.can('task.edit', p.id);

      this.el.replaceChildren(
        this._header(t, p, parent, status, canEdit),
        this._propsGrid(t, p, status, logged, canEdit),
        this._blockedBanner(blockers),
        this._section('Description', 'ph-text-align-left', this._description(t, p, canEdit)),
        this._subtaskSection(t, p, subs, progress, canEdit),
        this._checklistSection(t, canEdit),
        this._dependencySection(t, p, canEdit),
        this._attachmentSection(t, canEdit),
        this._commentSection(t, p),
        this._activityFooter(t),
      );
    }

    /* ---- Header ------------------------------------------------------ */

    _header(t, p, parent, status, canEdit) {
      const title = h('h2', { class: 'pm-tp-title', text: t.title });
      if (canEdit) {
        title.classList.add('is-editable');
        title.tabIndex = 0;
        const edit = () => U.editInline(title, t.title, next => {
          if (next) this.store.updateTask(t.id, { title: next });
          this.render();
        }, { placeholder: 'Task title' });
        title.addEventListener('click', edit);
        title.addEventListener('keydown', e => { if (e.key === 'Enter') edit(); });
      }

      const crumbs = h('div', { class: 'pm-tp-crumbs' }, [
        h('button', {
          type: 'button', class: 'pm-tp-crumb', text: p.name,
          onclick: () => { this.close(); this.hub?.openProject(p.id); },
        }),
        parent ? h('span', { class: 'pm-tp-crumb-sep', text: '/' }) : null,
        parent ? h('button', {
          type: 'button', class: 'pm-tp-crumb', text: parent.title,
          onclick: () => this.open(parent.id),
        }) : null,
      ]);

      return h('header', { class: 'pm-tp-head' }, [
        h('div', { class: 'pm-tp-head-row' }, [
          crumbs,
          h('div', { class: 'pm-tp-head-actions' }, [
            this._iconBtn('ph-eye', t.watchers.includes(this._me()) ? 'Stop watching' : 'Watch this task',
              e => this.store.toggleWatcher(t.id, this._me()),
              t.watchers.includes(this._me()) ? 'is-on' : ''),
            this._iconBtn('ph-dots-three-vertical', 'More actions', e => this._moreMenu(e.currentTarget, t, p)),
            this._iconBtn('ph-x', 'Close (Esc)', () => this.close()),
          ]),
        ]),
        title,
        h('div', { class: 'pm-tp-head-chips' }, [
          this._statusButton(t, p, status, canEdit),
          this._doneButton(t, p, status, canEdit),
        ]),
      ]);
    }

    _statusButton(t, p, status, canEdit) {
      return h('button', {
        type: 'button',
        class: 'pm-tp-status',
        style: { '--st': status.color },
        disabled: !canEdit,
        onclick: e => U.statusPicker(e.currentTarget, p.statuses, t.statusId,
          id => this.store.updateTask(t.id, { statusId: id })),
      }, [h('span', { class: 'pm-status-dot' }), status.name, h('i', { class: 'ph ph-caret-down' })]);
    }

    /** One-click complete — the single most-used action in any PM tool. */
    _doneButton(t, p, status, canEdit) {
      const doneStatus = p.statuses.find(s => s.kind === 'done');
      if (!doneStatus || !canEdit) return null;
      const isDone = status.kind === 'done';
      return h('button', {
        type: 'button',
        class: `pm-tp-done${isDone ? ' is-done' : ''}`,
        onclick: () => {
          const back = p.statuses.find(s => s.kind === 'active') || p.statuses[0];
          this.store.updateTask(t.id, { statusId: isDone ? back.id : doneStatus.id });
        },
      }, [h('i', { class: `ph ${isDone ? 'ph-check-circle' : 'ph-circle'}` }), isDone ? 'Completed' : 'Mark complete']);
    }

    /* ---- Property grid ----------------------------------------------- */

    _propsGrid(t, p, status, logged, canEdit) {
      const rows = [];

      rows.push(this._prop('Assignees', 'ph-users', h('button', {
        type: 'button', class: 'pm-tp-val pm-tp-assignees', disabled: !canEdit,
        onclick: e => U.memberPicker(e.currentTarget, p.members, t.assignees,
          keys => this.store.assign(t.id, keys)),
      }, [
        h('span', { html: U.avatarStackHTML(this.membersOf(t.assignees), { max: 4, size: 26 }) }),
        h('span', {
          class: 'pm-tp-val-text',
          text: t.assignees.length
            ? this.membersOf(t.assignees).map(m => m.name).join(', ')
            : 'Unassigned',
        }),
      ])));

      rows.push(this._prop('Priority', 'ph-flag', h('button', {
        type: 'button', class: 'pm-tp-val', disabled: !canEdit,
        html: U.priorityChipHTML(t.priority) || 'Set priority',
        onclick: e => U.priorityPicker(e.currentTarget, t.priority,
          id => this.store.updateTask(t.id, { priority: id })),
      })));

      rows.push(this._prop('Due date', 'ph-calendar-blank', h('button', {
        type: 'button', class: 'pm-tp-val', disabled: !canEdit,
        html: t.dueDate
          ? U.dueChipHTML(p, t)
          : '<span class="pm-tp-empty">No due date</span>',
        onclick: e => U.datePicker(e.currentTarget, t.dueDate,
          (iso, time) => this.store.updateTask(t.id, { dueDate: iso, dueTime: time ?? t.dueTime }),
          { withTime: true, currentTime: t.dueTime }),
      })));

      rows.push(this._prop('Start date', 'ph-play', h('button', {
        type: 'button', class: 'pm-tp-val', disabled: !canEdit,
        text: t.startDate ? new Date(t.startDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not set',
        onclick: e => U.datePicker(e.currentTarget, t.startDate,
          iso => this.store.updateTask(t.id, { startDate: iso }), { title: 'Start date' }),
      })));

      rows.push(this._prop('Estimate', 'ph-timer', this._estimateControl(t, canEdit)));
      rows.push(this._prop('Time logged', 'ph-clock', this._timeControl(t, logged, canEdit)));

      rows.push(this._prop('Tags', 'ph-tag', h('button', {
        type: 'button', class: 'pm-tp-val pm-tp-tags', disabled: !canEdit,
        html: t.tags.length ? t.tags.map(U.tagChipHTML).join('') : '<span class="pm-tp-empty">No tags</span>',
        onclick: e => U.tagPicker(e.currentTarget, p.tags || [], t.tags, tags => {
          this.store.updateTask(t.id, { tags });
          // Remember new tags on the project so the next task can reuse them.
          const merged = [...new Set([...(p.tags || []), ...tags])];
          if (merged.length !== (p.tags || []).length) this.store.updateProject(p.id, { tags: merged });
        }),
      })));

      if (p.lists.length > 1) {
        const list = p.lists.find(l => l.id === t.listId);
        rows.push(this._prop('List', 'ph-list-checks', h('button', {
          type: 'button', class: 'pm-tp-val', disabled: !canEdit,
          text: list?.name || 'No list',
          onclick: e => U.menu(e.currentTarget, p.lists.map(l => ({
            label: l.name, icon: l.icon, checked: l.id === t.listId,
            onClick: () => this.store.updateTask(t.id, { listId: l.id }),
          }))),
        })));
      }

      if (p.sprints.length) {
        const sprint = p.sprints.find(s => s.id === t.sprintId);
        rows.push(this._prop('Sprint', 'ph-arrows-clockwise', h('button', {
          type: 'button', class: 'pm-tp-val', disabled: !canEdit,
          text: sprint?.name || 'Backlog',
          onclick: e => U.menu(e.currentTarget, [
            { label: 'Backlog (no sprint)', icon: 'ph-tray', checked: !t.sprintId, onClick: () => this.store.updateTask(t.id, { sprintId: null }) },
            '-',
            ...p.sprints.map(s => ({ label: s.name, icon: 'ph-flag', checked: s.id === t.sprintId, onClick: () => this.store.updateTask(t.id, { sprintId: s.id }) })),
          ]),
        })));
      }

      for (const f of p.customFields || []) {
        rows.push(this._prop(f.name, 'ph-textbox', this._customFieldControl(t, f, canEdit)));
      }

      return h('div', { class: 'pm-tp-props' }, rows);
    }

    _prop(label, icon, control) {
      return h('div', { class: 'pm-tp-prop' }, [
        h('span', { class: 'pm-tp-key' }, [h('i', { class: `ph ${icon}` }), label]),
        control,
      ]);
    }

    _estimateControl(t, canEdit) {
      const btn = h('button', {
        type: 'button', class: 'pm-tp-val', disabled: !canEdit,
        text: t.estimateMinutes ? S.formatMinutes(t.estimateMinutes) : 'No estimate',
      });
      btn.addEventListener('click', () => {
        U.editInline(btn, t.estimateMinutes ? String(t.estimateMinutes / 60) : '', (next, raw) => {
          if (next !== null || raw !== '') {
            const hours = parseFloat(raw);
            this.store.updateTask(t.id, { estimateMinutes: isNaN(hours) || hours <= 0 ? null : Math.round(hours * 60) });
          }
          this.render();
        }, { placeholder: 'Hours, e.g. 3.5' });
      });
      return btn;
    }

    _timeControl(t, logged, canEdit) {
      const est = t.estimateMinutes;
      const over = est && logged > est;
      return h('div', { class: 'pm-tp-time' }, [
        h('span', { class: `pm-tp-time-val${over ? ' is-over' : ''}`, text: S.formatMinutes(logged) }),
        est ? h('span', { class: 'pm-tp-time-of', text: ` of ${S.formatMinutes(est)}` }) : null,
        est ? h('span', { class: 'pm-tp-time-bar', html: U.progressBarHTML(Math.min(100, (logged / est) * 100), { color: over ? 'var(--clr-danger)' : 'var(--clr-ok)' }) }) : null,
        canEdit ? h('button', {
          type: 'button', class: 'pm-tp-mini', title: 'Log time',
          onclick: e => this._logTimePop(e.currentTarget, t),
        }, [h('i', { class: 'ph ph-plus' })]) : null,
      ]);
    }

    _logTimePop(anchor, t) {
      const amount = h('input', { class: 'input', type: 'text', placeholder: 'e.g. 90m, 1.5h, 2h30' });
      const note = h('input', { class: 'input', type: 'text', placeholder: 'What did you work on? (optional)' });
      const wrap = h('div', {}, [
        h('div', { class: 'pm-pop-title', text: 'Log time' }),
        amount, note,
        h('button', {
          type: 'button', class: 'btn btn-primary pm-pop-go', text: 'Log',
          onclick: () => {
            const mins = parseDuration(amount.value);
            if (!mins) { U.toast('Could not read that duration. Try "90m" or "1.5h".', 'warn'); return; }
            this.store.logTime(t.id, mins, note.value.trim());
            U.Pop.close();
          },
        }),
        (t.timeEntries.length ? h('div', { class: 'pm-pop-title', text: 'Entries' }) : null),
        ...t.timeEntries.slice().reverse().map(e => h('div', { class: 'pm-time-row' }, [
          h('span', { class: 'pm-time-mins', text: S.formatMinutes(e.minutes) }),
          h('span', { class: 'pm-time-note', text: e.note || '—' }),
          h('button', {
            type: 'button', class: 'pm-tp-mini', title: 'Remove',
            onclick: () => { this.store.removeTimeEntry(t.id, e.id); U.Pop.close(); },
          }, [h('i', { class: 'ph ph-trash' })]),
        ])),
      ].filter(Boolean));

      amount.addEventListener('keydown', ev => { if (ev.key === 'Enter') wrap.querySelector('.pm-pop-go').click(); });
      U.Pop.open(anchor, wrap, { width: 260, className: 'pm-pop-form' });
    }

    _customFieldControl(t, f, canEdit) {
      const val = t.custom?.[f.id];
      const set = v => this.store.setCustomField(t.id, f.id, v);

      if (f.type === 'checkbox') {
        return h('label', { class: 'pm-tp-val pm-tp-check' }, [
          h('input', { type: 'checkbox', checked: !!val, disabled: !canEdit, onchange: e => set(e.target.checked) }),
          val ? 'Yes' : 'No',
        ]);
      }
      if (f.type === 'select') {
        return h('button', {
          type: 'button', class: 'pm-tp-val', disabled: !canEdit,
          text: val || 'Not set',
          onclick: e => U.menu(e.currentTarget, [
            { label: 'Not set', icon: 'ph-prohibit', checked: !val, onClick: () => set(null) },
            '-',
            ...(f.options || []).map(o => ({ label: o, icon: 'ph-circle', checked: o === val, onClick: () => set(o) })),
          ]),
        });
      }
      if (f.type === 'date') {
        return h('button', {
          type: 'button', class: 'pm-tp-val', disabled: !canEdit, text: val || 'Not set',
          onclick: e => U.datePicker(e.currentTarget, val, iso => set(iso), { title: f.name }),
        });
      }
      if (f.type === 'people') {
        return h('button', {
          type: 'button', class: 'pm-tp-val', disabled: !canEdit,
          html: U.avatarStackHTML(this.membersOf(val || []), { size: 22 }),
          onclick: e => U.memberPicker(e.currentTarget, this.project.members, val || [], set, { title: f.name }),
        });
      }

      const btn = h('button', {
        type: 'button', class: 'pm-tp-val', disabled: !canEdit,
        text: val === null || val === undefined || val === '' ? 'Empty' : String(val),
      });
      btn.addEventListener('click', () => U.editInline(btn, val == null ? '' : String(val), (next, raw) => {
        set(raw);
        this.render();
      }));
      return btn;
    }

    /* ---- Blocked banner ---------------------------------------------- */

    _blockedBanner(blockers) {
      if (!blockers.length) return null;
      return h('div', { class: 'pm-tp-blocked' }, [
        h('i', { class: 'ph-fill ph-warning-octagon' }),
        h('div', {}, [
          h('strong', { text: `Blocked by ${blockers.length} unfinished task${blockers.length > 1 ? 's' : ''}` }),
          h('div', { class: 'pm-tp-blocked-list' },
            blockers.map(b => h('button', { type: 'button', class: 'pm-tp-link', text: b.title, onclick: () => this.open(b.id) }))),
        ]),
      ]);
    }

    /* ---- Sections ----------------------------------------------------- */

    _section(title, icon, body, actions = null) {
      if (!body) return null;
      return h('section', { class: 'pm-tp-section' }, [
        h('div', { class: 'pm-tp-section-head' }, [
          h('h4', {}, [h('i', { class: `ph ${icon}` }), title]),
          actions,
        ]),
        body,
      ]);
    }

    _description(t, p, canEdit) {
      const box = h('div', { class: 'pm-tp-desc' });
      const paint = () => {
        box.innerHTML = t.description
          ? U.renderRichText(t.description, p.members)
          : '<span class="pm-tp-empty">No description yet. Click to add one — **bold**, `code`, links and @mentions work.</span>';
      };
      paint();
      if (canEdit) {
        box.classList.add('is-editable');
        box.addEventListener('click', e => {
          if (e.target.tagName === 'A') return;
          U.editInline(box, t.description, next => {
            if (next !== null) this.store.updateTask(t.id, { description: next });
            this.render();
          }, { multiline: true, placeholder: 'Add a description…' });
        });
      }
      return box;
    }

    _subtaskSection(t, p, subs, progress, canEdit) {
      const list = h('div', { class: 'pm-tp-subs' });

      for (const st of subs) {
        const stStatus = S.statusOf(p, st);
        const done = stStatus.kind === 'done';
        list.append(h('div', { class: `pm-tp-sub${done ? ' is-done' : ''}` }, [
          h('button', {
            type: 'button', class: 'pm-tp-sub-check', title: done ? 'Reopen' : 'Complete', disabled: !canEdit,
            onclick: () => {
              const target = done
                ? (p.statuses.find(s => s.kind === 'todo') || p.statuses[0])
                : (p.statuses.find(s => s.kind === 'done') || p.statuses.at(-1));
              this.store.updateTask(st.id, { statusId: target.id });
            },
          }, [h('i', { class: `ph ${done ? 'ph-check-circle' : 'ph-circle'}` })]),
          h('button', { type: 'button', class: 'pm-tp-sub-title', text: st.title, onclick: () => this.open(st.id) }),
          h('span', { class: 'pm-tp-sub-meta', html: U.dueChipHTML(p, st) + U.avatarStackHTML(this.membersOf(st.assignees), { max: 2, size: 20 }) }),
        ]));
      }

      if (canEdit) {
        const input = h('input', { class: 'pm-tp-add', type: 'text', placeholder: '+ Add a subtask, press Enter' });
        input.addEventListener('keydown', e => {
          if (e.key !== 'Enter' || !input.value.trim()) return;
          this.store.createTask({ projectId: p.id, parentId: t.id, title: input.value.trim(), listId: t.listId, statusId: p.statuses[0].id });
          input.value = '';
        });
        list.append(input);
      }

      const head = subs.length
        ? h('span', { class: 'pm-tp-section-meta' }, [
            `${subs.filter(s => S.statusOf(p, s).kind === 'done').length}/${subs.length}`,
            h('span', { html: U.progressBarHTML(progress) }),
          ])
        : null;

      return this._section(`Subtasks`, 'ph-tree-structure', list, head);
    }

    _checklistSection(t, canEdit) {
      const prog = S.checklistProgress(t);
      const list = h('div', { class: 'pm-tp-checklist' });

      for (const item of t.checklist) {
        list.append(h('div', { class: `pm-tp-ck${item.done ? ' is-done' : ''}` }, [
          h('input', {
            type: 'checkbox', checked: item.done, disabled: !canEdit,
            onchange: e => this.store.updateChecklistItem(t.id, item.id, { done: e.target.checked }),
          }),
          h('span', { class: 'pm-tp-ck-text', text: item.text }),
          canEdit ? h('button', {
            type: 'button', class: 'pm-tp-mini', title: 'Turn into a real subtask',
            onclick: () => this.store.promoteChecklistItem(t.id, item.id),
          }, [h('i', { class: 'ph ph-arrow-square-out' })]) : null,
          canEdit ? h('button', {
            type: 'button', class: 'pm-tp-mini', title: 'Remove',
            onclick: () => this.store.removeChecklistItem(t.id, item.id),
          }, [h('i', { class: 'ph ph-x' })]) : null,
        ]));
      }

      if (canEdit) {
        const input = h('input', { class: 'pm-tp-add', type: 'text', placeholder: '+ Add a checklist item' });
        input.addEventListener('keydown', e => {
          if (e.key !== 'Enter' || !input.value.trim()) return;
          this.store.addChecklistItem(t.id, input.value.trim());
          input.value = '';
        });
        list.append(input);
      }

      if (!t.checklist.length && !canEdit) return null;
      const meta = prog ? h('span', { class: 'pm-tp-section-meta' }, [`${prog.done}/${prog.total}`, h('span', { html: U.progressBarHTML(prog.pct) })]) : null;
      return this._section('Checklist', 'ph-check-square-offset', list, meta);
    }

    _dependencySection(t, p, canEdit) {
      const deps = t.dependencies || [];
      if (!deps.length && !canEdit) return null;

      const list = h('div', { class: 'pm-tp-deps' });
      for (const d of deps) {
        const other = this.store.task(d.taskId);
        if (!other) continue;
        const meta = S.DEPENDENCY_TYPES[d.type] || S.DEPENDENCY_TYPES.relates;
        const otherDone = S.isDone(p, other);
        list.append(h('div', { class: `pm-tp-dep${otherDone ? ' is-done' : ''}` }, [
          h('span', { class: 'pm-tp-dep-type' }, [h('i', { class: `ph ${meta.icon}` }), meta.name]),
          h('button', { type: 'button', class: 'pm-tp-link', text: other.title, onclick: () => this.open(other.id) }),
          h('span', { class: 'pm-tp-dep-status', html: U.statusPillHTML(S.statusOf(p, other), { compact: true }) }),
          canEdit ? h('button', {
            type: 'button', class: 'pm-tp-mini', title: 'Unlink',
            onclick: () => this.store.removeDependency(t.id, other.id),
          }, [h('i', { class: 'ph ph-x' })]) : null,
        ]));
      }

      const add = canEdit ? h('button', {
        type: 'button', class: 'pm-tp-add-btn',
        onclick: e => this._linkPop(e.currentTarget, t, p),
      }, [h('i', { class: 'ph ph-link' }), 'Link a task']) : null;

      return this._section('Dependencies', 'ph-flow-arrow', list, add);
    }

    _linkPop(anchor, t, p) {
      let type = 'blocked_by';
      const search = h('input', { class: 'pm-pop-search input', placeholder: 'Search tasks in this project…' });
      const results = h('div', { class: 'pm-pick-list' });
      const typeRow = h('div', { class: 'pm-dep-types' },
        Object.entries(S.DEPENDENCY_TYPES).map(([k, v]) => h('button', {
          type: 'button', class: `pm-dep-type${k === type ? ' is-on' : ''}`, text: v.name,
          onclick: e => {
            type = k;
            typeRow.querySelectorAll('.pm-dep-type').forEach(b => b.classList.remove('is-on'));
            e.currentTarget.classList.add('is-on');
          },
        })));

      const draw = () => {
        results.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        const linked = new Set((t.dependencies || []).map(d => d.taskId));
        const hits = this.store.projectTasks(p.id)
          .filter(x => x.id !== t.id && !linked.has(x.id) && (!q || x.title.toLowerCase().includes(q)))
          .slice(0, 40);

        if (!hits.length) { results.append(h('div', { class: 'pm-pick-empty', text: 'No matching tasks.' })); return; }
        for (const x of hits) {
          results.append(h('button', {
            type: 'button', class: 'pm-pick-row',
            onclick: () => { this.store.addDependency(t.id, x.id, type); U.Pop.close(); },
          }, [
            h('span', { class: 'pm-status-dot', style: { background: S.statusOf(p, x).color } }),
            h('span', { class: 'pm-pick-meta' }, [h('strong', { text: x.title })]),
          ]));
        }
      };

      search.addEventListener('input', draw);
      draw();
      U.Pop.open(anchor, h('div', {}, [h('div', { class: 'pm-pop-title', text: 'Link a task' }), typeRow, search, results]),
        { width: 300, className: 'pm-pop-pick' });
    }

    _attachmentSection(t, canEdit) {
      const items = t.attachments || [];
      if (!items.length && !canEdit) return null;

      const list = h('div', { class: 'pm-tp-atts' });
      for (const a of items) {
        list.append(h('div', { class: 'pm-tp-att' }, [
          h('i', { class: `ph ${ATT_ICON[a.kind] || 'ph-paperclip'}` }),
          a.url
            ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: a.name || a.url, class: 'pm-tp-link' })
            : h('span', { text: a.name || 'Attachment' }),
          a.kind === 'board' ? h('button', {
            type: 'button', class: 'pm-tp-mini', title: 'Show on the whiteboard',
            onclick: () => this.hub?.revealOnCanvas(a.boardId, a.elementId),
          }, [h('i', { class: 'ph ph-crosshair' })]) : null,
          canEdit ? h('button', {
            type: 'button', class: 'pm-tp-mini', title: 'Remove',
            onclick: () => this.store.removeAttachment(t.id, a.id),
          }, [h('i', { class: 'ph ph-x' })]) : null,
        ]));
      }

      const add = canEdit ? h('button', {
        type: 'button', class: 'pm-tp-add-btn',
        onclick: e => this._attachPop(e.currentTarget, t),
      }, [h('i', { class: 'ph ph-paperclip' }), 'Attach']) : null;

      return this._section('Attachments', 'ph-paperclip', list, add);
    }

    _attachPop(anchor, t) {
      const url = h('input', { class: 'input', placeholder: 'Paste a link (Drive, Docs, anything)' });
      const name = h('input', { class: 'input', placeholder: 'Label (optional)' });
      const wrap = h('div', {}, [
        h('div', { class: 'pm-pop-title', text: 'Attach a link' }),
        url, name,
        h('button', {
          type: 'button', class: 'btn btn-primary pm-pop-go', text: 'Attach',
          onclick: () => {
            const v = url.value.trim();
            if (!v) return;
            this.store.addAttachment(t.id, { kind: guessAttKind(v), url: v, name: name.value.trim() || v });
            U.Pop.close();
          },
        }),
        h('div', { class: 'pm-pop-title', text: 'Or from the app' }),
        h('button', {
          type: 'button', class: 'pm-menu-item',
          onclick: () => { U.Pop.close(); this.hub?.attachFromBoard?.(t.id); },
        }, [h('i', { class: 'ph ph-selection' }), 'Pick an object on the whiteboard']),
        h('button', {
          type: 'button', class: 'pm-menu-item',
          onclick: () => { U.Pop.close(); this.hub?.attachFromKeep?.(t.id); },
        }, [h('i', { class: 'ph ph-note' }), 'A Google Keep note']),
      ]);
      U.Pop.open(anchor, wrap, { width: 280, className: 'pm-pop-form' });
    }

    /* ---- Comments ------------------------------------------------------ */

    _commentSection(t, p) {
      const list = h('div', { class: 'pm-tp-comments' });
      const me = this._me();

      for (const c of t.comments) {
        const author = this.store.member(p.id, c.authorId) || { name: 'Someone', email: '' };
        const mine = c.authorId === me;

        list.append(h('div', { class: 'pm-cmt' }, [
          h('span', { class: 'pm-cmt-av', html: U.avatarHTML(author, 28) }),
          h('div', { class: 'pm-cmt-body' }, [
            h('div', { class: 'pm-cmt-head' }, [
              h('strong', { text: author.name || author.email }),
              h('time', { text: U.relativeTime(c.at) + (c.editedAt ? ' · edited' : '') }),
              mine ? h('button', {
                type: 'button', class: 'pm-tp-mini', title: 'Comment actions',
                onclick: e => U.menu(e.currentTarget, [
                  { label: 'Edit', icon: 'ph-pencil-simple', onClick: () => this._editComment(t, c) },
                  { label: 'Delete', icon: 'ph-trash', danger: true, onClick: () => this.store.deleteComment(t.id, c.id) },
                ], { width: 160, align: 'end' }),
              }, [h('i', { class: 'ph ph-dots-three' })]) : null,
            ]),
            h('div', { class: 'pm-cmt-text', html: U.renderRichText(c.text, p.members) }),
            this._reactionRow(t, c, me),
          ]),
        ]));
      }

      if (!t.comments.length) {
        list.append(h('div', { class: 'pm-tp-empty pm-cmt-empty', text: 'No comments yet. Use @name to notify a teammate.' }));
      }

      list.append(this._composer(t, p));
      return this._section(`Comments`, 'ph-chat-circle', list,
        t.comments.length ? h('span', { class: 'pm-tp-section-meta', text: String(t.comments.length) }) : null);
    }

    _reactionRow(t, c, me) {
      const row = h('div', { class: 'pm-cmt-reactions' });
      for (const [emoji, users] of Object.entries(c.reactions || {})) {
        if (!users.length) continue;
        row.append(h('button', {
          type: 'button', class: `pm-cmt-react${users.includes(me) ? ' is-on' : ''}`,
          onclick: () => this.store.reactToComment(t.id, c.id, emoji),
        }, [emoji, h('span', { text: String(users.length) })]));
      }
      row.append(h('button', {
        type: 'button', class: 'pm-cmt-react is-add', title: 'React',
        onclick: e => U.menu(e.currentTarget, ['👍', '🎉', '👀', '🚀', '❤️', '😅'].map(em => ({
          label: em, icon: 'ph-smiley', onClick: () => this.store.reactToComment(t.id, c.id, em),
        })), { width: 120 }),
      }, [h('i', { class: 'ph ph-smiley' })]));
      return row;
    }

    _editComment(t, c) {
      const node = this.el.querySelector(`.pm-cmt-text`);
      const next = prompt('Edit comment', c.text);
      if (next != null && next.trim() !== c.text) this.store.editComment(t.id, c.id, next.trim());
    }

    _composer(t, p) {
      const box = h('textarea', { class: 'pm-cmt-input', rows: 2, placeholder: 'Write a comment…  @ to mention' });
      const send = () => {
        const v = box.value.trim();
        if (!v) return;
        this.store.addComment(t.id, v);
        box.value = '';
        box.style.height = 'auto';
      };

      box.addEventListener('input', () => {
        box.style.height = 'auto';
        box.style.height = Math.min(200, box.scrollHeight) + 'px';
        this._maybeMention(box, p);
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
      });

      return h('div', { class: 'pm-cmt-composer' }, [
        box,
        h('div', { class: 'pm-cmt-composer-actions' }, [
          h('span', { class: 'pm-cmt-hint', text: 'Ctrl+Enter to send' }),
          h('button', { type: 'button', class: 'btn btn-primary', text: 'Comment', onclick: send }),
        ]),
      ]);
    }

    /** Autocomplete after an `@`, so mentions actually resolve to people. */
    _maybeMention(box, p) {
      const upto = box.value.slice(0, box.selectionStart);
      const m = /@([\w.-]*)$/.exec(upto);
      if (!m) { if (U.Pop.isOpen && U.Pop._el?.classList.contains('pm-pop-mention')) U.Pop.close(); return; }

      const q = m[1].toLowerCase();
      const hits = p.members.filter(x => x.status !== 'removed' &&
        (!q || (x.name || '').toLowerCase().includes(q) || (x.email || '').toLowerCase().includes(q))).slice(0, 6);
      if (!hits.length) return;

      const list = h('div', { class: 'pm-pick-list' }, hits.map(x => h('button', {
        type: 'button', class: 'pm-pick-row',
        onclick: () => {
          const handle = (x.name || x.email).replace(/\s+/g, '');
          box.value = box.value.slice(0, box.selectionStart - m[0].length) + '@' + handle + ' ' + box.value.slice(box.selectionStart);
          U.Pop.close();
          box.focus();
        },
      }, [
        h('span', { html: U.avatarHTML(x, 22) }),
        h('span', { class: 'pm-pick-meta' }, [h('strong', { text: x.name || x.email })]),
      ])));

      U.Pop.open(box, list, { width: 220, className: 'pm-pop-mention', side: 'top' });
    }

    /* ---- Footer & menus ------------------------------------------------ */

    _activityFooter(t) {
      const created = this.store.member(this.project.id, t.createdBy);
      return h('footer', { class: 'pm-tp-foot' }, [
        h('span', { text: `Created ${U.relativeTime(t.createdAt)}${created ? ' by ' + (created.name || created.email) : ''}` }),
        h('span', { text: `Updated ${U.relativeTime(t.updatedAt)}` }),
        t.completedAt ? h('span', { class: 'is-done', text: `Completed ${U.relativeTime(t.completedAt)}` }) : null,
      ]);
    }

    _moreMenu(anchor, t, p) {
      U.menu(anchor, [
        { label: 'Duplicate', icon: 'ph-copy', onClick: () => { const c = this.store.duplicateTask(t.id); if (c) this.open(c.id); } },
        { label: 'Copy link', icon: 'ph-link-simple', onClick: () => this._copyLink(t) },
        { label: 'Send to whiteboard', icon: 'ph-chalkboard', onClick: () => this.hub?.sendTaskToCanvas?.(t.id) },
        { label: 'Add to Google Calendar', icon: 'ph-calendar-plus', disabled: !t.dueDate, onClick: () => this.hub?.pushToCalendar?.(t.id) },
        '-',
        { label: 'Auto-assign to lightest load', icon: 'ph-scales', onClick: () => this.store.autoAssign(t.id) },
        { label: t.archived ? 'Unarchive' : 'Archive', icon: 'ph-archive', onClick: () => this.store.updateTask(t.id, { archived: !t.archived }) },
        '-',
        {
          label: 'Delete task', icon: 'ph-trash', danger: true,
          onClick: async () => {
            const subs = this.store.descendants(t.id);
            const msg = subs.length
              ? `"${t.title}" and its ${subs.length} subtask${subs.length > 1 ? 's' : ''} will be deleted.`
              : `"${t.title}" will be deleted.`;
            if (await U.confirm(msg, { title: 'Delete task?', okLabel: 'Delete', danger: true })) {
              this.store.deleteTask(t.id);
              this.close();
            }
          },
        },
      ], { align: 'end', width: 250 });
    }

    _copyLink(t) {
      const url = `${location.origin}${location.pathname}?project=${encodeURIComponent(t.projectId)}&task=${encodeURIComponent(t.id)}`;
      navigator.clipboard?.writeText(url)
        .then(() => U.toast('Task link copied.', 'success'))
        .catch(() => U.toast(url, 'info', 6000));
    }

    _iconBtn(icon, title, onclick, cls = '') {
      return h('button', { type: 'button', class: `pm-tp-icon ${cls}`, title, onclick }, [h('i', { class: `ph ${icon}` })]);
    }

    _me() {
      const u = this.store.currentUser;
      return u ? (u.uid || u.email) : 'anon';
    }
  }

  /* ---- helpers --------------------------------------------------------- */

  const ATT_ICON = {
    link: 'ph-link-simple',
    gdoc: 'ph-file-doc',
    gsheet: 'ph-file-xls',
    gslide: 'ph-projector-screen',
    gdrive: 'ph-google-drive-logo',
    keep: 'ph-note',
    board: 'ph-chalkboard',
    file: 'ph-file',
  };

  function guessAttKind(url) {
    if (/docs\.google\.com\/document/.test(url)) return 'gdoc';
    if (/docs\.google\.com\/spreadsheets/.test(url)) return 'gsheet';
    if (/docs\.google\.com\/presentation/.test(url)) return 'gslide';
    if (/drive\.google\.com/.test(url)) return 'gdrive';
    if (/keep\.google\.com/.test(url)) return 'keep';
    return 'link';
  }

  /** "90m", "1.5h", "2h30", "45" (bare = minutes) → minutes. */
  function parseDuration(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 0;

    const hm = /^(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*(\d+)?\s*m?(?:ins?)?$/.exec(s);
    if (hm) return Math.round(parseFloat(hm[1]) * 60 + (parseInt(hm[2] || '0', 10)));

    const mOnly = /^(\d+(?:\.\d+)?)\s*m(?:ins?)?$/.exec(s);
    if (mOnly) return Math.round(parseFloat(mOnly[1]));

    const bare = parseFloat(s);
    return isNaN(bare) ? 0 : Math.round(bare);
  }

  global.PMTaskPanel = TaskPanel;
  global.PMParseDuration = parseDuration;

})(window);
