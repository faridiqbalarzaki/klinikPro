const { normalizeMessageContent } = require("@whiskeysockets/baileys");
const db = require("../db");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { createSender, sleep, withTimeout } = require("./sender");
const funnel = require("./funnel");
const commands = require("./commands");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");
const { autoGreeting } = require("./templates");

const unwrap = normalizeMessageContent || ((m) => m);
const queues = new Map();
const seen = new Set();
const lastGreeting = new Map(); // Untuk melacak sapaan terakhir pelanggan lama

// Jumlah proses funnel yang sedang berjalan/antre per jid.
const inflight = new Map();
const incInflight = (jid) => inflight.set(jid, (inflight.get(jid) || 0) + 1);
const decInflight = (jid) => {
  const n = (inflight.get(jid) || 0) - 1;
  if (n > 0) inflight.set(jid, n);
  else inflight.delete(jid);
};

// Waktu terakhir bot benar-benar membalas customer (selesai kirim).
const lastBotAt = new Map();
// Bubble yang masuk dalam jendela ini setelah bot selesai membalas dianggap masih
// "susulan" (customer mengetik sebelum sempat membaca balasan bot).
// Ubah lewat FUNNEL_LATE_GRACE_MS di .env; 0 = hanya saat bot sedang memproses.
const LATE_GRACE_MS = process.env.FUNNEL_LATE_GRACE_MS
  ? Number(process.env.FUNNEL_LATE_GRACE_MS) || 0
  : 5000;

// Satu buffer maksimal menampung sekian bubble; lebih dari itu langsung diproses
// (anti-banjir: customer/bot spam ratusan pesan beruntun).
const MAX_BUFFER_BUBBLES = 25;

// ------------------------------------------------------------------
// Mapping LID <-> nomor asli (tabel lid_map yang sama dengan inbox.js).
// Funnel tidak meneruskan teks customer ke inbox, jadi mapping harus dicatat di sini;
// kalau tidak, pesan "@lid" tanpa remoteJidAlt dianggap customer baru (stage 0 lagi).
// ------------------------------------------------------------------
let lidLoaded = null;
function loadLidMap() {
  if (!lidLoaded) {
    lidLoaded = (async () => {
      try {
        await db.query(
          `CREATE TABLE IF NOT EXISTS lid_map (
             lid        text PRIMARY KEY,
             pn         text NOT NULL,
             updated_at timestamptz NOT NULL DEFAULT NOW()
           )`,
        );
        const r = await db.query("SELECT lid, pn FROM lid_map");
        for (const row of r?.rows || []) priceFlow.registerLid(row.lid, row.pn);
      } catch (err) {
        console.error("⚠️  [Bot] Gagal memuat lid_map:", err.message);
      }
    })();
  }
  return lidLoaded;
}

function persistLid(lid, pn) {
  loadLidMap()
    .then(() =>
      db.query(
        `INSERT INTO lid_map (lid, pn) VALUES ($1::text, $2::text)
         ON CONFLICT (lid) DO UPDATE SET pn = EXCLUDED.pn, updated_at = NOW()`,
        [lid, pn],
      ),
    )
    .catch((err) =>
      console.error("⚠️  [Bot] Gagal menyimpan mapping LID:", err.message),
    );
}

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

function firstTime(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return true;
}

function sessionJidOf(key) {
  const raw = normalizeJid(key?.remoteJid);
  if (!raw) return null;
  if (raw.endsWith("@lid")) {
    const alt = normalizeJid(key.remoteJidAlt);
    if (alt.endsWith("@s.whatsapp.net")) {
      // Catat pasangan LID <-> nomor supaya pesan berikutnya tanpa alt
      // tetap jatuh ke sesi yang sama.
      if (priceFlow.registerLid(raw, alt)) persistLid(raw, alt);
      return alt;
    }
    return normalizeJid(priceFlow.canonicalJid(raw));
  }
  return raw.endsWith("@s.whatsapp.net") ? raw : null;
}

function mediaCopy(msg) {
  const c = unwrap(msg.message) || msg.message;
  for (const k of ["imageMessage", "videoMessage", "documentMessage"]) {
    if (c?.[k]) return { ...msg, message: { [k]: { ...c[k], caption: "" } } };
  }
  if (c?.audioMessage)
    return { ...msg, message: { audioMessage: c.audioMessage } };
  return null;
}

const NON_CONVERSATIONAL = [
  "reactionMessage",
  "encReactionMessage",
  "stickerMessage",
  "protocolMessage",
  "editedMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
];
function isNonConversational(msg) {
  const raw = msg?.message || {};
  let c = raw;
  try {
    c = unwrap(raw) || raw;
  } catch (_) {}
  return NON_CONVERSATIONAL.some((k) => raw[k] || c?.[k]);
}

// Gabungkan bubble menjadi satu teks. Jika SEMUA bubble punya messageTimestamp
// WhatsApp, urutkan berdasarkan itu (anti bubble terbalik karena event datang
// tidak berurutan); kalau tidak, pakai urutan kedatangan.
function joinBubbles(items) {
  const list = items.slice();
  if (list.length > 1 && list.every((i) => i.ts > 0)) {
    list.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  return list
    .map((i) => i.text)
    .join("\n")
    .trim();
}

const buffers = new Map();

async function flush(jid) {
  const b = buffers.get(jid);
  if (!b) return;
  buffers.delete(jid);

  const text = joinBubbles(b.items);
  if (!text) return;
  const sock = (b.getSock && b.getSock()) || b.sock;
  if (!sock) return;
  const sender = createSender(sock);

  // Ditandai secara sinkron (tanpa await di antara delete buffer dan ini),
  // sehingga bubble yang masuk setelahnya langsung terbaca sebagai "late".
  incInflight(jid);
  try {
    const session = await state.getSession(jid);

    // --- AUTO GREETING PELANGGAN LAMA ---
    // Buffer hanya dibuka saat sesi masih BOT. Jika saat flush sesi sudah HANDOFF,
    // penyebabnya bot sendiri (objection / stage 3) atau CS mengambil alih, dan
    // itu BUKAN pelanggan lama yang kembali. Jadi jangan menyapa dalam kasus itu.
    if (
      session &&
      session.status === "HANDOFF" &&
      !b.late &&
      !funnel.isTakenOver(jid)
    ) {
      const now = Date.now();
      const lastGreet = lastGreeting.get(jid) || 0;
      const cooldown = 2 * 60 * 60 * 1000; // 2 jam

      if (now - lastGreet > cooldown) {
        if (lastGreeting.size > 5000) lastGreeting.clear();
        lastGreeting.set(jid, now);
        await enqueue(jid, async () => {
          await sender.typing(jid);
          await sender.sendText(jid, autoGreeting);
        });
      }
    }

    const r = await enqueue(jid, () =>
      funnel.process({
        sender,
        msg: b.last,
        jid,
        text,
        ctx: { late: b.late, stageAtOpen: b.stageAtOpen },
      }),
    );

    if (r === "replied") {
      if (lastBotAt.size > 5000) lastBotAt.clear();
      lastBotAt.set(jid, Date.now());
    }

    // "absorbed" = bubble susulan yang sengaja tidak memicu balasan bot.
    // Tidak diteruskan ke inbox: forward (bahkan silent) dicatat sebagai tiket
    // oleh inbox.js, padahal lead masih di tengah funnel.
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
  } finally {
    decInflight(jid);
  }
}

// Masuknya pesan diserialkan per jid. worker.js memanggil handler ini tanpa await
// per event upsert, jadi tanpa ini urutan bubble bisa tertukar saat admit() (DB)
// selesai tidak berurutan.
async function handleIncoming(sock, msg, text, deps = {}) {
  if (msg.key?.fromMe) return "passthrough";
  await loadLidMap(); // mapping LID harus sudah dimuat sebelum jid sesi ditentukan
  const jid = sessionJidOf(msg.key);
  if (!jid) return "passthrough";
  if (!firstTime(`in:${jid}:${msg.key.id}`)) return "ignored";

  return enqueue(`intake:${jid}`, () =>
    intakeMessage(sock, msg, text, deps, jid),
  );
}

async function intakeMessage(sock, msg, text, deps, jid) {
  const session = await funnel.admit(jid);
  if (!session) return cfg.SILENT_IN_HANDOFF ? "silent" : "passthrough";

  if (isNonConversational(msg)) return "ignored";

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

  const clean = String(text || "").trim();
  if (!clean) return "ignored";

  const now = Date.now();
  let b = buffers.get(jid);
  if (!b) {
    // "late" = buffer ini mulai terkumpul saat bot sedang memproses balasan
    // untuk bubble sebelumnya, atau sesaat setelah bot selesai membalas.
    const late =
      (inflight.get(jid) || 0) > 0 ||
      (LATE_GRACE_MS > 0 && now - (lastBotAt.get(jid) || 0) < LATE_GRACE_MS);
    buffers.set(
      jid,
      (b = {
        timer: null,
        items: [],
        seq: 0,
        last: null,
        firstAt: now,
        lastAt: now,
        stageAtOpen: session.funnel_stage, // snapshot stage saat bubble pertama masuk
        late,
      }),
    );
  }
  clearTimeout(b.timer);
  b.items.push({
    text: clean,
    ts: Number(msg.messageTimestamp) || 0,
    seq: ++b.seq,
  });
  b.last = msg;
  b.lastAt = now;
  b.sock = sock;
  b.getSock = deps.getSock || null;
  b.forward = deps.forward || null;
  const wait =
    b.items.length >= MAX_BUFFER_BUBBLES
      ? 0
      : Math.max(
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

async function handleOutgoing(sock, msg, text) {
  if (!text || !text.trim().startsWith("/")) return false;

  const ts = Number(msg.messageTimestamp) || 0;
  if (ts && Date.now() / 1000 - ts > cfg.COMMAND_MAX_AGE_S) return false;

  const name = commands.parseName(text);
  if (!commands.isKnown(name)) return false;
  await loadLidMap();
  if (!firstTime(`out:${msg.key.id}`)) return false;

  const chatJid = msg.key.remoteJid;
  const sessionJid = sessionJidOf(msg.key);

  if (cfg.HANDOFF_ON_CS_COMMAND && sessionJid) funnel.markTakeover(sessionJid);

  await commands.deleteCommand(sock, chatJid, msg.key);

  const phone = inbox.phoneFromJid(sessionJid || chatJid);

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

  const sender = createSender(sock);
  enqueue(sessionJid || chatJid, async () => {
    await commands.sendTemplate(sender, chatJid, name);
    console.log(`⌨️  [Bot] /${name} -> ${phone}`);
  }).catch((err) =>
    console.error(`❌ [Bot] /${name} gagal dikirim:`, err.message),
  );
  return true;
}

let stuckTimer = null;
let stuckRunning = false;

async function checkStuck(getSock) {
  if (stuckRunning) return;
  stuckRunning = true;
  try {
    const sock = getSock();
    if (!sock) return;
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
        if (!cur || cur.status !== "BOT") return;
        const idleMin =
          (Date.now() - new Date(cur.updatedAt).getTime()) / 60000;
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
      await sleep(4000 + Math.floor(Math.random() * 4000));
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
