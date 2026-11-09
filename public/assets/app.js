/* DLY Graduation — public interactions */
(function () {
  'use strict';

  const base = (document.body.dataset.base || '').replace(/\/$/, '');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rupiah = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');
  const pad = (n) => String(n).padStart(2, '0');

  /* ==================================================================
     Header
     ================================================================== */
  const header = document.querySelector('[data-header]');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ==================================================================
     Mobile dropdown menu (Tahap 6)
     Animated open/close: the panel is revealed with a class, and `hidden`
     is only restored AFTER the closing transition, so it never "snaps".
     ================================================================== */
  const navToggle = document.querySelector('[data-nav-toggle]');
  const mobileNav = document.querySelector('[data-mobile-nav]');
  const navBackdrop = document.querySelector('[data-mobile-backdrop]');
  if (navToggle && mobileNav) {
    const CLOSE_MS = 240;
    let closeTimer = null;

    const setMenu = (open) => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Tutup menu' : 'Buka menu');
      document.body.classList.toggle('nav-open', open);

      if (open) {
        mobileNav.hidden = false;
        if (navBackdrop) navBackdrop.hidden = false;
        // Next frame so the transition has a starting state to animate from.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          mobileNav.classList.add('is-open');
          if (navBackdrop) navBackdrop.classList.add('is-open');
        }));
      } else {
        mobileNav.classList.remove('is-open');
        if (navBackdrop) navBackdrop.classList.remove('is-open');
        closeTimer = setTimeout(() => {
          if (!mobileNav.classList.contains('is-open')) mobileNav.hidden = true;
          if (navBackdrop && !navBackdrop.classList.contains('is-open')) navBackdrop.hidden = true;
          closeTimer = null;
        }, CLOSE_MS);
      }
    };

    navToggle.addEventListener('click', () => {
      setMenu(navToggle.getAttribute('aria-expanded') !== 'true');
    });
    mobileNav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
    if (navBackdrop) navBackdrop.addEventListener('click', () => setMenu(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') setMenu(false);
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1100 && navToggle.getAttribute('aria-expanded') === 'true') setMenu(false);
    });
  }

  /* ==================================================================
     Gallery — filter dua dropdown (Revisi 2)
     Paket & Lokasi bisa digabung; form GET langsung dikirim saat pilihan
     berubah supaya hasilnya tetap berupa URL yang bisa dibagikan/bookmark.
     ================================================================== */
  function initGalleryFilter() {
    document.querySelectorAll('[data-gallery-filter]').forEach((form) => {
      form.querySelectorAll('[data-gf-auto]').forEach((select) => {
        select.addEventListener('change', () => {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
        });
      });
    });
  }

  /* ==================================================================
     Hero slideshow — crossfade + ken burns
     ================================================================== */
  function initHero() {
    const hero = document.querySelector('[data-hero]');
    if (!hero) return;
    const slides = Array.from(hero.querySelectorAll('[data-slide]'));
    if (slides.length < 2) return;

    const dots = Array.from(hero.querySelectorAll('[data-hero-dot]'));
    const counter = hero.querySelector('[data-hero-current]');
    const toggle = hero.querySelector('[data-hero-toggle]');
    const toggleIcon = hero.querySelector('[data-hero-toggle-icon]');
    const intervalMs = Math.max(2500, Number(hero.dataset.interval) || 6000);
    let index = 0;
    let timer = null;
    let playing = hero.dataset.autoplay === '1' && !reduceMotion;
    let paused = false;

    /* V10: hero slides 2..n ship no <img> (they used to be downloaded on every visit
       even though only one is visible). The markup waits in data-picture and is injected
       shortly before the slide is shown — the crossfade still has its image ready. */
    function hydrate(slide) {
      if (!slide || slide.dataset.hydrated === '1') return;
      const tpl = slide.querySelector('template[data-hero-defer]');
      if (!tpl) return;
      const node = tpl.content.firstElementChild && tpl.content.firstElementChild.cloneNode(true);
      if (!node) return;
      // Swap the whole <picture> in so the <source type=image/webp> is honoured.
      tpl.replaceWith(tpl.content.cloneNode(true));
      const inserted = slide.querySelectorAll('[data-hero-defer]');
      inserted.forEach((n) => n.removeAttribute && n.removeAttribute('data-hero-defer'));
      slide.dataset.hydrated = '1';
    }

    function render() {
      hydrate(slides[index]);
      slides.forEach((s, i) => {
        const active = i === index;
        s.classList.toggle('is-active', active);
        s.setAttribute('aria-hidden', String(!active));
        // restart the ken-burns transform on each activation
        const img = s.querySelector('img');
        if (img) img.style.animation = 'none';
      });
      dots.forEach((d, i) => {
        d.classList.toggle('is-active', i === index);
        d.setAttribute('aria-selected', String(i === index));
      });
      if (counter) counter.textContent = pad(index + 1);
    }

    function go(next) {
      const target = (next + slides.length) % slides.length;
      hydrate(slides[target]);   // inject before it becomes visible
      index = target;
      render();
    }

    let preloadTimer = null;
    function schedule() {
      if (timer) clearInterval(timer);
      if (preloadTimer) clearTimeout(preloadTimer);
      timer = null;
      if (!playing || paused) return;
      // Fetch the next slide ~2s before it appears instead of up-front for every visit.
      preloadTimer = setTimeout(() => hydrate(slides[(index + 1) % slides.length]),
        Math.max(0, intervalMs - 2000));
      timer = setInterval(() => go(index + 1), intervalMs);
    }

    function setPlaying(value) {
      playing = value;
      if (toggle) {
        toggle.setAttribute('aria-pressed', String(!value));
        toggle.setAttribute('aria-label', value ? 'Jeda slideshow' : 'Lanjutkan slideshow');
        if (toggleIcon) toggleIcon.textContent = value ? '❙❙' : '▶';
      }
      schedule();
    }

    hero.querySelectorAll('[data-hero-prev]').forEach((b) => b.addEventListener('click', () => { go(index - 1); schedule(); }));
    hero.querySelectorAll('[data-hero-next]').forEach((b) => b.addEventListener('click', () => { go(index + 1); schedule(); }));
    dots.forEach((d) => d.addEventListener('click', () => { go(Number(d.dataset.heroDot)); schedule(); }));
    if (toggle) toggle.addEventListener('click', () => setPlaying(!playing));

    // Pause autoplay while the tab is hidden or the hero is hovered.
    document.addEventListener('visibilitychange', () => { paused = document.hidden; schedule(); });
    hero.addEventListener('mouseenter', () => { paused = true; schedule(); });
    hero.addEventListener('mouseleave', () => { paused = false; schedule(); });

    hero.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { go(index - 1); schedule(); }
      if (e.key === 'ArrowRight') { go(index + 1); schedule(); }
    });

    render();
    setPlaying(playing);
  }

  /* ==================================================================
     Portfolio carousel
     ================================================================== */
  function initCarousels() {
    document.querySelectorAll('[data-carousel]').forEach((root) => {
      const viewport = root.querySelector('[data-carousel-viewport]');
      const track = root.querySelector('[data-carousel-track]');
      const dotsWrap = root.querySelector('[data-carousel-dots]');
      const prev = document.querySelector('[data-carousel-prev]');
      const next = document.querySelector('[data-carousel-next]');
      if (!viewport || !track) return;
      const items = Array.from(track.children);
      if (!items.length) return;

      const perView = () => {
        const first = items[0].getBoundingClientRect().width || 1;
        const gap = parseFloat(getComputedStyle(track).columnGap || '14') || 14;
        return Math.max(1, Math.round((viewport.clientWidth + gap) / (first + gap)));
      };
      const pages = () => Math.max(1, Math.ceil(items.length / perView()));

      function step() {
        const first = items[0].getBoundingClientRect().width || 1;
        const gap = parseFloat(getComputedStyle(track).columnGap || '14') || 14;
        return (first + gap) * perView();
      }

      function currentPage() {
        const s = step();
        return s ? Math.round(viewport.scrollLeft / s) : 0;
      }

      function buildDots() {
        if (!dotsWrap) return;
        dotsWrap.innerHTML = '';
        for (let i = 0; i < pages(); i += 1) {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('aria-label', 'Halaman ' + (i + 1));
          b.addEventListener('click', () => {
            viewport.scrollTo({ left: i * step(), behavior: reduceMotion ? 'auto' : 'smooth' });
          });
          dotsWrap.appendChild(b);
        }
        sync();
      }

      function sync() {
        const page = currentPage();
        if (dotsWrap) {
          Array.from(dotsWrap.children).forEach((d, i) => d.classList.toggle('is-active', i === page));
        }
        const max = viewport.scrollWidth - viewport.clientWidth - 2;
        if (prev) prev.disabled = viewport.scrollLeft <= 2;
        if (next) next.disabled = viewport.scrollLeft >= max;
      }

      if (prev) prev.addEventListener('click', () => viewport.scrollBy({ left: -step(), behavior: 'smooth' }));
      if (next) next.addEventListener('click', () => viewport.scrollBy({ left: step(), behavior: 'smooth' }));
      viewport.addEventListener('scroll', () => window.requestAnimationFrame(sync), { passive: true });
      window.addEventListener('resize', buildDots);

      buildDots();

      // Optional autoplay
      if (root.dataset.autoplay === '1' && !reduceMotion) {
        const interval = Math.max(3000, Number(root.dataset.interval) || 5000);
        let hover = false;
        root.addEventListener('mouseenter', () => { hover = true; });
        root.addEventListener('mouseleave', () => { hover = false; });
        setInterval(() => {
          if (hover || document.hidden) return;
          const max = viewport.scrollWidth - viewport.clientWidth - 2;
          if (viewport.scrollLeft >= max) viewport.scrollTo({ left: 0, behavior: 'smooth' });
          else viewport.scrollBy({ left: step(), behavior: 'smooth' });
        }, interval);
      }
    });
  }

  /* ==================================================================
     Package browser: category tabs + duration chips + price
     ================================================================== */
  function initPackageBrowser() {
    document.querySelectorAll('[data-pkg-browser]').forEach((root) => {
      const city = root.dataset.city || '';
      const tabs = Array.from(root.querySelectorAll('[data-cat-tab]'));
      const panels = Array.from(root.querySelectorAll('[data-cat-panel]'));

      tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          const slug = tab.dataset.catTab;
          tabs.forEach((t) => {
            const on = t === tab;
            t.classList.toggle('is-active', on);
            t.setAttribute('aria-selected', String(on));
          });
          panels.forEach((p) => p.classList.toggle('is-active', p.dataset.catPanel === slug));
        });
      });

      root.querySelectorAll('[data-pkg-card]').forEach((card) => {
        const chips = Array.from(card.querySelectorAll('.dur-chip, .dur-card'));
        const priceEl = card.querySelector('[data-price-display]');
        const noteEl = card.querySelector('[data-price-note]');
        const cta = card.querySelector('[data-book-link]');
        const pkgId = card.dataset.packageId;

        function select(chip) {
          chips.forEach((c) => {
            const on = c === chip;
            c.classList.toggle('is-active', on);
            c.setAttribute('aria-pressed', String(on));
          });
          const minutes = Number(chip.dataset.duration);
          const price = chip.dataset.price ? Number(chip.dataset.price) : null;
          const photos = chip.dataset.photos ? Number(chip.dataset.photos) : null;

          if (priceEl) {
            priceEl.textContent = price ? rupiah(price) : 'Harga belum tersedia';
            priceEl.classList.toggle('is-empty', !price);
          }
          if (noteEl) {
            noteEl.textContent = price
              ? 'untuk ' + minutes + ' menit' + (photos ? ' · ' + photos + ' foto edit' : '')
              : 'Admin belum mengatur harga';
          }

          // photo count follows the selected duration
          const photosEl = card.querySelector('[data-photos-display]');
          const photosHint = card.querySelector('[data-photos-hint]');
          if (photosEl) {
            photosEl.textContent = photos ? photos + ' foto' : 'Belum dikonfigurasi';
          }
          if (photosHint) {
            photosHint.textContent = photos ? 'untuk durasi ' + minutes + ' menit' : '';
          }
          if (cta) {
            // Detail-page CTA: keep it always clickable, just carry the chosen duration.
            const detailSlug = card.dataset.slug || '';
            if (cta.dataset.detailLink) {
              cta.setAttribute('href', base + '/paket/' + encodeURIComponent(detailSlug) +
                '?kota=' + encodeURIComponent(city) + '&durasi=' + minutes);
            } else {
              const href = base + '/booking?kota=' + encodeURIComponent(city) +
                '&paket=' + encodeURIComponent(pkgId) + '&durasi=' + minutes;
              if (price) {
                cta.setAttribute('href', href);
                cta.classList.remove('is-disabled');
                cta.removeAttribute('aria-disabled');
              } else {
                cta.classList.add('is-disabled');
                cta.setAttribute('aria-disabled', 'true');
              }
            }
          }
        }

        chips.forEach((chip) => chip.addEventListener('click', () => select(chip)));
        // reflect the server-rendered default selection (keeps CTA/href in sync)
        const active = chips.find((c) => c.classList.contains('is-active'));
        if (active) select(active);
      });
    });
  }

  /* ==================================================================
     Portfolio "load more"
     ================================================================== */
  function initLoadMore() {
    const btn = document.querySelector('[data-load-more-btn]');
    const grid = document.querySelector('[data-load-more]');
    if (!btn || !grid) return;
    const step = Number(grid.dataset.loadMore) || 9;
    const remaining = btn.querySelector('[data-remaining]');

    btn.addEventListener('click', () => {
      const hidden = Array.from(grid.querySelectorAll('[data-grid-item].is-hidden'));
      hidden.slice(0, step).forEach((el) => el.classList.remove('is-hidden'));
      const left = grid.querySelectorAll('[data-grid-item].is-hidden').length;
      if (remaining) remaining.textContent = String(left);
      if (!left) btn.parentElement.remove();
    });
  }

  /* ==================================================================
     Booking wizard: city → category → package → duration →
     calendar → location → add-ons → total → data diri → review
     ================================================================== */
  function initBooking() {
    const form = document.querySelector('[data-booking-form]');
    const dataEl = document.getElementById('catalog-data');
    if (!form || !dataEl) return;

    let catalog = [];
    let preset = {};
    let availability = {};
    let rules = {};
    try { catalog = JSON.parse(dataEl.textContent || '[]'); } catch (e) { catalog = []; }
    try {
      const el = document.getElementById('booking-preset');
      preset = el ? JSON.parse(el.textContent || '{}') : {};
    } catch (e) { preset = {}; }
    try {
      const el = document.getElementById('availability-data');
      availability = el ? JSON.parse(el.textContent || '{}') : {};
    } catch (e) { availability = {}; }
    try {
      const el = document.getElementById('booking-rules');
      rules = el ? JSON.parse(el.textContent || '{}') : {};
    } catch (e) { rules = {}; }

    const citySelect = form.querySelector('[data-city-select]');
    const catSelect = form.querySelector('[data-category-select]');
    const pkgSelect = form.querySelector('[data-package-select]');
    const durWrap = form.querySelector('[data-duration-options]');
    const dateInput = form.querySelector('[data-date-input]');
    const addonEls = Array.from(form.querySelectorAll('[data-addon]'));
    const addonEmpty = form.querySelector('[data-addon-empty]');
    const serviceLabel = document.querySelector('[data-wizard-service]');

    const money = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
    const fmtDate = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso + 'T00:00:00');
      if (Number.isNaN(d.getTime())) return iso;
      const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
      const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
      return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    };
    const pad = (n) => String(n).padStart(2, '0');

    /* ---------- lookups ---------- */
    const currentCity = () => catalog.find((c) => c.slug === (citySelect ? citySelect.value : '')) || null;
    const currentCategory = () => {
      const city = currentCity();
      return city ? city.categories.find((k) => k.slug === catSelect.value) || null : null;
    };
    const currentPackage = () => {
      const cat = currentCategory();
      return cat ? cat.packages.find((p) => String(p.id) === String(pkgSelect.value)) || null : null;
    };
    const currentDuration = () => {
      const checked = form.querySelector('input[name="duration"]:checked');
      return checked ? Number(checked.value) : null;
    };
    const durationRow = () => {
      const pkg = currentPackage();
      const minutes = currentDuration();
      return pkg ? pkg.durations.find((d) => Number(d.minutes) === Number(minutes)) || null : null;
    };
    const packagePrice = () => {
      const row = durationRow();
      return row && row.price ? Number(row.price) : null;
    };
    const selectedAddons = () => addonEls
      .filter((el) => !el.hidden && el.querySelector('input').checked && !el.querySelector('input').disabled)
      .map((el) => ({ id: Number(el.dataset.addonId), name: el.querySelector('strong').textContent.trim(), price: Number(el.dataset.price) || 0 }));
    const addonsTotal = () => selectedAddons().reduce((sum, a) => sum + a.price, 0);

    /* ---------- calendar ---------- */
    let calMonth = null; // {y, m}
    let calLoading = false;
    const calLabel = document.querySelector('[data-cal-label]');
    const calGrid = document.querySelector('[data-cal-grid]');
    const calPrev = document.querySelector('[data-cal-prev]');
    const calNext = document.querySelector('[data-cal-next]');
    const calSelectedText = document.querySelector('[data-cal-selected]');

    function monthKey(y, m) { return y + '-' + pad(m + 1); }

    function ensureMonthAvailability(y, m) {
      const key = monthKey(y, m);
      const days = Object.keys(availability).filter((d) => d.startsWith(key));
      if (days.length) return Promise.resolve();
      calLoading = true;
      return fetch((base || '') + '/api/availability?bulan=' + key)
        .then((r) => r.json())
        .then((data) => {
          if (data && data.ok) {
            Object.assign(availability, data.days || {});
            if (data.rules) Object.assign(rules, data.rules);
          }
        })
        .catch(() => {})
        .finally(() => { calLoading = false; });
    }

    function renderCalendar() {
      if (!calGrid || !calMonth) return;
      const { y, m } = calMonth;
      const first = new Date(Date.UTC(y, m, 1));
      const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const startOffset = (first.getUTCDay() + 6) % 7; // Monday-first
      const today = new Date();
      const todayISO = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());

      if (calLabel) calLabel.textContent = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'][m] + ' ' + y;

      calGrid.innerHTML = '';
      for (let i = 0; i < startOffset; i += 1) {
        const blank = document.createElement('span');
        blank.className = 'cal-day is-empty';
        blank.setAttribute('aria-hidden', 'true');
        calGrid.appendChild(blank);
      }
      for (let d = 1; d <= daysInMonth; d += 1) {
        const iso = y + '-' + pad(m + 1) + '-' + pad(d);
        const info = availability[iso];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cal-day';
        btn.textContent = String(d);
        btn.dataset.date = iso;

        const selectable = Boolean(info && info.available);
        if (!selectable) {
          btn.disabled = true;
          if (info && info.reason === 'full') btn.title = 'Full Booking — kuota tanggal ini sudah penuh';
          else if (info && info.reason === 'full-manual') btn.title = 'Full Booking — ditandai penuh oleh admin';
          else if (info && info.reason === 'blocked') btn.title = info.note || 'Tanggal ditutup admin';
          else if (info && info.reason === 'closed') btn.title = 'Tanggal tutup rutin';
          else if (info && info.reason === 'lead') btn.title = 'Terlalu dekat dengan hari ini';
          else btn.title = 'Tidak tersedia';
        } else {
          btn.title = 'Tersedia';
        }
        if (iso === todayISO) btn.classList.add('is-today');
        if (dateInput && dateInput.value === iso) btn.classList.add('is-selected');
        btn.setAttribute('aria-pressed', String(Boolean(dateInput && dateInput.value === iso)));
        btn.addEventListener('click', () => {
          if (!dateInput) return;
          dateInput.value = iso;
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));
          renderCalendar();
          updateSelectedLabel();
        });
        calGrid.appendChild(btn);
      }

      // prev/next availability
      const now = new Date();
      const isCurrentMonth = y === now.getFullYear() && m === now.getMonth();
      if (calPrev) calPrev.disabled = isCurrentMonth;
      if (calNext) {
        const maxAdvance = Number(rules.advanceDays) || 180;
        const limit = new Date(now.getTime() + maxAdvance * 86400000);
        const cursor = new Date(Date.UTC(y, m + 1, 1));
        calNext.disabled = cursor > limit;
      }
    }

    function updateSelectedLabel() {
      if (!calSelectedText) return;
      const v = dateInput ? dateInput.value : '';
      calSelectedText.innerHTML = v
        ? 'Tanggal dipilih: <strong>' + fmtDate(v) + '</strong>'
        : 'Tanggal belum dipilih. Pilih tanggal yang tersedia pada kalender.';
      syncEstimate();
    }

    function shiftMonth(delta) {
      if (!calMonth) return;
      let { y, m } = calMonth;
      m += delta;
      if (m < 0) { m = 11; y -= 1; }
      if (m > 11) { m = 0; y += 1; }
      calMonth = { y, m };
      ensureMonthAvailability(y, m).then(renderCalendar);
    }

    if (calPrev) calPrev.addEventListener('click', () => shiftMonth(-1));
    if (calNext) calNext.addEventListener('click', () => shiftMonth(1));

    {
      const now = new Date();
      if (dateInput && dateInput.value) {
        const d = new Date(dateInput.value + 'T00:00:00');
        if (!Number.isNaN(d.getTime())) calMonth = { y: d.getFullYear(), m: d.getMonth() };
      }
      if (!calMonth) calMonth = { y: now.getFullYear(), m: now.getMonth() };
      ensureMonthAvailability(calMonth.y, calMonth.m).then(renderCalendar);
    }

    /* ---------- selectors ---------- */
    function fillCategories(preferred) {
      const city = currentCity();
      catSelect.innerHTML = '';
      if (!city || !city.categories.length) {
        catSelect.add(new Option('Belum ada kategori', ''));
        catSelect.disabled = true;
        return;
      }
      catSelect.disabled = false;
      city.categories.forEach((k) => catSelect.add(new Option(k.name, k.slug)));
      if (preferred && city.categories.some((k) => k.slug === preferred)) catSelect.value = preferred;
    }

    function fillPackages(preferredId) {
      const cat = currentCategory();
      pkgSelect.innerHTML = '';
      if (!cat || !cat.packages.length) {
        pkgSelect.add(new Option('Belum ada paket', ''));
        pkgSelect.disabled = true;
        fillDurations(null);
        return;
      }
      pkgSelect.disabled = false;
      cat.packages.forEach((p) => pkgSelect.add(new Option(p.name, p.id)));
      if (preferredId && cat.packages.some((p) => String(p.id) === String(preferredId))) {
        pkgSelect.value = String(preferredId);
      }
      fillDurations();
    }

    function fillDurations(preferredMinutes) {
      const pkg = currentPackage();
      durWrap.innerHTML = '';
      if (!pkg || !pkg.durations.length) {
        durWrap.innerHTML = '<span class="field__hint">Paket ini belum memiliki pilihan durasi.</span>';
        syncAddons();
        syncEstimate();
        return;
      }
      const wanted = preferredMinutes || Number(preset.duration) || null;
      const preferred = pkg.durations.find((d) => Number(d.minutes) === Number(wanted) && d.price)
        || pkg.durations.find((d) => d.price)
        || pkg.durations[0];

      pkg.durations.forEach((d) => {
        const label = document.createElement('label');
        label.className = 'slot' + (d.price ? '' : ' is-unavailable');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'duration';
        input.value = String(d.minutes);
        input.checked = preferred && Number(preferred.minutes) === Number(d.minutes);
        input.dataset.price = d.price ? String(d.price) : '';
        input.dataset.photos = d.edited_photos ? String(d.edited_photos) : '';

        const box = document.createElement('span');
        box.className = 'slot__box';
        box.innerHTML =
          '<span class="slot__main">' +
            '<span class="slot__time">' + d.minutes + ' Menit</span>' +
            '<span class="slot__price">' + (d.price ? money(d.price) : 'Harga belum tersedia') + '</span>' +
            (d.edited_photos ? '<span class="slot__photos">' + d.edited_photos + ' Foto Edit</span>' : '') +
          '</span>' +
          '<span class="slot__tick" aria-hidden="true">✓</span>';

        label.appendChild(input);
        label.appendChild(box);
        durWrap.appendChild(label);
        input.addEventListener('change', () => { syncEstimate(); syncAddons(); });
      });

      syncAddons();
      syncEstimate();
    }

    /* ---------- add-ons ---------- */
    function syncAddons() {
      if (!addonEls.length) return;
      const cat = currentCategory();
      let visible = 0;
      addonEls.forEach((el) => {
        const scope = String(el.dataset.applies || 'all');
        const matches = scope === 'all' || (cat && scope.split(',').map((x) => x.trim()).includes(cat.slug));
        const hasPrice = Boolean(el.dataset.price);
        const show = Boolean(matches) && hasPrice;
        el.hidden = !show;
        const input = el.querySelector('input');
        if (!show && input.checked) input.checked = false;
        if (show) visible += 1;
      });
      if (addonEmpty) addonEmpty.hidden = visible > 0;
    }

    /* ---------- estimate ---------- */
    const est = {
      pkg: document.querySelector('[data-est-package]'),
      addons: document.querySelector('[data-est-addons]'),
      total: document.querySelector('[data-est-total]'),
      rvPkg: document.querySelector('[data-rv-package-price]'),
      rvAddons: document.querySelector('[data-rv-addon-price]'),
      rvTotal: document.querySelector('[data-rv-total]')
    };

    function syncEstimate() {
      const price = packagePrice();
      const extras = addonsTotal();
      const total = price ? price + extras : null;

      if (est.pkg) est.pkg.textContent = price ? money(price) : 'Harga belum tersedia';
      if (est.addons) est.addons.textContent = money(extras);
      if (est.total) est.total.textContent = total ? money(total) : '—';
      if (est.rvPkg) est.rvPkg.textContent = price ? money(price) : 'Harga belum tersedia';
      if (est.rvAddons) est.rvAddons.textContent = money(extras);
      if (est.rvTotal) est.rvTotal.textContent = total ? money(total) : '—';

      if (serviceLabel) {
        const cat = currentCategory();
        const city = currentCity();
        serviceLabel.textContent = cat ? cat.name + (city ? ' · ' + city.name : '') : 'Pilih sesi Anda';
      }
      return total;
    }

    addonEls.forEach((el) => {
      const input = el.querySelector('input');
      if (input) input.addEventListener('change', syncEstimate);
    });

    /* ---------- review step ---------- */
    function syncReview() {
      const val = (n) => {
        const el = form.querySelector('[name="' + n + '"]');
        return el ? String(el.value || '').trim() : '';
      };
      const set = (sel, text) => {
        const el = document.querySelector(sel);
        if (el) el.textContent = text || '—';
      };
      const cat = currentCategory();
      const pkg = currentPackage();
      const city = currentCity();
      const minutes = currentDuration();
      const extras = selectedAddons();

      set('[data-rv-city]', city ? city.name : '');
      set('[data-rv-category]', cat ? cat.name : '');
      set('[data-rv-package]', pkg ? pkg.name : '');
      const durRow = durationRow();
      set('[data-rv-duration]', minutes
        ? minutes + ' menit' + (durRow && durRow.edited_photos ? ' · ' + durRow.edited_photos + ' foto edit' : '')
        : '');
      set('[data-rv-date]', dateInput && dateInput.value ? fmtDate(dateInput.value) : '');
      const t = val('shooting_time');
      set('[data-rv-time]', t ? t + ' WIB' : '');
      set('[data-rv-location]', [val('location'), val('location_address')].filter(Boolean).join(' — '));
      set('[data-rv-addons]', extras.length ? extras.map((a) => a.name).join(', ') : 'Tidak ada');
      set('[data-rv-name]', val('client_name'));
      set('[data-rv-phone]', val('client_phone'));
      set('[data-rv-ig]', val('instagram') ? '@' + val('instagram').replace(/^@/, '') : '');
      set('[data-rv-campus]', val('campus'));
      set('[data-rv-faculty]', [val('faculty'), val('major')].filter(Boolean).join(' / '));
      set('[data-rv-notes]', val('notes'));
      syncEstimate();
    }

    /* ---------- wizard steps ---------- */
    const panels = Array.from(form.querySelectorAll('[data-step]'));
    const dots = Array.from(document.querySelectorAll('[data-step-dot]'));
    let currentStep = 1;

    const setError = (field, message) => {
      const holder = form.querySelector('[data-error-for="' + field + '"]');
      if (holder) holder.textContent = message || '';
      const input = form.querySelector('[name="' + field + '"]');
      if (input && input.closest('.field')) input.closest('.field').classList.toggle('has-error', Boolean(message));
    };
    const clearErrors = () => {
      ['client_name', 'client_phone', 'campus', 'city', 'package_id', 'duration', 'shooting_date', 'location', 'location_address', 'terms']
        .forEach((f) => setError(f, ''));
    };

    function showStep(n) {
      currentStep = n;
      panels.forEach((p) => {
        const on = Number(p.dataset.step) === n;
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
      dots.forEach((d) => {
        const i = Number(d.dataset.stepDot);
        d.classList.toggle('is-active', i === n);
        d.classList.toggle('is-done', i < n);
      });
      if (n === 3) syncReview();
      const shell = form.closest('[data-booking-wizard]');
      if (shell) {
        const top = shell.getBoundingClientRect().top + window.scrollY - 100;
        window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
      }
      const focusable = panels.find((p) => Number(p.dataset.step) === n);
      const firstInput = focusable && focusable.querySelector('input:not([type=hidden]), select, textarea');
      if (firstInput && !reduceMotion) firstInput.focus({ preventScroll: true });
    }

    function validateSession() {
      clearErrors();
      const problems = [];
      if (!currentCity()) { setError('city', 'Pilih kota layanan.'); problems.push('Kota layanan wajib dipilih.'); }
      if (!currentPackage()) { setError('package_id', 'Pilih paket.'); problems.push('Paket wajib dipilih.'); }
      if (!currentDuration()) { setError('duration', 'Pilih durasi.'); problems.push('Durasi wajib dipilih.'); }
      else if (!packagePrice()) {
        setError('duration', 'Harga kombinasi ini belum diatur admin.');
        problems.push('Harga untuk durasi ini belum tersedia.');
      }
      if (!dateInput || !dateInput.value) {
        setError('shooting_date', 'Pilih tanggal pada kalender.');
        problems.push('Tanggal pemotretan wajib dipilih.');
      } else {
        const info = availability[dateInput.value];
        if (!info || !info.available) {
          setError('shooting_date', 'Tanggal ini tidak tersedia.');
          problems.push('Tanggal yang dipilih tidak tersedia.');
        }
      }
      const val = (n) => {
        const el = form.querySelector('[name="' + n + '"]');
        return el ? String(el.value || '').trim() : '';
      };
      if (val('location').length < 3) { setError('location', 'Lokasi wajib diisi.'); problems.push('Lokasi wajib diisi.'); }
      const timeVal = val('shooting_time');
      if (!timeVal) {
        setError('shooting_time', 'Jam pemotretan wajib dipilih.');
        problems.push('Jam pemotretan wajib dipilih.');
      } else if (!/^\d{2}:\d{2}$/.test(timeVal)) {
        setError('shooting_time', 'Format jam tidak valid.');
        problems.push('Format jam pemotretan tidak valid.');
      }

      selectedAddons().forEach((a) => {
        if (!a.price) problems.push('Add-on “' + a.name + '” belum memiliki harga.');
      });
      return problems;
    }

    function validateIdentity() {
      clearErrors();
      const problems = [];
      const val = (n) => {
        const el = form.querySelector('[name="' + n + '"]');
        return el ? String(el.value || '').trim() : '';
      };
      if (val('client_name').length < 3) { setError('client_name', 'Nama minimal 3 karakter.'); problems.push('Nama lengkap wajib diisi.'); }
      const phone = (() => {
        let d = val('client_phone').replace(/\D/g, '');
        if (d.startsWith('0')) d = '62' + d.slice(1);
        else if (d.startsWith('8')) d = '62' + d;
        return d;
      })();
      if (!/^62\d{8,14}$/.test(phone)) { setError('client_phone', 'Nomor WhatsApp tidak valid.'); problems.push('Nomor WhatsApp tidak valid.'); }
      if (val('campus').length < 2) { setError('campus', 'Nama kampus wajib diisi.'); problems.push('Nama kampus wajib diisi.'); }
      const ig = val('instagram').replace(/^@+/, '');
      if (!ig) {
        setError('instagram', 'Instagram wajib diisi.');
        problems.push('Instagram wajib diisi.');
      } else if (!/^[A-Za-z0-9._]{2,30}$/.test(ig)) {
        setError('instagram', 'Format Instagram tidak valid (huruf, angka, titik, garis bawah).');
        problems.push('Format Instagram tidak valid.');
      }
      const terms = form.querySelector('[data-terms-check]');
      if (!terms || !terms.checked) { setError('terms', 'Persetujuan Syarat & Ketentuan wajib dicentang.'); problems.push('Persetujuan Syarat & Ketentuan wajib dicentang.'); }
      // Photo-publication consent is intentionally not requested on the public form anymore.
      return problems;
    }

    function showProblems(problems) {
      let box = form.querySelector('.alert--client');
      if (box) box.remove();
      if (!problems.length) return;
      box = document.createElement('div');
      box.className = 'alert alert--error alert--client';
      box.setAttribute('role', 'alert');
      box.innerHTML = '<strong>Periksa kembali data Anda:</strong><ul>' +
        problems.map((p) => '<li>' + p.replace(/</g, '&lt;') + '</li>').join('') + '</ul>';
      const panel = panels.find((p) => Number(p.dataset.step) === currentStep);
      (panel || form).insertBefore(box, (panel || form).firstChild);
      box.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    }

    form.querySelectorAll('[data-next]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = Number(btn.dataset.next);
        // Step 1 = identity, step 2 = session detail.
        const problems = currentStep === 1 ? validateIdentity() : validateSession();
        showProblems(problems);
        if (problems.length) return;
        const pending = form.querySelector('.alert--client');
        if (pending) pending.remove();
        showStep(target);
      });
    });
    form.querySelectorAll('[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pending = form.querySelector('.alert--client');
        if (pending) pending.remove();
        showStep(Number(btn.dataset.back));
      });
    });

    /* terms hidden mirror so an unchecked box still posts 0 */
    const termsCheck = form.querySelector('[data-terms-check]');
    const termsHidden = form.querySelector('[data-terms-hidden]');
    if (termsCheck && termsHidden) {
      const syncTerms = () => { termsHidden.disabled = termsCheck.checked; };
      termsCheck.addEventListener('change', syncTerms);
      syncTerms();
    }

    form.addEventListener('submit', (e) => {
      const identityProblems = validateIdentity();
      const sessionProblems = validateSession();
      const problems = identityProblems.concat(sessionProblems);
      if (problems.length) {
        e.preventDefault();
        // Send the admin back to the step that actually has the problem.
        showStep(identityProblems.length ? 1 : 2);
        showProblems(problems);
        return;
      }
      const btn = form.querySelector('[data-submit-btn]');
      if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan…'; }
    });

    /* live review inputs */
    ['client_name', 'client_phone', 'instagram', 'campus', 'faculty', 'major', 'notes',
      'location', 'shooting_time', 'location_address'].forEach((name) => {
      const el = form.querySelector('[name="' + name + '"]');
      if (el) el.addEventListener('input', () => { if (currentStep === 3) syncReview(); });
    });

    /* ---------- boot ---------- */
    fillCategories();
    if (preset.packageId) {
      const city = catalog.find((c) => c.slug === preset.city);
      if (city) {
        const found = city.categories.find((k) => k.packages.some((p) => Number(p.id) === Number(preset.packageId)));
        if (found) {
          citySelect.value = city.slug;
          fillCategories(found.slug);
        }
      }
    }
    fillPackages(preset.packageId);
    if (preset.duration) fillDurations(preset.duration);
    updateSelectedLabel();

    citySelect.addEventListener('change', () => {
      fillCategories();
      fillPackages();
      syncEstimate();
    });
    catSelect.addEventListener('change', () => fillPackages());
    pkgSelect.addEventListener('change', () => fillDurations());
    if (dateInput) dateInput.addEventListener('change', updateSelectedLabel);
  }

  /* ==================================================================
     Lightbox — one "slide set" per trigger.
     A portfolio card carries its own extra photos in data-more (|-separated),
     so next/prev walks that portfolio's gallery; on pages without data-more
     every photo on the page behaves as one set (previous behaviour).
     ================================================================== */
  function initLightbox() {
    const modal = document.querySelector('[data-lightbox-modal]');
    if (!modal) return;
    const triggers = Array.from(document.querySelectorAll('[data-lightbox]'));
    if (!triggers.length) return;

    const img = modal.querySelector('[data-lb-img]');
    const title = modal.querySelector('[data-lb-title]');
    const meta = modal.querySelector('[data-lb-meta]');
    const desc = modal.querySelector('[data-lb-desc]');
    const counter = modal.querySelector('[data-lb-counter]');
    const thumbsWrap = modal.querySelector('[data-lb-thumbs]');

    let active = null;       // trigger that opened the modal (title/meta source)
    let index = 0;           // position inside the current slide set
    let slides = [];
    let lastFocused = null;

    const parseMore = (value) => String(value || '')
      .split('|').map((s) => s.trim()).filter(Boolean);

    /**
     * Slide set for a trigger. A trigger may carry extra photos in data-more
     * (one portfolio = one set). Triggers sharing a data-lb-group (the client
     * photo-selection portal) walk the whole group, so next/prev covers every
     * photo of the session without repeating every URL inside every tile.
     */
    function setFor(t) {
      if (!t) return { list: [], index: 0 };
      const group = t.dataset.lbGroup;
      if (group) {
        const groupTriggers = triggers.filter((x) => x.dataset.lbGroup === group);
        return {
          list: groupTriggers.map((x) => ({ src: x.dataset.src || '', caption: x.dataset.title || '' })),
          index: Math.max(0, groupTriggers.indexOf(t))
        };
      }
      const more = parseMore(t.dataset.more);
      return {
        list: [{ src: t.dataset.src || '', caption: t.dataset.caption || '' }]
          .concat(more.map((src) => ({ src, caption: '' })))
          .filter((s) => s.src),
        index: 0
      };
    }

    function render() {
      const t = active;
      if (!t) return;
      const slide = slides[index] || { src: '' };
      img.src = slide.src;
      img.alt = t.dataset.title || '';
      title.textContent = t.dataset.title || '';
      meta.textContent = t.dataset.meta || '';
      desc.textContent = t.dataset.desc || '';
      desc.hidden = !t.dataset.desc;

      const many = slides.length > 1;
      if (counter) {
        counter.hidden = !many;
        counter.textContent = many ? `${index + 1} / ${slides.length}` : '';
      }
      if (thumbsWrap) {
        thumbsWrap.hidden = !many;
        if (many) {
          thumbsWrap.innerHTML = '';
          slides.forEach((s, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lightbox__thumb' + (i === index ? ' is-active' : '');
            b.setAttribute('aria-label', `Foto ${i + 1} dari ${slides.length}`);
            const im = document.createElement('img');
            im.src = s.src;
            im.alt = '';
            b.appendChild(im);
            b.addEventListener('click', (e) => { e.stopPropagation(); index = i; render(); });
            thumbsWrap.appendChild(b);
          });
        }
      }
      // Hide the arrows entirely when there is nothing to step through.
      modal.querySelectorAll('[data-lb-prev], [data-lb-next]').forEach((btn) => {
        btn.hidden = slides.length < 2;
      });
    }

    function open(i) {
      active = triggers[i];
      const set = setFor(active);
      slides = set.list;
      index = set.index;
      lastFocused = document.activeElement;
      render();
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      modal.querySelector('[data-lb-close]').focus();
    }

    function close() {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    function step(dir) {
      if (!slides.length) return;
      index = (index + dir + slides.length) % slides.length;
      render();
    }

    triggers.forEach((t, i) => t.addEventListener('click', () => open(i)));
    modal.querySelector('[data-lb-close]').addEventListener('click', close);
    modal.querySelector('[data-lb-prev]').addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
    modal.querySelector('[data-lb-next]').addEventListener('click', (e) => { e.stopPropagation(); step(1); });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (modal.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });

    /* Swipe on touch devices (mobile). */
    let touchX = null;
    let touchY = null;
    modal.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { touchX = null; return; }
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    modal.addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = (e.changedTouches[0].clientX - touchX) || 0;
      const dy = (e.changedTouches[0].clientY - touchY) || 0;
      touchX = null;
      touchY = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
      step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  /* ==================================================================
     Testimonial carousel — scroll-snap track with prev/next arrows
     ================================================================== */
  function initTestimonialCarousel() {
    document.querySelectorAll('[data-tst-carousel]').forEach((root) => {
      const viewport = root.querySelector('[data-tst-viewport]');
      const track = root.querySelector('.tst-carousel__track');
      const nav = root.querySelector('[data-tst-nav]');
      const prev = root.querySelector('[data-tst-prev]');
      const next = root.querySelector('[data-tst-next]');
      if (!viewport || !track) return;
      const cards = Array.from(track.children);
      if (!cards.length) return;

      const pageWidth = () => {
        const card = cards[0].getBoundingClientRect().width || 1;
        const gap = parseFloat(getComputedStyle(track).columnGap || '18') || 18;
        return card + gap;
      };

      function sync() {
        const max = viewport.scrollWidth - viewport.clientWidth - 2;
        if (prev) prev.disabled = viewport.scrollLeft <= 2;
        if (next) next.disabled = viewport.scrollLeft >= max;
        if (nav) nav.hidden = max <= 2; // everything fits → no arrows needed
      }

      if (prev) prev.addEventListener('click', () => viewport.scrollBy({ left: -pageWidth(), behavior: reduceMotion ? 'auto' : 'smooth' }));
      if (next) next.addEventListener('click', () => viewport.scrollBy({ left: pageWidth(), behavior: reduceMotion ? 'auto' : 'smooth' }));
      viewport.addEventListener('scroll', () => window.requestAnimationFrame(sync), { passive: true });
      window.addEventListener('resize', sync);
      sync();
    });
  }

  /* ==================================================================
     Star rating readout (public testimonial form)
     The fill itself is pure CSS; this only mirrors the choice into text.
     ================================================================== */
  function initStarPicker() {
    document.querySelectorAll('[data-star-picker]').forEach((picker) => {
      const readout = picker.parentElement.querySelector('[data-star-readout]');
      const defaultText = readout ? readout.textContent : '';
      picker.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.addEventListener('change', () => {
          if (readout) readout.textContent = `Rating dipilih: ${input.value} dari 5 bintang.`;
        });
      });
      const checked = picker.querySelector('input:checked');
      if (checked && readout) readout.textContent = `Rating dipilih: ${checked.value} dari 5 bintang.`;
      if (readout && !checked) readout.textContent = defaultText;
    });
  }


  /* ==================================================================
     Scroll reveal — fade + rise for page blocks.
     Elements are chosen by role, so new sections are covered automatically.
     ================================================================== */
  function initScrollReveal() {
    if (reduceMotion) return; // CSS already neutralises the effect
    const noRevealPages = ['page-booking', 'page-testimonial-form', 'page-booking-success'];
    if (noRevealPages.some((c) => document.body.classList.contains(c))) return;

    const SELECTORS = [
      '.section-head',
      '.page-head h1',
      '.page-head__lede',
      '.intro__media',
      '.intro__body',
      '.advantage',
      '.service-card',
      '.step',
      '.testimonial',
      '.review-card',
      '.editorial-item',
      '.masonry-item',
      '.carousel__item',
      '.article-card',
      '.city-card',
      '.archive-card',
      '.pkg-feature',
      '.about-media',
      '.about-body',
      '.order-step',
      '.faq-item',
      '.tnc__list li',
      '.cta-band__inner > *'
    ];

    const targets = [];
    document.querySelectorAll(SELECTORS.join(',')).forEach((el) => {
      if (el.closest('.hero')) return;          // hero has its own entrance
      if (el.classList.contains('reveal')) return;
      targets.push(el);
    });
    if (!targets.length) return;

    targets.forEach((el, i) => {
      el.classList.add('reveal');
      // Stagger items that sit side by side in the same row.
      const idx = Array.prototype.indexOf.call(el.parentElement ? el.parentElement.children : [], el);
      if (idx > 0 && idx <= 3) el.style.transitionDelay = (idx * 70) + 'ms';
      if (i % 7 === 6) el.classList.add('reveal--slow');
    });

    if (!('IntersectionObserver' in window)) {
      targets.forEach((el) => el.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    targets.forEach((el) => {
      // Anything already in view on load appears immediately (no flash of hidden content).
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.92) {
        el.classList.add('is-in');
      } else {
        io.observe(el);
      }
    });
  }

  /* ==================================================================
     Homepage statistics count-up (runs once when scrolled into view)
     ================================================================== */
  function initStatCounters() {
    const nodes = Array.from(document.querySelectorAll('[data-countup]'));
    if (!nodes.length) return;

    const render = (el, value) => {
      const suffix = el.getAttribute('data-suffix') || '';
      el.textContent = Math.round(value).toLocaleString('id-ID') + suffix;
    };

    const animate = (el) => {
      const target = Number(el.getAttribute('data-countup')) || 0;
      if (reduceMotion) { render(el, target); return; }
      const duration = 1800;
      const start = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        render(el, target * eased);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (!('IntersectionObserver' in window)) { nodes.forEach(animate); return; }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animate(entry.target);
        io.unobserve(entry.target); // never repeats on scroll
      });
    }, { threshold: 0.35 });

    nodes.forEach((el) => {
      render(el, 0);
      io.observe(el);
    });
  }

  initGalleryFilter();
  initHero();
  initStatCounters();
  initScrollReveal();
  initCarousels();
  initTestimonialCarousel();
  initStarPicker();
  initPackageBrowser();
  initLoadMore();
  initBooking();
  initLightbox();
})();

/* ==========================================================================
   V6 — package detail page: gallery slider + dynamic duration pricing
   ========================================================================== */
(function () {
  'use strict';
  const dataEl = document.getElementById('pkg-detail-data');
  const root = document.querySelector('.pkg-detail');
  if (!dataEl || !root) return;

  let data = {};
  try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
  const base = data.base || '';
  const money = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- slider ---------- */
  const track = root.querySelector('[data-slider-track]');
  if (track) {
    const slides = Array.from(track.querySelectorAll('[data-slide-index]'));
    const dots = Array.from(root.querySelectorAll('[data-slider-dot]'));
    const thumbs = Array.from(root.querySelectorAll('[data-slider-thumb]'));
    const counter = root.querySelector('[data-slider-current]');
    let index = 0;

    const sync = () => {
      dots.forEach((d, i) => d.classList.toggle('is-active', i === index));
      thumbs.forEach((t, i) => t.classList.toggle('is-active', i === index));
      if (counter) counter.textContent = String(index + 1);
    };
    const goTo = (i) => {
      if (!slides.length) return;
      index = (i + slides.length) % slides.length;
      track.scrollTo({ left: slides[index].offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
      sync();
    };

    root.querySelector('[data-slider-prev]')?.addEventListener('click', () => goTo(index - 1));
    root.querySelector('[data-slider-next]')?.addEventListener('click', () => goTo(index + 1));
    dots.forEach((d, i) => d.addEventListener('click', () => goTo(i)));
    thumbs.forEach((t, i) => t.addEventListener('click', () => goTo(i)));

    let scrollTimer = null;
    track.addEventListener('scroll', () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const w = slides[0] ? slides[0].offsetWidth : 1;
        const next = Math.round(track.scrollLeft / w);
        if (next !== index && next >= 0 && next < slides.length) { index = next; sync(); }
      }, 90);
    }, { passive: true });
  }

  /* ---------- dynamic duration pricing ---------- */
  const chips = Array.from(root.querySelectorAll('[data-detail-duration]'));
  const priceEl = root.querySelector('[data-detail-price]');
  const noteEl = root.querySelector('[data-detail-price-note]');
  const photosEl = root.querySelector('[data-detail-photos]');
  const stickyPrice = root.querySelector('[data-sticky-price]');
  const stickyNote = root.querySelector('[data-sticky-note]');
  const bookLinks = Array.from(root.querySelectorAll('[data-detail-book]'));

  const apply = (chip) => {
    if (!chip) return;
    const minutes = Number(chip.dataset.detailDuration);
    const price = chip.dataset.price ? Number(chip.dataset.price) : null;
    const photos = chip.dataset.photos ? Number(chip.dataset.photos) : null;

    chips.forEach((c) => c.classList.toggle('is-active', c === chip));

    if (priceEl) priceEl.textContent = price ? money(price) : 'Harga belum tersedia';
    if (noteEl) noteEl.textContent = price ? 'untuk ' + minutes + ' menit' : 'Admin belum mengisi harga untuk durasi ini';
    if (photosEl) photosEl.textContent = photos ? photos + ' foto' : 'Belum dikonfigurasi';
    if (stickyPrice) stickyPrice.textContent = price ? money(price) : 'Harga belum tersedia';
    if (stickyNote) stickyNote.textContent = minutes + ' menit';

    bookLinks.forEach((a) => {
      a.setAttribute('href', base + '/booking?kota=' + encodeURIComponent(data.city) +
        '&paket=' + encodeURIComponent(data.pkgId) + '&durasi=' + minutes);
    });
  };

  chips.forEach((chip) => chip.addEventListener('click', () => apply(chip)));
  apply(chips.find((c) => c.classList.contains('is-active')) || chips[0]);
})();

/* ==========================================================================
   Tahap 4 — PWA "Pasang aplikasi" prompt
   --------------------------------------------------------------------------
   The service worker is registered inline in layout.ejs (it needs the app's base
   path). This only handles the install offer: it appears when the browser says the
   app is installable, and stays hidden otherwise — no fake "install" button.
   ========================================================================== */
(function () {
  'use strict';
  var box = document.querySelector('[data-install-app]');
  if (!box) return;
  var DISMISS_KEY = 'dly.installDismissed';
  var deferred = null;

  function hide() { box.hidden = true; }
  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }
  // Already installed / running as an app: nothing to offer.
  var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  if (standalone || window.navigator.standalone) return;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (!dismissed()) box.hidden = false;
  });

  var go = box.querySelector('[data-install-go]');
  if (go) {
    go.addEventListener('click', function () {
      if (!deferred) { hide(); return; }
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; hide(); }).catch(function () { hide(); });
    });
  }
  var x = box.querySelector('[data-install-dismiss]');
  if (x) {
    x.addEventListener('click', function () {
      hide();
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
    });
  }
  window.addEventListener('appinstalled', hide);
})();

/* ==========================================================================
   Tahap 6 — carousel foto paket di Pricelist
   --------------------------------------------------------------------------
   Autoplay halus + swipe manual + indikator posisi. Aturan:
   - hanya berjalan bila paket punya >1 foto;
   - berhenti saat kursor/fokus/touch ada di carousel (interaksi pengguna);
   - berhenti saat tab tidak terlihat (hemat baterai & tidak "melompat" saat kembali);
   - prefers-reduced-motion: tidak pernah autoplay.
   Tidak memakai library, tidak menambah berat halaman.
   ========================================================================== */
(function () {
  'use strict';
  var roots = document.querySelectorAll('[data-pkg-carousel]');
  if (!roots.length) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  roots.forEach(function (root) {
    var track = root.querySelector('[data-carousel-track]');
    if (!track) return;
    var slides = Array.prototype.slice.call(track.querySelectorAll('.pkg-carousel__slide'));
    var dots = Array.prototype.slice.call(root.querySelectorAll('[data-carousel-dot]'));
    var counter = root.querySelector('[data-carousel-counter]');
    var interval = Math.max(3500, Number(root.getAttribute('data-interval')) || 5500);

    if (slides.length < 2) return;

    var index = 0;
    var timer = null;
    var paused = false;
    var userStopped = false;

    function paint() {
      dots.forEach(function (d, i) {
        var on = i === index;
        d.classList.toggle('is-active', on);
        d.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (counter) counter.textContent = (index + 1) + ' / ' + slides.length;
    }

    function goTo(i, smooth) {
      index = (i + slides.length) % slides.length;
      var left = slides[index].offsetLeft;
      // scrollTo on the track keeps native swipe working and never resizes the layout.
      try {
        track.scrollTo({ left: left, behavior: smooth === false || reduceMotion ? 'auto' : 'smooth' });
      } catch (err) {
        track.scrollLeft = left;
      }
      paint();
    }

    function start() {
      if (reduceMotion || paused || userStopped || document.hidden || timer) return;
      timer = window.setInterval(function () { goTo(index + 1); }, interval);
    }
    function stop() {
      if (timer) { window.clearInterval(timer); timer = null; }
    }
    function pause() { paused = true; stop(); }
    function resume() { paused = false; start(); }

    // Manual controls stop autoplay for this visit (the visitor is browsing deliberately).
    function manual(action) {
      userStopped = true;
      stop();
      action();
    }

    var prev = root.querySelector('[data-carousel-prev]');
    var next = root.querySelector('[data-carousel-next]');
    if (prev) prev.addEventListener('click', function () { manual(function () { goTo(index - 1); }); });
    if (next) next.addEventListener('click', function () { manual(function () { goTo(index + 1); }); });
    dots.forEach(function (dot) {
      dot.addEventListener('click', function () {
        manual(function () { goTo(Number(dot.getAttribute('data-carousel-dot'))); });
      });
    });

    // Keep the indicator truthful when the visitor swipes.
    var scrollTick = null;
    track.addEventListener('scroll', function () {
      if (scrollTick) return;
      scrollTick = window.setTimeout(function () {
        scrollTick = null;
        var approx = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (approx !== index && approx >= 0 && approx < slides.length) { index = approx; paint(); }
      }, 90);
    }, { passive: true });

    track.addEventListener('pointerdown', pause);
    track.addEventListener('touchstart', pause, { passive: true });
    track.addEventListener('pointerup', resume);
    track.addEventListener('touchend', resume);
    root.addEventListener('pointerenter', pause);
    root.addEventListener('pointerleave', resume);
    root.addEventListener('focusin', pause);
    root.addEventListener('focusout', resume);
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); manual(function () { goTo(index + 1); }); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); manual(function () { goTo(index - 1); }); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    paint();
    start();
  });
})();
