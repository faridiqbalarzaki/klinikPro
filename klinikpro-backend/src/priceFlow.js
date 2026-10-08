const path = require("path");

// State percakapan untuk alur konsultatif harga (consultative selling).
// In-memory: cukup karena worker WhatsApp berjalan satu proses (ada file lock).
// State hilang jika server restart, dan pelanggan kembali ke IDLE.
const STATES = Object.freeze({
  IDLE: "IDLE",
  WAITING_FOR_COMPLAINT: "WAITING_FOR_COMPLAINT",
  DONE: "DONE",
});

// Dicocokkan di AWAL KATA, jadi "harganya" dan "berapaan" ikut terdeteksi.
const PRICE_KEYWORDS = ["harga", "biaya", "pricelist", "price list", "berapa"];

// Kata keluhan (juga di AWAL KATA). Tambah kata baru di sini bila perlu.
const COMPLAINT_KEYWORDS = [
  "flek",
  "jerawat",
  "putih",
  "kering",
  "merata",
  "glowing",
];

// Pilihan menu angka 1-6: hanya dianggap keluhan jika pesannya cuma angka itu
const COMPLAINT_CHOICE_RE = /^[1-6][.)]?$/;

// Jika pelanggan tak membalas keluhan dalam waktu ini, kembali ke IDLE
const STATE_TTL_MS = Number(process.env.PRICE_STATE_TTL_MS) || 30 * 60 * 1000;

// Teks SOP: harus persis, jangan diubah
const ASK_COMPLAINT_TEXT =
  "Hallo kakak sebelum keharga bisa di konsultasikan yaah keluhannya apa? Biar aku bantu untuk kasih saran yang paling cocok untuk kakak 💖✨";

// ---------- Alur solusi setelah keluhan (dipakai inbox.js) ----------
// Folder gambar: klinikpro-backend/assets/ (bisa diganti lewat ASSET_DIR di .env)
const ASSET_DIR = process.env.ASSET_DIR || path.join(__dirname, "..", "assets");

// Path gambar sesuai dengan ekstensi .jpeg di folder assets
const IMAGE_PRODUCT_PATH = path.join(ASSET_DIR, "awal.jpeg");
const IMAGE_TESTI_PATH = path.join(ASSET_DIR, "akhir.jpeg");

// Variabel bawaan tetap dipertahankan agar tidak bentrok dengan inbox.js
const IMAGE_AWAL_PATH = IMAGE_PRODUCT_PATH;
const IMAGE_TESTI_PATHS = [1, 2, 3, 4].map((n) =>
  path.join(ASSET_DIR, `testi${n}.jpeg`),
);
const IMAGE_AKHIR_PATH = IMAGE_TESTI_PATH;

const STEP1_DELAY_MS = 1500; // jeda setelah teks sapaan
const STEP2_DELAY_MS = 2000; // jeda antar gambar berikutnya

// Teks SOP 3 Langkah
const STEP1_SOLUSI_TEXT = "Lizel bantu berikan solusi yaa kak say🤗";

const STEP2_PRODUCT_CAPTION = [
  "✨ PAKET GLOWING 12 HARI - FIX NUTRI D&N CREAM ✨",
  "",
  "Paket lengkap 3 rangkaian perawatan:",
  "",
  "☀️ Day Cream - membantu mencerahkan kulit dan melindungi kulit saat beraktivitas",
  "🌙 Night Cream - membantu menyamarkan flek dan noda hitam saat kulit beristirahat di malam hari",
  "🧼 Collagen Beauty Soap - membersihkan lembut dan membantu menjaga kelembapan kulit",
  "",
  "💖 Manfaat yang bisa Kakak rasakan:",
  "• Mencerahkan kulit wajah",
  "• Menyamarkan flek dan noda hitam",
  "• Membantu menjaga skin barrier",
  "• Kulit tampak lebih lembap, halus, dan glowing merata",
  "",
  "Gunakan rutin sesuai aturan pakai ya Kak 🤍",
].join("\n");

const STEP3_TESTI_CAPTION =
  "✨ FIX NUTRI GLOW SERIES✨\n\n" +
  "🤍 Produk ini tidak mengandung merkuri maupun steroid, sehingga aman digunakan sesuai aturan pakai dan tidak menyebabkan ketergantungan.\n\n" +
  "✅ Sudah terdaftar BPOM\n" +
  "✅ Bersertifikat Halal\n" +
  "✅ Cocok digunakan untuk perawatan kulit sehari-hari\n\n" +
  "😊 Boleh tahu ya Kak, saat ini Kakak berdomisili di Kecamatan mana? Nanti aku cek promo dan estimasi pengiriman ke lokasi Kakak. 📦💖";

// Dipakai hanya jika tidak ada template harga di dashboard

// ---------- Pencocokan kata kunci ----------
function buildStartOfWordRegex(keywords) {
  const parts = keywords.map((k) =>
    k
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+"),
  );
  // Awal kata: didahului awal teks atau karakter non huruf/angka
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})`, "iu");
}

const PRICE_RE = buildStartOfWordRegex(PRICE_KEYWORDS);
const COMPLAINT_RE = buildStartOfWordRegex(COMPLAINT_KEYWORDS);

function isPriceQuestion(text) {
  return PRICE_RE.test(String(text || ""));
}

function isComplaint(text) {
  const t = String(text || "").trim();
  return COMPLAINT_CHOICE_RE.test(t) || COMPLAINT_RE.test(t);
}

// ---------- State ----------
const store = new Map(); // jid -> { state, at }

function getState(jid) {
  const e = store.get(jid);
  if (!e) return STATES.IDLE;
  if (Date.now() - e.at > STATE_TTL_MS) {
    store.delete(jid);
    return STATES.IDLE;
  }
  return e.state;
}

function setState(jid, state) {
  if (state === STATES.IDLE) store.delete(jid);
  else store.set(jid, { state, at: Date.now() });
}

module.exports = {
  STATES,
  PRICE_KEYWORDS,
  COMPLAINT_KEYWORDS,
  ASK_COMPLAINT_TEXT,

  // Ekspor Path Gambar
  IMAGE_PRODUCT_PATH,
  IMAGE_TESTI_PATH,
  IMAGE_AWAL_PATH,
  IMAGE_TESTI_PATHS,
  IMAGE_AKHIR_PATH,

  // Ekspor Delay
  STEP1_DELAY_MS,
  STEP2_DELAY_MS,

  // Ekspor Teks
  STEP1_SOLUSI_TEXT,
  STEP2_PRODUCT_CAPTION,
  STEP3_TESTI_CAPTION,
  STEP_AKHIR_CAPTION: STEP3_TESTI_CAPTION, // Alias agar kode lama tidak terganggu

  isPriceQuestion,
  isComplaint,
  getState,
  setState,
};
