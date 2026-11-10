/**
 * Renders the sidebar and gates the page behind a session check.
 * Every protected page includes this script and an empty <div id="sidebar-mount">.
 * The server independently enforces auth on every API call too - this is
 * just what keeps a logged-out visitor from sitting on a blank protected page.
 */
(function () {
  const CURRENT_PAGE = document.body.dataset.page || '';

  const links = [
    { href: '/categories.html', label: 'Categories', page: 'categories' },
    { href: '/upload.html', label: 'Upload', page: 'upload' },
    { href: '/videos.html', label: 'Video library', page: 'videos' },
  ];

  function renderSidebar(username) {
    const mount = document.getElementById('sidebar-mount');
    if (!mount) return;

    const linkHtml = links
      .map(
        (l) =>
          `<a href="${l.href}" class="${l.page === CURRENT_PAGE ? 'active' : ''}">${l.label}</a>`
      )
      .join('');

    mount.innerHTML = `
      <div class="brand"><span class="dot"></span>Video CMS</div>
      <nav class="nav-links">${linkHtml}</nav>
      <div class="sidebar-footer">
        Signed in as <strong>${username}</strong>
        <button id="logout-btn" type="button">Log out</button>
      </div>
    `;

    document.getElementById('logout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }

  async function guard() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) throw new Error('unauthenticated');
      const data = await res.json();
      renderSidebar(data.username);
      document.body.classList.add('authed');
    } catch (err) {
      window.location.href = '/login.html';
    }
  }

  guard();
})();
