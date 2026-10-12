// Normalisasi JID. SATU-SATUNYA tempat bot membersihkan JID sebelum dipakai sebagai kunci DB/state.
// Yang dibuang: suffix device Multi-Device ("628123:12@s.whatsapp.net" -> "628123@s.whatsapp.net").
// Domain DIPERTAHANKAN (@s.whatsapp.net, @lid, @g.us). Jangan memaksa "@s.whatsapp.net":
// angka di depan "@lid" BUKAN nomor telepon, memaksanya jadi nomor akan menyambungkan
// chat ke orang yang salah.
function normalizeJid(jid) {
  const s = String(jid ?? "").trim();
  const at = s.indexOf("@");
  if (at < 0) return s;
  const user = s.slice(0, at).split(":")[0];
  let server = s.slice(at + 1);
  if (server === "c.us") server = "s.whatsapp.net"; // format lama
  return `${user}@${server}`;
}

module.exports = { normalizeJid };
