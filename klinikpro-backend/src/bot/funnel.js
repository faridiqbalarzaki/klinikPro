const path = require("path");
const db = require("../db");
const inbox = require("../inbox");
const priceFlow = require("../priceFlow");
const { botStages: T, csCommands, priceFlow: PT } = require("./templates");
const state = require("./state");
const cfg = require("./config");
const { normalizeJid } = require("./jid");
const intentParser = require("./intentParser");
const replies = require("./replies");
const { detectTopic } = require("./topics");

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

  // --- TOPIK PERTANYAAN UMUM (ongkir, COD, BPOM, dst) ---
  // Dari AI (jika yakin) atau dari kamus lokal; dihitung dulu karena memengaruhi penanganan
  // keberatan ("takut efek samping" = pertanyaan keamanan, bukan penolakan).
  const nlu = ctx.nlu || null;
  const texts = textsOf(text, nlu);
  const lowers = texts.map((t) => t.toLowerCase());
  const mem = replies.getMem(jid);
  const nluTopic =
    nlu && (nlu.source === "local" || nlu.confidence >= 0.5)
      ? nlu.entities?.topic
      : null;
  const topic =
    nluTopic ||
    texts.map((t) => detectTopic(priceFlow.normalizeText(t))).find(Boolean) ||
    null;

  // --- PENANGANAN KEBERATAN (OBJECTION) YANG ELEGAN ---
  // Tetap aktif untuk semua pesan, termasuk bubble susulan.
  // Pertama & kedua: empati -> nilai (BPOM) -> tawarkan paket hemat / promo / keep order / COD,
  // sesi TETAP di tahap yang sama (customer bisa langsung memilih paket).
  // Setelah MAX_OBJECTION_REPLIES atau customer membatalkan: baru diserahkan ke CS.
  const aiObjection = intentParser.isObjection(nlu); // AI (ambang rendah) ATAU kamus lokal
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
    if (objType === "ragu" && topic === "SAFETY") objType = null; // pertanyaan keamanan -> dijawab di FAQ
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
    const r = await deliver({
      jid,
      steps: [say(replies.objectionReply(objType, n, mem), 1500)],
      // stage tetap; commit hanya memperbarui updated_at (timer anti-ghosting)
      commit: () => patch({ funnel_stage: stage }),
      rollback: async () => {},
    });
    console.log(
      `💬 [Bot] ${phone} objection ${objType} #${n} dijawab bot (stage ${stage}): "${text.slice(0, 60)}"`,
    );
    markTurn(jid, r === "replied");
    return r === "taken" ? "silent" : "replied";
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

  // --- PERTANYAAN UMUM (ongkir, COD, BPOM, cara pakai, dst): JAWAB LANGSUNG ---
  // Anti-reset: pertanyaan di tengah alur dijawab di tempat, TIDAK mengulang menu / pertanyaan
  // keluhan dari awal. Jawaban ditutup ajakan lanjut sesuai tahap (soft-selling).
  //  - customer SEKALIGUS menjawab pertanyaan tahap ini -> jawaban FAQ jadi pembuka,
  //    lalu alur normal jalan (lihat `lead` di bawah).
  //  - tidak menjawab tahap ini -> FAQ + ajakan lanjut, stage tetap.
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
          !!ent.complaint; // stage 0 & 1
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
      const r = await deliver({
        jid,
        steps: [
          say(
            toCS
              ? replies.HANDOFF.many
              : `${faqText}\n\n${replies.cta(nextStage, mem)}`,
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
        // Tanya-ulang yang nyambung & hangat. Satu-satunya yang tetap SOP persis:
        // customer minta harga di stage 1 (harga ditahan, keluhan ditanyakan dulu).
        const greeting =
          aiHas(nlu, "GREETING") ||
          (nlu?.source === "local" && nlu.intent === "GREETING");
        const reaskLine =
          stage === 1 && priceAsk
            ? reaskText[1]
            : greeting
              ? replies.greetMid(stage, mem)
              : replies.confused(stage, mem);
        const steps =
          verdict === "catalog"
            ? [
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

  // Ingat apa yang sudah disebut customer (dipakai untuk menyapa lebih personal)
  if (stage === 1 && !mem.complaint) {
    const mc = priceFlow.matchComplaint(text);
    mem.complaint =
      ent.complaint || (mc && mc.kind === "keyword" ? mc.keyword : null);
  }
  if (stage === 2 && !mem.kecamatan) mem.kecamatan = ent.kecamatan || null;

  let result;
  switch (stage) {
    case 0:
      result = await deliver({
        jid,
        steps: [...lead, say(T.salam, 1500)],
        commit: () => patch({ funnel_stage: 1 }),
        rollback: () => patch({ funnel_stage: 0 }),
      });
      break;

    case 1:
      result = await deliver({
        jid,
        steps: [
          ...lead,
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
          ...lead,
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
