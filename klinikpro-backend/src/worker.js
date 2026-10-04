// Baca .env dari klinikpro-backend/ (satu tingkat di atas src/), cadangan: folder kerja
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
require("dotenv").config();
const db = require("./db");
const media = require("./media");
const inbox = require("./inbox");
// Fitur Label WA bersifat tambahan: jika modulnya bermasalah, WhatsApp tetap harus tersambung.
let labels = null;
try {
  labels = require("./walabels");
  if (
    typeof labels.attach !== "function" ||
    typeof labels.resync !== "function"
  ) {
    throw new Error(
      "isi file walabels.js tidak sesuai (fungsi attach/resync tidak ada)",
    );
  }
} catch (err) {
  console.error(`⚠️  Fitur Label WA dinonaktifkan: ${err.message}`);
  labels = null;
}
const baileys = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const fs = require("fs");
const path = require("path");

const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason } = baileys;

// ==========================================
// KUNCI PROSES TUNGGAL
// Mencegah dua proses memakai sesi WhatsApp yang sama
// ==========================================
const LOCK_FILE = path.join(__dirname, ".wa-worker.lock");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // ada, tapi bukan milik kita
  }
}

const LOCK_HEARTBEAT_MS = 15000;
const LOCK_STALE_MS = 60000; // kunci tanpa detak > 60 detik dianggap basi
let lockTimer = null;

function isLockFresh() {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs < LOCK_STALE_MS;
  } catch (_) {
    return false;
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
      // PID bisa didaur ulang (Docker/restart server), jadi kunci hanya
      // dihormati jika prosesnya hidup DAN kunci masih berdetak.
      if (
        oldPid &&
        oldPid !== process.pid &&
        isProcessAlive(oldPid) &&
        isLockFresh()
      ) {
        console.error(
          `❌ Worker WhatsApp sudah berjalan di proses PID ${oldPid}. ` +
            "Hentikan proses itu dulu (atau hapus file .wa-worker.lock jika proses tersebut sudah mati).",
        );
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    lockTimer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(LOCK_FILE, now, now);
      } catch (_) {
        /* abaikan */
      }
    }, LOCK_HEARTBEAT_MS);
    lockTimer.unref();
    return true;
  } catch (err) {
    console.error("⚠️  Gagal membuat file kunci:", err.message);
    return true; // jangan blokir worker hanya karena file kunci bermasalah
  }
}

function releaseLock() {
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = null;
  try {
    if (
      fs.existsSync(LOCK_FILE) &&
      Number(fs.readFileSync(LOCK_FILE, "utf8")) === process.pid
    ) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {
    /* abaikan */
  }
}

process.on("exit", releaseLock);

// ==========================================
// KONFIGURASI
// ==========================================
// Default: klinikpro-backend/auth_info_baileys (satu tingkat di atas folder src),
// jadi tetap memakai sesi yang sama walau node dijalankan dari folder lain.
const AUTH_DIR =
  process.env.WA_AUTH_DIR || path.join(__dirname, "..", "auth_info_baileys");
const MIN_DELAY_MS = Number(process.env.WA_MIN_DELAY_MS) || 8000; // jeda minimum antar pesan
const MAX_DELAY_MS = Math.max(
  Number(process.env.WA_MAX_DELAY_MS) || 15000,
  MIN_DELAY_MS,
);
const IDLE_POLL_MS = 3000; // cek antrean saat kosong
const RECONNECT_MS = 3000;
const CAPTION_LIMIT = 1024; // batas teks keterangan gambar di WhatsApp
const IMAGE_GAP_MIN_MS = 1200; // jeda antar gambar dalam satu pesan
const IMAGE_GAP_MAX_MS = 2500;
const DISPLAY_TZ = process.env.APP_TIMEZONE || "Asia/Jakarta";
// Log diagnostik pesan masuk. Matikan di produksi dengan INBOX_DEBUG=false di .env
const INBOX_DEBUG = process.env.INBOX_DEBUG !== "false";

// ==========================================
// STATE
// ==========================================
let sock = null;
let waStatus = "idle"; // idle | connecting | qr | open | closed | logged_out
let running = false;
let reconnectTimer = null;
let lastQr = null; // string QR terbaru (diubah jadi gambar oleh server)
let connectInFlight = false; // mencegah dua socket dibuat bersamaan

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = () =>
  MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
const isConnected = () => waStatus === "open" && sock !== null;

// Hapus sesi WhatsApp di disk (setelah logout agar bisa scan QR baru)
function clearAuth() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("⚠️  Gagal menghapus folder sesi:", err.message);
  }
}

// ==========================================
// KONEKSI WHATSAPP (SATU SESI UNTUK SEMUA)
// ==========================================
function scheduleReconnect() {
  if (reconnectTimer || !running) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectWhatsApp();
    } catch (err) {
      console.error("❌ Gagal menyambung ke WhatsApp:", err.message);
      scheduleReconnect();
    }
  }, RECONNECT_MS);
}

async function connectWhatsApp() {
  if (connectInFlight) return;
  connectInFlight = true;
  try {
    await openSocket();
  } finally {
    connectInFlight = false;
  }
}

async function openSocket() {
  waStatus = "connecting";
  lastQr = null;
  console.log("Memproses koneksi ke WhatsApp...");

  // Pastikan socket lama benar-benar tertutup sebelum membuat yang baru
  if (sock) {
    const old = sock;
    sock = null;
    try {
      old.ev.removeAllListeners("connection.update");
      old.end(undefined);
    } catch (_) {
      /* sudah tertutup */
    }
  }

  // Sesi disimpan agar tidak perlu scan QR setiap restart
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const s = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });
  sock = s;

  s.ev.on("creds.update", saveCreds);

  // Pesan masuk dari pelanggan -> auto-reply / tiket Inbox
  s.ev.on("messages.upsert", (upsert) => {
    // Log paling awal: membuktikan Baileys benar-benar menangkap pesan (sebelum filter apa pun)
    if (INBOX_DEBUG) {
      console.log(
        `📨 [Baileys] messages.upsert diterima: type=${upsert?.type} jumlah=${upsert?.messages?.length ?? 0}`,
      );
    }
    if (s !== sock) {
      if (INBOX_DEBUG) console.log("📨 diabaikan: event dari socket lama");
      return; // abaikan event dari socket lama
    }
    inbox.handleUpsert(s, upsert, { send: sendDirect }).catch((err) => {
      console.error("❌ Inbox:", err.message);
    });
  });

  // Label WhatsApp Business (event labels.edit / labels.association -> PostgreSQL)
  if (labels) {
    try {
      labels.attach(s, () => s === sock);
    } catch (err) {
      console.error(
        "⚠️  Gagal memasang listener label (WhatsApp tetap berjalan):",
        err.message,
      );
    }
  }

  s.ev.on("connection.update", (update) => {
    if (s !== sock) return; // abaikan event dari socket lama

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waStatus = "qr";
      lastQr = qr;
      console.log("\n--- SILAKAN SCAN QR CODE INI DI WHATSAPP HP ANDA ---");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      waStatus = "open";
      lastQr = null;
      console.log("\n✅ WhatsApp terhubung ke sistem KlinikPro WAsender.");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(
        "Koneksi WhatsApp terputus. Alasan:",
        lastDisconnect?.error?.message || code,
      );

      lastQr = null;

      if (code === DisconnectReason.loggedOut) {
        // Sesi sudah tidak berlaku: hapus otomatis, tinggal Generate QR dari aplikasi
        clearAuth();
        waStatus = "logged_out";

        // Hapus data label WA dari database agar tidak nyampur ke device baru
        db.query("DELETE FROM wa_labels;")
          .then(() => console.log("🧹 Data Label WA lama dibersihkan."))
          .catch(() => {});

        console.log(
          "❌ WhatsApp logout. Sesi lama dihapus otomatis. Klik 'Generate QR' di aplikasi untuk menghubungkan kembali.",
        );
        return;
      }
      if (code === DisconnectReason.timedOut && waStatus === "qr") {
        waStatus = "qr_expired";
        console.log(
          "⌛ QR kedaluwarsa karena tidak di-scan. Klik 'Generate QR' di aplikasi untuk membuat yang baru.",
        );
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        waStatus = "closed";
        console.log(
          "❌ Sesi digantikan oleh koneksi lain. Penyebab umum:\n" +
            "   1) wa.js / node worker.js / server.js lain masih berjalan di terminal lain,\n" +
            "   2) nodemon me-restart server karena folder auth berubah (abaikan folder auth di nodemon),\n" +
            "   3) folder auth disalin dan dipakai di komputer/server lain.\n" +
            "   Setelah semuanya dihentikan, jalankan ulang server.",
        );
        return;
      }

      waStatus = "closed";
      scheduleReconnect();
    }
  });
}

// ==========================================
// UTILITAS PESAN
// ==========================================
function renderMessage(template, { nama, treatment, tanggal }) {
  // Fungsi pengganti dipakai agar karakter seperti "$&" di nama tidak ditafsirkan
  return String(template)
    .replace(/{{\s*nama\s*}}/gi, () => nama || "Kak")
    .replace(/{{\s*treatment\s*}}/gi, () => treatment || "Treatment")
    .replace(/{{\s*tanggal\s*}}/gi, () => tanggal);
}

function formatTanggal(date) {
  return new Date(date).toLocaleDateString("id-ID", {
    dateStyle: "medium",
    timeZone: DISPLAY_TZ,
  });
}

// ==========================================
// PEMROSESAN ANTREAN
// ==========================================

// Mengambil 1 item 'pending' secara atomik. Hanya dari batch yang:
// - belum dibatalkan / selesai
// - jadwalnya sudah tiba
const CLAIM_SQL = `
  WITH next AS (
    SELECT bi.id
    FROM batch_items bi
    JOIN batches b ON b.id = bi.batch_id
    WHERE bi.status = 'pending'
      AND b.status IN ('Terjadwal', 'Berjalan')
      AND b.scheduled_at <= NOW()
    ORDER BY b.scheduled_at ASC, bi.id ASC
    LIMIT 1
    FOR UPDATE OF bi SKIP LOCKED
  ),
  claimed AS (
    UPDATE batch_items bi
    SET status = 'processing'
    FROM next
    WHERE bi.id = next.id
    RETURNING bi.id, bi.batch_id, bi.phone, bi.customer_name, bi.treatment
  )
  SELECT c.id AS item_id, c.batch_id, c.phone, c.customer_name, c.treatment,
         b.message_text, b.scheduled_at,
         COALESCE(
           (SELECT json_agg(bm.file_name ORDER BY bm.position, bm.id)
            FROM batch_images bm WHERE bm.batch_id = b.id),
           '[]'
         ) AS images
  FROM claimed c
  JOIN batches b ON b.id = c.batch_id
`;

async function claimNextItem() {
  const result = await db.query(CLAIM_SQL);
  return result.rows[0] || null;
}

async function finalizeBatchIfDone(batchId) {
  await db.query(
    `UPDATE batches
     SET status = CASE
       WHEN EXISTS (SELECT 1 FROM batch_items WHERE batch_id = $1 AND status = 'failed')
       THEN 'Selesai dengan kegagalan'
       ELSE 'Selesai'
     END
     WHERE id = $1
       AND status = 'Berjalan'
       AND NOT EXISTS (
         SELECT 1 FROM batch_items
         WHERE batch_id = $1 AND status IN ('pending', 'processing')
       )`,
    [batchId],
  );
}

async function markFailed(task, reason) {
  await db.query(
    `UPDATE batch_items SET status = 'failed', error_log = $2 WHERE id = $1`,
    [task.item_id, String(reason).slice(0, 500)],
  );
  console.log(`⚠️  Gagal ke ${task.customer_name} (${task.phone}): ${reason}`);
}

// Kirim pesan. Batch bisa punya sampai 5 gambar:
// - Gambar dikirim berurutan; teks menjadi caption gambar PERTAMA.
// - Teks > 1024 karakter -> semua gambar dikirim dulu, lalu teksnya terpisah.
// - File gambar yang hilang dilewati (peringatan di log); jika semuanya hilang, kirim teks saja.
// - Jika gagal di tengah jalan, error diberi tanda "partial" agar item tidak dikirim ulang
//   (pelanggan sudah menerima sebagian pesan).
// Pemisah bubble chat dalam satu template: "bubble 1 [[bubble]] bubble 2"
const BUBBLE_RE = /\s*\[\[bubble\]\]\s*/i;
function splitBubbles(text) {
  const parts = String(text ?? "")
    .split(BUBBLE_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(text ?? "")];
}

// Kirim pesan: bubble 1 (+ gambar bila ada) dulu, lalu bubble berikutnya satu per satu.
// Jika gagal di tengah jalan, error diberi tanda "partial" agar item tidak dikirim ulang.
async function deliver(jid, text, imageNames) {
  if (!sock) throw new Error("Koneksi terputus saat menunggu jeda auto-reply.");
  const [first, ...rest] = splitBubbles(text);

  const files = [];
  for (const name of imageNames || []) {
    const img = media.readImage(name);
    if (img) files.push(img);
    else {
      console.log(
        `⚠️  File gambar "${name}" tidak ditemukan di folder uploads, dilewati.`,
      );
    }
  }

  const steps = [];
  if (files.length === 0) {
    steps.push(() => sock.sendMessage(jid, { text: first }));
  } else {
    const captionFits = first.length <= CAPTION_LIMIT;
    files.forEach((f, i) => {
      steps.push(() =>
        sock.sendMessage(
          jid,
          i === 0 && captionFits
            ? { image: f.buffer, mimetype: f.mimetype, caption: first }
            : { image: f.buffer, mimetype: f.mimetype },
        ),
      );
    });
    if (!captionFits) steps.push(() => sock.sendMessage(jid, { text: first }));
  }
  for (const bubble of rest) {
    steps.push(() => sock.sendMessage(jid, { text: bubble }));
  }

  let sent = 0;
  try {
    for (let i = 0; i < steps.length; i++) {
      if (i > 0) {
        await sleep(
          IMAGE_GAP_MIN_MS +
            Math.floor(
              Math.random() * (IMAGE_GAP_MAX_MS - IMAGE_GAP_MIN_MS + 1),
            ),
        );
      }
      await steps[i]();
      sent++;
    }
  } catch (err) {
    if (sent > 0) err.partial = { sent, total: steps.length };
    throw err;
  }

  const mode =
    files.length > 1
      ? `${files.length} gambar`
      : files.length === 1
        ? "gambar"
        : "teks";
  return rest.length ? `${mode}, ${rest.length + 1} bubble` : mode;
}

// Kirim langsung ke satu JID (dipakai Inbox / Follow-Up manual dari CS).
// Melempar error ber-status HTTP agar bisa diteruskan apa adanya oleh API.
async function sendDirect(jid, text, imageNames = []) {
  const fail = (status, message) => {
    const err = new Error(message);
    err.status = status;
    return err;
  };
  if (!isConnected()) {
    throw fail(
      503,
      "WhatsApp belum terhubung. Hubungkan dulu lewat tombol status di pojok kanan atas.",
    );
  }
  if (jid.endsWith("@s.whatsapp.net")) {
    try {
      const check = await sock.onWhatsApp(jid.split("@")[0]);
      if (check && check[0] && check[0].exists === false) {
        throw fail(422, "Nomor tidak terdaftar di WhatsApp.");
      }
    } catch (err) {
      if (err.status) throw err; // hanya pengecekan yang boleh dilewati saat gagal
    }
  }
  try {
    return await deliver(jid, text, imageNames);
  } catch (err) {
    err.status = err.status || 502;
    if (err.partial) {
      err.message = `Terkirim sebagian (${err.partial.sent} dari ${err.partial.total} bagian): ${err.message}`;
    }
    throw err;
  }
}

async function sendTask(task) {
  // Tandai batch mulai berjalan
  await db.query(
    `UPDATE batches SET status = 'Berjalan' WHERE id = $1 AND status = 'Terjadwal'`,
    [task.batch_id],
  );

  console.log(
    `\n⏳ Mengirim pesan ke ${task.customer_name} (${task.phone})...`,
  );

  try {
    let jid = task.phone.includes("@")
      ? task.phone
      : `${task.phone}@s.whatsapp.net`;

    // Pastikan nomor terdaftar di WhatsApp (jika pengecekan gagal, lanjut kirim)
    try {
      const check = await sock.onWhatsApp(jid.split("@")[0]);
      if (check && check[0]) {
        if (check[0].exists === false) {
          await markFailed(task, "Nomor tidak terdaftar di WhatsApp");
          return "failed";
        }
        jid = check[0].jid || jid;
      }
    } catch (checkErr) {
      console.log("Cek nomor dilewati:", checkErr.message);
    }

    const text = renderMessage(task.message_text, {
      nama: task.customer_name,
      treatment: task.treatment,
      tanggal: formatTanggal(task.scheduled_at),
    });

    // Batch bisa dibatalkan saat item ini sudah diklaim: cek ulang sebelum kirim
    const live = await db.query("SELECT status FROM batches WHERE id = $1", [
      task.batch_id,
    ]);
    if (!live.rows[0] || live.rows[0].status === "Dibatalkan") {
      await db.query(
        `UPDATE batch_items SET status = 'cancelled' WHERE id = $1`,
        [task.item_id],
      );
      console.log(`🚫 Batch dibatalkan, pesan ke ${task.phone} tidak dikirim.`);
      return "cancelled";
    }

    const mode = await deliver(jid, text, task.images);

    await db.query(
      `UPDATE batch_items
       SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error_log = NULL
       WHERE id = $1`,
      [task.item_id],
    );
    await db.query(
      `UPDATE batches SET sent_count = sent_count + 1 WHERE id = $1`,
      [task.batch_id],
    );
    console.log(
      `✅ Terkirim (${mode}) ke ${task.customer_name} (${task.phone})`,
    );
    return "sent";
  } catch (err) {
    // Sudah ada bagian pesan yang terkirim: jangan dikirim ulang, tandai gagal untuk dicek manual
    if (err.partial) {
      await markFailed(
        task,
        `Terkirim sebagian (${err.partial.sent} dari ${err.partial.total} bagian): ${err.message}`,
      );
      return "failed";
    }
    // Jika penyebabnya koneksi terputus, kembalikan ke antrean (jangan ditandai gagal)
    if (!isConnected()) {
      await db.query(
        `UPDATE batch_items SET status = 'pending' WHERE id = $1`,
        [task.item_id],
      );
      console.log("↩️  Koneksi terputus, pesan dikembalikan ke antrean.");
      return "requeued";
    }
    await markFailed(task, err.message || "Gagal mengirim pesan");
    return "failed";
  } finally {
    await finalizeBatchIfDone(task.batch_id).catch(() => {});
  }
}

async function processLoop() {
  while (running) {
    try {
      if (!isConnected()) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const task = await claimNextItem();
      if (!task) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const outcome = await sendTask(task);

      // Jeda acak antar pesan demi keamanan nomor klinik (anti-ban)
      if (outcome === "sent") {
        const delay = randomDelay();
        console.log(`⏱️  Jeda ${(delay / 1000).toFixed(1)} detik...`);
        await sleep(delay);
      } else {
        await sleep(2000);
      }
    } catch (err) {
      console.error("❌ Gagal memproses antrean:", err.message);
      await sleep(5000);
    }
  }
}

// ==========================================
// API MODUL
// ==========================================
async function startWorker() {
  if (running) return;
  if (!acquireLock()) return; // proses lain sudah memegang sesi WhatsApp
  running = true;
  console.log("🔄 Sistem antrean pesan KlinikPro berjalan...");

  // Item yang tertahan di 'processing' saat proses mati tidak dikirim ulang
  // (bisa jadi sudah terkirim), jadi ditandai gagal agar bisa dicek manual.
  try {
    await db.query(
      `UPDATE batch_items
       SET status = 'failed',
           error_log = 'Proses berhenti saat pengiriman (status tidak pasti, cek WhatsApp)'
       WHERE status = 'processing'`,
    );
  } catch (err) {
    // Kembalikan state agar worker bisa dicoba start lagi dan kunci tidak menggantung
    running = false;
    releaseLock();
    throw err;
  }

  try {
    await connectWhatsApp();
  } catch (err) {
    console.error("❌ Gagal menyambung ke WhatsApp:", err.message);
    scheduleReconnect();
  }

  processLoop();
}

function stopWorker() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    sock?.end?.(undefined);
  } catch (_) {
    /* abaikan */
  }
  releaseLock();
}

function getStatus() {
  const id = sock?.user?.id; // contoh: "62812345678:12@s.whatsapp.net"
  return {
    status: waStatus,
    connected: waStatus === "open",
    me: id ? id.split(":")[0].split("@")[0] : null,
    hasQr: Boolean(lastQr),
  };
}

// QR hanya tersedia saat status "qr"
const getQr = () => (waStatus === "qr" ? lastQr : null);

const conflict = (message) => {
  const err = new Error(message);
  err.status = 409;
  return err;
};

// Dipakai tombol "Generate QR": mulai koneksi baru (menghasilkan QR jika belum login)
async function requestConnect() {
  if (!running) {
    throw conflict(
      "Worker WhatsApp tidak aktif. Periksa log server (mungkin proses lain memegang sesi).",
    );
  }
  if (waStatus === "open" || waStatus === "connecting" || waStatus === "qr") {
    return getStatus(); // sudah tersambung / sedang berjalan
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  await connectWhatsApp();
  return getStatus();
}

// Dipakai tombol "Logout": putuskan perangkat di WhatsApp, hapus sesi lokal
async function logoutWhatsApp() {
  if (!running) throw conflict("Worker WhatsApp tidak aktif.");
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const s = sock;
  const wasOpen = waStatus === "open";
  sock = null; // event dari socket ini akan diabaikan; pesan yang sedang jalan dikembalikan ke antrean
  if (s) {
    if (wasOpen) {
      try {
        await s.logout();
      } catch (err) {
        console.log(
          "Logout di sisi WhatsApp gagal (sesi lokal tetap dihapus):",
          err.message,
        );
      }
    }
    try {
      s.ev.removeAllListeners("connection.update");
      s.end(undefined);
    } catch (_) {
      /* sudah tertutup */
    }
  }

  clearAuth();
  lastQr = null;
  waStatus = "logged_out";

  // Hapus data label WA dari database agar tidak nyampur ke device baru
  try {
    await db.query("DELETE FROM wa_labels;");
    console.log("🧹 Data Label WA lama dibersihkan karena logout.");
  } catch (err) {}

  console.log(
    "👋 WhatsApp logout. Klik 'Generate QR' untuk menghubungkan lagi.",
  );
  return getStatus();
}

// Tombol "Sync Label dari WA": minta WhatsApp mengirim ulang data label
async function syncLabels(opts = {}) {
  if (!isConnected()) {
    const err = new Error(
      "WhatsApp belum terhubung. Hubungkan dulu lewat tombol status di pojok kanan atas.",
    );
    err.status = 503;
    throw err;
  }
  if (!labels) {
    const err = new Error(
      "Fitur Label WA tidak aktif. Pastikan file src/walabels.js ada dan benar, lalu jalankan ulang server.",
    );
    err.status = 501;
    throw err;
  }
  return labels.resync(sock, opts);
}

module.exports = {
  syncLabels,
  sendDirect,
  startWorker,
  stopWorker,
  getStatus,
  getQr,
  requestConnect,
  logoutWhatsApp,
};

// Tetap bisa dijalankan mandiri: `node worker.js` (set RUN_WORKER=false di server)
if (require.main === module) {
  db.initDb()
    .then(startWorker)
    .catch((err) => {
      console.error("❌ Worker gagal start:", err);
      process.exit(1);
    });
}
