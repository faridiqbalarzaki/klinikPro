// Inbox CRM: memproses pesan masuk WhatsApp (Baileys `messages.upsert`).
//   1. ekstrak teks + deteksi lampiran
//   2. auto-reply berdasarkan keywords di tabel templates (type = 'auto_reply')
//   3. kategorisasi otomatis (Order / Penawaran / Batal / General)
//   4. UPSERT tiket 'pending' (satu tiket pending per customer)
// Fungsi murni (normalize, categorize, matchAutoReply, extractContent) diekspor
// agar mudah diuji tanpa WhatsApp/database.
const db = require("./db");
const media = require("./media"); // FITUR BARU: Import media untuk menyimpan gambar pelanggan
const priceFlow = require("./priceFlow"); // FITUR BARU: alur konsultatif harga

// FITUR BARU: Deteksi jika pesan berisi gambar (baik langsung maupun diforward/quoted)
const isImageMessage = (message) => Boolean(unwrap(message)?.imageMessage);

// FITUR BARU: Unduh foto pelanggan ke disk (uploads/inbox/).
// Gagal -> null (tiket tetap dibuat tanpa foto).
async function downloadImage(sock, msg) {
  try {
    const { downloadMediaMessage } = require("@whiskeysockets/baileys");
    const buf = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: require("pino")({ level: "silent" }),
        reuploadRequest: sock.updateMediaMessage,
      },
    );
    return media.saveInboxBuffer(buf);
  } catch (err) {
    console.error("⚠️  Gagal mengunduh foto pelanggan:", err.message);
    return null;
  }
}

const CATEGORIES = ["Order", "Penawaran", "Batal", "General"];

// Jika true: kategori spesifik (Order/Penawaran/Batal) tidak ditimpa oleh deteksi
// "General" (mis. "ok kak", "terima kasih", atau kiriman bukti transfer tanpa caption).
// Ubah ke false untuk perilaku "selalu timpa dengan deteksi terbaru" secara harfiah.
const KEEP_SPECIFIC_CATEGORY = true;

// Log diagnostik pesan masuk. Matikan di produksi dengan INBOX_DEBUG=false di .env
const DEBUG = process.env.INBOX_DEBUG !== "false";
const dbg = (...args) => {
  if (DEBUG) console.log("🔎 [Inbox]", ...args);
};

const AUTO_REPLY_COOLDOWN_MS =
  Number(process.env.AUTO_REPLY_COOLDOWN_MS) || 60 * 1000;

// Jeda sebelum bot membalas (ms). Default 8-10 detik, acak di antaranya.
const AUTO_REPLY_DELAY_MIN_MS =
  Number(process.env.AUTO_REPLY_DELAY_MIN_MS) || 8000;
const AUTO_REPLY_DELAY_MAX_MS = Math.max(
  Number(process.env.AUTO_REPLY_DELAY_MAX_MS) || 10000,
  AUTO_REPLY_DELAY_MIN_MS,
);
const TYPING_MS = 4000; // lama indikator "sedang mengetik" sebelum pesan terkirim
// ------------------------------------------------------------------
// Aturan kategori (urutan prioritas: strongBatal > order > penawaran > weakBatal)
// Pencocokan = AWAL KATA, jadi "harga" juga cocok dengan "harganya".
// ------------------------------------------------------------------
const RULES = {
  strongBatal: [
    "batal",
    "cancel",
    "gak jadi",
    "ga jadi",
    "gk jadi",
    "nggak jadi",
    "ngga jadi",
    "tidak jadi",
    "ntar dulu",
    "nanti dulu",
  ],
  order: [
    "beli",
    "membeli",
    "pesan",
    "memesan",
    "transfer",
    "rekening",
    "jadi ambil",
    "mau paket",
  ],
  penawaran: ["minat", "boleh", "harga", "gimana caranya", "promo"],
  weakBatal: ["maaf"],
};

// ------------------------------------------------------------------
// Utilitas teks
// ------------------------------------------------------------------
function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasPhrase(normText, phrase, wholeWord = false) {
  const p = normalize(phrase);
  if (!p) return false;
  const body = escapeRe(p);
  const re = new RegExp(`(?:^| )${body}${wholeWord ? "(?: |$)" : ""}`);
  return re.test(normText);
}

const anyPhrase = (normText, list) => list.some((p) => hasPhrase(normText, p));

function categorize(text) {
  const t = normalize(text);
  if (!t) return "General";
  if (anyPhrase(t, RULES.strongBatal)) return "Batal";
  if (anyPhrase(t, RULES.order)) return "Order";
  if (anyPhrase(t, RULES.penawaran)) return "Penawaran";
  if (anyPhrase(t, RULES.weakBatal)) return "Batal";
  return "General";
}

function matchAutoReply(text, templates) {
  const t = normalize(text);
  if (!t) return null;
  let best = null;
  for (const tpl of templates || []) {
    for (const kw of tpl.keywords || []) {
      const k = normalize(kw);
      if (!k || !hasPhrase(t, k, true)) continue;
      if (
        !best ||
        k.length > best.len ||
        (k.length === best.len && tpl.id < best.tpl.id)
      ) {
        best = { tpl, len: k.length };
      }
    }
  }
  return best ? best.tpl : null;
}

function renderTemplate(template, { nama, treatment, tanggal }) {
  return String(template)
    .replace(/{{\s*nama\s*}}/gi, () => nama || "Kak")
    .replace(/{{\s*treatment\s*}}/gi, () => treatment || "Treatment")
    .replace(/{{\s*tanggal\s*}}/gi, () => tanggal || "");
}

// ------------------------------------------------------------------
// Ekstrak isi pesan Baileys
// ------------------------------------------------------------------
function unwrap(message) {
  let cur = message;
  for (let i = 0; i < 5 && cur; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message ||
      cur.quotedMessage; // Pastikan quoted message juga dicek
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function extractContent(message) {
  const m = unwrap(message);
  if (!m) return null;

  if (m.conversation) {
    return { text: String(m.conversation), hasAttachment: false, label: "" };
  }
  if (m.extendedTextMessage?.text) {
    return {
      text: String(m.extendedTextMessage.text),
      hasAttachment: false,
      label: "",
    };
  }
  if (m.imageMessage) {
    return {
      text: String(m.imageMessage.caption || ""),
      hasAttachment: true,
      label: "[Gambar]",
    };
  }
  if (m.videoMessage) {
    return {
      text: String(m.videoMessage.caption || ""),
      hasAttachment: true,
      label: "[Video]",
    };
  }
  if (m.documentMessage) {
    return {
      text: String(m.documentMessage.caption || ""),
      hasAttachment: true,
      label: "[Dokumen]",
    };
  }
  if (m.audioMessage) {
    return { text: "", hasAttachment: false, label: "[Pesan suara]" };
  }
  return null;
}

function resolveJid(key) {
  let jid = key?.remoteJid;
  if (!jid) return null;
  if (
    jid.endsWith("@lid") &&
    String(key.remoteJidAlt || "").endsWith("@s.whatsapp.net")
  ) {
    jid = key.remoteJidAlt;
  }
  if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) return null;
  return jid.replace(/:\d+@/, "@");
}

const phoneFromJid = (jid) => jid.split("@")[0].replace(/\D/g, "");

// ------------------------------------------------------------------
// SQL
// ------------------------------------------------------------------
const CATEGORY_UPDATE = KEEP_SPECIFIC_CATEGORY
  ? "CASE WHEN EXCLUDED.category = 'General' THEN tickets.category ELSE EXCLUDED.category END"
  : "EXCLUDED.category";

const UPSERT_TICKET_SQL = `
  WITH cust AS (
    INSERT INTO customers (phone, jid, name)
    VALUES ($1::text, $2::text, $3::text)
    ON CONFLICT (phone) DO UPDATE SET
      jid  = COALESCE(customers.jid, EXCLUDED.jid),
      name = CASE
               WHEN EXCLUDED.name IS NOT NULL
                AND COALESCE(customers.name, '') IN ('', 'Kak')
               THEN EXCLUDED.name
               ELSE customers.name
             END
    RETURNING id
  )
  INSERT INTO tickets (customer_id, last_message, status, category, has_attachment)
  SELECT id, $4::text, 'pending', $5::text, $6::boolean FROM cust
  ON CONFLICT (customer_id) WHERE status = 'pending'
  DO UPDATE SET
    last_message   = EXCLUDED.last_message,
    category       = ${CATEGORY_UPDATE},
    has_attachment = tickets.has_attachment OR EXCLUDED.has_attachment,
    updated_at     = NOW()
  RETURNING id, customer_id, category
`;

const AUTO_REPLY_SQL = `
  SELECT t.id, t.name, t.content, t.keywords,
         COALESCE(
           (SELECT json_agg(ti.file_name ORDER BY ti.position, ti.id)
            FROM template_images ti WHERE ti.template_id = t.id),
           '[]'::json
         ) AS images
  FROM templates t
  WHERE t.type = 'auto_reply' AND cardinality(t.keywords) > 0
  ORDER BY t.id`;

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------
const seenIds = new Set();
const lastAutoReply = new Map();

function remember(id) {
  seenIds.add(id);
  if (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jeda + indikator "mengetik..." sebelum bot membalas (pola sama dengan auto-reply)
async function humanDelay(sock, jid, deps) {
  const total =
    AUTO_REPLY_DELAY_MIN_MS +
    Math.floor(
      Math.random() * (AUTO_REPLY_DELAY_MAX_MS - AUTO_REPLY_DELAY_MIN_MS + 1),
    );
  await deps.sleep(Math.max(0, total - TYPING_MS));
  try {
    await sock.sendPresenceUpdate?.("composing", jid);
  } catch (_) {}
  await deps.sleep(Math.min(TYPING_MS, total));
}

// Template harga: PRICE_TEMPLATE_ID (opsional) -> atau template auto_reply yang
// punya keyword harga/biaya/dst. Tidak ketemu -> null (pakai teks cadangan).
function findPriceTemplate(tpls) {
  const id = Number(process.env.PRICE_TEMPLATE_ID);
  if (id) {
    const t = tpls.find((x) => x.id === id);
    if (t) return t;
  }
  for (const kw of priceFlow.PRICE_KEYWORDS) {
    const t = matchAutoReply(kw, tpls);
    if (t) return t;
  }
  return null;
}

async function processMessage(sock, msg, deps) {
  const { key } = msg;

  dbg(
    `pesan masuk -> remoteJid=${key?.remoteJid} alt=${key?.remoteJidAlt ?? "-"} ` +
      `fromMe=${key?.fromMe} id=${key?.id} pushName="${msg.pushName ?? ""}" ` +
      `isi=[${Object.keys(msg.message || {}).join(",") || "kosong"}]`,
  );

  if (!key) return null;
  if (key.fromMe) return null;

  const jid = resolveJid(key);
  if (!jid) return null;

  if (key.id) {
    const id = `${jid}:${key.id}`;
    if (seenIds.has(id)) return null;
    remember(id);
  }

  const content = extractContent(msg.message);
  if (!content) return null;
  const phone = phoneFromJid(jid);
  if (!phone) return null;

  dbg(
    `lolos filter -> nomor=${phone} teks="${content.text.slice(0, 80)}" lampiran=${content.hasAttachment}`,
  );

  // --- 0. Alur konsultatif harga: tahan harga, tanya keluhan dulu ---
  const { STATES } = priceFlow;
  const normText = normalize(content.text);
  const priceState = priceFlow.getState(jid);
  let priceComplaint = false; // true = pesan ini adalah keluhan yang dijawab dengan harga

  if (
    priceState === STATES.WAITING_FOR_COMPLAINT &&
    (content.text || content.label)
  ) {
    // Pelanggan mengulang "berapa harganya?" tanpa cerita keluhan -> tanyakan lagi, jangan reset
    const justAskingAgain =
      content.text &&
      !content.hasAttachment &&
      normText.split(" ").length <= 4 &&
      anyPhrase(normText, priceFlow.PRICE_KEYWORDS);
    if (justAskingAgain) {
      priceFlow.setState(jid, STATES.WAITING_FOR_COMPLAINT); // perpanjang TTL
      await humanDelay(sock, jid, deps);
      await deps.send(jid, priceFlow.ASK_COMPLAINT_TEXT);
      return { action: "price_gate_repeat" };
    }

    // Keluhan diterima (teks, foto, atau pesan suara) -> reset ke IDLE, kirim estimasi harga
    priceFlow.setState(jid, STATES.IDLE);
    const tpls = (await deps.query(AUTO_REPLY_SQL)).rows;
    const tpl = findPriceTemplate(tpls);
    const reply = renderTemplate(
      tpl?.content ?? priceFlow.FALLBACK_PRICE_TEXT,
      {
        nama: msg.pushName,
        treatment: "",
        tanggal: new Date().toLocaleDateString("id-ID", {
          dateStyle: "medium",
          timeZone: deps.tz,
        }),
      },
    );
    await humanDelay(sock, jid, deps);
    const mode = await deps.send(jid, reply, tpl?.images || []);
    console.log(
      `💬 Estimasi harga dikirim ke ${phone} (${mode || "teks"}) setelah keluhan`,
    );
    priceComplaint = true; // lanjut ke bawah: keluhan disimpan sebagai tiket untuk CS
  } else if (
    priceState === STATES.IDLE &&
    content.text &&
    anyPhrase(normText, priceFlow.PRICE_KEYWORDS)
  ) {
    // Ada keyword harga -> tahan info harga, tanya keluhan
    priceFlow.setState(jid, STATES.WAITING_FOR_COMPLAINT);
    try {
      await humanDelay(sock, jid, deps);
      await deps.send(jid, priceFlow.ASK_COMPLAINT_TEXT);
    } catch (err) {
      priceFlow.setState(jid, STATES.IDLE); // jangan terjebak jika kirim gagal
      throw err;
    }
    console.log(`💬 Pertanyaan harga dari ${phone} ditahan, menunggu keluhan`);
    return { action: "price_gate" };
  }

  // --- 1. Auto-reply (jika cocok: balas, lalu berhenti — tidak ada tiket) ---
  // Dilewati jika pesan ini sudah dijawab oleh alur harga
  if (content.text && !priceComplaint) {
    const tpls = (await deps.query(AUTO_REPLY_SQL)).rows;
    const hit = matchAutoReply(content.text, tpls);
    if (hit) {
      const last = lastAutoReply.get(jid) || 0;
      if (Date.now() - last >= AUTO_REPLY_COOLDOWN_MS) {
        lastAutoReply.set(jid, Date.now());
        const reply = renderTemplate(hit.content, {
          nama: msg.pushName,
          treatment: "",
          tanggal: new Date().toLocaleDateString("id-ID", {
            dateStyle: "medium",
            timeZone: deps.tz,
          }),
        });
        // 1. Tentukan waktu jeda (8-10 detik) dan lama ngetik (4 detik)
        const minMs = 8000;
        const maxMs = 10000;
        const typeMs = 4000;

        const totalDelay =
          minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
        const waitTime = Math.max(0, totalDelay - typeMs);

        // 2. Diam dulu tanpa status apa-apa
        await deps.sleep(waitTime);

        // 3. Mulai munculkan indikator "sedang mengetik..." di WA pelanggan
        try {
          await sock.sendPresenceUpdate?.("composing", jid);
        } catch (_) {}

        // 4. Tahan tulisan "mengetik..." sebelum pesan benar-benar terkirim
        await deps.sleep(Math.min(typeMs, totalDelay));

        // FITUR BARU: Auto-reply kini bisa mengirimkan gambar
        const images = Array.isArray(hit.images) ? hit.images : [];
        const mode = await deps.send(jid, reply, images);
        console.log(
          `🤖 Auto-reply "${hit.name}" ke ${phone} (${mode || "teks"})`,
        );
      } else {
        console.log(`🤖 Auto-reply ke ${phone} dilewati (cooldown).`);
      }
      return { action: "auto_reply", templateId: hit.id };
    }
  }

  // --- 2. Kategori + 3. Simpan tiket + 4. Catat pesan (& foto) ---
  // Keluhan yang dijawab harga otomatis masuk kategori "Penawaran"
  const category = priceComplaint ? "Penawaran" : categorize(content.text);
  dbg(`kategori terdeteksi: ${category}`);
  const lastMessage = (content.text || content.label || "").slice(0, 1000);

  // FITUR BARU: Unduh media jika pelanggan mengirim gambar
  const mediaFile = isImageMessage(msg.message)
    ? await deps.saveMedia(msg)
    : null;

  let row;
  try {
    const r = await deps.query(UPSERT_TICKET_SQL, [
      phone,
      jid,
      msg.pushName ? String(msg.pushName).slice(0, 100) : null,
      lastMessage,
      category,
      content.hasAttachment,
    ]);
    row = r.rows[0];

    // FITUR BARU: Catat pesan ke tabel messages beserta nama file gambar (jika ada)
    await deps.query(
      `INSERT INTO messages (customer_id, ticket_id, body, media_file)
       VALUES ($1, $2, $3, $4)`,
      [
        row.customer_id,
        row.id,
        (content.text || content.label || "").slice(0, 4000) || null,
        mediaFile,
      ],
    );
  } catch (err) {
    // FITUR BARU: Hapus gambar yatim di hardisk jika gagal masuk database
    if (mediaFile) await media.removeInboxFile(mediaFile);
    throw err;
  }

  console.log(
    `📥 Tiket #${row?.id} (${row?.category}${content.hasAttachment ? ", lampiran" : ""}) dari ${phone}`,
  );
  return { action: "ticket", ticketId: row?.id, category, detected: category };
}

// Dipasang ke sock.ev.on("messages.upsert", ...)
async function handleUpsert(sock, upsert, deps = {}) {
  dbg(
    `handleUpsert dipanggil: type=${upsert?.type} jumlah=${upsert?.messages?.length ?? 0}`,
  );
  if (upsert?.type !== "notify") return;

  const d = {
    query: deps.query || db.query,
    send:
      deps.send ||
      (async (jid, text) => {
        await sock.sendMessage(jid, { text });
        return "teks";
      }),
    sleep: deps.sleep || sleep,
    tz: deps.tz || process.env.APP_TIMEZONE || "Asia/Jakarta",
    // FITUR BARU: Berikan akses fungsi downloadImage ke processMessage via depedency injection
    saveMedia: deps.saveMedia || ((m) => downloadImage(sock, m)),
  };

  for (const msg of upsert.messages || []) {
    try {
      await processMessage(sock, msg, d);
    } catch (err) {
      console.error("❌ Gagal memproses pesan masuk:", err.message);
    }
  }
}

module.exports = {
  CATEGORIES,
  RULES,
  normalize,
  categorize,
  matchAutoReply,
  renderTemplate,
  extractContent,
  resolveJid,
  handleUpsert,
};
