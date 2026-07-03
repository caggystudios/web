# CaggyID Dev — Website Blog & Portfolio

Website untuk **Mohammad Luthfi Abdillah**. Frontend: HTML5 + Tailwind CSS + JS.
Backend: Node.js **tanpa dependency eksternal** (hanya modul bawaan Node), jadi bisa langsung
dijalankan di hosting/VPS mana pun yang punya Node.js ≥ 18, tanpa perlu `npm install`.

## 1. Menjalankan di komputer/hosting

```bash
node server.js
```

Lalu buka:
- Website publik: `http://localhost:3000`
- Login admin: `http://localhost:3000/admin/login.html`

**Login admin default:**
- Username: `admin`
- Password: `CaggyID#2026`

⚠️ **Wajib ganti password ini** setelah login pertama, lewat tab **Keamanan** di dashboard admin.

Untuk mengganti port: `PORT=8080 node server.js`

## 2. Struktur folder

```
caggyid-dev/
├── server.js              # backend (semua logic API + keamanan ada di sini)
├── package.json
├── data/                   # "database" berbasis file JSON (tidak bisa diakses publik)
│   ├── admin.json          # kredensial admin (password sudah di-hash, bukan plaintext)
│   ├── settings.json       # identitas situs, bio, foto developer
│   ├── blogs.json          # semua post blog
│   └── projects.json       # semua proyek portfolio
└── public/                 # semua file yang bisa diakses browser
    ├── index.html           # halaman utama
    ├── css/style.css
    ├── js/main.js           # render data + logika sertifikat (localStorage)
    ├── uploads/             # gambar hasil upload (blog, proyek, foto developer)
    └── admin/
        ├── login.html
        ├── dashboard.html
        └── admin.js
```

## 3. Fitur

- **Beranda**: hero dengan foto & nama developer, about, projects, blog, sertifikat, kontak.
- **Blog**: admin bisa tambah/hapus post (judul, ringkasan, isi, gambar). Tersimpan di server (`data/blogs.json`), jadi tampil untuk semua pengunjung.
- **Proyek**: admin bisa tambah/hapus proyek (judul, kategori, deskripsi, link, tahun, gambar). Sudah diisi 3 contoh proyek dari kamu (Mount Astraeus/Yorunova, Exile Network, Caggy Shop) — bisa diedit/dihapus lewat admin panel.
- **Sertifikat**: sesuai permintaan, disimpan di **localStorage browser** (bukan server). Artinya sertifikat yang kamu tambahkan lewat admin panel hanya akan tampil di browser/perangkat yang sama tempat kamu menambahkannya — pengunjung lain tidak akan melihatnya secara otomatis. Kalau nanti kamu mau sertifikat tampil untuk semua orang dari server manapun, bagian ini gampang dipindah ke penyimpanan server seperti blog/proyek — tinggal bilang saja.
- **Pengaturan situs**: nama situs, nama developer, tagline, bio, foto, email/github/instagram — semua bisa diubah lewat admin panel tanpa sentuh kode.

## 4. Keamanan yang sudah diterapkan

- Password admin di-hash dengan **scrypt + salt** (built-in Node.js crypto), tidak pernah disimpan sebagai teks biasa.
- **Session token** acak 256-bit disimpan di server (bisa di-revoke), cookie diberi flag `HttpOnly`, `SameSite=Strict`, dan otomatis `Secure` saat situs berjalan via HTTPS — jadi token tidak bisa dicuri lewat JavaScript atau serangan cross-site.
- **CSRF protection**: setiap request yang mengubah data (tambah/edit/hapus) wajib menyertakan token CSRF yang cuma didapat lewat sesi login yang sah.
- **Rate limiting login**: setelah 5x percobaan password salah dari IP yang sama, login dikunci otomatis selama 15 menit (anti brute-force).
- **File `data/` (kredensial, database) tidak pernah di-serve sebagai file statis** — meskipun tahu nama filenya, pengunjung tidak bisa mengakses `data/admin.json` dari browser.
- Perlindungan **path traversal** pada penyajian file statis.
- Upload gambar divalidasi tipe & ukurannya (maks 6MB), nama file di-random-kan agar tidak bisa ditebak/ditimpa.
- Sanitasi dasar terhadap isi blog (menghapus tag `<script>`, `<iframe>`, atribut `onclick` dsb.) untuk mencegah stored XSS.
- Security headers: `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security` (saat HTTPS).

### Rekomendasi tambahan saat deploy ke publik
1. **Selalu pakai HTTPS** (lewat reverse proxy seperti Nginx + Let's Encrypt, atau platform hosting yang sudah menyediakan HTTPS otomatis).
2. Ganti password default admin **segera** setelah deploy.
3. Jangan commit folder `data/` ke repository publik (isi `.gitignore` sudah disiapkan) — kredensial & konten sebaiknya tetap privat di server.
4. Kalau memungkinkan, taruh admin panel di belakang VPN atau batasi akses IP tertentu untuk lapisan keamanan ekstra.
5. Backup folder `data/` dan `public/uploads/` secara berkala.

## 5. Mengganti foto developer

Bisa langsung dari admin panel (tab **Pengaturan Situs** → Foto developer), tidak perlu edit kode.

## 6. Deploy ke hosting

Karena tidak ada dependency npm, tinggal upload seluruh folder ini ke VPS/hosting yang mendukung Node.js (Railway, Render, VPS biasa, dll), lalu jalankan:

```bash
node server.js
```

Gunakan process manager seperti `pm2` supaya server tetap jalan setelah restart server:

```bash
npm install -g pm2
pm2 start server.js --name caggyid-dev
pm2 save
```
