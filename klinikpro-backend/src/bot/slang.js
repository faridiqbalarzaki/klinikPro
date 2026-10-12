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
  // keberatan harga / tawar / tunda dari berbagai daerah -> kata baku yang sudah dikenali SOP
  // Jawa
  larang: "mahal",
  rega: "harga",
  regane: "harganya",
  piro: "berapa",
  pira: "berapa",
  sesuk: "nanti",
  duwit: "uang",
  duit: "uang",
  bojo: "suami",
  // Sunda
  teuing: "banget",
  engke: "nanti",
  sabaraha: "berapa",
  // Banjar / Palembang / Medan
  banar: "banget",
  nian: "banget",
  kalik: "banget",
  kada: "tidak",
  idak: "tidak",
  dak: "tidak",
  katek: "tidak ada",
  pacak: "bisa",
  ikam: "kamu",
  // nego
  nego: "mahal",
  negonya: "mahal",
  nawar: "mahal",
  menawar: "mahal",
  dskon: "diskon",
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
