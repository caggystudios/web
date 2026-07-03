/**
 * CaggyID Dev - API untuk Vercel (Node.js Serverless Function)
 *
 * Ini adalah port dari server.js supaya jalan di Vercel:
 * - Static file (public/) di-serve otomatis oleh Vercel, TIDAK lewat file ini.
 * - Semua request ke /api/* masuk ke sini (catch-all route [...path].js).
 * - Data JSON (blogs/projects/settings/admin) & session disimpan di Upstash Redis
 *   (bukan file data/*.json, karena filesystem Vercel read-only & tidak persisten).
 * - Upload gambar disimpan ke Vercel Blob (bukan public/uploads).
 *
 * Logika keamanan (hash password scrypt, CSRF token, rate limit login, sanitasi
 * HTML dasar, security headers) dipertahankan sama seperti server.js asli.
 */
const crypto = require('crypto');
const {
  readData,
  writeData,
  createSession,
  getSession,
  deleteSession,
  isLockedOut,
  registerFailedAttempt,
  registerSuccessfulAttempt,
} = require('../lib/redis');
const { saveBase64Image } = require('../lib/blob');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // hanya dipakai utk cookie Max-Age

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

// ---------- Util: password hashing (scrypt, built-in Node) ----------
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
function setSessionCookie(res, token, req) {
  const isHTTPS = req.headers['x-forwarded-proto'] === 'https';
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

// ---------- Util: response helpers ----------
function sendJSON(res, status, obj) {
  res.status(status).json(obj);
}
function securityHeaders(res, req) {
  const isHTTPS = req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; " +
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self';"
  );
  if (isHTTPS) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

// ---------- Auth middleware ----------
async function requireAuth(req, res) {
  const session = await getSession(req.cookies.caggyid_session);
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
function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

// ---------- Ambil body JSON dengan aman ----------
function getBody(req) {
  try {
    return req.body && typeof req.body === 'object' ? req.body : {};
  } catch (e) {
    return null; // JSON malformed
  }
}

// ---------- Route handlers ----------
async function handleAPI(req, res, pathname, method) {
  // ===== PUBLIC: settings =====
  if (pathname === '/api/settings' && method === 'GET') {
    const settings = await readData('settings', {});
    return sendJSON(res, 200, settings);
  }

  // ===== PUBLIC: blogs =====
  if (pathname === '/api/blogs' && method === 'GET') {
    const blogs = await readData('blogs', []);
    return sendJSON(res, 200, blogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }
  if (pathname.match(/^\/api\/blogs\/[\w-]+$/) && method === 'GET') {
    const id = pathname.split('/').pop();
    const blogs = await readData('blogs', []);
    const blog = blogs.find((b) => b.id === id);
    if (!blog) return sendJSON(res, 404, { error: 'Blog tidak ditemukan.' });
    return sendJSON(res, 200, blog);
  }

  // ===== PUBLIC: projects =====
  if (pathname === '/api/projects' && method === 'GET') {
    const projects = await readData('projects', []);
    return sendJSON(res, 200, projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }

  // ===== AUTH: login =====
  if (pathname === '/api/admin/login' && method === 'POST') {
    const ip = getClientIP(req);
    if (await isLockedOut(ip)) {
      return sendJSON(res, 429, { error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.' });
    }
    const body = getBody(req);
    if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
    const { username, password } = body;
    const admin = await readData('admin', null);
    if (!admin || typeof username !== 'string' || typeof password !== 'string') {
      await registerFailedAttempt(ip);
      return sendJSON(res, 401, { error: 'Username atau password salah.' });
    }
    if (username !== admin.username || !verifyPassword(password, admin.salt, admin.hash)) {
      await registerFailedAttempt(ip);
      return sendJSON(res, 401, { error: 'Username atau password salah.' });
    }
    await registerSuccessfulAttempt(ip);
    const { token, csrf } = await createSession(admin.username);
    setSessionCookie(res, token, req);
    return sendJSON(res, 200, { ok: true, csrfToken: csrf, username: admin.username });
  }

  // ===== AUTH: logout =====
  if (pathname === '/api/admin/logout' && method === 'POST') {
    await deleteSession(req.cookies.caggyid_session);
    clearSessionCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  // ===== AUTH: check session =====
  if (pathname === '/api/admin/check' && method === 'GET') {
    const session = await getSession(req.cookies.caggyid_session);
    if (!session) return sendJSON(res, 401, { authenticated: false });
    return sendJSON(res, 200, { authenticated: true, csrfToken: session.csrf, username: session.username });
  }

  // ---- Semua route di bawah ini WAJIB login + CSRF ----
  if (pathname.startsWith('/api/admin/')) {
    const session = await requireAuth(req, res);
    if (!session) return;
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      if (!requireCSRF(req, res, session)) return;
    }

    // ---- ganti password ----
    if (pathname === '/api/admin/change-password' && method === 'POST') {
      const body = getBody(req);
      if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
      const { currentPassword, newPassword } = body;
      const admin = await readData('admin', null);
      if (!admin || !verifyPassword(currentPassword || '', admin.salt, admin.hash)) {
        return sendJSON(res, 401, { error: 'Password saat ini salah.' });
      }
      if (!newPassword || newPassword.length < 8) {
        return sendJSON(res, 400, { error: 'Password baru minimal 8 karakter.' });
      }
      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = hashPassword(newPassword, newSalt);
      await writeData('admin', { username: admin.username, salt: newSalt, hash: newHash });
      return sendJSON(res, 200, { ok: true, message: 'Password berhasil diganti.' });
    }

    // ---- settings ----
    if (pathname === '/api/admin/settings' && method === 'PUT') {
      const body = getBody(req);
      if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
      const current = await readData('settings', {});
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
          updated.developerPhoto = await saveBase64Image(body.developerPhotoBase64, 'avatar');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      await writeData('settings', updated);
      return sendJSON(res, 200, updated);
    }

    // ---- blogs: create ----
    if (pathname === '/api/admin/blogs' && method === 'POST') {
      const body = getBody(req);
      if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
      if (!body.title || !body.content) {
        return sendJSON(res, 400, { error: 'Judul dan konten wajib diisi.' });
      }
      let imagePath = '';
      if (body.imageBase64) {
        try {
          imagePath = await saveBase64Image(body.imageBase64, 'blog');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      const blogs = await readData('blogs', []);
      const newBlog = {
        id: crypto.randomBytes(8).toString('hex'),
        title: escapeHTML(body.title).slice(0, 200),
        excerpt: escapeHTML(body.excerpt || '').slice(0, 300),
        content: sanitizeHTML(body.content).slice(0, 50000),
        image: imagePath,
        createdAt: new Date().toISOString(),
      };
      blogs.push(newBlog);
      await writeData('blogs', blogs);
      return sendJSON(res, 201, newBlog);
    }

    // ---- blogs: update / delete ----
    if (pathname.match(/^\/api\/admin\/blogs\/[\w-]+$/) && (method === 'PUT' || method === 'DELETE')) {
      const id = pathname.split('/').pop();
      let blogs = await readData('blogs', []);
      const idx = blogs.findIndex((b) => b.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Blog tidak ditemukan.' });

      if (method === 'DELETE') {
        blogs.splice(idx, 1);
        await writeData('blogs', blogs);
        return sendJSON(res, 200, { ok: true });
      }

      const body = getBody(req);
      if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
      const blog = blogs[idx];
      if (body.title) blog.title = escapeHTML(body.title).slice(0, 200);
      if (body.excerpt !== undefined) blog.excerpt = escapeHTML(body.excerpt).slice(0, 300);
      if (body.content) blog.content = sanitizeHTML(body.content).slice(0, 50000);
      if (body.imageBase64) {
        try {
          blog.image = await saveBase64Image(body.imageBase64, 'blog');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      blog.updatedAt = new Date().toISOString();
      blogs[idx] = blog;
      await writeData('blogs', blogs);
      return sendJSON(res, 200, blog);
    }

    // ---- projects: create ----
    if (pathname === '/api/admin/projects' && method === 'POST') {
      const body = getBody(req);
      if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
      if (!body.title || !body.description) {
        return sendJSON(res, 400, { error: 'Judul dan deskripsi wajib diisi.' });
      }
      let imagePath = '';
      if (body.imageBase64) {
        try {
          imagePath = await saveBase64Image(body.imageBase64, 'project');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      const projects = await readData('projects', []);
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
      await writeData('projects', projects);
      return sendJSON(res, 201, newProject);
    }

    // ---- projects: update / delete ----
    if (pathname.match(/^\/api\/admin\/projects\/[\w-]+$/) && (method === 'PUT' || method === 'DELETE')) {
      const id = pathname.split('/').pop();
      let projects = await readData('projects', []);
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Proyek tidak ditemukan.' });

      if (method === 'DELETE') {
        projects.splice(idx, 1);
        await writeData('projects', projects);
        return sendJSON(res, 200, { ok: true });
      }

      const body = getBody(req);
      if (body === null) return sendJSON(res, 400, { error: 'Request tidak valid.' });
      const project = projects[idx];
      if (body.title) project.title = escapeHTML(body.title).slice(0, 150);
      if (body.category !== undefined) project.category = escapeHTML(body.category).slice(0, 80);
      if (body.description) project.description = escapeHTML(body.description).slice(0, 1000);
      if (body.link !== undefined) project.link = escapeHTML(body.link).slice(0, 500);
      if (body.year !== undefined) project.year = escapeHTML(body.year).slice(0, 20);
      if (body.imageBase64) {
        try {
          project.image = await saveBase64Image(body.imageBase64, 'project');
        } catch (e) {
          return sendJSON(res, 400, { error: e.message });
        }
      }
      projects[idx] = project;
      await writeData('projects', projects);
      return sendJSON(res, 200, project);
    }

    return sendJSON(res, 404, { error: 'Endpoint tidak ditemukan.' });
  }

  return sendJSON(res, 404, { error: 'Endpoint tidak ditemukan.' });
}

// ---------- Entry point Vercel ----------
module.exports = async (req, res) => {
  try {
    securityHeaders(res, req);

    const rawUrl = req.url || '/';
    const pathname = rawUrl.split('?')[0];

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }

    await handleAPI(req, res, pathname, req.method);
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Terjadi kesalahan pada server.' });
  }
};
