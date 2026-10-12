// State Management di PostgreSQL (memakai pool db.js yang sudah ada).
// Tabel dibuat sendiri saat pertama dipakai, db.js tidak perlu diubah.
const db = require("../db");
const { normalizeJid } = require("./jid");

let ready = null;
function init() {
  if (!ready) {
    ready = db
      .query(
        `CREATE TABLE IF NOT EXISTS bot_sessions (
           jid          text PRIMARY KEY,
           phone_number text NOT NULL,
           funnel_stage int  NOT NULL DEFAULT 0 CHECK (funnel_stage BETWEEN 0 AND 4),
           status       text NOT NULL DEFAULT 'BOT' CHECK (status IN ('BOT','HANDOFF')),
           updated_at   timestamptz NOT NULL DEFAULT NOW()
         );
         ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS stuck_sent_at timestamptz;
         CREATE INDEX IF NOT EXISTS idx_bot_sessions_stuck
           ON bot_sessions (updated_at) WHERE status = 'BOT' AND stuck_sent_at IS NULL;`,
      )
      .catch((err) => {
        ready = null; // coba lagi pada pemanggilan berikutnya
        throw err;
      });
  }
  return ready;
}

const map = (r) =>
  r
    ? {
        phoneNumber: r.phone_number,
        funnel_stage: r.funnel_stage,
        status: r.status,
        updatedAt: r.updated_at,
      }
    : null;

async function getSession(jid) {
  jid = normalizeJid(jid);
  await init();
  const r = await db.query(
    "SELECT phone_number, funnel_stage, status, updated_at FROM bot_sessions WHERE jid = $1",
    [jid],
  );
  return map(r.rows[0]);
}

// Buat sesi hanya jika belum ada (aman dari balapan dua pesan pertama yang bersamaan)
async function createSession(jid, { phoneNumber, funnel_stage, status }) {
  jid = normalizeJid(jid);
  await init();
  await db.query(
    `INSERT INTO bot_sessions (jid, phone_number, funnel_stage, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (jid) DO NOTHING`,
    [jid, phoneNumber, funnel_stage, status],
  );
}

// Upsert PARTIAL: hanya field yang diberikan yang diubah. Field yang tidak diberikan tetap
// seperti di database, jadi dua proses yang jalan bersamaan (mis. funnel memajukan stage
// sementara CS memicu HANDOFF) tidak saling menimpa status.
async function updateSession(jid, { phoneNumber, funnel_stage, status }) {
  jid = normalizeJid(jid);
  await init();
  const r = await db.query(
    `INSERT INTO bot_sessions (jid, phone_number, funnel_stage, status)
     VALUES ($1::text, $2::text, COALESCE($3::int, 0), COALESCE($4::text, 'BOT'))
     ON CONFLICT (jid) DO UPDATE SET
       phone_number = COALESCE($2::text, bot_sessions.phone_number),
       funnel_stage = COALESCE($3::int,  bot_sessions.funnel_stage),
       status       = COALESCE($4::text, bot_sessions.status),
       updated_at   = NOW()
     RETURNING phone_number, funnel_stage, status, updated_at`,
    [
      jid,
      phoneNumber ?? jid.split("@")[0],
      funnel_stage ?? null,
      status ?? null,
    ],
  );
  return map(r.rows[0]);
}

// Ambil (sekaligus tandai terkirim) sesi yang menggantung di stage 1-3.
// updated_at = waktu langkah bot terakhir; berubah setiap customer membalas / stage maju.
async function claimStuck({ afterMin, maxAgeMin, limit }) {
  await init();
  const r = await db.query(
    `UPDATE bot_sessions SET stuck_sent_at = NOW()
     WHERE jid IN (
       SELECT jid FROM bot_sessions
       WHERE status = 'BOT'
         AND funnel_stage BETWEEN 1 AND 3
         AND stuck_sent_at IS NULL
         AND updated_at <= NOW() - ($1::int * interval '1 minute')
         AND updated_at >  NOW() - ($2::int * interval '1 minute')
       ORDER BY updated_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING jid, phone_number, funnel_stage`,
    [afterMin, maxAgeMin, limit],
  );
  return r.rows;
}

// Batalkan penandaan /stuck (mis. customer ternyata baru dibalas bot, atau sedang mengetik)
async function releaseStuck(jid) {
  jid = normalizeJid(jid);
  await init();
  await db.query(
    "UPDATE bot_sessions SET stuck_sent_at = NULL WHERE jid = $1 AND status = 'BOT'",
    [jid],
  );
}

module.exports = {
  getSession,
  createSession,
  updateSession,
  claimStuck,
  releaseStuck,
};
