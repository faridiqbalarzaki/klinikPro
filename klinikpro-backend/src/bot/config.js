const path = require("path");

const cfg = {
  // klinikpro-backend/assets (sama dengan priceFlow.js). Bisa diganti lewat ASSET_DIR di .env
  ASSETS_DIR:
    process.env.ASSET_DIR || path.join(__dirname, "..", "..", "assets"),
  DELAY_WELCOME_MS: 1000, // jeda welcomeAds -> salam (sesuai blueprint)
  DELAY_BETWEEN_MS: 800, // jeda antar pesan funnel berurutan
  // Jeda antar gambar pada slash command (/bukti, /carapakai): 2 dtk + acak 0-500 ms (anti-spam)
  MEDIA_GAP_MS: Number(process.env.MEDIA_GAP_MS) || 2000,
  MEDIA_GAP_JITTER_MS: 500,
  CAPTION_LIMIT: 1024, // caption lebih panjang dikirim sebagai teks terpisah
  // true  = funnel hanya untuk nomor BARU (belum ada di tabel customers).
  //         Pelanggan lama / penerima broadcast FU langsung dianggap HANDOFF.
  // false = semua nomor tanpa sesi bot ikut funnel.
  NEW_LEADS_ONLY: process.env.FUNNEL_NEW_LEADS_ONLY !== "false",
  // Setelah CS memakai slash command di sebuah chat, chat itu otomatis HANDOFF
  HANDOFF_ON_CS_COMMAND: process.env.HANDOFF_ON_CS_COMMAND !== "false",
  // Pesan CS lebih tua dari ini (detik) diabaikan (cegah command lama dari sinkronisasi riwayat)
  COMMAND_MAX_AGE_S: 60,

  // Debounce: pesan beruntun dari satu nomor digabung, bot membalas SEKALI setelah jeda ini
  DEBOUNCE_MS: Number(process.env.FUNNEL_DEBOUNCE_MS) || 3500,
  // Batas tunggu total: customer yang mengetik terus-menerus tetap dibalas setelah selama ini
  DEBOUNCE_MAX_WAIT_MS:
    Number(process.env.FUNNEL_DEBOUNCE_MAX_WAIT_MS) || 15000,

  // Status HANDOFF = bot 100% diam. Pesan customer HANDOFF tetap diteruskan ke inbox.js
  // HANYA untuk dicatat sebagai tiket (tanpa auto-reply / SOP harga / konsultatif).
  // Set SILENT_IN_HANDOFF=false jika pelanggan lama masih ingin dilayani auto-reply inbox.js.
  SILENT_IN_HANDOFF: process.env.SILENT_IN_HANDOFF !== "false",

  // Satu kali kirim yang menggantung (jaringan putus tanpa error) dibatalkan setelah ini,
  // supaya antrean chat itu tidak macet selamanya.
  SEND_TIMEOUT_MS: Number(process.env.SEND_TIMEOUT_MS) || 45000,
  // Indikator "sedang mengetik..." sebelum tiap pesan funnel + variasi acak jeda antar pesan
  TYPING_MIN_MS: 700,
  TYPING_MAX_MS: 1800,
  GAP_JITTER_MS: 600,

  // Anti-ghosting: customer menggantung di stage 1-3 -> kirim template /stuck (sekali per sesi)
  STUCK_ENABLED: process.env.STUCK_ENABLED !== "false",
  STUCK_AFTER_MIN: Number(process.env.STUCK_AFTER_MIN) || 25,
  // Sesi yang sudah menggantung lebih lama dari ini TIDAK dikirimi (cegah kirim massal setelah server mati lama)
  STUCK_MAX_AGE_MIN: Number(process.env.STUCK_MAX_AGE_MIN) || 360,
  STUCK_CHECK_MS: 60 * 1000,
  STUCK_BATCH: 3, // maks. dikirim per pengecekan (jeda antar kirim 4-8 detik)

  // Keberatan (mahal/ragu/nanti): bot menjawab dulu sebanyak ini, setelahnya diserahkan ke CS.
  MAX_OBJECTION_REPLIES: Number(process.env.FUNNEL_MAX_OBJECTION_REPLIES) || 2,
  // Pertanyaan umum (ongkir/COD/BPOM...) yang dijawab bot per sesi sebelum diserahkan ke CS.
  MAX_FAQ_REPLIES: Number(process.env.FUNNEL_MAX_FAQ_REPLIES) || 6,

  // AI Intent Parser (Gemini Flash). Kosongkan GEMINI_API_KEY / set AI_PARSER_ENABLED=false
  // untuk mematikan; bot otomatis memakai regex lokal saja.
  AI_API_KEY: process.env.GEMINI_API_KEY || "",
  AI_ENABLED:
    process.env.AI_PARSER_ENABLED !== "false" && !!process.env.GEMINI_API_KEY,
  AI_MODEL: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
  AI_TIMEOUT_MS: Number(process.env.AI_TIMEOUT_MS) || 2500,
  // Keyakinan minimum agar hasil AI dipakai funnel (di bawah ini -> hanya aturan lokal)
  AI_MIN_CONFIDENCE: Number(process.env.AI_MIN_CONFIDENCE) || 0.7,
  // Ambang khusus OBJECTION (lebih rendah: salah tangkap = handoff CS, lolos = form ke customer yang menawar)
  AI_OBJECTION_MIN_CONFIDENCE:
    Number(process.env.AI_OBJECTION_MIN_CONFIDENCE) || 0.5,
  AI_MAX_CONCURRENT: Number(process.env.AI_MAX_CONCURRENT) || 5,
  // Circuit breaker: sekian kali gagal beruntun -> lewati AI selama cooldown
  AI_CIRCUIT_FAILS: 3,
  AI_CIRCUIT_COOLDOWN_MS: 60 * 1000,
  AI_CACHE_SIZE: 500,
  AI_CACHE_TTL_MS: 10 * 60 * 1000,
  AI_MAX_INPUT_CHARS: 600,
};

// Jeda dasar + acak 0..GAP_JITTER_MS (pola kirim tidak seragam = tidak terlihat seperti robot)
cfg.gap = (base) => base + Math.floor(Math.random() * (cfg.GAP_JITTER_MS + 1));
cfg.typingMs = () =>
  cfg.TYPING_MIN_MS +
  Math.floor(Math.random() * (cfg.TYPING_MAX_MS - cfg.TYPING_MIN_MS + 1));

// Jeda dinamis antar gambar pada slash command
cfg.mediaGap = () =>
  cfg.MEDIA_GAP_MS + Math.floor(Math.random() * (cfg.MEDIA_GAP_JITTER_MS + 1));

module.exports = cfg;
