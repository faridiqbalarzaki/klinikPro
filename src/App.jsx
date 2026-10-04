import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
} from "react";
import {
  Send,
  Calendar,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  Plus,
  Tag,
  Users,
  Trash2,
  Pencil,
  FileText,
  Search,
  MessageSquare,
  Loader2,
  Smartphone,
  SmartphoneNfc,
  RefreshCw,
  ChevronDown,
  User,
  X,
  Image as ImageIcon,
  UploadCloud,
  Inbox,
  QrCode,
  LogOut,
  Tags,
} from "lucide-react";
import "./design.css";

// PWA: daftarkan service worker hanya di production (HTTPS / localhost)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.warn("Service worker gagal didaftarkan:", err));
  });
}

// ==========================================
// 1. KONFIGURASI & UTILITAS
// ==========================================
const API_URL =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.PROD ? "" : "http://localhost:5000");
const API_KEY = import.meta.env.VITE_API_KEY || "";

const MAX_IMAGES = 5; // maksimal gambar per template
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const MAX_BATCH_SIZE = 100; // batas KETAT per batch (sama dengan server)
const MAX_RECIPIENTS = 1000; // maksimal daftar di layar; >100 dipecah otomatis

const imageSrc = (img) =>
  img.startsWith("data:") ? img : `${API_URL}/uploads/${img}`;
const inboxMediaSrc = (f) => `${API_URL}/uploads/inbox/${f}`;

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Jenis template. "parts" = jumlah bubble chat yang digabung jadi 1 pesan.
const TPL_GROUPS = [
  {
    id: "followup",
    label: "FollowUp",
    emoji: "💬",
    hint: "Satu bubble chat.",
    parts: [
      {
        label: "Isi Pesan",
        placeholder:
          "Halo {{nama}}, jadwal {{treatment}} Anda tanggal {{tanggal}}...",
      },
    ],
  },
  {
    id: "rencana",
    label: "Rencana",
    emoji: "💰",
    hint: "2 bubble chat: Harga lalu Rencana, dikirim berurutan.",
    parts: [
      { label: "Bubble 1 - Harga", placeholder: "Isi bubble Harga..." },
      { label: "Bubble 2 - Rencana", placeholder: "Isi bubble Rencana..." },
    ],
  },
  {
    id: "pengiriman",
    label: "Pengiriman",
    emoji: "📦",
    hint: "2 bubble chat: Solusi lalu Testimoni, dikirim berurutan.",
    parts: [
      { label: "Bubble 1 - Solusi", placeholder: "Isi bubble Solusi..." },
      { label: "Bubble 2 - Testimoni", placeholder: "Isi bubble Testimoni..." },
    ],
  },
];
const GROUP_BY_ID = Object.fromEntries(TPL_GROUPS.map((g) => [g.id, g]));

// Pemisah bubble chat dalam satu template/pesan: "bubble 1 [[bubble]] bubble 2".
// Server memecahnya saat kirim: bubble 1 terkirim dulu, lalu bubble 2.
const BUBBLE_SEP = "[[bubble]]";
const BUBBLE_RE = /\s*\[\[bubble\]\]\s*/i;
const BUBBLE_RE_G = /\s*\[\[bubble\]\]\s*/gi;
const splitBubbles = (text) => {
  const parts = String(text ?? "")
    .split(BUBBLE_RE)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [""];
};

async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* body kosong */
  }
  if (!res.ok) throw new Error(data?.error || `Server error (${res.status})`);
  return data;
}

// 0812..., +62812..., 812... -> 62812...  (null jika tidak valid)
const normalizePhone = (raw) => {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  let n = digits;
  if (n.startsWith("08")) n = "62" + n.slice(1);
  else if (n.startsWith("8")) n = "62" + n;
  return /^628\d{7,12}$/.test(n) ? n : null;
};

const looksLikePhone = (s) => /^[+\d\s\-()]{8,}$/.test(s.trim());

// Format baris: "08123456789, Siska, Facial" (nama & treatment opsional)
function parseBulk(raw) {
  const result = [];
  const push = (phone, nama, treatment) => {
    const nomor = normalizePhone(phone);
    if (nomor) {
      result.push({
        nomor,
        nama: (nama || "").trim() || "Kak",
        treatment: (treatment || "").trim() || "Treatment",
      });
    }
  };

  raw.split(/[\n;]+/).forEach((line) => {
    if (!line.trim()) return;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length > 1 && parts.every((p) => p === "" || looksLikePhone(p))) {
      parts.filter(Boolean).forEach((p) => push(p, "", ""));
    } else {
      push(parts[0], parts[1], parts[2]);
    }
  });
  return result;
}

const renderTemplate = (text, { nama, treatment, tanggal }) =>
  String(text)
    .replace(/{{\s*nama\s*}}/gi, () => nama)
    .replace(/{{\s*treatment\s*}}/gi, () => treatment)
    .replace(/{{\s*tanggal\s*}}/gi, () => tanggal);

const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Kontak dari backend -> bentuk yang dipakai UI
const normalizeLabel = (c) => ({
  id: c.id,
  name: c.name,
  contacts: (c.contacts || []).map((x) => ({
    nomor: x.phone,
    nama: x.name,
    treatment: x.treatment,
  })),
});

const WA_STATUS = {
  open: {
    label: "WhatsApp Connected",
    dot: "bg-green-500",
    ok: true,
    hint: "WhatsApp sudah terhubung dan siap mengirim pesan.",
  },
  connecting: {
    label: "Menyambungkan...",
    dot: "bg-amber-400 animate-pulse",
    hint: "Sedang menyambung ke WhatsApp. Tunggu beberapa detik.",
  },
  qr: {
    label: "Scan QR",
    dot: "bg-amber-400 animate-pulse",
    hint: "Buka WhatsApp di HP → Perangkat Tertaut → Tautkan Perangkat, lalu scan QR di bawah.",
  },
  qr_expired: {
    label: "QR Kedaluwarsa",
    dot: "bg-red-500",
    hint: "QR tidak di-scan tepat waktu. Klik Generate QR untuk membuat yang baru.",
    canConnect: true,
  },
  closed: {
    label: "Terputus",
    dot: "bg-red-500",
    hint: "Koneksi terputus. Server mencoba menyambung ulang otomatis; jika tidak berhasil, klik Generate QR.",
    canConnect: true,
  },
  logged_out: {
    label: "Logout",
    dot: "bg-red-500",
    hint: "WhatsApp sudah logout. Klik Generate QR, lalu scan dengan HP Anda untuk menghubungkan kembali.",
    canConnect: true,
  },
  idle: {
    label: "Worker belum jalan",
    dot: "bg-red-500",
    hint: "Worker WhatsApp belum berjalan. Periksa log server.",
  },
  offline: {
    label: "Server tidak terjangkau",
    dot: "bg-red-500",
    hint: "Aplikasi tidak bisa menghubungi server backend.",
  },
};

// ==========================================
// 2. NOTIFIKASI INBOX: BUNYI PING + JUDUL TAB
// (bunyi dibuat lewat Web Audio, tanpa file mp3)
// ==========================================
let audioCtx = null;
const unlockAudio = () => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    /* abaikan */
  }
};

const playPing = () => {
  try {
    unlockAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const start = t0 + i * 0.18;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.45);
    });
  } catch {
    /* abaikan */
  }
};

// Berbunyi saat ada tiket baru atau pelanggan membalas di tiket pending.
// Muat pertama kali tidak berbunyi. CS cukup klik satu kali di halaman.
const useInboxPing = () => {
  const seen = useRef(null); // Map: id tiket -> updated_at
  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    let alive = true;
    const check = async () => {
      try {
        const data = await api("/api/tickets/active");
        if (!alive) return;
        if (seen.current) {
          const hasNew = data.tickets.some(
            (t) => seen.current.get(t.id) !== t.updated_at,
          );
          if (hasNew) playPing();
        }
        seen.current = new Map(data.tickets.map((t) => [t.id, t.updated_at]));
        const n = data.tickets.length;
        document.title = n > 0 ? `(${n}) KlinikPro` : "KlinikPro";
      } catch {
        /* dicoba lagi pada putaran berikutnya */
      }
    };
    check();
    const timer = setInterval(check, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("pointerdown", unlockAudio);
    };
  }, []);
};

// ==========================================
// 3. CONTEXT API (Pusat Manajemen State)
// ==========================================
const AppContext = createContext();

const AppProvider = ({ children }) => {
  const [activeTab, setActiveTab] = useState("create");
  const [waStatus, setWaStatus] = useState("offline");
  const [waMe, setWaMe] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // Create Batch: sumber data penerima
  const [rawNumbers, setRawNumbers] = useState("");
  const [manualList, setManualList] = useState([]);
  const [excluded, setExcluded] = useState([]);
  const [singleNumber, setSingleNumber] = useState("");
  const [singleName, setSingleName] = useState("");
  const [singleTreatment, setSingleTreatment] = useState("Facial");
  const [saveToLabelId, setSaveToLabelId] = useState("");

  // Pesan & jadwal
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [message, setMessage] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [selectedTemplateImages, setSelectedTemplateImages] = useState([]);

  // Data dari database
  const [templates, setTemplates] = useState([]);
  const [labels, setLabels] = useState([]);
  const [queues, setQueues] = useState([]);

  const notify = useCallback((type, text) => {
    setToast({ type, text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const refreshTemplates = useCallback(async () => {
    try {
      const data = await api("/api/templates");
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Gagal mengambil template:", err);
    }
  }, []);

  const refreshLabels = useCallback(async () => {
    try {
      const data = await api("/api/categories");
      if (Array.isArray(data)) setLabels(data.map(normalizeLabel));
    } catch (err) {
      console.error("Gagal mengambil kategori:", err);
    }
  }, []);

  const refreshQueues = useCallback(async () => {
    try {
      const data = await api("/api/batches");
      if (Array.isArray(data)) setQueues(data);
    } catch (err) {
      console.error("Gagal mengambil antrean:", err);
    }
  }, []);

  useEffect(() => {
    refreshTemplates();
    refreshLabels();
    refreshQueues();
  }, [refreshTemplates, refreshLabels, refreshQueues]);

  const refreshWaStatus = useCallback(async () => {
    try {
      const data = await api("/api/wa/status");
      setWaStatus(data.status);
      setWaMe(data.me || null);
      return data;
    } catch {
      setWaStatus("offline");
      setWaMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshWaStatus();
    const timer = setInterval(refreshWaStatus, 5000);
    return () => clearInterval(timer);
  }, [refreshWaStatus]);

  const bulkParsed = useMemo(() => parseBulk(rawNumbers), [rawNumbers]);

  const parsedList = useMemo(() => {
    const map = new Map();
    [...manualList, ...bulkParsed].forEach((item) => {
      if (!excluded.includes(item.nomor) && !map.has(item.nomor)) {
        map.set(item.nomor, item);
      }
    });
    return Array.from(map.values());
  }, [manualList, bulkParsed, excluded]);

  const addRecipients = useCallback(
    (items) => {
      const existing = new Set(parsedList.map((i) => i.nomor));
      const toAdd = [];
      let skippedLimit = 0;
      for (const it of items) {
        if (existing.has(it.nomor) || toAdd.some((t) => t.nomor === it.nomor))
          continue;
        if (existing.size + toAdd.length >= MAX_RECIPIENTS) {
          skippedLimit++;
          continue;
        }
        toAdd.push(it);
      }
      if (toAdd.length > 0) {
        setManualList((prev) => [...prev, ...toAdd]);
        setExcluded((prev) =>
          prev.filter((n) => !toAdd.some((t) => t.nomor === n)),
        );
      }
      return { added: toAdd.length, skippedLimit };
    },
    [parsedList],
  );

  const removeRecipient = useCallback((nomor) => {
    setManualList((prev) => prev.filter((i) => i.nomor !== nomor));
    setExcluded((prev) => (prev.includes(nomor) ? prev : [...prev, nomor]));
  }, []);

  const clearRecipients = useCallback(() => {
    setManualList([]);
    setExcluded([]);
    setRawNumbers("");
  }, []);

  return (
    <AppContext.Provider
      value={{
        activeTab,
        setActiveTab,
        waStatus,
        waMe,
        refreshWaStatus,
        toast,
        notify,
        rawNumbers,
        setRawNumbers,
        singleNumber,
        setSingleNumber,
        singleName,
        setSingleName,
        singleTreatment,
        setSingleTreatment,
        saveToLabelId,
        setSaveToLabelId,
        parsedList,
        addRecipients,
        removeRecipient,
        clearRecipients,
        templates,
        setTemplates,
        refreshTemplates,
        selectedTemplateId,
        setSelectedTemplateId,
        message,
        setMessage,
        scheduleDate,
        setScheduleDate,
        queues,
        refreshQueues,
        labels,
        refreshLabels,
        selectedTemplateImages,
        setSelectedTemplateImages,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

// ==========================================
// 4. KOMPONEN UI KECIL
// ==========================================
const inputBase =
  "w-full px-4 py-3 rounded-xl border border-gray-200 bg-white text-gray-700 placeholder:text-gray-400 focus:border-pink-500 focus:ring-1 focus:ring-pink-500 outline-none transition-colors font-normal text-sm";
const cardBase =
  "bg-white shadow-[0_4px_20px_rgba(0,0,0,0.03)] border border-gray-100 p-6 sm:p-8 rounded-3xl";
const hoverReveal =
  "md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all";

const TABS = [
  { id: "create", label: "Buat Batch", icon: Plus },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "queue", label: "Antrean", icon: Send },
  { id: "labels", label: "Kategori", icon: Tag },
  { id: "walabels", label: "Label WA", icon: Tags },
  { id: "templates", label: "Template", icon: FileText },
];

const StatusBadge = ({ status }) => {
  const map = {
    Berjalan: {
      cls: "bg-blue-50 text-blue-700 border-blue-100",
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    },
    Terjadwal: {
      cls: "bg-amber-50 text-amber-700 border-amber-100",
      icon: <Clock className="w-3.5 h-3.5" />,
    },
    Selesai: {
      cls: "bg-green-50 text-green-700 border-green-100",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    },
    "Selesai dengan kegagalan": {
      cls: "bg-orange-50 text-orange-700 border-orange-100",
      icon: <AlertCircle className="w-3.5 h-3.5" />,
    },
    Dibatalkan: {
      cls: "bg-red-50 text-red-700 border-red-100",
      icon: <XCircle className="w-3.5 h-3.5" />,
    },
  };
  const s = map[status] || {
    cls: "bg-gray-50 text-gray-700 border-gray-200",
    icon: null,
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border whitespace-nowrap ${s.cls}`}
    >
      {s.icon} {status}
    </span>
  );
};

const Toast = () => {
  const { toast } = useContext(AppContext);
  if (!toast) return null;
  const isError = toast.type === "error";
  return (
    <div
      role="status"
      className={`fixed top-4 right-4 left-4 sm:left-auto sm:max-w-sm z-[60] flex items-start gap-2 px-4 py-3 rounded-2xl shadow-lg border text-sm animate-slide-up ${isError ? "bg-red-50 border-red-200 text-red-800" : "bg-green-50 border-green-200 text-green-800"}`}
    >
      {isError ? (
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
      )}
      <span>{toast.text}</span>
    </div>
  );
};

// Pratinjau gelembung WhatsApp (sampai 5 gambar; beberapa bubble tampil terpisah)
const WaPreview = ({ text, images = [], className = "" }) => {
  const time = new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const bubbles = splitBubbles(text);
  return (
    <div
      className={`bg-[#efeae2] rounded-[2rem] p-4 sm:p-6 relative overflow-hidden border border-gray-200 ${className}`}
    >
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(#000 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      />
      <div className="relative z-10 flex flex-col items-start gap-1.5">
        {bubbles.map((bubble, bi) => (
          <div
            key={bi}
            className="wa-bubble animate-fade-in w-fit max-w-[85%] bg-white rounded-lg p-1.5 shadow-sm border border-gray-100 flex flex-col"
          >
            {bi === 0 && images.length > 0 && (
              <div
                data-testid="wa-preview-images"
                className={`mb-1 rounded-md overflow-hidden grid gap-0.5 ${images.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
              >
                {images.map((img, i) => (
                  <div
                    key={`${i}-${img.slice(-24)}`}
                    className={`bg-gray-100 overflow-hidden ${images.length % 2 === 1 && i === 0 && images.length > 1 ? "col-span-2" : ""}`}
                  >
                    <img
                      src={imageSrc(img)}
                      alt={`Media ${i + 1}`}
                      className={`w-full object-cover ${images.length === 1 ? "max-h-48" : "h-24"}`}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="px-1.5 pb-1 pt-1">
              <p className="text-[14px] leading-relaxed text-[#111b21] whitespace-pre-wrap break-words">
                {bubble || (
                  <span className="text-gray-400 italic">
                    Ketik pesan untuk melihat pratinjau...
                  </span>
                )}
              </p>
              <div className="text-[10px] text-gray-400 text-right mt-1 font-medium">
                {time}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const Navbar = ({ onOpenWa }) => {
  const { activeTab, setActiveTab, waStatus } = useContext(AppContext);
  const wa = WA_STATUS[waStatus] || WA_STATUS.offline;

  return (
    <header className="sticky top-0 z-40 mb-6 bg-[#F8F9FA]/80 backdrop-blur-md border-b border-gray-200/60 pt-2 pb-2">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-pink-500 flex items-center justify-center text-white font-bold text-lg shadow-sm">
            K
          </div>
          <span className="font-bold text-xl tracking-tight text-gray-900">
            KlinikPro
          </span>
        </div>

        <nav className="hidden md:flex space-x-2 items-center bg-white border border-gray-200 p-1 rounded-full shadow-sm">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-pink-500 text-white shadow-sm"
                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <button
          onClick={onOpenWa}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-50 hover:border-gray-300 transition-colors shadow-sm group"
          aria-label={`Status WhatsApp: ${wa.label}`}
        >
          <Smartphone className="w-4 h-4 text-gray-500 group-hover:text-gray-700 transition-colors" />
          <span className="hidden sm:inline">{wa.label}</span>
          <div className={`w-2 h-2 rounded-full ml-1 ${wa.dot}`}></div>
        </button>
      </div>
    </header>
  );
};

const WaModal = ({ onClose }) => {
  const { waStatus, waMe, refreshWaStatus, notify } = useContext(AppContext);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(null);
  const wa = WA_STATUS[waStatus] || WA_STATUS.offline;

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Selama jendela terbuka: perbarui status tiap 2 detik, dan ambil QR saat status "qr"
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const st = await refreshWaStatus();
      if (!alive) return;
      if (st?.status === "qr") {
        try {
          const data = await api("/api/wa/qr");
          if (alive) setQr(data.qr || null);
        } catch {
          /* dicoba lagi pada putaran berikutnya */
        }
      } else {
        setQr(null);
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshWaStatus]);

  const handleRefresh = async () => {
    setChecking(true);
    await refreshWaStatus();
    setChecking(false);
  };

  const handleConnect = async () => {
    setBusy(true);
    try {
      await api("/api/wa/connect", { method: "POST" });
      await refreshWaStatus();
    } catch (err) {
      notify("error", `Gagal membuat QR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (
      !window.confirm(
        "Logout WhatsApp dari server? Pesan yang belum terkirim akan menunggu sampai WhatsApp tersambung kembali.",
      )
    )
      return;
    setBusy(true);
    try {
      await api("/api/wa/logout", { method: "POST" });
      await refreshWaStatus();
      notify(
        "success",
        "WhatsApp berhasil logout. Klik Generate QR untuk menghubungkan lagi.",
      );
    } catch (err) {
      notify("error", `Gagal logout: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
      ></div>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-3xl w-full max-w-sm max-h-[92vh] overflow-y-auto p-8 relative animate-slide-up flex flex-col items-center text-center shadow-2xl border border-gray-100"
      >
        <button
          onClick={onClose}
          aria-label="Tutup"
          className="absolute top-4 right-4 p-2 rounded-full bg-gray-50 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <div
          className={`w-16 h-16 rounded-2xl flex items-center justify-center text-white mb-6 shadow-sm border border-black/5 ${wa.ok ? "bg-green-500" : "bg-gray-400"}`}
        >
          <SmartphoneNfc className="w-8 h-8" />
        </div>
        <h3 className="text-xl font-bold mb-2 text-gray-900">
          Status WhatsApp
        </h3>
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-50 border border-gray-200 text-sm font-semibold text-gray-800 mb-4">
          <span className={`w-2 h-2 rounded-full ${wa.dot}`}></span>
          {wa.label}
        </div>
        {wa.ok && waMe && (
          <p className="text-sm font-semibold text-gray-800 mb-2">
            Terhubung sebagai +{waMe}
          </p>
        )}
        <p className="text-sm text-gray-500 mb-6 font-normal">{wa.hint}</p>

        {waStatus === "qr" && (
          <div className="w-full mb-6 flex flex-col items-center">
            {qr ? (
              <img
                src={qr}
                alt="QR code WhatsApp"
                className="w-56 h-56 rounded-2xl border border-gray-200 p-2 bg-white"
              />
            ) : (
              <div className="w-56 h-56 rounded-2xl border border-dashed border-gray-300 flex items-center justify-center text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            )}
            <p className="text-xs text-gray-400 mt-3">
              QR diperbarui otomatis. Biarkan jendela ini terbuka sampai
              terhubung.
            </p>
          </div>
        )}

        <div className="w-full flex flex-col gap-3">
          {wa.canConnect && (
            <button
              onClick={handleConnect}
              disabled={busy}
              className="flex items-center gap-2 px-6 py-3.5 rounded-full bg-pink-500 text-white font-semibold hover:bg-pink-600 disabled:opacity-60 transition-colors w-full justify-center shadow-sm"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <QrCode className="w-4 h-4" />
              )}
              Generate QR
            </button>
          )}
          {waStatus === "open" && (
            <button
              onClick={handleLogout}
              disabled={busy}
              className="flex items-center gap-2 px-6 py-3.5 rounded-full bg-white border border-red-200 text-red-600 font-semibold hover:bg-red-50 disabled:opacity-60 transition-colors w-full justify-center"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4" />
              )}
              Logout WhatsApp
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={checking}
            className="flex items-center gap-2 px-6 py-3.5 rounded-full bg-gray-900 text-white font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors w-full justify-center shadow-sm"
          >
            <RefreshCw
              className={`w-4 h-4 ${checking ? "animate-spin" : ""}`}
            />
            Cek Status
          </button>
        </div>
      </div>
    </div>
  );
};

const SelectChevron = () => (
  <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none text-gray-400">
    <ChevronDown className="w-5 h-5" />
  </div>
);

// ==========================================
// 5. TAB: BUAT BATCH
// ==========================================
const CreateBatchTab = () => {
  const {
    labels,
    refreshLabels,
    rawNumbers,
    setRawNumbers,
    singleNumber,
    setSingleNumber,
    singleName,
    setSingleName,
    singleTreatment,
    setSingleTreatment,
    parsedList,
    addRecipients,
    removeRecipient,
    clearRecipients,
    saveToLabelId,
    setSaveToLabelId,
    templates,
    selectedTemplateId,
    setSelectedTemplateId,
    message,
    setMessage,
    scheduleDate,
    setScheduleDate,
    waStatus,
    notify,
    refreshQueues,
    setActiveTab,
    refreshTemplates,
    selectedTemplateImages,
    setSelectedTemplateImages,
  } = useContext(AppContext);

  const [submitting, setSubmitting] = useState(false);
  const [sendNow, setSendNow] = useState(true);

  useEffect(() => {
    refreshTemplates();
    refreshLabels();
  }, [refreshTemplates, refreshLabels]);

  const isOverLimit = parsedList.length > MAX_RECIPIENTS;
  const batchCount = Math.ceil(parsedList.length / MAX_BATCH_SIZE);
  const waReady = waStatus === "open";
  const hasSchedule = sendNow || Boolean(scheduleDate);
  const canSubmit =
    !submitting &&
    !isOverLimit &&
    parsedList.length > 0 &&
    message.trim() &&
    hasSchedule;

  // Template broadcast (bukan auto-reply), dikelompokkan per waktu di dropdown
  const broadcastTemplates = useMemo(
    () => templates.filter((t) => t.type !== "auto_reply"),
    [templates],
  );
  const templateGroups = useMemo(() => {
    const groups = TPL_GROUPS.map((s) => ({
      key: s.id,
      label: `${s.emoji} ${s.label}`,
      items: broadcastTemplates.filter((t) => t.time_slot === s.id),
    }));
    groups.push({
      key: "none",
      label: "Lainnya",
      items: broadcastTemplates.filter((t) => !GROUP_BY_ID[t.time_slot]),
    });
    return groups.filter((g) => g.items.length > 0);
  }, [broadcastTemplates]);

  const handleAddSingle = async (e) => {
    e.preventDefault();
    const nomor = normalizePhone(singleNumber);
    if (!nomor) {
      notify("error", "Format nomor WhatsApp tidak valid. Contoh: 08123456789");
      return;
    }
    const nama = singleName.trim() || "Kak";
    const treatment = singleTreatment.trim() || "Facial";

    if (parsedList.some((i) => i.nomor === nomor)) {
      notify("error", "Nomor sudah ada dalam daftar.");
    } else if (parsedList.length >= MAX_RECIPIENTS) {
      notify("error", `Maksimal ${MAX_RECIPIENTS} penerima di daftar.`);
      return;
    } else {
      addRecipients([{ nomor, nama, treatment }]);
    }

    if (saveToLabelId) {
      try {
        await api(`/api/categories/${saveToLabelId}/contacts`, {
          method: "POST",
          body: JSON.stringify({ phone: nomor, name: nama, treatment }),
        });
        await refreshLabels();
      } catch (err) {
        notify("error", `Gagal menyimpan ke kategori: ${err.message}`);
      }
    }
    setSingleNumber("");
    setSingleName("");
  };

  const handleAddCategory = (label) => {
    const { added, skippedLimit } = addRecipients(label.contacts);
    if (skippedLimit > 0) {
      notify(
        "error",
        `${added} kontak ditambahkan, ${skippedLimit} dilewati karena batas ${MAX_RECIPIENTS} penerima.`,
      );
    }
  };

  const handleSendNowChange = (checked) => {
    setSendNow(checked);
    if (!checked && !scheduleDate) setScheduleDate(toLocalInput(new Date()));
  };

  // Daftar > 100 otomatis dipecah (mis. 250 -> 100, 100, 50)
  const handleScheduleBatch = async () => {
    if (parsedList.length === 0 || !message.trim() || !hasSchedule) {
      notify("error", "Lengkapi daftar customer, pesan, dan jadwal kirim.");
      return;
    }
    const when = sendNow ? new Date() : new Date(scheduleDate);
    if (Number.isNaN(when.getTime())) {
      notify("error", "Jadwal kirim tidak valid.");
      return;
    }

    const tpl = templates.find((t) => String(t.id) === selectedTemplateId);
    const baseName = `${tpl?.name || "Broadcast"} - ${when.toLocaleDateString("id-ID", { dateStyle: "medium" })}`;
    const groups = chunk(parsedList, MAX_BATCH_SIZE);

    setSubmitting(true);
    let created = 0;
    try {
      for (const [i, group] of groups.entries()) {
        const payload = {
          name:
            groups.length > 1
              ? `${baseName} (${i + 1}/${groups.length})`
              : baseName,
          message_text: message,
          scheduled_at: when.toISOString(),
          recipients: group,
        };
        if (selectedTemplateImages.length > 0) {
          payload.images = selectedTemplateImages;
        }
        await api("/api/batches", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        created++;
      }
      notify(
        "success",
        groups.length > 1
          ? `${groups.length} batch berhasil dijadwalkan (maks ${MAX_BATCH_SIZE} nomor per batch).`
          : "Batch berhasil dijadwalkan dan masuk antrean.",
      );
      clearRecipients();
      setMessage("");
      setSelectedTemplateId("");
      setSelectedTemplateImages([]);
      setScheduleDate("");
      setSendNow(true);
      await refreshQueues();
      setActiveTab("queue");
    } catch (err) {
      // Buang penerima dari batch yang sudah terbuat agar tidak terkirim dua kali bila CS mencoba lagi
      groups
        .slice(0, created)
        .flat()
        .forEach((r) => removeRecipient(r.nomor));
      if (created > 0) await refreshQueues();
      notify(
        "error",
        `Gagal pada batch ke-${created + 1} dari ${groups.length} (${created} batch sudah masuk antrean): ${err.message}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const previewMessageText = useMemo(() => {
    if (!message) return "";
    const sample = parsedList[0] || {
      nama: "Siska",
      treatment: "Facial Glowing",
    };
    const dateForPreview = sendNow
      ? new Date()
      : scheduleDate
        ? new Date(scheduleDate)
        : null;
    const tanggal = dateForPreview
      ? dateForPreview.toLocaleDateString("id-ID", { dateStyle: "medium" })
      : "Besok";
    return renderTemplate(message, {
      nama: sample.nama,
      treatment: sample.treatment || "Treatment",
      tanggal,
    });
  }, [message, parsedList, scheduleDate, sendNow]);

  const scheduleSummary = sendNow
    ? "Sekarang"
    : scheduleDate
      ? new Date(scheduleDate).toLocaleString("id-ID", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "-";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        {/* Daftar Customer */}
        <div
          className={`${cardBase} animate-slide-in-right`}
          style={{ animationDelay: "0.1s" }}
        >
          <h2 className="text-lg font-bold mb-6 flex items-center gap-2 text-gray-900 border-b border-gray-100 pb-4">
            <Users className="w-5 h-5 text-pink-500" /> Daftar Customer
          </h2>

          <div className="space-y-5">
            {labels.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-gray-500">
                  Tambah dari kategori:
                </span>
                {labels.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => handleAddCategory(l)}
                    className="text-xs bg-pink-50 text-pink-700 hover:bg-pink-100 border border-pink-100 px-3 py-1.5 rounded-full font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <Tag className="w-3 h-3" /> {l.name}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={handleAddSingle} className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <input
                  type="text"
                  placeholder="No. WA (08...)"
                  value={singleNumber}
                  onChange={(e) => setSingleNumber(e.target.value)}
                  className={inputBase}
                />
                <input
                  type="text"
                  placeholder="Nama"
                  value={singleName}
                  onChange={(e) => setSingleName(e.target.value)}
                  className={inputBase}
                />
                <input
                  type="text"
                  placeholder="Treatment"
                  value={singleTreatment}
                  onChange={(e) => setSingleTreatment(e.target.value)}
                  className={inputBase}
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                <div className="w-full sm:w-1/2 relative">
                  <select
                    value={saveToLabelId}
                    onChange={(e) => setSaveToLabelId(e.target.value)}
                    className={`${inputBase} appearance-none cursor-pointer pr-10 bg-gray-50/50`}
                  >
                    <option value="">Sekaligus simpan ke kategori...</option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <SelectChevron />
                </div>
                <button
                  type="submit"
                  className="flex items-center gap-2 px-6 py-3 rounded-xl bg-pink-500 text-white font-semibold hover:bg-pink-600 transition-colors w-full sm:w-auto justify-center shadow-sm"
                >
                  <Plus className="w-4 h-4" /> Tambah
                </button>
              </div>
            </form>

            <div className="pt-5 mt-5 border-t border-gray-100">
              <div className="flex items-center justify-between mb-3 gap-3">
                <label
                  className={`block text-sm font-semibold ${isOverLimit ? "text-red-600" : "text-gray-500"}`}
                >
                  Data Pelanggan ({parsedList.length})
                  {parsedList.length > MAX_BATCH_SIZE &&
                    ` → akan dipecah jadi ${batchCount} batch (maks ${MAX_BATCH_SIZE}/batch)`}
                  {isOverLimit &&
                    ` - kurangi ${parsedList.length - MAX_RECIPIENTS} nomor`}
                </label>
                {parsedList.length > 0 && (
                  <button
                    type="button"
                    onClick={clearRecipients}
                    className="text-xs text-red-500 hover:underline font-semibold shrink-0"
                  >
                    Hapus Semua
                  </button>
                )}
              </div>

              {parsedList.length === 0 ? (
                <p className="text-sm text-gray-400 italic">
                  Belum ada customer. Tambahkan lewat form di atas atau paste
                  data massal di bawah.
                </p>
              ) : (
                <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                  {parsedList.map((item) => (
                    <div
                      key={item.nomor}
                      className="bg-gray-50 border border-gray-100 rounded-xl p-3 flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-500 shrink-0">
                          <User className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 text-sm truncate">
                            {item.nomor}
                            <span className="font-normal text-gray-400 mx-1">
                              •
                            </span>
                            {item.nama}
                          </p>
                          <p className="text-xs font-medium text-gray-500">
                            {item.treatment}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRecipient(item.nomor)}
                        aria-label={`Hapus ${item.nomor}`}
                        className={`p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-white border border-transparent hover:border-gray-200 ${hoverReveal}`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <textarea
                  rows={3}
                  value={rawNumbers}
                  onChange={(e) => setRawNumbers(e.target.value)}
                  placeholder={
                    "Paste data massal, satu penerima per baris:\n08123456789, Siska, Facial"
                  }
                  className={`${inputBase} resize-none text-xs font-mono ${isOverLimit ? "border-red-400 bg-red-50" : "bg-gray-50/50"}`}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Jadwal Kirim */}
        <div
          className={`${cardBase} animate-slide-in-right`}
          style={{ animationDelay: "0.2s" }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h2 className="text-lg font-bold flex items-center gap-2 text-gray-900">
              <Calendar className="w-5 h-5 text-pink-500" /> Jadwal Kirim
            </h2>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <input
                type="datetime-local"
                value={scheduleDate}
                disabled={sendNow}
                onChange={(e) => setScheduleDate(e.target.value)}
                className={`${inputBase} sm:w-auto py-2.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-50`}
              />
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none bg-gray-50 px-4 py-2.5 rounded-xl border border-gray-100">
                <input
                  type="checkbox"
                  checked={sendNow}
                  onChange={(e) => handleSendNowChange(e.target.checked)}
                  className="w-4 h-4 text-pink-500 border-gray-300 rounded focus:ring-pink-500 accent-pink-500"
                />
                <span>Kirim sekarang</span>
              </label>
            </div>
          </div>
        </div>

        {/* Pesan */}
        <div
          className={`${cardBase} animate-slide-in-right`}
          style={{ animationDelay: "0.3s" }}
        >
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-gray-900 border-b border-gray-100 pb-4">
            <MessageSquare className="w-5 h-5 text-pink-500" /> Pesan
          </h2>
          <div className="space-y-4">
            <div className="relative">
              <select
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  const t = templates.find(
                    (x) => String(x.id) === e.target.value,
                  );
                  if (t) {
                    setMessage(t.content);
                    setSelectedTemplateImages(t.images || []);
                  } else {
                    setSelectedTemplateImages([]);
                  }
                }}
                className={`${inputBase} appearance-none cursor-pointer pr-10 bg-gray-50/50`}
              >
                <option value="">Pilih Template Pesan...</option>
                {templateGroups.map((g) => (
                  <optgroup key={g.key} label={g.label}>
                    {g.items.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <SelectChevron />
            </div>
            <textarea
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tulis atau edit pesan Anda di sini... (Gunakan {{nama}}, {{treatment}}, {{tanggal}})"
              className={`${inputBase} resize-none`}
            />
            {splitBubbles(message).length > 1 && (
              <p className="text-xs text-gray-500">
                Pesan ini terdiri dari {splitBubbles(message).length} bubble
                chat (dipisah baris{" "}
                <span className="px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-gray-700 font-mono text-[10px]">
                  {BUBBLE_SEP}
                </span>
                ), dikirim berurutan.
              </p>
            )}
            <div>
              <p className="text-sm font-semibold text-gray-500 mb-3 flex items-center gap-2">
                <Smartphone className="w-4 h-4" /> Preview Pesan di WhatsApp
              </p>
              <WaPreview
                text={previewMessageText}
                images={selectedTemplateImages}
              />
              {selectedTemplateImages.length > 1 && (
                <p className="text-xs text-gray-400 mt-2">
                  {selectedTemplateImages.length} gambar dikirim berurutan; teks
                  menjadi keterangan gambar pertama.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Ringkasan */}
      <div className="lg:col-span-1">
        <div
          className={`${cardBase} animate-slide-in-right sticky top-24`}
          style={{ animationDelay: "0.4s" }}
        >
          <div className="flex justify-between items-start mb-6">
            <h3 className="text-xl font-bold text-gray-900">
              Ringkasan
              <br />
              Batch
            </h3>
            <div className="w-10 h-10 rounded-full bg-pink-50 flex items-center justify-center text-pink-500">
              <Users className="w-5 h-5" />
            </div>
          </div>
          <div className="mb-6 border border-gray-100 rounded-2xl overflow-hidden bg-gray-50/30">
            <div className="flex justify-between items-center p-4 border-b border-gray-100">
              <span className="text-gray-500 font-medium text-sm flex items-center gap-2">
                <Users className="w-4 h-4 text-gray-400" /> Customer
              </span>
              <span className="text-xl font-bold text-gray-900">
                {parsedList.length}
              </span>
            </div>
            {batchCount > 1 && (
              <div className="flex justify-between items-center p-4 border-b border-gray-100">
                <span className="text-gray-500 font-medium text-sm flex items-center gap-2">
                  <Send className="w-4 h-4 text-gray-400" /> Dipecah
                </span>
                <span className="text-sm font-bold text-gray-900">
                  {batchCount} batch
                </span>
              </div>
            )}
            <div className="flex justify-between items-center p-4 border-b border-gray-100">
              <span className="text-gray-500 font-medium text-sm flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-gray-400" /> Pesan
              </span>
              <span className="text-sm font-bold text-gray-900">
                {message.trim() ? "Terisi" : "-"}
              </span>
            </div>
            <div className="flex justify-between items-center p-4 gap-3">
              <span className="text-gray-500 font-medium text-sm flex items-center gap-2 shrink-0">
                <Calendar className="w-4 h-4 text-gray-400" /> Jadwal
              </span>
              <span className="text-sm font-bold text-gray-900 text-right">
                {scheduleSummary}
              </span>
            </div>
          </div>
          {!waReady && (
            <p className="mb-6 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-3">
              WhatsApp belum terhubung. Batch tetap bisa dijadwalkan dan akan
              dikirim setelah WhatsApp tersambung.
            </p>
          )}
          <button
            onClick={handleScheduleBatch}
            disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-pink-500 text-white font-bold text-[15px] hover:bg-pink-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {submitting ? "Menyimpan..." : "Jadwalkan Batch"}{" "}
            <Send className="w-4 h-4 ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 6. TAB: ANTREAN
// ==========================================
const QueueTab = () => {
  const { queues, refreshQueues, notify } = useContext(AppContext);
  const [search, setSearch] = useState("");

  useEffect(() => {
    refreshQueues();
    const timer = setInterval(refreshQueues, 5000);
    return () => clearInterval(timer);
  }, [refreshQueues]);

  const filtered = useMemo(
    () =>
      queues.filter((q) => q.name.toLowerCase().includes(search.toLowerCase())),
    [queues, search],
  );

  const handleCancel = async (q) => {
    if (
      !window.confirm(
        `Batalkan "${q.name}"? Pesan yang belum terkirim tidak akan dikirim.`,
      )
    )
      return;
    try {
      await api(`/api/batches/${q.id}/cancel`, { method: "PATCH" });
      notify("success", "Batch dibatalkan.");
      refreshQueues();
    } catch (err) {
      notify("error", `Gagal membatalkan batch: ${err.message}`);
    }
  };

  const thBase =
    "px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider bg-gray-50";

  return (
    <div className={`${cardBase} animate-slide-up p-4 sm:p-6`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 px-2 sm:px-0 border-b border-gray-100 pb-4">
        <h2 className="text-lg font-bold flex items-center gap-2 text-gray-900">
          <Send className="w-5 h-5 text-pink-500" /> Antrean Pengiriman
        </h2>
        <div className="relative w-full sm:w-72">
          <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-gray-400">
            <Search className="w-4 h-4" />
          </div>
          <input
            type="text"
            placeholder="Cari batch..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${inputBase} pl-10 py-2.5 bg-gray-50`}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[680px]">
          <thead>
            <tr>
              <th className={`${thBase} rounded-l-lg`}>Nama Batch</th>
              <th className={thBase}>Jadwal</th>
              <th className={thBase}>Progres</th>
              <th className={thBase}>Status</th>
              <th className={`${thBase} text-right rounded-r-lg`}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((q) => {
              const sentPct = q.total ? (q.sent / q.total) * 100 : 0;
              const failedPct = q.total ? (q.failed / q.total) * 100 : 0;
              const canCancel = ["Berjalan", "Terjadwal"].includes(q.status);
              return (
                <tr
                  key={q.id}
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50 transition-colors"
                >
                  <td className="px-4 py-4">
                    <p className="font-semibold text-gray-900 text-sm">
                      {q.name}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {q.total} pesan
                    </p>
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600 whitespace-nowrap">
                    {new Date(q.date).toLocaleString("id-ID", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                  <td className="px-4 py-4 min-w-[190px]">
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden flex">
                        <div
                          className={`h-full progress-fill ${q.status === "Selesai" ? "bg-green-500" : "bg-pink-500"}`}
                          style={{ width: `${sentPct}%` }}
                        ></div>
                        <div
                          className="h-full bg-red-400"
                          style={{ width: `${failedPct}%` }}
                        ></div>
                      </div>
                      <span className="text-xs font-semibold text-gray-600 w-9 text-right">
                        {Math.round(sentPct)}%
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {q.sent}/{q.total} terkirim{" "}
                      {q.failed > 0 && (
                        <span className="text-red-600 font-medium">
                          {" "}
                          · {q.failed} gagal
                        </span>
                      )}
                    </p>
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge status={q.status} />
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button
                      onClick={() => handleCancel(q)}
                      disabled={!canCancel}
                      className="text-xs px-3 py-1.5 rounded-lg font-semibold bg-red-50 text-red-600 hover:bg-red-100 border border-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Batalkan
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="p-8 text-sm text-gray-400 italic text-center"
                >
                  Belum ada batch. Buat batch baru di tab "Buat Batch".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ==========================================
// 7. TAB: KATEGORI
// ==========================================
const LabelsTab = () => {
  const { labels, refreshLabels, notify } = useContext(AppContext);
  const [search, setSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [inputs, setInputs] = useState({});
  const [openId, setOpenId] = useState(null);

  const emptyInput = { nomor: "", nama: "", treatment: "" };

  const handleAddCategory = async () => {
    const name = newLabelName.trim();
    if (!name) return;
    try {
      await api("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setNewLabelName("");
      await refreshLabels();
    } catch (err) {
      notify("error", `Gagal menambah kategori: ${err.message}`);
    }
  };

  const handleDeleteCategory = async (label) => {
    if (!window.confirm(`Hapus kategori "${label.name}"?`)) return;
    try {
      await api(`/api/categories/${label.id}`, { method: "DELETE" });
      await refreshLabels();
    } catch (err) {
      notify("error", `Gagal menghapus kategori: ${err.message}`);
    }
  };

  const handleAddContact = async (e, categoryId) => {
    e.preventDefault();
    const ci = inputs[categoryId] || emptyInput;
    const phone = normalizePhone(ci.nomor);
    if (!phone) {
      notify("error", "Format nomor WhatsApp tidak valid. Contoh: 08123456789");
      return;
    }
    try {
      await api(`/api/categories/${categoryId}/contacts`, {
        method: "POST",
        body: JSON.stringify({
          phone,
          name: ci.nama.trim() || "Kak",
          treatment: ci.treatment.trim() || "Facial",
        }),
      });
      setInputs((prev) => ({ ...prev, [categoryId]: emptyInput }));
      await refreshLabels();
    } catch (err) {
      notify("error", `Gagal menyimpan kontak: ${err.message}`);
    }
  };

  const handleDeleteContact = async (categoryId, phone) => {
    try {
      await api(
        `/api/categories/${categoryId}/contacts/${encodeURIComponent(phone)}`,
        { method: "DELETE" },
      );
      await refreshLabels();
    } catch (err) {
      notify("error", `Gagal menghapus kontak: ${err.message}`);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return labels;
    return labels
      .map((l) => {
        if (l.name.toLowerCase().includes(q)) return l;
        return {
          ...l,
          contacts: l.contacts.filter(
            (c) =>
              (c.nama || "").toLowerCase().includes(q) ||
              (c.nomor || "").includes(q),
          ),
        };
      })
      .filter((l) => l.name.toLowerCase().includes(q) || l.contacts.length > 0);
  }, [labels, search]);

  const setField = (id, field, value) =>
    setInputs((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || emptyInput), [field]: value },
    }));
  const searching = search.trim() !== "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1">
        <div
          className={`${cardBase} animate-slide-in-right sticky top-24`}
          style={{ animationDelay: "0.1s" }}
        >
          <h3 className="text-lg font-bold mb-6 flex items-center gap-2 text-gray-900 border-b border-gray-100 pb-4">
            <Tag className="w-5 h-5 text-pink-500" /> Kategori Baru
          </h3>
          <div className="space-y-4">
            <input
              type="text"
              placeholder="Nama Kategori (Contoh: Pasien Baru)"
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddCategory()}
              className={inputBase}
            />
            <button
              onClick={handleAddCategory}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 transition-colors"
            >
              <Plus className="w-4 h-4" /> Tambah
            </button>
          </div>
        </div>
      </div>
      <div className="lg:col-span-2">
        <div
          className={`${cardBase} animate-slide-in-right`}
          style={{ animationDelay: "0.2s" }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2 text-gray-900">
              <Users className="w-5 h-5 text-pink-500" /> Daftar Kategori
            </h3>
            <div className="relative w-full sm:w-72">
              <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-gray-400">
                <Search className="w-4 h-4" />
              </div>
              <input
                type="text"
                placeholder="Cari kategori atau customer..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={`${inputBase} pl-10 py-2.5 bg-gray-50`}
              />
            </div>
          </div>
          <div className="space-y-3">
            {filtered.map((l) => {
              const ci = inputs[l.id] || emptyInput;
              const isOpen = searching || openId === l.id;
              return (
                <div
                  key={l.id}
                  className="border border-gray-200 rounded-2xl hover:border-pink-300 hover:shadow-sm transition-all bg-white group"
                >
                  <div className="flex items-center justify-between gap-2 p-4">
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === l.id ? null : l.id)}
                      aria-expanded={isOpen}
                      className="flex items-center gap-4 flex-1 min-w-0 text-left"
                    >
                      <div className="w-10 h-10 rounded-full bg-pink-50 text-pink-500 flex items-center justify-center shrink-0">
                        <Tag className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-bold text-gray-900 truncate">
                          {l.name}
                        </h4>
                        <p className="text-xs text-gray-500 font-medium">
                          {l.contacts.length} Kontak
                        </p>
                      </div>
                      <ChevronDown
                        className={`w-4 h-4 text-gray-400 ml-auto shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    <button
                      aria-label={`Hapus kategori ${l.name}`}
                      onClick={() => handleDeleteCategory(l)}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {isOpen && (
                    <div className="px-4 pb-4 space-y-3 animate-fade-in">
                      <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                        {l.contacts.length === 0 ? (
                          <p className="text-xs text-gray-400 italic">
                            Belum ada customer di kategori ini.
                          </p>
                        ) : (
                          l.contacts.map((c) => (
                            <div
                              key={c.nomor}
                              className="bg-gray-50 border border-gray-100 rounded-xl p-3 flex items-center justify-between"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-500 shrink-0">
                                  <User className="w-4 h-4" />
                                </div>
                                <div className="min-w-0">
                                  <p className="font-medium text-gray-900 text-sm truncate">
                                    {c.nomor}
                                    <span className="font-normal text-gray-400 mx-1">
                                      •
                                    </span>
                                    {c.nama}
                                  </p>
                                  {c.treatment && (
                                    <p className="text-xs font-medium text-gray-500">
                                      {c.treatment}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <button
                                aria-label={`Hapus ${c.nomor}`}
                                onClick={() =>
                                  handleDeleteContact(l.id, c.nomor)
                                }
                                className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-white border border-transparent hover:border-gray-200 transition-all"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                      <form
                        onSubmit={(e) => handleAddContact(e, l.id)}
                        className="pt-3 border-t border-gray-100 grid grid-cols-1 sm:grid-cols-4 gap-2"
                      >
                        <input
                          type="text"
                          placeholder="No. WA"
                          value={ci.nomor}
                          onChange={(e) =>
                            setField(l.id, "nomor", e.target.value)
                          }
                          className={`${inputBase} py-2.5 sm:col-span-1`}
                        />
                        <input
                          type="text"
                          placeholder="Nama"
                          value={ci.nama}
                          onChange={(e) =>
                            setField(l.id, "nama", e.target.value)
                          }
                          className={`${inputBase} py-2.5`}
                        />
                        <input
                          type="text"
                          placeholder="Treatment"
                          value={ci.treatment}
                          onChange={(e) =>
                            setField(l.id, "treatment", e.target.value)
                          }
                          className={`${inputBase} py-2.5`}
                        />
                        <button
                          type="submit"
                          className="px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 transition-colors"
                        >
                          Simpan
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-sm text-gray-400 italic p-4 text-center">
                {search
                  ? "Tidak ada kategori atau customer yang cocok."
                  : "Belum ada kategori. Buat kategori pertama di sebelah kiri."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 8. TAB: TEMPLATE (gambar maks 5 + kategori waktu)
// ==========================================
// Modal edit template: ubah nama, isi pesan (per bubble), keyword, dan gambar.
const EditTemplateModal = ({ template, onClose, onSaved }) => {
  const { notify } = useContext(AppContext);
  const isAuto = template.type === "auto_reply";
  const group = !isAuto ? GROUP_BY_ID[template.time_slot] : null;
  const usesParts = !!group && group.parts.length > 1;

  const [name, setName] = useState(template.name || "");
  const [content, setContent] = useState(template.content || "");
  const [partTexts, setPartTexts] = useState(() => {
    if (!usesParts) return [];
    const parts = splitBubbles(template.content);
    return group.parts.map((_, i) => parts[i] || "");
  });
  const [keywords, setKeywords] = useState(
    (template.keywords || []).join(", "),
  );
  const [images, setImages] = useState(template.images || []); // nama file lama / data URL baru
  const [saving, setSaving] = useState(false);

  // Esc menutup modal, scroll halaman dikunci selama modal terbuka
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, saving]);

  const addFiles = (fileList) => {
    const files = Array.from(fileList || []);
    const slots = MAX_IMAGES - images.length;
    if (files.length === 0) return;
    if (slots <= 0) {
      notify("error", `Maksimal ${MAX_IMAGES} gambar per template.`);
      return;
    }
    const accepted = [];
    for (const file of files.slice(0, slots)) {
      if (!IMAGE_TYPES.includes(file.type)) {
        notify(
          "error",
          `"${file.name}" dilewati: gunakan JPG, PNG, atau WEBP.`,
        );
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        notify("error", `"${file.name}" dilewati: ukuran maksimal 5 MB.`);
        continue;
      }
      accepted.push(file);
    }
    Promise.all(
      accepted.map(
        (file) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(String(e.target.result));
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }),
      ),
    ).then((urls) =>
      setImages((prev) =>
        [...prev, ...urls.filter(Boolean)].slice(0, MAX_IMAGES),
      ),
    );
  };

  const handleSave = async () => {
    const finalContent = usesParts
      ? partTexts
          .map((t) => t.trim())
          .filter(Boolean)
          .join(`\n${BUBBLE_SEP}\n`)
      : content.trim();

    if (!name.trim() || !finalContent) {
      notify("error", "Nama dan isi template wajib diisi.");
      return;
    }
    if (usesParts && partTexts.some((t) => !t.trim())) {
      notify("error", "Isi kedua bubble chat terlebih dulu.");
      return;
    }
    if (isAuto && !keywords.trim()) {
      notify("error", "Template auto-reply wajib punya minimal 1 keyword.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        content: finalContent,
        time_slot: template.time_slot || "",
        images,
      };
      if (isAuto) payload.keywords = keywords;
      const saved = await api(`/api/templates/${template.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      onSaved(saved);
      notify("success", "Template berhasil diperbarui!");
      onClose();
    } catch (err) {
      notify("error", `Gagal menyimpan perubahan: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const labelCls = "block text-xs font-semibold text-gray-500 mb-1.5";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit template ${template.name}`}
        onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-xl max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl shadow-xl p-5 sm:p-7"
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Pencil className="w-5 h-5 text-pink-500" />
            Edit Template
          </h3>
          <button
            aria-label="Tutup"
            onClick={onClose}
            disabled={saving}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelCls}>Nama Template</label>
            <input
              className={inputBase}
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {usesParts ? (
            group.parts.map((p, i) => (
              <div key={p.label}>
                <label className={labelCls}>{p.label}</label>
                <textarea
                  rows={5}
                  className={`${inputBase} resize-y`}
                  placeholder={p.placeholder}
                  value={partTexts[i] || ""}
                  onChange={(e) =>
                    setPartTexts((prev) =>
                      prev.map((t, j) => (j === i ? e.target.value : t)),
                    )
                  }
                />
              </div>
            ))
          ) : (
            <div>
              <label className={labelCls}>Isi Pesan</label>
              <textarea
                rows={7}
                className={`${inputBase} resize-y`}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          )}

          {isAuto && (
            <div>
              <label className={labelCls}>Keyword (pisahkan dengan koma)</label>
              <input
                className={inputBase}
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
              />
            </div>
          )}

          <div>
            <label className={labelCls}>
              Gambar ({images.length}/{MAX_IMAGES})
            </label>
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div
                  key={`${img.slice(0, 40)}-${i}`}
                  className="relative w-20 h-20"
                >
                  <img
                    src={imageSrc(img)}
                    alt={`Gambar ${i + 1}`}
                    className="w-full h-full rounded-xl object-cover border border-gray-200 bg-gray-50"
                  />
                  <button
                    type="button"
                    aria-label={`Hapus gambar ${i + 1}`}
                    onClick={() =>
                      setImages((p) => p.filter((_, j) => j !== i))
                    }
                    className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center shadow"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <label className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-300 hover:border-pink-400 text-gray-400 hover:text-pink-500 flex items-center justify-center cursor-pointer transition-colors">
                  <Plus className="w-6 h-6" />
                  <input
                    type="file"
                    multiple
                    hidden
                    accept={IMAGE_TYPES.join(",")}
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Gambar yang rusak bisa dihapus lalu diunggah ulang. Batch yang
              sudah dibuat tidak ikut berubah.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100"
          >
            Batal
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-pink-500 hover:bg-pink-600 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? "Menyimpan..." : "Simpan Perubahan"}
          </button>
        </div>
      </div>
    </div>
  );
};

const TemplateCard = ({ t, onDelete, onSetGroup, onEdit }) => {
  const slot = GROUP_BY_ID[t.time_slot];
  return (
    <div className="border border-gray-200 rounded-2xl p-4 hover:border-pink-300 hover:shadow-sm transition-all bg-white flex flex-col gap-3 group">
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full bg-pink-50 flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-pink-500" />
          </div>
          <div className="min-w-0">
            <h4 className="font-bold text-gray-900 text-sm truncate">
              {t.name}
            </h4>
            <div className="flex flex-wrap items-center gap-1 mt-0.5">
              {slot && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-pink-700 bg-pink-50 px-1.5 py-0.5 rounded">
                  {slot.emoji} {slot.label}
                </span>
              )}
              {t.type === "auto_reply" && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded">
                  🤖 Auto-reply: {(t.keywords || []).join(", ")}
                </span>
              )}
              {t.images?.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                  <ImageIcon className="w-3 h-3" /> {t.images.length} Media
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            aria-label={`Edit template ${t.name}`}
            onClick={() => onEdit(t)}
            className="p-2 rounded-lg text-gray-400 hover:text-pink-500 hover:bg-pink-50 transition-colors"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            aria-label={`Hapus template ${t.name}`}
            onClick={() => onDelete(t.id)}
            className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {t.images?.length > 0 && (
        <div className="flex gap-1.5">
          {t.images.map((img, i) => (
            <img
              key={`${img}-${i}`}
              src={imageSrc(img)}
              alt={`${t.name} ${i + 1}`}
              className="w-12 h-12 rounded-lg object-cover border border-gray-100"
            />
          ))}
        </div>
      )}
      <p className="text-xs text-gray-600 bg-gray-50 p-3 rounded-xl border border-gray-100 whitespace-pre-wrap line-clamp-3">
        {t.content.replace(BUBBLE_RE_G, "\n↓ bubble berikutnya\n")}
      </p>
      {t.type !== "auto_reply" && (
        <div className="relative">
          <select
            aria-label={`Jenis template ${t.name}`}
            value={GROUP_BY_ID[t.time_slot] ? t.time_slot : ""}
            onChange={(e) => onSetGroup(t.id, e.target.value)}
            className={`${inputBase} py-2 text-xs appearance-none cursor-pointer pr-9 bg-gray-50/50`}
          >
            <option value="">Lainnya (tanpa jenis)</option>
            {TPL_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.emoji} {g.label}
              </option>
            ))}
          </select>
          <SelectChevron />
        </div>
      )}
    </div>
  );
};

const TemplatesTab = () => {
  const { templates, setTemplates, refreshTemplates, notify } =
    useContext(AppContext);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [images, setImages] = useState([]); // Daftar Base64 (maks MAX_IMAGES)
  const [tplType, setTplType] = useState("manual_fu"); // 'manual_fu' | 'auto_reply'
  const [tplGroup, setTplGroup] = useState("followup"); // followup | rencana | pengiriman
  const [partTexts, setPartTexts] = useState(["", ""]); // isi tiap bubble (Rencana / Pengiriman)
  const [keywords, setKeywords] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [slotFilter, setSlotFilter] = useState("semua"); // semua | followup | rencana | pengiriman | umum | auto
  const [editingTemplate, setEditingTemplate] = useState(null); // state untuk modal edit

  const group = GROUP_BY_ID[tplGroup];
  const usesParts = tplType === "manual_fu" && group.parts.length > 1;
  const finalContent = usesParts
    ? partTexts
        .slice(0, group.parts.length)
        .map((t) => t.trim())
        .filter(Boolean)
        .join(`\n${BUBBLE_SEP}\n`)
    : content.trim();

  useEffect(() => {
    refreshTemplates();
  }, [refreshTemplates]);

  const processFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const slots = MAX_IMAGES - images.length;
    if (slots <= 0) {
      notify("error", `Maksimal ${MAX_IMAGES} gambar per template.`);
      return;
    }
    if (files.length > slots) {
      notify(
        "error",
        `Hanya ${slots} gambar lagi yang bisa ditambahkan (maksimal ${MAX_IMAGES}).`,
      );
    }

    const accepted = [];
    for (const file of files.slice(0, slots)) {
      if (!IMAGE_TYPES.includes(file.type)) {
        notify(
          "error",
          `"${file.name}" dilewati: gunakan JPG, PNG, atau WEBP.`,
        );
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        notify("error", `"${file.name}" dilewati: ukuran maksimal 5 MB.`);
        continue;
      }
      accepted.push(file);
    }

    Promise.all(
      accepted.map(
        (file) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(String(e.target.result));
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }),
      ),
    ).then((urls) => {
      const ok = urls.filter(Boolean);
      setImages((prev) => [...prev, ...ok].slice(0, MAX_IMAGES));
    });
  };

  const removeImageAt = (index) =>
    setImages((prev) => prev.filter((_, i) => i !== index));

  const handleSave = async () => {
    if (!name.trim() || !finalContent) {
      notify("error", "Nama dan isi template wajib diisi.");
      return;
    }
    if (
      usesParts &&
      partTexts.slice(0, group.parts.length).some((t) => !t.trim())
    ) {
      notify("error", "Isi kedua bubble chat terlebih dulu.");
      return;
    }
    if (tplType === "auto_reply" && !keywords.trim()) {
      notify("error", "Template auto-reply wajib punya minimal 1 keyword.");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        content: finalContent,
        type: tplType,
      };
      if (tplType === "auto_reply") payload.keywords = keywords;
      if (tplType === "manual_fu") payload.time_slot = tplGroup;
      if (images.length > 0) payload.images = images;

      const newTemplate = await api("/api/templates", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setTemplates([newTemplate, ...templates]);
      setName("");
      setContent("");
      setImages([]);
      setTplType("manual_fu");
      setTplGroup("followup");
      setPartTexts(["", ""]);
      setKeywords("");
      notify("success", "Template berhasil disimpan!");
    } catch (err) {
      notify("error", `Gagal menyimpan template: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Yakin ingin menghapus template ini?")) return;
    try {
      await api(`/api/templates/${id}`, { method: "DELETE" });
      setTemplates(templates.filter((x) => x.id !== id));
      notify("success", "Template dihapus.");
    } catch (err) {
      notify("error", `Gagal menghapus template: ${err.message}`);
    }
  };

  const handleSetGroup = async (id, group) => {
    const previous = templates;
    setTemplates(
      templates.map((x) =>
        x.id === id ? { ...x, time_slot: group || null } : x,
      ),
    );
    try {
      await api(`/api/templates/${id}/group`, {
        method: "PUT",
        body: JSON.stringify({ group }),
      });
    } catch (err) {
      setTemplates(previous);
      notify("error", `Gagal mengubah jenis template: ${err.message}`);
    }
  };

  const previewText = finalContent
    ? renderTemplate(finalContent, {
        nama: "Budi",
        treatment: "Facial",
        tanggal: new Date().toLocaleDateString("id-ID", {
          dateStyle: "medium",
        }),
      })
    : "";

  const counts = useMemo(() => {
    const manual = templates.filter((t) => t.type !== "auto_reply");
    const c = {
      semua: templates.length,
      auto: templates.length - manual.length,
      umum: manual.filter((t) => !GROUP_BY_ID[t.time_slot]).length,
    };
    TPL_GROUPS.forEach((s) => {
      c[s.id] = manual.filter((t) => t.time_slot === s.id).length;
    });
    return c;
  }, [templates]);

  const sections = useMemo(() => {
    const manual = templates.filter((t) => t.type !== "auto_reply");
    const all = [
      ...TPL_GROUPS.map((s) => ({
        key: s.id,
        title: `${s.emoji} ${s.label}`,
        items: manual.filter((t) => t.time_slot === s.id),
      })),
      {
        key: "umum",
        title: "Lainnya (tanpa jenis)",
        items: manual.filter((t) => !GROUP_BY_ID[t.time_slot]),
      },
      {
        key: "auto",
        title: "🤖 Auto-Reply",
        items: templates.filter((t) => t.type === "auto_reply"),
      },
    ];
    const picked =
      slotFilter === "semua" ? all : all.filter((s) => s.key === slotFilter);
    return picked.filter((s) => s.items.length > 0);
  }, [templates, slotFilter]);

  const filterChips = [
    { id: "semua", label: "Semua" },
    ...TPL_GROUPS.map((s) => ({ id: s.id, label: `${s.emoji} ${s.label}` })),
    { id: "umum", label: "Lainnya" },
    { id: "auto", label: "🤖 Auto-Reply" },
  ];

  const chip =
    "px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-gray-700 font-mono text-[10px]";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form Template */}
        <div
          className={`${cardBase} animate-slide-in-right`}
          style={{ animationDelay: "0.1s" }}
        >
          <h2 className="text-lg font-bold mb-6 flex items-center gap-2 text-gray-900 border-b border-gray-100 pb-4">
            <FileText className="w-5 h-5 text-pink-500" />
            Buat Template Baru
          </h2>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Nama Template
              </label>
              <input
                type="text"
                placeholder="Contoh: Promo Facial Lebaran"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputBase}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Jenis Template
              </label>
              <div className="grid grid-cols-2 gap-2 p-1 bg-gray-50 border border-gray-200 rounded-xl">
                {[
                  { id: "manual_fu", label: "Follow-Up / Balasan" },
                  { id: "auto_reply", label: "Auto-Reply 🤖" },
                ].map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setTplType(o.id)}
                    className={`px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      tplType === o.id
                        ? "bg-white text-pink-600 shadow-sm border border-gray-200"
                        : "text-gray-500 hover:text-gray-800"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {tplType === "auto_reply" && (
                <div className="mt-3">
                  <input
                    type="text"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="Keyword, pisahkan koma: jam buka, lokasi, alamat"
                    className={inputBase}
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    Dibalas otomatis saat pesan pelanggan memuat salah satu kata
                    ini (kata utuh), dan <b>tidak</b> menjadi tiket. Boleh
                    disertai gambar (maks {MAX_IMAGES}).
                  </p>
                </div>
              )}
            </div>

            {tplType === "manual_fu" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Template
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {TPL_GROUPS.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setTplGroup(g.id)}
                      aria-pressed={tplGroup === g.id}
                      className={`flex flex-col items-center gap-0.5 px-2 py-2.5 rounded-xl border text-xs font-semibold transition-colors ${
                        tplGroup === g.id
                          ? "bg-pink-50 border-pink-300 text-pink-700 shadow-sm"
                          : "bg-white border-gray-200 text-gray-500 hover:border-pink-200 hover:text-gray-800"
                      }`}
                    >
                      <span className="text-base leading-none">{g.emoji}</span>
                      {g.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">{group.hint}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2 flex justify-between">
                <span>
                  Media (Opsional){" "}
                  <span className="text-pink-500 font-semibold">
                    {images.length}/{MAX_IMAGES}
                  </span>
                </span>
                <span className="text-gray-400 text-xs font-normal">
                  JPG, PNG, WEBP (Maks 5MB per gambar)
                </span>
              </label>

              {images.length > 0 && (
                <div
                  data-testid="template-image-grid"
                  className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-3"
                >
                  {images.map((img, i) => (
                    <div
                      key={`${i}-${img.slice(-24)}`}
                      className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 bg-gray-50"
                    >
                      <img
                        src={img}
                        alt={`Gambar ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute bottom-1 left-1 bg-black/55 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded">
                        {i + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeImageAt(i)}
                        aria-label={`Hapus gambar ${i + 1}`}
                        className="absolute top-1 right-1 bg-red-500 hover:bg-red-600 text-white rounded-full p-1 shadow-sm transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {images.length < MAX_IMAGES && (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    processFiles(e.dataTransfer.files);
                  }}
                  className={`border-2 border-dashed rounded-xl ${images.length ? "p-4" : "p-6"} flex flex-col items-center justify-center transition-colors relative ${
                    isDragging
                      ? "border-pink-500 bg-pink-50/50"
                      : "border-gray-200 hover:border-pink-300 hover:bg-gray-50/50"
                  }`}
                >
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg, image/png, image/webp"
                    data-testid="template-image-input"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={(e) => {
                      processFiles(e.target.files);
                      e.target.value = "";
                    }}
                    title="Klik atau Drag & Drop gambar ke sini"
                  />
                  <div className="flex flex-col items-center pointer-events-none">
                    <div className="w-10 h-10 bg-pink-50 text-pink-500 rounded-full flex items-center justify-center mb-2">
                      <UploadCloud className="w-5 h-5" />
                    </div>
                    <p className="text-sm font-semibold text-pink-500">
                      {images.length
                        ? "Tambah gambar lagi"
                        : "Klik untuk unggah gambar"}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      bisa pilih beberapa sekaligus, atau drag & drop
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div>
              {usesParts ? (
                <div className="space-y-4">
                  {group.parts.map((part, i) => (
                    <div key={part.label}>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {part.label}
                      </label>
                      <textarea
                        rows={4}
                        value={partTexts[i] || ""}
                        onChange={(e) =>
                          setPartTexts((prev) => {
                            const next = [...prev];
                            next[i] = e.target.value;
                            return next;
                          })
                        }
                        placeholder={part.placeholder}
                        className={`${inputBase} resize-none`}
                      />
                    </div>
                  ))}
                  <p className="text-xs text-gray-500">
                    Dikirim berurutan: <b>bubble 1</b> terkirim dulu, lalu{" "}
                    <b>bubble 2</b>.
                  </p>
                </div>
              ) : (
                <>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Isi Pesan
                  </label>
                  <textarea
                    rows={6}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={
                      tplType === "auto_reply"
                        ? "Balasan otomatis untuk keyword di atas..."
                        : group.parts[0].placeholder
                    }
                    className={`${inputBase} resize-none`}
                  />
                </>
              )}
              <p className="text-xs text-gray-500 mt-2 flex flex-wrap items-center gap-1.5">
                Gunakan <span className={chip}>{"{{nama}}"}</span>
                <span className={chip}>{"{{treatment}}"}</span>
                <span className={chip}>{"{{tanggal}}"}</span> untuk data
                otomatis.
              </p>
            </div>

            <button
              onClick={handleSave}
              disabled={isSubmitting}
              className="w-full py-3.5 rounded-xl bg-pink-500 text-white font-semibold hover:bg-pink-600 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Menyimpan..." : "Simpan Template"}
            </button>
          </div>
        </div>

        {/* Preview */}
        <div
          className="flex flex-col animate-slide-in-right"
          style={{ animationDelay: "0.2s" }}
        >
          <h3 className="text-sm font-bold text-gray-500 mb-4 px-2 flex items-center gap-2 uppercase tracking-wider">
            <Smartphone className="w-4 h-4" /> Preview Pesan
          </h3>
          <WaPreview
            text={previewText}
            images={images}
            className="flex-1 min-h-[350px] flex flex-col justify-center"
          />
        </div>
      </div>

      {/* Template Tersimpan */}
      <div
        className={`${cardBase} animate-slide-up`}
        style={{ animationDelay: "0.3s" }}
      >
        <h3 className="text-lg font-bold mb-5 flex items-center gap-2 text-gray-900 border-b border-gray-100 pb-4">
          <MessageSquare className="w-5 h-5 text-pink-500" />
          Template Tersimpan
        </h3>

        <div
          role="tablist"
          aria-label="Filter jenis template"
          className="flex flex-wrap gap-2 mb-6"
        >
          {filterChips.map((c) => {
            const active = slotFilter === c.id;
            return (
              <button
                key={c.id}
                role="tab"
                aria-selected={active}
                onClick={() => setSlotFilter(c.id)}
                className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
                  active
                    ? "bg-pink-500 text-white border-pink-500 shadow-sm"
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {c.label}{" "}
                <span className={active ? "text-pink-100" : "text-gray-400"}>
                  {counts[c.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {sections.length === 0 ? (
          <p className="text-sm text-gray-400 italic text-center py-8 border border-dashed rounded-xl border-gray-200">
            {templates.length === 0
              ? "Belum ada template tersimpan."
              : "Tidak ada template di kelompok ini."}
          </p>
        ) : (
          <div className="space-y-6">
            {sections.map((s) => (
              <div key={s.key}>
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 px-1">
                  {s.title}{" "}
                  <span className="text-gray-400 font-semibold">
                    ({s.items.length})
                  </span>
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {s.items.map((t) => (
                    <TemplateCard
                      key={t.id}
                      t={t}
                      onDelete={handleDelete}
                      onSetGroup={handleSetGroup}
                      onEdit={setEditingTemplate}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal Edit Template */}
      {editingTemplate && (
        <EditTemplateModal
          template={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={(updated) =>
            setTemplates((list) =>
              list.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)),
            )
          }
        />
      )}
    </div>
  );
};

// ==========================================
// 9. TAB: INBOX (tiket + foto pelanggan + catatan internal)
// ==========================================
const CATEGORY_META = {
  Order: { emoji: "🟢", badge: "bg-green-50 text-green-700 border-green-200" },
  Penawaran: {
    emoji: "🟡",
    badge: "bg-amber-50 text-amber-700 border-amber-200",
  },
  Batal: { emoji: "🔴", badge: "bg-red-50 text-red-700 border-red-200" },
  General: { emoji: "⚪", badge: "bg-gray-50 text-gray-600 border-gray-200" },
};
const TICKET_CATEGORIES = Object.keys(CATEGORY_META);
const INBOX_POLL_MS = 10000;

const formatDuration = (seconds) => {
  const m = Math.floor(Math.abs(seconds) / 60);
  if (m < 1) return "<1 mnt";
  if (m < 60) return `${m} mnt`;
  return `${Math.floor(m / 60)} j ${m % 60} mnt`;
};

const InboxTab = () => {
  const { templates, refreshTemplates, notify } = useContext(AppContext);
  const [tickets, setTickets] = useState([]);
  const [slaMinutes, setSlaMinutes] = useState(15);
  const [loaded, setLoaded] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState("Semua");
  const [replyTpl, setReplyTpl] = useState({}); // ticketId -> templateId
  const [sending, setSending] = useState({}); // ticketId -> true
  const [noteDraft, setNoteDraft] = useState({}); // customer_id -> teks yang sedang diketik
  const [noteOpen, setNoteOpen] = useState({}); // ticket id -> true
  const [noteSaving, setNoteSaving] = useState({});
  const loadFailedRef = useRef(false);

  const replyTemplates = useMemo(
    () => templates.filter((t) => t.type !== "auto_reply"),
    [templates],
  );
  const replyGroups = useMemo(() => {
    const groups = TPL_GROUPS.map((s) => ({
      key: s.id,
      label: `${s.emoji} ${s.label}`,
      items: replyTemplates.filter((t) => t.time_slot === s.id),
    }));
    groups.push({
      key: "none",
      label: "Lainnya",
      items: replyTemplates.filter((t) => !GROUP_BY_ID[t.time_slot]),
    });
    return groups.filter((g) => g.items.length > 0);
  }, [replyTemplates]);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/tickets/active");
      setTickets(data.tickets);
      setSlaMinutes(data.sla_minutes);
      setFetchedAt(Date.now());
      setNow(Date.now());
      setLoaded(true);
      loadFailedRef.current = false;
    } catch (err) {
      if (!loadFailedRef.current) {
        notify("error", `Gagal memuat Inbox: ${err.message}`);
        loadFailedRef.current = true;
      }
    }
  }, [notify]);

  useEffect(() => {
    refreshTemplates();
    load();
    const poll = setInterval(load, INBOX_POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 15000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, refreshTemplates]);

  // Lama menunggu = nilai server saat diambil + waktu berjalan di browser
  const elapsedSeconds = (t) =>
    t.elapsed_seconds + Math.max(0, now - fetchedAt) / 1000;
  const isBreached = (t) => elapsedSeconds(t) > slaMinutes * 60;

  const counts = useMemo(() => {
    const c = { Semua: tickets.length };
    TICKET_CATEGORIES.forEach((k) => {
      c[k] = tickets.filter((t) => t.category === k).length;
    });
    return c;
  }, [tickets]);

  const visible = useMemo(
    () =>
      filter === "Semua"
        ? tickets
        : tickets.filter((t) => t.category === filter),
    [tickets, filter],
  );
  const breachedCount = tickets.filter(isBreached).length;

  const handleCategory = async (ticket, category) => {
    const previous = ticket.category;
    if (category === previous) return;
    const patch = (value) =>
      setTickets((list) =>
        list.map((t) => (t.id === ticket.id ? { ...t, category: value } : t)),
      );
    patch(category);
    try {
      await api(`/api/tickets/${ticket.id}/category`, {
        method: "PUT",
        body: JSON.stringify({ category }),
      });
    } catch (err) {
      patch(previous);
      notify("error", `Gagal mengubah kategori: ${err.message}`);
    }
  };

  const handleSend = async (ticket) => {
    const templateId = replyTpl[ticket.id];
    if (!templateId) {
      notify("error", "Pilih template balasan dulu.");
      return;
    }
    setSending((s) => ({ ...s, [ticket.id]: true }));
    try {
      const r = await api("/api/messages/send-template", {
        method: "POST",
        body: JSON.stringify({
          ticket_id: ticket.id,
          template_id: Number(templateId),
        }),
      });
      setTickets((list) => list.filter((t) => t.id !== ticket.id));
      if (r.warning) notify("error", r.warning);
      else notify("success", "Balasan terkirim, tiket selesai.");
    } catch (err) {
      notify("error", `Gagal mengirim balasan: ${err.message}`);
    } finally {
      setSending((s) => ({ ...s, [ticket.id]: false }));
    }
  };

  const handleSaveNote = async (ticket) => {
    const text = noteDraft[ticket.customer_id];
    if (text === undefined) return;
    setNoteSaving((s) => ({ ...s, [ticket.id]: true }));
    try {
      const r = await api(`/api/customers/${ticket.customer_id}/note`, {
        method: "PUT",
        body: JSON.stringify({ note: text }),
      });
      setTickets((list) =>
        list.map((t) =>
          t.customer_id === ticket.customer_id
            ? { ...t, private_note: r.private_note }
            : t,
        ),
      );
      setNoteDraft((d) => {
        const next = { ...d };
        delete next[ticket.customer_id];
        return next;
      });
      notify("success", "Catatan tersimpan.");
    } catch (err) {
      notify("error", `Gagal menyimpan catatan: ${err.message}`);
    } finally {
      setNoteSaving((s) => ({ ...s, [ticket.id]: false }));
    }
  };

  const filterTabs = ["Semua", ...TICKET_CATEGORIES];

  return (
    <div className={`${cardBase} animate-slide-up p-4 sm:p-6`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 border-b border-gray-100 pb-4">
        <h2 className="text-lg font-bold flex items-center gap-2 text-gray-900">
          <Inbox className="w-5 h-5 text-pink-500" />
          Inbox Pesan Masuk
        </h2>
        <p className="text-sm text-gray-500">
          {counts.Semua} tiket menunggu
          {breachedCount > 0 && (
            <span className="ml-2 font-semibold text-red-600">
              · {breachedCount} melewati SLA {slaMinutes} menit
            </span>
          )}
        </p>
      </div>

      {/* Filter kategori */}
      <div
        role="tablist"
        className="flex flex-wrap gap-2 mb-5"
        aria-label="Filter kategori tiket"
      >
        {filterTabs.map((k) => {
          const active = filter === k;
          const label =
            k === "Semua" ? "Semua" : `${k} ${CATEGORY_META[k].emoji}`;
          return (
            <button
              key={k}
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(k)}
              className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
                active
                  ? "bg-pink-500 text-white border-pink-500 shadow-sm"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
            >
              {label}{" "}
              <span className={active ? "text-pink-100" : "text-gray-400"}>
                {counts[k]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Daftar tiket */}
      <div className="space-y-3" data-testid="ticket-list">
        {visible.map((t) => {
          const breached = isBreached(t);
          const elapsed = elapsedSeconds(t);
          const remaining = slaMinutes * 60 - elapsed;
          const meta = CATEGORY_META[t.category] || CATEGORY_META.General;
          const noteValue = noteDraft[t.customer_id] ?? t.private_note ?? "";
          const noteDirty =
            noteDraft[t.customer_id] !== undefined &&
            noteDraft[t.customer_id] !== (t.private_note ?? "");
          const showNote = noteOpen[t.id] || Boolean(t.private_note);

          return (
            <div
              key={t.id}
              data-testid={`ticket-${t.id}`}
              data-breached={breached}
              className={`rounded-2xl border p-4 transition-colors ${
                breached
                  ? "bg-red-50/70 border-red-300"
                  : "bg-white border-gray-200 hover:border-pink-300"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-gray-900 text-sm truncate">
                    {t.customer_name || "Tanpa nama"}
                    <span className="font-normal text-gray-400 mx-1.5">•</span>
                    <span className="font-medium text-gray-500">{t.phone}</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Pesan terakhir {formatDuration(elapsed)} lalu
                  </p>
                </div>

                {breached ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-red-600 text-white animate-pulse whitespace-nowrap">
                    ⏰ Terlambat {formatDuration(remaining)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-gray-50 text-gray-600 border border-gray-200 whitespace-nowrap">
                    <Clock className="w-3.5 h-3.5" /> SLA{" "}
                    {formatDuration(remaining)}
                  </span>
                )}
              </div>

              <p className="mt-3 text-sm text-gray-700 bg-white/70 border border-gray-100 rounded-xl px-3 py-2 whitespace-pre-wrap break-words line-clamp-3">
                {t.has_attachment && (
                  <span
                    title="Ada lampiran"
                    aria-label="Ada lampiran"
                    className="mr-1.5"
                  >
                    🖼️
                  </span>
                )}
                {t.last_message}
              </p>

              {/* Foto kiriman pelanggan (mis. struk transfer) */}
              {t.media_files?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.media_files.map((f) => (
                    <a
                      key={f}
                      href={inboxMediaSrc(f)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={inboxMediaSrc(f)}
                        alt="Lampiran pelanggan"
                        loading="lazy"
                        className="w-20 h-20 rounded-xl object-cover border border-gray-200 hover:border-pink-400 transition-colors"
                      />
                    </a>
                  ))}
                </div>
              )}

              {/* Catatan internal */}
              {showNote ? (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 p-2">
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={noteValue}
                    onChange={(e) =>
                      setNoteDraft((d) => ({
                        ...d,
                        [t.customer_id]: e.target.value,
                      }))
                    }
                    placeholder="📝 Catatan internal (tidak dikirim ke pelanggan), mis. Alergi krim"
                    className={`${inputBase} resize-none text-xs bg-white`}
                  />
                  {noteDirty && (
                    <div className="flex justify-end mt-2">
                      <button
                        onClick={() => handleSaveNote(t)}
                        disabled={noteSaving[t.id]}
                        className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 disabled:opacity-60 transition-colors"
                      >
                        {noteSaving[t.id] ? "Menyimpan..." : "Simpan catatan"}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setNoteOpen((s) => ({ ...s, [t.id]: true }))}
                  className="mt-3 text-xs font-semibold text-gray-500 hover:text-amber-700 hover:underline"
                >
                  ＋ Catatan internal
                </button>
              )}

              <div className="mt-3 grid grid-cols-1 md:grid-cols-[170px_1fr_auto] gap-2">
                <div className="relative">
                  <select
                    aria-label={`Kategori tiket ${t.id}`}
                    value={t.category}
                    onChange={(e) => handleCategory(t, e.target.value)}
                    className={`${inputBase} py-2.5 appearance-none cursor-pointer pr-9 font-semibold border ${meta.badge}`}
                  >
                    {TICKET_CATEGORIES.map((k) => (
                      <option key={k} value={k}>
                        {CATEGORY_META[k].emoji} {k}
                      </option>
                    ))}
                  </select>
                  <SelectChevron />
                </div>

                <div className="relative">
                  <select
                    aria-label={`Template balasan tiket ${t.id}`}
                    value={replyTpl[t.id] || ""}
                    onChange={(e) =>
                      setReplyTpl((s) => ({ ...s, [t.id]: e.target.value }))
                    }
                    className={`${inputBase} py-2.5 appearance-none cursor-pointer pr-9 bg-gray-50/50`}
                  >
                    <option value="">Pilih template balasan...</option>
                    {replyGroups.map((g) => (
                      <optgroup key={g.key} label={g.label}>
                        {g.items.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <SelectChevron />
                </div>

                <button
                  onClick={() => handleSend(t)}
                  disabled={sending[t.id]}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-pink-500 text-white text-sm font-semibold hover:bg-pink-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  {sending[t.id] ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Kirim
                </button>
              </div>
            </div>
          );
        })}

        {visible.length === 0 && (
          <p className="text-sm text-gray-400 italic text-center py-10 border border-dashed rounded-2xl border-gray-200">
            {!loaded
              ? "Memuat tiket..."
              : filter === "Semua"
                ? "Tidak ada tiket menunggu. Semua pesan sudah ditangani 🎉"
                : `Tidak ada tiket berkategori ${filter}.`}
          </p>
        )}
      </div>
    </div>
  );
};

// ==========================================
// 10. TAB: LABEL WHATSAPP BUSINESS
// ==========================================
const WA_LABEL_COLORS = [
  "#ff9485",
  "#64c4ff",
  "#ffd429",
  "#dfaef0",
  "#99b6c1",
  "#55ccb3",
  "#ff9dff",
  "#d3a91d",
  "#6d7cce",
  "#d7e752",
  "#00d0e3",
  "#ffc5c7",
  "#93ceac",
  "#f74848",
  "#00a0f2",
  "#83e422",
  "#ffaf04",
  "#b5ebff",
  "#9ba6ff",
  "#9368cf",
];
const waLabelColor = (i) => WA_LABEL_COLORS[i] || "#9ca3af";

const WaLabelsTab = () => {
  const { notify, addRecipients, setActiveTab } = useContext(AppContext);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(
    async (silent = false) => {
      try {
        const d = await api("/api/labels");
        setData(d);
        setSelectedId((prev) =>
          prev && d.labels.some((l) => l.id === prev)
            ? prev
            : (d.labels[0]?.id ?? null),
        );
      } catch (err) {
        if (!silent) notify("error", `Gagal memuat label: ${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 10000);
    return () => clearInterval(timer);
  }, [load]);

  const handleSync = async (full) => {
    setSyncing(true);
    try {
      const r = await api("/api/labels/sync", {
        method: "POST",
        body: JSON.stringify(full ? { full: true } : {}),
      });
      await load(true);
      if (!r.labels) {
        notify(
          "error",
          "WhatsApp belum mengirim data label. Pastikan nomor ini memakai WhatsApp Business dan sudah punya label, lalu coba Sync penuh.",
        );
      } else {
        notify(
          "success",
          `Sinkronisasi selesai: ${r.labels} label, ${r.contacts} kontak.`,
        );
      }
    } catch (err) {
      notify("error", `Gagal sinkronisasi: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const labels = data?.labels || [];
  const meta = data?.meta;
  const selected = labels.find((l) => l.id === selectedId) || null;

  const contacts = useMemo(() => {
    if (!selected) return [];
    const q = search.trim().toLowerCase();
    if (!q) return selected.contacts;
    return selected.contacts.filter(
      (c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.phone || "").includes(q.replace(/\D/g, "") || "\u0000"),
    );
  }, [selected, search]);

  const otherLabels = (c) =>
    (c.labels || "")
      .split(", ")
      .filter((n) => n && n !== selected?.name)
      .join(", ");

  // Kontak berlabel -> daftar penerima di "Buat Batch" (>100 dipecah otomatis di sana)
  const handleBroadcast = () => {
    if (!selected) return;
    const items = [];
    for (const c of selected.contacts) {
      const nomor = normalizePhone(c.phone); // @lid / nomor asing -> null -> dilewati
      if (nomor) {
        items.push({ nomor, nama: c.name || "Kak", treatment: "Treatment" });
      }
    }
    if (items.length === 0) {
      notify("error", "Tidak ada kontak bernomor valid di label ini.");
      return;
    }
    const { added, skippedLimit } = addRecipients(items);
    const skipped = selected.contacts.length - items.length;
    notify(
      skipped > 0 || skippedLimit > 0 ? "error" : "success",
      `${added} kontak dari label "${selected.name}" dimasukkan ke Buat Batch.` +
        (skipped > 0 ? ` ${skipped} dilewati (nomor tidak dikenali).` : "") +
        (skippedLimit > 0
          ? ` ${skippedLimit} melebihi batas ${MAX_RECIPIENTS}.`
          : ""),
    );
    setActiveTab("create");
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Sidebar daftar label */}
      <div className="lg:col-span-1">
        <div className={`${cardBase} lg:sticky lg:top-24`}>
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-gray-900 border-b border-gray-100 pb-4">
            <Tags className="w-5 h-5 text-pink-500" /> Label WhatsApp
          </h3>

          <button
            onClick={() => handleSync(false)}
            disabled={syncing}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-pink-500 text-white font-semibold hover:bg-pink-600 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Menyinkronkan..." : "Sync Label dari WA"}
          </button>
          <button
            onClick={() => handleSync(true)}
            disabled={syncing}
            title="Minta WhatsApp mengirim ulang seluruh data label dari awal"
            className="w-full mt-2 text-xs text-gray-400 hover:text-pink-600 disabled:opacity-60 transition-colors"
          >
            Sync penuh (kirim ulang semua)
          </button>

          {meta && (
            <p className="text-xs text-gray-400 mt-3 mb-4 text-center">
              {meta.totalLabels} label · {meta.totalContacts} kontak
              {meta.lastEventAt &&
                ` · data terakhir ${new Date(meta.lastEventAt).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}`}
            </p>
          )}

          <div className="space-y-2 max-h-72 lg:max-h-[55vh] overflow-y-auto pr-1">
            {loading && (
              <div className="flex justify-center py-6 text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            )}
            {!loading && labels.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-6 leading-relaxed">
                Belum ada label tersinkron.
                <br />
                Klik <b>Sync Label dari WA</b>. Label hanya ada di aplikasi
                WhatsApp Business.
              </p>
            )}
            {labels.map((l) => (
              <button
                key={l.id}
                onClick={() => {
                  setSelectedId(l.id);
                  setSearch("");
                }}
                aria-pressed={l.id === selectedId}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                  l.id === selectedId
                    ? "border-pink-300 bg-pink-50 shadow-sm"
                    : "border-gray-200 bg-white hover:border-pink-200"
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: waLabelColor(l.color) }}
                ></span>
                <span className="flex-1 text-sm font-semibold text-gray-800 truncate">
                  {l.name}
                </span>
                <span className="text-xs font-semibold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
                  {l.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Isi label terpilih */}
      <div className="lg:col-span-2">
        <div className={cardBase}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2 text-gray-900 min-w-0">
              {selected ? (
                <>
                  <span
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: waLabelColor(selected.color) }}
                  ></span>
                  <span className="truncate">{selected.name}</span>
                  <span className="text-sm font-medium text-gray-400 shrink-0">
                    {selected.count} kontak
                  </span>
                </>
              ) : (
                <>
                  <Users className="w-5 h-5 text-pink-500" /> Kontak
                </>
              )}
            </h3>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleBroadcast}
                disabled={!selected || selected.count === 0}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-pink-500 text-white text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 shadow-sm"
              >
                <Send className="w-4 h-4" /> Buat Batch dari Label Ini
              </button>
              <div className="relative w-full sm:w-64">
                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-gray-400">
                  <Search className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  placeholder="Cari nama atau nomor..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={!selected}
                  className={`${inputBase} pl-10 py-2.5 bg-gray-50`}
                />
              </div>
            </div>
          </div>

          {!selected ? (
            <p className="text-sm text-gray-400 text-center py-12">
              Pilih label di sebelah kiri untuk melihat kontaknya.
            </p>
          ) : contacts.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">
              {search
                ? "Tidak ada kontak yang cocok."
                : "Belum ada kontak di label ini."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[480px]">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
                    <th className="py-3 pr-3 font-semibold w-10">#</th>
                    <th className="py-3 pr-3 font-semibold">Nama</th>
                    <th className="py-3 pr-3 font-semibold">Nomor WA</th>
                    <th className="py-3 font-semibold">Label lain</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {contacts.map((c, i) => (
                    <tr key={c.jid} className="hover:bg-gray-50/70">
                      <td className="py-3 pr-3 text-sm text-gray-400">
                        {i + 1}
                      </td>
                      <td className="py-3 pr-3 text-sm font-semibold text-gray-800">
                        {c.name || (
                          <span className="font-normal text-gray-400">
                            (tanpa nama)
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-sm text-gray-600 whitespace-nowrap">
                        {c.phone ? (
                          `+${c.phone}`
                        ) : (
                          <span
                            className="text-gray-400"
                            title="WhatsApp menyembunyikan nomor kontak ini (ID internal)"
                          >
                            ID internal
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-sm text-gray-500">
                        {otherLabels(c) || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 11. MAIN APP COMPONENT
// ==========================================
const AppContent = () => {
  const { activeTab, setActiveTab } = useContext(AppContext);
  const [waModalOpen, setWaModalOpen] = useState(false);
  const closeWaModal = useCallback(() => setWaModalOpen(false), []);

  useInboxPing(); // bunyi notifikasi walau CS sedang di tab lain

  return (
    <div className="min-h-screen text-slate-700 font-sans selection:bg-pink-100 selection:text-pink-900 pb-20">
      <Navbar onOpenWa={() => setWaModalOpen(true)} />
      <Toast />

      <main className="max-w-6xl mx-auto px-4">
        {/* Navigasi (mobile) */}
        <div className="md:hidden flex overflow-x-auto hide-scrollbar space-x-2 mb-6 p-1 bg-white border border-gray-200 rounded-full w-full shadow-sm">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-pink-500 text-white shadow-sm"
                  : "text-gray-500"
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="animate-fade-in relative">
          {activeTab === "create" && <CreateBatchTab />}
          {activeTab === "queue" && <QueueTab />}
          {activeTab === "labels" && <LabelsTab />}
          {activeTab === "walabels" && <WaLabelsTab />}
          {activeTab === "inbox" && <InboxTab />}
          {activeTab === "templates" && <TemplatesTab />}
        </div>
      </main>

      {waModalOpen && <WaModal onClose={closeWaModal} />}
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
