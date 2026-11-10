(function () {
  const form = document.getElementById('upload-form');
  const categorySelect = document.getElementById('category');
  const submitBtn = document.getElementById('submit-btn');
  const progressText = document.getElementById('progress-text');
  const formError = document.getElementById('form-error');
  const recentList = document.getElementById('recent-list');

  let pollTimer = null;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function statusPill(status, progress) {
    if (status === 'ready') return `<span class="pill pill-ready">Ready</span>`;
    if (status === 'failed') return `<span class="pill pill-failed">Failed</span>`;
    // progress 0 = waiting in the queue behind another conversion
    return `<span class="pill pill-processing">${progress ? `Converting ${progress}%` : 'Queued'}</span>`;
  }

  async function loadCategories() {
    const res = await fetch('/api/categories');
    if (!res.ok) return;
    const categories = await res.json();
    categorySelect.innerHTML =
      `<option value="">Uncategorized</option>` +
      categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  }

  // Recently-uploaded videos, newest first. Polls while anything is still
  // 'processing' so status pills update without a manual refresh, then stops.
  async function loadRecent() {
    const res = await fetch('/api/videos?page=1&limit=8');
    if (!res.ok) return;
    const { data } = await res.json();

    if (data.length === 0) {
      recentList.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">Nothing uploaded yet.</div>`;
      return;
    }

    recentList.innerHTML = data.map(renderCard).join('');

    const stillProcessing = data.some((v) => v.status === 'processing');
    clearTimeout(pollTimer);
    if (stillProcessing) {
      pollTimer = setTimeout(loadRecent, 3000);
    }
  }

  function renderCard(v) {
    const thumb = v.thumbnail_url
      ? `<img src="${v.thumbnail_url}" alt="" loading="lazy" />`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">${v.status === 'failed' ? 'Failed' : 'Processing…'}</div>`;

    const errorLine = v.status === 'failed' && v.error_message
      ? `<div class="video-meta" style="color:#c0392b;font-size:11px;margin-top:4px;" title="${escapeHtml(v.error_message)}">${escapeHtml(v.error_message)}</div>`
      : '';

    return `
      <div class="video-card" data-id="${v.id}">
        <div class="video-thumb-wrap">
          ${thumb}
          ${v.duration_seconds ? `<span class="video-duration">${formatDuration(v.duration_seconds)}</span>` : ''}
        </div>
        <div class="video-body">
          <div class="video-title">${escapeHtml(v.title)}</div>
          <div class="video-meta">
            <span class="video-cat">${v.category ? escapeHtml(v.category.name) : 'Uncategorized'}</span>
            ${statusPill(v.status, v.progress)}
          </div>
          ${v.renditions && v.renditions.length ? `<div class="renditions">${v.renditions.map(escapeHtml).join(' · ')}</div>` : ''}
          ${errorLine}
          <button type="button" class="btn btn-danger-ghost delete-video-btn" data-id="${v.id}" data-title="${escapeHtml(v.title)}" style="margin-top:10px;width:100%;">Delete</button>
        </div>
      </div>
    `;
  }

  recentList.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.delete-video-btn');
    if (!deleteBtn) return;
    const id = deleteBtn.dataset.id;
    const title = deleteBtn.dataset.title || 'this video';
    if (!confirm(`Are you sure you want to delete this video?\n\n"${title}"`)) return;

    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete video');
      const card = recentList.querySelector(`.video-card[data-id="${id}"]`);
      if (card) card.remove();
      if (!recentList.querySelector('.video-card')) loadRecent();
    } catch (err) {
      alert(err.message);
      deleteBtn.disabled = false;
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    formError.textContent = '';
    submitBtn.disabled = true;

    const formData = new FormData(form);
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.round((evt.loaded / evt.total) * 100);
        progressText.textContent = `Uploading… ${pct}%`;
      }
    });

    xhr.addEventListener('load', () => {
      submitBtn.disabled = false;
      if (xhr.status === 202) {
        progressText.textContent = 'Uploaded — converting to 1080p / 720p / 480p / 360p in the background.';
        form.reset();
        loadRecent();
        setTimeout(() => (progressText.textContent = ''), 4000);
      } else {
        let message = 'Upload failed';
        try { message = JSON.parse(xhr.responseText).error || message; } catch (_) {}
        formError.textContent = message;
        progressText.textContent = '';
      }
    });

    xhr.addEventListener('error', () => {
      submitBtn.disabled = false;
      formError.textContent = 'Upload failed — check your connection and try again.';
      progressText.textContent = '';
    });

    xhr.open('POST', '/api/videos');
    xhr.send(formData);
  });

  loadCategories();
  loadRecent();
})();
