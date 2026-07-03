const $ = (sel) => document.querySelector(sel);
const CERT_KEY = 'caggyid_certificates';
let CSRF_TOKEN = null;

// ============ Auth guard ============
(async function checkAuth() {
  try {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/admin/login.html';
      return;
    }
    CSRF_TOKEN = data.csrfToken;
    $('#whoami').textContent = `logged in as ${data.username}`;
    initDashboard();
  } catch (e) {
    window.location.href = '/admin/login.html';
  }
})();

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login.html';
});

// ============ API helper (otomatis sertakan CSRF token) ============
async function api(path, options = {}) {
  const headers = options.headers || {};
  if (options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = CSRF_TOKEN;
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showMsg(el, text, ok = true) {
  el.textContent = text;
  el.className = `text-sm font-mono ${ok ? 'text-emerald-400' : 'text-red-400'}`;
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ============ Tabs ============
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });
}

// ============ Settings ============
async function loadSettingsTab() {
  const s = await api('/api/settings');
  $('#s-siteName').value = s.siteName || '';
  $('#s-developerName').value = s.developerName || '';
  $('#s-tagline').value = s.tagline || '';
  $('#s-bio').value = s.bio || '';
  $('#s-email').value = s.email || '';
  $('#s-github').value = s.github || '';
  $('#s-instagram').value = s.instagram || '';
  if (s.developerPhoto) $('#s-photo-preview').src = s.developerPhoto;
}

$('#s-photo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) $('#s-photo-preview').src = await fileToBase64(file);
});

$('#save-settings').addEventListener('click', async () => {
  const msg = $('#settings-msg');
  msg.classList.remove('hidden');
  try {
    const payload = {
      siteName: $('#s-siteName').value.trim(),
      developerName: $('#s-developerName').value.trim(),
      tagline: $('#s-tagline').value.trim(),
      bio: $('#s-bio').value.trim(),
      email: $('#s-email').value.trim(),
      github: $('#s-github').value.trim(),
      instagram: $('#s-instagram').value.trim(),
    };
    const file = $('#s-photo-file').files[0];
    if (file) payload.developerPhotoBase64 = await fileToBase64(file);
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    showMsg(msg, '✓ Pengaturan berhasil disimpan.', true);
  } catch (e) {
    showMsg(msg, '✗ ' + e.message, false);
  }
});

// ============ Blogs ============
async function loadBlogsList() {
  const blogs = await api('/api/blogs');
  const list = $('#blogs-list');
  if (!blogs.length) {
    list.innerHTML = '<p class="text-slate-500 text-sm font-mono">// belum ada blog.</p>';
    return;
  }
  list.innerHTML = blogs.map((b) => `
    <div class="card p-4 flex items-center gap-4">
      ${b.image ? `<img src="${b.image}" class="w-16 h-16 rounded-lg object-cover" />` : '<div class="w-16 h-16 rounded-lg bg-white/5 flex items-center justify-center text-xs text-slate-500">no img</div>'}
      <div class="flex-1 min-w-0">
        <p class="text-white font-medium truncate">${b.title}</p>
        <p class="text-xs text-slate-500 font-mono">${new Date(b.createdAt).toLocaleDateString('id-ID')}</p>
      </div>
      <button data-id="${b.id}" class="del-blog text-xs px-3 py-1.5 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 transition">Hapus</button>
    </div>
  `).join('');
  document.querySelectorAll('.del-blog').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus blog ini?')) return;
      await api(`/api/admin/blogs/${btn.dataset.id}`, { method: 'DELETE' });
      loadBlogsList();
    });
  });
}

$('#add-blog').addEventListener('click', async () => {
  const msg = $('#blog-msg');
  msg.classList.remove('hidden');
  try {
    const payload = {
      title: $('#b-title').value.trim(),
      excerpt: $('#b-excerpt').value.trim(),
      content: $('#b-content').value.trim(),
    };
    if (!payload.title || !payload.content) throw new Error('Judul dan konten wajib diisi.');
    const file = $('#b-image').files[0];
    if (file) payload.imageBase64 = await fileToBase64(file);
    await api('/api/admin/blogs', { method: 'POST', body: JSON.stringify(payload) });
    showMsg(msg, '✓ Blog berhasil dipublikasikan.', true);
    $('#b-title').value = ''; $('#b-excerpt').value = ''; $('#b-content').value = ''; $('#b-image').value = '';
    loadBlogsList();
  } catch (e) {
    showMsg(msg, '✗ ' + e.message, false);
  }
});

// ============ Projects ============
async function loadProjectsList() {
  const projects = await api('/api/projects');
  const list = $('#projects-list');
  if (!projects.length) {
    list.innerHTML = '<p class="text-slate-500 text-sm font-mono">// belum ada proyek.</p>';
    return;
  }
  list.innerHTML = projects.map((p) => `
    <div class="card p-4 flex items-center gap-4">
      ${p.image ? `<img src="${p.image}" class="w-16 h-16 rounded-lg object-cover" />` : '<div class="w-16 h-16 rounded-lg bg-white/5 flex items-center justify-center text-xs text-slate-500">no img</div>'}
      <div class="flex-1 min-w-0">
        <p class="text-white font-medium truncate">${p.title}</p>
        <p class="text-xs text-slate-500 font-mono">${p.category || '-'} ${p.year ? '· ' + p.year : ''}</p>
      </div>
      <button data-id="${p.id}" class="del-project text-xs px-3 py-1.5 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 transition">Hapus</button>
    </div>
  `).join('');
  document.querySelectorAll('.del-project').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus proyek ini?')) return;
      await api(`/api/admin/projects/${btn.dataset.id}`, { method: 'DELETE' });
      loadProjectsList();
    });
  });
}

$('#add-project').addEventListener('click', async () => {
  const msg = $('#project-msg');
  msg.classList.remove('hidden');
  try {
    const payload = {
      title: $('#p-title').value.trim(),
      category: $('#p-category').value.trim(),
      description: $('#p-description').value.trim(),
      link: $('#p-link').value.trim(),
      year: $('#p-year').value.trim(),
    };
    if (!payload.title || !payload.description) throw new Error('Judul dan deskripsi wajib diisi.');
    const file = $('#p-image').files[0];
    if (file) payload.imageBase64 = await fileToBase64(file);
    await api('/api/admin/projects', { method: 'POST', body: JSON.stringify(payload) });
    showMsg(msg, '✓ Proyek berhasil ditambahkan.', true);
    ['#p-title','#p-category','#p-description','#p-link','#p-year','#p-image'].forEach((s) => $(s).value = '');
    loadProjectsList();
  } catch (e) {
    showMsg(msg, '✗ ' + e.message, false);
  }
});

// ============ Certificates (localStorage) ============
function getCertificates() {
  try { return JSON.parse(localStorage.getItem(CERT_KEY)) || []; } catch (e) { return []; }
}
function saveCertificates(certs) {
  localStorage.setItem(CERT_KEY, JSON.stringify(certs));
}
function renderCertsList() {
  const certs = getCertificates();
  const list = $('#certs-list');
  if (!certs.length) {
    list.innerHTML = '<p class="text-slate-500 text-sm font-mono col-span-full">// belum ada sertifikat.</p>';
    return;
  }
  list.innerHTML = certs.map((c) => `
    <div class="card p-4">
      ${c.image ? `<img src="${c.image}" class="w-full h-32 object-cover rounded-lg mb-3" />` : ''}
      <p class="text-white font-medium">${c.title}</p>
      <p class="text-xs text-slate-500 font-mono mb-3">${c.issuer || '-'} ${c.year ? '· ' + c.year : ''}</p>
      <button data-id="${c.id}" class="del-cert text-xs px-3 py-1.5 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 transition">Hapus</button>
    </div>
  `).join('');
  document.querySelectorAll('.del-cert').forEach((btn) => {
    btn.addEventListener('click', () => {
      const certs = getCertificates().filter((c) => c.id !== btn.dataset.id);
      saveCertificates(certs);
      renderCertsList();
    });
  });
}

$('#add-cert').addEventListener('click', async () => {
  const title = $('#c-title').value.trim();
  const issuer = $('#c-issuer').value.trim();
  const year = $('#c-year').value.trim();
  if (!title) { alert('Judul sertifikat wajib diisi.'); return; }
  let image = '';
  const file = $('#c-image').files[0];
  if (file) image = await fileToBase64(file);
  const certs = getCertificates();
  certs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title, issuer, year, image });
  saveCertificates(certs);
  $('#c-title').value = ''; $('#c-issuer').value = ''; $('#c-year').value = ''; $('#c-image').value = '';
  renderCertsList();
});

// ============ Change password ============
$('#change-password').addEventListener('click', async () => {
  const msg = $('#password-msg');
  msg.classList.remove('hidden');
  const current = $('#cp-current').value;
  const next = $('#cp-new').value;
  const confirm2 = $('#cp-confirm').value;
  if (next !== confirm2) { showMsg(msg, '✗ Konfirmasi password tidak cocok.', false); return; }
  try {
    const data = await api('/api/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    showMsg(msg, '✓ ' + data.message, true);
    $('#cp-current').value = ''; $('#cp-new').value = ''; $('#cp-confirm').value = '';
  } catch (e) {
    showMsg(msg, '✗ ' + e.message, false);
  }
});

// ============ Init ============
function initDashboard() {
  initTabs();
  loadSettingsTab();
  loadBlogsList();
  loadProjectsList();
  renderCertsList();
}
