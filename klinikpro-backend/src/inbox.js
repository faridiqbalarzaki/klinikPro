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
const fs = require("fs");

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

// SATU-SATUNYA pintu pembuat key JID. Hasilnya dipakai untuk state SOP,
// cooldown, antrean, dedup, dan tabel customers. Jangan pakai remoteJid mentah.
// - buang suffix device (":12@")
// - "@lid" + remoteJidAlt -> catat mapping, pakai nomor asli
// - "@lid" tanpa alt -> pakai mapping yang pernah tersimpan, jika tidak ada tetap LID
function resolveJid(key, onNewLid) {
  const raw = priceFlow.stripDevice(key?.remoteJid);
  if (!raw) return null;

  if (raw.endsWith("@lid")) {
    const alt = priceFlow.stripDevice(key.remoteJidAlt);
    if (alt.endsWith("@s.whatsapp.net") && priceFlow.registerLid(raw, alt)) {
      try {
        onNewLid?.(raw, alt);
      } catch (_) {}
    }
    return priceFlow.canonicalJid(raw);
  }
  return raw.endsWith("@s.whatsapp.net") ? raw : null;
}

// Untuk "@lid" angka di depan "@" BUKAN nomor telepon, jadi diberi prefix "lid:"
// agar tidak tercampur dengan nomor asli di tabel customers.
const phoneFromJid = (jid) => {
  const digits = String(jid).split("@")[0].replace(/\D/g, "");
  if (!digits) return "";
  return String(jid).endsWith("@lid") ? `lid:${digits}` : digits;
};

// ------------------------------------------------------------------
// Mapping LID <-> nomor asli (persisten di DB, tabel lid_map)
// ------------------------------------------------------------------
const LID_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS lid_map (
    lid        text PRIMARY KEY,
    pn         text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW()
  )`;

let lidReady = false;
async function initLidMap(query) {
  if (lidReady) return;
  lidReady = true; // coba sekali per proses; gagal -> hanya di-log
  try {
    await query(LID_TABLE_SQL);
    const r = await query("SELECT lid, pn FROM lid_map");
    for (const row of r?.rows || []) priceFlow.registerLid(row.lid, row.pn);
    dbg(`lid_map dimuat: ${(r?.rows || []).length} pasangan`);
  } catch (err) {
    console.error("⚠️  Gagal memuat lid_map:", err.message);
  }
}

async function saveLidMapping(query, lid, pn) {
  try {
    await query(
      `INSERT INTO lid_map (lid, pn) VALUES ($1::text, $2::text)
       ON CONFLICT (lid) DO UPDATE SET pn = EXCLUDED.pn, updated_at = NOW()`,
      [lid, pn],
    );
    // Customer lama yang tersimpan sebagai "lid:..." -> pindahkan ke nomor asli
    // (hanya jika nomor asli belum punya baris sendiri; kalau sudah, biarkan).
    await query(
      `UPDATE customers SET phone = $2::text, jid = $3::text
       WHERE phone = $1::text
         AND NOT EXISTS (SELECT 1 FROM customers c2 WHERE c2.phone = $2::text)`,
      [phoneFromJid(lid), phoneFromJid(pn), pn],
    );
  } catch (err) {
    console.error("⚠️  Gagal menyimpan mapping LID:", err.message);
  }
}

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

// Antrean per customer: pesan dari JID yang sama diproses satu per satu, juga
// lintas event messages.upsert. Mencegah dua pesan beruntun sama-sama melihat
// state lama saat SOP (delay + gambar, ~20 detik) masih berjalan.
const jidQueues = new Map();
function enqueue(jid, fn) {
  const prev = jidQueues.get(jid) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  jidQueues.set(jid, next);
  next
    .catch(() => {})
    .finally(() => {
      if (jidQueues.get(jid) === next) jidQueues.delete(jid);
    });
  return next;
}

// Jeda + indikator "mengetik..." sebelum bot membalas (pola sama dengan auto-reply)
async function humanDelay(sock, jid, deps) {
  const total =
    AUTO_REPLY_DELAY_MIN_MS +
    Math.floor(
      Math.random() * (AUTO_REPLY_DELAY_MAX_MS - AUTO_REPLY_DELAY_MIN_MS + 1),
    );

  // 1. Set status online
  try {
    await sock.sendPresenceUpdate("available", jid);
  } catch (_) {}

  // 2. Jeda sebentar sebelum ngetik
  await deps.sleep(Math.max(0, total - TYPING_MS));

  // 3. Mulai status ngetik (typing)
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (_) {}

  // 4. Tahan status ngetik selama waktu TYPING_MS
  await deps.sleep(Math.min(TYPING_MS, total));
}

const CAPTION_LIMIT = 1024; // batas caption gambar di WhatsApp

function readAsset(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
}

// Kirim SATU image message; caption (jika ada) menempel pada gambar itu.
// Tidak ada fallback ke teks: asset sudah divalidasi sebelum pengiriman dimulai.
function sendImageMessage(sock, jid, buffer, caption) {
  const content = { image: buffer, mimetype: "image/jpeg" };
  if (caption) content.caption = caption;
  return sock.sendMessage(jid, content);
}

// SOP consultative selling (7 pesan): teks -> awal.jpeg + keluhan pelanggan ->
// testi1..4 (tanpa caption) -> akhir.jpeg + deskripsi FIX NUTRI GLOW SERIES.
// `complaint` = teks keluhan asli pelanggan; kosong (foto/pesan suara) -> awal.jpeg tanpa caption.
// SOP consultative selling (3 pesan):
// 1. Teks Sapaan -> 2. awal.jpeg (caption keluhan + produk) -> 3. akhir.jpeg (caption BPOM/Halal)
async function sendConsultativeSteps(
  sock,
  jid,
  sleepFn = sleep,
  complaint = "",
) {
  // 1. Validasi path gambar
  const paths = [
    priceFlow.IMAGE_PRODUCT_PATH,
    ...priceFlow.IMAGE_TESTI_PATHS,
    priceFlow.IMAGE_TESTI_PATH,
  ];

  const buffers = paths.map(readAsset);
  const missing = paths.filter((_, i) => !buffers[i]);
  if (missing.length) {
    throw new Error(
      `Alur solusi dibatalkan, asset tidak ditemukan: ${missing.join(", ")}`,
    );
  }

  const awalBuf = buffers[0];
  const testiBufs = buffers.slice(1, 5); // testi1 s.d testi4
  const akhirBuf = buffers[5];

  // 2. Siapkan caption
  let userComplaint = String(complaint || "").trim();
  let awalCaption = userComplaint
    ? `Keluhan Kakak:\n"${userComplaint}"\n\n${priceFlow.STEP2_PRODUCT_CAPTION}`
    : priceFlow.STEP2_PRODUCT_CAPTION;

  if (awalCaption.length > CAPTION_LIMIT) {
    awalCaption = awalCaption.slice(0, CAPTION_LIMIT);
  }

  let akhirCaption = priceFlow.STEP3_TESTI_CAPTION;
  if (akhirCaption.length > CAPTION_LIMIT) {
    akhirCaption = akhirCaption.slice(0, CAPTION_LIMIT);
  }

  await sock.sendMessage(jid, { text: priceFlow.STEP1_SOLUSI_TEXT });

  // Jeda 4 detik + indikator typing aktif
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (_) {}
  await sleepFn(4000);

  // Langkah 2: Gambar Awal + Caption Produk
  await sendImageMessage(sock, jid, awalBuf, awalCaption);

  // Jeda 2,5 detik + typing
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (_) {}
  await sleepFn(2500);

  // Langkah Sisipan: 4 Gambar Testi
  const sendTestiPromises = testiBufs.map((buf) =>
    sendImageMessage(sock, jid, buf),
  );
  await Promise.all(sendTestiPromises);

  // Jeda 2 detik + typing
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (_) {}
  await sleepFn(2000);

  // Langkah 3: Gambar Akhir + Caption Closing
  await sendImageMessage(sock, jid, akhirBuf, akhirCaption);
}

// Jeda "mengetik..." lalu kirim 7 pesan alur solusi. Jika gagal, hanya dicatat di log
// supaya keluhan pelanggan tetap masuk tiket untuk CS.
async function replyConsultative(sock, jid, phone, deps, complaint = "") {
  await humanDelay(sock, jid, deps);
  try {
    await deps.sendSteps(jid, complaint);
    console.log(`💬 Rangkaian konsultatif (7 pesan) dikirim ke ${phone}`);
  } catch (err) {
    console.error("❌ Gagal mengirim rangkaian konsultatif:", err.message);
  }
}

async function processMessage(sock, msg, deps) {
  const { key } = msg;

  dbg(
    `pesan masuk -> remoteJid=${key?.remoteJid} alt=${key?.remoteJidAlt ?? "-"} ` +
      `fromMe=${key?.fromMe} id=${key?.id} pushName="${msg.pushName ?? ""}" ` +
      `isi=[${Object.keys(msg.message || {}).join(",") || "kosong"}]`,
  );

  if (!key) return null;
  // Pesan keluar (balasan CS dari HP bot / template bot) tidak boleh menyentuh
  // state SOP maupun timer konsultasi.
  if (key.fromMe) return null;

  const jid = resolveJid(key, (lid, pn) => saveLidMapping(deps.query, lid, pn));
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
  const priceState = priceFlow.getState(jid);
  const hasPriceWord =
    Boolean(content.text) && priceFlow.isPriceQuestion(content.text);
  let priceComplaint = false;

  if (priceFlow.hasConsultedWithin24h(jid)) {
    // Sudah konsultasi <24 jam: SOP (tanya keluhan & kirim solusi) tidak boleh
    // jalan lagi, apa pun isi pesannya (lokasi, harga, dll). Lanjut ke
    // auto-reply/tiket supaya CS yang menangani.
    dbg(`Nomor ${phone} sudah konsultasi <24 jam, SOP dilewati.`);
  } else if (
    priceState === STATES.WAITING_FOR_COMPLAINT &&
    (content.text || content.label)
  ) {
    const looksLikeComplaint =
      content.hasAttachment || // foto wajah
      !content.text || // pesan suara
      priceFlow.isComplaint(content.text);

    if (hasPriceWord && !looksLikeComplaint) {
      // Masih tanya harga/produk, bukan keluhan -> ulangi pertanyaan SOP
      priceFlow.setState(jid, STATES.WAITING_FOR_COMPLAINT);
      await humanDelay(sock, jid, deps);
      await deps.send(jid, priceFlow.ASK_COMPLAINT_TEXT);
      return { action: "price_gate_repeat" };
    }

    // Keluhan diterima -> state & cooldown diset SEBELUM kirim (await)
    priceFlow.setConsultedNow(jid);
    priceFlow.setState(jid, STATES.IDLE);
    await replyConsultative(sock, jid, phone, deps, content.text);
    priceComplaint = true;
  } else if (priceState === STATES.IDLE && hasPriceWord) {
    // Pertanyaan harga pertama -> tahan, minta keluhan
    priceFlow.setState(jid, STATES.WAITING_FOR_COMPLAINT);
    try {
      await humanDelay(sock, jid, deps);
      await deps.send(jid, priceFlow.ASK_COMPLAINT_TEXT);
    } catch (err) {
      priceFlow.setState(jid, STATES.IDLE);
      throw err;
    }
    console.log(`💬 Pertanyaan harga dari ${phone} ditahan, menunggu keluhan`);
    return { action: "price_gate" };
  } else if (
    priceState === STATES.IDLE &&
    content.text &&
    priceFlow.isComplaint(content.text)
  ) {
    // Keluhan langsung tanpa ditanya -> kirim SOP
    priceFlow.setConsultedNow(jid);
    priceFlow.setState(jid, STATES.IDLE);
    await replyConsultative(sock, jid, phone, deps, content.text);
    priceComplaint = true;
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
  d.sendSteps =
    deps.sendSteps ||
    ((jid, complaint) => sendConsultativeSteps(sock, jid, d.sleep, complaint));

  await initLidMap(d.query);

  for (const msg of upsert.messages || []) {
    try {
      const jid =
        resolveJid(msg.key, (lid, pn) => saveLidMapping(d.query, lid, pn)) ||
        "unknown";
      await enqueue(jid, () => processMessage(sock, msg, d));
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
  phoneFromJid,
  handleUpsert,
  sendConsultativeSteps,
};
