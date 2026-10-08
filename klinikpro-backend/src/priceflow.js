// State percakapan untuk alur konsultatif harga (consultative selling).
// In-memory: cukup karena worker WhatsApp berjalan satu proses (ada file lock).
// State hilang jika server restart, dan pelanggan kembali ke IDLE.
const STATES = Object.freeze({
  IDLE: "IDLE",
  WAITING_FOR_COMPLAINT: "WAITING_FOR_COMPLAINT",
});

// Dicocokkan di AWAL KATA, jadi "harganya" dan "berapaan" ikut terdeteksi.
const PRICE_KEYWORDS = ["harga", "biaya", "pricelist", "price list", "berapa"];

// Jika pelanggan tak membalas keluhan dalam waktu ini, kembali ke IDLE
const STATE_TTL_MS = Number(process.env.PRICE_STATE_TTL_MS) || 30 * 60 * 1000;

const ASK_COMPLAINT_TEXT =
  "Halo Kak! Untuk estimasi biaya perawatan, boleh ceritakan dulu keluhan atau masalah yang sedang dialami agar kami berikan rekomendasi yang pas?";

// Dipakai hanya jika tidak ada template harga di dashboard
const FALLBACK_PRICE_TEXT =
  "Terima kasih sudah bercerita, Kak 🙏\n\n" +
  "Berdasarkan keluhan Kakak, estimasi biaya perawatan kami mulai dari Rp XXX.000 " +
  "(final menyesuaikan hasil pemeriksaan langsung oleh dokter).\n\n" +
  "Mau kami jadwalkan konsultasi? Balas dengan tanggal & jam yang Kakak inginkan ya 😊";

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
  ASK_COMPLAINT_TEXT,
  FALLBACK_PRICE_TEXT,
  getState,
  setState,
};
