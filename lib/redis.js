/**
 * Wrapper tipis di atas @upstash/redis.
 * Vercel Marketplace (integrasi Upstash Redis) otomatis mengisi env var:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 * Redis.fromEnv() membaca keduanya secara otomatis.
 */
const { Redis } = require('@upstash/redis');

let client = null;
function getRedis() {
  if (!client) {
    // Integrasi Upstash lewat Vercel Marketplace kadang memakai nama env var
    // gaya lama "Vercel KV" (KV_REST_API_URL / KV_REST_API_TOKEN) alih-alih
    // UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Dukung keduanya.
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        'Kredensial Redis tidak ditemukan. Pastikan salah satu pasangan env var ini ada: ' +
          'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN atau KV_REST_API_URL/KV_REST_API_TOKEN.'
      );
    }
    client = new Redis({ url, token });
  }
  return client;
}

// ---------- Data JSON (pengganti data/*.json) ----------
async function readData(key, fallback) {
  const redis = getRedis();
  const val = await redis.get(`data:${key}`);
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch (e) {
      return fallback;
    }
  }
  return val;
}

async function writeData(key, data) {
  const redis = getRedis();
  await redis.set(`data:${key}`, JSON.stringify(data));
}

// ---------- Session (pengganti Map in-memory) ----------
const SESSION_TTL_SEC = 2 * 60 * 60; // 2 jam

async function createSession(username) {
  const crypto = require('crypto');
  const redis = getRedis();
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  await redis.set(`session:${token}`, JSON.stringify({ username, csrf }), { ex: SESSION_TTL_SEC });
  return { token, csrf };
}

async function getSession(token) {
  if (!token) return null;
  const redis = getRedis();
  const raw = await redis.get(`session:${token}`);
  if (!raw) return null;
  const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  redis.expire(`session:${token}`, SESSION_TTL_SEC).catch(() => {}); // sliding expiry, fire-and-forget
  return session;
}

async function deleteSession(token) {
  if (!token) return;
  const redis = getRedis();
  await redis.del(`session:${token}`);
}

// ---------- Rate limiting login (pengganti Map in-memory) ----------
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_SEC = 15 * 60;

async function isLockedOut(ip) {
  const redis = getRedis();
  const rec = await redis.get(`loginlock:${ip}`);
  return !!rec;
}

async function registerFailedAttempt(ip) {
  const redis = getRedis();
  const key = `loginattempts:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, LOCKOUT_SEC);
  if (count >= MAX_LOGIN_ATTEMPTS) {
    await redis.set(`loginlock:${ip}`, '1', { ex: LOCKOUT_SEC });
    await redis.del(key);
  }
}

async function registerSuccessfulAttempt(ip) {
  const redis = getRedis();
  await redis.del(`loginattempts:${ip}`);
}

module.exports = {
  getRedis,
  readData,
  writeData,
  createSession,
  getSession,
  deleteSession,
  isLockedOut,
  registerFailedAttempt,
  registerSuccessfulAttempt,
};
