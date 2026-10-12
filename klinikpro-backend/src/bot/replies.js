// Kumpulan balasan CONVERSATIONAL (hangat, kontekstual, soft-selling)
// Kalimat disesuaikan murni dengan gaya bahasa Admin Lizel di chat aslinya,
// tanpa promo buatan/ngarang di luar konteks screenshot.

const PRICE = {
  lengkap: "Rp 349.000",
  lengkapNormal: "Rp 550.000",
  premium: "Rp 250.000",
  sabun: "Rp 279.000",
};

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const mems = new Map();

function getMem(jid) {
  const now = Date.now();
  let m = mems.get(jid);
  if (!m || now - m.at > MEM_TTL_MS) {
    if (mems.size > 5000) mems.clear();
    m = {
      at: now,
      complaint: null,
      kecamatan: null,
      objections: 0,
      faqs: 0,
      lastTopic: null,
      last: {},
    };
    mems.set(jid, m);
  }
  m.at = now;
  return m;
}

function pick(mem, key, arr) {
  if (arr.length === 1) return arr[0];
  let i = Math.floor(Math.random() * arr.length);
  if (i === mem.last[key]) i = (i + 1) % arr.length;
  mem.last[key] = i;
  return arr[i];
}

// ------------------------------------------------------------------
// CTA (Call to Action) - Menggunakan template asli dari screenshot
// ------------------------------------------------------------------
function cta(stage, mem) {
  const c = mem.complaint;
  if (stage >= 3) {
    return pick(mem, "cta3", [
      "Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?",
      "Besok/lusa harga kembali normal, jadi jauh lebih mahal lagi kalau kk order besok 🙏😊 Yuk Lizel bantu proses datanya sekarang kak say?",
    ]);
  }
  if (stage === 2) {
    return pick(mem, "cta2", [
      "Oh iya Kak, domisili Kakak kirim ke kabupaten atau kecamatan mana nih? Biar Lizel cek estimasinya 📦💖",
      "Biar Lizel bantu cek ongkirnya, mau dikirim ke daerah mana nih kak say? 🥰",
    ]);
  }
  return pick(mem, "cta1", [
    "Apa nih keluhan kakak cantik? 😊 Biar Lizel bantu rekomendasikan produk yang paling sesuai 💖",
    "Boleh cerita dulu keluhan kulitnya Kak? Nanti Lizel kasih saran paket yang paling pas untuk kondisi kulit kakak ✨",
  ]);
}

// ------------------------------------------------------------------
// FAQ - Jawaban disesuaikan tanpa janji promo fiktif
// ------------------------------------------------------------------
const FAQ = {
  SHIPPING: [
    `Pengiriman kita aman ya Kak, bisa menjangkau lokasi Kakak 🚚. Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
    `Bisa banget Kak 🥰 Nanti dikirim dari gudang resmi kita yang terdekat. Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
  ],
  COD: [
    `Bisa banget Kak, kita via COD 🥰 Jadi Kakak bayarnya nanti pas paket sudah sampai ke tangan Kakak ya.`,
    `Tenang Kak, bisa COD kok, bayar di kurir pas paketnya datang 📦💖 Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
  ],
  SAFETY: [
    `Tenang Kak 🤍 Fix Nutri sudah terdaftar BPOM & halal, aman tanpa merkuri atau steroid Kak 🙏😊 Kakak bisa buktikan sendiri manfaatnya ya.`,
  ],
  USAGE: [
    `Gampang kok Kak 🥰 Day Cream dipakai pagi hari, Night Cream dipakai malam sebelum tidur. Pakai rutin biar kulit tampak lebih sehat, lembap dan glowing ✨`,
  ],
  RESULT: [
    `Hasilnya sesuai dengan rutinitas pemakaian Kakak ya 🤍 Karena produk kita BPOM jadi prosesnya aman dan tidak instan yang berbahaya. Kakak bisa buktikan sendiri manfaatnya nanti 🥰`,
  ],
  AUTHENTIC: [
    `Kita toko resmi ya Kak 🤍 Hati-hati barang murah di luar sana kadang tidak asli atau tidak ada manfaatnya sama sekali Kak 🙏😊 Di sini terjamin original.`,
  ],
  AGE: [
    `Bisa banget Kak say 🌸 Rangkaian Fix Nutri ini cocok untuk berbagai usia untuk menjaga skin barrier tetap sehat dan glowing 🥰`,
  ],
};

function faqBody(topic, mem) {
  const v = FAQ[topic];
  return v ? pick(mem, `faq:${topic}`, v) : null;
}

// ------------------------------------------------------------------
// OBJECTION HANDLING - Merujuk ketat pada screenshot
// ------------------------------------------------------------------
const OBJECTION = {
  mahal: {
    1: () =>
      `Itu sudah harga rata-rata ya kak itu sudah diskon jadi itu tidak mahal kak soalnya juga sesuai dengan manfaatnya Kakak bisa buktikan sendiri 🙏😊 Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
    2: () =>
      `Iya Kak, dibanding barang murah yang kadang tidak asli atau tidak ada manfaatnya sama sekali, Fix Nutri ini lebih terjamin kualitasnya Kak 🙏😊 Besok/lusa harga kembali normal lho, jadi jauh lebih mahal lagi kalau kk order besok. Mau Lizel bantu proses sekarang? 🥰`,
  },
  nanti: {
    1: () =>
      `Siap Kak, nggak apa-apa kok 🥰 Cuma info aja ya Kak, besok/lusa harga kembali normal, jadi jauh lebih mahal lagi kalau kk order besok 🙏😊\n\nMumpung hari ini gratis ongkir via COD, mau Lizel bantu proses datanya sekarang aja kah kak say?`,
    2: () =>
      `Baik Kak 🙏 Boleh Lizel tau yang bikin Kakak masih mikir apa? Biar Lizel bantu jawab dan kasih saran paling cocok untuk Kakak cantik 💖✨`,
  },
  paksu: {
    1: () =>
      `Wah bagus Kak, memang enaknya didiskusikan dulu sama suami 🥰 Biar gampang jelasinnya: produk kita BPOM & aman, dan bisa via COD jadi bayarnya pas paket sampai ya.\n\nSekadar info, besok/lusa harga kembali normal, jadi jauh lebih mahal kalau order besok 🙏😊 Mau Lizel bantu keep datanya dulu?`,
    2: () =>
      `Siap Kak 🥰 Kalau sudah dapat izin suami, kabarin Lizel aja ya. Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
  },
  ragu: {
    1: () =>
      `Wajar Kak kalau masih ragu 🥰 Tapi Kakak nggak perlu khawatir, produk kita BPOM dan soalnya juga sesuai dengan manfaatnya Kakak bisa buktikan sendiri 🙏😊\n\nMumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
    2: () =>
      `Boleh cerita Kak, yang bikin ragu bagian apanya? Biar Lizel bantu untuk kasih saran yang paling cocok untuk Kakak 💖✨`,
  },
  lainnya: {
    1: () =>
      `Siap Kak, Lizel ngerti 🥰 Biar Kakak makin mantap: produk kita aman BPOM dan bisa bayar di tempat ya. Mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD 🥰?`,
    2: () =>
      `Boleh Lizel tau yang bikin Kakak masih berat apa Kak? Biar Lizel bantu cariin solusinya 🥰`,
  },
};

function objectionReply(type, n, mem) {
  const t = OBJECTION[type] || OBJECTION.lainnya;
  const f = t[Math.min(n, 2)];
  return f ? f() : null;
}

// ------------------------------------------------------------------
// GREETING MID & CONFUSED
// ------------------------------------------------------------------
function greetMid(stage, mem) {
  const hi = pick(mem, "hi", [
    "Halo kakak cantik 🥰 Lizel masih di sini kok.",
    "Hai kak say 😊 Iya, Lizel masih standby ya.",
  ]);
  return `${hi} ${cta(stage, mem)}`;
}

function confused(stage, mem) {
  const lead = pick(mem, "conf", [
    "Maaf kak say, Lizel belum nangkep maksudnya nih 🙏😊",
    "Hehe maaf Kak, Lizel kurang paham, boleh diulang pertanyaannya? 🙏",
  ]);
  return `${lead} ${cta(stage, mem)}`;
}

const HANDOFF = {
  objection:
    "Baik Kak 🥰 Biar Kakak dapat penawaran yang lebih pas, Lizel sambungkan ke admin pusat kami ya. Mohon ditunggu sebentar 🙏💖",
  cancel:
    "Baik Kak 🙏 Lizel sambungkan ke admin pusat untuk bantu prosesnya ya. Mohon ditunggu sebentar 💖",
  many: "Biar Kakak dapat jawaban yang lebih jelas, Lizel sambungkan ke admin pusat kami ya Kak 🥰 Mohon ditunggu sebentar 🙏",
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
