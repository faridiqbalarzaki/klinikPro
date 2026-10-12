const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const { ASSETS_DIR, CAPTION_LIMIT } = cfg;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Batalkan operasi yang menggantung (socket "setengah mati" tidak selalu melempar error).
// Promise.race memasang handler di kedua promise, jadi penolakan susulan tidak jadi
// Unhandled Rejection.
function withTimeout(promise, ms, label = "kirim") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`Timeout ${label} (> ${ms} ms)`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function createSender(sock) {
  // Promise.resolve().then(...): sock null / sudah ditutup -> jadi rejection biasa, bukan throw sinkron
  const send = (jid, content) =>
    withTimeout(
      Promise.resolve().then(() => sock.sendMessage(jid, content)),
      cfg.SEND_TIMEOUT_MS,
      "sendMessage",
    );

  const sendText = (jid, text) => send(jid, { text });

  // "sedang mengetik..." (gagal -> diabaikan; ini hanya kosmetik)
  async function typing(jid, ms = cfg.typingMs()) {
    try {
      await withTimeout(
        Promise.resolve().then(() => sock.sendPresenceUpdate("composing", jid)),
        5000,
        "presence",
      );
    } catch (_) {
      /* tidak penting */
    }
    await sleep(ms);
  }

  // Kirim gambar dari assets/ (nama file persis, termasuk spasi)
  async function sendImage(jid, fileName, caption) {
    const filePath = path.join(ASSETS_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      console.error(`⚠️  [Bot] Asset hilang: ${filePath}`);
      if (caption) await sendText(jid, caption); // fallback: minimal teksnya terkirim
      return;
    }
    const image = await fs.promises.readFile(filePath);
    if (caption && caption.length > CAPTION_LIMIT) {
      await send(jid, { image, mimetype: "image/jpeg" });
      await sleep(cfg.gap(800));
      await sendText(jid, caption);
    } else {
      await send(jid, {
        image,
        mimetype: "image/jpeg",
        ...(caption ? { caption } : {}),
      });
    }
  }

  return { sendText, sendImage, typing, sleep };
}

module.exports = { createSender, sleep, withTimeout };
