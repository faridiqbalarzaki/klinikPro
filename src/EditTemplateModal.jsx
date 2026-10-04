import { useState } from "react";
import { Pencil, X, Plus } from "lucide-react";

const MAX_IMAGES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const API_KEY = import.meta.env.VITE_API_KEY;

const imgSrc = (v) =>
  v.startsWith("data:") ? v : `/uploads/${encodeURIComponent(v)}`;
const readFile = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

export default function EditTemplateModal({ template, onClose, onSaved }) {
  const [name, setName] = useState(template.name);
  const [content, setContent] = useState(template.content);
  const [keywords, setKeywords] = useState(
    (template.keywords || []).join(", "),
  );
  const [slot, setSlot] = useState(template.time_slot || "");
  const [images, setImages] = useState(template.images || []); // nama file lama / data URL baru
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (images.length + files.length > MAX_IMAGES) {
      return setError(`Maksimal ${MAX_IMAGES} gambar.`);
    }
    if (files.some((f) => f.size > MAX_BYTES)) {
      return setError("Ukuran gambar maksimal 5 MB.");
    }
    setError("");
    const urls = await Promise.all(files.map(readFile));
    setImages((prev) => [...prev, ...urls]);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { "x-api-key": API_KEY } : {}),
        },
        body: JSON.stringify({
          name,
          content,
          keywords,
          time_slot: slot,
          images,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan perubahan.");
      onSaved(data);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field =
    "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-pink-400";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold">
            <Pencil size={18} /> Edit Template
          </h3>
          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <label className="text-xs font-semibold text-gray-500">Nama</label>
        <input
          className={`${field} mb-3`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="text-xs font-semibold text-gray-500">Isi pesan</label>
        <textarea
          className={`${field} mb-3`}
          rows={7}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

        {template.type === "auto_reply" ? (
          <>
            <label className="text-xs font-semibold text-gray-500">
              Keyword (pisahkan koma)
            </label>
            <input
              className={`${field} mb-3`}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </>
        ) : (
          <>
            <label className="text-xs font-semibold text-gray-500">
              Kelompok
            </label>
            <select
              className={`${field} mb-3`}
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
            >
              <option value="followup">FollowUp</option>
              <option value="rencana">Rencana</option>
              <option value="pengiriman">Pengiriman</option>
              <option value="">Lainnya</option>
            </select>
          </>
        )}

        <label className="text-xs font-semibold text-gray-500">
          Gambar ({images.length}/{MAX_IMAGES})
        </label>
        <div className="mb-3 mt-1 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="relative h-20 w-20">
              <img
                src={imgSrc(img)}
                alt={`Media ${i + 1}`}
                className="h-full w-full rounded-lg border object-cover"
              />
              <button
                type="button"
                onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                className="absolute -right-2 -top-2 rounded-full bg-red-500 p-0.5 text-white"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {images.length < MAX_IMAGES && (
            <label className="flex h-20 w-20 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-gray-400">
              <Plus />
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={addFiles}
              />
            </label>
          )}
        </div>

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm">
            Batal
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-xl bg-pink-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving ? "Menyimpan..." : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  );
}
