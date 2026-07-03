# Tutorial Deploy CaggyID Dev ke Vercel

Project ini sudah diadaptasi supaya jalan di Vercel. Yang berubah dari versi asli:

| Bagian | Versi VPS (server.js) | Versi Vercel |
|---|---|---|
| Data blog/proyek/settings/admin | file `data/*.json` | **Upstash Redis** (Marketplace) |
| Session login & rate limit | `Map()` di memori | **Upstash Redis** |
| Upload gambar | folder `public/uploads` | **Vercel Blob** |
| Server | `node server.js` (nyala terus) | Serverless Function di `api/[...path].js` |

Frontend (`public/`) **tidak diubah sama sekali** — tetap fetch ke `/api/...` seperti biasa.

---

## Langkah 1 — Push project ke GitHub

1. Extract zip ini, lalu buat repo baru di GitHub.
2. Push semua isi folder ke repo tersebut (`git init`, `git add .`, `git commit`, `git push`).

## Langkah 2 — Import project ke Vercel

1. Buka [vercel.com/new](https://vercel.com/new), login, pilih repo GitHub tadi.
2. Di layar konfigurasi:
   - **Framework Preset**: biarkan `Other`.
   - **Build Command**: kosongkan.
   - **Output Directory**: biarkan default (Vercel otomatis pakai folder `public/`).
3. **Jangan klik Deploy dulu** — lanjut ke Langkah 3 supaya database sudah siap sebelum deploy pertama.

## Langkah 3 — Pasang Upstash Redis (database)

1. Di halaman project Vercel → tab **Storage** → **Create Database** / **Marketplace Database Providers**.
2. Pilih **Upstash** → **Redis** → ikuti wizard (pilih region terdekat, misal Singapore).
3. Setelah dibuat, klik **Connect Project** dan pilih project ini. Vercel otomatis menambahkan env var:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## Langkah 4 — Pasang Vercel Blob (penyimpanan gambar)

1. Masih di tab **Storage** → **Create Database** → pilih **Blob**.
2. Beri nama, buat, lalu **Connect Project** ke project ini.
3. Vercel otomatis menambahkan env var `BLOB_READ_WRITE_TOKEN`.

## Langkah 5 — Deploy

Klik **Deploy**. Tunggu sampai selesai — website akan langsung online di `https://nama-project.vercel.app`.

Tapi di titik ini datanya masih kosong (blog/proyek/admin belum ada di Redis). Lanjut ke Langkah 6.

## Langkah 6 — Pindahkan data awal ke Redis

Ini dikerjakan sekali saja, dari komputer kamu:

```bash
npm install -g vercel        # kalau belum ada
vercel login
vercel link                  # hubungkan folder ini ke project Vercel yang tadi dibuat
vercel env pull .env.local   # ambil UPSTASH_REDIS_REST_URL & TOKEN ke .env.local
npm install
node -r dotenv/config scripts/migrate-to-redis.js dotenv_config_path=.env.local
```

Kalau `dotenv` belum ke-install otomatis, jalankan `npm install dotenv` dulu (sekali saja, cuma dipakai lokal).

Script ini akan memindahkan isi `data/settings.json`, `data/blogs.json`, `data/projects.json`, dan `data/admin.json` (kredensial admin) ke Redis. Setelah ini website Vercel kamu akan tampil persis seperti versi lokal.

**Login admin default** (ganti segera setelah deploy):
- Username: `admin`
- Password: `CaggyID#2026`

Login lewat: `https://nama-project.vercel.app/admin/login.html`, lalu ganti password di tab **Keamanan**.

## Langkah 7 — Redeploy (opsional)

Kalau kamu instal integrasi Redis/Blob *setelah* deploy pertama, env var baru belum otomatis kepakai — cukup buka tab **Deployments** → titik tiga di deployment terakhir → **Redeploy**.

---

## Batasan yang perlu kamu tahu

- **Ukuran upload gambar dibatasi 3MB** (bukan 6MB seperti versi VPS). Ini karena Vercel Functions punya batas ukuran body request ~4.5MB, dan base64 menambah ukuran gambar ~33%.
- **Sertifikat** di halaman utama tetap tersimpan di `localStorage` browser pengunjung, seperti versi asli — tidak ikut pindah ke Redis (kalau nanti mau dipindah ke server juga, tinggal bilang).
- Kalau project berkembang dan butuh command Redis lebih dari 10.000/hari (free tier Upstash), tinggal upgrade plan di dashboard Upstash — tidak perlu ubah kode.
- Kalau suatu saat balik lagi ke VPS, `server.js` versi asli tetap ada dan masih berfungsi (`node server.js`) — dua mode ini independen.

## Kalau ada error

- **`UPSTASH_REDIS_REST_URL is not defined`** → integrasi Redis belum ke-connect ke project ini, cek Langkah 3.
- **Upload gambar gagal terus** → cek `BLOB_READ_WRITE_TOKEN` sudah ada di Environment Variables project (Settings → Environment Variables).
- **Login admin gagal padahal password benar** → berarti Langkah 6 (migrasi data) belum dijalankan, jadi Redis belum punya `data:admin`.
