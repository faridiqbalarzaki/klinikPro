// Validasi dan pembacaan file media (gambar + voice note), dipakai form Buat dan Edit template.
export const MAX_AUDIO = 1;
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_ACCEPT =
  "image/jpeg,image/png,image/webp,audio/mpeg,audio/ogg,.mp3,.ogg";

const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];
const AUDIO_EXT = ["mp3", "ogg"];

// Nama file lama (dari server) maupun data URL baru
export const isAudioSrc = (src) =>
  typeof src === "string" &&
  (src.startsWith("data:audio/") || /\.(mp3|ogg)$/i.test(src));

export function countMedia(list = []) {
  const audio = list.filter(isAudioSrc).length;
  return { images: list.length - audio, audio };
}

function classify(file) {
  if (IMAGE_MIME.includes(file.type)) return "image";
  const ext = file.name.split(".").pop().toLowerCase();
  // beberapa browser memberi MIME kosong untuk .ogg, jadi ekstensi ikut dicek
  const typeOk =
    !file.type ||
    file.type.startsWith("audio/") ||
    file.type === "application/ogg";
  return AUDIO_EXT.includes(ext) && typeOk ? "audio" : null;
}

function readAsDataUrl(file, kind) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      let url = String(r.result);
      if (kind === "audio") {
        // samakan header dengan yang diterima server
        const mime = file.name.toLowerCase().endsWith(".mp3")
          ? "audio/mpeg"
          : "audio/ogg";
        url = url.replace(/^data:.*?;base64,/, `data:${mime};base64,`);
      }
      resolve(url);
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

/**
 * Validasi file yang dipilih terhadap daftar media saat ini, lalu baca jadi data URL.
 * Mengembalikan array data URL yang lolos (urutan sesuai file yang dipilih).
 */
export async function prepareMedia(fileList, current, notify, maxImages) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return [];

  const counts = countMedia(current);
  const accepted = [];
  for (const file of files) {
    const kind = classify(file);
    if (!kind) {
      notify(
        "error",
        `"${file.name}" dilewati: gunakan JPG, PNG, WEBP, MP3, atau OGG.`,
      );
      continue;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      notify("error", `"${file.name}" dilewati: ukuran maksimal 5 MB.`);
      continue;
    }
    if (kind === "image") {
      if (counts.images >= maxImages) {
        notify("error", `Maksimal ${maxImages} gambar per template.`);
        continue;
      }
      counts.images++;
    } else {
      if (counts.audio >= MAX_AUDIO) {
        notify("error", "Maksimal 1 voice note per template.");
        continue;
      }
      counts.audio++;
    }
    accepted.push({ file, kind });
  }
  const urls = await Promise.all(
    accepted.map((a) => readAsDataUrl(a.file, a.kind)),
  );
  return urls.filter(Boolean);
}
