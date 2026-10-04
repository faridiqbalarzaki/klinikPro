// Sinkronisasi Label WhatsApp Business.
//
// Cara kerja:
//  - WhatsApp mengirim label lewat "app state sync". Baileys meneruskannya sebagai dua event:
//      labels.edit         -> label dibuat / diubah nama-warnanya / dihapus
//      labels.association  -> sebuah chat diberi / dicabut dari sebuah label
//  - Tidak ada fungsi "ambil semua label" di Baileys, dan store.labels hanya ada di memori
//    (hilang saat server restart; dihapus di Baileys v7). Karena itu setiap event langsung
//    disimpan ke PostgreSQL (wa_labels + wa_label_chats) sehingga data bertahan dan
//    otomatis ikut berubah bila label diubah di HP.
//  - "Sync" manual memaksa WhatsApp mengirim ulang data (resyncAppState); hasilnya
//    masuk lewat event yang sama.
//  - Satu kontak bisa punya BANYAK label, sedangkan customers.wa_label hanya satu kolom,
//    jadi kolom itu berisi ringkasan gabungan ("Daftar FO, Pelanggan VIP"). Sumber data
//    yang akurat untuk pengelompokan adalah tabel wa_label_chats.
const db = require("./db");

const DEBUG = process.env.LABEL_DEBUG !== "false";
// false -> kontak berlabel yang belum ada di tabel customers TIDAK dibuat baris barunya
const CREATE_CUSTOMERS = process.env.LABEL_SYNC_CREATE_CUSTOMERS !== "false";
const DEFAULT_CONTACT_NAME = "Kak";
const SYNC_COLLECTIONS = [
  "critical_block",
  "critical_unblock_low",
  "regular_high",
  "regular_low",
  "regular",
];

const dbg = (...args) => {
  if (DEBUG) console.log("🏷️  [Label]", ...args);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// ------------------------------------------------------------------
// Antrean: event diproses satu per satu agar urutan "add" lalu "remove" terjaga
// ------------------------------------------------------------------
let tail = Promise.resolve();
let pending = 0;
let refreshTimer = null;
let syncing = false;
let lastEventAt = null;
let eventCount = 0;

function enqueue(task) {
  pending++;
  tail = tail
    .then(task)
    .catch((err) => console.error("❌ Label:", err.message))
    .finally(() => {
      pending--;
    });
  return tail;
}

// Tunggu sampai semua event selesai diproses (dan ringkasan kolom sudah diperbarui)
async function idle(maxMs = 20000) {
  const start = Date.now();
  let calmSince = Date.now();
  while (Date.now() - start < maxMs) {
    if (pending > 0 || refreshTimer) calmSince = Date.now();
    else if (Date.now() - calmSince >= 800) return true;
    await sleep(150);
  }
  return false;
}

// ------------------------------------------------------------------
// JID / nomor
// ------------------------------------------------------------------
const normalizeJid = (jid) =>
  typeof jid === "string" ? jid.replace(/:\d+@/, "@") : "";

const phoneFromJid = (jid) =>
  String(jid).split("@")[0].replace(/\D/g, "") || null;

// @s.whatsapp.net -> nomor langsung. @lid (ID internal WhatsApp) -> cari di tabel customers,
// lalu coba pemetaan LID->nomor milik Baileys v7 (jika tersedia). Gagal -> null.
async function resolvePhone(sock, jid) {
  if (jid.endsWith("@s.whatsapp.net")) return phoneFromJid(jid);
  if (jid.endsWith("@lid")) {
    const r = await db.query(
      "SELECT phone FROM customers WHERE jid = $1 LIMIT 1",
      [jid],
    );
    if (r.rows[0]?.phone) return r.rows[0].phone;
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn && String(pn).endsWith("@s.whatsapp.net")) {
        return phoneFromJid(normalizeJid(String(pn)));
      }
    } catch (_) {
      /* hanya tersedia di Baileys v7; abaikan jika tidak ada */
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Penulisan ke database
// ------------------------------------------------------------------
// Ringkasan gabungan di customers.wa_label (satu kolom, banyak label dipisah koma)
async function refreshCustomerLabels() {
  const set = await db.query(`
    UPDATE customers c
    SET wa_label = s.names
    FROM (
      SELECT lc.phone, LEFT(string_agg(l.name, ', ' ORDER BY l.name), 1000) AS names
      FROM wa_label_chats lc
      JOIN wa_labels l ON l.id = lc.label_id
      WHERE lc.phone IS NOT NULL
      GROUP BY lc.phone
    ) s
    WHERE c.phone = s.phone AND c.wa_label IS DISTINCT FROM s.names
  `);
  const clear = await db.query(`
    UPDATE customers c
    SET wa_label = NULL
    WHERE c.wa_label IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM wa_label_chats lc WHERE lc.phone = c.phone)
  `);
  dbg(
    `kolom customers.wa_label diperbarui: ${set.rowCount ?? 0} diisi/diubah, ${clear.rowCount ?? 0} dikosongkan`,
  );
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    enqueue(refreshCustomerLabels);
  }, 1500);
}

async function onLabelEdit(label) {
  const id = String(label?.id ?? "");
  if (!id) return;
  if (label.deleted) {
    await db.query("DELETE FROM wa_labels WHERE id = $1::text", [id]);
    dbg(`label dihapus: id=${id}`);
    scheduleRefresh();
    return;
  }
  const name = String(label.name ?? "").trim();
  const color = Number.isInteger(label.color) ? label.color : null;
  const predefined =
    label.predefinedId != null ? String(label.predefinedId) : null;
  await db.query(
    `INSERT INTO wa_labels (id, name, color, predefined_id, updated_at)
     VALUES ($1::text, COALESCE(NULLIF($2::text, ''), 'Label ' || $1::text), $3::int, $4::text, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(NULLIF($2::text, ''), wa_labels.name),
       color = COALESCE($3::int, wa_labels.color),
       predefined_id = COALESCE($4::text, wa_labels.predefined_id),
       updated_at = NOW()`,
    [id, name, color, predefined],
  );
  dbg(`label tersimpan: id=${id} nama="${name}" warna=${color}`);
  scheduleRefresh();
}

async function onAssociation(sock, evt) {
  const a = evt?.association;
  if (!a) return;
  // Label pada satu pesan (bukan chat) tidak relevan untuk daftar kontak
  if (a.messageId || a.type === "label_message") return;

  const labelId = String(a.labelId ?? "");
  const chatJid = normalizeJid(a.chatId);
  if (!labelId || !chatJid) return;
  if (!/@(s\.whatsapp\.net|lid)$/.test(chatJid)) {
    dbg(`dilewati: bukan chat pribadi (${chatJid})`);
    return;
  }

  if (evt.type === "remove") {
    await db.query(
      "DELETE FROM wa_label_chats WHERE label_id = $1::text AND chat_jid = $2::text",
      [labelId, chatJid],
    );
    dbg(`label ${labelId} dicabut dari ${chatJid}`);
    scheduleRefresh();
    return;
  }

  // Event asosiasi bisa tiba sebelum event definisi label -> buat label sementara
  await db.query(
    `INSERT INTO wa_labels (id, name) VALUES ($1::text, 'Label ' || $1::text)
     ON CONFLICT (id) DO NOTHING`,
    [labelId],
  );

  const phone = await resolvePhone(sock, chatJid);

  // UPSERT ke customers. created_at sengaja NULL: kontak berlabel adalah pelanggan lama,
  // bukan "pelanggan baru hari ini" (created_at NULL = kelompok RO di antrean Follow-Up).
  if (phone && CREATE_CUSTOMERS) {
    await db.query(
      `INSERT INTO customers (phone, jid, name, created_at)
       VALUES ($1::text, $2::text, $3::text, NULL)
       ON CONFLICT (phone) DO UPDATE SET
         jid  = COALESCE(customers.jid, EXCLUDED.jid),
         name = CASE
                  WHEN COALESCE(customers.name, '') = '' THEN EXCLUDED.name
                  ELSE customers.name
                END`,
      [phone, `${phone}@s.whatsapp.net`, DEFAULT_CONTACT_NAME],
    );
  }

  await db.query(
    `INSERT INTO wa_label_chats (label_id, chat_jid, phone)
     VALUES ($1::text, $2::text, $3::text)
     ON CONFLICT (label_id, chat_jid) DO UPDATE
       SET phone = COALESCE(EXCLUDED.phone, wa_label_chats.phone)`,
    [labelId, chatJid, phone],
  );
  dbg(
    `label ${labelId} -> ${chatJid}${phone ? ` (nomor ${phone})` : " (nomor belum dikenali)"}`,
  );
  scheduleRefresh();
}

// ------------------------------------------------------------------
// Pasang listener ke socket Baileys
// ------------------------------------------------------------------
function attach(sock, isCurrent = () => true) {
  sock.ev.on("labels.edit", (payload) => {
    if (!isCurrent()) return;
    for (const label of [].concat(payload || [])) {
      eventCount++;
      lastEventAt = new Date();
      dbg(
        `event labels.edit: id=${label?.id} nama="${label?.name ?? ""}" dihapus=${!!label?.deleted}`,
      );
      enqueue(() => onLabelEdit(label));
    }
  });

  sock.ev.on("labels.association", (payload) => {
    if (!isCurrent()) return;
    for (const evt of [].concat(payload || [])) {
      eventCount++;
      lastEventAt = new Date();
      dbg(
        `event labels.association: ${evt?.type} label=${evt?.association?.labelId} chat=${evt?.association?.chatId}`,
      );
      enqueue(() => onAssociation(sock, evt));
    }
  });
}

// ------------------------------------------------------------------
// Data untuk API
// ------------------------------------------------------------------
async function counts() {
  const r = await db.query(`
    SELECT (SELECT COUNT(*) FROM wa_labels)::int AS labels,
           (SELECT COUNT(DISTINCT chat_jid) FROM wa_label_chats)::int AS contacts
  `);
  return r.rows[0] || { labels: 0, contacts: 0 };
}

async function getGroups() {
  const groups = await db.query(`
    SELECT l.id, l.name, l.color,
           COUNT(lc.chat_jid)::int AS count,
           COALESCE(
             json_agg(
               json_build_object(
                 'phone', lc.phone,
                 'jid', lc.chat_jid,
                 'name', cu.name,
                 'labels', cu.wa_label
               )
               ORDER BY cu.name NULLS LAST, lc.phone NULLS LAST, lc.chat_jid
             ) FILTER (WHERE lc.chat_jid IS NOT NULL),
             '[]'::json
           ) AS contacts
    FROM wa_labels l
    LEFT JOIN wa_label_chats lc ON lc.label_id = l.id
    LEFT JOIN LATERAL (
      SELECT c.name, c.wa_label
      FROM customers c
      WHERE c.phone = lc.phone OR c.jid = lc.chat_jid
      ORDER BY (c.phone = lc.phone) DESC
      LIMIT 1
    ) cu ON TRUE
    GROUP BY l.id
    ORDER BY l.name
  `);
  const c = await counts();
  return {
    labels: groups.rows,
    meta: {
      totalLabels: c.labels,
      totalContacts: c.contacts,
      lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      syncing,
    },
  };
}

// ------------------------------------------------------------------
// Sinkronisasi manual
// ------------------------------------------------------------------
// full: true  -> hapus versi sinkronisasi tersimpan lalu minta snapshot penuh dari WhatsApp
// full: false -> minta pembaruan susulan saja
// full: undefined -> otomatis penuh bila database label masih kosong
async function resync(sock, { full } = {}) {
  if (syncing) throw httpError(409, "Sinkronisasi label sedang berjalan.");
  if (typeof sock?.resyncAppState !== "function") {
    throw httpError(
      501,
      "Versi Baileys yang terpasang tidak menyediakan resyncAppState. " +
        "Tautkan ulang perangkat (Logout, lalu Generate QR) agar WhatsApp mengirim data label saat sinkronisasi awal.",
    );
  }

  syncing = true;
  const startedEvents = eventCount;
  try {
    const before = await counts();
    const doFull = full === undefined ? before.labels === 0 : Boolean(full);
    dbg(
      `sinkronisasi dimulai (penuh=${doFull}), label di DB: ${before.labels}`,
    );

    if (doFull) {
      try {
        const reset = {};
        for (const name of SYNC_COLLECTIONS) reset[name] = null;
        await sock.authState.keys.set({ "app-state-sync-version": reset });
      } catch (err) {
        dbg("reset versi sinkronisasi dilewati:", err.message);
      }
    }

    try {
      await sock.resyncAppState(SYNC_COLLECTIONS, doFull);
    } catch (err) {
      throw httpError(502, `WhatsApp menolak sinkronisasi: ${err.message}`);
    }

    await sleep(1500); // beri waktu event terakhir masuk antrean
    await idle();

    const after = await counts();
    const newEvents = eventCount - startedEvents;
    dbg(
      `sinkronisasi selesai: ${newEvents} event diterima, ${after.labels} label, ${after.contacts} kontak`,
    );
    return {
      ok: true,
      full: doFull,
      newEvents,
      labels: after.labels,
      contacts: after.contacts,
    };
  } finally {
    syncing = false;
  }
}

module.exports = {
  attach,
  resync,
  getGroups,
  // diekspor untuk pengujian
  normalizeJid,
  phoneFromJid,
  idle,
};
