// Penyimpanan gambar template/batch di disk (klinikpro-backend/uploads/).
// Dipakai oleh routes.js (simpan/salin/hapus) dan worker.js (baca saat kirim).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Baca .env dari klinikpro-backend/ (satu tingkat di atas src/), cadangan: folder kerja
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
require("dotenv").config();

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per gambar
const MAX_IMAGES = 5; // maksimal gambar per template/batch
const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// Pastikan folder utama uploads tersedia
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// FITUR BARU: Konfigurasi folder Inbox khusus pelanggan
const INBOX_DIR = path.join(UPLOAD_DIR, "inbox");
const MAX_INBOX_BYTES = 10 * 1024 * 1024; // foto pelanggan maks 10 MB
fs.mkdirSync(INBOX_DIR, { recursive: true });

const SAFE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// Tipe file ditentukan dari isi file (magic bytes), bukan dari klaim browser
function detectExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return ".png";
  if (
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return ".webp";
  return null;
}

const resolveName = (name) =>
  typeof name === "string" && SAFE_NAME.test(name)
    ? path.join(UPLOAD_DIR, name)
    : null;

// "data:image/png;base64,...." -> simpan ke disk, kembalikan nama file
function saveDataUrl(dataUrl) {
  const s = String(dataUrl ?? "");
  const comma = s.indexOf(",");
  const head = comma > 0 ? s.slice(0, comma) : "";
  if (!/^data:image\/(jpeg|png|webp);base64$/.test(head)) {
    throw httpError(
      400,
      "Format gambar tidak valid. Gunakan JPG, PNG, atau WEBP.",
    );
  }
  const buf = Buffer.from(s.slice(comma + 1), "base64");
  if (buf.length === 0) {
    throw httpError(400, "Data gambar kosong atau rusak.");
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw httpError(400, "Ukuran gambar maksimal 5 MB.");
  }
  const ext = detectExt(buf);
  if (!ext) {
    throw httpError(
      400,
      "Isi file bukan gambar JPG, PNG, atau WEBP yang valid.",
    );
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = crypto.randomBytes(16).toString("hex") + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}

// Salin gambar template untuk sebuah batch (batch tetap utuh walau template dihapus)
function copyImage(name) {
  const src = resolveName(name);
  if (!src || !fs.existsSync(src)) return null;
  const copyName = crypto.randomBytes(16).toString("hex") + path.extname(name);
  fs.copyFileSync(src, path.join(UPLOAD_DIR, copyName));
  return copyName;
}

function removeImage(name) {
  const p = resolveName(name);
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch (_) {
    /* sudah tidak ada */
  }
}

function readImage(name) {
  const p = resolveName(name);
  if (!p || !fs.existsSync(p)) return null;
  return {
    buffer: fs.readFileSync(p),
    mimetype: MIME_BY_EXT[path.extname(name)] || "application/octet-stream",
  };
}

const isDataUrl = (v) => typeof v === "string" && v.startsWith("data:");

const removeImages = (names) => (names || []).forEach(removeImage);

// Simpan banyak data URL sekaligus. Jika salah satu gagal, yang sudah tertulis dibatalkan.
function saveDataUrls(list) {
  if (list.length > MAX_IMAGES) {
    throw httpError(400, `Maksimal ${MAX_IMAGES} gambar per template.`);
  }
  const saved = [];
  try {
    for (const item of list) saved.push(saveDataUrl(item));
    return saved;
  } catch (err) {
    removeImages(saved);
    throw err;
  }
}

// Salin banyak file (batch memakai salinan sendiri). Gagal -> batalkan semuanya.
function copyImages(names) {
  const copies = [];
  for (const name of names) {
    const c = copyImage(name);
    if (!c) {
      removeImages(copies);
      return null;
    }
    copies.push(c);
  }
  return copies;
}

// Terima "images" (array) atau "image" lama (string tunggal) -> array
function toImageList(images, legacyImage) {
  const raw = Array.isArray(images) ? images : legacyImage ? [legacyImage] : [];
  if (raw.some((x) => typeof x !== "string" || !x)) {
    throw httpError(400, "Format gambar tidak valid.");
  }
  if (raw.length > MAX_IMAGES) {
    throw httpError(400, `Maksimal ${MAX_IMAGES} gambar per pesan.`);
  }
  return raw;
}

// ==============================================
// FITUR BARU: Penanganan File Inbox Pelanggan
// ==============================================

// Simpan foto kiriman pelanggan (Buffer) -> kembalikan nama file, atau null jika tidak valid
function saveInboxBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_INBOX_BYTES)
    return null;
  const ext = detectExt(buf); // cek isi file, bukan klaim pengirim
  if (!ext) return null;
  const name = crypto.randomBytes(16).toString("hex") + ext;
  fs.writeFileSync(path.join(INBOX_DIR, name), buf);
  return name;
}

// Hapus satu foto pelanggan. true jika terhapus.
async function removeInboxFile(name) {
  if (typeof name !== "string" || !SAFE_NAME.test(name)) return false;
  try {
    await fs.promises.unlink(path.join(INBOX_DIR, name));
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`⚠️  Gagal menghapus ${name}:`, err.message);
    }
    return false;
  }
}

module.exports = {
  UPLOAD_DIR,
  INBOX_DIR, // Tambahan export
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  httpError,
  isDataUrl,
  saveDataUrl,
  copyImage,
  removeImage,
  removeImages,
  saveDataUrls,
  copyImages,
  toImageList,
  readImage,
  saveInboxBuffer, // Tambahan export
  removeInboxFile, // Tambahan export
};
