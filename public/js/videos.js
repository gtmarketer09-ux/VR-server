(function () {
  const grid = document.getElementById('video-grid');
  const pagination = document.getElementById('pagination');
  const categoryFilter = document.getElementById('category-filter');
  const tabGallery = document.getElementById('tab-gallery');
  const tabJson = document.getElementById('tab-json');
  const galleryView = document.getElementById('gallery-view');
  const jsonView = document.getElementById('json-view');
  const jsonOutput = document.getElementById('json-output');
  const modal = document.getElementById('player-modal');
  const modalVideo = document.getElementById('player-video');
  const modalClose = document.getElementById('player-close');
  const modalQuality = document.getElementById('player-quality');
  const modalInfo = document.getElementById('player-info');
  let activePlayer = null;

  const PAGE_SIZE = 12;
  let currentPage = 1;
  let currentCategory = '';

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
    if (status === 'ready') return '';
    if (status === 'failed') return `<span class="pill pill-failed">Failed</span>`;
    return `<span class="pill pill-processing">Processing${progress ? ` ${progress}%` : ''}</span>`;
  }

  function renditionsLine(renditions) {
    if (!renditions || !renditions.length) return '';
    return `<div class="renditions">${renditions.map(escapeHtml).join(' · ')}</div>`;
  }

  async function loadCategories() {
    const res = await fetch('/api/categories');
    if (!res.ok) return;
    const categories = await res.json();
    let optionsHtml = `<option value="">All categories</option>`;
    for (const c of categories) {
      optionsHtml += `<option value="cat-${c.id}">${escapeHtml(c.name)} (${c.video_count})</option>`;
      if (c.subcategories && c.subcategories.length > 0) {
        for (const sc of c.subcategories) {
          optionsHtml += `<option value="sub-${sc.id}">&nbsp;&nbsp;↳ ${escapeHtml(sc.name)} (${sc.video_count || 0})</option>`;
        }
      }
    }
    categoryFilter.innerHTML = optionsHtml;
  }

  function renderCard(v) {
    // Thumbnails use loading="lazy" so only what's actually visible on screen
    // downloads - this is what keeps the page fast once there are hundreds
    // of videos. The <video> element itself is never mounted on the grid at
    // all: clicking a card opens the modal and sets .src only at that point,
    // so no video bytes are fetched until the person actually wants to watch.
    const thumb = v.thumbnail_url
      ? `<img src="${v.thumbnail_url}" alt="${escapeHtml(v.title)}" loading="lazy" />`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">No preview</div>`;

    return `
      <div class="video-card" data-id="${v.id}">
        <div class="video-thumb-wrap" data-video-url="${v.video_url || ''}" data-hls-url="${v.hls_url || ''}" data-status="${v.status}">
          ${thumb}
          ${v.status === 'ready' ? `<div class="play-overlay"><svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></div>` : ''}
          ${v.duration_seconds ? `<span class="video-duration">${formatDuration(v.duration_seconds)}</span>` : ''}
        </div>
        <div class="video-body">
          <div class="video-title">${escapeHtml(v.title)}</div>
          ${v.description ? `<div class="video-desc">${escapeHtml(v.description)}</div>` : ''}
          <div class="video-meta">
            <span class="video-cat">${v.category ? escapeHtml(v.category.name) + (v.subcategory ? ` › ${escapeHtml(v.subcategory.name)}` : '') : 'Uncategorized'}</span>
            ${statusPill(v.status, v.progress)}
          </div>
          ${renditionsLine(v.renditions)}
          <button type="button" class="btn btn-danger-ghost delete-video-btn" data-id="${v.id}" data-title="${escapeHtml(v.title)}" style="margin-top:10px;width:100%;">Delete</button>
        </div>
      </div>
    `;
  }

  async function loadGallery() {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Loading…</div>`;
    const params = new URLSearchParams({ page: currentPage, limit: PAGE_SIZE });
    if (currentCategory) {
      if (currentCategory.startsWith('sub-')) {
        params.set('subcategory_id', currentCategory.slice(4));
      } else if (currentCategory.startsWith('cat-')) {
        params.set('category_id', currentCategory.slice(4));
      } else {
        params.set('category_id', currentCategory);
      }
    }

    const res = await fetch(`/api/videos?${params}`);
    if (!res.ok) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Could not load videos.</div>`;
      return;
    }
    const { data, pagination: p } = await res.json();

    if (data.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No videos in this category yet.</div>`;
      pagination.innerHTML = '';
      return;
    }

    grid.innerHTML = data.map(renderCard).join('');
    renderPagination(p);
  }

  function renderPagination(p) {
    if (p.total_pages <= 1) { pagination.innerHTML = ''; return; }
    pagination.innerHTML = `
      <button class="btn btn-ghost" id="prev-page" ${p.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${p.page} of ${p.total_pages} · ${p.total} videos</span>
      <button class="btn btn-ghost" id="next-page" ${p.page >= p.total_pages ? 'disabled' : ''}>Next →</button>
    `;
    document.getElementById('prev-page')?.addEventListener('click', () => { currentPage--; loadGallery(); });
    document.getElementById('next-page')?.addEventListener('click', () => { currentPage++; loadGallery(); });
  }

  grid.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.delete-video-btn');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = deleteBtn.dataset.id;
      const title = deleteBtn.dataset.title || 'this video';
      if (!confirm(`Are you sure you want to delete this video?\n\n"${title}"`)) return;

      deleteBtn.disabled = true;
      try {
        const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not delete video');
        const card = grid.querySelector(`.video-card[data-id="${id}"]`);
        if (card) card.remove();
        if (!grid.querySelector('.video-card')) {
          loadGallery();
        }
      } catch (err) {
        alert(err.message);
        deleteBtn.disabled = false;
      }
      return;
    }

    const wrap = e.target.closest('.video-thumb-wrap');
    if (!wrap) return;
    const mp4Url = wrap.dataset.videoUrl;
    const hlsUrl = wrap.dataset.hlsUrl;
    if ((!mp4Url && !hlsUrl) || wrap.dataset.status !== 'ready') return;
    if (activePlayer) activePlayer.destroy();
    // Adaptive HLS when available (auto quality + manual menu), MP4 otherwise.
    activePlayer = window.VideoCmsPlayer.attach(
      modalVideo,
      { hlsUrl, mp4Url },
      { qualitySelect: modalQuality, infoEl: modalInfo }
    );
    modal.style.display = 'flex';
    modalVideo.play().catch(() => {});
  });

  function closeModal() {
    modal.style.display = 'none';
    if (activePlayer) { activePlayer.destroy(); activePlayer = null; }
  }
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  categoryFilter.addEventListener('change', () => {
    currentCategory = categoryFilter.value;
    currentPage = 1;
    loadGallery();
  });

  async function loadJson() {
    jsonOutput.textContent = 'Loading…';
    const params = new URLSearchParams({ page: 1, limit: 100 });
    if (currentCategory) {
      if (currentCategory.startsWith('sub-')) {
        params.set('subcategory_id', currentCategory.slice(4));
      } else if (currentCategory.startsWith('cat-')) {
        params.set('category_id', currentCategory.slice(4));
      } else {
        params.set('category_id', currentCategory);
      }
    }
    const res = await fetch(`/api/videos?${params}`);
    const data = await res.json();
    jsonOutput.textContent = JSON.stringify(data, null, 2);
  }

  tabGallery.addEventListener('click', () => {
    tabGallery.classList.add('active');
    tabJson.classList.remove('active');
    galleryView.style.display = '';
    jsonView.style.display = 'none';
  });

  tabJson.addEventListener('click', () => {
    tabJson.classList.add('active');
    tabGallery.classList.remove('active');
    galleryView.style.display = 'none';
    jsonView.style.display = '';
    loadJson();
  });

  loadCategories();
  loadGallery();
})();
