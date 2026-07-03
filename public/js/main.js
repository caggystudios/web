// ============ Util ============
const $ = (sel) => document.querySelector(sel);
const CERT_KEY = 'caggyid_certificates';

document.getElementById('year').textContent = new Date().getFullYear();

function escapeHTML(str = '') {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ============ Settings ============
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    if (s.developerName) {
      $('#dev-name').innerHTML = escapeHTML(s.developerName).replace(/ /g, '<br class="hidden md:block"/> ').trim();
      $('#dev-name').textContent = s.developerName; // fallback simpler render
      $('#dev-name').innerText = s.developerName;
    }
    if (s.tagline) $('#dev-tagline').textContent = s.tagline;
    if (s.bio) $('#dev-bio').textContent = s.bio;
    if (s.developerPhoto) $('#dev-photo').src = s.developerPhoto;
    if (s.siteName) document.title = s.siteName;

    const links = [];
    if (s.email) links.push(`<a href="mailto:${escapeHTML(s.email)}" class="hover:text-violet-300 transition">✉ ${escapeHTML(s.email)}</a>`);
    if (s.github) links.push(`<a href="${escapeHTML(s.github)}" target="_blank" rel="noopener" class="hover:text-violet-300 transition">github ↗</a>`);
    if (s.instagram) links.push(`<a href="${escapeHTML(s.instagram)}" target="_blank" rel="noopener" class="hover:text-violet-300 transition">instagram ↗</a>`);
    $('#contact-links').innerHTML = links.length ? links.join('') : '<p class="text-slate-600">Belum ada kontak ditambahkan lewat admin panel.</p>';
  } catch (e) {
    console.error('Gagal memuat settings', e);
  }
}

// ============ Projects ============
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    const grid = $('#projects-grid');
    if (!projects.length) {
      grid.innerHTML = '<p class="text-slate-500 font-mono text-sm">// belum ada proyek ditambahkan.</p>';
      return;
    }
    grid.innerHTML = projects.map((p) => `
      <div class="card overflow-hidden flex flex-col">
        ${p.image ? `<img src="${escapeHTML(p.image)}" alt="${escapeHTML(p.title)}" class="w-full h-40 object-cover" />` : `<div class="w-full h-40 bg-gradient-to-br from-violet-900/40 to-indigo-900/40 flex items-center justify-center font-mono text-violet-400 text-xs">no preview</div>`}
        <div class="p-5 flex flex-col flex-1">
          <div class="flex items-center gap-2 mb-2">
            ${p.category ? `<span class="badge">${escapeHTML(p.category)}</span>` : ''}
            ${p.year ? `<span class="text-xs text-slate-500 font-mono">${escapeHTML(p.year)}</span>` : ''}
          </div>
          <h4 class="font-display font-semibold text-white text-lg mb-2">${escapeHTML(p.title)}</h4>
          <p class="text-sm text-slate-400 leading-relaxed flex-1">${escapeHTML(p.description)}</p>
          ${p.link ? `<a href="${escapeHTML(p.link)}" target="_blank" rel="noopener" class="mt-4 inline-flex items-center gap-1 text-sm text-violet-300 hover:text-violet-200 font-medium">Lihat proyek <span>↗</span></a>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Gagal memuat proyek', e);
  }
}

// ============ Blog ============
let blogCache = [];
async function loadBlogs() {
  try {
    const res = await fetch('/api/blogs');
    blogCache = await res.json();
    const grid = $('#blog-grid');
    const empty = $('#blog-empty');
    if (!blogCache.length) {
      grid.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    grid.classList.remove('hidden');
    empty.classList.add('hidden');
    grid.innerHTML = blogCache.map((b) => `
      <button data-id="${b.id}" class="blog-card card text-left overflow-hidden flex flex-col">
        ${b.image ? `<img src="${escapeHTML(b.image)}" alt="${escapeHTML(b.title)}" class="w-full h-40 object-cover" />` : `<div class="w-full h-40 bg-gradient-to-br from-violet-900/40 to-indigo-900/40 flex items-center justify-center font-mono text-violet-400 text-xs">no image</div>`}
        <div class="p-5 flex flex-col flex-1">
          <p class="text-xs font-mono text-slate-500 mb-2">${timeAgo(b.createdAt)}</p>
          <h4 class="font-display font-semibold text-white text-lg mb-2">${escapeHTML(b.title)}</h4>
          <p class="text-sm text-slate-400 leading-relaxed flex-1">${escapeHTML(b.excerpt || (b.content || '').slice(0, 100))}</p>
          <span class="mt-4 text-sm text-violet-300 font-medium">Baca selengkapnya →</span>
        </div>
      </button>
    `).join('');

    document.querySelectorAll('.blog-card').forEach((btn) => {
      btn.addEventListener('click', () => openBlog(btn.dataset.id));
    });
  } catch (e) {
    console.error('Gagal memuat blog', e);
  }
}

function openBlog(id) {
  const blog = blogCache.find((b) => b.id === id);
  if (!blog) return;
  $('#modal-title').textContent = blog.title;
  $('#modal-date').textContent = timeAgo(blog.createdAt);
  // Konten blog sudah disanitasi di server; render sebagai HTML terbatas.
  $('#modal-content').innerHTML = blog.content;
  const img = $('#modal-img');
  if (blog.image) {
    img.src = blog.image;
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
  }
  $('#blog-modal').classList.remove('hidden');
}
$('#modal-close').addEventListener('click', () => $('#blog-modal').classList.add('hidden'));
$('#blog-modal').addEventListener('click', (e) => {
  if (e.target.id === 'blog-modal') $('#blog-modal').classList.add('hidden');
});

// ============ Certificates (localStorage) ============
function getCertificates() {
  try {
    return JSON.parse(localStorage.getItem(CERT_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function renderCertificates() {
  const certs = getCertificates();
  const grid = $('#cert-grid');
  const empty = $('#cert-empty');
  if (!certs.length) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  grid.classList.remove('hidden');
  empty.classList.add('hidden');
  grid.innerHTML = certs.map((c) => `
    <div class="card overflow-hidden flex flex-col">
      ${c.image ? `<img src="${c.image}" alt="${escapeHTML(c.title)}" class="w-full h-40 object-cover" />` : `<div class="w-full h-40 bg-gradient-to-br from-violet-900/40 to-indigo-900/40 flex items-center justify-center font-mono text-violet-400 text-xs">🏆</div>`}
      <div class="p-5">
        <h4 class="font-display font-semibold text-white text-base mb-1">${escapeHTML(c.title)}</h4>
        <p class="text-xs text-slate-500 font-mono">${escapeHTML(c.issuer || '')} ${c.year ? '· ' + escapeHTML(c.year) : ''}</p>
      </div>
    </div>
  `).join('');
}

// ============ Init ============
loadSettings();
loadProjects();
loadBlogs();
renderCertificates();

// Refresh sertifikat otomatis bila diubah dari tab admin lain
window.addEventListener('storage', (e) => {
  if (e.key === CERT_KEY) renderCertificates();
});
