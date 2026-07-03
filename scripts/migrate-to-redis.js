/**
 * Jalankan SEKALI SAJA di komputer lokal setelah env var Upstash sudah ada,
 * untuk memindahkan isi data/*.json (settings, blogs, projects, admin)
 * ke Upstash Redis supaya website Vercel langsung punya data awal.
 *
 * Cara pakai:
 *   1. vercel env pull .env.local   (ambil UPSTASH_REDIS_REST_URL & TOKEN dari project)
 *   2. node -r dotenv/config scripts/migrate-to-redis.js dotenv_config_path=.env.local
 *      (atau export manual env var-nya sebelum menjalankan `node scripts/migrate-to-redis.js`)
 */
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('❌ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN belum ada di environment.');
  console.error('   Jalankan `vercel env pull .env.local` dulu, lalu load file itu sebelum run script ini.');
  process.exit(1);
}

const redis = Redis.fromEnv();
const DATA_DIR = path.join(__dirname, '..', 'data');

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function main() {
  const settings = readJSON('settings.json', {});
  const blogs = readJSON('blogs.json', []);
  const projects = readJSON('projects.json', []);
  const admin = readJSON('admin.json', null);

  await redis.set('data:settings', JSON.stringify(settings));
  await redis.set('data:blogs', JSON.stringify(blogs));
  await redis.set('data:projects', JSON.stringify(projects));
  if (admin) {
    await redis.set('data:admin', JSON.stringify(admin));
    console.log('✅ admin.json dipindah (username:', admin.username + ')');
  } else {
    console.log('⚠️  data/admin.json tidak ditemukan — bikin admin baru dengan scripts/create-admin.js');
  }

  console.log('✅ settings, blogs, projects berhasil dipindah ke Upstash Redis.');
}

main().catch((err) => {
  console.error('❌ Gagal migrasi:', err);
  process.exit(1);
});
