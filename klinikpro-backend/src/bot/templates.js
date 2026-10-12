module.exports = {
  // ==========================================
  // 1. TEMPLATE BOT (AUTO-REPLY FUNNEL STAGE 0-4)
  // ==========================================
  botStages: {
    welcomeAds: `Halo Kak! Untuk memproses atau melihat detailnya, cukup klik iklannya 1 kali saja yaa 😊\n\nKalau diklik berkali-kali, biasanya sistem akan mendeteksi sebagai spam atau malah bikin halamannya jadi lambat terbuka 😔 Terima kasih banyak atas pengertiannya Kak! 🙏✨`,

    salam: `Halo, terimakasih ya kak sudah mengklik WA *Admin Lizel* Toko Resmi Fix Nutri D&N Cream 🌸✨\n\nApa nih *keluhan kakak cantik*? 😋\n\n1. Kulit susah putih?\n2. Warna kulit tidak merata?\n3. Muncul flek hitam dan bekas jerawat?\n4. Jerawat meradang?\n5. Kulit kering atau skin barrier terganggu\n6. Ingin kulit tampak lebih sehat,lembap dan glowing\n\nBisa langsung konsultasikan keluhannya ke Lizel ya,aku bantu rekomendasikan produk yang paling sesuai dengan kondisi kulit kakak 🌸🥰`,

    kecamatan: `Btw Kakak sayang, bisa dibantu dengan menyebutkan *Kecamatan* lokasinya? Biar Lizel bisa sekalian cek estimasi di sistem kita 🥰`,

    harga_katalog: `💖 HARGA PROMO FIX NUTRI GLOW SERIES HARI INI:\n\n1️⃣  PAKET LENGKAP D&N CREAM +COLLAGEN SOAP\n      🛍️1 DAY CREAM + 1 NIGHT CREAM + 1 SOAP = RP 550.000 Menjadi RP 349.000+ GRATIS ONGKIR\n\n2️⃣ PAKET DAY&NIGHT PREMIUM SKINCARE FIX NUTRI CREAM\n       🛍️1 DAY CREAM + 1 NIGHT CREAM = RP 389.000 Menjadi Rp 250.000 (BELUM ONGKIR)\n\n3️⃣  COLLAGEN BEAUTY SOAP FIX NUTRI\n       🛍️  3 COLLAGEN BEAUTY SOAP\nRp 300.000 Menjadi RP 279.000 + GRATIS ONGKIR\n\n🚛 BISA COD SELURUH INDONESIA\n100% PRODUK ORIGINAL DISTRIBUTOR RESMI`,

    harga_tanya: `Nah, biar kulitnya cepat glowing, Kaka mau coba PAKET PREMIUM D&N CREAM atau langsung ambil PAKET LENGKAP D&N CREAM+FACIAL WASH nya nih kak say? 😍 \n\nSaran Lizel sih mending ambil yang paket lengkap kk, harganya jauh lebih hemat + GRATIS ONGKIR. Terus ada Sabun Collagen yg bisa dipakai ke seluruh tubuh juga. Jadi nggak cuma wajah nih yang Glowing dan Cerah, tapi kulit badan juga ikut sehat 🥰`,

    isiform: `Masyaallah boleh banget Kak pilihan yang tepat! 😍\nUntuk lanjut pemesanan, Kakak bisa langsung isi alamat lengkap di bawah ini ya kak untuk proses pengiriman 🚚🥰`,

    formatOrder: `FORMAT ORDER FIX NUTRI CREAM\n\nNama : \nTelp : \nKecamatan/Kabupaten : \nAlamat Lengkap (RT&RW, dan ancer ancer) : \nToko : Lizel FIX Nutri D&N Store\nMetode pembayaran (COD/TRANSFER) : \n\nOrderan :`,
  },

  // ==========================================
  // 2. SENJATA CS (SLASH COMMANDS)
  // ==========================================
  csCommands: {
    // --- HANDLING MARKETPLACE & USIA ---
    shopee: `❌STOP BELI FIX Nutri D&N CREAM PALSU❌\n\nSudah banyak banget nih kak yang tertipu beli di marketplace seperti Shopee, TikTok, Lazada. Kebanyakan customer tergiur harga murah, tapi ternyata tidak ada hasil bahkan bisa membahayakan kulit wajah 😭\n\nYuk beli produk yang sudah terjamin original lewat konsultasi resmi di sini 🥰`,
    usia50: `Bisa dan sangat cocok, Bunda! 🌸✨\nRangkaian FIX Nutri D&N Cream ini justru sangat direkomendasikan untuk usia 50 tahun ke atas.\n\nAsal digunakan rutin sesuai anjuran, pasti bisa kelihatan hasilnya ya bunda sayang 🥰`,

    // --- MENGATASI PENOLAKAN (OBJECTION HANDLING) ---
    paksu: `Wah bagus Kak, memang enaknya didiskusikan dulu sama suami 🥰🤭 Biar gampang jelasinnya, kalau keluhan teratasi otomatis kan Kakak makin cantik, glowing dan awet muda, pasti Paksu juga ikut seneng dong kak 🥰\n\nJadi jangan ditunda terlalu lama untuk merawat wajah cantiknya ya.\n*Mumpung gratis ongkir juga, mau ambil paket lengkap kak say via COD? 🥰*`,

    // PERBAIKAN: Dibuat lebih soft-selling, tidak menyindir "barang murah"
    mahal: `Itu sudah harga rata-rata ya kak, karena ini sudah harga diskon jadi jatuhnya sangat hemat kalau dibanding dengan manfaat yang Kakak dapatkan. Kakak bisa buktikan sendiri khasiatnya 🙏😊\n\nDaripada coba-coba yang belum pasti, Fix Nutri ini lebih terjamin kualitasnya Kak. Mau Lizel bantu proses promonya sekarang? 🥰`,

    nanti: `*Mau coba paket yang no berapa kaka?*🤗\nKalau boleh tau, nanti dulu nya kenapa nih kak say? Karna stock promo kita terbatas dan promo nya berlaku di hari ini saja kak. Besok/lusa harga kembali normal, jadi jauh lebih mahal lagi kalau kk order besok 🙏😊`,
    ragu: `Tidak apa-apa kak, wajar kok kalau masih ragu, silakan tanya apa saja ke Lizel ya. 😊\n\nKalau untuk hasil, proses setiap orang memang bisa berbeda-beda, tergantung kondisi kulit, jenis flek, dan seberapa rutin pemakaiannya. Kuncinya sabar dan telaten ya Kak, karena kita BPOM jadi prosesnya aman dan tidak instan berbahaya.`,
    mengulur: `Sayang banget lho kak kalau mengulur waktu untuk pikir-pikir, takutnya kalau tidak segera di atasi malah makin mengganggu kesehatan skin barrier kaka nih 🥺`,

    // --- EDUKASI & FAQ PRODUK ---
    distri: `Yang asli hanya di produksi oleh *PT BOTRYO HERBA BIOTEKNOLOGI* yang beralamat di Tawangsari jawa tenggah, dan tertera nomer BPOM ya kak sayang😘\nSerta di belakang box ada barcode BPOM dan hanya di distribusikan oleh *PT SASTRO DIGITAL ASIA* 😘`,
    bpom: `Sudah BPOM dan halal yah kak, tanpa efek samping karena takaran sesuai anjuran BPOM \n- Day cream ✔️ BPOM RI NA 18260107073\n- Night Cream ✔️ BPOM RI NA 18260107075\n- Collagen Beauty Soap ✔️ BPOM RI NA 18260500504`,
    busui: `Sangat aman ya kak untuk busui, karena FIX Nutri Glow Perfect series ini sudah teruji klinis BPOM dan sudah ada hasil uji lab nya 🥰\nJadi kandungan aktifnya tidak akan berpengaruh ke baby ya kak 😍`,
    efek: `Umumnya sangat aman ya Kak & tidak ada efek samping yang berbahaya ✅\n\nFix Nutri D&N CREAM tidak menimbulkan ketergantungan ya kak, karena kita murni terbebas dari senyawa berbahaya seperti _Merkuri dan Steroid_ 🥰✅`,
    permanen: `Fix Nutri Cream ini *tidak mengakibatkan ketergantungan dan hasilnya permanen* ya kak say 🤗😘\n\nJadi kalau misal pemakaian pertama Kakak sudah dapat hasil yang diinginkan, kakak boleh banget kalau mau berhenti memakai Fix Nutri creamnya ya kak 🤗🤗`,
    perubahan: `Setiap perubahan dan daya serap kulit orang pasti berbeda-beda yaa kak. Ada yang cepat meresap, ada juga yang butuh waktu, apalagi kalau kondisi masalah kulitnya cukup membandel.\n\nKuncinya konsisten dan nggak gampang menyerah kak 🥰 Atau kaka mau coba 1 paket lagi biar bisa melihat hasilnya secara lebih maksimal? 😊🙏🏻`,
    pouch: `Lizel bantu jelasin ya kaka sayy\n\nSebagian besar produk skincare berkualitas tidak menggunakan kemasan kantong fleksibel (pouch) karena bahan aktif di dalamnya sangat sensitif terhadap udara, cahaya, dan bakteri. Rangkaian Fix Nutri ini dipilih kemasannya untuk menjaga stabilitas formula agar tidak mudah rusak dan tetap higienis ya kaka say 🥰\n\n*Jadi produk dijamin tetap aman dan tersegel walaupun tidak menggunakan pouch* ✅✅`,
    detoks: `Baik kakak sebelumnya Lizel bantu jelaskan ya, itu merupakan proses detoksifikasi ya kak. Gunanya sangat bagus untuk mengangkat sel kulit mati, membersihkan lapisan luar kulit dari penumpukan kotoran, dan memperbaiki skin barrier perlahan-lahan 🙏🏻🥰`,

    // --- LOGISTIK, COD, & KEEP ORDER ---
    ekspedisi: `Untuk pengiriman, Lizel bekerjasama dengan Ekspedisi:\n✅ JNT EXPRESS\n✅ JNE EXPRESS\n✅ ID EXPRESS\n✅ SAP EXPRESS\n✅ LION PARCEL\n\nDari pilihan di atas, Kakak biasanya lebih nyaman pakai Ekspedisi apa nih kalau belanja online?`,
    estimasi: `Estimasi pengiriman\n\nUntuk ke Luar Jawa\nEstimasi 6-7 harian\n\nUntuk ke Pulau Jawa - Bali\nEstimasi 3-5 harian`,
    gudang: `Untuk pengiriman, Lizel kirim dari 3 titik gudang yah Kak: Bandung, Malang dan Lombok ✅\n\nNanti otomatis Lizel kirim dari gudang yang posisinya paling dekat dengan alamat Kakak biar cepat sampai 🥰`,
    keep: `Oh iya, kalau kakak kebetulan belum siap dananya hari ini, Kakak juga bisa *keep orderan* kok! Nanti dikirim sesuai hari/tanggal permintaan kakak. Caranya cukup isi alamat lengkap di bawah ini biar kakak tetap aman kebagian harga promonya hari ini 🥰🥰😍`,
    kalo: `Kalo kaka order sekarang, barangnya kan gak langsung sampai besok pagi kok kak ☺️\n\nJadi butuh estimasi perjalanan karena dikirim dari gudang. Nah, Kakak bisa nunggu barang datang sambil ngumpulin uangnya, soalnya kita kan bisa via COD 🥰\n\nLumayan banget order skrg bisa mengamankan promo dan keuntungannya kak!`,
    cod: `Ketentuan COD :\n\n1. Barang yang sudah dipesan TIDAK BISA DIBATALKAN\n2. Barang boleh dikembalikan dan akan diganti jika tidak sesuai dan ada kerusakan (syarat cantumkan video unboxing paket)\n3. No HP mohon selalu aktif untuk memudahkan kurir mengabari bapak/ibu\n\nPesanannya Lizel proses yaa kak, tinggal ditunggu saja paket cantiknya sampai.\n\nNOTE: Simpan yaa kak nomer WA ini 😊 Dan minta tolong kalau kurirnya hubungi Kaka, mohon direspon dan diterima ya paketnya 🤗 Terima kasih banyak Kak, semoga rezekinya selalu lancar dan diberi kesehatan 🙏 aminn~`,

    // --- FOLLOW UP, TESTI, & GHOSTING ---
    read: `Jadi gimana kakak cantik? Kok pesannya cuma di baca saja 😔\nKalau ada yang kurang jelas Kak, sampaikan aja biar Lizel jelaskan ya.\n\nMohon dibalas ya kak 🙏 seperti saya tadi merespon chat kakak ☺️🥰`,
    tanya: `Hallo kak cantik, maaf ganggu waktunya sebentar ya 🥰 Kakak sempat tanya Fix Nutri Cream nih sebelumnya, kira-kira keluhan kulit kakak apa nih?\nBiarkan aku bantu untuk kasih saran yang paling pas untuk merawat kulit kakak 💖✨`,
    sisapromo: `*PROMO SISA HARI INI SAJA YA KAK 😍*\n\nPromonya super terbatas loh kak, kalo kaka ambil di lain hari harganya dipastikan udah kembali normal. Sayang banget nih kak promo besar ini kalau ga diambil 😋\n\n*Kita juga melayani COD bayar ditempat ya kak 💕*\n\nMasa buat kebaikan kulit sendiri masih mikir-mikir sih kak? Yuk buruan amankan promo nya hari ini 😍`,
    bukti: `✨ Ini contoh bukti paket customer Lizel yang sudah sampai dengan aman ya kak 📦💖\nTenang saja kak, semua barang yang kami kirim 100% ORIGINAL dan pastinya dipacking sesuai dengan pesanan kakak! 💯✨\n\n*Lizel sangat mengutamakan amanah ya kak. Barang yang dikirim pasti ori 😍\n\n100% Original & BPOM\nBarang yang di kirim adalah produksi stock terbaru (masa expired lama) 😍✅`,
    testihasil: `Ini bukti real testi pelanggan aku nih kak yang udah kelihatan hasil nya 🥰\n\nMakin cerah, sehat, glowing, dan fleknya juga sudah mulai memudar dengan pakai fix nutri glow perfect set secara rutin 😍\n\nJangan ragu lagi ya kak buat cobain, yuk order sekarang agar keluhannya segera teratasi dan glowing nyusul yang lain 🤗\n\nMau langsung coba paket bundlingnya hari ini kak? 🥰🤗`,
    bestseller: `Dijamin 💯 kak, Fix Nutri D&N cream memang diformulasikan khusus untuk mengatasi keluhan di wajah kaka ya..\nTerbukti 💯 karena kandungan Niacinamide & Symwhite 377 nya juga tinggi, jadi proses perbaikannya bisa lebih maksimal 🥰😁✨\n\nMau cobain si Best Seller Paket Lengkap dari Fix Nutri D&N cream nya kak? 🥰`,
    member: `Oh iya, spesial hari ini nanti aku jadikan member juga khusus buat kaka 🥰😍\n\nBenefit member card:\nSetiap kakak mau *repeat order* nanti, kakak akan tetap dapat *HARGA AWAL BELI PROMO* dari kami meskipun harga normalnya sudah naik. Plus, gratis unlimited konsultasi sampai kakak dapat hasil yang diinginkan 🥰`,
    stuck: `Halo kak sayy 😍🌸\n\nDengan produk berkualitas dan sudah terjamin aman, formulanya langsung menyerap ke kulit wajah buat perbaikan secara berkala.\n\nBisa COD, bisa transfer & free daftar member resmi 💳 100% loh kaka say 🥰🌸\n\nBisa Lizel lanjutkan sesi konsultasinya ya kak? 🤗`,

    // --- CLOSING & PASCA-ORDER ---
    konfirmasi: `Lizel konfirmasi ulang untuk pesanan kakak ya: Paket Lengkap 🥰✅\n\n*Total : Rp 349.000*\n1 Day Cream + 1 Night Cream + 1 Collagen Soap\nMetode: COD ✅`,
    terimakasih: `Terima kasih banyak ya kak pesanannya!\nSemoga lekas mendapat hasil yang maksimal dan makin glowing 🤗😍\nJangan lupa kabari Lizel kalau paketnya sudah mendarat dengan aman ya 🙏🙏`,
    bukapaket: `Satu lagi pesan Lizel kak, nanti kalau paketnya sudah datang kaka tolong *videokan* saat awal membuka paket sampai akhir tanpa jeda ya, supaya aman kalau misalnya mau klaim garansi 🥰🫶`,
    paketsampai: `Alhamdulillah 🥰🥰\nTerima kasih banyak sudah konfirmasi ke *Lizel* ☺️🙏\nJangan lupa dipakai secara rutin ya kakak sayang biar hasilnya mantap 😘`,
    proses: `Baik kak, Lizel langsung bantu siapkan proses pengiriman barangnya hari ini ya kak. \nMohon ditunggu resinya ☺️ \n\nSimpan nomor aku ini ya kak, buat next order atau kalau mau jadi reseller bisa chat ke sini lagi 🥰\n\nFree konsultasi kok ka, jadi selama pemakaian santai aja kalau mau konsultasi terus sama Lizel 😘🙏`,
    carapakai: `🌸 CARA PEMAKAIAN FIX NUTRI COLLAGEN BEAUTY SOAP 🌸\n\nnote : Simpan produk di tempat sejuk dan kering, terhindar dari sinar matahari langsung ya kak.\n\nBerikut cara pemakaiannya:\n1. Cuci wajah hingga bersih\n2. Gunakan Facial Wash / Fix Nutri Collagen beauty soap 😍🫧\n3. Keringkan wajah dengan menepuk lembut menggunakan tissue bersih \n\nNext ⬇️\n\nPenggunaan Day Cream (Pagi/Siang) ☀️✅\n\n1. Setelah membersihkan wajah dengan sabun\n2. Ambil Day Cream secukupnya\n3. Oleskan secara merata pada wajah dan leher. (Tidak perlu tambah sunscreen lagi karena day cream ini sudah ada kandungan SPF 50 +++ lho kak!)\n4. Tunggu hingga meresap sekitar 2 menit, baru boleh ditimpa dengan bedak atau make up ringan lainnya 🌸😍\n\nNext⬇️\n\nPenggunaan Night Cream (Malam) 🌙⬇️\n\n1. Bersihkan wajah sebelum bersiap tidur\n2. Gunakan toner/serum pelengkap (jika ada)\n3. Oleskan night cream secara tipis dan merata pada wajah dan leher\n4. Tepuk perlahan hingga meresap\n5. Hindari penggunaan cream di area sensitif/lipatan wajah seperti: sudut bibir atau sudut hidung ya kak.`,
  },

  // ==========================================
  // 3. TAMBAHAN: TEMPLATE PRICE FLOW & AUTO GREETING
  // ==========================================
  priceFlow: {
    askComplaint: `Hallo kakak cantik 🥰 Sebelum kita bahas harganya, boleh dikonsultasikan dulu yaah keluhan kulitnya apa? Biar Lizel bisa bantu kasih saran perawatan yang paling pas buat kakak 💖✨`,

    // PERBAIKAN: Bridging empati yang luwes
    step1Solusi: `Siap Kak! Untuk keluhan seperti itu butuh perawatan khusus, sini Lizel bantu berikan solusinya yaa kak say 🤗`,

    step2Product: `✨ PAKET GLOWING 12 HARI - FIX NUTRI D&N CREAM ✨\n\nPaket lengkap 3 rangkaian perawatan:\n\n☀️ Day Cream - membantu mencerahkan kulit dan melindungi kulit saat beraktivitas\n🌙 Night Cream - membantu menyamarkan flek dan noda hitam saat kulit beristirahat di malam hari\n🧼 Collagen Beauty Soap - membersihkan lembut dan membantu menjaga kelembapan kulit\n\n💖 Manfaat yang bisa Kakak rasakan:\n• Mencerahkan kulit wajah\n• Menyamarkan flek dan noda hitam\n• Membantu menjaga skin barrier\n• Kulit tampak lebih lembap, halus, dan glowing merata\n\nGunakan rutin sesuai aturan pakai ya Kak 🤍`,

    // PERBAIKAN: Bridging tanya kecamatan dibuat natural
    step3Testi: `✨ FIX NUTRI GLOW SERIES ✨\n\n🤍 Produk ini tidak mengandung merkuri maupun steroid, sehingga sangat aman digunakan sesuai aturan pakai dan tidak menyebabkan ketergantungan.\n\n✅ Sudah terdaftar BPOM\n✅ Bersertifikat Halal\n✅ Sangat cocok digunakan untuk perawatan kulit sehari-hari\n\nBtw Kak, untuk mempermudah Lizel mengecek promo bebas ongkir hari ini, saat ini Kakak berdomisili di Kecamatan mana nih? Biar langsung Lizel cek estimasi paketnya 📦💖`,
  },

  autoGreeting: `Halo Kak! Terima kasih sudah menghubungi Lizel kembali 🥰 Ada yang bisa Lizel bantu hari ini? (Mau konsultasi lanjutan tentang pemakaian atau mau repeat order paketnya nih Kak?) 📦✨`,
};
