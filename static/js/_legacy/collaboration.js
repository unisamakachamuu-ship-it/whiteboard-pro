/* ================================================================
   CollaborationManager – share, comments & presence (basic)
   ================================================================ */

class CollaborationManager {
  constructor(app) {
    this.app = app;
    this.cursors = {};
    this.connected = false;
    this.comments = [];
    this._bindUI();
  }

  _bindUI() {
    // Share modal
    document.getElementById('share-btn')?.addEventListener('click', () => this.openShareModal());
    document.querySelector('#share-modal .modal-close')?.addEventListener('click', () => this.closeShareModal());
    document.getElementById('share-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'share-modal') this.closeShareModal();
    });

    // Copy link
    document.getElementById('copy-link-btn')?.addEventListener('click', () => this.copyLink());
  }

  openShareModal() {
    document.getElementById('share-modal').classList.remove('hidden');
    const link = `${window.location.origin}/?board=${this.app.state.boardId || 'new'}`;
    document.getElementById('share-link').value = link;
  }

  closeShareModal() {
    document.getElementById('share-modal').classList.add('hidden');
  }

  copyLink() {
    const input = document.getElementById('share-link');
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      const btn = document.getElementById('copy-link-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  }

  /* -------- Comment System (local) -------- */

  addComment(x, y, text, author = 'You') {
    const comment = {
      id: 'comment-' + Date.now(),
      x, y, text, author,
      timestamp: new Date().toISOString(),
      resolved: false,
      replies: [],
    };
    this.comments.push(comment);
    this._renderCommentPin(comment);
    return comment;
  }

  _renderCommentPin(comment) {
    const pin = document.createElement('div');
    pin.className = 'board-element comment-pin';
    pin.dataset.elementId = comment.id;
    pin.style.left = comment.x + 'px';
    pin.style.top = comment.y + 'px';
    pin.style.width = '28px';
    pin.style.height = '28px';
    pin.style.borderRadius = '50%';
    pin.style.background = '#4262ff';
    pin.style.color = '#fff';
    pin.style.display = 'flex';
    pin.style.alignItems = 'center';
    pin.style.justifyContent = 'center';
    pin.style.fontSize = '14px';
    pin.style.fontWeight = '700';
    pin.style.cursor = 'pointer';
    pin.style.boxShadow = '0 2px 8px rgba(66,98,255,.4)';
    pin.style.zIndex = '9999';
    pin.textContent = '💬';
    pin.title = `${comment.author}: ${comment.text}`;

    document.getElementById('elements-layer')?.appendChild(pin);
  }

  resolveComment(id) {
    const c = this.comments.find(c => c.id === id);
    if (c) c.resolved = true;
  }

  /* -------- Presence (placeholder) -------- */

  showCursor(userId, x, y, name, color) {
    let cursor = document.getElementById(`cursor-${userId}`);
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = `cursor-${userId}`;
      cursor.style.position = 'absolute';
      cursor.style.pointerEvents = 'none';
      cursor.style.zIndex = '10000';
      cursor.style.transition = 'left 0.1s, top 0.1s';
      cursor.innerHTML = `
        <svg width="16" height="22" viewBox="0 0 16 22" fill="${color}">
          <path d="M0 0l16 16h-8l-4 6L0 0z"/>
        </svg>
        <span style="background:${color};color:#fff;font-size:11px;padding:1px 6px;border-radius:4px;margin-left:4px;white-space:nowrap;">${name}</span>
      `;
      document.getElementById('elements-layer')?.appendChild(cursor);
    }
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  }

  removeCursor(userId) {
    const cursor = document.getElementById(`cursor-${userId}`);
    if (cursor) cursor.remove();
  }
}

window.CollaborationManager = CollaborationManager;
