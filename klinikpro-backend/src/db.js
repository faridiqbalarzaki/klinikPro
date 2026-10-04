const { Pool, Client } = require("pg");
// Baca .env dari klinikpro-backend/ (satu tingkat di atas src/), cadangan: folder kerja
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
require("dotenv").config();

// Mengambil konfigurasi langsung dari URL connection string Neon.tech
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Wajib untuk cloud database seperti Neon
  },
});

pool.on("error", (err) => {
  console.error("❌ Error pada database PostgreSQL:", err.message);
});

/**
 * Membuat tabel yang belum ada dan menambah kolom yang kurang.
 * Aman dijalankan berkali-kali (idempotent) dan tidak menghapus data.
 *
 * CATATAN: isi string di bawah adalah SQL, jadi komentar harus memakai "--"
 * (bukan "//"), kalau tidak PostgreSQL akan menolak seluruh skrip.
 */
async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      image_url VARCHAR(255)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      phone VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      treatment VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS category_customers (
      category_id INT REFERENCES categories(id) ON DELETE CASCADE,
      customer_phone VARCHAR(50) REFERENCES customers(phone) ON DELETE CASCADE,
      PRIMARY KEY (category_id, customer_phone)
    );

    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      message_text TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(50) DEFAULT 'Terjadwal',
      sent_count INT DEFAULT 0,
      image_url VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS batch_items (
      id SERIAL PRIMARY KEY,
      batch_id INT REFERENCES batches(id) ON DELETE CASCADE,
      phone VARCHAR(50) NOT NULL,
      customer_name VARCHAR(100),
      treatment VARCHAR(100),
      status VARCHAR(50) DEFAULT 'pending',
      sent_at TIMESTAMP,
      error_log TEXT
    );

    -- Kolom yang mungkin belum ada di tabel lama
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS image_url VARCHAR(255);
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS sent_count INT DEFAULT 0;
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS image_url VARCHAR(255);
    ALTER TABLE batch_items ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
    ALTER TABLE batch_items ADD COLUMN IF NOT EXISTS error_log TEXT;

    CREATE INDEX IF NOT EXISTS idx_batch_items_status
      ON batch_items (status, batch_id);

    -- Banyak gambar per template / batch (maks 5, diatur di aplikasi)
    CREATE TABLE IF NOT EXISTS template_images (
      id SERIAL PRIMARY KEY,
      template_id INT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      file_name VARCHAR(255) NOT NULL,
      position INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS batch_images (
      id SERIAL PRIMARY KEY,
      batch_id INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      file_name VARCHAR(255) NOT NULL,
      position INT NOT NULL DEFAULT 0
    );
    -- ===== Inbox CRM (semua bersifat tambahan; data lama tidak diubah) =====
    -- customers: tetap berkunci "phone" (dipakai kategori broadcast), ditambah id/jid/FU.
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS id SERIAL;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS jid VARCHAR(100);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_fu_date DATE;
    -- created_at tanpa nilai awal untuk baris lama (NULL = pelanggan lama / kelompok RO)
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    ALTER TABLE customers ALTER COLUMN created_at SET DEFAULT NOW();
    UPDATE customers SET jid = phone || '@s.whatsapp.net' WHERE jid IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS customers_jid_key ON customers (jid);

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_id_unique') THEN
        ALTER TABLE customers ADD CONSTRAINT customers_id_unique UNIQUE (id);
      END IF;
    END $$;

    -- templates: jenis + keywords untuk auto-reply
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'manual_fu';
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}';
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'templates_type_check') THEN
        ALTER TABLE templates
          ADD CONSTRAINT templates_type_check CHECK (type IN ('auto_reply', 'manual_fu'));
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      last_message TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'resolved')),
      category VARCHAR(20) NOT NULL DEFAULT 'General'
        CHECK (category IN ('Order', 'Penawaran', 'Batal', 'General')),
      has_attachment BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Maksimal satu tiket 'pending' per customer (dasar UPSERT di inbox.js)
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_ticket_per_customer
      ON tickets (customer_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_tickets_status_updated
      ON tickets (status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_template_images_tpl
      ON template_images (template_id, position);
    CREATE INDEX IF NOT EXISTS idx_batch_images_batch
      ON batch_images (batch_id, position);

    -- Pindahkan gambar tunggal lama (kolom image_url) ke tabel baru, sekali saja
    INSERT INTO template_images (template_id, file_name, position)
      SELECT t.id, t.image_url, 0 FROM templates t
      WHERE t.image_url IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM template_images ti WHERE ti.template_id = t.id);
    INSERT INTO batch_images (batch_id, file_name, position)
      SELECT b.id, b.image_url, 0 FROM batches b
      WHERE b.image_url IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM batch_images bi WHERE bi.batch_id = b.id);

    -- ===== Sinkronisasi Label WhatsApp Business =====
    -- Ringkasan label per kontak. Satu kontak bisa punya banyak label, jadi isinya
    -- gabungan nama label dipisah koma (mis. "Daftar FO, Pelanggan VIP").
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS wa_label VARCHAR(1000);

    -- Daftar label persis seperti di WhatsApp Business
    CREATE TABLE IF NOT EXISTS wa_labels (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      color INT,
      predefined_id VARCHAR(50),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Kontak (chat) yang memakai label tersebut
    CREATE TABLE IF NOT EXISTS wa_label_chats (
      label_id VARCHAR(50) NOT NULL REFERENCES wa_labels(id) ON DELETE CASCADE,
      chat_jid VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      PRIMARY KEY (label_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_wa_label_chats_phone ON wa_label_chats (phone);

    -- Jadwal harus menyimpan zona waktu agar perbandingan dengan NOW() akurat
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'batches'
          AND column_name = 'scheduled_at'
          AND data_type = 'timestamp without time zone'
      ) THEN
        ALTER TABLE batches ALTER COLUMN scheduled_at TYPE TIMESTAMPTZ;
      END IF;
    END $$;

    -- ===== FITUR BARU: Catatan internal CS & Riwayat Pesan =====
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS private_note TEXT;

    -- Hanya nama file foto yang disimpan, bukan isi gambarnya.
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     ticket_id INT REFERENCES tickets(id) ON DELETE SET NULL,
      body TEXT,
      media_file VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_ticket
      ON messages (ticket_id) WHERE media_file IS NOT NULL;

    ALTER TABLE templates ADD COLUMN IF NOT EXISTS time_slot VARCHAR(20);
    ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_time_slot_check;
    UPDATE templates SET time_slot = NULL
      WHERE time_slot IN ('pagi','siang','sore','malam');
    ALTER TABLE templates
      ADD CONSTRAINT templates_time_slot_check
      CHECK (time_slot IS NULL OR time_slot IN ('followup','rencana','pengiriman'));
  `);
  console.log("✅ Skema database siap (klinikpro_db)");
}

// Buat database otomatis jika belum ada (butuh user PostgreSQL yang boleh CREATE DATABASE).
async function ensureDatabase() {
  const dbName = process.env.DB_NAME;
  if (!dbName) return;
  const admin = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    database: process.env.DB_ADMIN_DB || "postgres",
  });
  try {
    await admin.connect();
    const r = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (r.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`🆕 Database "${dbName}" dibuat otomatis.`);
    }
  } catch (err) {
    // Tidak fatal: jika database sudah ada / user tak punya izin, createSchema yang menentukan
    console.warn("ℹ️  Pengecekan database dilewati:", err.message);
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Menyiapkan database: membuat DB (jika belum ada) + skema, dengan percobaan ulang.
 * Berguna saat server dinyalakan otomatis bersamaan dengan PostgreSQL (boot komputer).
 */
async function initDb({ retries = 5, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await createSchema();
      console.log("✅ Skema database berhasil dimuat ke Neon.tech!");
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(
        `⏳ Menghubungkan ke database (${err.message}). Mencoba lagi ${attempt}/${retries}...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(), // untuk transaksi (BEGIN / COMMIT / ROLLBACK)
  initDb,
};
