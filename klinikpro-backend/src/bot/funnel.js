const db = require("../db");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { botStages: T } = require("./templates");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");

// Pemicu handoff (satu kata utuh, tidak peka huruf besar/kecil)
const HANDOFF_REGEX = /\b(gajian|suami|batal|cancel|mahal|nanti)\b/i;

async function isKnownCustomer(phone, jid) {
  jid = normalizeJid(jid);
  const r = await db.query(
    "SELECT 1 FROM customers WHERE phone = $1 OR jid = $2 LIMIT 1",
    [phone, jid],
  );
  return r.rowCount > 0;
}

// Saat funnel selesai (HANDOFF), buat tiket Inbox supaya CS melihat leadnya.
// Gagal -> hanya dicatat; funnel tidak boleh terganggu.
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

// Dipanggil SEGERA saat pesan masuk (sebelum debounce).
// Return sesi jika customer ini harus ditangani bot (status BOT), selain itu null
// (HANDOFF / pelanggan lama) -> pesan langsung diteruskan ke inbox.js tanpa ditahan.
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
      return null; // pelanggan lama: bukan urusan funnel
    }
    await state.createSession(jid, {
      phoneNumber: phone,
      funnel_stage: 0,
      status: "BOT",
    });
    session = await state.getSession(jid);
  }
  if (isTakenOver(jid)) return null; // CS baru saja memakai slash command (DB mungkin belum tercatat)
  return session && session.status === "BOT" ? session : null;
}

// ------------------------------------------------------------------
// Takeover CS (in-memory). handleOutgoing memanggil markTakeover() SECARA SINKRON begitu
// slash command terdeteksi, SEBELUM update DB selesai. Jadi funnel yang sedang berjalan
// berhenti seketika dan funnel yang baru mulai pun tahu, walau DB belum sempat berubah.
// Jendela 3 menit cukup untuk menutup jeda sampai HANDOFF tersimpan di DB.
// ------------------------------------------------------------------
const TAKEOVER_WINDOW_MS = 3 * 60 * 1000;
const takeoverAt = new Map();

function markTakeover(jid) {
  if (takeoverAt.size > 5000) takeoverAt.clear();
  takeoverAt.set(normalizeJid(jid), Date.now());
}
const isTakenOver = (jid) =>
  Date.now() - (takeoverAt.get(jid) || 0) < TAKEOVER_WINDOW_MS;

// Kirim urutan pesan funnel secara AMAN:
//  - commit stage (dan HANDOFF pada closing) SEBELUM pesan pertama dikirim, jadi tidak ada
//    jendela di mana customer sudah dibalas tetapi sesi masih di stage lama (anti-duplikat).
//  - pesan pertama gagal  -> rollback stage (customer belum menerima apa pun, boleh diulang)
//  - pesan ke-2 dst gagal -> dicatat saja; stage TETAP maju (customer sudah menerima sebagian,
//    mengulang dari awal akan menggandakan pesan)
//  - CS mengambil alih di tengah jalan -> sisa pesan dibatalkan
async function deliver({ jid, steps, commit, rollback }) {
  if (isTakenOver(jid)) return "taken";
  await commit();

  for (let i = 0; i < steps.length; i++) {
    if (isTakenOver(jid)) {
      console.log(`🛑 [Bot] ${jid}: CS mengambil alih, sisa pesan funnel dibatalkan.`);
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

// Dipanggil SETELAH debounce, dengan teks gabungan. Return:
//   "replied"     -> bot sudah membalas
//   "ignored"     -> tidak ada yang perlu dilakukan (teks kosong)
//   "silent"      -> chat HANDOFF / diambil alih CS: bot diam (teks hanya dicatat sebagai tiket)
async function process_({ sender, msg, jid, text }) {
  jid = normalizeJid(jid);

  // Stiker / voice note / reaction / pesan kosong TIDAK BOLEH memajukan funnel
  if (!text || !String(text).trim()) return "ignored";

  const phone = inbox.phoneFromJid(jid);
  const session = await state.getSession(jid); // baca ulang: status bisa berubah selama debounce
  if (!session) return "silent";

  // Aturan 1: hanya balas jika status BOT (dan CS belum mengambil alih)
  if (session.status !== "BOT" || isTakenOver(jid)) return "silent";

  // Selama funnel aktif, SOP harga lama (priceFlow) jangan ikut membalas
  priceFlow.setConsultedNow(jid);

  // Aturan 3: auto-handoff. Bot diam; teks dicatat sebagai tiket oleh inbox.js (mode silent)
  if (HANDOFF_REGEX.test(text)) {
    await state.updateSession(jid, { phoneNumber: phone, status: "HANDOFF" });
    console.log(`🙋 [Bot] ${phone} HANDOFF (kata kunci): "${text.slice(0, 60)}"`);
    return "silent";
  }

  const stage = session.funnel_stage;
  const patch = (p) => state.updateSession(jid, { phoneNumber: phone, ...p });
  // Tiap pesan: "mengetik..." dulu, baru kirim (jeda acak antar pesan, tidak seragam)
  const say = (t, wait = 0) => async () => {
    if (wait) await sender.sleep(cfg.gap(wait));
    await sender.typing(jid);
    await sender.sendText(jid, t);
  };
  const pic = (file, caption, wait = 0) => async () => {
    if (wait) await sender.sleep(cfg.gap(wait));
    await sender.typing(jid);
    await sender.sendImage(jid, file, caption);
  };

  let result;
  switch (stage) {
    case 0: // Welcome Ads
      result = await deliver({
        jid,
        steps: [say(T.welcomeAds), say(T.salam, cfg.DELAY_WELCOME_MS)],
        commit: () => patch({ funnel_stage: 1 }),
        rollback: () => patch({ funnel_stage: 0 }),
      });
      break;

    case 1: // Tanya Kecamatan
      result = await deliver({
        jid,
        steps: [say(T.kecamatan)],
        commit: () => patch({ funnel_stage: 2 }),
        rollback: () => patch({ funnel_stage: 1 }),
      });
      break;

    case 2: // Katalog Harga
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

    case 3: // Format Order (closing) -> HANDOFF
      result = await deliver({
        jid,
        steps: [
          say(T.isiform),
          pic("FORMAT ORDER.jpeg", undefined, cfg.DELAY_BETWEEN_MS), // tanpa caption
          say(T.formatOrder, cfg.DELAY_BETWEEN_MS),
        ],
        // HANDOFF dicommit SEBELUM mengirim: balasan customer saat bot masih mengirim
        // sudah tidak akan memicu apa pun.
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
