const path = require("path");
const db = require("../db");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { botStages: T, csCommands, priceFlow: PT } = require("./templates");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");
const intentParser = require("./intentParser");

const ASSET_DIR =
  process.env.ASSET_DIR || path.join(__dirname, "..", "..", "assets");

// Regex untuk mendeteksi kata kunci penolakan
const HANDOFF_REGEX =
  /\b(gajian|suami|batal|cancel|mahal|nanti|kemahalan|uang|paksu|ragu|takut)\b/i;

// Validasi jawaban customer di stage 1-3 (anti chat ngawur / di luar alur).
// FUNNEL_STRICT_REPLY=false -> perilaku lama: balasan apa pun memajukan stage.
const STRICT = process.env.FUNNEL_STRICT_REPLY !== "false";
// Batas bot bertanya ulang pada stage yang sama sebelum diserahkan ke CS
// (sama dengan batas SOP harga di priceFlow.js / inbox.js).
const MAX_REASKS = Number.isFinite(priceFlow.MAX_REASKS)
  ? priceFlow.MAX_REASKS
  : 2;
const MAX_CATALOG_RESEND = 1; // katalog dikirim ulang maks. sekali di stage 3
const REASK_TTL_MS = 30 * 60 * 1000; // hitungan tanya-ulang kedaluwarsa setelah 30 menit

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

// Mencatat apakah giliran (turn) terakhir untuk jid ini benar-benar membalas.
// Direset (replied=false) di awal setiap giliran yang diproses, jadi giliran yang
// gagal / tidak membalas tidak meninggalkan status "sudah membalas" yang basi.
const lastTurn = new Map();
function markTurn(jid, replied) {
  if (lastTurn.size > 5000) lastTurn.clear();
  lastTurn.set(jid, { replied: !!replied, at: Date.now() });
}

// Hitungan "bot bertanya ulang" per customer, dipisah per jenis (stage:verdict) supaya
// tanya-ulang biasa dan kirim-ulang katalog tidak saling menghabiskan jatah.
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
  if (isTakenOver(jid)) return "taken";

  // INSTANT STAGE LOCK: stage di-commit ke DB SEBELUM sleep/typing/kirim pesan.
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

// ------------------------------------------------------------------
// Penilai jawaban customer (hanya heuristik ringan, tanpa AI)
// ------------------------------------------------------------------
// Pertanyaan harga: pencocok priceFlow (per kata; "berapa lama/hari/kali" bukan harga)
// + kata "price" yang sebelumnya ada di regex lama.
const isPriceAsk = (text) =>
  priceFlow.isPriceQuestion(text) || /\bprice\b/i.test(text);

// ------------------------------------------------------------------
// Jembatan ke AI Intent Parser (ctx.nlu dari index.js)
// ------------------------------------------------------------------
// Aturan lokal selalu jalan lebih dulu pada teks asli DAN teks hasil normalisasi slang
// (nlu.normalized: "pket"->"paket", "pelek"->"flek"; deterministik, bukan buatan AI).
// Hasil AI hanya MENAMBAH sinyal (intent / entity tervalidasi, keyakinan >= ambang);
// tidak ada teks AI yang dikirim ke customer dan keputusan bisnis tetap di bawah.
const textsOf = (text, nlu) =>
  nlu?.normalized && nlu.normalized !== priceFlow.normalizeText(text)
    ? [text, nlu.normalized]
    : [text];
const aiHas = (nlu, intent) =>
  intentParser.isTrusted(nlu) && nlu.intents.includes(intent);

// Sapaan / basa-basi / tawa / partikel: bukan keluhan, bukan kecamatan, bukan pilihan paket.
const FILLER = new Set([
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
// Kata setuju: BUKAN jawaban untuk keluhan / kecamatan, tapi jawaban sah untuk
// pertanyaan pilihan paket di stage 3 ("mau", "oke", "boleh").
const AFFIRM = new Set([
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
// Pola ketukan keyboard asal (baris QWERTY) yang paling sering dipakai iseng
const KEYMASH_RE =
  /asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|uiop|zxcv|xcvb|cvbn|vbnm|qaz|wsx/;
function isGibberishToken(t) {
  if (!/\p{L}/u.test(t)) return false;
  return (
    /(.)\1{3,}/u.test(t) || // aaaaa, hahahahaha
    LAUGH_RE.test(t) || // wkwkwk, hahaha, hehe
    KEYMASH_RE.test(t) || // asdfg, qwerty, zxcvb
    /[^aeiou\d]{5,}/.test(t) // 5+ konsonan beruntun
  );
}

// Kata bermakna: bukan sapaan/tawa/ngawur (dan bukan kata setuju, kecuali diminta).
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

// "ok"      = jawaban masuk akal untuk stage ini -> lanjut alur
// "reask"   = bukan jawaban (sapaan/tawa/ngawur/emoji) -> tanya ulang, stage tetap
// "catalog" = (stage 3) customer minta harga lagi, bukan memesan -> kirim ulang katalog
function judgeReply(stage, text, nlu = null) {
  const texts = textsOf(text, nlu);
  const ai = intentParser.isTrusted(nlu) ? nlu : null;
  const maxWords = (affirm) =>
    Math.max(...texts.map((t) => contentWords(t, affirm).length));
  const price = texts.some(isPriceAsk) || aiHas(nlu, "PRICE_INQUIRY");

  // AI yakin pesan ini HANYA sapaan ("mikum", "p", "permisi") -> bukan jawaban.
  // (Veto ini hanya boleh MENAHAN kemajuan stage; paling buruk bot bertanya ulang,
  // dan setelah MAX_REASKS diserahkan ke CS.)
  const greetOnly =
    !!ai &&
    ai.intents.length === 1 &&
    ai.intents[0] === "GREETING" &&
    !ai.entities.complaint &&
    !ai.entities.kecamatan;
  if (greetOnly && !price) return "reask";

  if (stage === 1) {
    // Menunggu keluhan
    if (
      texts.some((t) => priceFlow.isComplaint(t)) || // kata keluhan / angka menu 1-6
      aiHas(nlu, "COMPLAINT") ||
      ai?.entities.complaint
    )
      return "ok";
    if (!price && maxWords(false) >= 2) return "ok";
    return "reask";
  }
  if (stage === 2) {
    // Menunggu kecamatan; minta harga = jawaban untuk katalog
    if (price) return "ok";
    if (aiHas(nlu, "KECAMATAN") || ai?.entities.kecamatan) return "ok";
    return maxWords(false) >= 1 ? "ok" : "reask";
  }
  if (stage === 3) {
    // Menunggu pilihan paket
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

/**
 * ctx (opsional, diisi oleh index.js):
 *  - late:        true jika buffer ini mulai terkumpul saat proses funnel
 *                 sebelumnya untuk jid yang sama masih berjalan/antre, atau
 *                 sesaat setelah bot selesai membalas.
 *  - stageAtOpen: stage yang terbaca saat bubble pertama buffer masuk.
 *  - nlu:         hasil intentParser.parse() (AI atau fallback lokal); opsional.
 * Return: "replied" | "silent" | "ignored" | "absorbed"
 */
async function process_({ sender, msg, jid, text, ctx = {} }) {
  jid = normalizeJid(jid);

  if (!text || !String(text).trim()) return "ignored";

  const phone = inbox.phoneFromJid(jid);

  // VALIDASI ULANG: baca stage terbaru dari DB di dalam antrean (serial per jid),
  // setelah semua bubble digabung. Ini selalu stage paling mutakhir.
  const session = await state.getSession(jid);
  if (!session) return "silent";

  if (session.status !== "BOT" || isTakenOver(jid)) return "silent";

  priceFlow.setConsultedNow(jid);

  const stage = session.funnel_stage;
  const patch = (p) => state.updateSession(jid, { phoneNumber: phone, ...p });

  // Setiap langkah mengecek ulang takeover CS SESUDAH jeda, tepat sebelum kirim:
  // CS bisa mengambil alih saat bot sedang "tidur" / "mengetik".
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

  // --- CEGAT PENOLAKAN (AUTO-OBJECTION HANDLING) ---
  // Tetap aktif untuk semua pesan, termasuk bubble susulan.
  // Regex lokal dicek pada teks asli + teks ter-normalisasi slang. AI (OBJECTION) hanya
  // menambah penangkapan untuk gaya bahasa yang lolos regex; template yang dikirim
  // tetap template SOP milik kita.
  const nlu = ctx.nlu || null;
  const texts = textsOf(text, nlu);
  const lowers = texts.map((t) => t.toLowerCase());
  const aiObjection = aiHas(nlu, "OBJECTION");
  if (lowers.some((l) => HANDOFF_REGEX.test(l)) || aiObjection) {
    let replyTemplate = null;
    const lt = (re) => lowers.some((l) => re.test(l));
    if (lt(/mahal|kemahalan|uang/i)) replyTemplate = csCommands.mahal;
    else if (lt(/suami|paksu/i)) replyTemplate = csCommands.paksu;
    else if (lt(/nanti|besok|kapan/i)) replyTemplate = csCommands.nanti;
    else if (lt(/ragu|takut|efek/i)) replyTemplate = csCommands.ragu;
    else if (aiObjection) {
      // Tidak ada kata kunci lokal: pakai klasifikasi AI -> template yang sama
      replyTemplate =
        {
          mahal: csCommands.mahal,
          paksu: csCommands.paksu,
          nanti: csCommands.nanti,
          ragu: csCommands.ragu,
        }[nlu.entities.objection_type] || null; // batal/lainnya -> handoff tanpa template
    }

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

  // --- STRICT STAGE VALIDATION: SERAP BUBBLE SUSULAN ---
  // Bubble susulan = diketik customer saat bot masih memproses/mengetik balasan
  // untuk bubble sebelumnya. Jangan majukan stage / picu harga / katalog lagi.
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

  // Dari sini giliran ini diproses sungguhan. Status "sudah membalas" direset dulu;
  // baru jadi true jika balasan benar-benar terkirim (jadi giliran yang gagal tidak
  // membuat bubble susulan berikutnya ikut diserap).
  markTurn(jid, false);

  // --- CEGAT KATA KUNCI "HARGA" (PRICE FLOW) ---
  // Stage 0: tahan harga, tanyakan keluhan dulu. (Stage 1 ditangani penilai jawaban
  // di bawah; mode lama FUNNEL_STRICT_REPLY=false tetap memakai cegat ini.)
  const priceAsk = texts.some(isPriceAsk) || aiHas(nlu, "PRICE_INQUIRY");
  if ((stage === 0 || (!STRICT && stage === 1)) && priceAsk) {
    const r = await deliver({
      jid,
      steps: [say(PT.askComplaint, 1500)],
      commit: () => patch({ funnel_stage: 1 }),
      rollback: () => patch({ funnel_stage: stage }),
    });
    markTurn(jid, r === "replied");
    return r === "taken" ? "silent" : "replied";
  }

  // --- PENILAI JAWABAN: CHAT NGAWUR / DI LUAR ALUR ---
  if (STRICT && stage >= 1 && stage <= 3) {
    const verdict = judgeReply(stage, text, nlu);
    if (verdict === "reask" || verdict === "catalog") {
      const n = bumpReask(jid, `${stage}:${verdict}`);
      const limit = verdict === "catalog" ? MAX_CATALOG_RESEND : MAX_REASKS;
      if (n <= limit) {
        const reaskText = {
          1: PT.askComplaint,
          2: T.kecamatan,
          3: T.harga_tanya,
        };
        const steps =
          verdict === "catalog"
            ? [
                pic("HARGA PROMO.jpeg", T.harga_katalog),
                say(T.harga_tanya, cfg.DELAY_BETWEEN_MS),
              ]
            : [say(reaskText[stage], 1500)];
        console.log(
          `🔁 [Bot] ${phone}: ${verdict} di stage ${stage} (${n}/${limit}): "${text.slice(0, 60)}"`,
        );
        const r = await deliver({
          jid,
          steps,
          // stage tetap; commit hanya memperbarui updated_at (timer anti-ghosting)
          commit: () => patch({ funnel_stage: stage }),
          rollback: async () => {},
        });
        markTurn(jid, r === "replied");
        return r === "taken" ? "silent" : "replied";
      }
      if (verdict === "reask") {
        // Sudah ditanya ulang melebihi batas: serahkan ke CS (tiket dibuat lewat forward silent)
        await patch({ status: "HANDOFF" });
        console.log(
          `🙋 [Bot] ${phone} HANDOFF (jawaban di luar alur ${n - 1}x): "${text.slice(0, 60)}"`,
        );
        return "silent";
      }
      // verdict "catalog" melewati batas kirim ulang: lanjut ke alur normal (form order)
    }
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

  if (result === "replied") reasks.delete(jid); // stage maju: hitungan tanya-ulang direset
  markTurn(jid, result === "replied");
  return result === "taken" ? "silent" : "replied";
}

module.exports = {
  admit,
  process: process_,
  markTakeover,
  isTakenOver,
  HANDOFF_REGEX,
  judgeReply, // diekspor untuk pengujian
};
