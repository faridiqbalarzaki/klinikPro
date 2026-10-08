// Konversi audio upload -> OGG/Opus agar tampil sebagai Voice Note (PTT) di WhatsApp.
// Pakai paket ffmpeg-static (tanpa instal ffmpeg manual); cadangan: ffmpeg di PATH.
const { spawn } = require("child_process");

let ffmpegBin = "ffmpeg";
try {
  ffmpegBin = require("ffmpeg-static") || "ffmpeg";
} catch (_) {
  /* pakai ffmpeg dari PATH */
}

const CACHE_MAX = 20;
const cache = new Map(); // nama file -> Buffer OGG/Opus

function convert(input) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const ff = spawn(ffmpegBin, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-map_metadata",
      "-1",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1",
    ]);
    const chunks = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", () => {});
    ff.stdin.on("error", () => {}); // EPIPE jika ffmpeg berhenti lebih awal
    ff.on("error", (err) => {
      console.warn(`⚠️  ffmpeg tidak bisa dijalankan: ${err.message}`);
      finish(null);
    });
    ff.on("close", (code) => {
      const out = Buffer.concat(chunks);
      finish(code === 0 && out.length > 0 ? out : null);
    });
    ff.stdin.end(input);
  });
}

// file = { buffer, mimetype } dari media.readImage(). Mengembalikan isi pesan Baileys.
// Hasil konversi di-cache, jadi batch 100 penerima hanya memicu satu kali ffmpeg.
async function toVoiceNote(name, file) {
  let buf = cache.get(name);
  if (!buf) {
    buf = await convert(file.buffer);
    if (buf) {
      cache.set(name, buf);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
  }
  if (buf) return { audio: buf, mimetype: "audio/ogg; codecs=opus", ptt: true };

  // Cadangan jika ffmpeg gagal: kirim file asli tetap sebagai PTT (hasil bisa kurang konsisten)
  console.warn("⚠️  Konversi ffmpeg gagal, voice note dikirim tanpa konversi.");
  return {
    audio: file.buffer,
    mimetype:
      file.mimetype === "audio/ogg" ? "audio/ogg; codecs=opus" : file.mimetype,
    ptt: true,
  };
}

module.exports = { toVoiceNote };
