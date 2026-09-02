/* ================================================================
   pm/schema.js — The work-item data model
   ----------------------------------------------------------------
   Pure data. No DOM, no network, no globals beyond the export.

   Everything the PM system knows how to store is defined here once:
   the shape of a task, the statuses it can hold, how two tasks sort
   against each other, and how a parent's progress rolls up from its
   children. Views read these helpers; they never re-derive.

   Design rule inherited from core.js: a task is a plain JSON object.
   No classes, no getters, no prototypes — so it survives
   structuredClone, JSON.stringify, Firestore and localStorage
   unchanged, and undo/redo can snapshot it for free.
   ================================================================ */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------
     Status pipelines

     A status is not a string on the task — it is an id pointing at a
     row in the project's own pipeline, so a team can rename "In
     progress" to "Cooking" without rewriting every task. `kind` is the
     part the system reasons about: only `done` counts as complete, only
     `active` counts toward work-in-progress limits.
     ------------------------------------------------------------------ */

  const STATUS_KINDS = ['backlog', 'todo', 'active', 'review', 'done', 'cancelled'];

  /** Kinds that mean "this task no longer needs doing". */
  const CLOSED_KINDS = new Set(['done', 'cancelled']);

  const DEFAULT_PIPELINE = [
    { id: 'backlog',  name: 'Backlog',     color: '#929aab', kind: 'backlog' },
    { id: 'todo',     name: 'To do',       color: '#4262ff', kind: 'todo'    },
    { id: 'doing',    name: 'In progress', color: '#e8912b', kind: 'active'  },
    { id: 'review',   name: 'In review',   color: '#a855f7', kind: 'review'  },
    { id: 'done',     name: 'Done',        color: '#17a673', kind: 'done'    },
  ];

  /** Pipelines a project can be seeded with. Teams can edit freely after. */
  const PIPELINE_PRESETS = {
    simple: {
      name: 'Simple',
      statuses: [
        { id: 'todo', name: 'To do',       color: '#4262ff', kind: 'todo'   },
        { id: 'doing', name: 'In progress', color: '#e8912b', kind: 'active' },
        { id: 'done', name: 'Done',        color: '#17a673', kind: 'done'   },
      ],
    },
    software: {
      name: 'Software delivery',
      statuses: [
        { id: 'backlog', name: 'Backlog',     color: '#929aab', kind: 'backlog' },
        { id: 'todo',    name: 'Ready',       color: '#4262ff', kind: 'todo'    },
        { id: 'doing',   name: 'In progress', color: '#e8912b', kind: 'active'  },
        { id: 'review',  name: 'Code review', color: '#a855f7', kind: 'review'  },
        { id: 'qa',      name: 'QA',          color: '#06b6d4', kind: 'review'  },
        { id: 'done',    name: 'Shipped',     color: '#17a673', kind: 'done'    },
        { id: 'wontfix', name: "Won't fix",   color: '#767f92', kind: 'cancelled' },
      ],
    },
    content: {
      name: 'Content pipeline',
      statuses: [
        { id: 'idea',    name: 'Idea',      color: '#929aab', kind: 'backlog' },
        { id: 'outline', name: 'Outlining', color: '#4262ff', kind: 'todo'    },
        { id: 'draft',   name: 'Drafting',  color: '#e8912b', kind: 'active'  },
        { id: 'edit',    name: 'Editing',   color: '#a855f7', kind: 'review'  },
        { id: 'live',    name: 'Published', color: '#17a673', kind: 'done'    },
      ],
    },
    support: {
      name: 'Support queue',
      statuses: [
        { id: 'new',      name: 'New',         color: '#e0455e', kind: 'todo'   },
        { id: 'triage',   name: 'Triaging',    color: '#e8912b', kind: 'active' },
        { id: 'waiting',  name: 'Waiting on customer', color: '#a855f7', kind: 'review' },
        { id: 'resolved', name: 'Resolved',    color: '#17a673', kind: 'done'   },
      ],
    },
  };

  /* ------------------------------------------------------------------
     Priority

     Ordered low → urgent so `PRIORITY_RANK[p]` sorts numerically and
     `null` (unset) sorts below everything real.
     ------------------------------------------------------------------ */

  const PRIORITIES = [
    { id: 'low',    name: 'Low',    color: '#929aab', rank: 1, icon: 'ph-flag' },
    { id: 'normal', name: 'Normal', color: '#4262ff', rank: 2, icon: 'ph-flag' },
    { id: 'high',   name: 'High',   color: '#e8912b', rank: 3, icon: 'ph-flag-banner' },
    { id: 'urgent', name: 'Urgent', color: '#e0455e', rank: 4, icon: 'ph-warning-diamond' },
  ];

  const PRIORITY_BY_ID = Object.fromEntries(PRIORITIES.map(p => [p.id, p]));
  const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map(p => [p.id, p.rank]));

  /* ------------------------------------------------------------------
     Roles & permissions

     Checked on the client for UI affordances and re-checked in the
     Firestore security rules, which are the actual enforcement point.
     Never trust this table alone.
     ------------------------------------------------------------------ */

  const ROLES = {
    owner:  { name: 'Owner',  rank: 4, can: ['*'] },
    admin:  { name: 'Admin',  rank: 3, can: ['task.*', 'member.*', 'project.edit', 'board.*', 'view.*'] },
    member: { name: 'Member', rank: 2, can: ['task.create', 'task.edit', 'task.comment', 'board.*', 'view.create'] },
    guest:  { name: 'Guest',  rank: 1, can: ['task.comment', 'task.viewAssigned'] },
    viewer: { name: 'Viewer', rank: 0, can: ['task.view'] },
  };

  function roleCan(role, action) {
    const r = ROLES[role] || ROLES.viewer;
    return r.can.some(rule => {
      if (rule === '*') return true;
      if (rule === action) return true;
      if (rule.endsWith('.*')) return action.startsWith(rule.slice(0, -1));
      return false;
    });
  }

  /* ------------------------------------------------------------------
     Dependencies
     ------------------------------------------------------------------ */

  const DEPENDENCY_TYPES = {
    blocks:     { name: 'Blocks',      inverse: 'blocked_by', icon: 'ph-arrow-right' },
    blocked_by: { name: 'Blocked by',  inverse: 'blocks',     icon: 'ph-arrow-left'  },
    relates:    { name: 'Relates to',  inverse: 'relates',    icon: 'ph-link'        },
    duplicates: { name: 'Duplicates',  inverse: 'duplicates', icon: 'ph-copy'        },
  };

  /* ------------------------------------------------------------------
     Custom fields — the escape hatch that stops every team asking for
     a new column. Values live in `task.custom[fieldId]`.
     ------------------------------------------------------------------ */

  const FIELD_TYPES = {
    text:     { name: 'Text',        coerce: v => (v == null ? '' : String(v)) },
    number:   { name: 'Number',      coerce: v => (v === '' || v == null ? null : Number(v)) },
    money:    { name: 'Money',       coerce: v => (v === '' || v == null ? null : Number(v)) },
    percent:  { name: 'Percent',     coerce: v => (v === '' || v == null ? null : clamp(Number(v), 0, 100)) },
    date:     { name: 'Date',        coerce: v => (v ? String(v) : null) },
    select:   { name: 'Dropdown',    coerce: v => (v == null ? null : String(v)) },
    multi:    { name: 'Labels',      coerce: v => (Array.isArray(v) ? v.map(String) : []) },
    checkbox: { name: 'Checkbox',    coerce: v => !!v },
    people:   { name: 'People',      coerce: v => (Array.isArray(v) ? v.map(String) : []) },
    url:      { name: 'URL',         coerce: v => (v == null ? '' : String(v)) },
    rating:   { name: 'Rating',      coerce: v => (v == null ? null : clamp(Math.round(Number(v)), 0, 5)) },
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ------------------------------------------------------------------
     Fractional ordering

     Manual drag-to-reorder needs a sort key that can always be split
     between two neighbours without renumbering the list. Keys are
     base-62 strings compared lexicographically; `orderBetween(a, b)`
     returns a key that sorts strictly between them.

     This matters at scale: renumbering 500 tasks because someone
     dragged one card is 500 Firestore writes. This is one.
     ------------------------------------------------------------------ */

  const ORDER_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const ORDER_BASE = ORDER_DIGITS.length;
  const ORDER_MID = ORDER_DIGITS[Math.floor(ORDER_BASE / 2)]; // 'V'

  /**
   * The midpoint of two keys, treating each as a fraction in base 62.
   *
   * Invariant: a key never ends in '0'. That is what keeps this
   * terminating — without it, splitting the gap between "U" and "U0"
   * has no representable answer and the naive version returns a key
   * equal to one of its bounds, which silently corrupts the sequence
   * the first time someone drags a card into the same slot twice.
   *
   * `null`/'' for `b` means "no upper bound" (append to the end).
   */
  function midpoint(a, b) {
    if (b !== null && a >= b) return null;   // caller error; recovered below

    if (b !== null) {
      // Walk past the shared prefix, treating a missing digit in `a` as
      // '0' — "U" and "U0X" agree for two positions, not one.
      let n = 0;
      while ((a[n] || '0') === b[n]) n++;
      if (n > 0) {
        const tail = midpoint(a.slice(n), b.slice(n));
        return tail === null ? null : b.slice(0, n) + tail;
      }
    }

    const digitA = a ? ORDER_DIGITS.indexOf(a[0]) : 0;
    const digitB = b !== null && b.length ? ORDER_DIGITS.indexOf(b[0]) : ORDER_BASE;

    if (digitB - digitA > 1) {
      return ORDER_DIGITS[Math.round(0.5 * (digitA + digitB))];
    }

    // Adjacent digits: there is no room at this position.
    if (b !== null && b.length > 1) {
      // `b` continues past its first digit, so that digit alone sits
      // strictly between the two.
      return b.slice(0, 1);
    }
    // Otherwise descend into `a`'s tail with no upper bound.
    const tail = midpoint(a.slice(1), null);
    return tail === null ? null : ORDER_DIGITS[digitA] + tail;
  }

  function orderBetween(a, b) {
    a = stripTrailingZeros(a || '');
    b = b ? stripTrailingZeros(b) : '';

    // Callers can pass neighbours in the wrong order after a filtered
    // view is re-sorted. Recover rather than emit a corrupting key.
    if (a && b && a >= b) [a, b] = [b, a];
    if (a && b && a >= b) return a + ORDER_MID;   // genuinely equal

    const m = midpoint(a, b || null);
    return m === null ? (a || '') + ORDER_MID : m;
  }

  /** '0' at the end carries no value and breaks the midpoint invariant. */
  function stripTrailingZeros(s) {
    let i = s.length;
    while (i > 0 && s[i - 1] === '0') i--;
    return s.slice(0, i);
  }

  /** A key that sorts after everything currently in `keys`. */
  function orderAfterAll(keys) {
    if (!keys.length) return ORDER_MID;
    const max = keys.reduce((m, k) => (k > m ? k : m), keys[0]);
    return orderBetween(max, '');
  }

  /** A key that sorts before everything currently in `keys`. */
  function orderBeforeAll(keys) {
    if (!keys.length) return ORDER_MID;
    const min = keys.reduce((m, k) => (k < m ? k : m), keys[0]);
    return orderBetween('', min);
  }

  /* ------------------------------------------------------------------
     Factories
     ------------------------------------------------------------------ */

  let _seq = 0;
  function uid(prefix) {
    _seq = (_seq + 1) % 0xffff;
    return `${prefix}_${Date.now().toString(36)}${_seq.toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 6)}`;
  }

  function nowISO() { return new Date().toISOString(); }

  /**
   * A task. Every field is present from birth — views can read
   * `task.assignees.length` without guarding, and a missing key later
   * is a real bug rather than an old record.
   */
  function makeTask(props = {}) {
    const t = {
      id: props.id || uid('task'),
      projectId: props.projectId || null,
      listId: props.listId || null,          // grouping inside a project
      sprintId: props.sprintId || null,
      parentId: props.parentId || null,      // subtask nesting

      title: (props.title || '').trim() || 'Untitled task',
      description: props.description || '',
      statusId: props.statusId || 'todo',
      priority: props.priority || null,      // null = unset, sorts last

      assignees: dedupe(props.assignees),
      watchers: dedupe(props.watchers),
      createdBy: props.createdBy || null,

      startDate: props.startDate || null,    // ISO date, no time
      dueDate: props.dueDate || null,
      dueTime: props.dueTime || null,        // 'HH:MM' when the due date is timed
      completedAt: props.completedAt || null,

      estimateMinutes: props.estimateMinutes ?? null,
      timeEntries: Array.isArray(props.timeEntries) ? props.timeEntries.slice() : [],

      tags: dedupe(props.tags),
      dependencies: Array.isArray(props.dependencies) ? props.dependencies.slice() : [],
      checklist: Array.isArray(props.checklist) ? props.checklist.slice() : [],
      comments: Array.isArray(props.comments) ? props.comments.slice() : [],
      attachments: Array.isArray(props.attachments) ? props.attachments.slice() : [],

      // Canvas fusion: which whiteboard objects represent this task.
      boardRefs: Array.isArray(props.boardRefs) ? props.boardRefs.slice() : [],
      // Google Calendar event mirroring this task's due date.
      calendarEventId: props.calendarEventId || null,

      custom: props.custom ? { ...props.custom } : {},

      order: props.order || ORDER_MID,
      archived: !!props.archived,

      createdAt: props.createdAt || nowISO(),
      updatedAt: props.updatedAt || nowISO(),
    };
    return t;
  }

  function makeComment(uidStr, text, extra = {}) {
    return {
      id: uid('cmt'),
      authorId: uidStr,
      text: String(text || ''),
      at: nowISO(),
      editedAt: null,
      reactions: {},                 // { '👍': [uid, uid] }
      mentions: extractMentions(text),
      ...extra,
    };
  }

  function makeChecklistItem(text, extra = {}) {
    return { id: uid('ck'), text: String(text || ''), done: false, assignee: null, ...extra };
  }

  function makeTimeEntry(uidStr, minutes, note = '') {
    return { id: uid('te'), userId: uidStr, minutes: Math.max(0, Number(minutes) || 0), note, at: nowISO() };
  }

  function makeMember(props = {}) {
    return {
      uid: props.uid || null,               // Firebase Auth uid once they sign in
      email: (props.email || '').toLowerCase(),
      name: props.name || (props.email || '').split('@')[0] || 'Member',
      photoURL: props.photoURL || null,
      role: props.role || 'member',
      status: props.status || 'invited',    // invited | active | removed
      color: props.color || avatarColor(props.email || props.name || ''),
      capacityHoursPerWeek: props.capacityHoursPerWeek ?? 40,
      invitedAt: props.invitedAt || nowISO(),
      joinedAt: props.joinedAt || null,
    };
  }

  function makeList(props = {}) {
    return {
      id: props.id || uid('list'),
      name: props.name || 'New list',
      color: props.color || '#4262ff',
      icon: props.icon || 'ph-list-checks',
      order: props.order || ORDER_MID,
      archived: false,
      createdAt: nowISO(),
    };
  }

  function makeSprint(props = {}) {
    return {
      id: props.id || uid('sprint'),
      name: props.name || 'Sprint',
      goal: props.goal || '',
      startDate: props.startDate || null,
      endDate: props.endDate || null,
      status: props.status || 'planned',    // planned | active | closed
      createdAt: nowISO(),
    };
  }

  function makeProject(props = {}) {
    const pipeline = props.statuses
      || (PIPELINE_PRESETS[props.preset] || PIPELINE_PRESETS.simple).statuses;

    return {
      id: props.id || uid('proj'),
      name: (props.name || '').trim() || 'New project',
      description: props.description || '',
      category: props.category || 'Engineering',
      color: props.color || '#4262ff',
      icon: props.icon || 'ph-kanban',
      status: props.status || 'active',     // active | paused | done | archived
      priority: props.priority || 'normal',

      statuses: pipeline.map(s => ({ ...s })),
      lists: (props.lists || [makeList({ name: 'Tasks' })]).map(l => ({ ...l })),
      sprints: (props.sprints || []).map(s => ({ ...s })),
      tags: props.tags || [],
      customFields: props.customFields || [],

      members: (props.members || []).map(makeMember),
      memberUids: [],                       // denormalised for Firestore queries
      memberEmails: [],                     // ditto, for invite-before-signup

      boards: props.boards || [],           // whiteboard ids attached to this project
      startDate: props.startDate || null,
      dueDate: props.dueDate || null,

      settings: {
        defaultView: 'board',
        wipLimits: {},                      // { statusId: n }
        autoEmail: {
          onAssign: true,
          onMention: true,
          onDueSoon: true,
          onStatusDone: false,
          digest: 'daily',                  // off | daily | weekly
        },
        calendarSync: false,
        ...(props.settings || {}),
      },

      createdBy: props.createdBy || null,
      createdAt: props.createdAt || nowISO(),
      updatedAt: props.updatedAt || nowISO(),
    };
  }

  /* ------------------------------------------------------------------
     Derived values

     Anything a view wants to show but the record does not store.
     Kept here so List, Board, Calendar and Timeline all agree on what
     "overdue" and "progress" mean.
     ------------------------------------------------------------------ */

  function statusOf(project, task) {
    const list = (project && project.statuses) || DEFAULT_PIPELINE;
    return list.find(s => s.id === task.statusId) || list[0] || DEFAULT_PIPELINE[0];
  }

  function isDone(project, task) {
    return CLOSED_KINDS.has(statusOf(project, task).kind);
  }

  function isComplete(project, task) {
    return statusOf(project, task).kind === 'done';
  }

  /** Start of today in local time — the reference point for overdue. */
  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function parseDate(iso) {
    if (!iso) return null;
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    return isNaN(d) ? null : d;
  }

  /** Whole days from today; negative is in the past. */
  function daysUntil(iso) {
    const d = parseDate(iso);
    if (!d) return null;
    d.setHours(0, 0, 0, 0);
    return Math.round((d - today()) / 86400000);
  }

  function isOverdue(project, task) {
    if (!task.dueDate || isDone(project, task)) return false;
    return daysUntil(task.dueDate) < 0;
  }

  function isDueSoon(project, task, withinDays = 2) {
    if (!task.dueDate || isDone(project, task)) return false;
    const d = daysUntil(task.dueDate);
    return d !== null && d >= 0 && d <= withinDays;
  }

  function loggedMinutes(task) {
    return (task.timeEntries || []).reduce((sum, e) => sum + (e.minutes || 0), 0);
  }

  function checklistProgress(task) {
    const items = task.checklist || [];
    if (!items.length) return null;
    const done = items.filter(i => i.done).length;
    return { done, total: items.length, pct: Math.round((done / items.length) * 100) };
  }

  /**
   * Progress of a task, 0–100.
   *
   * Preference order matters: a done status is 100 regardless of an
   * unfinished checklist (people tick the box last), subtasks outrank
   * a checklist because they are real tracked work, and a bare task
   * with neither is binary.
   */
  function progressOf(project, task, subtasks = []) {
    if (isComplete(project, task)) return 100;
    if (statusOf(project, task).kind === 'cancelled') return 100;

    if (subtasks.length) {
      const total = subtasks.reduce((s, st) => s + progressOf(project, st, []), 0);
      return Math.round(total / subtasks.length);
    }
    const ck = checklistProgress(task);
    if (ck) return ck.pct;
    return statusOf(project, task).kind === 'active' ? 50 : 0;
  }

  /**
   * Health of a whole project, for the dashboard cards.
   * Returns counts plus a single 0–100 score so cards can sort by it.
   */
  function projectHealth(project, tasks) {
    const live = tasks.filter(t => !t.archived);
    const total = live.length;
    if (!total) {
      return { total: 0, done: 0, active: 0, overdue: 0, unassigned: 0, pct: 0, score: 100, label: 'empty' };
    }

    let done = 0, active = 0, overdue = 0, unassigned = 0;
    for (const t of live) {
      const kind = statusOf(project, t).kind;
      if (kind === 'done') done++;
      if (kind === 'active' || kind === 'review') active++;
      if (isOverdue(project, t)) overdue++;
      if (!t.assignees.length && !CLOSED_KINDS.has(kind)) unassigned++;
    }

    const pct = Math.round((done / total) * 100);
    // Overdue work is the strongest negative signal; unassigned open
    // work is a weaker one. Both are capped so a big backlog cannot
    // drive the score below zero on its own.
    const penalty = Math.min(60, (overdue / total) * 100) + Math.min(20, (unassigned / total) * 40);
    const score = clamp(Math.round(pct - penalty + 40), 0, 100);

    let label = 'on track';
    if (overdue > 0 && overdue / total > 0.25) label = 'at risk';
    else if (overdue > 0) label = 'slipping';
    if (pct === 100) label = 'complete';

    return { total, done, active, overdue, unassigned, pct, score, label };
  }

  /**
   * Per-person load over a date window, for the Workload view.
   * Splits each task's estimate evenly across the days it spans, so a
   * 10-hour task over 5 days reads as 2h/day rather than a spike.
   */
  function workloadFor(project, tasks, members, { from, to } = {}) {
    const start = from ? parseDate(from) : today();
    const end = to ? parseDate(to) : new Date(today().getTime() + 13 * 86400000);
    const dayCount = Math.max(1, Math.round((end - start) / 86400000) + 1);

    const byUser = new Map();
    for (const m of members) {
      byUser.set(m.uid || m.email, {
        member: m,
        minutes: 0,
        tasks: [],
        overdue: 0,
        capacityMinutes: (m.capacityHoursPerWeek || 40) * 60 * (dayCount / 7),
        perDay: new Array(dayCount).fill(0),
      });
    }

    for (const t of tasks) {
      if (t.archived || isDone(project, t)) continue;
      if (!t.assignees.length) continue;

      const est = t.estimateMinutes || 60;          // an unestimated task still occupies time
      const share = est / t.assignees.length;

      const tStart = parseDate(t.startDate) || parseDate(t.dueDate) || start;
      const tEnd = parseDate(t.dueDate) || tStart;
      const spanStart = new Date(Math.max(tStart, start));
      const spanEnd = new Date(Math.min(tEnd, end));
      const spanDays = Math.max(1, Math.round((spanEnd - spanStart) / 86400000) + 1);

      for (const a of t.assignees) {
        const bucket = byUser.get(a);
        if (!bucket) continue;                       // assignee left the project
        bucket.minutes += share;
        bucket.tasks.push(t);
        if (isOverdue(project, t)) bucket.overdue++;

        if (spanEnd >= start && spanStart <= end) {
          const perDay = share / spanDays;
          const offset = Math.round((spanStart - start) / 86400000);
          for (let d = 0; d < spanDays; d++) {
            const idx = offset + d;
            if (idx >= 0 && idx < dayCount) bucket.perDay[idx] += perDay;
          }
        }
      }
    }

    return [...byUser.values()].map(b => ({
      ...b,
      utilisation: b.capacityMinutes ? Math.round((b.minutes / b.capacityMinutes) * 100) : 0,
    }));
  }

  /**
   * Critical-path-ish ordering for the Timeline view: tasks sorted so
   * every task appears after everything it is blocked by. Cycles are
   * broken rather than throwing — a user *can* create one, and the
   * timeline still has to draw.
   */
  function topoSort(tasks) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const seen = new Set();
    const stack = new Set();
    const out = [];

    function visit(t) {
      if (seen.has(t.id) || stack.has(t.id)) return;   // stack hit = cycle, stop descending
      stack.add(t.id);
      for (const dep of t.dependencies || []) {
        if (dep.type !== 'blocked_by') continue;
        const up = byId.get(dep.taskId);
        if (up) visit(up);
      }
      stack.delete(t.id);
      seen.add(t.id);
      out.push(t);
    }

    for (const t of tasks) visit(t);
    return out;
  }

  /* ------------------------------------------------------------------
     Sorting & grouping
     ------------------------------------------------------------------ */

  const SORTERS = {
    manual:   (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0),
    title:    (a, b) => a.title.localeCompare(b.title),
    priority: (a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0),
    dueDate:  (a, b) => nullsLast(a.dueDate, b.dueDate),
    startDate:(a, b) => nullsLast(a.startDate, b.startDate),
    created:  (a, b) => (a.createdAt < b.createdAt ? -1 : 1),
    updated:  (a, b) => (a.updatedAt > b.updatedAt ? -1 : 1),
    estimate: (a, b) => (b.estimateMinutes || 0) - (a.estimateMinutes || 0),
  };

  /** Empty dates sort to the bottom in both directions — an undated task is never "soonest". */
  function nullsLast(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function sortTasks(tasks, key = 'manual', dir = 'asc') {
    const fn = SORTERS[key] || SORTERS.manual;
    const out = tasks.slice().sort(fn);
    return dir === 'desc' ? out.reverse() : out;
  }

  const GROUPERS = {
    status:   (t) => t.statusId,
    priority: (t) => t.priority || '__none',
    assignee: (t) => (t.assignees[0] || '__none'),
    list:     (t) => t.listId || '__none',
    sprint:   (t) => t.sprintId || '__none',
    dueWeek:  (t) => (t.dueDate ? weekKey(t.dueDate) : '__none'),
    tag:      (t) => (t.tags[0] || '__none'),
    none:     () => '__all',
  };

  function weekKey(iso) {
    const d = parseDate(iso);
    if (!d) return '__none';
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }

  function groupTasks(tasks, key = 'status') {
    const fn = GROUPERS[key] || GROUPERS.status;
    const map = new Map();
    for (const t of tasks) {
      const k = fn(t);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(t);
    }
    return map;
  }

  /* ------------------------------------------------------------------
     Filtering

     One declarative filter object drives every view, so a filter set
     on the List view survives a switch to Calendar.
     ------------------------------------------------------------------ */

  function matchesFilter(project, task, f = {}) {
    if (!f) return true;

    if (!f.includeArchived && task.archived) return false;
    if (!f.includeDone && f.hideDone && isDone(project, task)) return false;

    if (f.text) {
      const q = f.text.toLowerCase();
      const hay = `${task.title} ${task.description} ${task.tags.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.statusIds?.length && !f.statusIds.includes(task.statusId)) return false;
    if (f.priorities?.length && !f.priorities.includes(task.priority)) return false;
    if (f.listIds?.length && !f.listIds.includes(task.listId)) return false;
    if (f.sprintIds?.length && !f.sprintIds.includes(task.sprintId)) return false;
    if (f.tags?.length && !f.tags.some(tag => task.tags.includes(tag))) return false;

    if (f.assignees?.length) {
      const wantsUnassigned = f.assignees.includes('__none');
      const hit = task.assignees.some(a => f.assignees.includes(a))
        || (wantsUnassigned && !task.assignees.length);
      if (!hit) return false;
    }

    if (f.dueBefore && (!task.dueDate || task.dueDate > f.dueBefore)) return false;
    if (f.dueAfter && (!task.dueDate || task.dueDate < f.dueAfter)) return false;
    if (f.overdueOnly && !isOverdue(project, task)) return false;
    if (f.unassignedOnly && task.assignees.length) return false;
    if (f.noDueDate && task.dueDate) return false;

    if (f.custom) {
      for (const [fieldId, want] of Object.entries(f.custom)) {
        if (want == null || want === '') continue;
        const got = task.custom?.[fieldId];
        if (Array.isArray(want)) { if (!want.includes(got)) return false; }
        else if (got !== want) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------
     Small shared helpers
     ------------------------------------------------------------------ */

  function dedupe(arr) {
    return Array.isArray(arr) ? [...new Set(arr.filter(Boolean))] : [];
  }

  function extractMentions(text) {
    const out = [];
    const re = /@([\w.+-]+@[\w-]+\.[\w.]+|[\w][\w.-]{1,30})/g;
    let m;
    while ((m = re.exec(String(text || '')))) out.push(m[1]);
    return [...new Set(out)];
  }

  /** Deterministic avatar colour so the same person is the same colour everywhere. */
  const AVATAR_COLORS = [
    '#4262ff', '#e0455e', '#17a673', '#e8912b', '#a855f7',
    '#06b6d4', '#ec4899', '#f59e0b', '#10b981', '#6366f1',
  ];
  function avatarColor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initialsOf(member) {
    const src = (member?.name || member?.email || '?').trim();
    const parts = src.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase();
  }

  function formatMinutes(mins) {
    if (!mins) return '—';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    if (!h) return `${m}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDueDate(iso) {
    const d = daysUntil(iso);
    if (d === null) return '';
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    if (d === -1) return 'Yesterday';
    if (d > 1 && d < 7) return parseDate(iso).toLocaleDateString(undefined, { weekday: 'short' });
    if (d < 0) return `${Math.abs(d)}d overdue`;
    return parseDate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function toDateInput(iso) { return iso ? String(iso).slice(0, 10) : ''; }

  /* ------------------------------------------------------------------ */

  global.PMSchema = {
    // constants
    STATUS_KINDS, CLOSED_KINDS, DEFAULT_PIPELINE, PIPELINE_PRESETS,
    PRIORITIES, PRIORITY_BY_ID, PRIORITY_RANK,
    ROLES, DEPENDENCY_TYPES, FIELD_TYPES, AVATAR_COLORS,

    // factories
    uid, nowISO, makeTask, makeComment, makeChecklistItem, makeTimeEntry,
    makeMember, makeList, makeSprint, makeProject,

    // ordering
    orderBetween, orderAfterAll, orderBeforeAll,

    // derived
    statusOf, isDone, isComplete, isOverdue, isDueSoon,
    loggedMinutes, checklistProgress, progressOf, projectHealth,
    workloadFor, topoSort,

    // query
    SORTERS, GROUPERS, sortTasks, groupTasks, matchesFilter,

    // permissions
    roleCan,

    // helpers
    clamp, dedupe, extractMentions, avatarColor, initialsOf,
    formatMinutes, formatDueDate, toDateInput, parseDate, daysUntil, today, weekKey,
  };

})(window);
