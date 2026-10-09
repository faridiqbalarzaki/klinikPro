const express = require("express");
const router = express.Router();
const db = require("./db");
const media = require("./media");

// ==========================================
// 1. TEMPLATES (Bisa Teks / Gambar / Voice Note)
// ==========================================

// Get All Templates
router.get("/templates", async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.name, t.content, t.type, t.keywords, t.time_slot,
             COALESCE(
               (SELECT json_agg(ti.file_name ORDER BY ti.position, ti.id)
                FROM template_images ti WHERE ti.template_id = t.id),
               '[]'::json
             ) AS images
      FROM templates t
      ORDER BY t.id DESC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Create Template (Mendukung Voice Note Tanpa Teks)
router.post("/templates", async (req, res, next) => {
  try {
    const { name, content, type, keywords, time_slot, images } = req.body;

    const hasMedia = Array.isArray(images) && images.length > 0;
    const hasContent = typeof content === "string" && content.trim() !== "";

    if (!name || !name.trim()) {
      throw media.httpError(400, "Nama template wajib diisi.");
    }

    // VALIDASI BARU: Boleh tanpa teks asalkan ada file audio/media!
    if (!hasContent && !hasMedia) {
      throw media.httpError(
        400,
        "Template harus berisi teks atau media (Voice Note/Gambar).",
      );
    }

    let kwArray = [];
    if (type === "auto_reply") {
      if (typeof keywords === "string") {
        kwArray = keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      } else if (Array.isArray(keywords)) {
        kwArray = keywords.map((k) => String(k).trim()).filter(Boolean);
      }
      if (kwArray.length === 0) {
        throw media.httpError(
          400,
          "Template auto-reply wajib punya minimal 1 keyword.",
        );
      }
    }

    // Simpan gambar / voice note jika berupa Data URL
    const imageList = media.toImageList(images);
    const dataUrls = imageList.filter(media.isDataUrl);
    const existingNames = imageList.filter((x) => !media.isDataUrl(x));
    const savedNames = media.saveDataUrls(dataUrls);
    const finalImages = [...existingNames, ...savedNames];

    const { rows } = await db.query(
      `INSERT INTO templates (name, content, type, keywords, time_slot)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        name.trim(),
        content ? content.trim() : "",
        type || "manual_fu",
        kwArray,
        time_slot || null,
      ],
    );

    const newTpl = rows[0];

    // Simpan relasi media ke database
    for (let i = 0; i < finalImages.length; i++) {
      await db.query(
        `INSERT INTO template_images (template_id, file_name, position) VALUES ($1, $2, $3)`,
        [newTpl.id, finalImages[i], i],
      );
    }

    newTpl.images = finalImages;
    res.json(newTpl);
  } catch (err) {
    next(err);
  }
});

// Edit Template
router.put("/templates/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, content, keywords, time_slot, images } = req.body;

    const hasMedia = Array.isArray(images) && images.length > 0;
    const hasContent = typeof content === "string" && content.trim() !== "";

    if (!name || !name.trim()) {
      throw media.httpError(400, "Nama template wajib diisi.");
    }

    if (!hasContent && !hasMedia) {
      throw media.httpError(
        400,
        "Template harus berisi teks atau media (Voice Note/Gambar).",
      );
    }

    const imageList = media.toImageList(images);
    const dataUrls = imageList.filter(media.isDataUrl);
    const existingNames = imageList.filter((x) => !media.isDataUrl(x));
    const savedNames = media.saveDataUrls(dataUrls);
    const finalImages = [...existingNames, ...savedNames];

    let kwArray = null;
    if (keywords !== undefined) {
      if (typeof keywords === "string") {
        kwArray = keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      } else if (Array.isArray(keywords)) {
        kwArray = keywords.map((k) => String(k).trim()).filter(Boolean);
      }
    }

    const { rows } = await db.query(
      `UPDATE templates
       SET name = $1,
           content = $2,
           time_slot = COALESCE($3, time_slot),
           keywords = COALESCE($4, keywords),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        name.trim(),
        content ? content.trim() : "",
        time_slot || null,
        kwArray,
        id,
      ],
    );

    if (rows.length === 0)
      throw media.httpError(404, "Template tidak ditemukan.");

    // Update media di database
    await db.query(`DELETE FROM template_images WHERE template_id = $1`, [id]);
    for (let i = 0; i < finalImages.length; i++) {
      await db.query(
        `INSERT INTO template_images (template_id, file_name, position) VALUES ($1, $2, $3)`,
        [id, finalImages[i], i],
      );
    }

    const updatedTpl = rows[0];
    updatedTpl.images = finalImages;
    res.json(updatedTpl);
  } catch (err) {
    next(err);
  }
});

// Update Group/Time Slot Template
router.put("/templates/:id/group", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { group } = req.body;
    const { rows } = await db.query(
      `UPDATE templates SET time_slot = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [group || null, id],
    );
    if (rows.length === 0)
      throw media.httpError(404, "Template tidak ditemukan.");
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Delete Template
router.delete("/templates/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    // Ambil gambar untuk dihapus dari disk jika tidak dipakai lagi
    const { rows: imgs } = await db.query(
      `SELECT file_name FROM template_images WHERE template_id = $1`,
      [id],
    );
    for (const img of imgs) {
      media.removeImage(img.file_name);
    }

    await db.query(`DELETE FROM templates WHERE id = $1`, [id]);
    res.json({ success: true, id: Number(id) });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 2. TIKET & CRM INBOX
// ==========================================

// Get Active Tickets
router.get("/tickets/active", async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.customer_id, t.last_message, t.status, t.category, t.has_attachment,
             t.created_at, t.updated_at,
             c.phone, c.name AS customer_name, c.private_note,
             EXTRACT(EPOCH FROM (NOW() - t.updated_at))::int AS elapsed_seconds,
             COALESCE(
               (SELECT json_agg(m.media_file ORDER BY m.id)
                FROM messages m
                WHERE m.ticket_id = t.id AND m.media_file IS NOT NULL),
               '[]'::json
             ) AS media_files
      FROM tickets t
      JOIN customers c ON c.id = t.customer_id
      WHERE t.status = 'pending'
      ORDER BY t.updated_at DESC
    `);
    res.json({
      tickets: rows,
      sla_minutes: Number(process.env.SLA_MINUTES) || 15,
    });
  } catch (err) {
    next(err);
  }
});

// Update Ticket Category
router.put("/tickets/:id/category", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category } = req.body;
    const { rows } = await db.query(
      `UPDATE tickets SET category = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [category, id],
    );
    if (rows.length === 0) throw media.httpError(404, "Tiket tidak ditemukan.");
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Save Customer Private Note
router.put("/customers/:id/note", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const { rows } = await db.query(
      `UPDATE customers SET private_note = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [note || null, id],
    );
    if (rows.length === 0)
      throw media.httpError(404, "Customer tidak ditemukan.");
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 3. CATEGORIES & CONTACTS
// ==========================================

router.get("/categories", async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT cat.id, cat.name,
             COALESCE(
               (SELECT json_agg(json_build_object('phone', cust.phone, 'name', cust.name, 'treatment', cc.treatment))
                FROM category_contacts cc
                JOIN customers cust ON cust.id = cc.customer_id
                WHERE cc.category_id = cat.id),
               '[]'::json
             ) AS contacts
      FROM categories cat
      ORDER BY cat.name ASC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/categories", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim())
      throw media.httpError(400, "Nama kategori wajib diisi.");
    const { rows } = await db.query(
      `INSERT INTO categories (name) VALUES ($1) RETURNING *`,
      [name.trim()],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/categories/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM categories WHERE id = $1`, [id]);
    res.json({ success: true, id: Number(id) });
  } catch (err) {
    next(err);
  }
});

router.post("/categories/:id/contacts", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { phone, name, treatment } = req.body;

    if (!phone) throw media.httpError(400, "Nomor telepon wajib diisi.");

    // Upsert Customer
    const custRes = await db.query(
      `INSERT INTO customers (phone, name) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name)
       RETURNING id`,
      [phone, name || "Kak"],
    );
    const customerId = custRes.rows[0].id;

    // Link Contact to Category
    await db.query(
      `INSERT INTO category_contacts (category_id, customer_id, treatment)
       VALUES ($1, $2, $3)
       ON CONFLICT (category_id, customer_id) DO UPDATE SET treatment = EXCLUDED.treatment`,
      [id, customerId, treatment || "Treatment"],
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/categories/:id/contacts/:phone", async (req, res, next) => {
  try {
    const { id, phone } = req.params;
    await db.query(
      `DELETE FROM category_contacts
       WHERE category_id = $1
         AND customer_id = (SELECT id FROM customers WHERE phone = $2)`,
      [id, phone],
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 4. BATCH BROADCAST & QUEUE
// ==========================================

router.get("/batches", async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT b.id, b.name, b.scheduled_at AS date, b.status,
             COUNT(r.id)::int AS total,
             COUNT(CASE WHEN r.status = 'sent' THEN 1 END)::int AS sent,
             COUNT(CASE WHEN r.status = 'failed' THEN 1 END)::int AS failed
      FROM batches b
      LEFT JOIN recipients r ON r.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.scheduled_at DESC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/batches", async (req, res, next) => {
  try {
    const { name, message_text, scheduled_at, recipients, images } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      throw media.httpError(400, "Penerima wajib diisi.");
    }

    const { rows } = await db.query(
      `INSERT INTO batches (name, message_text, scheduled_at, status)
       VALUES ($1, $2, $3, 'Terjadwal')
       RETURNING *`,
      [name, message_text || "", scheduled_at],
    );

    const batch = rows[0];

    // Simpan gambar batch jika ada
    if (Array.isArray(images) && images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        await db.query(
          `INSERT INTO batch_images (batch_id, file_name, position) VALUES ($1, $2, $3)`,
          [batch.id, images[i], i],
        );
      }
    }

    // Insert Recipients
    for (const r of recipients) {
      await db.query(
        `INSERT INTO recipients (batch_id, phone, name, treatment, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [batch.id, r.nomor, r.nama, r.treatment],
      );
    }

    res.json(batch);
  } catch (err) {
    next(err);
  }
});

router.patch("/batches/:id/cancel", async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.query(
      `UPDATE batches SET status = 'Dibatalkan', updated_at = NOW() WHERE id = $1`,
      [id],
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
