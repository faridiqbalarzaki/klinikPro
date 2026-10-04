// Konfigurasi PM2: menyalakan server (sekaligus worker WhatsApp) otomatis,
// dan menyalakannya lagi jika crash atau komputer/server di-restart.
// Taruh di klinikpro-backend/ (sejajar dengan package.json).
module.exports = {
  apps: [
    {
      name: "klinikpro",
      script: "src/server.js",
      cwd: __dirname,

      // WAJIB satu proses: satu sesi WhatsApp tidak boleh dipakai dua proses sekaligus
      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      min_uptime: "10s", // dianggap sehat jika hidup > 10 detik
      max_restarts: 50,
      restart_delay: 5000, // jeda 5 detik sebelum dinyalakan ulang
      max_memory_restart: "600M",

      // Jangan pakai watch: folder auth_info_baileys & uploads berubah terus
      // dan akan memicu restart tanpa henti.
      watch: false,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
