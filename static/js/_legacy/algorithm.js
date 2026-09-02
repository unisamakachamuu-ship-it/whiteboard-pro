/* ================================================================
   AlgorithmManager – Full visual algorithm editor with modal
   ================================================================ */

class AlgorithmManager {
  constructor(app) {
    this.app = app;
    this._editingId = null;
    this._buildModal();
  }

  /* ---- Color themes ---- */
  static THEMES = {
    dark:   { bg: '#1e1e1e', headerBg: '#2d2d2d', text: '#d4d4d4', border: '#404040', name: '🌙 Dark' },
    ocean:  { bg: '#0d1b2a', headerBg: '#1b2838', text: '#e0e1dd', border: '#415a77', name: '🌊 Ocean' },
    forest: { bg: '#1b2e1b', headerBg: '#2d3e2d', text: '#d4e7d4', border: '#3a5a3a', name: '🌲 Forest' },
    sunset: { bg: '#2e1a0e', headerBg: '#3d2a1a', text: '#f0dcc8', border: '#5a3a2a', name: '🌅 Sunset' },
    light:  { bg: '#f8f9fb', headerBg: '#e9ecef', text: '#1a1a2e', border: '#d0d5dd', name: '☀️ Light' },
    purple: { bg: '#1a1030', headerBg: '#2a1a40', text: '#e0d4f0', border: '#4a3a6a', name: '💜 Purple' },
  };

  /* ---- Step type detection (smart syntax parser) ---- */
  static classifyLine(text) {
    const t = text.trim().toLowerCase();
    if (!t) return 'blank';
    if (t.startsWith('#') || t.startsWith('//')) return 'comment';
    if (/^(def |function |class |procedure |algorithm |begin$|start$)/.test(t)) return 'start';
    if (/^(return |end$|stop$|exit$)/.test(t)) return 'end';
    if (/^(if |else|elif |switch |case )/.test(t)) return 'condition';
    if (/^(for |while |do |loop |repeat )/.test(t)) return 'loop';
    if (/^(input|output|read|write|print|display|scan|prompt)/.test(t)) return 'io';
    if (/^(set |let |var |const |int |float |string |bool )/.test(t)) return 'declare';
    return 'process';
  }

  static STEP_META = {
    start:     { icon: '▶', color: '#569cd6', label: 'START' },
    end:       { icon: '⏹', color: '#ce9178', label: 'END' },
    condition: { icon: '◇', color: '#c586c0', label: 'IF/ELSE' },
    loop:      { icon: '↻', color: '#dcdcaa', label: 'LOOP' },
    io:        { icon: '⇄', color: '#4ec9b0', label: 'I/O' },
    declare:   { icon: '≡', color: '#9cdcfe', label: 'VAR' },
    process:   { icon: '▸', color: '#d4d4d4', label: 'PROC' },
    comment:   { icon: '#', color: '#6a9955', label: 'NOTE' },
    blank:     { icon: ' ', color: '#555',     label: '' },
  };

  /* ---- Build the modal (once) ---- */
  _buildModal() {
    if (document.getElementById('algo-editor-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'algo-editor-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-content algo-editor-content">
        <div class="modal-header">
          <h3>⚡ Algorithm Editor</h3>
          <button class="modal-close" id="algo-modal-close">&times;</button>
        </div>
        <div class="algo-editor-body">
          <div class="algo-editor-row">
            <input type="text" id="algo-editor-title" placeholder="Algorithm Name" value="Algorithm" />
          </div>
          <div class="algo-editor-row algo-theme-row" id="algo-theme-row"></div>
          <div class="algo-editor-main">
            <div class="algo-preview-pane" id="algo-preview"></div>
            <textarea id="algo-editor-code" spellcheck="false" placeholder="Write your algorithm / pseudocode here...
Example:
def BubbleSort(A, n):
    for i = 0 to n-1:
        for j = 0 to n-i-1:
            if A[j] > A[j+1]:
                swap(A[j], A[j+1])
    return A"></textarea>
          </div>
          <div class="algo-editor-legend">
            <span class="algo-legend-item" style="color:#569cd6">▶ Start/Def</span>
            <span class="algo-legend-item" style="color:#c586c0">◇ Condition</span>
            <span class="algo-legend-item" style="color:#dcdcaa">↻ Loop</span>
            <span class="algo-legend-item" style="color:#4ec9b0">⇄ I/O</span>
            <span class="algo-legend-item" style="color:#9cdcfe">≡ Variable</span>
            <span class="algo-legend-item" style="color:#ce9178">⏹ End</span>
            <span class="algo-legend-item" style="color:#6a9955"># Comment</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="algo-editor-save">💾 Save</button>
          <button class="btn btn-outline" id="algo-editor-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Theme buttons
    const themeRow = document.getElementById('algo-theme-row');
    Object.entries(AlgorithmManager.THEMES).forEach(([key, theme]) => {
      const btn = document.createElement('button');
      btn.className = 'algo-theme-btn';
      btn.dataset.theme = key;
      btn.textContent = theme.name;
      btn.style.background = theme.bg;
      btn.style.color = theme.text;
      btn.style.border = `1px solid ${theme.border}`;
      themeRow.appendChild(btn);
    });

    // Events
    document.getElementById('algo-modal-close').addEventListener('click', () => this._closeModal());
    document.getElementById('algo-editor-cancel').addEventListener('click', () => this._closeModal());
    document.getElementById('algo-editor-save').addEventListener('click', () => this._saveFromModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) this._closeModal(); });

    // Live preview on typing
    document.getElementById('algo-editor-code').addEventListener('input', () => this._updatePreview());

    // Theme buttons
    themeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme]');
      if (btn) {
        themeRow.querySelectorAll('.algo-theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updatePreview();
      }
    });
  }

  /* ---- Open modal for editing an element ---- */
  openEditor(elId) {
    const el = this.app.state.elements.find(e => e.id === elId);
    if (!el) return;
    this._editingId = elId;

    document.getElementById('algo-editor-title').value = el.content || 'Algorithm';
    document.getElementById('algo-editor-code').value =
      (el.algoSteps || []).map(s => s.text).join('\n');

    // Select current theme
    const themeName = el.algoTheme || 'dark';
    document.querySelectorAll('.algo-theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === themeName);
    });

    this._updatePreview();
    document.getElementById('algo-editor-modal').classList.remove('hidden');
    document.getElementById('algo-editor-code').focus();
  }

  _closeModal() {
    document.getElementById('algo-editor-modal').classList.add('hidden');
    this._editingId = null;
  }

  _getSelectedTheme() {
    const active = document.querySelector('.algo-theme-btn.active');
    return active ? active.dataset.theme : 'dark';
  }

  _saveFromModal() {
    const el = this.app.state.elements.find(e => e.id === this._editingId);
    if (!el) return;

    const title = document.getElementById('algo-editor-title').value.trim() || 'Algorithm';
    const code  = document.getElementById('algo-editor-code').value;
    const theme = this._getSelectedTheme();

    const lines = code.split('\n');
    el.content = title;
    el.algoTheme = theme;
    el.algoSteps = lines.map(text => ({
      text,
      type: AlgorithmManager.classifyLine(text),
    }));

    // Resize to fit content
    el.height = Math.max(120, 50 + lines.length * 22 + 20);

    this.app.board.renderElement(el);
    this.app.pushHistory('algo-edit');
    this.app.saveState();
    this._closeModal();
  }

  _updatePreview() {
    const code = document.getElementById('algo-editor-code').value;
    const title = document.getElementById('algo-editor-title').value || 'Algorithm';
    const themeName = this._getSelectedTheme();
    const theme = AlgorithmManager.THEMES[themeName] || AlgorithmManager.THEMES.dark;
    const lines = code.split('\n');

    const preview = document.getElementById('algo-preview');
    let html = `<div class="algo-block-preview" style="background:${theme.bg};color:${theme.text};border:1px solid ${theme.border};">`;
    html += `<div class="algo-header-preview" style="background:${theme.headerBg};border-bottom:1px solid ${theme.border};">`;
    html += `<span style="margin-right:6px;">⚡</span>${this._esc(title)}</div>`;
    html += `<div class="algo-body-preview">`;

    lines.forEach((line, i) => {
      const type = AlgorithmManager.classifyLine(line);
      const meta = AlgorithmManager.STEP_META[type];
      const indent = line.match(/^(\s*)/)[1].length;
      const paddingLeft = 12 + indent * 8;
      html += `<div class="algo-step-preview" style="padding-left:${paddingLeft}px">`;
      html += `<span class="algo-ln">${i + 1}</span>`;
      html += `<span class="algo-type-badge" style="color:${meta.color}">${meta.icon}</span>`;
      html += `<span style="color:${meta.color}">${this._esc(line.trim()) || '&nbsp;'}</span>`;
      html += `</div>`;
    });

    html += `</div></div>`;
    preview.innerHTML = html;
  }

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}

window.AlgorithmManager = AlgorithmManager;
