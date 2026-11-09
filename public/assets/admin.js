/* DLY Graduation — admin interactions */
(function () {
  'use strict';

  const csrf = (document.querySelector('input[name="_csrf"]') || {}).value || '';

  /* ---------------- sidebar ---------------- */
  const side = document.querySelector('[data-side]');
  const burger = document.querySelector('[data-side-toggle]');
  if (side && burger) {
    burger.addEventListener('click', () => side.classList.toggle('is-open'));
    document.addEventListener('click', (e) => {
      if (window.innerWidth >= 1000) return;
      if (!side.classList.contains('is-open')) return;
      if (side.contains(e.target) || burger.contains(e.target)) return;
      side.classList.remove('is-open');
    });
  }

  /* ---------------- collapsible nav groups (remembered) ---------------- */
  const NAV_KEY = 'dly.admin.navGroups';
  const navRoot = document.querySelector('[data-admin-nav]');
  if (navRoot) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(NAV_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    const groups = Array.from(navRoot.querySelectorAll('[data-nav-group]'));

    // A group that holds the active page always opens, whatever was remembered.
    groups.forEach((g) => {
      const key = g.dataset.navGroup;
      const hasActive = Boolean(g.querySelector('.admin-nav__item.is-active'));
      if (hasActive) g.classList.add('is-open');
      else if (key in saved) g.classList.toggle('is-open', Boolean(saved[key]));
    });

    const persist = () => {
      const state = {};
      groups.forEach((g) => { state[g.dataset.navGroup] = g.classList.contains('is-open'); });
      try { localStorage.setItem(NAV_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    };

    navRoot.addEventListener('click', (e) => {
      const head = e.target.closest('[data-nav-toggle-group]');
      if (!head) return;
      const group = head.closest('[data-nav-group]');
      if (!group) return;
      group.classList.toggle('is-open');
      head.setAttribute('aria-expanded', String(group.classList.contains('is-open')));
      persist();
    });

    // First visit: open the group of the current page, keep others closed.
    if (!Object.keys(saved).length) {
      groups.forEach((g) => {
        if (!g.querySelector('.admin-nav__item.is-active')) g.classList.remove('is-open');
      });
      persist();
    }
  }

  /* ---------------- testimonial star picker readout ---------------- */
  document.querySelectorAll('[data-admin-stars]').forEach((picker) => {
    const readout = picker.parentElement.querySelector('[data-admin-stars-readout]');
    if (!readout) return;
    picker.querySelectorAll('input[type="radio"]').forEach((input) => {
      input.addEventListener('change', () => {
        readout.textContent = `${input.value} dari 5 bintang`;
      });
    });
    const checked = picker.querySelector('input:checked');
    if (checked) readout.textContent = `${checked.value} dari 5 bintang`;
  });

  /* ---------------- destructive confirmations ---------------- */
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm || 'Lanjutkan?')) e.preventDefault();
    });
  });

  /* ---------------- thousand separators on price fields ---------------- */
  document.addEventListener('blur', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!/^dur_price_/.test(input.name || '') && !/^price_/.test(input.name || '')) return;
    const digits = input.value.replace(/[^\d]/g, '');
    input.value = digits ? Number(digits).toLocaleString('id-ID') : '';
  }, true);

  /* ---------------- image downscaling before upload ---------------- */
  async function optimizeImage(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
    if (file.size < 350 * 1024) return file;
    try {
      const bitmap = await createImageBitmap(file);
      // Hero images keep more detail than portfolio thumbnails.
      const isHero = Boolean(document.querySelector('input[name="desktop_position"]'));
      const maxEdge = isHero ? 2400 : 1800;
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (err) {
      return file;
    }
  }

  document.querySelectorAll('form[data-upload-form]').forEach((form) => {
    let prepared = false;
    form.addEventListener('submit', async (e) => {
      if (prepared) return;
      const input = form.querySelector('input[type="file"]');
      const btn = form.querySelector('button[type="submit"]');
      const file = input && input.files ? input.files[0] : null;
      const worth = file && /^image\/(jpeg|png|webp)$/i.test(file.type) && file.size >= 350 * 1024;

      const mark = () => {
        if (btn) { btn.dataset.label = btn.textContent; btn.textContent = 'Menyimpan…'; btn.disabled = true; }
      };

      if (!worth) { mark(); return; }

      e.preventDefault();
      if (btn) { btn.dataset.label = btn.textContent; btn.textContent = 'Mengoptimalkan gambar…'; btn.disabled = true; }
      const optimized = await optimizeImage(file);
      try {
        const dt = new DataTransfer();
        dt.items.add(optimized);
        input.files = dt.files;
      } catch (err) { /* keep original */ }
      prepared = true;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Simpan'; }
      window.setTimeout(() => {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }, 0);
    });
  });

  /* ---------------- duration editor (add / remove rows) ---------------- */
  document.querySelectorAll('[data-duration-form]').forEach((form) => {
    const editor = form.querySelector('[data-duration-editor]');
    const hidden = form.querySelector('#duration_rows');
    const template = form.querySelector('#duration-row-template');
    if (!editor || !hidden || !template) return;

    const reindex = () => {
      const rows = Array.from(editor.querySelectorAll('[data-duration-row]'));
      rows.forEach((row, i) => {
        row.querySelectorAll('input, select').forEach((el) => {
          if (el.name) el.name = el.name.replace(/dur_(min|price|note|active)_\d+/, 'dur_$1_' + i);
        });
      });
      hidden.value = String(rows.length);
    };

    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-duration]');
      const remove = e.target.closest('[data-remove-duration]');
      if (add) {
        const idx = editor.querySelectorAll('[data-duration-row]').length;
        const html = template.innerHTML.replace(/__IDX__/g, String(idx));
        const wrap = document.createElement('div');
        wrap.innerHTML = html.trim();
        const row = wrap.firstElementChild;
        editor.appendChild(row);
        reindex();
        const minutes = row.querySelector('input[type="number"]');
        if (minutes) minutes.focus();
      }
      if (remove) {
        const rows = editor.querySelectorAll('[data-duration-row]');
        if (rows.length <= 1) {
          window.alert('Paket sebaiknya memiliki minimal satu pilihan durasi.');
          return;
        }
        remove.closest('[data-duration-row]').remove();
        reindex();
      }
    });

    reindex();
  });

  /* ---------------- benefit editor (add / remove rows + icon picker) ---------------- */
  document.querySelectorAll('[data-benefit-editor]').forEach((editor) => {
    const form = editor.closest('form');
    const hidden = form && form.querySelector('#benefit_rows');
    const template = form && form.querySelector('#benefit-row-template');
    if (!form || !hidden || !template) return;
    const emptyHint = form.querySelector('[data-benefit-empty]');

    const reindex = () => {
      const rows = Array.from(editor.querySelectorAll('[data-benefit-row]'));
      rows.forEach((row, i) => {
        row.querySelectorAll('input').forEach((el) => {
          if (!el.name) return;
          el.name = el.name.replace(/benefit_(id|text|order|active|icon)_\d+/, 'benefit_$1_' + i);
        });
      });
      hidden.value = String(rows.length);
      if (emptyHint) emptyHint.hidden = rows.length > 0;
    };

    // Show the chosen icon + its name in the <summary>, then close the picker.
    const syncSummary = (row) => {
      const checked = row.querySelector('.icon-picker input:checked');
      if (!checked) return;
      const cur = row.querySelector('[data-icon-current]');
      const label = row.querySelector('[data-icon-label]');
      const box = checked.parentElement.querySelector('.icon-picker__box');
      if (cur && box) cur.innerHTML = box.innerHTML;
      if (label) label.textContent = checked.dataset.iconLabel || checked.value;
      const details = row.querySelector('.icon-picker');
      if (details) details.open = false;
    };

    editor.querySelectorAll('[data-benefit-row]').forEach(syncSummary);

    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-benefit]');
      const remove = e.target.closest('[data-remove-benefit]');
      if (add) {
        const idx = editor.querySelectorAll('[data-benefit-row]').length;
        const html = template.innerHTML.replace(/__IDX__/g, String(idx));
        const wrap = document.createElement('div');
        wrap.innerHTML = html.trim();
        const row = wrap.firstElementChild;
        editor.appendChild(row);
        const maxOrder = Array.from(editor.querySelectorAll('[data-benefit-row]')).length - 1;
        const orderInput = row.querySelector('input[name^="benefit_order_"]');
        if (orderInput) orderInput.value = String(maxOrder);
        reindex();
        syncSummary(row);
        const text = row.querySelector('input[name^="benefit_text_"]');
        if (text) text.focus();
      }
      if (remove) {
        remove.closest('[data-benefit-row]').remove();
        reindex();
      }
    });

    form.addEventListener('change', (e) => {
      if (e.target.matches('.icon-picker input[type="radio"]')) {
        syncSummary(e.target.closest('[data-benefit-row]'));
      }
    });

    reindex();
  });

  /* ---------------- drag & drop ordering ---------------- */
  document.querySelectorAll('[data-reorder-list]').forEach((list) => {
    const type = list.dataset.reorderType;
    const items = () => Array.from(list.querySelectorAll('[data-reorder-item]'));
    let dragged = null;

    items().forEach((item) => {
      const handle = item.querySelector('.drag-handle');
      if (!handle) return;

      handle.addEventListener('dragstart', (e) => {
        dragged = item;
        item.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.dataset.id || '');
        }
      });
      handle.addEventListener('dragend', () => {
        item.classList.remove('is-dragging');
        items().forEach((i) => i.classList.remove('is-drop-target'));
        dragged = null;
      });
      // allow dropping onto the card body as well
      item.addEventListener('dragover', (e) => {
        if (!dragged || dragged === item) return;
        e.preventDefault();
        item.classList.add('is-drop-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('is-drop-target'));
      item.addEventListener('drop', (e) => {
        if (!dragged || dragged === item) return;
        e.preventDefault();
        item.classList.remove('is-drop-target');
        const rect = item.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        list.insertBefore(dragged, after ? item.nextSibling : item);
        persist();
      });
    });

    let timer = null;
    function persist() {
      const ids = items().map((i) => Number(i.dataset.id)).filter(Boolean);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fetch(document.body.dataset.base ? document.body.dataset.base + '/admin/reorder' : '/admin/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ type, ids })
        }).then((r) => r.json())
          .then((data) => {
            if (!data.ok) return;
            items().forEach((it, idx) => {
              const badge = it.querySelector('.hero-row__index');
              if (badge) badge.textContent = String(idx + 1).padStart(2, '0');
            });
            const state = document.querySelector('.publish-bar__state');
            if (state && data.pending && data.pending.total > 0) {
              state.textContent = data.pending.total + ' perubahan belum dipublikasi';
              state.classList.add('publish-bar__state--draft');
            }
          })
          .catch(() => {});
      }, 250);
    }
  });

  /* ---------------- disable double submit on plain form posts ---------------- */
  document.querySelectorAll('form.admin-form:not([data-upload-form])').forEach((form) => {
    form.addEventListener('submit', () => {
      const btn = form.querySelector('button[type="submit"]');
      if (btn && !btn.disabled) {
        btn.dataset.label = btn.textContent;
        btn.textContent = 'Menyimpan…';
        btn.disabled = true;
        window.setTimeout(() => {
          btn.disabled = false;
          btn.textContent = btn.dataset.label || 'Simpan';
        }, 4000);
      }
    });
  });
})();

/* ==========================================================================
   V6 — dashboard interactions: sidebar collapse, count-up, toast,
   unsaved-changes guard, page enter animation.
   ========================================================================== */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- sidebar collapse (desktop, remembered) ---------- */
  const collapseBtn = document.querySelector('[data-side-collapse]');
  const COLLAPSE_KEY = 'dly.admin.sideCollapsed';
  const applyCollapsed = (on) => {
    document.body.classList.toggle('side-collapsed', on);
    if (collapseBtn) {
      collapseBtn.setAttribute('aria-label', on ? 'Bentangkan sidebar' : 'Ciutkan sidebar');
      const icon = collapseBtn.querySelector('[data-collapse-icon]');
      if (icon) icon.textContent = on ? '\u00BB' : '\u00AB\u00AB';
    }
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { /* ignore */ }
  applyCollapsed(collapsed);
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      collapsed = !document.body.classList.contains('side-collapsed');
      applyCollapsed(collapsed);
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
    });
  }

  /* ---------- toast ---------- */
  const toastEl = document.querySelector('[data-toast]');
  let toastTimer = null;
  window.adminToast = function (message, kind) {
    if (!toastEl || !message) return;
    toastEl.textContent = message;
    toastEl.className = 'admin-toast is-visible' + (kind === 'err' ? ' admin-toast--err' : kind === 'ok' ? ' admin-toast--ok' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.classList.remove('is-visible'); }, 4200);
  };
  // auto-surface flash messages as toasts too
  document.querySelectorAll('.admin-flash').forEach((el) => {
    const isErr = el.classList.contains('admin-flash--err');
    if (el.textContent.trim()) window.adminToast(el.textContent.trim().slice(0, 220), isErr ? 'err' : 'ok');
  });

  /* ---------- count-up for stat values ---------- */
  function animateCount(el) {
    const raw = el.getAttribute('data-count');
    if (raw === null) return;
    const target = Number(raw);
    if (!Number.isFinite(target)) return;
    const prefix = el.getAttribute('data-prefix') || '';
    const suffix = el.getAttribute('data-suffix') || '';
    const format = (n) => prefix + Math.round(n).toLocaleString('id-ID') + suffix;
    if (reduce) { el.textContent = format(target); return; }
    const duration = 1500;
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(target * eased);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length) {
    if (!('IntersectionObserver' in window)) counters.forEach(animateCount);
    else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          animateCount(e.target);
          io.unobserve(e.target);
        });
      }, { threshold: 0.3 });
      counters.forEach((c) => io.observe(c));
    }
  }

  /* ---------- unsaved changes guard ---------- */
  document.querySelectorAll('form.admin-form').forEach((form) => {
    let dirty = false;
    const markDirty = () => { dirty = true; };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    form.addEventListener('submit', () => { dirty = false; });
    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  });

  /* ---------- copy-to-clipboard (portal link etc.) ---------- */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    const value = btn.getAttribute('data-copy') || btn.dataset.copyValue || '';
    if (!value) return;
    const done = () => {
      if (window.adminToast) window.adminToast('Link disalin ke clipboard.', 'ok');
      const original = btn.textContent;
      btn.textContent = 'Tersalin ✓';
      setTimeout(() => { btn.textContent = original; }, 1800);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) {
        if (window.adminToast) window.adminToast('Gagal menyalin. Salin link secara manual.', 'err');
      }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(fallback);
    } else {
      fallback();
    }
  });

  /* ---------- dropdown / tab micro-interaction ---------- */
  document.querySelectorAll('.filter-pills--admin .pill, .admin-nav a').forEach((el) => {
    el.addEventListener('click', () => {
      if (reduce) return;
      el.style.transform = 'scale(.97)';
      setTimeout(() => { el.style.transform = ''; }, 130);
    });
  });
})();

/* ==========================================================================
   Tahap 3 — Kelola Booking: view preference + kanban drag & drop
   ========================================================================== */
(function () {
  'use strict';
  var VIEW_KEY = 'dly.admin.bookingView';

  /* Remember the last view so returning to the page keeps it. */
  var viewLinks = document.querySelectorAll('[data-view-link]');
  viewLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      try { localStorage.setItem(VIEW_KEY, link.getAttribute('data-view-link')); } catch (e) { /* ignore */ }
    });
  });
  // Visiting a view by URL also remembers it (deep links, bookmarks, back button).
  var explicit = new URLSearchParams(location.search).get('view');
  if (explicit) {
    try { localStorage.setItem(VIEW_KEY, explicit); } catch (e) { /* ignore */ }
  }
  // If the URL carries no explicit view, jump straight to the remembered one.
  if (viewLinks.length && !explicit) {
    var saved = '';
    try { saved = localStorage.getItem(VIEW_KEY) || ''; } catch (e) { saved = ''; }
    if (saved) {
      var target = Array.from(viewLinks).find(function (l) { return l.getAttribute('data-view-link') === saved; });
      if (target && !target.classList.contains('is-active')) {
        var url = new URL(target.href, location.origin);
        location.replace(url.toString());
        return;
      }
    }
  }

  /* Auto-submit filter selects (date/select) so filters combine without extra clicks. */
  document.querySelectorAll('form[data-auto-filter]').forEach(function (form) {
    form.querySelectorAll('select, input[type="date"]').forEach(function (field) {
      field.addEventListener('change', function () {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      });
    });
  });

  /* Kanban drag & drop — the server validates and records every move. */
  var board = document.querySelector('[data-kanban]');
  if (!board) return;
  var csrf = board.getAttribute('data-csrf') || '';
  var base = board.getAttribute('data-base') || '';
  var dragged = null;

  function toast(message, isErr) {
    if (window.adminToast) window.adminToast(message, isErr ? 'err' : 'ok');
  }

  function countIn(col) {
    var badge = col.querySelector('[data-col-count]');
    if (!badge) return;
    var n = col.querySelectorAll('.kb-kcard').length;
    badge.textContent = String(n);
    var empty = col.querySelector('.kb-col__empty');
    if (empty) empty.hidden = n > 0;
  }

  board.addEventListener('dragstart', function (e) {
    var card = e.target.closest('.kb-kcard');
    if (!card) return;
    dragged = card;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.getAttribute('data-booking-id')); } catch (err) { /* ignore */ }
  });

  board.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('is-dragging');
    board.querySelectorAll('.kb-col').forEach(function (c) { c.classList.remove('is-drop-target'); });
    dragged = null;
  });

  board.querySelectorAll('.kb-col').forEach(function (col) {
    col.addEventListener('dragover', function (e) {
      if (!dragged) return;
      if (col.getAttribute('data-col') === dragged.getAttribute('data-status')) return;
      e.preventDefault();
      col.classList.add('is-drop-target');
    });
    col.addEventListener('dragleave', function (e) {
      if (col.contains(e.relatedTarget)) return;
      col.classList.remove('is-drop-target');
    });
    col.addEventListener('drop', function (e) {
      e.preventDefault();
      col.classList.remove('is-drop-target');
      if (!dragged) return;

      var card = dragged;
      var bookingId = card.getAttribute('data-booking-id');
      var fromStatus = card.getAttribute('data-status');
      var toStatus = col.getAttribute('data-col');
      if (!bookingId || !toStatus || fromStatus === toStatus) return;

      var fromCol = card.closest('.kb-col');
      var body = col.querySelector('[data-col-body]');
      if (!body) return;

      // Optimistic move; rolled back if the server refuses.
      body.insertBefore(card, body.querySelector('.kb-col__empty'));
      card.setAttribute('data-status', toStatus);
      if (fromCol) countIn(fromCol);
      countIn(col);

      fetch(base + '/admin/bookings/' + bookingId + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-csrf-token': csrf },
        credentials: 'same-origin',
        body: JSON.stringify({ status: toStatus })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      }).then(function (result) {
        if (!result.ok || !result.data.ok) {
          // Put it back where it came from.
          var back = fromCol && fromCol.querySelector('[data-col-body]');
          if (back) back.insertBefore(card, back.querySelector('.kb-col__empty'));
          card.setAttribute('data-status', fromStatus);
          if (fromCol) countIn(fromCol);
          countIn(col);
          toast(result.data.message || 'Status gagal diubah.', true);
          return;
        }
        toast('Status ' + result.data.code + ' → ' + result.data.status, false);
      }).catch(function () {
        var back = fromCol && fromCol.querySelector('[data-col-body]');
        if (back) back.insertBefore(card, back.querySelector('.kb-col__empty'));
        card.setAttribute('data-status', fromStatus);
        if (fromCol) countIn(fromCol);
        countIn(col);
        toast('Koneksi bermasalah, status belum berubah.', true);
      });
    });
  });
})();

/* ==========================================================================
   Tahap 5 — Antrean Editing: drag & drop between the three stages
   ========================================================================== */
(function () {
  'use strict';
  var board = document.querySelector('[data-editing-board]');
  if (!board) return;

  var csrf = board.getAttribute('data-csrf') || '';
  var base = board.getAttribute('data-base') || '';
  var dragged = null;

  function toast(message, isErr) {
    if (window.adminToast) window.adminToast(message, isErr ? 'err' : 'ok');
  }

  function countIn(col) {
    var badge = col.querySelector('[data-col-count]');
    if (!badge) return;
    badge.textContent = String(col.querySelectorAll('.ed-card').length);
    var empty = col.querySelector('.ed-col__empty');
    if (empty) empty.hidden = col.querySelectorAll('.ed-card').length > 0;
  }

  board.querySelectorAll('.ed-col').forEach(function (col) {
    var empty = col.querySelector('.ed-col__empty');
    if (empty) empty.hidden = col.querySelectorAll('.ed-card').length > 0;
  });

  board.addEventListener('dragstart', function (e) {
    var card = e.target.closest('.ed-card');
    if (!card) return;
    dragged = card;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.getAttribute('data-job-id')); } catch (err) { /* ignore */ }
  });

  board.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('is-dragging');
    board.querySelectorAll('.ed-col').forEach(function (c) { c.classList.remove('is-drop-target'); });
    dragged = null;
  });

  board.querySelectorAll('.ed-col').forEach(function (col) {
    col.addEventListener('dragover', function (e) {
      if (!dragged) return;
      if (col.getAttribute('data-col') === dragged.getAttribute('data-status')) return;
      e.preventDefault();
      col.classList.add('is-drop-target');
    });
    col.addEventListener('dragleave', function (e) {
      if (col.contains(e.relatedTarget)) return;
      col.classList.remove('is-drop-target');
    });
    col.addEventListener('drop', function (e) {
      e.preventDefault();
      col.classList.remove('is-drop-target');
      if (!dragged) return;

      var card = dragged;
      var jobId = card.getAttribute('data-job-id');
      var fromStatus = card.getAttribute('data-status');
      var toStatus = col.getAttribute('data-col');
      if (!jobId || !toStatus || fromStatus === toStatus) return;

      var fromCol = card.closest('.ed-col');
      var body = col.querySelector('[data-col-body]');
      if (!body) return;

      // Optimistic move; rolled back when the server refuses.
      body.insertBefore(card, body.querySelector('.ed-col__empty'));
      card.setAttribute('data-status', toStatus);
      if (fromCol) countIn(fromCol);
      countIn(col);

      fetch(base + '/admin/editing/' + jobId + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-csrf-token': csrf },
        credentials: 'same-origin',
        body: JSON.stringify({ status: toStatus })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      }).then(function (result) {
        if (!result.ok || !result.data.ok) {
          var back = fromCol && fromCol.querySelector('[data-col-body]');
          if (back) back.insertBefore(card, back.querySelector('.ed-col__empty'));
          card.setAttribute('data-status', fromStatus);
          if (fromCol) countIn(fromCol);
          countIn(col);
          toast(result.data.message || 'Tahap editing gagal diubah.', true);
          return;
        }
        toast('Tahap ' + result.data.code + ' → ' + result.data.label, false);
      }).catch(function () {
        var back = fromCol && fromCol.querySelector('[data-col-body]');
        if (back) back.insertBefore(card, back.querySelector('.ed-col__empty'));
        card.setAttribute('data-status', fromStatus);
        if (fromCol) countIn(fromCol);
        countIn(col);
        toast('Koneksi bermasalah, tahap belum berubah.', true);
      });
    });
  });
})();

/* ==========================================================================
   Tahap 7 — booking operations UI
   - confirmation summary before confirming a booking
   - team badges (visual only; the form posts the checkboxes)
   - reschedule panel + old/new summary
   - manual payment form toggle
   ========================================================================== */
(function () {
  'use strict';

  function toast(msg, isErr) { if (window.adminToast) window.adminToast(msg, isErr ? 'err' : 'ok'); }

  /* ---------- confirmation summary ---------- */
  var confirmForm = document.querySelector('[data-confirm-summary]');
  if (confirmForm) {
    confirmForm.addEventListener('submit', function (e) {
      var btn = confirmForm.querySelector('[data-confirm-btn]');
      // Guard against double clicks (the server is idempotent, this is just UX).
      if (confirmForm.getAttribute('data-busy') === '1') { e.preventDefault(); return; }
      var raw = confirmForm.getAttribute('data-summary') || '{}';
      var s = {};
      try { s = JSON.parse(raw); } catch (err) { s = {}; }
      var lines = [
        'Konfirmasi booking ini?',
        '',
        'Client    : ' + (s.client || '-'),
        'Jadwal    : ' + (s.jadwal || '-'),
        'Lokasi    : ' + (s.lokasi || '-'),
        'Paket     : ' + (s.paket || '-'),
        'Tim       : ' + (s.tim || '-'),
        '',
        'Sistem akan membuat event Google Calendar + folder Google Drive dan mengirim undangan ke tim.'
      ];
      if (!window.confirm(lines.join('\n'))) { e.preventDefault(); return; }
      confirmForm.setAttribute('data-busy', '1');
      if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
    });
  }

  /* ---------- manual payment form ---------- */
  var toggle = document.querySelector('[data-toggle-manual-pay]');
  var manual = document.querySelector('[data-manual-pay]');
  if (toggle && manual) {
    toggle.addEventListener('click', function () {
      manual.hidden = !manual.hidden;
      toggle.textContent = manual.hidden ? 'Input nominal manual' : 'Tutup input manual';
      if (!manual.hidden) {
        var amount = manual.querySelector('input[name="amount"]');
        if (amount) amount.focus();
      }
    });
  }

  /* ---------- reschedule panel ---------- */
  var openBtn = document.querySelector('[data-toggle-reschedule]');
  var panel = document.querySelector('[data-reschedule-panel]');
  var cancelBtn = document.querySelector('[data-cancel-reschedule]');
  if (openBtn && panel) {
    openBtn.addEventListener('click', function () {
      panel.hidden = false;
      openBtn.hidden = true;
      var date = panel.querySelector('input[name="shooting_date"]');
      if (date && date.showPicker) { try { date.focus(); } catch (e) {} }
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  if (cancelBtn && panel) {
    cancelBtn.addEventListener('click', function () {
      panel.hidden = true;
      if (openBtn) openBtn.hidden = false;
    });
  }

  var rsForm = document.querySelector('[data-reschedule-form]');
  if (rsForm) {
    rsForm.addEventListener('submit', function (e) {
      if (rsForm.getAttribute('data-busy') === '1') { e.preventDefault(); return; }
      var old = {};
      try { old = JSON.parse(rsForm.getAttribute('data-old') || '{}'); } catch (err) { old = {}; }
      var dateVal = (rsForm.querySelector('input[name="shooting_date"]') || {}).value || '';
      var timeVal = (rsForm.querySelector('input[name="shooting_time"]') || {}).value || '';
      var locVal = (rsForm.querySelector('input[name="location"]') || {}).value || '';
      if (!dateVal || !timeVal || !locVal) return; // native validation handles it

      var dateLabel = dateVal;
      try {
        dateLabel = new Date(dateVal + 'T00:00:00').toLocaleDateString('id-ID', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });
      } catch (err) { /* keep ISO */ }

      var lines = [
        'Simpan perubahan jadwal?',
        '',
        'SEBELUMNYA',
        '  ' + (old.tanggal || '-') + ' · ' + (old.jam || '-') + ' WIB',
        '  ' + (old.lokasi || '-'),
        '',
        'JADWAL BARU',
        '  ' + dateLabel + ' · ' + timeVal + ' WIB',
        '  ' + locVal,
        '',
        'Harga, pembayaran, kode booking, folder Drive, dan portal seleksi tidak berubah.'
      ];
      if (!window.confirm(lines.join('\n'))) { e.preventDefault(); return; }
      rsForm.setAttribute('data-busy', '1');
      var submit = rsForm.querySelector('button[type="submit"]');
      if (submit) { submit.disabled = true; submit.textContent = 'Menyimpan…'; }
    });
  }
})();

/* ==========================================================================
   Tahap 7 — availability day panel (Tersedia / Full / Ditutup)
   ========================================================================== */
(function () {
  'use strict';
  var panel = document.querySelector('[data-avail-panel]');
  if (!panel) return;
  var dateInput = panel.querySelector('[data-avail-date]');
  var title = panel.querySelector('[data-avail-title]');
  var info = panel.querySelector('[data-avail-info]');
  var note = panel.querySelector('[data-avail-note]');
  var closeBtn = panel.querySelector('[data-avail-close]');

  var LABEL = { open: 'Tersedia', full: 'Full Booking (kapasitas)', 'full-manual': 'Full Booking (manual)', closed: 'Ditutup', past: 'Sudah lewat' };

  document.querySelectorAll('[data-avail-day]').forEach(function (cell) {
    cell.addEventListener('click', function () {
      if (cell.disabled) return;
      var iso = cell.getAttribute('data-avail-day');
      var status = cell.getAttribute('data-avail-status');
      var booked = cell.getAttribute('data-avail-booked') || '0';
      dateInput.value = iso;
      title.textContent = cell.getAttribute('data-avail-label') || iso;
      info.textContent = 'Status saat ini: ' + (LABEL[status] || status) + ' · ' + booked + ' booking pada tanggal ini.';
      note.value = cell.getAttribute('data-avail-note') || '';
      panel.hidden = false;
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      document.querySelectorAll('.avail-cell.is-selected').forEach(function (c) { c.classList.remove('is-selected'); });
      cell.classList.add('is-selected');
      if (note.focus) note.focus();
    });
  });
  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      panel.hidden = true;
      document.querySelectorAll('.avail-cell.is-selected').forEach(function (c) { c.classList.remove('is-selected'); });
    });
  }
})();

/* ==========================================================================
   Tahap 7 — Portfolio: multi-file preview + drag & drop ordering
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- multi-file preview ---------- */
  var form = document.querySelector('[data-multi-upload]');
  if (form) {
    var input = form.querySelector('[data-file-input]');
    var preview = form.querySelector('[data-preview]');
    var submit = form.querySelector('[data-upload-submit]');
    var clearBtn = form.querySelector('[data-upload-clear]');
    var status = form.querySelector('[data-upload-status]');
    var progress = form.querySelector('[data-progress]');
    var bar = form.querySelector('[data-progress-bar]');
    var drop = form.querySelector('[data-drop]');
    var chosen = [];
    var MAX_FILES = 20;
    var MAX_BYTES = 10 * 1024 * 1024;
    var ALLOWED = /^image\/(jpeg|png|webp|gif)$/i;

    function human(bytes) {
      if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      return Math.round(bytes / 1024) + ' KB';
    }

    function paint() {
      if (!preview) return;
      preview.innerHTML = '';
      chosen.forEach(function (file, i) {
        var li = document.createElement('li');
        li.className = 'pf-preview__item';
        var img = document.createElement('img');
        img.alt = '';
        img.src = URL.createObjectURL(file);
        var meta = document.createElement('span');
        meta.className = 'pf-preview__meta';
        meta.innerHTML = '<strong></strong><small></small>';
        meta.querySelector('strong').textContent = file.name;
        meta.querySelector('small').textContent = human(file.size);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'pf-preview__x';
        del.setAttribute('aria-label', 'Batalkan ' + file.name);
        del.textContent = '×';
        del.addEventListener('click', function () {
          chosen.splice(i, 1);
          sync();
        });
        li.appendChild(img);
        li.appendChild(meta);
        li.appendChild(del);
        preview.appendChild(li);
      });
      preview.hidden = !chosen.length;
    }

    function sync() {
      // Rebuild the FileList so the form posts exactly what is previewed.
      var dt = new DataTransfer();
      chosen.forEach(function (f) { dt.items.add(f); });
      try { input.files = dt.files; } catch (e) { /* older browsers: keep original list */ }
      paint();
      if (submit) submit.disabled = !chosen.length;
      if (clearBtn) clearBtn.hidden = !chosen.length;
      if (status && !chosen.length) status.textContent = '';
    }

    function accept(list) {
      var files = Array.from(list || []);
      var rejected = 0;
      files.forEach(function (f) {
        if (!ALLOWED.test(f.type) || f.size > MAX_BYTES) { rejected += 1; return; }
        // No name-based de-duplication: two different files can legitimately share a name
        // (different folders), and the admin can always remove one from the preview.
        chosen.push(f);
      });
      if (chosen.length > MAX_FILES) chosen = chosen.slice(0, MAX_FILES);
      if (status) {
        status.textContent = rejected
          ? rejected + ' file dilewati (tipe tidak didukung atau lebih dari 10MB).'
          : chosen.length + ' foto siap diunggah.';
        status.className = 'pf-upload__status' + (rejected ? ' is-warn' : '');
      }
      sync();
    }

    input.addEventListener('change', function () { accept(input.files); });
    if (clearBtn) clearBtn.addEventListener('click', function () { chosen = []; sync(); });

    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
      });
      drop.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) accept(e.dataTransfer.files);
      });
    }

    // Real upload progress (XHR) instead of a plain form post.
    form.addEventListener('submit', function (e) {
      if (!chosen.length) { e.preventDefault(); return; }
      e.preventDefault();
      var data = new FormData(form);
      data.delete('photo_files');
      chosen.forEach(function (f) { data.append('photo_files', f); });
      var xhr = new XMLHttpRequest();
      xhr.open('POST', form.action, true);
      xhr.withCredentials = true;
      if (progress) { progress.hidden = false; }
      if (submit) { submit.disabled = true; submit.textContent = 'Mengunggah…'; }
      xhr.upload.addEventListener('progress', function (ev) {
        if (!ev.lengthComputable || !bar) return;
        bar.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
      });
      xhr.addEventListener('load', function () {
        if (xhr.status >= 200 && xhr.status < 400) {
          window.location.href = xhr.responseURL || window.location.href;
        } else {
          if (status) { status.textContent = 'Unggahan gagal (status ' + xhr.status + '). Coba lagi.'; status.className = 'pf-upload__status is-err'; }
          if (submit) { submit.disabled = false; submit.textContent = 'Unggah ke galeri'; }
          if (progress) progress.hidden = true;
        }
      });
      xhr.addEventListener('error', function () {
        if (status) { status.textContent = 'Koneksi bermasalah saat mengunggah.'; status.className = 'pf-upload__status is-err'; }
        if (submit) { submit.disabled = false; submit.textContent = 'Unggah ke galeri'; }
        if (progress) progress.hidden = true;
      });
      xhr.send(data);
    });
  }

  /* ---------- gallery ordering ---------- */
  var grid = document.querySelector('[data-photo-order]');
  if (!grid) return;
  var orderStatus = document.querySelector('[data-order-status]');
  var dragging = null;

  function ids() {
    return Array.from(grid.querySelectorAll('[data-photo-id]')).map(function (el) { return el.getAttribute('data-photo-id'); });
  }
  function renumber() {
    Array.from(grid.querySelectorAll('[data-photo-id]')).forEach(function (el, i) {
      var num = el.querySelector('.pf-photo__num');
      if (num) num.textContent = String(i + 1);
    });
  }
  function save() {
    var body = new URLSearchParams();
    body.set('order', ids().join(','));
    if (orderStatus) { orderStatus.textContent = 'Menyimpan urutan…'; orderStatus.className = 'admin-hint pf-order-status'; }
    fetch(grid.getAttribute('data-base') ? grid.getAttribute('data-base') + '/admin/portfolio/' + grid.getAttribute('data-portfolio') + '/photos/reorder'
      : '/admin/portfolio/' + grid.getAttribute('data-portfolio') + '/photos/reorder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-csrf-token': grid.getAttribute('data-csrf') || '',
        accept: 'application/json'
      },
      credentials: 'same-origin',
      body: body.toString()
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (orderStatus) {
          orderStatus.textContent = data && data.ok ? 'Urutan tersimpan — halaman publik mengikuti urutan ini.' : 'Gagal menyimpan urutan.';
          orderStatus.className = 'admin-hint pf-order-status' + (data && data.ok ? ' is-ok' : ' is-err');
        }
      })
      .catch(function () {
        if (orderStatus) { orderStatus.textContent = 'Gagal menyimpan urutan (koneksi).'; orderStatus.className = 'admin-hint pf-order-status is-err'; }
      });
  }

  grid.addEventListener('dragstart', function (e) {
    var card = e.target.closest('[data-photo-id]');
    if (!card) return;
    dragging = card;
    card.classList.add('is-dragging');
    try { e.dataTransfer.setData('text/plain', card.getAttribute('data-photo-id')); } catch (err) {}
    e.dataTransfer.effectAllowed = 'move';
  });
  grid.addEventListener('dragend', function () {
    if (dragging) dragging.classList.remove('is-dragging');
    grid.querySelectorAll('.is-over').forEach(function (el) { el.classList.remove('is-over'); });
    dragging = null;
  });
  grid.addEventListener('dragover', function (e) {
    if (!dragging) return;
    e.preventDefault();
    var card = e.target.closest('[data-photo-id]');
    grid.querySelectorAll('.is-over').forEach(function (el) { if (el !== card) el.classList.remove('is-over'); });
    if (card && card !== dragging) card.classList.add('is-over');
  });
  grid.addEventListener('drop', function (e) {
    if (!dragging) return;
    e.preventDefault();
    var card = e.target.closest('[data-photo-id]');
    if (card && card !== dragging) {
      var rect = card.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      grid.insertBefore(dragging, after ? card.nextSibling : card);
      renumber();
      save();
    }
    grid.querySelectorAll('.is-over').forEach(function (el) { el.classList.remove('is-over'); });
  });
  grid.querySelectorAll('[data-move]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var card = btn.closest('[data-photo-id]');
      var dir = Number(btn.getAttribute('data-move'));
      var sibling = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
      if (!sibling) return;
      if (dir < 0) grid.insertBefore(card, sibling);
      else grid.insertBefore(sibling, card);
      renumber();
      save();
    });
  });
})();

/* ==========================================================================
   Revisi Tahap 7 — tim tersimpan otomatis saat dropdown diganti
   (tidak ada tombol "Simpan tim" terpisah)
   ========================================================================== */
(function () {
  'use strict';
  var form = document.querySelector('[data-auto-submit-team]');
  if (!form) return;
  var select = form.querySelector('[data-team-select]');
  var hint = form.querySelector('[data-team-save-hint]');
  if (select) {
    select.addEventListener('change', function () {
      if (hint) hint.textContent = 'Menyimpan…';
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    });
  }
})();

/* ==========================================================================
   Tambah client manual — durasi mengikuti paket, harga terisi otomatis
   (dari data paket yang dirender server; tidak ada permintaan jaringan)
   ========================================================================== */
(function () {
  'use strict';
  var form = document.querySelector('[data-manual-booking]');
  if (!form) return;
  var pkgSelect = form.querySelector('[data-manual-package]');
  var durSelect = form.querySelector('[data-manual-duration]');
  var priceInput = form.querySelector('#price');
  if (!pkgSelect || !durSelect) return;

  var formatRp = function (n) {
    var num = Number(n);
    if (!num) return '';
    return 'Rp ' + num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };

  var fillDurations = function () {
    var option = pkgSelect.options[pkgSelect.selectedIndex];
    var list = [];
    try { list = JSON.parse(option.getAttribute('data-durations') || '[]'); } catch (e) { list = []; }
    var previous = durSelect.value;
    durSelect.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = option.value ? 'Durasi belum diatur admin' : '— Pilih paket dulu —';
      durSelect.appendChild(empty);
      return;
    }
    list.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = String(d.duration_minutes);
      opt.setAttribute('data-price', d.price || '');
      opt.textContent = d.duration_minutes + ' menit'
        + (d.price ? ' — ' + formatRp(d.price) : ' — harga belum diatur')
        + (d.edited_photos ? ' · ' + d.edited_photos + ' foto edit' : '');
      durSelect.appendChild(opt);
    });
    var stillThere = list.some(function (d) { return String(d.duration_minutes) === previous; });
    if (stillThere) durSelect.value = previous;
    else if (list.length === 1) durSelect.value = String(list[0].duration_minutes);
  };

  var fillPrice = function () {
    if (!priceInput) return;
    var option = durSelect.options[durSelect.selectedIndex];
    var price = option ? option.getAttribute('data-price') : '';
    if (price) priceInput.value = price;
  };

  pkgSelect.addEventListener('change', function () {
    fillDurations();
    fillPrice();
  });
  durSelect.addEventListener('change', fillPrice);
})();
