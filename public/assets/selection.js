/* ==========================================================================
   DLY Graduation — client photo-selection portal.
   The server is the source of truth for the quota, the picks and the file names;
   this only mirrors them for instant feedback.
   ========================================================================== */
(function () {
  'use strict';

  var app = document.querySelector('[data-selection-app]');
  if (!app) return;

  var token = app.getAttribute('data-token') || '';
  var base = app.getAttribute('data-base') || '';
  var quota = Number(app.getAttribute('data-quota')) || 0;
  var requireFull = app.getAttribute('data-require-full') === '1';
  var locked = app.getAttribute('data-locked') === '1';
  var waHref = app.getAttribute('data-wa') || '';

  var grid = app.querySelector('[data-sel-grid]');
  var tiles = Array.prototype.slice.call(grid.querySelectorAll('.sel-tile[data-photo]'));
  var counterChips = document.querySelectorAll('[data-sel-counter], [data-sel-counter-bar], [data-sel-counter-inline], [data-sel-counter-big]');
  var pickedCountEl = document.querySelector('[data-picked-count]');
  var progressEl = document.querySelector('[data-sel-progress]');
  var sendBtn = document.querySelector('[data-sel-send]');
  var viewBtn = document.querySelector('[data-sel-view]');
  var statusEl = document.querySelector('[data-sel-status]');
  var toastEl = document.querySelector('[data-sel-toast]');
  var modal = document.querySelector('[data-sel-modal]');

  // File names come from the server (database), never from the DOM text.
  var names = [];
  try { names = JSON.parse((app.getAttribute('data-names') || '[]').replace(/&quot;/g, '"')); } catch (e) { names = []; }

  var picked = new Set();
  tiles.forEach(function (t) {
    if (t.classList.contains('is-picked')) picked.add(Number(t.getAttribute('data-photo')));
  });
  var order = new Map(); // photoId → 1-based order shown on the badge
  var nameOf = new Map();
  var counter = 0;

  /* ==========================================================================
     V2 — AKURASI PILIHAN (perbaikan bug "pilihan lain ikut hilang")

     Penyebab bug: setiap respons /pick berisi DAFTAR PENUH pilihan pada saat server
     memprosesnya, dan kode lama MENGGANTI seluruh state dengan daftar itu:
         picked = new Set(response.picks)
     Bila dua klik terjadi berdekatan, respons yang lebih LAMA bisa tiba BELAKANGAN
     (koneksi HP) → daftar lama menimpa pilihan baru → foto dari baris lain hilang
     dari layar walaupun tetap tersimpan di database.

     Perbaikan:
      1. Server mengirim `rev` (nomor revisi pilihan, naik di transaksi yang sama).
      2. Klien menyimpan `picksRev` tertinggi yang pernah dilihat dan MENGABAIKAN
         respons dengan rev lebih kecil/sama (stale).
      3. Perubahan lokal diterapkan per-ID (add/delete), tidak pernah "ganti semua".
      4. Setiap klik diberi `opId` unik → server idempotent terhadap retry.
     ========================================================================== */
  var picksRev = Number(app.getAttribute('data-picks-rev')) || 0;
  var pending = new Map(); // photoId → { action, opId } (request yang belum selesai)
  var opSeq = 0;
  var newOpId = function () {
    opSeq += 1;
    return Date.now().toString(36) + '-' + opSeq + '-' + Math.random().toString(36).slice(2, 8);
  };

  /** Badge nomor urut: pakai posisi dari server bila ada, jika tidak urutan lokal. */
  function applyPositions(list) {
    if (!Array.isArray(list) || !list.length) return;
    var next = new Map();
    list.forEach(function (row) {
      if (row && row.id) next.set(Number(row.id), Number(row.position) || next.size + 1);
    });
    if (next.size) order = next;
  }

  var toastTimer = null;
  function toast(message, isError) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = 'sel-toast is-visible' + (isError ? ' is-error' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 4200);
  }

  function rebuildOrder(sourceIds) {
    var ids = sourceIds || Array.from(picked);
    counter = ids.length;
    order = new Map();
    ids.forEach(function (id, i) { order.set(Number(id), i + 1); });
  }

  function paint() {
    var n = picked.size;
    counterChips.forEach(function (el) {
      if (el.hasAttribute('data-sel-counter-big')) {
        // Markup: <span>picked<i>/quota</i></span> — keep the small "/quota" styling.
        el.innerHTML = n + '<i>/' + quota + '</i>';
      } else {
        el.textContent = n + '/' + quota;
      }
    });
    if (pickedCountEl) pickedCountEl.textContent = n;
    if (progressEl) progressEl.style.width = (quota ? Math.round((n / quota) * 100) : 0) + '%';

    tiles.forEach(function (tile) {
      var id = Number(tile.getAttribute('data-photo'));
      var on = picked.has(id);
      tile.classList.toggle('is-picked', on);
      var badge = tile.querySelector('[data-order]');
      // Badge = posisi foto ini (bukan jumlah total) — sebelumnya semua tile menampilkan
      // angka yang sama sehingga urutan pilihan tidak terbaca.
      if (badge) badge.textContent = on ? (order.get(id) || '') : '';
      var btn = tile.querySelector('[data-pick]');
      if (btn) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        var label = btn.querySelector('[data-pick-label]');
        if (label) label.textContent = on ? 'Terpilih' : 'Pilih';
      }
    });

    if (sendBtn) {
      sendBtn.disabled = n === 0;
      sendBtn.classList.toggle('is-disabled', n === 0);
    }
    if (statusEl) {
      if (n === 0) {
        statusEl.textContent = 'Belum ada foto dipilih. Batas pilihan ' + quota + ' foto.';
      } else if (n >= quota) {
        statusEl.textContent = 'Batas maksimal pemilihan tercapai (' + n + '/' + quota + ').';
      } else {
        statusEl.textContent = n + '/' + quota + ' foto terpilih · sisa ' + (quota - n) + ' pilihan.';
      }
    }
  }

  function applyFilter() {
    var filter = activeFilter;
    var query = (searchEl && searchEl.value || '').trim().toLowerCase();
    var visible = 0;
    tiles.forEach(function (tile) {
      var id = Number(tile.getAttribute('data-photo'));
      var name = tile.getAttribute('data-name') || '';
      var matchFilter = filter === 'picked' ? picked.has(id)
        : filter === 'highlight' ? tile.getAttribute('data-highlight') === '1'
        : true;
      var matchQuery = !query || name.indexOf(query) !== -1;
      var show = matchFilter && matchQuery;
      tile.hidden = !show;
      if (show) visible += 1;
    });
    if (emptyEl) emptyEl.hidden = visible > 0;
    return visible;
  }

  var activeFilter = 'all';
  var searchEl = app.querySelector('[data-sel-search]');
  var sortEl = app.querySelector('[data-sel-sort]');
  var emptyEl = app.querySelector('[data-sel-empty]');

  // Initial order for already-picked photos comes from the DOM (server order).
  var initialIds = [];
  tiles.forEach(function (t) {
    if (picked.has(Number(t.getAttribute('data-photo')))) {
      initialIds.push(Number(t.getAttribute('data-photo')));
    }
  });
  rebuildOrder(initialIds);
  paint();

  if (locked) {
    if (searchEl) searchEl.addEventListener('input', applyFilter);
    app.querySelectorAll('[data-filter]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        app.querySelectorAll('[data-filter]').forEach(function (t) { t.classList.remove('is-active'); });
        tab.classList.add('is-active');
        activeFilter = tab.getAttribute('data-filter');
        applyFilter();
      });
    });
    return;
  }

  /* ---------------- filters / search / sort ---------------- */
  app.querySelectorAll('[data-filter]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      app.querySelectorAll('[data-filter]').forEach(function (t) {
        t.classList.remove('is-active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      activeFilter = tab.getAttribute('data-filter');
      applyFilter();
    });
  });

  if (searchEl) searchEl.addEventListener('input', applyFilter);

  if (sortEl) {
    sortEl.addEventListener('change', function () {
      var mode = sortEl.value;
      var sorted = tiles.slice();
      if (mode === 'name-asc' || mode === 'name-desc') {
        sorted.sort(function (a, b) {
          var an = a.getAttribute('data-name') || '';
          var bn = b.getAttribute('data-name') || '';
          return mode === 'name-asc' ? an.localeCompare(bn, 'id', { numeric: true })
            : bn.localeCompare(an, 'id', { numeric: true });
        });
      } else {
        sorted.sort(function (a, b) {
          return Number(a.getAttribute('data-photo')) - Number(b.getAttribute('data-photo'));
        });
      }
      sorted.forEach(function (t) { grid.appendChild(t); });
      applyFilter();
    });
  }

  /* ---------------- picking ---------------- */
  /**
   * Satu klik = satu operasi. State lokal diubah PER ID (tidak pernah mengganti seluruh
   * daftar), lalu direkonsiliasi dengan respons server yang lebih baru saja.
   */
  function pickRequest(photoId, action, opId) {
    return fetch(base + '/selection/' + token + '/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ photoId: photoId, action: action, opId: opId })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  /** Terapkan keadaan dari server HANYA bila lebih baru dari yang sudah dipegang. */
  function reconcile(data) {
    var rev = Number(data && data.rev);
    if (!Number.isFinite(rev)) return false;
    if (rev <= picksRev) return false;      // respons lama → abaikan (inti perbaikan)
    picksRev = rev;
    if (Array.isArray(data.picks)) {
      var server = new Set(data.picks.map(Number));
      // Server adalah sumber kebenaran: samakan, tetapi JANGAN menghapus pilihan yang
      // masih menunggu konfirmasi (ada request lain yang belum selesai).
      pending.forEach(function (p, waitingId) {
        if (p.action === 'add') server.add(Number(waitingId));
        else server.delete(Number(waitingId));
      });
      picked = server;
    }
    if (Array.isArray(data.names)) names = data.names;
    applyPositions(data.positions);
    rebuildOrder(Array.from(picked));
    return true;
  }

  grid.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-pick]');
    if (!btn) return;
    event.preventDefault();
    if (btn.disabled) return;

    var photoId = Number(btn.getAttribute('data-pick'));
    if (!photoId) return;

    var wasPicked = picked.has(photoId);
    if (!wasPicked && quota && picked.size >= quota) {
      toast('Batas pilihan sudah penuh (' + quota + ' foto). Batalkan salah satu foto dulu.', true);
      return;
    }

    var opId = newOpId();
    var action = wasPicked ? 'remove' : 'add';

    // 1) Perubahan optimistis, per ID.
    btn.disabled = true;
    if (wasPicked) picked.delete(photoId); else picked.add(photoId);
    if (wasPicked) rebuildOrder(Array.from(picked));
    else order.set(photoId, picked.size);
    pending.set(photoId, { action: action, opId: opId });
    paint();
    if (activeFilter === 'picked') applyFilter();

    // 2) Kirim ke server; hasilnya hanya dipakai bila lebih baru (rev).
    //    Retry sekali untuk kegagalan jaringan sesaat — opId sama = idempotent.
    var attempt = function (tries) {
      return pickRequest(photoId, action, opId).catch(function (err) {
        if (err || tries <= 1) return null;     // null → gagal, ditangani di bawah
        return attempt(tries - 1);
      });
    };

    attempt(2).then(function (result) {
      pending.delete(photoId);
      if (!result || !result.ok || !result.data || !result.data.ok) {
        // Gagal: kembalikan HANYA foto ini (pilihan lain tidak disentuh).
        if (action === 'add') picked.delete(photoId); else picked.add(photoId);
        rebuildOrder(Array.from(picked));
        paint();
        if (activeFilter === 'picked') applyFilter();
        var msg = (result && result.data && result.data.message)
          || 'Pilihan gagal disimpan. Periksa koneksi lalu coba lagi.';
        toast(msg, true);
        return;
      }
      // Sukses: respons memuat rev terbaru → rekonsiliasi penuh (stale otomatis diabaikan).
      reconcile(result.data);
      paint();
      if (activeFilter === 'picked') applyFilter();
      if (picked.size === quota && quota > 0) {
        toast('Semua kuota terisi. Tekan "Kirim Pilihan" bila sudah selesai.', false);
      }
    }).then(function () {
      btn.disabled = false;
    });
  });

  /* ---------------- "Lihat Pilihan" — filter to picked only ---------------- */
  if (viewBtn) {
    viewBtn.addEventListener('click', function () {
      var pickedTab = app.querySelector('[data-filter="picked"]');
      if (pickedTab) pickedTab.click();
      app.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ---------------- confirmation modal ---------------- */
  function paintModal() {
    if (!modal) return;
    var listEl = modal.querySelector('[data-sel-modal-list]');
    var countEl = modal.querySelector('[data-sel-modal-count]');
    if (listEl) {
      // Revisi pemilik: daftar ke WhatsApp = nama file bersih (tanpa nomor urut & ekstensi),
      // satu per baris, supaya mudah disortir.
      listEl.textContent = names.length ? names.join('\n') : '(belum ada foto dipilih)';
    }
    if (countEl) countEl.textContent = String(picked.size);
  }

  function openModal() {
    if (!modal) return;
    if (!picked.size) {
      toast('Pilih minimal satu foto terlebih dahulu.', true);
      return;
    }
    if (requireFull && picked.size < quota) {
      toast('Portal ini mewajibkan ' + quota + ' foto dipilih. Saat ini ' + picked.size + '.', true);
      return;
    }
    paintModal();
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var first = modal.querySelector('[data-sel-copy]');
    if (first) first.focus();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  if (modal) {
    modal.addEventListener('click', function (event) {
      if (event.target.closest('[data-sel-modal-close]')) closeModal();
    });
    document.addEventListener('keydown', function (event) {
      if (!modal.hidden && event.key === 'Escape') closeModal();
    });

    var copyBtn = modal.querySelector('[data-sel-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var list = modal.querySelector('[data-sel-modal-list]');
        var text = list ? list.textContent : '';
        var done = function () {
          copyBtn.textContent = 'Tersalin ✓';
          setTimeout(function () { copyBtn.textContent = 'Salin Daftar Foto'; }, 1800);
          toast('Daftar foto disalin.', false);
        };
        var fallback = function () {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); } catch (e) { toast('Gagal menyalin. Salin manual ya.', true); }
          document.body.removeChild(ta);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
          fallback();
        }
      });
    }

    var submitBtn = modal.querySelector('[data-sel-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Menyimpan…';
        fetch(base + '/selection/' + token + '/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({})
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { ok: res.ok, data: data };
          });
        }).then(function (result) {
          if (!result.ok || !result.data.ok) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Simpan & Buka WhatsApp';
            toast(result.data.message || 'Gagal menyimpan pilihan.', true);
            return;
          }
          var href = result.data.wa || waHref;
          if (href) window.open(href, '_blank', 'noopener');
          window.location.href = base + '/selection/' + token + '?sent=1';
        }).catch(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Simpan & Buka WhatsApp';
          toast('Koneksi bermasalah. Pilihan belum terkirim.', true);
        });
      });
    }
  }

  if (sendBtn) sendBtn.addEventListener('click', openModal);

  // Warn if the client closes the tab with an unsubmitted selection.
  window.addEventListener('beforeunload', function (event) {
    if (!picked.size || locked) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* ==================================================================
     Revisi — mode Swipe: satu foto besar, geser untuk berpindah.
     ================================================================== */
  (function initSwipe() {
    var box = app.querySelector('[data-sel-swipe]');
    if (!box) return;
    var img = box.querySelector('[data-swipe-img]');
    var nameEl = box.querySelector('[data-swipe-name]');
    var posEl = box.querySelector('[data-swipe-pos]');
    var stateEl = box.querySelector('[data-swipe-state]');
    var pickBtn = box.querySelector('[data-swipe-pick]');
    var prevBtn = box.querySelector('[data-swipe-prev]');
    var nextBtn = box.querySelector('[data-swipe-next]');
    var index = 0;

    function list() { return tiles.filter(function (t) { return !t.hidden || activeFilter === 'swipe'; }); }

    function render() {
      var items = tiles; // swipe selalu berjalan pada seluruh foto (urutan folder)
      if (!items.length) return;
      index = Math.max(0, Math.min(index, items.length - 1));
      var tile = items[index];
      var id = Number(tile.getAttribute('data-photo'));
      var base = app.getAttribute('data-base') || '';
      var token = app.getAttribute('data-token');
      img.src = base + '/selection/' + token + '/photo/' + id + '?w=640';
      img.alt = tile.getAttribute('data-name') || '';
      nameEl.textContent = tile.getAttribute('data-name') || ('Foto ' + (index + 1));
      posEl.textContent = (index + 1) + ' / ' + items.length;
      var on = picked.has(id);
      stateEl.hidden = !on;
      stateEl.textContent = on ? 'Terpilih' : '';
      pickBtn.textContent = on ? 'Batalkan pilihan' : 'Pilih foto ini';
      pickBtn.classList.toggle('sel-btn--primary', !on);
      pickBtn.classList.toggle('sel-btn--ghost', on);
    }

    function step(delta) { index += delta; render(); }

    if (prevBtn) prevBtn.addEventListener('click', function () { step(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { step(1); });
    if (pickBtn) pickBtn.addEventListener('click', function () {
      var tile = tiles[index];
      if (!tile) return;
      var btn = tile.querySelector('[data-pick]');
      if (btn) btn.click(); // reuse the existing toggle logic (server-validated)
    });

    // swipe gestures
    var startX = null;
    var card = box.querySelector('.sel-swipe__card');
    if (card) {
      card.addEventListener('touchstart', function (e) {
        startX = e.touches && e.touches[0] ? e.touches[0].clientX : null;
      }, { passive: true });
      card.addEventListener('touchend', function (e) {
        if (startX == null) return;
        var endX = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : startX;
        var dx = endX - startX;
        startX = null;
        if (Math.abs(dx) < 45) return;
        step(dx < 0 ? 1 : -1);
      }, { passive: true });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') step(1);
        if (e.key === 'ArrowLeft') step(-1);
      });
    }

    function syncMode() {
      var swiping = activeFilter === 'swipe';
      var foldable = app.querySelector('[data-sel-foldable]');
      box.hidden = !swiping;
      if (foldable) foldable.hidden = swiping;
      var foldBtn = app.querySelector('[data-sel-fold]');
      if (foldBtn) foldBtn.hidden = swiping;
      var tools = app.querySelector('.sel-tools');
      if (tools) tools.hidden = swiping;
      if (swiping) render();
    }
    app.querySelectorAll('[data-filter]').forEach(function (tab) {
      tab.addEventListener('click', syncMode);
    });
    syncMode();
    app.__selSwipe = { render: render, syncMode: syncMode };
  })();

})();

/* ==========================================================================
   Revisi — galeri bisa dilipat. Dipisah dari IIFE utama supaya tetap bekerja
   pada portal yang sudah dikirim (mode baca-saja) maupun portal aktif.
   ========================================================================== */
(function initFold() {
  var btn = document.querySelector('[data-sel-fold]');
  var box = document.querySelector('[data-sel-foldable]');
  if (!btn || !box) return;
  btn.addEventListener('click', function () {
    var collapsed = box.classList.toggle('is-collapsed');
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    var label = btn.querySelector('[data-sel-fold-label]');
    if (label) label.textContent = collapsed ? 'Buka galeri' : 'Ciutkan galeri';
    if (collapsed) {
      try { btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
    }
  });
})();
