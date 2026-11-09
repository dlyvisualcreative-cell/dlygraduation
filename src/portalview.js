'use strict';

/**
 * Data halaman pemilihan foto — dipakai DUA entry point:
 *   1. `/selection/<token>`  (link lama, tetap jalan)
 *   2. `/portal/pilih-foto`  (Client Portal baru, di dalam sidebar)
 *
 * Semua aturan (kuota, kunci setelah submit, deadline, pratinjau ber-watermark) tetap
 * dijalankan oleh `src/selection.js` + route POST yang sama — modul ini hanya menyiapkan
 * variabel tampilan supaya kedua halaman tidak pernah berbeda perilaku.
 */

const util = require('./util');
const selection = require('./selection');
const editing = require('./editing');

/** Portal terkunci bila ditutup / deadline lewat / sudah submit (kecuali dilihat admin). */
function gate(ctx, adminView) {
  const p = ctx.portal;
  const submitted = ['submitted', 'processing', 'done'].includes(p.status);
  const deadlinePassed = Boolean(p.deadline) && util.todayISO() > String(p.deadline).slice(0, 10);
  const closed = (!p.is_open || (p.expires_at && util.todayISO() > String(p.expires_at).slice(0, 10))) && !adminView;
  return { submitted, deadlinePassed, closed, locked: closed || submitted || deadlinePassed };
}

/**
 * @param {object} req express req
 * @param {object} res express res (untuk settings/brand)
 * @param {object} booking baris bookings.*
 * @param {{adminView?:boolean}} opts
 */
function photoVars(req, res, booking, { adminView = false } = {}) {
  const portal = selection.portalForBooking(booking.id);
  if (!portal) return null;
  const ctx = selection.detail(portal);
  if (!ctx) return null;

  const allPhotos = selection.photosFor(portal.id);
  const photos = allPhotos.filter((p) => Number(p.is_available) !== 0);
  const picks = new Set(ctx.picks);
  const g = gate(ctx, adminView);
  const pickedList = selection.pickedPhotos(portal.id);
  const pickedNames = pickedList.map((p) => selection.photoBaseName(p));
  // Posisi (1..N) per foto — dipakai badge urutan pada tile (bukan jumlah total).
  const positions = new Map(pickedList.map((p, i) => [p.id, Number(p.position) || (i + 1)]));
  const base = req.basePath;
  const brandName = (res.locals.settings.selection_brand_name || '').trim() || res.locals.brand.name;

  return {
    portal,
    booking: ctx.booking,
    photos,
    unavailableCount: allPhotos.length - photos.length,
    picks,
    positions,
    quota: portal.quota,
    gate: g,
    adminView,
    sent: req.query.sent === '1',
    empty: req.query.empty === '1',
    error: req.query.error ? String(req.query.error).slice(0, 200) : '',
    formatDateTimeWIB: util.formatDateTimeWIB,
    allowDownload: Number(portal.allow_download) === 1,
    requireFullQuota: Number(portal.require_full_quota) === 1,
    drive: selection.driveFolderFor(portal, ctx.booking),
    editingStatus: g.submitted ? (editing.clientView(portal.id) || editing.pendingView()) : null,
    selectedNames: pickedNames,
    highlightCount: photos.filter((p) => Number(p.is_highlight) === 1).length,
    selectedCount: pickedNames.length,
    submitWa: util.whatsappLink(res.locals.settings.whatsapp_number || '', selection.clientSubmitMessage(ctx)),
    portalBrand: brandName,
    portalBrandName: brandName,
    photoSrc: (id) => `${base}/selection/${portal.token}/photo/${id}`,
    downloadSrc: (id) => `${base}/selection/${portal.token}/download/${id}`,
    portalUrl: `${base}/selection/${portal.token}`,
    selectionBaseName: selection.photoBaseName,
    formatDateID: util.formatDateID
  };
}

module.exports = { gate, photoVars };
