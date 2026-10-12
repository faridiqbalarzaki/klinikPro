const { csCommands } = require("./templates");
const cfg = require("./config");
const { withTimeout, sleep } = require("./sender");

const ALIASES = { fu: "bestseller", hallo: "stuck" };

// command -> file gambar. Caption = csCommands[command], hanya di gambar terakhir.
const MEDIA = {
  bpom: ["Bpom .jpeg"], // spasi sebelum titik sesuai nama file asli
  busui: ["busui.jpeg"],
  cod: ["Ketentuan COD.jpeg"],
  bestseller: ["dijamin.jpeg"],
  member: ["member.jpeg"],
  stuck: ["stuck hallo.jpeg"],
  testihasil: ["Bukti real testi.jpeg"],
  shopee: ["shopee.jpeg"],
  bukti: [1, 2, 3, 4].map((n) => `bukti paket customer ${n}.jpeg`),
  carapakai: [1, 2, 3].map((n) => `CARA PEMAKAIAN${n}.jpeg`),
};

// "/Paksu  halo" -> "paksu"
const parseName = (text) =>
  String(text || "")
    .trim()
    .slice(1)
    .split(/\s+/)[0]
    .toLowerCase();

function resolve(name) {
  const cmd = ALIASES[name] || name;
  const files = MEDIA[cmd];
  const caption = csCommands[cmd];
  return files || caption ? { cmd, files, caption } : null;
}

const isKnown = (name) => resolve(name) !== null;

// Hapus pesan command (delete for everyone). Dipanggil SEGERA, tanpa antrean/debounce.
async function deleteCommand(sock, chatJid, key) {
  // Satu kali coba ulang untuk gangguan jaringan sesaat; tiap percobaan dibatasi waktu
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await withTimeout(
        Promise.resolve().then(() => sock.sendMessage(chatJid, { delete: key })),
        15000,
        "hapus command",
      );
      return true;
    } catch (err) {
      console.error(
        `⚠️  [Bot] Gagal menghapus pesan command (percobaan ${attempt}/2):`,
        err.message,
      );
      if (attempt < 2) await sleep(500);
    }
  }
  return false;
}

// Kirim isi template: gambar berurutan (caption di gambar terakhir) atau teks saja.
// Antar gambar diberi jeda 2 detik + acak (cfg.mediaGap) agar tidak terdeteksi spam.
async function sendTemplate(sender, chatJid, name) {
  const r = resolve(name);
  if (!r) return false;
  if (r.files) {
    for (let i = 0; i < r.files.length; i++) {
      const last = i === r.files.length - 1;
      await sender.sendImage(chatJid, r.files[i], last ? r.caption : undefined);
      if (!last) await sender.sleep(cfg.mediaGap());
    }
  } else {
    await sender.sendText(chatJid, r.caption);
  }
  return true;
}

module.exports = { parseName, isKnown, deleteCommand, sendTemplate };
