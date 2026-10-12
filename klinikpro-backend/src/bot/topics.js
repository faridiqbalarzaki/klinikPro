// Deteksi TOPIK pertanyaan umum (FAQ) secara lokal, tanpa AI.
// Dipakai oleh intentParser.js (fallback saat Gemini mati) dan funnel.js.
// Input harus sudah dinormalisasi (priceFlow.normalizeText / slang.normalizeSlang).
const TOPICS = [
  "SHIPPING", // ongkir, estimasi, ekspedisi, resi, gudang
  "COD", // bayar di tempat
  "SAFETY", // BPOM, halal, aman, efek samping, busui, merkuri
  "USAGE", // cara / aturan pakai
  "RESULT", // berapa lama hasil, permanen
  "AUTHENTIC", // asli/palsu, marketplace, distributor
  "AGE", // cocok untuk usia 50+, bunda
];

// Urutan = prioritas bila beberapa topik muncul sekaligus.
const RULES = [
  ["AUTHENTIC", /(?:^| )(?:asli|palsu|ori|original|shopee|tokopedia|tiktok|lazada|marketplace|distributor|resmi)(?:nya|an|kah|lah)?(?: |$)/],
  ["AGE", /(?:^| )(?:usia|umur|lansia|bunda|ibu ibu|nenek)(?:nya|an|kah|lah)?(?: |$)/],
  ["SAFETY", /(?:^| )(?:bpom|halal|aman|efek samping|efek|merkuri|steroid|berbahaya|bahaya|ketergantungan|busui|hamil|menyusui|bumil|alergi|cocok)(?:nya|an|kah|lah)?(?: |$)/],
  ["COD", /(?:^| )(?:cod|bayar ditempat|bayar di tempat|bayar saat)(?:nya|an|kah|lah)?(?: |$)/],
  ["SHIPPING", /(?:^| )(?:ongkir|ongkos kirim|biaya kirim|kirim|pengiriman|ekspedisi|estimasi|resi|sampai|jne|jnt|sicepat|gudang|dikirim|nyampe|nyampai)(?:nya|an|kah|lah)?(?: |$)/],
  ["USAGE", /(?:^| )(?:cara pakai|cara pemakaian|aturan pakai|cara penggunaan|dipakai|pakainya|pemakaian|gimana pakai|bagaimana pakai)(?:nya|an|kah|lah)?(?: |$)/],
  ["RESULT", /(?:^| )(?:hasil|permanen|kapan terlihat|berapa lama|lama hasil|berapa hari)(?:nya|an|kah|lah)?(?: |$)/],
];

function detectTopic(normText) {
  const t = String(normText || "");
  for (const [topic, re] of RULES) if (re.test(t)) return topic;
  return null;
}

module.exports = { TOPICS, detectTopic };
