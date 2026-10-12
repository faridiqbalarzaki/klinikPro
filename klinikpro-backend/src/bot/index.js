const { normalizeMessageContent } = require("@whiskeysockets/baileys");
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
    return alt.endsWith("@s.whatsapp.net")
      ? alt
      : normalizeJid(priceFlow.canonicalJid(raw));
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

const buffers = new Map();

async function flush(jid) {
  const b = buffers.get(jid);
  if (!b) return;
  buffers.delete(jid);

  const text = b.texts.join("\n").trim();
  if (!text) return;
  const sock = (b.getSock && b.getSock()) || b.sock;
  if (!sock) return;
  const sender = createSender(sock);

  try {
    const session = await state.getSession(jid);

    // --- AUTO GREETING PELANGGAN LAMA ---
    if (session && session.status === "HANDOFF") {
      const now = Date.now();
      const lastGreet = lastGreeting.get(jid) || 0;
      const cooldown = 2 * 60 * 60 * 1000; // 2 jam

      if (now - lastGreet > cooldown) {
        lastGreeting.set(jid, now);
        await enqueue(jid, async () => {
          await sender.typing(jid);
          await sender.sendText(jid, autoGreeting);
        });
      }
    }

    const r = await enqueue(jid, () =>
      funnel.process({ sender, msg: b.last, jid, text }),
    );

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

async function handleIncoming(sock, msg, text, deps = {}) {
  if (msg.key?.fromMe) return "passthrough";
  const jid = sessionJidOf(msg.key);
  if (!jid) return "passthrough";
  if (!firstTime(`in:${jid}:${msg.key.id}`)) return "ignored";

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

async function handleOutgoing(sock, msg, text) {
  if (!text || !text.trim().startsWith("/")) return false;

  const ts = Number(msg.messageTimestamp) || 0;
  if (ts && Date.now() / 1000 - ts > cfg.COMMAND_MAX_AGE_S) return false;

  const name = commands.parseName(text);
  if (!commands.isKnown(name)) return false;
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
