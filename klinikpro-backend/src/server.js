const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron"); // FITUR BARU: Cron Job

// Baca .env dari klinikpro-backend/ (satu tingkat di atas src/), cadangan: folder kerja
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
require("dotenv").config();
const db = require("./db");
const media = require("./media");
const worker = require("./worker");
const inbox = require("./inbox");
// Fitur Label WA bersifat tambahan: jika modulnya bermasalah, server lain tetap jalan.
let waLabels = null;
try {
  waLabels = require("./walabels");
} catch (err) {
  console.error(`⚠️  Fitur Label WA dinonaktifkan: ${err.message}`);
}
const needLabels = () => {
  if (!waLabels) {
    throw media.httpError(
      501,
      "Fitur Label WA tidak aktif. Pastikan file src/walabels.js ada, lalu jalankan ulang server.",
    );
  }
  return waLabels;
};

const app = express(); // HARUS dibuat sebelum app.use(...) apa pun
const MAX_RECIPIENTS = 100; // FITUR BARU: Batas ketat 100 per batch
const TZ = process.env.APP_TIMEZONE || "Asia/Jakarta";
const SLA_MINUTES = Number(process.env.SLA_MINUTES) || 15; // batas balas tiket
const RO_INTERVAL_DAYS = Number(process.env.RO_INTERVAL_DAYS) || 30; // jarak FU untuk filter "ro"

// CORS: isi CORS_ORIGIN (pisahkan koma) untuk membatasi asal frontend.
// Jika frontend disajikan oleh server ini (satu alamat), CORS tidak diperlukan sama sekali.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  }),
);

// Cek hidup (tanpa API key) untuk monitoring / pm2 / uptime checker
app.get("/healthz", (req, res) => res.json({ ok: true }));

// Kunci API opsional. Jika API_KEY diisi di .env, semua endpoint /api wajib
// mengirim header x-api-key yang sama (frontend: VITE_API_KEY di file .env frontend).
const API_KEY = process.env.API_KEY || "";
app.use("/api", (req, res, next) => {
  if (!API_KEY || req.method === "OPTIONS") return next();
  const given = Buffer.from(String(req.get("x-api-key") || ""));
  const expected = Buffer.from(API_KEY);
  if (
    given.length === expected.length &&
    crypto.timingSafeEqual(given, expected)
  ) {
    return next();
  }
  res.status(401).json({ error: "API key tidak valid." });
});

// Body JSON dibaca SETELAH autentikasi. Template & batch boleh membawa sampai
// 5 gambar (base64, maks 5 MB asli per gambar), endpoint lain cukup 1 MB.
app.use(["/api/templates", "/api/batches"], express.json({ limit: "40mb" }));
app.use(express.json({ limit: "1mb" }));

// Gambar bisa dibuka di http://localhost:5000/uploads/<nama-file>
app.use(
  "/uploads",
  express.static(media.UPLOAD_DIR, { dotfiles: "deny", index: false }),
);

// ==========================================
// UTILITAS
// ==========================================
// Meneruskan error async ke error handler di bawah
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const normalizePhone = (raw) => {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  let n = digits;
  if (n.startsWith("08")) n = "62" + n.slice(1);
  else if (n.startsWith("8")) n = "62" + n;
  return /^628\d{7,12}$/.test(n) ? n : null;
};

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ==========================================
// 1. TEMPLATES
// ==========================================
// Setiap template punya "images": daftar nama file (maks 5) yang bisa dibuka di /uploads/<nama>
const TEMPLATE_SELECT = `
  SELECT t.id, t.name, t.content, t.type, t.keywords, t.time_slot,
         COALESCE(
           (SELECT json_agg(ti.file_name ORDER BY ti.position, ti.id)
            FROM template_images ti WHERE ti.template_id = t.id),
           '[]'
         ) AS images
  FROM templates t`;

app.get(
  "/api/templates",
  route(async (req, res) => {
    const result = await db.query(`${TEMPLATE_SELECT} ORDER BY t.id DESC`);
    res.json(result.rows);
  }),
);

app.post(
  "/api/templates",
  route(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const content = String(req.body?.content ?? "").trim();
    if (!name || !content) {
      return res
        .status(400)
        .json({ error: "Nama dan isi template wajib diisi." });
    }

    // Jenis template: 'manual_fu' (default, juga dipakai broadcast) atau 'auto_reply'
    // Jenis template: 'manual_fu' (default, juga dipakai broadcast) atau 'auto_reply'
    const type = req.body?.type === "auto_reply" ? "auto_reply" : "manual_fu";
    const SLOTS = ["followup", "rencana", "pengiriman"];
    const timeSlot =
      type === "manual_fu" && SLOTS.includes(req.body?.time_slot)
        ? req.body.time_slot
        : null;
    const rawKeywords = Array.isArray(req.body?.keywords)
      ? req.body.keywords
      : String(req.body?.keywords ?? "").split(",");
    const keywords = [
      ...new Set(
        rawKeywords
          .map((k) => String(k).trim().toLowerCase().slice(0, 60))
          .filter(Boolean),
      ),
    ].slice(0, 30);
    if (type === "auto_reply" && keywords.length === 0) {
      return res
        .status(400)
        .json({ error: "Template auto-reply wajib punya minimal 1 keyword." });
    }

    const list = media.toImageList(req.body?.images, req.body?.image);
    // FITUR BARU: Hapus validasi penolakan gambar pada auto-reply agar bisa menangani gambar

    if (!list.every(media.isDataUrl)) {
      return res.status(400).json({ error: "Format gambar tidak valid." });
    }

    // Simpan gambar (jika ada) setelah validasi teks lolos
    const files = media.saveDataUrls(list);
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      const tpl = await client.query(
        `INSERT INTO templates (name, content, type, keywords, time_slot)
         VALUES ($1, $2, $3, $4::text[], $5)
         RETURNING id, name, content, type, keywords, time_slot`,
        [name.slice(0, 255), content, type, keywords, timeSlot],
      );
      if (files.length > 0) {
        await client.query(
          `INSERT INTO template_images (template_id, file_name, position)
           SELECT $1::int, f.file_name, f.position - 1
           FROM unnest($2::text[]) WITH ORDINALITY AS f(file_name, position)`,
          [tpl.rows[0].id, files],
        );
      }
      await client.query("COMMIT");
      res.status(201).json({ ...tpl.rows[0], images: files });
    } catch (err) {
      await client.query("ROLLBACK");
      media.removeImages(files); // jangan tinggalkan file yatim jika DB gagal
      throw err;
    } finally {
      client.release();
    }
  }),
);

app.delete(
  "/api/templates/:id",
  route(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID template tidak valid." });

    const imgs = await db.query(
      "SELECT file_name FROM template_images WHERE template_id = $1",
      [id],
    );
    await db.query("DELETE FROM templates WHERE id = $1", [id]);
    // Batch yang sudah dibuat memakai salinan sendiri, jadi aman menghapus file template
    media.removeImages(imgs.rows.map((r) => r.file_name));
    res.json({ message: "Template berhasil dihapus" });
  }),
);

app.put(
  "/api/templates/:id/group",
  route(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID template tidak valid." });

    const group = String(req.body?.group ?? "");
    if (group && !["followup", "rencana", "pengiriman"].includes(group)) {
      return res.status(400).json({ error: "Jenis template tidak valid." });
    }

    const result = await db.query(
      `UPDATE templates SET time_slot = $2 
       WHERE id = $1 AND type = 'manual_fu' RETURNING id, time_slot`,
      [id, group || null],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Template tidak ditemukan." });
    }
    res.json(result.rows[0]);
  }),
);

// ==========================================
// 2. KATEGORI & CUSTOMER
// ==========================================

// ==========================================
// 2. KATEGORI & CUSTOMER
// ==========================================
app.get(
  "/api/categories",
  route(async (req, res) => {
    const result = await db.query(`
      SELECT c.id, c.name,
             COALESCE(
               json_agg(
                 json_build_object('phone', cu.phone, 'name', cu.name, 'treatment', cu.treatment)
                 ORDER BY cu.name
               ) FILTER (WHERE cu.phone IS NOT NULL),
               '[]'
             ) AS contacts
      FROM categories c
      LEFT JOIN category_customers cc ON cc.category_id = c.id
      LEFT JOIN customers cu ON cu.phone = cc.customer_phone
      GROUP BY c.id
      ORDER BY c.id DESC
    `);
    res.json(result.rows);
  }),
);

app.post(
  "/api/categories",
  route(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name)
      return res.status(400).json({ error: "Nama kategori wajib diisi." });
    const result = await db.query(
      "INSERT INTO categories (name) VALUES ($1) RETURNING *",
      [name.slice(0, 255)],
    );
    res.status(201).json(result.rows[0]);
  }),
);

app.delete(
  "/api/categories/:id",
  route(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID kategori tidak valid." });
    await db.query("DELETE FROM categories WHERE id = $1", [id]);
    res.json({ message: "Kategori berhasil dihapus" });
  }),
);

app.post(
  "/api/categories/:categoryId/contacts",
  route(async (req, res) => {
    const categoryId = toId(req.params.categoryId);
    if (!categoryId)
      return res.status(400).json({ error: "ID kategori tidak valid." });

    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
      return res
        .status(400)
        .json({ error: "Format nomor WhatsApp tidak valid." });
    }
    const name =
      String(req.body?.name ?? "")
        .trim()
        .slice(0, 100) || "Kak";
    const treatment =
      String(req.body?.treatment ?? "")
        .trim()
        .slice(0, 100) || "Treatment";

    const cat = await db.query("SELECT 1 FROM categories WHERE id = $1", [
      categoryId,
    ]);
    if (cat.rowCount === 0) {
      return res.status(404).json({ error: "Kategori tidak ditemukan." });
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO customers (phone, name, treatment)
         VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, treatment = EXCLUDED.treatment`,
        [phone, name, treatment],
      );
      await client.query(
        `INSERT INTO category_customers (category_id, customer_phone)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [categoryId, phone],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ phone, name, treatment });
  }),
);

app.delete(
  "/api/categories/:categoryId/contacts/:phone",
  route(async (req, res) => {
    const categoryId = toId(req.params.categoryId);
    if (!categoryId)
      return res.status(400).json({ error: "ID kategori tidak valid." });
    const phone = normalizePhone(req.params.phone);
    if (!phone)
      return res.status(400).json({ error: "Format nomor tidak valid." });
    await db.query(
      "DELETE FROM category_customers WHERE category_id = $1 AND customer_phone = $2",
      [categoryId, phone],
    );
    res.json({ message: "Customer berhasil dihapus dari kategori" });
  }),
);

// ==========================================
// 3. BATCH / ANTREAN
// ==========================================
app.get(
  "/api/batches",
  route(async (req, res) => {
    const result = await db.query(`
      SELECT b.id, b.name, b.status, b.scheduled_at AS date, b.created_at,
             (SELECT COUNT(*)::int FROM batch_images bm WHERE bm.batch_id = b.id) AS image_count,
             COUNT(bi.id)::int AS total,
             (COUNT(*) FILTER (WHERE bi.status = 'sent'))::int AS sent,
             (COUNT(*) FILTER (WHERE bi.status = 'failed'))::int AS failed
      FROM batches b
      LEFT JOIN batch_items bi ON bi.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.id DESC
      LIMIT 100
    `);
    res.json(result.rows);
  }),
);

app.post(
  "/api/batches",
  route(async (req, res) => {
    const { name, message_text, scheduled_at, recipients, images, image } =
      req.body ?? {};

    // --- 1. Validasi SEMUA input dulu, sebelum menyentuh disk ---
    if (!String(name ?? "").trim() || !String(message_text ?? "").trim()) {
      return res
        .status(400)
        .json({ error: "Nama batch dan pesan wajib diisi." });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "Daftar penerima kosong!" });
    }

    const scheduledDate = scheduled_at ? new Date(scheduled_at) : new Date();
    if (Number.isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: "Format jadwal tidak valid." });
    }

    // Normalisasi: terima nomor/phone & nama/name, buang duplikat
    const unique = new Map();
    const invalid = [];
    for (const r of recipients) {
      const phone = normalizePhone(r?.nomor ?? r?.phone);
      if (!phone) {
        invalid.push(r?.nomor ?? r?.phone ?? "(kosong)");
        continue;
      }
      unique.set(phone, {
        phone,
        name:
          String(r.nama ?? r.name ?? "Kak")
            .trim()
            .slice(0, 100) || "Kak",
        treatment:
          String(r.treatment ?? "Treatment")
            .trim()
            .slice(0, 100) || "Treatment",
      });
    }
    if (invalid.length > 0) {
      return res
        .status(400)
        .json({ error: `Nomor tidak valid: ${invalid.join(", ")}` });
    }
    const items = [...unique.values()];
    if (items.length > MAX_RECIPIENTS) {
      return res
        .status(400)
        .json({ error: `Maksimal ${MAX_RECIPIENTS} penerima per batch.` });
    }

    // --- 2. Siapkan gambar batch (maks 5) ---
    // Tiap gambar bisa berupa nama file milik template (disalin agar batch tetap utuh
    // walau template dihapus) atau data URL base64 baru.
    const imageList = media.toImageList(images, image);
    let batchImages = [];
    try {
      for (const item of imageList) {
        if (media.isDataUrl(item)) {
          batchImages.push(media.saveDataUrl(item));
        } else {
          const copy = media.copyImage(item);
          if (!copy) {
            media.removeImages(batchImages);
            return res.status(400).json({
              error:
                "Gambar template tidak ditemukan di server. Unggah ulang gambar pada template.",
            });
          }
          batchImages.push(copy);
        }
      }
    } catch (err) {
      media.removeImages(batchImages);
      throw err;
    }

    const status = scheduledDate > new Date() ? "Terjadwal" : "Berjalan";

    // --- 3. Satu transaksi: semua tersimpan atau tidak sama sekali ---
    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const batchRes = await client.query(
        `INSERT INTO batches (name, message_text, scheduled_at, status, sent_count)
         VALUES ($1, $2, $3, $4, 0) RETURNING id`,
        [
          String(name).trim().slice(0, 255),
          message_text,
          scheduledDate,
          status,
        ],
      );
      const batchId = batchRes.rows[0].id;

      if (batchImages.length > 0) {
        await client.query(
          `INSERT INTO batch_images (batch_id, file_name, position)
           SELECT $1::int, f.file_name, f.position - 1
           FROM unnest($2::text[]) WITH ORDINALITY AS f(file_name, position)`,
          [batchId, batchImages],
        );
      }

      await client.query(
        `INSERT INTO batch_items (batch_id, phone, customer_name, treatment, status)
         SELECT $1::int, t.phone, t.name, t.treatment, 'pending'
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(phone, name, treatment)`,
        [
          batchId,
          items.map((i) => i.phone),
          items.map((i) => i.name),
          items.map((i) => i.treatment),
        ],
      );

      await client.query("COMMIT");
      console.log(
        `✅ Batch #${batchId} (${status}) dengan ${items.length} penerima${batchImages.length ? ` + ${batchImages.length} gambar` : ""}.`,
      );
      res.status(201).json({
        message: "Batch berhasil dibuat!",
        batchId,
        total: items.length,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      media.removeImages(batchImages); // batalkan file yang sudah ditulis
      console.error("❌ ERROR SAAT SIMPAN BATCH:", err);
      res
        .status(500)
        .json({ error: "Gagal menyimpan batch.", detail: err.message });
    } finally {
      client.release();
    }
  }),
);

app.patch(
  "/api/batches/:id/cancel",
  route(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID batch tidak valid." });

    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      const upd = await client.query(
        `UPDATE batches SET status = 'Dibatalkan'
         WHERE id = $1 AND status IN ('Terjadwal', 'Berjalan')
         RETURNING id`,
        [id],
      );
      if (upd.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Batch tidak ditemukan atau sudah selesai/dibatalkan.",
        });
      }
      const items = await client.query(
        `UPDATE batch_items SET status = 'cancelled'
         WHERE batch_id = $1 AND status = 'pending'`,
        [id],
      );
      await client.query("COMMIT");
      res.json({ message: "Batch dibatalkan", cancelledItems: items.rowCount });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ==========================================
// 5. INBOX (TIKET) & FOLLOW-UP
// ==========================================
// FITUR BARU: Tambahan select c.private_note dan subquery media_files
const TICKET_SELECT = `
  SELECT t.id, t.customer_id, t.last_message, t.status, t.category,
         t.has_attachment, t.created_at, t.updated_at,
         c.name AS customer_name, c.phone,
         COALESCE(c.jid, c.phone || '@s.whatsapp.net') AS jid,
         c.private_note,
         COALESCE((SELECT json_agg(m.media_file ORDER BY m.id)
                   FROM messages m
                   WHERE m.ticket_id = t.id AND m.media_file IS NOT NULL), '[]') AS media_files,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - t.updated_at)))::int AS elapsed_seconds
  FROM tickets t
  JOIN customers c ON c.id = t.customer_id`;

// 1. Tiket aktif + sisa waktu SLA (negatif = sudah terlambat)
app.get(
  "/api/tickets/active",
  route(async (req, res) => {
    const result = await db.query(
      `${TICKET_SELECT} WHERE t.status = 'pending' ORDER BY t.updated_at ASC LIMIT 500`,
    );
    const slaSeconds = SLA_MINUTES * 60;
    const tickets = result.rows.map((t) => ({
      ...t,
      sla_minutes: SLA_MINUTES,
      sla_remaining_seconds: slaSeconds - t.elapsed_seconds,
      sla_breached: t.elapsed_seconds > slaSeconds,
    }));
    res.json({
      sla_minutes: SLA_MINUTES,
      server_time: new Date().toISOString(),
      tickets,
    });
  }),
);

// 2. Antrean follow-up proaktif.
// Kelompok dihitung dari tanggal customer masuk (created_at, zona waktu aplikasi):
//   hari_ini = masuk hari ini | kemarin = 1 hari lalu | lusa = 2 hari lalu
//   ro       = pelanggan lama (>= 3 hari) yang belum di-FU dalam RO_INTERVAL_DAYS hari
// Yang sudah di-FU HARI INI tidak pernah muncul (mencegah double-FU).
const FOLLOWUP_FILTERS = {
  hari_ini:
    "c.created_at IS NOT NULL AND (c.created_at AT TIME ZONE $1::text)::date = d.today",
  kemarin:
    "c.created_at IS NOT NULL AND (c.created_at AT TIME ZONE $1::text)::date = d.today - 1",
  lusa: "c.created_at IS NOT NULL AND (c.created_at AT TIME ZONE $1::text)::date = d.today - 2",
  ro: `(c.created_at IS NULL OR (c.created_at AT TIME ZONE $1::text)::date <= d.today - 3)
       AND (c.last_fu_date IS NULL OR c.last_fu_date <= d.today - $2::int)`,
};

app.get(
  "/api/followup/queue",
  route(async (req, res) => {
    const filter = String(req.query.filter || "hari_ini");
    const where = FOLLOWUP_FILTERS[filter];
    if (!where) {
      return res.status(400).json({
        error: `Filter tidak valid. Gunakan: ${Object.keys(FOLLOWUP_FILTERS).join(", ")}.`,
      });
    }
    const params = filter === "ro" ? [TZ, RO_INTERVAL_DAYS] : [TZ];
    const result = await db.query(
      `WITH d AS (SELECT (NOW() AT TIME ZONE $1::text)::date AS today)
       SELECT c.id, c.name, c.phone, c.treatment,
              COALESCE(c.jid, c.phone || '@s.whatsapp.net') AS jid,
              c.created_at, c.last_fu_date
       FROM customers c, d
       WHERE (c.last_fu_date IS NULL OR c.last_fu_date <> d.today)
         AND ${where}
       ORDER BY c.created_at DESC NULLS LAST, c.id DESC
       LIMIT 200`,
      params,
    );
    res.json({ filter, total: result.rows.length, customers: result.rows });
  }),
);

// 3. Kirim template via WhatsApp, lalu otomatis: tiket -> resolved + last_fu_date = hari ini
//    Body: { template_id, ticket_id? | customer_id?, force? }
app.post(
  "/api/messages/send-template",
  route(async (req, res) => {
    const templateId = toId(req.body?.template_id);
    const ticketId = toId(req.body?.ticket_id);
    let customerId = toId(req.body?.customer_id);
    if (!templateId) {
      return res.status(400).json({ error: "template_id wajib diisi." });
    }
    if (!ticketId && !customerId) {
      return res.status(400).json({ error: "Isi ticket_id atau customer_id." });
    }

    if (ticketId) {
      const t = await db.query(
        "SELECT customer_id FROM tickets WHERE id = $1",
        [ticketId],
      );
      if (t.rowCount === 0) {
        return res.status(404).json({ error: "Tiket tidak ditemukan." });
      }
      customerId = t.rows[0].customer_id;
    }

    const cust = await db.query(
      `SELECT c.id, c.name, c.phone, c.treatment,
              COALESCE(c.jid, c.phone || '@s.whatsapp.net') AS jid,
              (c.last_fu_date = (NOW() AT TIME ZONE $2::text)::date) AS fu_today
       FROM customers c WHERE c.id = $1`,
      [customerId, TZ],
    );
    if (cust.rowCount === 0) {
      return res.status(404).json({ error: "Customer tidak ditemukan." });
    }
    const customer = cust.rows[0];

    // Cegah double-FU untuk follow-up proaktif (balasan tiket selalu boleh)
    if (!ticketId && customer.fu_today && !req.body?.force) {
      return res.status(409).json({
        error: "Customer ini sudah di-follow-up hari ini.",
        code: "ALREADY_FU_TODAY",
      });
    }

    const tpl = await db.query(
      `SELECT t.id, t.content,
              COALESCE((SELECT json_agg(ti.file_name ORDER BY ti.position, ti.id)
                        FROM template_images ti WHERE ti.template_id = t.id), '[]') AS images
       FROM templates t WHERE t.id = $1`,
      [templateId],
    );
    if (tpl.rowCount === 0) {
      return res.status(404).json({ error: "Template tidak ditemukan." });
    }

    const text = inbox.renderTemplate(tpl.rows[0].content, {
      nama: customer.name,
      treatment: customer.treatment,
      tanggal: new Date().toLocaleDateString("id-ID", {
        dateStyle: "medium",
        timeZone: TZ,
      }),
    });

    // 1) Kirim dulu. Jika gagal, status tiket & tanggal FU TIDAK berubah.
    await worker.sendDirect(customer.jid, text, tpl.rows[0].images);

    // 2) Pesan sudah terkirim: perbarui database dalam satu transaksi
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      const resolved = await client.query(
        `UPDATE tickets SET status = 'resolved', updated_at = NOW()
         WHERE customer_id = $1 AND status = 'pending'`,
        [customer.id],
      );
      const fu = await client.query(
        `UPDATE customers SET last_fu_date = (NOW() AT TIME ZONE $2::text)::date
         WHERE id = $1 RETURNING last_fu_date`,
        [customer.id, TZ],
      );
      await client.query("COMMIT");
      res.json({
        ok: true,
        resolved_tickets: resolved.rowCount,
        last_fu_date: fu.rows[0]?.last_fu_date,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(
        "❌ Pesan terkirim tetapi gagal memperbarui database:",
        err,
      );
      // Jangan balas 500: klien bisa mengira pesan gagal lalu mengirim ulang
      res.json({
        ok: true,
        warning:
          "Pesan terkirim, tetapi status tiket/tanggal FU gagal diperbarui. Muat ulang halaman.",
      });
    } finally {
      client.release();
    }
  }),
);

// FITUR BARU: API endpoint untuk menyimpan catatan CS
app.put(
  "/api/customers/:id/note",
  route(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID customer tidak valid." });
    const note = String(req.body?.note ?? "")
      .trim()
      .slice(0, 2000);
    const result = await db.query(
      "UPDATE customers SET private_note = NULLIF($2, '') WHERE id = $1 RETURNING id, private_note",
      [id, note],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Customer tidak ditemukan." });
    }
    res.json(result.rows[0]);
  }),
);

// 4. Manual override kategori (koreksi jika deteksi bot salah).
// updated_at sengaja TIDAK diubah agar timer SLA tidak ter-reset.
app.put(
  "/api/tickets/:id/category",
  route(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID tiket tidak valid." });
    const category = String(req.body?.category ?? "");
    if (!inbox.CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Kategori tidak valid. Gunakan: ${inbox.CATEGORIES.join(", ")}.`,
      });
    }
    const result = await db.query(
      "UPDATE tickets SET category = $2 WHERE id = $1 RETURNING id, category, status",
      [id, category],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tiket tidak ditemukan." });
    }
    res.json(result.rows[0]);
  }),
);

// ==========================================
// 4. STATUS WHATSAPP
// ==========================================
app.get("/api/wa/status", (req, res) => {
  res.json(worker.getStatus());
});

// QR untuk di-scan dari WhatsApp HP (Perangkat Tertaut). Hanya terisi saat status "qr".
app.get(
  "/api/wa/qr",
  route(async (req, res) => {
    const qr = worker.getQr();
    const { status } = worker.getStatus();
    if (!qr) return res.json({ qr: null, status });

    let QRCode;
    try {
      QRCode = require("qrcode");
    } catch {
      throw media.httpError(
        500,
        'Paket "qrcode" belum terpasang di server. Jalankan: npm install qrcode',
      );
    }
    const dataUrl = await QRCode.toDataURL(qr, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: "M",
    });
    res.json({ qr: dataUrl, status });
  }),
);

// Tombol "Generate QR": mulai koneksi baru jika sedang logout / terputus / QR kedaluwarsa
app.post(
  "/api/wa/connect",
  route(async (req, res) => {
    res.json(await worker.requestConnect());
  }),
);

// Tombol "Logout": putuskan perangkat dari WhatsApp dan hapus sesi di server
app.post(
  "/api/wa/logout",
  route(async (req, res) => {
    res.json(await worker.logoutWhatsApp());
  }),
);

// ==========================================
// 5. LABEL WHATSAPP BUSINESS
// ==========================================
// Daftar label + kontak di dalamnya, dikelompokkan per label (data tersimpan di PostgreSQL,
// diperbarui otomatis oleh event Baileys dan tombol Sync).
app.get(
  "/api/labels",
  route(async (req, res) => {
    res.json(await needLabels().getGroups());
  }),
);

// Tombol "Sync Label dari WA". Body opsional: { "full": true } = paksa sinkronisasi penuh.
app.post(
  "/api/labels/sync",
  route(async (req, res) => {
    const full =
      typeof req.body?.full === "boolean" ? req.body.full : undefined;
    res.json(await worker.syncLabels({ full }));
  }),
);

// ==========================================
// ERROR HANDLER
// ==========================================
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Endpoint tidak ditemukan." });
});

// Frontend hasil `npm run build` (folder dist) disajikan oleh server ini juga,
// jadi cukup menyalakan SATU proses untuk seluruh aplikasi.
const DIST_DIR =
  process.env.FRONTEND_DIST || path.join(__dirname, "..", "..", "dist");
const HAS_FRONTEND = fs.existsSync(path.join(DIST_DIR, "index.html"));
if (HAS_FRONTEND) {
  app.use(express.static(DIST_DIR));
  // Semua alamat non-API diarahkan ke index.html (aplikasi satu halaman)
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/uploads/")) return next();
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  if (res.headersSent) return;
  if (err.type === "entity.too.large") {
    return res
      .status(413)
      .json({ error: "Data terlalu besar. Ukuran gambar maksimal 5 MB." });
  }
  // err.status berasal dari media.js (mis. 400 untuk gambar tidak valid)
  res
    .status(err.status || 500)
    .json({ error: err.message || "Terjadi kesalahan pada server." });
});

// ==========================================
// AUTO-CLEANUP: pesan > 30 hari + foto fisiknya, tiap 02:00
// ==========================================
const RETENTION_DAYS = Number(process.env.MESSAGE_RETENTION_DAYS) || 30;

async function cleanupOldMessages() {
  try {
    const r = await db.query(
      `DELETE FROM messages
       WHERE created_at < NOW() - make_interval(days => $1::int)
       RETURNING media_file`,
      [RETENTION_DAYS],
    );
    let filesRemoved = 0;
    for (const row of r.rows) {
      if (row.media_file && (await media.removeInboxFile(row.media_file))) {
        filesRemoved++;
      }
    }
    console.log(
      `🧹 Cleanup: ${r.rowCount} pesan & ${filesRemoved} foto (> ${RETENTION_DAYS} hari) dihapus.`,
    );
  } catch (err) {
    console.error("❌ Cleanup gagal:", err.message);
  }
}

// ==========================================
// JALANKAN SERVER (+ WORKER WHATSAPP)
// ==========================================
const PORT = process.env.PORT || 5000;

db.initDb()
  .then(() => {
    app.listen(PORT, () => {
      // FITUR BARU: Jadwal eksekusi cron cleanup setiap jam 02.00 pagi
      cron.schedule("0 2 * * *", cleanupOldMessages, { timezone: TZ });

      console.log(`🚀 Server Backend berjalan di port ${PORT}`);
      if (HAS_FRONTEND) {
        console.log(`🌐 Aplikasi web tersedia di http://localhost:${PORT}`);
      }
      if (!API_KEY) {
        console.log(
          "ℹ️  API_KEY belum diatur: semua endpoint (termasuk QR WhatsApp) terbuka untuk siapa pun yang bisa menjangkau port ini. Aman untuk komputer lokal; atur API_KEY jika server bisa diakses dari jaringan/internet.",
        );
      }
      // Set RUN_WORKER=false jika worker dijalankan terpisah (node worker.js)
      if (process.env.RUN_WORKER !== "false") {
        worker.startWorker().catch((err) => {
          console.error("❌ Worker gagal start:", err);
        });
      }
    });
  })
  .catch((err) => {
    console.error("❌ Gagal menyiapkan database:", err);
    process.exit(1);
  });

// SIGUSR2 dikirim nodemon saat restart; SIGTERM oleh pm2/docker
["SIGINT", "SIGTERM"].forEach((sig) =>
  process.on(sig, () => {
    worker.stopWorker();
    process.exit(0);
  }),
);
process.once("SIGUSR2", () => {
  worker.stopWorker();
  process.kill(process.pid, "SIGUSR2");
});
