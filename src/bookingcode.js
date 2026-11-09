'use strict';

/**
 * Kode booking Client Portal.
 *
 * Format (blueprint): DLY-[LAYANAN]-[NAMA KLIEN][NOMOR URUT]
 *   DLY-WISUDA-ANJAS001
 *   DLY-WISUDA-NADIA003
 *
 * Aturan:
 *  - LAYANAN = 'WISUDA' untuk fotografi wisuda (dari kategori paket, fallback WISUDA).
 *  - NAMA KLIEN = huruf saja, uppercase, tanpa gelar/tanda baca, maksimal 10 huruf.
 *  - NOMOR URUT = 3 digit, dihitung per (layanan + nama), tidak pernah dipakai ulang.
 *  - Kode bersifat permanen: reschedule / ganti tim TIDAK mengubah kode.
 *  - Kode lama tetap disimpan di `bookings.legacy_code` dan masih bisa dipakai masuk portal.
 */

const { db } = require('./db');

const SERVICE_DEFAULT = 'WISUDA';

/** Nama untuk kode: huruf saja, uppercase, tanpa gelar. "Anjas, S.Kom." → "ANJAS". */
function namePart(clientName) {
  const cleaned = String(clientName || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // é → e
    .replace(/[^A-Za-z\s]/g, ' ')                        // buang gelar/tanda baca
    .trim();
  // Ambil kata pertama yang cukup panjang (hindari "H" dari "H. Ahmad").
  const words = cleaned.split(/\s+/).filter(Boolean);
  const first = words.find((w) => w.length >= 3) || words[0] || 'KLIEN';
  return first.toUpperCase().slice(0, 10);
}

const servicePart = (value) => {
  const words = String(value || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const hit = words.find((w) => w === 'WISUDA') || words.find((w) => w.startsWith('WISUDA'));
  return hit || SERVICE_DEFAULT;
};

/** Apakah string ini sudah berbentuk kode portal baru? */
const isNewFormat = (code) => /^DLY-[A-Z]+-[A-Z]{3,10}\d{3}$/.test(String(code || ''));

/**
 * Bangkitkan kode unik untuk satu booking.
 * @param {{clientName?:string, service?:string, excludeBookingId?:number}} opts
 */
function generate({ clientName = '', service = '', excludeBookingId = 0 } = {}) {
  const svc = servicePart(service);
  const name = namePart(clientName);
  const prefix = `DLY-${svc}-${name}`;
  // Hitung yang sudah ada (termasuk milik booking ini sendiri saat regenerasi).
  const rows = db.prepare('SELECT code, legacy_code FROM bookings').all();
  const used = new Set();
  rows.forEach((r) => {
    [r.code, r.legacy_code].forEach((c) => {
      const m = String(c || '').match(new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d{3})$`));
      if (m) used.add(Number(m[1]));
    });
  });
  let n = 1;
  while (used.has(n)) n += 1;
  for (let i = n; i <= 999; i += 1) {
    const candidate = `${prefix}${String(i).padStart(3, '0')}`;
    const clash = db.prepare('SELECT id FROM bookings WHERE code = ? OR legacy_code = ?').get(candidate, candidate);
    if (!clash || (excludeBookingId && Number(clash.id) === Number(excludeBookingId))) {
      return candidate;
    }
  }
  // Praktis tidak terjadi; tetap jaga keunikan.
  return `${prefix}${String(Date.now()).slice(-3)}`;
}

/** PIN 4 digit acak (string). Disimpan sebagai hash oleh pemanggil/inisialisasi. */
function randomPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = { generate, namePart, servicePart, isNewFormat, randomPin, SERVICE_DEFAULT };
