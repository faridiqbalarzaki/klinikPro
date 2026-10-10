const path = require("path");

// State percakapan untuk alur konsultatif harga (consultative selling).
// In-memory: cukup karena worker WhatsApp berjalan satu proses (ada file lock).
// State hilang jika server restart, dan pelanggan kembali ke IDLE.
const STATES = Object.freeze({
  IDLE: "IDLE",
  WAITING_FOR_COMPLAINT: "WAITING_FOR_COMPLAINT",
  DONE: "DONE",
  // Pelanggan sudah ditanya ulang melebihi batas tapi tetap tak menyebut keluhan:
  // SOP berhenti, CS yang menangani, harga otomatis ditahan.
  HANDOFF: "HANDOFF",
});

// Dicocokkan per KATA: awal kata harus pas, akhir kata hanya boleh diikuti
// imbuhan umum (an, nya, ku, ...) atau huruf yang dipanjangkan ("hargaaa").
const PRICE_KEYWORDS = [
  "harga",
  "biaya",
  "pricelist",
  "price list",
  "berapa",
  "brp",
];

// Kata keluhan. SOP solusi HANYA dipicu oleh kata/frasa di bawah ini
// (atau angka menu 1-6, foto, dan pesan suara). Tidak ada kata tunggal yang
// ambigu: "putih", "kering", "merata", "noda" sengaja DIHAPUS karena muncul di
// kalimat biasa ("Pasir Putih", "keringat", "pengiriman merata").
const COMPLAINT_KEYWORDS = [
  // 1. Kata tunggal kuat & spesifik
  "flek",
  "jerawat",
  "komedo",
  "kusam",
  "belang",
  "bruntusan",
  "glowing",
  "pencerah",
  "pemutih",
  "memutihkan",
  "putihin",

  // 2. Frasa kulit/wajah kering (termasuk kata ganti)
  "kulit kering",
  "wajah kering",
  "muka kering",
  "kulitku kering",
  "mukaku kering",
  "wajahku kering",

  // 3. Masalah warna & tekstur
  "kulit hitam",
  "wajah hitam",
  "muka hitam",
  "noda hitam",
  "bekas jerawat",
  "tidak merata",
  "gak merata",
  "ga merata",
  "nggak merata",
  "ndak merata",

  // 4. Frasa keinginan mencerahkan / memutihkan
  "mau putih",
  "pengen putih",
  "ingin putih",
  "bikin putih",
  "biar putih",
  "bisa putih",

  // 5. Keluhan umum lain (tambahan). Tetap frasa/kata spesifik, bukan kata
  // tunggal yang ambigu ("cerah", "gelap", "kasar", "luka" sendirian TIDAK memicu).
  "kulit sensitif",
  "wajah sensitif",
  "muka sensitif",
  "pori besar",
  "pori pori",
  "kulit berminyak",
  "wajah berminyak",
  "muka berminyak",
  "kulit kasar",
  "wajah kasar",
  "muka kasar",
  "kulit gelap",
  "wajah gelap",
  "muka gelap",
  "dekil",
  "kerutan",
  "keriput",
  "penuaan",
  "anti aging",
  "antiaging",
  "kulit kendur",
  "wajah kendur",
  "melasma",
  "hiperpigmentasi",
  "bopeng",
  "bekas luka",
  "kantung mata",
  "mata panda",
  "kemerahan",
  "mau cerah",
  "pengen cerah",
  "ingin cerah",
  "biar cerah",
  "bikin cerah",
  "cerahin",
  "mencerahkan",
  "kurang cerah",
  "tidak cerah",
  "gak cerah",
  "ga cerah",
  "nggak cerah",
];

// Pilihan menu angka 1-6: hanya dianggap keluhan jika pesannya cuma angka itu
const COMPLAINT_CHOICE_RE = /^[1-6][.)]?$/;

// Jika pelanggan tak membalas keluhan dalam waktu ini, kembali ke IDLE
const STATE_TTL_MS = Number(process.env.PRICE_STATE_TTL_MS) || 30 * 60 * 1000;

// Maks. berapa kali bot mengulang pertanyaan keluhan bila jawaban pelanggan
// belum mengandung keluhan. Lewat dari ini -> HANDOFF ke CS.
const _envReasks = parseInt(process.env.PRICE_MAX_REASKS, 10);
const MAX_REASKS = Number.isNaN(_envReasks) ? 2 : _envReasks;

// Lama status HANDOFF (SOP & harga otomatis berhenti untuk pelanggan itu)
const HANDOFF_TTL_MS =
  Number(process.env.PRICE_HANDOFF_TTL_MS) || 24 * 60 * 60 * 1000;

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
// Teks dinormalisasi dulu: huruf kecil, tanpa aksen, selain huruf/angka -> spasi.
function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Imbuhan yang boleh menempel di belakang kata kunci: "harganya", "jerawatan".
const SUFFIX = "(?:an|nya|ku|mu|kan|i|lah|kah|pun)?";

// Aturan kecocokan:
//  - AWAL kata harus pas (bukan di tengah kata)
//  - AKHIR kata: hanya imbuhan di atas, plus huruf terakhir boleh dipanjangkan
//    ("flekkk", "hargaaa"). Jadi "flek" tidak kena "fleksibel", "belang" tidak
//    kena "belanga".
//  - `tails` = lookahead tambahan per kata (dipakai untuk "berapa lama" dkk).
function buildKeywordRegex(keywords, tails = {}) {
  const parts = keywords.map((k) => {
    const body = normalizeText(k)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ /g, "\\s+");
    return body + (tails[k] || "");
  });
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${parts.join("|")})${SUFFIX}(?<=(\\p{L}))\\1*(?![\\p{L}])`,
    "iu",
  );
}

// "berapa lama / berapa kali / berapa hari ..." BUKAN pertanyaan harga
const NOT_DURATION =
  "(?!\\s+(?:lama|hari|kali|x|jam|menit|minggu|bulan|tahun|banyak|umur|usia)\\b)";

const PRICE_RE = buildKeywordRegex(PRICE_KEYWORDS, { berapa: NOT_DURATION });
const COMPLAINT_RE = buildKeywordRegex(COMPLAINT_KEYWORDS);

function isPriceQuestion(text) {
  return PRICE_RE.test(normalizeText(text));
}

// Hasil: null (bukan keluhan) atau { kind: "choice" | "keyword", keyword }.
// Dipakai inbox.js untuk log: kata mana yang memicu SOP.
function matchComplaint(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (COMPLAINT_CHOICE_RE.test(raw)) return { kind: "choice", keyword: raw };
  const m = COMPLAINT_RE.exec(normalizeText(raw));
  return m ? { kind: "keyword", keyword: m[0] } : null;
}

function isComplaint(text) {
  return matchComplaint(text) !== null;
}

// ---------- Kunci JID (SATU PINTU) ----------
// Semua Map di bawah memakai canonicalJid() sebagai key. Jangan pernah memakai
// remoteJid mentah sebagai key: "123@lid" dan "62812...@s.whatsapp.net" bisa
// orang yang sama (HP vs WhatsApp Web).
const store = new Map(); // key -> { state, at }
const lastConsultedMap = new Map(); // key -> timestamp
// Lama cooldown setelah konsultasi (SOP tidak diulang). Default 24 jam.
const COOLDOWN_MS =
  Number(process.env.PRICE_CONSULT_COOLDOWN_MS) || 24 * 60 * 60 * 1000;
const lidToPn = new Map(); // "123@lid" -> "62812...@s.whatsapp.net"

const stripDevice = (jid) =>
  String(jid || "")
    .trim()
    .replace(/:\d+@/, "@");

function canonicalJid(jid) {
  const j = stripDevice(jid);
  if (!j) return "";
  return j.endsWith("@lid") ? lidToPn.get(j) || j : j;
}

// Catat pasangan LID <-> nomor asli. Return true jika mapping baru/berubah.
// State & cooldown yang sudah tersimpan atas nama LID ikut dipindah ke nomor asli.
function registerLid(lid, pn) {
  const l = stripDevice(lid);
  const p = stripDevice(pn);
  if (!l.endsWith("@lid") || !p.endsWith("@s.whatsapp.net")) return false;
  if (lidToPn.get(l) === p) return false;
  lidToPn.set(l, p);

  const e = store.get(l);
  if (e) {
    const cur = store.get(p);
    if (!cur || e.at > cur.at) store.set(p, e);
    store.delete(l);
  }
  const t = lastConsultedMap.get(l);
  if (t) {
    lastConsultedMap.set(p, Math.max(t, lastConsultedMap.get(p) || 0));
    lastConsultedMap.delete(l);
  }
  return true;
}

// ---------- Persistensi (opsional) ----------
// priceFlow.js tidak tahu soal database. inbox.js memasang hook yang menyimpan
// dua hal yang harus tahan restart: cooldown konsultasi & status HANDOFF.
// Keduanya juga dipulihkan lewat restoreConsulted / restoreHandoff saat start.
let persistHook = null;
function setPersistHook(fn) {
  persistHook = typeof fn === "function" ? fn : null;
}
function emit(evt) {
  if (!persistHook) return;
  try {
    Promise.resolve(persistHook(evt)).catch(() => {});
  } catch (_) {}
}

function restoreConsulted(jid, ms) {
  const k = canonicalJid(jid);
  const t = Number(ms);
  if (!k || !t) return;
  lastConsultedMap.set(k, Math.max(t, lastConsultedMap.get(k) || 0));
}

function restoreHandoff(jid, untilMs) {
  const k = canonicalJid(jid);
  const until = Number(untilMs);
  if (!k || !(until > Date.now()) || store.has(k)) return;
  store.set(k, {
    state: STATES.HANDOFF,
    at: until - HANDOFF_TTL_MS,
    misses: 0,
  });
}

// ---------- State ----------
const ttlOf = (e) =>
  e.state === STATES.HANDOFF ? HANDOFF_TTL_MS : STATE_TTL_MS;

function getState(jid) {
  const k = canonicalJid(jid);
  if (!k) return STATES.IDLE;
  const e = store.get(k);
  if (!e) return STATES.IDLE;
  if (Date.now() - e.at > ttlOf(e)) {
    store.delete(k);
    return STATES.IDLE;
  }
  return e.state;
}

function setState(jid, state) {
  const k = canonicalJid(jid);
  if (!k) return;
  if (state === STATES.IDLE) {
    store.delete(k);
    return;
  }
  store.set(k, { state, at: Date.now(), misses: 0 });
  if (state === STATES.HANDOFF) {
    emit({ type: "handoff", jid: k, until: Date.now() + HANDOFF_TTL_MS });
  }
}

// Tambah hitungan "jawaban belum berisi keluhan" (sekaligus perpanjang TTL).
// Return jumlah terbaru; 0 jika tidak ada state aktif.
function bumpMisses(jid) {
  const k = canonicalJid(jid);
  const e = k ? store.get(k) : null;
  if (!e) return 0;
  e.misses = (e.misses || 0) + 1;
  e.at = Date.now();
  return e.misses;
}

function setConsultedNow(jid) {
  const k = canonicalJid(jid);
  if (!k) return;
  const now = Date.now();
  lastConsultedMap.set(k, now);
  emit({ type: "consulted", jid: k, at: now });
}

function hasConsultedWithin24h(jid) {
  const k = canonicalJid(jid);
  if (!k) return false;
  const lastTime = lastConsultedMap.get(k);
  if (!lastTime) return false;
  return Date.now() - lastTime < COOLDOWN_MS;
}

// Bersihkan entri kadaluarsa supaya Map tidak membengkak
setInterval(
  () => {
    const now = Date.now();
    for (const [k, e] of store) if (now - e.at > ttlOf(e)) store.delete(k);
    for (const [k, t] of lastConsultedMap)
      if (now - t > COOLDOWN_MS) lastConsultedMap.delete(k);
  },
  10 * 60 * 1000,
).unref();

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

  MAX_REASKS,
  COOLDOWN_MS,
  HANDOFF_TTL_MS,
  normalizeText,
  isPriceQuestion,
  isComplaint,
  matchComplaint,

  // Kunci JID (satu pintu)
  stripDevice,
  canonicalJid,
  registerLid,

  getState,
  setState,
  bumpMisses,

  setConsultedNow,
  hasConsultedWithin24h,

  // Persistensi
  setPersistHook,
  restoreConsulted,
  restoreHandoff,
};
