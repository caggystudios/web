/**
 * Upload gambar base64 dataURL ke Vercel Blob (pengganti simpan ke public/uploads,
 * karena filesystem Vercel read-only & tidak persisten).
 *
 * Catatan penting: request body Vercel Functions dibatasi ~4.5MB total.
 * Base64 menambah ukuran ~33%, jadi batas gambar mentah diset 3MB supaya aman.
 */
const crypto = require('crypto');
const { put } = require('@vercel/blob');

const MAX_IMAGE_SIZE = 3 * 1024 * 1024; // 3MB

async function saveBase64Image(dataUrl, prefix) {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) {
    throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG, WEBP, atau GIF.');
  }
  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  const buffer = Buffer.from(match[2], 'base64');

  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error('Ukuran gambar maksimal 3MB (batas upload di Vercel Functions).');
  }

  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const blob = await put(filename, buffer, { access: 'public', contentType });
  return blob.url; // URL absolut, langsung dipakai di <img src="...">
}

module.exports = { saveBase64Image };
