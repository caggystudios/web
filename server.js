/**
 * CaggyID Dev - Backend Server
 * Vanilla Node.js (tanpa dependency eksternal) supaya bisa langsung dijalankan
 * dengan `node server.js` di hosting/VPS mana pun yang punya Node >= 18.
 *
 * Fitur keamanan admin panel:
 * - Password admin di-hash dengan scrypt + salt (tidak pernah disimpan plaintext)
 * - Session token acak 256-bit, disimpan di server (bukan JWT stateless supaya bisa di-revoke)
 * - Cookie session: HttpOnly, SameSite=Strict, (Secure otomatis aktif jika HTTPS terdeteksi)
 * - CSRF token wajib untuk semua request POST/PUT/DELETE ke /api/admin/*
 * - Rate limiting + auto-lockout percobaan login yang gagal (brute-force protection)
 * - Validasi & pembatasan ukuran upload gambar, nama file di-random-kan
 * - Folder /data (kredensial, database json) TIDAK di-serve sebagai static file
 * - Security headers (CSP, X-Frame-Options, X-Content-Type-Options, dll)
 * - Sanitasi dasar terhadap konten blog untuk mencegah stored XSS
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const BLOGS_FILE = path.join(DATA_DIR, 'blogs.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const MAX_BODY_SIZE = 8 * 1024 * 1024; // 8MB, cukup untuk gambar base64 blog/foto
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 jam
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 menit

// ---------- Util: JSON file read/write ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- Util: sanitasi dasar (cegah stored XSS pada konten blog) ----------
function sanitizeHTML(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/ on\w+\s*=\s*"(.*?)"/gi, '')
    .replace(/ on\w+\s*=\s*'(.*?)'/gi, '')
    .replace(/javascript:/gi, '');
}
function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- In-memory: sessions & login attempts ----------
const sessions = new Map(); // token -> { username, expires, csrf }
const loginAttempts = new Map(); // ip -> { count, lockUntil }

function cleanupSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expires < now) sessions.delete(token);
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000).unref();

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS, csrf });
  return { token, csrf };
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  s.expires = Date.now() + SESSION_TTL_MS; // sliding expiry
  return s;
}

// ---------- Util: password hashing (scrypt, built-in Node, tanpa bcrypt) ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, expectedHash) {
  const actual = hashPassword(password, salt);
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- Util: cookies ----------
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token, req) {
  const isHTTPS = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const parts = [
    `caggyid_session=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHTTPS) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'caggyid_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
}

// ---------- Util: body parsing ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error('INVALID_JSON');
  }
}

// ---------- Util: response helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function securityHeaders(res, req) {
  const isHTTPS = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; " +
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self';"
  );
  if (isHTTPS) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

// ---------- Auth middleware ----------
function requireAuth(req, res) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.caggyid_session);
  if (!session) {
    sendJSON(res, 401, { error: 'Unauthorized. Silakan login kembali.' });
    return null;
  }
  return session;
}

function requireCSRF(req, res, session) {
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken || headerToken !== session.csrf) {
    sendJSON(res, 403, { error: 'CSRF token tidak valid.' });
    return false;
  }
  return true;
}

// ---------- Rate limiting login ----------
function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function isLockedOut(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (rec.lockUntil && rec.lockUntil > Date.now()) return true;
  if (rec.lockUntil && rec.lockUntil <= Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}
function registerFailedAttempt(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts.set(ip, rec);
}
function registerSuccessfulAttempt(ip) {
  loginAttempts.delete(ip);
}

// ---------- Static file serving (aman dari path traversal) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\.+/g, ''); // buang percobaan path traversal
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJSON(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // fallback SPA-ish untuk /admin -> admin/index.html jika folder diakses tanpa file
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- Upload gambar (base64 dataURL -> file) ----------
function saveBase64Image(dataUrl, prefix) {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) {
    throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG, WEBP, atau GIF.');
  }
  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  const buffer = Buffer.from(match[2], 'base64');

  const MAX_IMAGE_SIZE = 6 * 1024 * 1024; // 6MB
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error('Ukuran gambar maksimal 6MB.');
  }

  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return `/uploads/${filename}`;
}

// ---------- Route handlers ----------
async function handleAPI(req, res, pathname, method) {
  // ===== PUBLIC: settings =====
  if (pathname === '/api/settings' && method === 'GET') {
    const settings = readJSON(SETTINGS_FILE, {});
    return sendJSON(res, 200, settings);
  }

  // ===== PUBLIC: blogs =====
  if (pathname === '/api/blogs' && method === 'GET') {
    const blogs = readJSON(BLOGS_FILE, []);
    return sendJSON(res, 200, blogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }
  if (pathname.match(/^\/api\/blogs\/[\w-]+$/) && method === 'GET') {
    const id = pathname.split('/').pop();
    const blogs = readJSON(BLOGS_FILE, []);
    const blog = blogs.find((b) => b.id === id);
    if (!blog) return sendJSON(res, 404, { error: 'Blog tidak ditemukan.' });
    return sendJSON(res, 200, blog);
  }

  // ===== PUBLIC: projects =====
  if (pathname === '/api/projects' && method === 'GET') {
    const projects = readJSON(PROJECTS_FILE, []);
    return sendJSON(res, 200, projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }

  // ===== AUTH: login =====
  if (pathname === '/api/admin/login' && method === 'POST') {
    const ip = getClientIP(req);
    if (isLockedOut(ip)) {
      return sendJSON(res, 429, {
        error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.',
      });
    }
    let body;
    try {
      body = await readJSONBody(req);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Request tidak valid.' });
    }
    const { username, password } = body;
    const admin = readJSON(ADMIN_FILE, null);
    if (!admin || typeof username !== 'string' || typeof password !== 'string') {
      registerFailedAttempt(ip);
      return sendJSON(res, 401, { error: 'Username atau password salah.' });
    }
    if (username !== admin.username || !verifyPassword(password, admin.salt, admin.hash)) {
      registerFailedAttempt(ip);
      return sendJSON(res, 401, { error: 'Username atau password salah.' });
    }
    registerSuccessfulAttempt(ip);
    const { token, csrf } = createSession(admin.username);
    setSessionCookie(res, token, req);
    return sendJSON(res, 200, { ok: true, csrfToken: csrf, username: admin.username });
  }

  // ===== AUTH: logout =====
  if (pathname === '/api/admin/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    if (cookies.caggyid_session) sessions.delete(cookies.caggyid_session);
    clearSessionCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  // ===== AUTH: check session =====
  if (pathname === '/api/admin/check' && method === 'GET') {
    const cookies = parseCookies(req);
    const session = getSession(cookies.caggyid_session);
    if (!session) return sendJSON(res, 401, { authenticated: false });
    return sendJSON(res, 200, { authenticated: true, csrfToken: session.csrf, username: session.username });
  }

  // ---- Semua route di bawah ini WAJIB login + CSRF ----
  if (pathname.startsWith('/api/admin/')) {
    const session = requireAuth(req, res);
    if (!session) return;
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      if (!requireCSRF(req, res, session)) return;
    }

    // ---- ganti password ----
    if (pathname === '/api/admin/change-password' && method === 'POST') {
      let body;
      try {
        body = await readJSONBody(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'Request tidak valid.' });
      }
      const { currentPassword, newPassword } = body;
      const admin = readJSON(ADMIN_FILE, null);
      if (!admin || !verifyPassword(currentPassword || '', admin.salt, admin.hash)) {
        return sendJSON(res, 401, { error: 'Password saat ini salah.' });
      }
      if (!newPassword || newPassword.length < 8) {
        return sendJSON(res, 400, { error: 'Password baru minimal 8 karakter.' });
      }
      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = hashPassword(newPassword, newSalt);
      writeJSON(ADMIN_FILE, { username: admin.username, salt: newSalt, hash: newHash });
      return sendJSON(res, 200, { ok: true, message: 'Password berhasil diganti.' });
    }

    // ---- settings ----
    if (pathname === '/api/admin/settings' && method === 'PUT') {
      let body;
      try {
        body = await readJSONBody(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'Request tidak valid.' });
      }
      const current = readJSON(SETTINGS_FILE, {});
      const updated = {
        ...current,
        siteName: escapeHTML(body.siteName || current.siteName),
        developerName: escapeHTML(body.developerName || current.developerName),
        tagline: escapeHTML(body.tagline || current.tagline),
        bio: sanitizeHTML(body.bio ?? current.bio),
        email: escapeHTML(body.email || current.email || ''),
        github: escapeHTML(body.github || current.github || ''),
        instagram: escapeHTML(body.instagram || current.instagram || ''),
      };
      if (body.developerPhotoBase64) {
        try {
          updated.developerPhoto = saveBase64Image(body.developerPhotoBase64, 'avatar');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      writeJSON(SETTINGS_FILE, updated);
      return sendJSON(res, 200, updated);
    }

    // ---- blogs: create ----
    if (pathname === '/api/admin/blogs' && method === 'POST') {
      let body;
      try {
        body = await readJSONBody(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'Request tidak valid.' });
      }
      if (!body.title || !body.content) {
        return sendJSON(res, 400, { error: 'Judul dan konten wajib diisi.' });
      }
      let imagePath = '';
      if (body.imageBase64) {
        try {
          imagePath = saveBase64Image(body.imageBase64, 'blog');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      const blogs = readJSON(BLOGS_FILE, []);
      const newBlog = {
        id: crypto.randomBytes(8).toString('hex'),
        title: escapeHTML(body.title).slice(0, 200),
        excerpt: escapeHTML(body.excerpt || '').slice(0, 300),
        content: sanitizeHTML(body.content).slice(0, 50000),
        image: imagePath,
        createdAt: new Date().toISOString(),
      };
      blogs.push(newBlog);
      writeJSON(BLOGS_FILE, blogs);
      return sendJSON(res, 201, newBlog);
    }

    // ---- blogs: update / delete ----
    if (pathname.match(/^\/api\/admin\/blogs\/[\w-]+$/) && (method === 'PUT' || method === 'DELETE')) {
      const id = pathname.split('/').pop();
      let blogs = readJSON(BLOGS_FILE, []);
      const idx = blogs.findIndex((b) => b.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Blog tidak ditemukan.' });

      if (method === 'DELETE') {
        blogs.splice(idx, 1);
        writeJSON(BLOGS_FILE, blogs);
        return sendJSON(res, 200, { ok: true });
      }

      let body;
      try {
        body = await readJSONBody(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'Request tidak valid.' });
      }
      const blog = blogs[idx];
      if (body.title) blog.title = escapeHTML(body.title).slice(0, 200);
      if (body.excerpt !== undefined) blog.excerpt = escapeHTML(body.excerpt).slice(0, 300);
      if (body.content) blog.content = sanitizeHTML(body.content).slice(0, 50000);
      if (body.imageBase64) {
        try {
          blog.image = saveBase64Image(body.imageBase64, 'blog');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      blog.updatedAt = new Date().toISOString();
      blogs[idx] = blog;
      writeJSON(BLOGS_FILE, blogs);
      return sendJSON(res, 200, blog);
    }

    // ---- projects: create ----
    if (pathname === '/api/admin/projects' && method === 'POST') {
      let body;
      try {
        body = await readJSONBody(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'Request tidak valid.' });
      }
      if (!body.title || !body.description) {
        return sendJSON(res, 400, { error: 'Judul dan deskripsi wajib diisi.' });
      }
      let imagePath = '';
      if (body.imageBase64) {
        try {
          imagePath = saveBase64Image(body.imageBase64, 'project');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      const projects = readJSON(PROJECTS_FILE, []);
      const newProject = {
        id: crypto.randomBytes(8).toString('hex'),
        title: escapeHTML(body.title).slice(0, 150),
        category: escapeHTML(body.category || '').slice(0, 80),
        description: escapeHTML(body.description).slice(0, 1000),
        link: escapeHTML(body.link || '').slice(0, 500),
        image: imagePath,
        year: escapeHTML(body.year || '').slice(0, 20),
        createdAt: new Date().toISOString(),
      };
      projects.push(newProject);
      writeJSON(PROJECTS_FILE, projects);
      return sendJSON(res, 201, newProject);
    }

    // ---- projects: update / delete ----
    if (pathname.match(/^\/api\/admin\/projects\/[\w-]+$/) && (method === 'PUT' || method === 'DELETE')) {
      const id = pathname.split('/').pop();
      let projects = readJSON(PROJECTS_FILE, []);
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Proyek tidak ditemukan.' });

      if (method === 'DELETE') {
        projects.splice(idx, 1);
        writeJSON(PROJECTS_FILE, projects);
        return sendJSON(res, 200, { ok: true });
      }

      let body;
      try {
        body = await readJSONBody(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'Request tidak valid.' });
      }
      const project = projects[idx];
      if (body.title) project.title = escapeHTML(body.title).slice(0, 150);
      if (body.category !== undefined) project.category = escapeHTML(body.category).slice(0, 80);
      if (body.description) project.description = escapeHTML(body.description).slice(0, 1000);
      if (body.link !== undefined) project.link = escapeHTML(body.link).slice(0, 500);
      if (body.year !== undefined) project.year = escapeHTML(body.year).slice(0, 20);
      if (body.imageBase64) {
        try {
          project.image = saveBase64Image(body.imageBase64, 'project');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      projects[idx] = project;
      writeJSON(PROJECTS_FILE, projects);
      return sendJSON(res, 200, project);
    }

    return sendJSON(res, 404, { error: 'Endpoint tidak ditemukan.' });
  }

  return sendJSON(res, 404, { error: 'Endpoint tidak ditemukan.' });
}

// ---------- Server utama ----------
const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(res, req);
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(parsed.pathname);

    if (pathname.startsWith('/api/')) {
      await handleAPI(req, res, pathname, req.method);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJSON(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error(err);
    if (err.message === 'PAYLOAD_TOO_LARGE') {
      return sendJSON(res, 413, { error: 'Ukuran data terlalu besar.' });
    }
    sendJSON(res, 500, { error: 'Terjadi kesalahan pada server.' });
  }
});

server.listen(PORT, () => {
  console.log(`CaggyID Dev server berjalan di http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin/login.html`);
});
