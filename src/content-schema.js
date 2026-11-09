'use strict';

/**
 * Declarative CMS schema: content fields, sections, appearance presets.
 * Kept free of any DB import so src/db.js can seed from it without cycles.
 */

const CONTENT_FIELDS = [
  // --- Hero -------------------------------------------------------------
  { key: 'hero.label', group: 'Hero', label: 'Label kecil di atas headline', default: 'FOTOGRAFI WISUDA · BANDUNG' },
  { key: 'hero.headline', group: 'Hero', label: 'Headline (baris 1)', default: 'Your Graduation,' },
  { key: 'hero.headline_accent', group: 'Hero', label: 'Headline (baris 2, miring)', default: 'Your Story.' },
  {
    key: 'hero.description', group: 'Hero', type: 'textarea',
    label: 'Deskripsi hero',
    default: 'Sesi foto wisuda yang dirancang mengikuti cerita Anda — dari toga dan senyum bangga, sampai momen bersama orang-orang terdekat. Pilih kota, paket, dan durasi, lalu amankan jadwal Anda.'
  },
  { key: 'hero.cta_primary', group: 'Hero', label: 'Tombol utama', default: 'Explore Our Portfolio' },
  { key: 'hero.cta_primary_link', group: 'Hero', label: 'Link tombol utama', default: '/portfolio' },
  { key: 'hero.cta_secondary', group: 'Hero', label: 'Tombol kedua', default: 'Book Your Session' },
  { key: 'hero.cta_secondary_link', group: 'Hero', label: 'Link tombol kedua', default: '/booking' },
  { key: 'hero.meta_1', group: 'Hero', label: 'Info singkat 1', default: 'Individu · Couple · Group' },
  { key: 'hero.meta_2', group: 'Hero', label: 'Info singkat 2', default: 'Bandung · Kota lain menyusul' },
  { key: 'hero.meta_3', group: 'Hero', label: 'Info singkat 3', default: 'Respon cepat via WhatsApp' },

  // --- Hero slideshow behaviour ----------------------------------------
  { key: 'hero.autoplay', group: 'Hero Slideshow', type: 'bool', label: 'Autoplay aktif', default: '1' },
  { key: 'hero.interval_ms', group: 'Hero Slideshow', type: 'number', label: 'Interval antar foto (ms)', default: '6000' },
  { key: 'hero.transition_ms', group: 'Hero Slideshow', type: 'number', label: 'Durasi transisi (ms)', default: '1300' },
  { key: 'hero.kenburns', group: 'Hero Slideshow', type: 'bool', label: 'Efek Ken Burns (zoom halus)', default: '1' },
  { key: 'hero.overlay_opacity', group: 'Hero Slideshow', type: 'number', label: 'Overlay opacity (%)', default: '58' },
  { key: 'hero.overlay_color', group: 'Hero Slideshow', type: 'color', label: 'Warna overlay', default: '#0B2340' },
  { key: 'hero.show_controls', group: 'Hero Slideshow', type: 'bool', label: 'Tampilkan kontrol & dots', default: '1' },

  // --- SEO --------------------------------------------------------------
  { key: 'seo.title', group: 'SEO', label: 'SEO title', default: 'DLY Graduation — Fotografi Wisuda Bandung' },
  {
    key: 'seo.description', group: 'SEO', type: 'textarea',
    label: 'SEO description',
    default: 'DLY Graduation — jasa fotografi wisuda individu, couple, dan group di Bandung. Pilih kota, paket, dan durasi, lalu booking langsung via WhatsApp.'
  },

  // --- Homepage: introduction & services --------------------------------
  { key: 'intro.eyebrow', group: 'Section: Introduction', label: 'Label kecil', default: 'Tentang Sesi Kami' },
  { key: 'intro.title', group: 'Section: Introduction', label: 'Judul', default: 'Wisuda Anda layak diceritakan dengan tenang' },
  {
    key: 'intro.description', group: 'Section: Introduction', type: 'textarea',
    label: 'Deskripsi',
    default: 'DLY Graduation adalah studio fotografi wisuda yang berfokus pada satu hal: membuat Anda merasa nyaman di depan kamera. Kami memotret individu, couple, group, dan liputan acara wisuda dengan pendekatan editorial yang natural — bukan pose kaku yang terasa asing.'
  },
  { key: 'intro.image', group: 'Section: Introduction', label: 'Foto section (URL/path)', default: '/ph/portfolio-campus.svg' },
  { key: 'intro.cta_label', group: 'Section: Introduction', label: 'Teks tombol', default: 'Tentang Kami' },
  { key: 'intro.cta_link', group: 'Section: Introduction', label: 'Link tombol', default: '/tentang' },
  {
    key: 'intro.points', group: 'Section: Introduction', type: 'textarea', label: 'Poin singkat (satu per baris, format: Judul | Deskripsi)',
    default: 'Pendekatan editorial | Komposisi rapi, warna konsisten, dan hasil yang tidak lekang waktu.\nArahan yang sabar | Anda tidak perlu pandai berpose — kami memandu setiap langkahnya.\nFokus pada cerita | Setiap sesi dimulai dari cerita dan referensi Anda sendiri.'
  },
  { key: 'services.title', group: 'Section: Our Services', label: 'Judul', default: 'Layanan yang kami sediakan' },
  {
    key: 'services.description', group: 'Section: Our Services', type: 'textarea', label: 'Deskripsi',
    default: 'Empat jenis sesi yang bisa Anda pilih. Pilih kategori untuk melihat durasi dan harga yang berlaku di kota Anda.'
  },

  // --- Sections copy ----------------------------------------------------
  { key: 'featured.title', group: 'Section: Featured', label: 'Judul section', default: 'Momen yang kami rancang dengan tenang' },
  { key: 'featured.description', group: 'Section: Featured', type: 'textarea', label: 'Deskripsi', default: 'Pilihan foto unggulan dari sesi wisuda DLY Graduation.' },
  { key: 'carousel.title', group: 'Section: Carousel', label: 'Judul section', default: 'Portfolio pilihan' },
  { key: 'carousel.description', group: 'Section: Carousel', type: 'textarea', label: 'Deskripsi', default: 'Geser untuk melihat lebih banyak momen wisuda.' },
  { key: 'carousel.autoplay', group: 'Section: Carousel', type: 'bool', label: 'Autoplay carousel', default: '1' },
  { key: 'carousel.autoplay_ms', group: 'Section: Carousel', type: 'number', label: 'Kecepatan autoplay (ms)', default: '5000' },
  { key: 'carousel.limit', group: 'Section: Carousel', type: 'number', label: 'Jumlah foto di carousel', default: '8' },
  { key: 'advantages.title', group: 'Section: Keunggulan', label: 'Judul section', default: 'Pengalaman wisuda yang terasa personal' },
  { key: 'advantages.description', group: 'Section: Keunggulan', type: 'textarea', label: 'Deskripsi', default: 'Kami menjaga sesi tetap nyaman, harga tetap transparan, dan hasil foto tetap terasa seperti Anda.' },
  { key: 'packages.title', group: 'Section: Paket', label: 'Judul section', default: 'Paket fotografi' },
  { key: 'packages.description', group: 'Section: Paket', type: 'textarea', label: 'Deskripsi', default: 'Pilih kategori, paket, lalu durasi. Harga menyesuaikan otomatis.' },
  { key: 'process.title', group: 'Section: Alur', label: 'Judul section', default: 'Tiga langkah, jadwal Anda aman' },
  { key: 'process.description', group: 'Section: Alur', type: 'textarea', label: 'Deskripsi', default: 'Alur pemesanan yang sederhana dan transparan.' },
  { key: 'testimonials.title', group: 'Section: Testimoni', label: 'Judul section', default: 'Cerita dari wisudawan' },
  { key: 'testimonials.description', group: 'Section: Testimoni', type: 'textarea', label: 'Deskripsi', default: '' },
  { key: 'cta.title', group: 'Section: CTA', label: 'Judul CTA', default: 'Siap mengabadikan hari kelulusan Anda?' },
  { key: 'cta.description', group: 'Section: CTA', type: 'textarea', label: 'Deskripsi CTA', default: 'Isi form booking, lalu lanjutkan ke WhatsApp. Admin akan mengonfirmasi ketersediaan jadwal Anda.' },
  { key: 'cta.button', group: 'Section: CTA', label: 'Teks tombol', default: 'Book Your Session' },
  { key: 'cta.note', group: 'Section: CTA', label: 'Catatan kecil', default: 'Jadwal terbatas per bulan' },

  // --- Page headers -----------------------------------------------------
  { key: 'portfolio.title', group: 'Halaman', label: 'Judul halaman portfolio', default: 'Galeri foto wisuda' },
  {
    key: 'portfolio.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman portfolio',
    default: 'Kumpulan sesi individu, couple, group, dan graduation event. Setiap foto memiliki cerita, kota, dan momennya sendiri.'
  },
  { key: 'pricelist.title', group: 'Halaman', label: 'Judul halaman pricelist', default: 'Paket & harga' },
  {
    key: 'pricelist.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman pricelist',
    default: 'Pilih kota, kategori, paket, dan durasi. Harga menyesuaikan otomatis dari data resmi DLY Graduation.'
  },
  {
    key: 'pricelist.notes', group: 'Halaman', type: 'textarea', label: 'Catatan layanan (satu poin per baris)',
    default: 'Harga yang tampil adalah harga resmi sesuai durasi yang dipilih.\nJadwal dianggap terpesan setelah admin mengonfirmasi ketersediaan tanggal melalui WhatsApp.\nBiaya transportasi di luar area kota layanan dikonfirmasi terlebih dahulu sebelum sesi.\nHasil foto dikirim melalui Google Drive dalam beberapa hari kerja setelah sesi selesai.\nPerubahan jadwal dapat diajukan maksimal 3 hari sebelum tanggal pemotretan.'
  },
  { key: 'gallery.title', group: 'Halaman', label: 'Judul halaman gallery', default: 'Gallery' },
  {
    key: 'gallery.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman gallery',
    default: 'Kumpulan sesi individu, couple, group, dan liputan acara wisuda. Setiap foto punya cerita, kota, dan momennya sendiri.'
  },
  { key: 'caraorder.title', group: 'Halaman', label: 'Judul halaman Cara Order', default: 'Cara Order' },
  {
    key: 'caraorder.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman Cara Order',
    default: 'Empat langkah sederhana dari memilih sesi sampai jadwal Anda dikonfirmasi admin.'
  },
  {
    key: 'caraorder.steps', group: 'Halaman', type: 'textarea', label: 'Langkah (satu per baris, format: Judul | Deskripsi)',
    default: 'Pilih kota & sesi | Tentukan kota layanan, kategori, dan durasi. Harga muncul otomatis dari data resmi.\nTentukan jadwal & lokasi | Pilih tanggal yang tersedia pada kalender, isi lokasi pemotretan, lalu tambahkan add-on bila diperlukan.\nLengkapi data diri | Isi kontak, kampus, dan detail pendukung. Tinjau kembali total estimasi Anda.\nKirim booking | Permintaan booking tersimpan dengan status Pending dan diteruskan ke WhatsApp. Admin mengonfirmasi ketersediaan jadwal.'
  },
  { key: 'artikel.title', group: 'Halaman', label: 'Judul halaman Artikel', default: 'Artikel & Panduan' },
  {
    key: 'artikel.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman Artikel',
    default: 'Catatan seputar persiapan sesi, pemilihan durasi, dan hal kecil yang membuat hasil foto wisuda lebih baik.'
  },
  { key: 'ulasan.title', group: 'Halaman', label: 'Judul halaman Ulasan', default: 'Ulasan Klien' },
  {
    key: 'ulasan.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman Ulasan',
    default: 'Pengalaman wisudawan yang pernah sesi foto bersama DLY Graduation.'
  },
  { key: 'faq.title', group: 'Halaman', label: 'Judul halaman FAQ', default: 'Pertanyaan yang Sering Diajukan' },
  {
    key: 'faq.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman FAQ',
    default: 'Jawaban singkat untuk hal-hal yang paling sering ditanyakan sebelum booking.'
  },
  { key: 'tnc.title', group: 'Halaman', label: 'Judul halaman Syarat & Ketentuan', default: 'Syarat & Ketentuan' },
  {
    key: 'tnc.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi singkat (di bawah judul)',
    default: 'Ketentuan yang berlaku untuk setiap sesi foto wisuda di DLY Graduation. Mohon dibaca sebelum melakukan booking.'
  },
  {
    key: 'tnc.body', group: 'Halaman', type: 'textarea', label: 'Isi Syarat & Ketentuan (satu poin per baris)',
    default: 'Booking dianggap sah setelah klien mengisi formulir booking dan admin mengonfirmasi ketersediaan jadwal melalui WhatsApp.\nJadwal baru terkunci setelah pembayaran DP diterima sesuai nominal yang tercantum pada konfirmasi admin.\nDP yang sudah dibayarkan tidak dapat dikembalikan apabila klien membatalkan sesi kurang dari 3 hari sebelum tanggal pemotretan.\nPerubahan jadwal dapat diajukan maksimal 3 hari sebelum tanggal pemotretan dan bergantung pada ketersediaan slot.\nKlien wajib hadir tepat waktu sesuai jam pemotretan yang disepakati; keterlambatan mengurangi durasi sesi.\nCuaca dan kondisi lokasi di luar kendali DLY Graduation; penjadwalan ulang karena cuaca dibicarakan bersama tanpa biaya tambahan.\nHasil foto dikirim melalui Google Drive sesuai jumlah foto edit yang tercantum pada paket.\nFile mentah (RAW) tidak diserahkan kepada klien kecuali disepakati lain secara tertulis.\nDLY Graduation berhak menggunakan hasil foto untuk portfolio, kecuali klien menyatakan tidak mengizinkan pada formulir booking.\nData pribadi klien hanya digunakan untuk keperluan booking, konfirmasi jadwal, dan pengiriman hasil foto.'
  },
  { key: 'tentang.title', group: 'Halaman', label: 'Judul halaman Tentang Kami', default: 'Tentang DLY Graduation' },
  {
    key: 'tentang.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi singkat (di bawah judul)',
    default: 'Studio fotografi wisuda yang percaya bahwa foto terbaik lahir dari rasa nyaman, bukan pose yang dipaksakan.'
  },
  { key: 'tentang.image', group: 'Halaman', label: 'Foto halaman Tentang (URL/path)', default: '/ph/portfolio-portrait-1.svg' },
  {
    key: 'tentang.body', group: 'Halaman', type: 'textarea', label: 'Isi halaman Tentang',
    default: 'DLY Graduation berawal dari satu keyakinan sederhana: hari kelulusan adalah salah satu momen paling personal dalam hidup seseorang, dan cara memotretnya seharusnya terasa personal juga.\n\nKami bekerja dengan pendekatan editorial — komposisi yang rapi, warna yang konsisten, dan arahan yang tenang. Tidak ada pose yang dipaksakan, tidak ada sesi yang terburu-buru. Kami berbincang dulu sebelum memotret, memahami apa yang ingin Anda kenang, lalu menyesuaikan konsep dan lokasi dengan itu.\n\nSaat ini layanan kami berpusat di Bandung, dengan kota lain yang dibuka secara bertahap. Setiap kota memiliki tim dan jadwalnya sendiri agar kualitas sesi tetap terjaga.'
  },
  {
    key: 'tentang.values', group: 'Halaman', type: 'textarea', label: 'Nilai studio (satu per baris, format: Judul | Deskripsi)',
    default: 'Tenang | Sesi yang tidak terburu-buru agar Anda bisa tampil natural.\nPersonal | Konsep disesuaikan dengan cerita dan referensi Anda.\nTransparan | Harga dan fasilitas ditampilkan jelas sejak awal.\nKonsisten | Editing warna dan retouch dikerjakan satu per satu.'
  },
  { key: 'booking.title', group: 'Halaman', label: 'Judul halaman booking', default: 'Amankan jadwal sesi foto Anda' },
  {
    key: 'booking.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman booking',
    default: 'Isi detail di bawah. Harga muncul otomatis dari data resmi, dan detail booking Anda akan tersimpan saat form dikirim.'
  },
  { key: 'cities.title', group: 'Halaman', label: 'Judul halaman kota', default: 'Archives by Location' },
  {
    key: 'cities.description', group: 'Halaman', type: 'textarea', label: 'Deskripsi halaman kota',
    default: 'Select a city to explore our graduation photography collections and available sessions.'
  },

  // --- Footer & contact --------------------------------------------------
  {
    key: 'footer.about', group: 'Footer', type: 'textarea', label: 'Tentang singkat (footer)',
    default: 'Jasa fotografi wisuda individu, couple, dan group. Sesi yang tenang, hasil yang Anda simpan bertahun-tahun.'
  },
  { key: 'footer.hours_1', group: 'Footer', label: 'Jam layanan baris 1', default: 'Senin – Sabtu' },
  { key: 'footer.hours_2', group: 'Footer', label: 'Jam layanan baris 2', default: '08.00 – 20.00 WIB' },
  { key: 'footer.hours_note', group: 'Footer', type: 'textarea', label: 'Catatan jam layanan', default: 'Balasan pesan dapat sedikit tertunda saat sesi pemotretan berlangsung.' },
  { key: 'footer.copyright', group: 'Footer', label: 'Teks copyright', default: 'Seluruh hak cipta dilindungi.' }
];

const SECTION_DEFAULTS = [
  { section_key: 'hero', title: 'Hero slideshow', description: '', layout: 'fullscreen', sort_order: 0, is_active: 1 },
  { section_key: 'intro', title: 'Introduction', description: '', layout: 'split', sort_order: 1, is_active: 1 },
  { section_key: 'featured', title: 'Featured Portfolio', description: '', layout: 'grid-editorial', sort_order: 2, is_active: 1 },
  { section_key: 'carousel', title: 'Portfolio carousel', description: '', layout: 'carousel', sort_order: 3, is_active: 1 },
  { section_key: 'services', title: 'Our Services', description: '', layout: 'grid-4', sort_order: 4, is_active: 1 },
  { section_key: 'advantages', title: 'Why DLY', description: '', layout: 'grid-4', sort_order: 5, is_active: 1 },
  { section_key: 'packages', title: 'Featured Packages', description: '', layout: 'cards-3', sort_order: 6, is_active: 1 },
  { section_key: 'process', title: 'How to Order', description: '', layout: 'steps-3', sort_order: 7, is_active: 1 },
  { section_key: 'testimonials', title: 'Testimonials', description: '', layout: 'grid-3', sort_order: 8, is_active: 1 },
  { section_key: 'cta', title: 'Call to action', description: '', layout: 'band', sort_order: 9, is_active: 1 }
];

// Layouts each section supports (keeps layouts consistent with the design system).
const SECTION_LAYOUTS = {
  hero: ['fullscreen'],
  intro: ['split', 'centered', 'image-left'],
  services: ['grid-4', 'grid-2', 'list'],
  featured: ['grid-editorial', 'grid-3', 'split'],
  carousel: ['carousel', 'carousel-wide'],
  advantages: ['grid-4', 'grid-2', 'list'],
  packages: ['cards-3', 'cards-2', 'list'],
  process: ['steps-3', 'steps-4'],
  testimonials: ['grid-3', 'grid-2'],
  cta: ['band', 'centered']
};

const FONT_OPTIONS = [
  // Tahap 6 — pasangan editorial yang lebih berkarakter (heading serif + body humanis).
  { value: 'Fraunces', label: 'Fraunces (serif editorial, hangat)', stack: "'Fraunces', Georgia, 'Times New Roman', serif", google: 'Fraunces:opsz,wght@9..144,300..600', local: true },
  { value: 'Newsreader', label: 'Newsreader (serif majalah)', stack: "'Newsreader', Georgia, serif", google: 'Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,400' },
  { value: 'Instrument Serif', label: 'Instrument Serif (display tinggi kontras)', stack: "'Instrument Serif', Georgia, serif", google: 'Instrument+Serif:ital@0;1' },
  { value: 'Instrument Sans', label: 'Instrument Sans (sans natural)', stack: "'Instrument Sans', system-ui, sans-serif", google: 'Instrument+Sans:wght@400;500;600', local: true },
  { value: 'Karla', label: 'Karla (sans humanis)', stack: "'Karla', system-ui, sans-serif", google: 'Karla:wght@300;400;500;600' },
  { value: 'Cormorant Garamond', label: 'Cormorant Garamond (editorial serif)', stack: "'Cormorant Garamond', Georgia, 'Times New Roman', serif", google: 'Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400' },
  { value: 'Playfair Display', label: 'Playfair Display (serif tegas)', stack: "'Playfair Display', Georgia, serif", google: 'Playfair+Display:ital,wght@0,400;0,500;0,600;1,400' },
  { value: 'Manrope', label: 'Manrope (sans modern)', stack: "'Manrope', system-ui, sans-serif", google: 'Manrope:wght@300;400;500;600' },
  { value: 'Inter', label: 'Inter (sans netral)', stack: "'Inter', system-ui, sans-serif", google: 'Inter:wght@300;400;500;600' },
  // Montserrat self-hosted (public/fonts/montserrat-latin.woff2, variabel 300–700):
  // tidak lagi memicu request ke fonts.googleapis.com.
  { value: 'Montserrat', label: 'Montserrat (sans geometric)', stack: "'Montserrat', system-ui, sans-serif", google: 'Montserrat:wght@300;400;500;600;700', local: true },
  { value: 'Montserrat Light', label: 'Montserrat Light (tipis 300)', stack: "'Montserrat', system-ui, sans-serif", google: 'Montserrat:wght@300', weight: '300', local: true },
  { value: 'Montserrat Bold', label: 'Montserrat Bold (tebal 700)', stack: "'Montserrat', system-ui, sans-serif", google: 'Montserrat:wght@700', weight: '700', local: true },
  { value: 'Poppins', label: 'Poppins (sans modern)', stack: "'Poppins', system-ui, sans-serif", google: 'Poppins:wght@300;400;500;600;700' }
];

/** Families served from /fonts (self-hosted): no Google request, preloaded in the layout. */
const LOCAL_FONTS = FONT_OPTIONS.filter((f) => f.local).map((f) => f.value);

// Default rows used on the homepage AND pre-filled in the editor, so the owner can
// edit/remove what visitors already see instead of starting from an empty list.
const SECTION_ITEM_DEFAULTS = {
  services: [
    { title: 'Individual', description: 'Portrait wisuda satu orang — formal, casual, maupun editorial.', image: '/ph/portfolio-portrait-1.svg' },
    { title: 'Couple', description: 'Sesi berdua bersama pasangan, sahabat, atau keluarga.', image: '/ph/portfolio-couple.svg' },
    { title: 'Group', description: 'Satu angkatan, satu komunitas, atau circle terdekat.', image: '/ph/portfolio-group.svg' },
    { title: 'Graduation Event', description: 'Liputan acara wisuda dan momen selebrasi di sekitarnya.', image: '/ph/portfolio-event.svg' }
  ],
  advantages: [
    { title: 'Arahan yang ramah', description: 'Tidak perlu pandai berpose. Kami memandu setiap gerakan dengan santai, termasuk untuk sesi group.' },
    { title: 'Harga transparan', description: 'Setiap paket menampilkan harga sesuai durasi. Tidak ada biaya tersembunyi yang muncul belakangan.' },
    { title: 'Editing profesional', description: 'Warna dan retouch dikerjakan satu per satu agar hasilnya konsisten dan tetap natural.' },
    { title: 'Fleksibel pilih durasi', description: 'Durasi tersedia mengikuti paket yang Anda pilih — harga menyesuaikan secara otomatis.' }
  ],
  process: [
    { title: 'Pilih kota, kategori & paket', description: 'Tentukan kota layanan, kategori, paket, lalu durasi. Harga muncul otomatis dari data resmi.' },
    { title: 'Kirim detail booking', description: 'Isi data diri dan tanggal. Detail booking tersimpan dan diteruskan ke WhatsApp kami.' },
    { title: 'Konfirmasi admin', description: 'Admin menghubungi Anda untuk memastikan ketersediaan jadwal dan detail teknis.' }
  ]
};

const APPEARANCE_FIELDS = [
  { key: 'primary', label: 'Warna utama (deep navy)', type: 'color', default: '#0B2340' },
  { key: 'secondary', label: 'Warna aksen (muted teal)', type: 'color', default: '#2C5E73' },
  { key: 'background', label: 'Warna background', type: 'color', default: '#F7F6F2' },
  { key: 'text', label: 'Warna teks', type: 'color', default: '#252A30' },
  { key: 'border', label: 'Warna border', type: 'color', default: '#E3E5E7' },
  { key: 'font_heading', label: 'Font heading', type: 'font', default: 'Fraunces' },
  { key: 'font_body', label: 'Font body', type: 'font', default: 'Instrument Sans' },
  { key: 'logo', label: 'Logo (URL/path)', type: 'text', default: '' },
  { key: 'favicon', label: 'Favicon (URL/path)', type: 'text', default: '' },
  { key: 'button_style', label: 'Gaya tombol', type: 'select', default: 'square', options: [
    { value: 'square', label: 'Kotak (editorial)' },
    { value: 'soft', label: 'Sedikit membulat' },
    { value: 'pill', label: 'Pill' }
  ] },
  { key: 'section_spacing', label: 'Kerapatan section', type: 'select', default: 'comfortable', options: [
    { value: 'compact', label: 'Rapat' },
    { value: 'comfortable', label: 'Nyaman' },
    { value: 'airy', label: 'Legaan' }
  ] }
];

const APPEARANCE_PRESETS = [
  {
    value: 'minimal_navy',
    label: 'Minimal Navy',
    description: 'Default DLY Graduation — deep navy, warm white, editorial serif.',
    values: {
      primary: '#0B2340', secondary: '#2C5E73', background: '#F7F6F2', text: '#252A30',
      border: '#E3E5E7', font_heading: 'Fraunces', font_body: 'Instrument Sans',
      button_style: 'soft', section_spacing: 'comfortable'
    }
  },
  {
    value: 'editorial_classic',
    label: 'Editorial Classic',
    description: 'Navy + warm white dengan serif editorial (Fraunces) dan body humanis.',
    values: {
      primary: '#0B2340', secondary: '#2C5E73', background: '#F7F6F2', text: '#252A30',
      border: '#E3E5E7', font_heading: 'Fraunces', font_body: 'Instrument Sans',
      button_style: 'square', section_spacing: 'airy'
    }
  },
  {
    value: 'editorial_warm',
    label: 'Editorial Warm',
    description: 'Nuansa hangat seperti majalah — espresso, tan, warm white.',
    values: {
      primary: '#2A2320', secondary: '#8C6B4A', background: '#FAF6EF', text: '#2A2724',
      border: '#E6DED2', font_heading: 'Playfair Display', font_body: 'Manrope',
      button_style: 'square', section_spacing: 'airy'
    }
  },
  {
    value: 'clean_neutral',
    label: 'Clean Neutral',
    description: 'Netral dan bersih untuk tampilan studio modern.',
    values: {
      primary: '#111827', secondary: '#5B6773', background: '#FFFFFF', text: '#1F2937',
      border: '#E5E7EB', font_heading: 'Cormorant Garamond', font_body: 'Inter',
      button_style: 'soft', section_spacing: 'compact'
    }
  }
];

function defaultContentMap() {
  const map = {};
  CONTENT_FIELDS.forEach((f) => { map[f.key] = f.default; });
  APPEARANCE_FIELDS.forEach((f) => { map['appearance.' + f.key] = f.default; });
  map['appearance.preset'] = 'minimal_navy';
  return map;
}

module.exports = {
  CONTENT_FIELDS,
  SECTION_DEFAULTS,
  SECTION_LAYOUTS,
  SECTION_ITEM_DEFAULTS,
  FONT_OPTIONS,
  LOCAL_FONTS,
  APPEARANCE_FIELDS,
  APPEARANCE_PRESETS,
  defaultContentMap
};
