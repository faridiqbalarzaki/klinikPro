const path = require("path");
const db = require("../db");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { botStages: T, csCommands, priceFlow: PT } = require("./templates");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");

const ASSET_DIR =
  process.env.ASSET_DIR || path.join(__dirname, "..", "..", "assets");

// Regex untuk mendeteksi kata kunci penolakan
const HANDOFF_REGEX =
  /\b(gajian|suami|batal|cancel|mahal|nanti|kemahalan|uang|paksu|ragu|takut)\b/i;

async function isKnownCustomer(phone, jid) {
  jid = normalizeJid(jid);
  const r = await db.query(
    "SELECT 1 FROM customers WHERE phone = $1 OR jid = $2 LIMIT 1",
    [phone, jid],
  );
  return r.rowCount > 0;
}

async function recordLeadTicket({ jid, phone, pushName, text }) {
  jid = normalizeJid(jid);
  try {
    const r = await db.query(
      `WITH cust AS (
         INSERT INTO customers (phone, jid, name)
         VALUES ($1::text, $2::text, $3::text)
         ON CONFLICT (phone) DO UPDATE SET
           jid  = COALESCE(customers.jid, EXCLUDED.jid),
           name = CASE
                    WHEN EXCLUDED.name IS NOT NULL
                     AND COALESCE(customers.name, '') IN ('', 'Kak')
                    THEN EXCLUDED.name ELSE customers.name END
         RETURNING id
       )
       INSERT INTO tickets (customer_id, last_message, status, category, has_attachment)
       SELECT id, $4::text, 'pending', 'Penawaran', FALSE FROM cust
       ON CONFLICT (customer_id) WHERE status = 'pending'
       DO UPDATE SET last_message = EXCLUDED.last_message, updated_at = NOW()
       RETURNING id, customer_id`,
      [
        phone,
        jid,
        pushName ? String(pushName).slice(0, 100) : null,
        (text || "").slice(0, 1000),
      ],
    );
    const row = r.rows[0];
    if (row && text) {
      await db.query(
        "INSERT INTO messages (customer_id, ticket_id, body) VALUES ($1, $2, $3)",
        [row.customer_id, row.id, text.slice(0, 4000)],
      );
    }
    console.log(
      `📥 [Bot] Tiket #${row?.id} dibuat untuk ${phone} (closing funnel)`,
    );
  } catch (err) {
    console.error("⚠️  [Bot] Gagal membuat tiket closing:", err.message);
  }
}

async function admit(jid) {
  jid = normalizeJid(jid);
  const phone = inbox.phoneFromJid(jid);
  let session = await state.getSession(jid);
  if (!session) {
    if (cfg.NEW_LEADS_ONLY && (await isKnownCustomer(phone, jid))) {
      await state.createSession(jid, {
        phoneNumber: phone,
        funnel_stage: 0,
        status: "HANDOFF",
      });
      return null;
    }
    await state.createSession(jid, {
      phoneNumber: phone,
      funnel_stage: 0,
      status: "BOT",
    });
    session = await state.getSession(jid);
  }
  if (isTakenOver(jid)) return null;
  return session && session.status === "BOT" ? session : null;
}

const TAKEOVER_WINDOW_MS = 3 * 60 * 1000;
const takeoverAt = new Map();

function markTakeover(jid) {
  if (takeoverAt.size > 5000) takeoverAt.clear();
  takeoverAt.set(normalizeJid(jid), Date.now());
}
const isTakenOver = (jid) =>
  Date.now() - (takeoverAt.get(jid) || 0) < TAKEOVER_WINDOW_MS;

async function deliver({ jid, steps, commit, rollback }) {
  if (isTakenOver(jid)) return "taken";
  await commit();

  for (let i = 0; i < steps.length; i++) {
    if (isTakenOver(jid)) {
      console.log(
        `🛑 [Bot] ${jid}: CS mengambil alih, sisa pesan funnel dibatalkan.`,
      );
      return "taken";
    }
    try {
      await steps[i]();
    } catch (err) {
      if (i === 0) {
        if (!isTakenOver(jid)) {
          await rollback().catch((e) =>
            console.error("⚠️  [Bot] Rollback stage gagal:", e.message),
          );
        }
        throw err;
      }
      console.error(
        `⚠️  [Bot] ${jid}: pesan funnel ke-${i + 1} gagal terkirim: ${err.message}`,
      );
      break;
    }
  }
  return "replied";
}

async function process_({ sender, msg, jid, text }) {
  jid = normalizeJid(jid);

  if (!text || !String(text).trim()) return "ignored";

  const phone = inbox.phoneFromJid(jid);
  const session = await state.getSession(jid);
  if (!session) return "silent";

  if (session.status !== "BOT" || isTakenOver(jid)) return "silent";

  priceFlow.setConsultedNow(jid);

  const lowerText = text.toLowerCase();
  const stage = session.funnel_stage;
  const patch = (p) => state.updateSession(jid, { phoneNumber: phone, ...p });

  const say =
    (t, wait = 0) =>
    async () => {
      if (wait) await sender.sleep(cfg.gap(wait));
      await sender.typing(jid);
      await sender.sendText(jid, t);
    };
  const pic =
    (file, caption, wait = 0) =>
    async () => {
      if (wait) await sender.sleep(cfg.gap(wait));
      await sender.typing(jid);
      await sender.sendImage(jid, file, caption);
    };

  // --- CEGAT PENOLAKAN (AUTO-OBJECTION HANDLING) ---
  if (HANDOFF_REGEX.test(lowerText)) {
    let replyTemplate = null;
    if (/mahal|kemahalan|uang/i.test(lowerText))
      replyTemplate = csCommands.mahal;
    else if (/suami|paksu/i.test(lowerText)) replyTemplate = csCommands.paksu;
    else if (/nanti|besok|kapan/i.test(lowerText))
      replyTemplate = csCommands.nanti;
    else if (/ragu|takut|efek/i.test(lowerText))
      replyTemplate = csCommands.ragu;

    if (replyTemplate) {
      await deliver({
        jid,
        steps: [say(replyTemplate, 1500)],
        commit: () => patch({ status: "HANDOFF" }),
        rollback: () => patch({ status: "BOT" }),
      });
    } else {
      await patch({ status: "HANDOFF" });
    }
    console.log(
      `🙋 [Bot] ${phone} HANDOFF (objection): "${text.slice(0, 60)}"`,
    );
    return "silent";
  }

  // --- CEGAT KATA KUNCI "HARGA" (PRICE FLOW) ---
  if (
    (stage === 0 || stage === 1) &&
    /harga|berapa|pricelist|price/i.test(lowerText)
  ) {
    await deliver({
      jid,
      steps: [say(PT.askComplaint, 1500)],
      commit: () => patch({ funnel_stage: 1 }),
      rollback: () => patch({ funnel_stage: stage }),
    });
    return "replied";
  }

  let result;
  switch (stage) {
    case 0:
      result = await deliver({
        jid,
        steps: [say(T.salam, 1500)],
        commit: () => patch({ funnel_stage: 1 }),
        rollback: () => patch({ funnel_stage: 0 }),
      });
      break;

    case 1:
      result = await deliver({
        jid,
        steps: [
          say(PT.step1Solusi, 1000),
          pic("awal.jpeg", PT.step2Product, 2000),
          pic("akhir.jpeg", PT.step3Testi, 2500),
        ],
        commit: () => patch({ funnel_stage: 2 }),
        rollback: () => patch({ funnel_stage: 1 }),
      });
      break;

    case 2:
      result = await deliver({
        jid,
        steps: [
          pic("HARGA PROMO.jpeg", T.harga_katalog),
          say(T.harga_tanya, cfg.DELAY_BETWEEN_MS),
        ],
        commit: () => patch({ funnel_stage: 3 }),
        rollback: () => patch({ funnel_stage: 2 }),
      });
      break;

    case 3:
      result = await deliver({
        jid,
        steps: [
          say(T.isiform),
          pic("FORMAT ORDER.jpeg", undefined, cfg.DELAY_BETWEEN_MS),
          say(T.formatOrder, cfg.DELAY_BETWEEN_MS),
        ],
        commit: () => patch({ funnel_stage: 4, status: "HANDOFF" }),
        rollback: () => patch({ funnel_stage: 3, status: "BOT" }),
      });
      if (result === "replied") {
        await recordLeadTicket({ jid, phone, pushName: msg?.pushName, text });
      }
      break;

    default:
      return "silent";
  }

  return result === "taken" ? "silent" : "replied";
}

module.exports = {
  admit,
  process: process_,
  markTakeover,
  isTakenOver,
  HANDOFF_REGEX,
};
