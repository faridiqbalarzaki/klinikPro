// Modul bot funnel + slash command CS. Dipanggil dari worker.js (TIDAK membuat koneksi sendiri).
const { normalizeMessageContent } = require("@whiskeysockets/baileys");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { createSender, sleep, withTimeout } = require("./sender");
const funnel = require("./funnel");
const commands = require("./commands");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");

const unwrap = normalizeMessageContent || ((m) => m);

// Antrean per chat: proses funnel / command dari satu JID berjalan satu per satu
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next
    .catch(() => {})
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  return next;
}

// Cegah pesan yang sama diproses dua kali (event notify + append / redelivery)
const seen = new Set();
function firstTime(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return true;
}

// Kunci JID kanonis tanpa mencatat mapping LID (itu tugas inbox.js).
// Hasilnya sudah dinormalisasi (tanpa suffix device) dan dipakai untuk SEMUA operasi DB/state.
function sessionJidOf(key) {
  const raw = normalizeJid(key?.remoteJid);
  if (!raw) return null;
  if (raw.endsWith("@lid")) {
    const alt = normalizeJid(key.remoteJidAlt);
    return alt.endsWith("@s.whatsapp.net")
      ? alt
      : normalizeJid(priceFlow.canonicalJid(raw));
  }
  return raw.endsWith("@s.whatsapp.net") ? raw : null;
}

// Salinan pesan media TANPA caption, untuk diteruskan ke inbox.js (simpan foto + tiket)
// tanpa memicu auto-reply dari teks caption. Caption tetap ikut ke teks gabungan funnel.
function mediaCopy(msg) {
  const c = unwrap(msg.message) || msg.message;
  for (const k of ["imageMessage", "videoMessage", "documentMessage"]) {
    if (c?.[k]) return { ...msg, message: { [k]: { ...c[k], caption: "" } } };
  }
  if (c?.audioMessage)
    return { ...msg, message: { audioMessage: c.audioMessage } };
  return null;
}

// Jenis pesan yang BUKAN balasan percakapan: tidak boleh memajukan funnel, walau (setelah di-unwrap)
// ada teksnya (mis. edit pesan membawa teks baru, reaction membawa emoji).
const NON_CONVERSATIONAL = [
  "reactionMessage",
  "encReactionMessage",
  "stickerMessage",
  "protocolMessage", // hapus / edit pesan, dll.
  "editedMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
];
function isNonConversational(msg) {
  const raw = msg?.message || {};
  let c = raw;
  try {
    c = unwrap(raw) || raw;
  } catch (_) {
    /* pakai raw */
  }
  return NON_CONVERSATIONAL.some((k) => raw[k] || c?.[k]);
}

// ------------------------------------------------------------------
// Debounce / message buffering per JID
// ------------------------------------------------------------------
const buffers = new Map(); // jid -> { timer, texts[], last, lastAt, firstAt, sock, getSock, forward }

async function flush(jid) {
  const b = buffers.get(jid);
  if (!b) return;
  buffers.delete(jid);

  const text = b.texts.join("\n").trim();
  if (!text) return; // tidak ada teks sama sekali: tidak ada yang dibalas
  // Socket bisa sudah berganti (reconnect) selama debounce: pakai yang terbaru bila ada
  const sock = (b.getSock && b.getSock()) || b.sock;
  if (!sock) return;
  const sender = createSender(sock);
  try {
    const r = await enqueue(jid, () =>
      funnel.process({ sender, msg: b.last, jid, text }),
    );
    // Bot tidak membalas (HANDOFF / kata kunci): teruskan teks gabungan ke inbox.js sebagai SATU pesan.
    // "silent" = inbox.js hanya mencatat tiket, TANPA auto-reply / SOP harga.
    // id dibuat unik supaya tidak dibuang dedup inbox.js bila pesan terakhir adalah media.
    if ((r === "silent" || r === "passthrough") && b.forward) {
      await b.forward(
        {
          ...b.last,
          key: { ...b.last.key, id: `${b.last.key.id}:buf` },
          message: { conversation: text },
        },
        { silent: r === "silent" && cfg.SILENT_IN_HANDOFF },
      );
    }
  } catch (err) {
    console.error("❌ [Bot] Funnel:", err.message);
  }
}

// Pesan dari customer. Return:
//   "replied"     -> sudah / akan dibalas bot (jangan diteruskan ke inbox.js)
//   "ignored"     -> stiker / reaction / voice note / pesan kosong: diabaikan total
//   "silent"      -> HANDOFF / pelanggan lama: teruskan ke inbox.js dengan {silent:true}
//   "passthrough" -> bukan urusan bot: teruskan ke inbox.js seperti biasa
// deps.forward(msg, {silent}) = fungsi dari worker.js untuk meneruskan pesan ke inbox.js
// deps.getSock()              = socket WhatsApp terkini (opsional)
async function handleIncoming(sock, msg, text, deps = {}) {
  // Debounce HANYA untuk pesan customer. Pesan CS (fromMe) tidak pernah ditahan / digabung.
  if (msg.key?.fromMe) return "passthrough";
  const jid = sessionJidOf(msg.key);
  if (!jid) return "passthrough";
  if (!firstTime(`in:${jid}:${msg.key.id}`)) return "ignored"; // duplikat

  // HANDOFF / pelanggan lama: tidak ditahan, langsung ke inbox.js (mode diam)
  const session = await funnel.admit(jid);
  if (!session) return cfg.SILENT_IN_HANDOFF ? "silent" : "passthrough";

  // Stiker / reaction / edit / hapus pesan: bukan jawaban customer -> abaikan
  if (isNonConversational(msg)) return "ignored";

  // Media customer SELALU diteruskan ke inbox.js (disimpan + tiket), walau masih di funnel.
  // silent: media tidak pernah perlu memicu balasan otomatis.
  const media = mediaCopy(msg);
  if (media && deps.forward) {
    Promise.resolve()
      .then(() => deps.forward(media, { silent: true }))
      .catch((err) =>
        console.error(
          "⚠️  [Bot] Gagal meneruskan media ke inbox:",
          err.message,
        ),
      );
  }

  // Tanpa teks (voice note, foto tanpa caption, lokasi, kontak, ...): JANGAN memajukan funnel
  // dan JANGAN menyentuh timer debounce.
  const clean = String(text || "").trim();
  if (!clean) return "ignored";

  // Tahan: gabungkan teks, reset timer. Bot membalas sekali setelah customer berhenti mengirim.
  const now = Date.now();
  let b = buffers.get(jid);
  if (!b)
    buffers.set(
      jid,
      (b = { timer: null, texts: [], last: null, firstAt: now, lastAt: now }),
    );
  clearTimeout(b.timer);
  b.texts.push(clean);
  b.last = msg;
  b.lastAt = now;
  b.sock = sock;
  b.getSock = deps.getSock || null;
  b.forward = deps.forward || null;
  // Batas tunggu total: customer yang mengetik tanpa henti tetap dibalas
  const wait = Math.max(
    0,
    Math.min(cfg.DEBOUNCE_MS, b.firstAt + cfg.DEBOUNCE_MAX_WAIT_MS - now),
  );
  b.timer = setTimeout(
    () =>
      flush(jid).catch((err) =>
        console.error("❌ [Bot] Flush gagal:", err.message),
      ),
    wait,
  );
  return "replied";
}

// ------------------------------------------------------------------
// Pesan dari nomor CS sendiri (fromMe): hanya slash command. TANPA debounce, TANPA antrean
// untuk penghapusan: pesan command dihapus secepat mungkin (customer tidak sempat membaca),
// bahkan saat funnel untuk chat itu sedang mengirim balasan.
// ------------------------------------------------------------------
async function handleOutgoing(sock, msg, text) {
  if (!text || !text.trim().startsWith("/")) return false;

  const ts = Number(msg.messageTimestamp) || 0;
  if (ts && Date.now() / 1000 - ts > cfg.COMMAND_MAX_AGE_S) return false;

  const name = commands.parseName(text);
  if (!commands.isKnown(name)) return false; // bukan command dikenal -> pesan dibiarkan
  if (!firstTime(`out:${msg.key.id}`)) return false;

  const chatJid = msg.key.remoteJid; // apa adanya: dipakai untuk kirim & hapus
  const sessionJid = sessionJidOf(msg.key); // dinormalisasi: dipakai untuk state

  // 0) tandai ambil-alih SECARA SINKRON (sebelum await apa pun): funnel yang sedang berjalan
  //    / baru mulai langsung berhenti, tanpa menunggu DB.
  if (cfg.HANDOFF_ON_CS_COMMAND && sessionJid) funnel.markTakeover(sessionJid);

  // 1) hapus INSTAN
  await commands.deleteCommand(sock, chatJid, msg.key);

  const phone = inbox.phoneFromJid(sessionJid || chatJid);

  // 2) simpan HANDOFF (dicoba ulang; kegagalan DB sesaat tidak boleh membuat bot hidup lagi)
  if (cfg.HANDOFF_ON_CS_COMMAND && sessionJid) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await state.updateSession(sessionJid, {
          phoneNumber: phone,
          status: "HANDOFF",
        });
        break;
      } catch (err) {
        console.error(
          `⚠️  [Bot] Gagal set HANDOFF (percobaan ${attempt}/3):`,
          err.message,
        );
        if (attempt < 3) await sleep(400 * attempt);
      }
    }
  }

  // 3) kirim balasan lewat antrean chat itu (urut dengan balasan funnel); tidak ditunggu worker
  const sender = createSender(sock);
  enqueue(sessionJid || chatJid, async () => {
    await commands.sendTemplate(sender, chatJid, name);
    console.log(`⌨️  [Bot] /${name} -> ${phone}`);
  }).catch((err) =>
    console.error(`❌ [Bot] /${name} gagal dikirim:`, err.message),
  );
  return true;
}

// ------------------------------------------------------------------
// Anti-ghosting: customer menggantung di stage 1-3 selama STUCK_AFTER_MIN -> kirim /stuck (sekali per sesi)
// ------------------------------------------------------------------
let stuckTimer = null;
let stuckRunning = false;

async function checkStuck(getSock) {
  if (stuckRunning) return;
  stuckRunning = true;
  try {
    const sock = getSock();
    if (!sock) return; // WhatsApp belum tersambung
    const rows = await state.claimStuck({
      afterMin: cfg.STUCK_AFTER_MIN,
      maxAgeMin: cfg.STUCK_MAX_AGE_MIN,
      limit: cfg.STUCK_BATCH,
    });
    for (const r of rows) {
      await enqueue(r.jid, async () => {
        const skip = async (why) => {
          console.log(`⏰ [Bot] /stuck ${r.phone_number} dilewati: ${why}`);
          await state.releaseStuck(r.jid).catch(() => {});
        };
        if (buffers.has(r.jid)) return skip("customer sedang mengetik");
        if (funnel.isTakenOver(r.jid)) return;
        const cur = await state.getSession(r.jid);
        if (!cur || cur.status !== "BOT") return; // CS sudah mengambil alih
        // Customer bisa saja baru dibalas bot saat item ini menunggu di antrean:
        // updated_at yang masih "segar" berarti chat ini tidak lagi menggantung.
        const idleMin = (Date.now() - new Date(cur.updatedAt).getTime()) / 60000;
        if (idleMin < cfg.STUCK_AFTER_MIN) return skip("baru saja dibalas bot");
        const liveSock = getSock();
        if (!liveSock) return skip("WhatsApp terputus");
        try {
          await commands.sendTemplate(createSender(liveSock), r.jid, "stuck");
          console.log(
            `⏰ [Bot] /stuck otomatis -> ${r.phone_number} (stage ${r.funnel_stage})`,
          );
        } catch (err) {
          console.error(
            `⚠️  [Bot] /stuck gagal ke ${r.phone_number}:`,
            err.message,
          );
        }
      });
      await sleep(4000 + Math.floor(Math.random() * 4000)); // jeda antar kirim (anti-ban)
    }
  } catch (err) {
    console.error("⚠️  [Bot] Cek anti-ghosting gagal:", err.message);
  } finally {
    stuckRunning = false;
  }
}

function startStuckTimer(getSock) {
  if (!cfg.STUCK_ENABLED || stuckTimer) return;
  stuckTimer = setInterval(() => checkStuck(getSock), cfg.STUCK_CHECK_MS);
  stuckTimer.unref?.();
  console.log(
    `⏰ [Bot] Timer anti-ghosting aktif (${cfg.STUCK_AFTER_MIN} menit).`,
  );
}

function stopStuckTimer() {
  if (stuckTimer) clearInterval(stuckTimer);
  stuckTimer = null;
}

module.exports = {
  handleIncoming,
  handleOutgoing,
  startStuckTimer,
  stopStuckTimer,
  extractText: require("./text").extractText,
};
