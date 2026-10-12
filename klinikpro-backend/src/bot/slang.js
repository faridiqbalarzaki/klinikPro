// Normalisasi bahasa gaul / singkatan / typo umum -> kata baku, TANPA AI.
// Dipakai oleh fallback lokal (intentParser.js) dan oleh funnel.js supaya regex lama
// ("harga", "flek", "paket", ...) tetap bisa mengenali "hrg", "pelek", "pket", dll.
// Tambah kata baru cukup di tabel SLANG di bawah (kunci = huruf kecil, tanpa tanda baca).
const { normalizeText } = require("../priceFlow");

const SLANG = {
  // salam
  mikum: "assalamualaikum",
  kumsalam: "waalaikumsalam",
  aslm: "assalamualaikum",
  asslm: "assalamualaikum",
  aslmkm: "assalamualaikum",
  asslmkm: "assalamualaikum",
  asalamualaikum: "assalamualaikum",
  assalamualaikm: "assalamualaikum",
  // produk / harga
  pket: "paket",
  pkt: "paket",
  paket: "paket",
  hrg: "harga",
  hrga: "harga",
  harg: "harga",
  hrgnya: "harganya",
  brpa: "berapa",
  brapa: "berapa",
  brp: "berapa",
  // keluhan (typo umum)
  pelek: "flek",
  plek: "flek",
  fleg: "flek",
  jrwt: "jerawat",
  jerwat: "jerawat",
  jerawt: "jerawat",
  jrawat: "jerawat",
  komdo: "komedo",
  kusem: "kusam",
  // order / penolakan
  psn: "pesan",
  pesen: "pesan",
  bli: "beli",
  ambl: "ambil",
  mw: "mau",
  pngn: "pengen",
  pgn: "pengen",
  tf: "transfer",
  trf: "transfer",
  mhl: "mahal",
  ntar: "nanti",
  nnti: "nanti",
  ntr: "nanti",
  // alamat
  kec: "kecamatan",
  kecmtn: "kecamatan",
  kcmtn: "kecamatan",
  kab: "kabupaten",
  // singkatan umum
  yg: "yang",
  dgn: "dengan",
  utk: "untuk",
  bs: "bisa",
  sy: "saya",
  gk: "gak",
  ngga: "gak",
  nggak: "gak",
  tdk: "tidak",
  blm: "belum",
  udh: "udah",
  sm: "sama",
  mksh: "makasih",
  makasi: "makasih",
};

// Huruf yang dipanjangkan ("hargaaa", "iyaaaa") dipadatkan; dua huruf kembar tetap
// ("keluhan", "mikum" tidak terpengaruh).
const squeeze = (w) => w.replace(/(\p{L})\1{2,}/gu, "$1");

function normalizeSlang(text) {
  return normalizeText(text)
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      const s = squeeze(w);
      return SLANG[s] ?? SLANG[w] ?? s;
    })
    .join(" ");
}

module.exports = { normalizeSlang, SLANG };
