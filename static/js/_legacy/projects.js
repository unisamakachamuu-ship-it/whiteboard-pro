/* ================================================================
   projects.js — Professional Enterprise Project Management Workspace
   ================================================================ */

class ProjectManager {
  constructor(app) {
    this.app = app;
    this.projects = [];
    this.currentProject = null;
    this.currentBoardId = null;
    this.activeFilter = 'all';
    this.searchQuery = '';
    this.viewMode = 'dashboard';

    this._initDOM();
    this._bindEvents();
    this.loadProjects();
  }

  /* ---- DOM Scaffold ------------------------------------------------ */

  _initDOM() {
    const hub = document.createElement('div');
    hub.id = 'projects-hub';
    hub.className = 'projects-hub hidden';
    hub.innerHTML = `
      <aside class="pm-sidebar">
        <div class="pm-brand">
          <div class="pm-brand-icon"><i class="ph-bold ph-kanban"></i></div>
          <div class="pm-brand-text">
            <strong>Projects Hub</strong>
            <small>Team Workspace</small>
          </div>
        </div>

        <nav class="pm-nav">
          <button type="button" class="pm-nav-item is-active" data-filter="all"><i class="ph-bold ph-squares-four"></i> All Projects</button>
          <button type="button" class="pm-nav-item" data-filter="Engineering"><i class="ph-bold ph-code"></i> Engineering</button>
          <button type="button" class="pm-nav-item" data-filter="Design"><i class="ph-bold ph-paint-brush-broad"></i> Design System</button>
          <button type="button" class="pm-nav-item" data-filter="Product"><i class="ph-bold ph-rocket-launch"></i> Product</button>
          <button type="button" class="pm-nav-item" data-filter="Marketing"><i class="ph-bold ph-megaphone"></i> Marketing</button>
        </nav>

        <div class="pm-sidebar-footer">
          <button type="button" class="pm-back-canvas-btn" id="pm-back-canvas-btn">
            <i class="ph-bold ph-arrow-left"></i> Back to Canvas
          </button>
        </div>
      </aside>

      <main class="pm-main">
        <!-- Top Bar -->
        <header class="pm-topbar">
          <div class="pm-search-wrap">
            <i class="ph-bold ph-magnifying-glass pm-search-ic"></i>
            <input type="text" class="pm-search-input" id="pm-search-input" placeholder="Search projects, boards, members…" />
          </div>
          <div class="pm-topbar-actions">
            <button type="button" class="btn btn-primary pm-new-proj-btn" id="pm-create-proj-btn">
              <i class="ph-bold ph-plus"></i> New Project
            </button>
          </div>
        </header>

        <!-- View 1: Projects Overview (Dashboard) -->
        <div class="pm-view" id="pm-view-dashboard">
          <!-- Metrics Banner -->
          <div class="pm-metrics-row">
            <div class="pm-metric-card">
              <span class="pm-metric-icon ic-blue"><i class="ph-bold ph-folder-notch-open"></i></span>
              <div><b id="pm-stat-projects">0</b><span>Active Projects</span></div>
            </div>
            <div class="pm-metric-card">
              <span class="pm-metric-icon ic-purple"><i class="ph-bold ph-chalkboard"></i></span>
              <div><b id="pm-stat-boards">0</b><span>Separate Whiteboards</span></div>
            </div>
            <div class="pm-metric-card">
              <span class="pm-metric-icon ic-green"><i class="ph-bold ph-users-three"></i></span>
              <div><b id="pm-stat-members">0</b><span>Team Collaborators</span></div>
            </div>
            <div class="pm-metric-card">
              <span class="pm-metric-icon ic-amber"><i class="ph-bold ph-check-circle"></i></span>
              <div><b id="pm-stat-tasks">0%</b><span>Task Completion</span></div>
            </div>
          </div>

          <!-- Projects Grid -->
          <div class="pm-section-head">
            <h3>Workspaces</h3>
            <span class="pm-count-badge" id="pm-projects-count">0 projects</span>
          </div>

          <div class="pm-projects-grid" id="pm-projects-grid">
            <div class="pm-loading"><div class="spinner"></div><span>Loading projects…</span></div>
          </div>
        </div>

        <!-- View 2: Project Detail / Workspaces & Separate Boards -->
        <div class="pm-view hidden" id="pm-view-detail">
          <div class="pm-detail-banner" id="pm-detail-banner">
            <button type="button" class="pm-btn-text pm-detail-back" id="pm-detail-back"><i class="ph-bold ph-arrow-left"></i> All Projects</button>
            <div class="pm-detail-header-row">
              <div class="pm-detail-title-group">
                <div class="pm-detail-icon" id="pm-detail-icon"><i class="ph-bold ph-kanban"></i></div>
                <div>
                  <h1 class="pm-detail-title" id="pm-detail-title">Project Name</h1>
                  <p class="pm-detail-desc" id="pm-detail-desc">Project description</p>
                </div>
              </div>
              <div class="pm-detail-actions">
                <button type="button" class="btn btn-secondary" id="pm-invite-member-btn"><i class="ph-bold ph-user-plus"></i> Invite Team</button>
                <button type="button" class="btn btn-primary" id="pm-add-board-btn"><i class="ph-bold ph-plus"></i> Add Board</button>
              </div>
            </div>
          </div>

          <!-- Project Sub-Navigation Tabs -->
          <div class="pm-tabs">
            <button type="button" class="pm-tab is-active" data-tab="boards"><i class="ph-bold ph-chalkboard-simple"></i> Whiteboards (<span id="pm-tab-board-count">0</span>)</button>
            <button type="button" class="pm-tab" data-tab="team"><i class="ph-bold ph-users"></i> Team Members (<span id="pm-tab-team-count">0</span>)</button>
            <button type="button" class="pm-tab" data-tab="tasks"><i class="ph-bold ph-check-square"></i> Tasks &amp; Milestones</button>
          </div>

          <!-- Tab Content: Boards Grid -->
          <div class="pm-tab-content" id="pm-tab-boards">
            <div class="pm-boards-grid" id="pm-boards-grid"></div>
          </div>

          <!-- Tab Content: Team Members -->
          <div class="pm-tab-content hidden" id="pm-tab-team">
            <div class="pm-team-panel">
              <div class="pm-team-head">
                <div>
                  <h4>Team Collaborators</h4>
                  <p>Invite team members with their Gmail addresses. They will automatically receive an invitation email with direct board access.</p>
                </div>
                <button type="button" class="btn btn-primary" id="pm-invite-member-btn-2"><i class="ph-bold ph-envelope-simple"></i> Invite via Gmail</button>
              </div>

              <!-- Quick Inline Member Add Bar -->
              <div class="pm-add-member-bar">
                <input type="email" class="input pm-inline-input" id="pm-inline-email" placeholder="Enter teammate Gmail (e.g. alex@gmail.com)" />
                <select class="input pm-inline-select" id="pm-inline-role">
                  <option value="Editor">Editor</option>
                  <option value="Admin">Admin</option>
                  <option value="Viewer">Viewer</option>
                </select>
                <button type="button" class="btn btn-primary pm-inline-add-btn" id="pm-inline-add-btn">
                  <i class="ph-bold ph-user-plus"></i> Add Member
                </button>
              </div>

              <div class="pm-members-list" id="pm-members-list"></div>
            </div>
          </div>

          <!-- Tab Content: Tasks -->
          <div class="pm-tab-content hidden" id="pm-tab-tasks">
            <div class="pm-tasks-panel">
              <div class="pm-task-input-row">
                <input type="text" class="input" id="pm-new-task-input" placeholder="Add a milestone or deliverable…" />
                <button type="button" class="btn btn-primary" id="pm-add-task-btn">Add Task</button>
              </div>
              <div class="pm-tasks-list" id="pm-tasks-list"></div>
            </div>
          </div>
        </div>
      </main>
    `;

    document.body.appendChild(hub);

    // Topbar Project Switcher & Breadcrumb
    const topbarGroup = document.querySelector('.topbar-group');
    if (topbarGroup) {
      const projSwitchBtn = document.createElement('button');
      projSwitchBtn.className = 'btn btn-ghost pm-topbar-hub-btn';
      projSwitchBtn.id = 'pm-open-hub-btn';
      projSwitchBtn.innerHTML = '<i class="ph-bold ph-kanban"></i> <span>Projects</span>';
      projSwitchBtn.title = 'Open Project Management Workspace';
      topbarGroup.insertBefore(projSwitchBtn, topbarGroup.children[1] || null);

      const breadcrumb = document.createElement('span');
      breadcrumb.className = 'pm-breadcrumb hidden';
      breadcrumb.id = 'pm-breadcrumb';
      breadcrumb.innerHTML = '<span class="pm-bc-proj" id="pm-bc-proj">Project</span> <span class="pm-bc-sep">/</span> <span class="pm-bc-board" id="pm-bc-board">Board</span>';
      topbarGroup.appendChild(breadcrumb);
    }
  }

  /* ---- Event Listeners --------------------------------------------- */

  _bindEvents() {
    document.getElementById('pm-open-hub-btn')?.addEventListener('click', () => this.openHub());
    document.getElementById('pm-back-canvas-btn')?.addEventListener('click', () => this.closeHub());
    document.getElementById('pm-create-proj-btn')?.addEventListener('click', () => this.promptCreateProject());
    document.getElementById('pm-detail-back')?.addEventListener('click', () => this.showDashboard());
    document.getElementById('pm-add-board-btn')?.addEventListener('click', () => this.promptAddBoard());
    document.getElementById('pm-invite-member-btn')?.addEventListener('click', () => this.promptInviteMember());
    document.getElementById('pm-invite-member-btn-2')?.addEventListener('click', () => this.promptInviteMember());
    document.getElementById('pm-add-task-btn')?.addEventListener('click', () => this.addTask());

    // Inline Add Member button & Enter key
    const inlineAddBtn = document.getElementById('pm-inline-add-btn');
    const inlineEmail = document.getElementById('pm-inline-email');
    inlineAddBtn?.addEventListener('click', () => this.addMemberInline());
    inlineEmail?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addMemberInline();
      }
    });

    const searchInput = document.getElementById('pm-search-input');
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.renderProjectsGrid();
    });

    document.querySelectorAll('.pm-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pm-nav-item').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.activeFilter = btn.dataset.filter || 'all';
        this.renderProjectsGrid();
      });
    });

    document.querySelectorAll('.pm-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.pm-tab').forEach(t => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        const target = tab.dataset.tab;
        document.getElementById('pm-tab-boards')?.classList.toggle('hidden', target !== 'boards');
        document.getElementById('pm-tab-team')?.classList.toggle('hidden', target !== 'team');
        document.getElementById('pm-tab-tasks')?.classList.toggle('hidden', target !== 'tasks');
      });
    });

    const params = new URLSearchParams(window.location.search);
    const pid = params.get('project');
    const bid = params.get('board');
    if (pid) {
      this.loadProjectDetails(pid).then(() => {
        if (bid) this.launchBoard(pid, bid);
      });
    }
  }

  /* ---- Data Operations --------------------------------------------- */

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        this.projects = await res.json();
        this.updateMetrics();
        this.renderProjectsGrid();
      }
    } catch (err) {
      console.warn('Projects load error:', err);
    }
  }

  updateMetrics() {
    const totalProjects = this.projects.length;
    let totalBoards = 0;
    const memberEmails = new Set();
    let totalTasks = 0;
    let doneTasks = 0;

    this.projects.forEach(p => {
      totalBoards += (p.boards || []).length;
      (p.members || []).forEach(m => {
        if (m.email) memberEmails.add(m.email.toLowerCase());
      });
      (p.tasks || []).forEach(t => {
        totalTasks++;
        if (t.done) doneTasks++;
      });
    });

    const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

    const elProj = document.getElementById('pm-stat-projects');
    const elBoards = document.getElementById('pm-stat-boards');
    const elMembers = document.getElementById('pm-stat-members');
    const elTasks = document.getElementById('pm-stat-tasks');
    const elCount = document.getElementById('pm-projects-count');

    if (elProj) elProj.textContent = totalProjects;
    if (elBoards) elBoards.textContent = totalBoards;
    if (elMembers) elMembers.textContent = memberEmails.size || (totalProjects > 0 ? 1 : 0);
    if (elTasks) elTasks.textContent = completionRate + '%';
    if (elCount) elCount.textContent = `${totalProjects} workspace${totalProjects === 1 ? '' : 's'}`;
  }

  renderProjectsGrid() {
    const grid = document.getElementById('pm-projects-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const filtered = this.projects.filter(p => {
      const matchCat = this.activeFilter === 'all' || p.category === this.activeFilter;
      const matchSearch = !this.searchQuery ||
        p.name.toLowerCase().includes(this.searchQuery) ||
        (p.description || '').toLowerCase().includes(this.searchQuery) ||
        (p.boards || []).some(b => b.name.toLowerCase().includes(this.searchQuery)) ||
        (p.members || []).some(m => (m.name || '').toLowerCase().includes(this.searchQuery) || (m.email || '').toLowerCase().includes(this.searchQuery));
      return matchCat && matchSearch;
    });

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="pm-empty-card">
          <div class="pm-empty-icon"><i class="ph-bold ph-folder-dashed"></i></div>
          <h4>No projects found</h4>
          <p>Create your first team project to organize separate whiteboards and invite collaborators via Gmail.</p>
          <button type="button" class="btn btn-primary pm-create-empty-btn" id="pm-create-empty-btn">
            <i class="ph-bold ph-plus"></i> Create Project
          </button>
        </div>
      `;
      document.getElementById('pm-create-empty-btn')?.addEventListener('click', () => this.promptCreateProject());
      return;
    }

    filtered.forEach(p => {
      const card = document.createElement('div');
      card.className = 'pm-project-card';
      card.style.setProperty('--proj-accent', p.color || '#4262ff');

      const boardsCount = (p.boards || []).length;
      const members = p.members || [];
      const tasks = p.tasks || [];
      const doneCount = tasks.filter(t => t.done).length;
      const progress = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;

      const statusMap = {
        'in_progress': { label: 'In Progress', cls: 'status-progress' },
        'planning': { label: 'Planning', cls: 'status-planning' },
        'review': { label: 'In Review', cls: 'status-review' },
        'completed': { label: 'Completed', cls: 'status-completed' },
      };
      const statusInfo = statusMap[p.status] || statusMap['in_progress'];

      const avatarsHTML = members.slice(0, 4).map(m => {
        const initial = (m.name || m.email || 'U')[0].toUpperCase();
        return `<span class="pm-avatar-chip" title="${Util.escapeHTML(m.name || m.email)} (${m.role})">${initial}</span>`;
      }).join('') +
      (members.length > 4 ? `<span class="pm-avatar-more">+${members.length - 4}</span>` : '') +
      `<button type="button" class="pm-avatar-add-chip" title="Invite team member to ${Util.escapeHTML(p.name)}"><i class="ph-bold ph-plus"></i></button>`;

      card.innerHTML = `
        <div class="pm-card-banner">
          <div class="pm-card-icon"><i class="ph-bold ${p.icon || 'ph-kanban'}"></i></div>
          <span class="pm-status-pill ${statusInfo.cls}">${statusInfo.label}</span>
        </div>

        <div class="pm-card-body">
          <h3 class="pm-card-title">${Util.escapeHTML(p.name)}</h3>
          <p class="pm-card-desc">${Util.escapeHTML(p.description || 'Collaborative team project workspace.')}</p>

          <div class="pm-card-meta-row">
            <span class="pm-card-tag"><i class="ph-bold ph-tag"></i> ${p.category || 'Engineering'}</span>
            <span class="pm-card-tag"><i class="ph-bold ph-chalkboard"></i> ${boardsCount} board${boardsCount === 1 ? '' : 's'}</span>
          </div>

          <div class="pm-card-progress-wrap">
            <div class="pm-card-progress-label">
              <span>Milestones</span>
              <span>${progress}%</span>
            </div>
            <div class="pm-progress-bar"><div class="pm-progress-fill" style="width: ${progress}%"></div></div>
          </div>
        </div>

        <div class="pm-card-footer">
          <div class="pm-avatars-group">${avatarsHTML}</div>
          <button type="button" class="btn btn-primary btn-sm pm-card-open-btn"><i class="ph-bold ph-arrow-right"></i> Open</button>
        </div>
      `;

      // Quick invite from card
      card.querySelector('.pm-avatar-add-chip')?.addEventListener('click', e => {
        e.stopPropagation();
        this.promptInviteMember(p.id);
      });

      card.addEventListener('click', () => {
        this.openProjectDetails(p.id);
      });

      grid.appendChild(card);
    });
  }

  /* ---- Project Detail & Separate Boards View ----------------------- */

  async openProjectDetails(projectId) {
    await this.loadProjectDetails(projectId);
    this.showDetailView();
  }

  async loadProjectDetails(projectId) {
    try {
      const res = await fetch('/api/project/' + projectId);
      if (!res.ok) throw new Error('Project not found');
      this.currentProject = await res.json();
      this._renderDetailView();
    } catch (err) {
      if (window.Modal?.toast) window.Modal.toast('Could not open project', 'warn');
    }
  }

  _renderDetailView() {
    const p = this.currentProject;
    if (!p) return;

    document.getElementById('pm-detail-title').textContent = p.name;
    document.getElementById('pm-detail-desc').textContent = p.description || 'Team project workspace & boards';
    document.getElementById('pm-detail-icon').innerHTML = `<i class="ph-bold ${p.icon || 'ph-kanban'}"></i>`;
    document.getElementById('pm-detail-banner').style.setProperty('--proj-accent', p.color || '#4262ff');

    document.getElementById('pm-tab-board-count').textContent = (p.boards || []).length;
    document.getElementById('pm-tab-team-count').textContent = (p.members || []).length;

    this.renderBoardsList();
    this.renderMembersList();
    this.renderTasksList();
  }

  renderBoardsList() {
    const grid = document.getElementById('pm-boards-grid');
    if (!grid || !this.currentProject) return;
    grid.innerHTML = '';

    const boards = this.currentProject.boards || [];

    const addCard = document.createElement('div');
    addCard.className = 'pm-board-card pm-board-add-card';
    addCard.innerHTML = `
      <div class="pm-add-board-icon"><i class="ph-bold ph-plus"></i></div>
      <strong>New Whiteboard</strong>
      <small>Add separate board to this project</small>
    `;
    addCard.addEventListener('click', () => this.promptAddBoard());
    grid.appendChild(addCard);

    boards.forEach(b => {
      const card = document.createElement('div');
      card.className = 'pm-board-card';
      const updatedDate = new Date(b.updated_at || Date.now()).toLocaleDateString();

      card.innerHTML = `
        <div class="pm-board-preview">
          <div class="pm-board-preview-canvas"><i class="ph-bold ph-chalkboard-simple"></i></div>
          <span class="pm-board-badge">Live Board</span>
        </div>
        <div class="pm-board-info">
          <div class="pm-board-name">${Util.escapeHTML(b.name || 'Untitled Board')}</div>
          <div class="pm-board-desc">${Util.escapeHTML(b.description || 'Interactive whiteboard canvas')}</div>
          <div class="pm-board-footer">
            <small><i class="ph-bold ph-clock"></i> ${updatedDate}</small>
            <button type="button" class="btn btn-primary btn-sm pm-launch-btn"><i class="ph-bold ph-arrow-square-out"></i> Launch</button>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.launchBoard(this.currentProject.id, b.id);
      });

      grid.appendChild(card);
    });
  }

  /* ---- Team Members Management ------------------------------------- */

  renderMembersList() {
    const list = document.getElementById('pm-members-list');
    if (!list || !this.currentProject) return;
    list.innerHTML = '';

    const members = this.currentProject.members || [];
    if (!members.length) {
      list.innerHTML = `
        <div class="pm-empty-members">
          <p class="muted">No team members added yet. Invite your colleagues by Gmail above!</p>
        </div>
      `;
      return;
    }

    members.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'pm-member-row';
      const initial = (m.name || m.email || 'U')[0].toUpperCase();
      const isOwner = m.role === 'Owner';

      row.innerHTML = `
        <div class="pm-member-avatar">${initial}</div>
        <div class="pm-member-info">
          <strong>${Util.escapeHTML(m.name || m.email.split('@')[0])} ${isOwner ? '<span class="pm-owner-tag">Owner</span>' : ''}</strong>
          <span>${Util.escapeHTML(m.email)}</span>
        </div>
        <div class="pm-member-role-select-wrap">
          <select class="input pm-member-role-select" data-idx="${idx}" ${isOwner ? 'disabled' : ''}>
            <option value="Editor" ${m.role === 'Editor' ? 'selected' : ''}>Editor</option>
            <option value="Admin" ${m.role === 'Admin' ? 'selected' : ''}>Admin</option>
            <option value="Viewer" ${m.role === 'Viewer' ? 'selected' : ''}>Viewer</option>
          </select>
        </div>
        <div class="pm-member-status"><span class="pm-status-dot"></span> ${m.status || 'Active'}</div>
        <div class="pm-member-actions">
          <button type="button" class="pm-btn-icon pm-resend-btn" title="Resend Gmail Invitation"><i class="ph-bold ph-paper-plane-tilt"></i></button>
          ${!isOwner ? '<button type="button" class="pm-btn-icon pm-remove-member-btn" title="Remove member"><i class="ph-bold ph-trash"></i></button>' : ''}
        </div>
      `;

      // Role change
      row.querySelector('.pm-member-role-select')?.addEventListener('change', async e => {
        m.role = e.target.value;
        await this.saveCurrentProject();
        if (window.Modal?.toast) window.Modal.toast(`Updated ${m.email} to ${m.role}`, 'info', 1800);
      });

      // Resend invite
      row.querySelector('.pm-resend-btn')?.addEventListener('click', async () => {
        const inviter = window.FirebaseSync?.user?.displayName || 'Project Lead';
        await fetch(`/api/project/${this.currentProject.id}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: m.email, name: m.name, role: m.role, inviter })
        });
        if (window.Modal?.toast) window.Modal.toast(`Invitation resent to ${m.email}!`, 'success', 2500);
      });

      // Remove member
      row.querySelector('.pm-remove-member-btn')?.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.name || m.email} from ${this.currentProject.name}?`)) return;
        this.currentProject.members = this.currentProject.members.filter((_, i) => i !== idx);
        await this.saveCurrentProject();
        this._renderDetailView();
        if (window.Modal?.toast) window.Modal.toast('Member removed.', 'info', 2000);
      });

      list.appendChild(row);
    });
  }

  async addMemberInline() {
    if (!this.currentProject) return;
    const emailInput = document.getElementById('pm-inline-email');
    const roleSelect = document.getElementById('pm-inline-role');
    const email = emailInput?.value.trim().toLowerCase();
    const role = roleSelect?.value || 'Editor';

    if (!email || !email.includes('@') || !email.includes('.')) {
      if (window.Modal?.toast) window.Modal.toast('Please enter a valid Gmail / email address', 'warn', 2500);
      emailInput?.focus();
      return;
    }

    const inviter = window.FirebaseSync?.user?.displayName || 'Project Lead';
    const name = email.split('@')[0];

    try {
      const res = await fetch(`/api/project/${this.currentProject.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role, inviter })
      });

      if (res.ok) {
        const data = await res.json();
        this.currentProject = data.project || this.currentProject;
        emailInput.value = '';
        this._renderDetailView();
        this.loadProjects();
        if (window.Modal?.toast) {
          window.Modal.toast(`🎉 Added ${email} & dispatched Gmail notification!`, 'success', 3500);
        }
      } else {
        const err = await res.json();
        if (window.Modal?.toast) window.Modal.toast(err.error || 'Failed to add member', 'warn', 3000);
      }
    } catch (err) {
      console.error('Invite error:', err);
      if (window.Modal?.toast) window.Modal.toast('Could not reach server to invite member', 'warn');
    }
  }

  promptInviteMember(projectId) {
    const targetPid = projectId || this.currentProject?.id;
    if (!targetPid) {
      if (window.Modal?.toast) window.Modal.toast('Select a project first to invite team members', 'warn');
      return;
    }

    const targetProj = this.projects.find(p => p.id === targetPid) || this.currentProject;
    const projName = targetProj ? targetProj.name : 'Project';

    const body = document.createElement('div');
    body.className = 'pm-modal-body';
    body.innerHTML = `
      <p class="modal-text">Enter one or more Gmail addresses separated by commas. Each collaborator will receive an invitation email with direct access.</p>
      <label class="field">
        <span>Gmail Address(es)</span>
        <input type="text" class="input" id="pm-invite-email-input" placeholder="alex@gmail.com, partner@gmail.com" required autofocus />
      </label>
      <label class="field">
        <span>Name (Optional)</span>
        <input type="text" class="input" id="pm-invite-name-input" placeholder="Teammate Name" />
      </label>
      <label class="field">
        <span>Role</span>
        <select class="input" id="pm-invite-role-input">
          <option value="Editor">Editor (Can draw, add elements, edit data)</option>
          <option value="Admin">Admin (Can manage project &amp; boards)</option>
          <option value="Viewer">Viewer (Read-only access)</option>
        </select>
      </label>
    `;

    Modal.open({
      title: `✉️ Invite to ${Util.escapeHTML(projName)}`,
      width: 500,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Send Gmail Invitation',
          primary: true,
          onClick: async () => {
            const rawEmails = body.querySelector('#pm-invite-email-input').value.trim();
            if (!rawEmails) {
              if (window.Modal?.toast) window.Modal.toast('Please enter at least one Gmail address', 'warn');
              return true; // Keep modal open
            }

            const emails = rawEmails.split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(e => e && e.includes('@'));
            if (!emails.length) {
              if (window.Modal?.toast) window.Modal.toast('Please enter a valid Gmail address', 'warn');
              return true;
            }

            const name = body.querySelector('#pm-invite-name-input').value.trim();
            const role = body.querySelector('#pm-invite-role-input').value;
            const inviter = window.FirebaseSync?.user?.displayName || 'Project Lead';

            let count = 0;
            for (const email of emails) {
              try {
                const res = await fetch(`/api/project/${targetPid}/invite`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email, name: name || email.split('@')[0], role, inviter })
                });
                if (res.ok) count++;
              } catch (e) {
                console.error(e);
              }
            }

            await this.loadProjects();
            if (this.currentProject && this.currentProject.id === targetPid) {
              await this.loadProjectDetails(targetPid);
            }

            if (window.Modal?.toast) {
              window.Modal.toast(`🎉 Sent ${count} Gmail invitation${count === 1 ? '' : 's'}!`, 'success', 3500);
            }
            return false; // Close modal
          }
        }
      ]
    });
  }

  /* ---- Tasks & Milestones ------------------------------------------- */

  renderTasksList() {
    const list = document.getElementById('pm-tasks-list');
    if (!list || !this.currentProject) return;
    list.innerHTML = '';

    const tasks = this.currentProject.tasks || [];
    tasks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'pm-task-row' + (t.done ? ' is-done' : '');

      row.innerHTML = `
        <input type="checkbox" class="pm-task-check" ${t.done ? 'checked' : ''} />
        <span class="pm-task-text">${Util.escapeHTML(t.text)}</span>
        <button type="button" class="pm-task-del" title="Remove milestone">&times;</button>
      `;

      const check = row.querySelector('.pm-task-check');
      check.addEventListener('change', () => {
        t.done = check.checked;
        this.saveCurrentProject();
        this.renderTasksList();
      });

      const del = row.querySelector('.pm-task-del');
      del.addEventListener('click', () => {
        this.currentProject.tasks = this.currentProject.tasks.filter(x => x.id !== t.id);
        this.saveCurrentProject();
        this.renderTasksList();
      });

      list.appendChild(row);
    });
  }

  async addTask() {
    const input = document.getElementById('pm-new-task-input');
    const text = input?.value.trim();
    if (!text || !this.currentProject) return;

    if (!this.currentProject.tasks) this.currentProject.tasks = [];
    this.currentProject.tasks.push({
      id: 'task_' + Date.now(),
      text: text,
      done: false
    });

    input.value = '';
    await this.saveCurrentProject();
    this.renderTasksList();
  }

  async saveCurrentProject() {
    if (!this.currentProject) return;
    try {
      await fetch('/api/project/' + this.currentProject.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.currentProject)
      });
      this.loadProjects();
    } catch (e) {
      console.warn('Save project error:', e);
    }
  }

  /* ---- Launch Board into Main WhiteBoard Pro Canvas ----------------- */

  async launchBoard(projectId, boardId) {
    this.currentBoardId = boardId;
    this.closeHub();

    const url = new URL(window.location);
    url.searchParams.set('project', projectId);
    url.searchParams.set('board', boardId);
    window.history.pushState({}, '', url);

    const bc = document.getElementById('pm-breadcrumb');
    const bcProj = document.getElementById('pm-bc-proj');
    const bcBoard = document.getElementById('pm-bc-board');
    if (bc && this.currentProject) {
      bc.classList.remove('hidden');
      if (bcProj) bcProj.textContent = this.currentProject.name;
      const bObj = (this.currentProject.boards || []).find(b => b.id === boardId);
      if (bcBoard) bcBoard.textContent = bObj ? bObj.name : 'Canvas';
    }

    if (window.app) {
      await window.app.loadBoard(boardId);
      if (window.Modal?.toast) {
        window.Modal.toast(`Loaded "${this.currentProject?.name} / ${boardId}"`, 'success', 2000);
      }
    }
  }

  /* ---- Modals & Dialogs --------------------------------------------- */

  promptCreateProject() {
    const body = document.createElement('div');
    body.className = 'pm-modal-body';
    body.innerHTML = `
      <label class="field">
        <span>Project Name</span>
        <input type="text" class="input" id="pm-new-name" placeholder="e.g. Mobile App Redesign" required autofocus />
      </label>
      <label class="field">
        <span>Description</span>
        <textarea class="input" id="pm-new-desc" rows="2" placeholder="Goals, scope, and key deliverables…"></textarea>
      </label>
      <div class="pm-modal-grid-2">
        <label class="field">
          <span>Category</span>
          <select class="input" id="pm-new-cat">
            <option value="Engineering">Engineering</option>
            <option value="Design">Design System</option>
            <option value="Product">Product</option>
            <option value="Marketing">Marketing</option>
          </select>
        </label>
        <label class="field">
          <span>Priority</span>
          <select class="input" id="pm-new-priority">
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span>Invite Team Members by Gmail (Optional)</span>
        <input type="text" class="input" id="pm-new-invite-email" placeholder="alex@gmail.com, partner@gmail.com" />
      </label>
    `;

    Modal.open({
      title: '✨ Create New Project Workspace',
      width: 520,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create Project',
          primary: true,
          onClick: async () => {
            const name = body.querySelector('#pm-new-name').value.trim();
            if (!name) {
              if (window.Modal?.toast) window.Modal.toast('Project name is required', 'warn');
              return true;
            }
            const desc = body.querySelector('#pm-new-desc').value.trim();
            const cat = body.querySelector('#pm-new-cat').value;
            const priority = body.querySelector('#pm-new-priority').value;
            const rawInvites = body.querySelector('#pm-new-invite-email').value.trim();

            const ownerUser = window.FirebaseSync?.user;
            const res = await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                description: desc,
                category: cat,
                priority,
                ownerName: ownerUser?.displayName || 'Owner',
                ownerEmail: ownerUser?.email || 'owner@gmail.com'
              })
            });

            if (res.ok) {
              const created = await res.json();
              if (rawInvites) {
                const emails = rawInvites.split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(e => e && e.includes('@'));
                for (const email of emails) {
                  await fetch(`/api/project/${created.id}/invite`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email,
                      role: 'Editor',
                      inviter: ownerUser?.displayName || 'Project Lead'
                    })
                  }).catch(() => {});
                }
              }
              await this.loadProjects();
              this.openProjectDetails(created.id);
              if (window.Modal?.toast) window.Modal.toast('Project workspace created!', 'success');
              return false;
            }
          }
        }
      ]
    });
  }

  promptAddBoard() {
    if (!this.currentProject) return;
    const body = document.createElement('div');
    body.className = 'pm-modal-body';
    body.innerHTML = `
      <label class="field">
        <span>Board Name</span>
        <input type="text" class="input" id="pm-board-name-input" placeholder="e.g. Brainstorming / Sprint Architecture" required autofocus />
      </label>
      <label class="field">
        <span>Purpose / Description</span>
        <input type="text" class="input" id="pm-board-desc-input" placeholder="e.g. Flowcharts, diagrams, and task breakdowns" />
      </label>
    `;

    Modal.open({
      title: '＋ Add Whiteboard to ' + this.currentProject.name,
      width: 480,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create Board',
          primary: true,
          onClick: async () => {
            const name = body.querySelector('#pm-board-name-input').value.trim();
            if (!name) {
              if (window.Modal?.toast) window.Modal.toast('Board name is required', 'warn');
              return true;
            }
            const desc = body.querySelector('#pm-board-desc-input').value.trim();

            const res = await fetch(`/api/project/${this.currentProject.id}/boards`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, description: desc })
            });

            if (res.ok) {
              const data = await res.json();
              await this.loadProjectDetails(this.currentProject.id);
              if (window.Modal?.toast) window.Modal.toast('Board added to project!', 'success');
              this.launchBoard(this.currentProject.id, data.board.id);
              return false;
            }
          }
        }
      ]
    });
  }

  /* ---- View Switching ---------------------------------------------- */

  openHub() {
    document.getElementById('projects-hub')?.classList.remove('hidden');
    this.viewMode = 'dashboard';
    this.showDashboard();
    this.loadProjects();
  }

  closeHub() {
    document.getElementById('projects-hub')?.classList.add('hidden');
    this.viewMode = 'canvas';
  }

  showDashboard() {
    document.getElementById('pm-view-dashboard')?.classList.remove('hidden');
    document.getElementById('pm-view-detail')?.classList.add('hidden');
  }

  showDetailView() {
    document.getElementById('pm-view-dashboard')?.classList.add('hidden');
    document.getElementById('pm-view-detail')?.classList.remove('hidden');
  }
}

// Instantiate and expose globally
window.ProjectManager = ProjectManager;
