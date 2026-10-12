// Ekstraksi teks dari pesan Baileys (sudah/ belum di-unwrap). Tidak pernah melempar error.
let unwrap = (m) => m;
try {
  const b = require("@whiskeysockets/baileys");
  if (typeof b.normalizeMessageContent === "function") unwrap = b.normalizeMessageContent;
} catch (_) {
  /* tanpa Baileys: anggap sudah ter-unwrap */
}

function extractText(message) {
  let m;
  try {
    m = unwrap(message) || message;
  } catch (_) {
    m = message;
  }
  if (!m || typeof m !== "object") return "";

  return String(
    m.conversation ||
      // balasan (quoted reply) dan teks berformat/link: yang diambil hanya teks BARU,
      // bukan isi pesan yang dikutip (itu ada di contextInfo.quotedMessage)
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      // jawaban tombol / daftar pilihan
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.buttonsResponseMessage?.selectedButtonId ||
      m.listResponseMessage?.title ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId ||
      m.templateButtonReplyMessage?.selectedDisplayText ||
      m.templateButtonReplyMessage?.selectedId ||
      "",
  );
}

module.exports = { extractText };
