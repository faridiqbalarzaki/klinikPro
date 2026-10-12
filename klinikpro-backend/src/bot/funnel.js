// funnel.js
const path = require("path");
const db = require("../db");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { botStages: T, csCommands, priceFlow: PT } = require("./templates");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");
const intentParser = require("./intentParser");
const replies = require("./replies"); // Integrasi modul balasan
const { detectTopic } = require("./topics"); // Integrasi modul topik FAQ

const ASSET_DIR =
  process.env.ASSET_DIR || path.join(__dirname, "..", "..", "assets");

// Regex untuk mendeteksi kata kunci penolakan
const HANDOFF_REGEX =
  /\b(gajian|suami|batal|cancel|mahal|nanti|kemahalan|uang|paksu|ragu|takut)\b/i;

const STRICT = process.env.FUNNEL_STRICT_REPLY !== "false";
const MAX_REASKS = Number.isFinite(priceFlow.MAX_REASKS)
  ? priceFlow.MAX_REASKS
  : 2;
const MAX_CATALOG_RESEND = 1;
const REASK_TTL_MS = 30 * 60 * 1000;

async function isKnownCustomer(phone, jid) {
  jid = normalizeJid(jid);
  const r = await db.query(
    "SELECT 1 FROM customers WHERE phone = $1 OR jid = $2 LIMIT 1",
    [phone, jid],
  );
  return r.rowCount > 0;
}

async function recordLeadTicket({ jid, phone, pushName, text }) {
  // ... (Fungsi recordLeadTicket tidak diubah) ...
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
  // ... (Fungsi admit tidak diubah) ...
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

const lastTurn = new Map();
function markTurn(jid, replied) {
  if (lastTurn.size > 5000) lastTurn.clear();
  lastTurn.set(jid, { replied: !!replied, at: Date.now() });
}

const reasks = new Map();
function bumpReask(jid, kind) {
  if (reasks.size > 5000) reasks.clear();
  const now = Date.now();
  let e = reasks.get(jid);
  if (!e || now - e.at > REASK_TTL_MS) e = { at: now, counts: {} };
  e.at = now;
  e.counts[kind] = (e.counts[kind] || 0) + 1;
  reasks.set(jid, e);
  return e.counts[kind];
}

async function deliver({ jid, steps, commit, rollback }) {
  // ... (Fungsi deliver tidak diubah) ...
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

const isPriceAsk = (text) =>
  priceFlow.isPriceQuestion(text) || /\bprice\b/i.test(text);

const textsOf = (text, nlu) =>
  nlu?.normalized && nlu.normalized !== priceFlow.normalizeText(text)
    ? [text, nlu.normalized]
    : [text];
const aiHas = (nlu, intent) =>
  intentParser.isTrusted(nlu) && nlu.intents.includes(intent);

const FILLER = new Set([
  // ... (Daftar FILLER tidak diubah) ...
  "p",
  "pp",
  "ping",
  "test",
  "tes",
  "halo",
  "hallo",
  "hai",
  "hi",
  "hy",
  "hello",
  "hey",
  "assalamualaikum",
  "assalamu",
  "alaikum",
  "waalaikumsalam",
  "salam",
  "selamat",
  "pagi",
  "siang",
  "sore",
  "malam",
  "kak",
  "kakak",
  "ka",
  "kk",
  "kaka",
  "min",
  "admin",
  "permisi",
  "hmm",
  "hm",
  "mm",
  "oh",
  "ooh",
  "ohh",
  "lol",
  "thx",
  "thanks",
  "makasih",
  "terima",
  "kasih",
  "trims",
  "dong",
  "deh",
  "sih",
  "nih",
  "tuh",
  "aja",
  "lah",
  "kok",
  "tanya",
  "nanya",
  "bun",
  "bunda",
  "mba",
  "mbak",
  "mas",
  "bu",
  "ibu",
  "pak",
  "bapak",
  "sis",
  "gan",
  "kan",
  "ini",
  "itu",
  "yang",
  "dan",
  "di",
  "ke",
]);

const AFFIRM = new Set([
  // ... (Daftar AFFIRM tidak diubah) ...
  "ok",
  "oke",
  "okey",
  "okay",
  "sip",
  "siap",
  "ya",
  "iya",
  "yaa",
  "yes",
  "yup",
  "mau",
  "boleh",
  "bisa",
  "jadi",
  "lanjut",
  "setuju",
  "gas",
]);

const tokensOf = (text) =>
  priceFlow.normalizeText(text).split(" ").filter(Boolean);

const LAUGH_RE = /^(?:(?:wk)+w?k*|(?:ha|he|hi|ho|xi)+h?|(?:kw)+k?)$/;
const KEYMASH_RE =
  /asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|uiop|zxcv|xcvb|cvbn|vbnm|qaz|wsx/;
function isGibberishToken(t) {
  if (!/\p{L}/u.test(t)) return false;
  return (
    /(.)\1{3,}/u.test(t) ||
    LAUGH_RE.test(t) ||
    KEYMASH_RE.test(t) ||
    /[^aeiou\d]{5,}/.test(t)
  );
}

function contentWords(text, affirmIsContent = false) {
  return tokensOf(text).filter(
    (t) =>
      /\p{L}{2,}/u.test(t) &&
      !FILLER.has(t) &&
      (affirmIsContent || !AFFIRM.has(t)) &&
      !isGibberishToken(t),
  );
}

const ORDER_INTENT_RE =
  /(?:^| )(?:ambil|pesan|order|beli|jadi|lanjut|cod|transfer)(?: |$)/;
const CHOICE_DIGIT_RE = /(?:^| )[1-3](?: |$)/;

function judgeReply(stage, text, nlu = null) {
  // ... (Logika judgeReply dipertahankan, memastikan anti-reset berjalan baik) ...
  const texts = textsOf(text, nlu);
  const ai = intentParser.isTrusted(nlu) ? nlu : null;
  const maxWords = (affirm) =>
    Math.max(...texts.map((t) => contentWords(t, affirm).length));
  const price = texts.some(isPriceAsk) || aiHas(nlu, "PRICE_INQUIRY");

  const greetOnly =
    !!ai &&
    ai.intents.length === 1 &&
    ai.intents[0] === "GREETING" &&
    !ai.entities.complaint &&
    !ai.entities.kecamatan;

  if (greetOnly && !price) return "reask"; // Mencegah reset jika hanya menyapa

  if (stage === 1) {
    if (
      texts.some((t) => priceFlow.isComplaint(t)) ||
      aiHas(nlu, "COMPLAINT") ||
      ai?.entities.complaint
    )
      return "ok";
    if (!price && maxWords(false) >= 2) return "ok";
    return "reask";
  }
  if (stage === 2) {
    if (price) return "ok";
    if (aiHas(nlu, "KECAMATAN") || ai?.entities.kecamatan) return "ok";
    return maxWords(false) >= 1 ? "ok" : "reask";
  }
  if (stage === 3) {
    const norms = texts.map((t) => priceFlow.normalizeText(t));
    const wantsOrder =
      norms.some((n) => ORDER_INTENT_RE.test(n)) ||
      aiHas(nlu, "ORDER_INTENT") ||
      !!ai?.entities.package;
    if (price && !wantsOrder) return "catalog";
    if (
      wantsOrder ||
      aiHas(nlu, "AFFIRM") ||
      norms.some((n) => CHOICE_DIGIT_RE.test(n)) ||
      maxWords(true) >= 1
    )
      return "ok";
    return "reask";
  }
  return "ok";
}

async function process_({ sender, msg, jid, text, ctx = {} }) {
  jid = normalizeJid(jid);

  if (!text || !String(text).trim()) return "ignored";

  const phone = inbox.phoneFromJid(jid);

  const session = await state.getSession(jid);
  if (!session) return "silent";

  if (session.status !== "BOT" || isTakenOver(jid)) return "silent";

  priceFlow.setConsultedNow(jid);

  const stage = session.funnel_stage;
  const patch = (p) => state.updateSession(jid, { phoneNumber: phone, ...p });

  const say =
    (t, wait = 0) =>
    async () => {
      if (wait) await sender.sleep(cfg.gap(wait));
      if (isTakenOver(jid)) return;
      await sender.typing(jid);
      if (isTakenOver(jid)) return;
      await sender.sendText(jid, t);
    };
  const pic =
    (file, caption, wait = 0) =>
    async () => {
      if (wait) await sender.sleep(cfg.gap(wait));
      if (isTakenOver(jid)) return;
      await sender.typing(jid);
      if (isTakenOver(jid)) return;
      await sender.sendImage(jid, file, caption);
    };

  const nlu = ctx.nlu || null;
  const texts = textsOf(text, nlu);
  const lowers = texts.map((t) => t.toLowerCase());
  const mem = replies.getMem(jid); // Integrasi memori dari replies.js

  const nluTopic =
    nlu && (nlu.source === "local" || nlu.confidence >= 0.5)
      ? nlu.entities?.topic
      : null;
  const topic =
    nluTopic ||
    texts.map((t) => detectTopic(priceFlow.normalizeText(t))).find(Boolean) ||
    null;

  // --- PENANGANAN KEBERATAN (OBJECTION) ---
  const aiObjection = intentParser.isObjection(nlu);
  const lt = (re) => lowers.some((l) => re.test(l));
  let objType = null;

  if (lowers.some((l) => HANDOFF_REGEX.test(l)) || aiObjection) {
    if (lt(/batal|cancel/i)) objType = "batal";
    else if (lt(/mahal|kemahalan|uang/i)) objType = "mahal";
    else if (lt(/suami|paksu/i)) objType = "paksu";
    else if (lt(/nanti|besok|kapan|gajian/i)) objType = "nanti";
    else if (lt(/ragu|takut/i)) objType = "ragu";
    else if (aiObjection) objType = nlu.entities.objection_type || "lainnya";
    else objType = "lainnya";

    // Pastikan pertanyaan tentang keamanan kulit dijawab dengan FAQ, bukan dianggap ragu
    if (objType === "ragu" && topic === "SAFETY") objType = null;
  }

  if (objType) {
    const n = ++mem.objections;
    const toCS = objType === "batal" || n > cfg.MAX_OBJECTION_REPLIES;
    if (toCS) {
      const line =
        objType === "batal"
          ? replies.HANDOFF.cancel
          : replies.HANDOFF.objection;
      await deliver({
        jid,
        steps: [say(line, 1200)],
        commit: () => patch({ status: "HANDOFF" }),
        rollback: () => patch({ status: "BOT" }),
      });
      console.log(
        `🙋 [Bot] ${phone} HANDOFF (objection ${objType} #${n}): "${text.slice(0, 60)}"`,
      );
      markTurn(jid, true);
      return "silent";
    }

    // Menggunakan replies.js untuk memberikan balasan empati yang natural
    const objectionText = replies.objectionReply(objType, n, mem);
    const r = await deliver({
      jid,
      steps: [say(objectionText, 1500)],
      commit: () => patch({ funnel_stage: stage }),
      rollback: async () => {},
    });
    console.log(
      `💬 [Bot] ${phone} objection ${objType} #${n} dijawab bot (stage ${stage}): "${text.slice(0, 60)}"`,
    );
    markTurn(jid, r === "replied");
    return r === "taken" ? "silent" : "replied";
  }

  // --- CEGAH BUBBLE SUSULAN (Mencegah bot mengirim pesan beruntun jika customer mengetik cepat) ---
  const stageMoved =
    typeof ctx.stageAtOpen === "number" && stage > ctx.stageAtOpen;
  const botJustReplied =
    ctx.late === true && lastTurn.get(jid)?.replied === true;

  if (stageMoved || botJustReplied) {
    console.log(
      `🧩 [Bot] ${phone}: bubble susulan diserap (stage ${stage}, open=${ctx.stageAtOpen ?? "-"}): "${text.slice(0, 60)}"`,
    );
    return "absorbed";
  }

  markTurn(jid, false);

  // --- PENANGANAN FAQ & PERTANYAAN DI TENGAH ALUR ---
  const ent = nlu?.entities || {};
  const stageAnswered =
    stage === 3
      ? texts.some((t) => ORDER_INTENT_RE.test(priceFlow.normalizeText(t))) ||
        aiHas(nlu, "ORDER_INTENT") ||
        !!ent.package
      : stage === 2
        ? !!ent.kecamatan || aiHas(nlu, "KECAMATAN")
        : texts.some((t) => priceFlow.isComplaint(t)) ||
          aiHas(nlu, "COMPLAINT") ||
          !!ent.complaint;

  const faqText = topic ? replies.faqBody(topic, mem) : null;
  let lead = [];

  if (faqText && stage <= 3) {
    if (stageAnswered) {
      lead = [say(faqText, 1200)];
    } else {
      mem.faqs++;
      mem.lastTopic = topic;
      const toCS = mem.faqs > cfg.MAX_FAQ_REPLIES;
      const nextStage = stage === 0 ? 1 : stage;

      // Tambahkan sedikit basa-basi sebelum CTA agar lebih natural
      const transition = replies.pick(mem, "faq_transition", [
        "Btw Kak, ",
        "Oh iya, untuk lanjut prosesnya, ",
        "Nah, sambil lanjut obrolan kita, ",
      ]);

      const r = await deliver({
        jid,
        steps: [
          say(
            toCS
              ? replies.HANDOFF.many
              : `${faqText}\n\n${transition}${replies.cta(nextStage, mem)}`,
            1500,
          ),
        ],
        commit: () =>
          patch(toCS ? { status: "HANDOFF" } : { funnel_stage: nextStage }),
        rollback: () => patch({ funnel_stage: stage, status: "BOT" }),
      });
      console.log(
        `💬 [Bot] ${phone} FAQ ${topic} dijawab (stage ${stage}${toCS ? ", -> CS" : ""}): "${text.slice(0, 60)}"`,
      );
      markTurn(jid, r === "replied");
      return r === "taken" || toCS ? "silent" : "replied";
    }
  }

  // --- CEGAT KATA KUNCI HARGA DI AWAL ---
  const priceAsk = texts.some(isPriceAsk) || aiHas(nlu, "PRICE_INQUIRY");
  if ((stage === 0 || (!STRICT && stage === 1)) && priceAsk) {
    // Menggunakan basa-basi natural jika customer langsung bertanya harga
    const politePriceBlock = `Halo Kak 🥰 Boleh banget, tapi biar hasilnya maksimal dan sesuai, boleh cerita dulu keluhan kulitnya Kak? Nanti Lizel kasih saran paket yang paling pas untuk kondisi kulit kakak ✨`;

    const r = await deliver({
      jid,
      steps: [say(politePriceBlock, 1500)],
      commit: () => patch({ funnel_stage: 1 }),
      rollback: () => patch({ funnel_stage: stage }),
    });
    markTurn(jid, r === "replied");
    return r === "taken" ? "silent" : "replied";
  }

  // --- PENANGANAN JAWABAN TIDAK VALID / GREETING DI TENGAH ALUR ---
  if (STRICT && stage >= 1 && stage <= 3) {
    const verdict = judgeReply(stage, text, nlu);

    if (verdict === "reask" || verdict === "catalog") {
      const n = bumpReask(jid, `${stage}:${verdict}`);
      const limit = verdict === "catalog" ? MAX_CATALOG_RESEND : MAX_REASKS;

      if (n <= limit) {
        const greeting =
          aiHas(nlu, "GREETING") ||
          (nlu?.source === "local" && nlu.intent === "GREETING");

        let reaskLine;

        // Memastikan penanganan GREETING yang lebih natural
        if (greeting) {
          reaskLine = replies.greetMid(stage, mem);
        } else if (stage === 1 && priceAsk) {
          reaskLine = `Sabar ya kak say 🥰 Biar harganya pas dengan perawatannya, boleh cerita dulu keluhan kulitnya? Nanti Lizel kasih saran paket yang paling pas ✨`;
        } else {
          reaskLine = replies.confused(stage, mem);
        }

        const steps =
          verdict === "catalog"
            ? [
                // PERINGATAN: Pastikan T.harga_katalog di templates.js TIDAK mengandung promo fiktif
                pic("HARGA PROMO.jpeg", T.harga_katalog),
                say(T.harga_tanya, cfg.DELAY_BETWEEN_MS),
              ]
            : [say(reaskLine, 1500)];

        console.log(
          `🔁 [Bot] ${phone}: ${verdict} di stage ${stage} (${n}/${limit}): "${text.slice(0, 60)}"`,
        );
        const r = await deliver({
          jid,
          steps,
          commit: () => patch({ funnel_stage: stage }),
          rollback: async () => {},
        });
        markTurn(jid, r === "replied");
        return r === "taken" ? "silent" : "replied";
      }
      if (verdict === "reask") {
        await patch({ status: "HANDOFF" });
        console.log(
          `🙋 [Bot] ${phone} HANDOFF (jawaban di luar alur ${n - 1}x): "${text.slice(0, 60)}"`,
        );
        return "silent";
      }
    }
  }

  // Simpan detail customer ke memori percakapan
  if (stage === 1 && !mem.complaint) {
    const mc = priceFlow.matchComplaint(text);
    mem.complaint =
      ent.complaint || (mc && mc.kind === "keyword" ? mc.keyword : null);
  }
  if (stage === 2 && !mem.kecamatan) mem.kecamatan = ent.kecamatan || null;

  // --- ALUR UTAMA FUNNEL (SOP normal) ---
  let result;
  switch (stage) {
    case 0:
      // Salam Pembuka (SOP)
      result = await deliver({
        jid,
        steps: [...lead, say(T.salam, 1500)],
        commit: () => patch({ funnel_stage: 1 }),
        rollback: () => patch({ funnel_stage: 0 }),
      });
      break;

    case 1:
      // Penjelasan Solusi Kulit
      // Menambahkan basa-basi empati sebelum memberikan solusi
      const empathyPrefix = mem.complaint
        ? `Noted Kak, untuk keluhan ${mem.complaint} memang butuh perawatan yang tepat 🥰. `
        : `Baik kak say, untuk kulit yang sehat memang butuh rutinitas yang baik 🥰. `;

      result = await deliver({
        jid,
        steps: [
          ...lead,
          say(empathyPrefix + PT.step1Solusi, 1000),
          pic("awal.jpeg", PT.step2Product, 2000),
          pic("akhir.jpeg", PT.step3Testi, 2500),
        ],
        commit: () => patch({ funnel_stage: 2 }),
        rollback: () => patch({ funnel_stage: 1 }),
      });
      break;

    case 2:
      // Penawaran Harga
      result = await deliver({
        jid,
        steps: [
          ...lead,
          // PERINGATAN: Pastikan T.harga_katalog di templates.js HANYA berisi fakta SOP
          pic("HARGA PROMO.jpeg", T.harga_katalog),
          say(T.harga_tanya, cfg.DELAY_BETWEEN_MS),
        ],
        commit: () => patch({ funnel_stage: 3 }),
        rollback: () => patch({ funnel_stage: 2 }),
      });
      break;

    case 3:
      // Formulir Pemesanan
      result = await deliver({
        jid,
        steps: [
          ...lead,
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

  if (result === "replied") reasks.delete(jid);
  markTurn(jid, result === "replied");
  return result === "taken" ? "silent" : "replied";
}

module.exports = {
  admit,
  process: process_,
  markTakeover,
  isTakenOver,
  HANDOFF_REGEX,
  judgeReply,
};
