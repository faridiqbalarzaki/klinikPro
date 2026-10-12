// Kumpulan balasan CONVERSATIONAL (hangat, kontekstual, soft-selling) + memori percakapan ringan.
//
// Semua kalimat ditulis manual (bukan hasil AI) dan hanya memakai fakta yang sudah ada di
// templates.js / SOP toko (harga, BPOM, COD, keep order, ekspedisi, estimasi, gudang).
// Ubah harga / klaim promo HANYA di blok PRICE & FACT di bawah, bukan di tiap kalimat.
//
// Teks tahap utama funnel (T.salam, PT.askComplaint, katalog harga, form order) TIDAK diubah:
// itu SOP. File ini dipakai untuk balasan di LUAR jalur utama: keberatan, pertanyaan umum
// (ongkir/COD/BPOM/dst), sapaan di tengah alur, dan tanya-ulang.

const PRICE = {
  lengkap: "Rp 349.000", // Paket 1: 1 Day + 1 Night + 1 Collagen Soap, GRATIS ongkir
  lengkapNormal: "Rp 550.000",
  premium: "Rp 250.000", // Paket 2: 1 Day + 1 Night, belum ongkir
  sabun: "Rp 279.000", // Paket 3: 3 Collagen Soap, GRATIS ongkir
};

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const mems = new Map(); // jid -> memori percakapan (in-memory; hilang saat restart)

function getMem(jid) {
  const now = Date.now();
  let m = mems.get(jid);
  if (!m || now - m.at > MEM_TTL_MS) {
    if (mems.size > 5000) mems.clear();
    m = { at: now, complaint: null, kecamatan: null, objections: 0, faqs: 0, lastTopic: null, last: {} };
    mems.set(jid, m);
  }
  m.at = now;
  return m;
}

// Pilih salah satu varian, hindari mengulang varian yang sama persis dengan sebelumnya.
function pick(mem, key, arr) {
  if (arr.length === 1) return arr[0];
  let i = Math.floor(Math.random() * arr.length);
  if (i === mem.last[key]) i = (i + 1) % arr.length;
  mem.last[key] = i;
  return arr[i];
}

// ------------------------------------------------------------------
// CTA / ajakan lanjut sesuai stage (selalu menutup balasan di luar jalur utama)
// ------------------------------------------------------------------
function cta(stage, mem) {
  const c = mem.complaint;
  if (stage >= 3) {
    return pick(mem, "cta3", [
      `Mau Lizel bantu pilihkan paketnya Kak? ${c ? `Buat keluhan ${c} Kakak, ` : ""}*Paket Lengkap* lagi promo hari ini + GRATIS ongkir lho 🥰`,
      `Kalau Kakak sudah ada gambaran, Lizel bantu proses sekarang ya 😍 *Paket Lengkap* paling banyak dipilih & lagi GRATIS ongkir 📦`,
      `Mumpung harga promonya masih jalan hari ini Kak 🥰 Mau Lizel bantu ambilkan *Paket Lengkap* atau *Day & Night*?`,
    ]);
  }
  if (stage === 2) {
    return pick(mem, "cta2", [
      "Oh iya Kak, domisili Kakak di kecamatan mana nih? Lizel cekin promo & estimasi kirim ke lokasinya ya 📦💖",
      "Biar Lizel bisa cek promo + ongkir yang pas, boleh tau Kecamatan Kakak? 🥰",
    ]);
  }
  return pick(mem, "cta1", [
    "Btw, keluhan kulit Kakak apa nih? Biar Lizel rekomendasiin paket yang paling cocok 💖",
    "Boleh cerita dulu keluhan kulitnya Kak? Nanti Lizel kasih saran paket yang paling pas + promo hari ini ✨",
  ]);
}

// ------------------------------------------------------------------
// Pertanyaan umum (FAQ): jawab langsung, nyambung, tanpa mengulang menu awal
// ------------------------------------------------------------------
const FAQ = {
  SHIPPING: [
    `Pengiriman Lizel kirim dari 3 gudang (Bandung, Malang, Lombok), nanti dipilih yang paling dekat dengan Kakak 🚚\n\nEstimasi sampai: Pulau Jawa-Bali sekitar 3-5 hari, luar Jawa sekitar 6-7 hari ya Kak. Ekspedisinya ada JNT, JNE, ID Express, SAP, dan Lion Parcel 📦\n\nKabar baiknya, *Paket Lengkap* & paket sabun lagi *GRATIS ongkir* 🎉`,
    `Siap Kak 🥰 Lizel kirim dari gudang terdekat (Bandung / Malang / Lombok). Estimasi 3-5 hari untuk Jawa-Bali dan 6-7 hari untuk luar Jawa. Pilihan ekspedisi: JNT, JNE, ID Express, SAP, Lion Parcel 🚚\n\nOh iya, promo hari ini *Paket Lengkap GRATIS ongkir* lho Kak 😍`,
  ],
  COD: [
    `Bisa banget Kak, *COD* tersedia ke seluruh Indonesia 🥰 Jadi Kakak bayarnya nanti pas paket sudah sampai, lebih tenang & aman ya.\n\nCuma mohon nomor HP tetap aktif supaya kurir gampang menghubungi Kakak 📲 Ketentuan singkatnya nanti Lizel jelasin saat order ya.`,
    `Tenang Kak, bisa *COD* kok, bayar di tempat pas paketnya datang 📦💖 Nomor HP tolong tetap aktif ya biar kurirnya bisa hubungi Kakak.`,
  ],
  SAFETY: [
    `Tenang Kak 🤍 Fix Nutri sudah *terdaftar BPOM* & *bersertifikat halal*, dan tidak mengandung merkuri maupun steroid.\n\nNomor BPOM-nya:\n• Day Cream: NA18260107073\n• Night Cream: NA18260107075\n• Collagen Beauty Soap: NA18260500504\n\nBisa Kakak cek sendiri ya. Kalau Kakak sedang hamil/menyusui atau punya kondisi kulit khusus, boleh konsultasi ke dokter juga biar makin mantap 🙏`,
  ],
  USAGE: [
    `Gampang kok Kak 🥰 *Day Cream* dipakai pagi hari, *Night Cream* dipakai malam sebelum tidur, dan *Collagen Soap* untuk bersih-bersih rutin. Pakai rutin sesuai aturan pakainya ya biar hasilnya maksimal ✨\n\nPanduan lengkapnya nanti Lizel kirim lagi saat paket Kakak diproses 💖`,
  ],
  RESULT: [
    `Hasilnya beda-beda tiap orang ya Kak 🤍 Tergantung kondisi kulit & seberapa rutin pemakaiannya, ada yang cepat terasa, ada yang butuh waktu lebih lama. Makanya Lizel nggak janjiin yang instan, kuncinya rutin & sabar 🥰\n\nPaket Lengkapnya untuk pemakaian sekitar 12 hari, jadi Kakak sudah bisa lihat progres kulitnya 😊`,
  ],
  AUTHENTIC: [
    `Yang asli itu diproduksi *PT Botryo Herba Bioteknologi* dan didistribusikan resmi oleh *PT Sastro Digital Asia*, Kak 🤍 Di belakang box juga ada barcode BPOM-nya.\n\nHati-hati ya Kak, di marketplace banyak yang palsu. Di sini Kakak dapat produk original lewat konsultasi langsung dengan Lizel 🥰`,
  ],
  AGE: [
    `Bisa banget Bunda 🌸 Rangkaian Fix Nutri D&N Cream ini cocok juga untuk usia 50 tahun ke atas, asal dipakai sesuai anjuran dan rutin ya 🥰`,
  ],
};

// topik tak dikenal -> jawaban netral yang tetap mengarahkan lanjut
function faqBody(topic, mem) {
  const v = FAQ[topic];
  return v ? pick(mem, `faq:${topic}`, v) : null;
}

// ------------------------------------------------------------------
// Keberatan (objection): empati -> nilai (BPOM) -> solusi hemat / promo. Tidak defensif.
// n = urutan keberatan dari customer ini (1 = pertama).
// ------------------------------------------------------------------
const OBJECTION = {
  mahal: {
    1: () =>
      `Iya Kak, Lizel ngerti banget, wajar kok kalau mikirin budget dulu 🥰\n\nProduk kita sudah *terdaftar BPOM* & *bersertifikat halal*, jadi soal kualitas & keamanan Kakak bisa tenang 🤍\n\nBiar lebih ringan, ada 2 pilihan:\n💖 *Paket Day & Night* ${PRICE.premium} (1 Day + 1 Night Cream)\n✨ *Paket Lengkap* ${PRICE.lengkap} (dari ${PRICE.lengkapNormal}, dapat tambahan Collagen Soap + *GRATIS ongkir*). Kalau dihitung justru lebih hemat Kak, dan promonya berlaku hari ini 😍\n\nKakak cocoknya yang mana?`,
    2: () =>
      `Lizel paham Kak 🙏 Biar makin ringan, bisa *COD* (bayar pas paket sampai) dan Kakak juga bisa *keep order* dulu supaya tetap kebagian harga promo, pengirimannya sesuai tanggal yang Kakak mau 🥰\n\nMau Lizel bantu catat paket yang mana Kak?`,
  },
  paksu: {
    1: () =>
      `Wah bagus Kak, memang enaknya diskusi dulu sama suami 🥰 Biar gampang jelasinnya: produk kita *BPOM & halal*, tidak mengandung merkuri maupun steroid, dan bisa *COD* jadi bayarnya pas paket sampai ya.\n\nMumpung promo & gratis ongkir hari ini masih jalan, Lizel bisa bantu keepin dulu harganya. Kakak mau lihat *Paket Lengkap* atau *Day & Night*? 💖`,
    2: () =>
      `Siap Kak 🥰 Kalau sudah dapat restu suami, kabarin Lizel aja ya, nanti langsung Lizel bantu proses. Biar harga promonya nggak kelewat, Kakak juga bisa *keep order* dulu kok, dikirim sesuai tanggal yang Kakak mau.\n\nMau Lizel keepin *Paket Lengkap*-nya?`,
  },
  nanti: {
    1: () =>
      `Siap Kak, nggak apa-apa kok 🥰 Cuma info aja ya, harga promo ini berlaku hari ini dan besok bisa kembali normal.\n\nKalau Kakak nunggu gajian atau belum siap sekarang, ada opsi *keep order*: Kakak isi data sekarang buat mengunci harga promo, paketnya dikirim sesuai tanggal yang Kakak mau, dan bisa *COD* juga 😊\n\nMau Lizel bantu kunciin harga promonya? Paket yang mana nih Kak?`,
    2: () =>
      `Oke Kak 🙏 Boleh Lizel tau yang bikin Kakak masih mikir apa? Soal harga, kecocokan kulit, atau pengiriman? Biar Lizel bantu jawab dengan jelas ya 🥰`,
  },
  ragu: {
    1: () =>
      `Wajar banget Kak kalau masih ragu, apalagi soal skincare 🤍\n\nYang bisa Lizel pastikan: produk kita *terdaftar BPOM*, *bersertifikat halal*, dan tidak mengandung merkuri maupun steroid. Hasil tiap orang memang beda tergantung kondisi kulit & rutin pemakaian, jadi Lizel nggak janjiin yang instan ya.\n\nKakak juga bisa pilih *COD* (bayar pas paket sampai) biar lebih tenang 🥰 Mau Lizel jelasin bagian yang bikin ragu, atau Kakak mau coba *Paket Day & Night* yang lebih ringan dulu?`,
    2: () =>
      `Boleh cerita Kak, yang bikin ragu itu apa? Soal kecocokan kulit, keamanan, atau hal lain? Lizel jawab satu-satu ya 🥰`,
  },
  lainnya: {
    1: () =>
      `Siap Kak, Lizel ngerti 🥰 Biar Kakak makin mantap: produk kita *BPOM & halal*, bisa *COD*, dan promo *Paket Lengkap GRATIS ongkir* masih jalan hari ini 😍\n\nAda yang mau Lizel jelasin dulu Kak?`,
    2: () =>
      `Boleh Lizel tau yang bikin Kakak masih berat apa Kak? Biar Lizel bantu cariin solusi yang paling pas 🥰`,
  },
};

function objectionReply(type, n, mem) {
  const t = OBJECTION[type] || OBJECTION.lainnya;
  const f = t[Math.min(n, 2)];
  return f ? f() : null;
}

// ------------------------------------------------------------------
// Sapaan / tidak paham di tengah alur (stage >= 1): TIDAK mengulang menu, cukup nyambung
// ------------------------------------------------------------------
function greetMid(stage, mem) {
  const hi = pick(mem, "hi", [
    "Halo Kak 🥰 Lizel masih di sini kok.",
    "Hai Kak 😊 Iya, Lizel di sini ya.",
    "Hai Kakak cantik 🌸 Lizel standby kok.",
  ]);
  return `${hi} ${cta(stage, mem)}`;
}

function confused(stage, mem) {
  const lead = pick(mem, "conf", [
    "Maaf Kak, Lizel belum nangkep maksudnya nih 🙏",
    "Hehe maaf Kak, Lizel kurang paham, boleh diulang pelan-pelan? 🙏",
  ]);
  return `${lead} ${cta(stage, mem)}`;
}

const HANDOFF = {
  objection: "Baik Kak 🥰 Biar Kakak dapat penawaran terbaik, Lizel sambungkan ke tim CS kami ya. Mohon ditunggu sebentar 🙏💖",
  cancel: "Baik Kak 🙏 Lizel sambungkan ke tim CS kami untuk bantu prosesnya ya. Mohon ditunggu sebentar 💖",
  many: "Biar Kakak dapat jawaban yang paling lengkap, Lizel sambungkan ke tim CS kami ya Kak 🥰 Mohon ditunggu sebentar 🙏",
};

module.exports = {
  PRICE,
  getMem,
  cta,
  faqBody,
  objectionReply,
  greetMid,
  confused,
  HANDOFF,
};
