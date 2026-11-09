'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.join(__dirname, '..');
const TOKEN_FILE = path.join(APP_DIR, '.vibecoder-media-token');
// Overridable so a test run can keep its uploaded files out of the live folder.
const LOCAL_DIR = process.env.DLY_UPLOAD_DIR
  ? path.resolve(process.env.DLY_UPLOAD_DIR)
  : path.join(APP_DIR, 'public', 'uploads');
const LOCAL_PREFIX = '/uploads/';
const MEDIA_ENDPOINT = 'http://127.0.0.1:4310/api/app-media/upload';

const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
};

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (err) {
    return '';
  }
}

/**
 * Uploads an image. In production the platform mints .vibecoder-media-token at
 * publish time and the file is stored on the app-media CDN (durable). During
 * local development the token is absent, so the file is written to
 * public/uploads instead. Both cases return a src usable by the app.
 */
async function uploadImage(buffer, originalName, mimetype) {
  const ext = ALLOWED[mimetype];
  if (!ext) {
    const err = new Error('Format gambar harus JPG, PNG, WEBP, GIF, atau SVG.');
    err.status = 400;
    throw err;
  }

  const safeBase = (originalName || 'foto')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .slice(0, 40) || 'foto';
  const filename = `${safeBase}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;

  const token = readToken();
  if (token) {
    const url = `${MEDIA_ENDPOINT}?filename=${encodeURIComponent(filename)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-App-Media-Token': token,
          'Content-Type': 'application/octet-stream'
        },
        body: buffer
      });
    } catch (err) {
      const e = new Error('Gagal menghubungi layanan penyimpanan media. Coba lagi sebentar lagi.');
      e.status = 502;
      throw e;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok || !data || !data.ok || !data.url) {
      const msg = (data && (data.message || data.error)) || `Unggah media gagal (${res.status}).`;
      const e = new Error(msg);
      e.status = res.status === 403 ? 403 : 502;
      throw e;
    }
    return { src: data.url, stored: 'cdn' };
  }

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer);
  return { src: `/uploads/${filename}`, stored: 'local' };
}

module.exports = { uploadImage, ALLOWED, LOCAL_DIR, localPathFor };

/**
 * Absolute on-disk path for an app-local upload src (`/uploads/x.jpg`), or null when
 * the src is a CDN URL. Used by the photo-selection preview generator, which must read
 * the MASTER file without ever exposing its public URL.
 */
function localPathFor(src) {
  const value = String(src || '');
  if (!value.startsWith(LOCAL_PREFIX)) return null;
  const name = path.basename(value.slice(LOCAL_PREFIX.length));
  if (!name || name === '.' || name === '..') return null;
  return path.join(LOCAL_DIR, name);
}
