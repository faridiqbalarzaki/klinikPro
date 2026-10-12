module.exports = {
  // ==========================================
  // 1. TEMPLATE BOT (AUTO-REPLY FUNNEL STAGE 0-4)
  // ==========================================
  botStages: {
    welcomeAds: `Halo Kak! Untuk memproses atau melihat detailnya, cukup klik iklannya 1 kali saja yaa 😊\n\nKalau diklik berkali-kali, biasanya sistem akan mendeteksi sebagai spam atau malah bikin halamannya jadi lambat terbuka 😔 Terima kasih banyak atas pengertiannya Kak! 🙏✨`,

    salam: `Halo, terimakasih ya kak sudah mengklik WA *Admin Lizel* Toko Resmi Fix Nutri D&N Cream 🌸✨\n\nApa nih *keluhan kakak cantik*? 😋\n\n1. Kulit susah putih?\n2. Warna kulit tidak merata?\n3. Muncul flek hitam dan bekas jerawat?\n4. Jerawat meradang?\n5. Kulit kering atau skin barrier terganggu\n6. Ingin kulit tampak lebih sehat,lembap dan glowing\n\nBisa langsung konsultasikan keluhannya ke Lizel ya,aku bantu rekomendasikan produk yang paling sesuai dengan kondisi kulit kakak 🌸🥰`,

    kecamatan: `Bisa dibantu dengan menyebutkan *Kecamatan* ya Kakak sayang, karena lizel bisa cek di sistem itu dari Kecamatan🥰`,

    harga_katalog: `💖 HARGA PROMO FIX NUTRI GLOW SERIES HARI INI:\n\n1️⃣  PAKET LENGKAP D&N CREAM +COLLAGEN SOAP\n      🛍️1 DAY CREAM + 1 NIGHT CREAM + 1 SOAP = RP 550.000 Menjadi RP 349.000+ GRATIS ONGKIR\n\n2️⃣ PAKET DAY&NIGHT PREMIUM SKINCARE FIX NUTRI CREAM\n       🛍️1 DAY CREAM + 1 NIGHT CREAM = RP 389.000 Menjadi Rp 250.000 (BELUM ONGKIR)\n\n3️⃣  COLLAGEN BEAUTY SOAP FIX NUTRI\n       🛍️  3 COLLAGEN BEAUTY SOAP\nRp 300.000 Menjadi RP 279.000 + GRATIS ONGKIR\n\n🚛 BISA COD SELURUH INDONESIA\n100% PRODUK ORIGINAL DISTRIBUTOR RESMI`,

    harga_tanya: `Kaka mau coba PAKET PREMIUM D&N CREAM atau langsung PAKET LENGKAP D&N CREAM+FACIAL WASH nya kak?😍 , Saran Lizel ambil yang paket lengkap kk, harga lebih hemat GRATIS ONGKIR , ada Sabun Collagen yg bisa dipakai seluruh tubuh, Jadi tidak hanya wajah nih yang Glowing dan Cerah, tapi kulit seluruh tubuh juga ikut cerah🥰`,

    isiform: `Masyaallah boleh banget Kak,\nUntuk pemesanan Kakak bisa langsung isi alamat lengkap ya kak untuk melakukan pengiriman🚚🥰`,

    formatOrder: `FORMAT ORDER FIX NUTRI CREAM\n\nNama : \nTelp : \nKecamatan/Kabupaten : \nAlamat Lengkap (RT&RW, dan ancer ancer) : \nToko : Lizel FIX Nutri D&N Store\nMetode pembayaran (COD/TRANSFER) : \n\nOrderan :`,
  },

  // ==========================================
  // 2. SENJATA CS (SLASH COMMANDS)
  // ==========================================
  csCommands: {
    // --- HANDLING MARKETPLACE & USIA ---
    shopee: `❌STOP BELI FIX Nutri D&N CREAM PALSU❌\n\nSudah banyak banget nih kak yang sudah tertipu beli di marketplace seperti shopee Tik Tok,Lazada, kebanyakan customer tergiur harga murah dan membelinya,Tidak ada hasil bahkan akan menimbulkan bahaya pada kulit wajah\n\nYuk beli produk yang sudah terjamin original dan melalui konsultasi terlebih dahulu🥰`,
    usia50: `Bisa dan sangat cocok, Bunda! 🌸✨\nRangkaian FIX Nutri D&N Cream ini justru sangat direkomendasikan untuk usia 50 tahun ke atas\n\nAsal digunakan sesuai anjuran dan rutin pasti bisa ya bunda sayang`,

    // --- MENGATASI PENOLAKAN (OBJECTION HANDLING) ---
    paksu: `Kalau semisalnya Kulit kaka jauh lebih sehat dan cerah, Keluhan teratasi otomatis kan juga buat Paksu nih kak wajah terlihat cerah, glowing dan awet muda ya🥰🤭, \njadi Gak ada salahnya nyenengin hati suami yah, jangan terlalu lama untuk mengatasi keluhan kulit wajah di kakak nya\n\n*mumpung gratis ongkir juga ambil paket lengkap kak say dengan via COD🥰?*`,
    mahal: `Itu sudah harga rata-rata ya kak itu sudah diskon jadi itu tidak mahal kak soalnya juga sesuai dengan manfaatnya Kakak bisa buktikan sendiri,\nbiasanya barang murah itu kadang tidak asli atau tidak ada manfaatnya sama sekali Kak🙏🏻😊`,
    nanti: `*Mau coba paket yang no berapa kaka?*🤗\nNanti dulu nya kenapa nih kak say ? Karna stock promo kita terbatas dan promo nya berlaku di hari ini saja kak. Besok/lusa harga kembali normal, jadi jauh lebih mahal lagi kalau kk order besok" 🙏😊`,
    ragu: `Tidak apa-apa kak, silakan tanya apa saja ya. 😊\n\nKalau untuk hasil, setiap orang memang prosesnya bisa berbeda-beda, tergantung kondisi kulit, jenis flek, dan pemakaian yang rutin. Jadi kami tidak bisa menjamin hasil yang instan atau 100sama pada semua orang.`,
    mengulur: `Jangan mengulur waktu untuk pikir2 kak, jika tidak segera di atasi akan menggangu kesehatan skin barrier kaka nih`,

    // --- EDUKASI & FAQ PRODUK ---
    distri: `Yang asli hanya di produksi oleh *PT BOTRYO HERBA BIOTEKNOLOGI* yang beralamat di Tawangsari jawa tenggah, dan tertera nomer BPOM ya kak sayang😘\nSerta di belakang box ada barcode BPOM dan hanya di distribusikan oleh *PT SASTRO DIGITAL ASIA* 😘`,
    bpom: `sudah Bpom dan halal yah kak, tanpa efek samping takaran sesuai anjuran Bpom \n- Day cream ✔️ BPOM RI NA 18260107073\n- Night Cream ✔️ BPOM RI NA 18260107075\n- Collagen Beauty Soap ✔️ BPOM RI NA 18260500504`,
    busui: `Sangat aman ya kak untuk busui , karena FIX Nutri Glow Perfect series ini sudah teruji klinis BPOM dan sudah ada hasil uji lab nya🥰\nJadi tidak akan berpengaruh ke baby ya kak😍`,
    efek: `Umumnya aman ya Kak & dan tidak ada efek samping yang berlebihan ✅\n\nfix nutri D&N CREAM tidak menimbulkan ketergantungan ya kak karena tidak mengandung senyawa berbahaya seperti _Merkuri dan Steroid_ yang dapat menimbulkan ketergantungan🥰✅`,
    permanen: `Fix Nutri Cream ini *tidak mengakibatkan ketergantungan dan hasilnya permanen* ya kak say🤗😘\n\nJadi setelah pembelian pertama kalo kaka sudah dapat hasil, kakak boleh berhenti memakai Fix Nutri creamnya ya kak🤗🤗`,
    perubahan: `Setiap perubahan dan daya serap kulit orang pasti berbeda" yaa kak, ada yang cepat dan ada juga yang lambat. Dan juga untuk kondisi kulit yang berbeda ada yang membandel. Jadi kemungkinan di kaka agak lama jadi perlu membutuhkan waktu agak lama juga agar bisa mendapat hasil yg maksimal,\n\nKuncinya konsisten dan nggak gampang menyerah kak 🥰 atau kaka mau coba 1 paket lagi biar bisa melihat hasilnya secara signifikan?😊🙏🏻`,
    pouch: `Lizel bantu jelasin ya kaka sayy\n\nSebagian besar produk perawatan kulit atau skincare tidak menggunakan kemasan kantong fleksibel (pouch) karena bahan aktif di dalamnya sangat sensitif terhadap udara, cahaya, dan kontaminasi bakteri. Rangkaian dari Fix Nutri ini dipilih untuk menjaga stabilitas formula agar tidak mudah rusak dan tetap higienis ya kaka say🥰\n\n*jadi produk tetap aman dan tersagell walaupun tidak menggunakan pouch*✅✅`,
    detoks: `Baik kakak sebelumnya Lizel bantu jelaskan ya, itu merupakan proses detoksifikasi ya kak yang berguna untuk mengangkat sel kulit mati, membersihkan lapisan luar kulit secara intensif dari penumpukan kotoran dan memperbaiki skin barrier🙏🏻🥰`,

    // --- LOGISTIK, COD, & KEEP ORDER ---
    ekspedisi: `Lizel bekerjasama dengan Ekspedisi:\n✅ JNT EXPRESS\n✅ JNE EXPRESS\n✅ ID EXPRESS\n✅ SAP EXPRESS\n✅ LION PARCEL\n\nDari di atas itu biasa pakai Ekspedisi apa kak say kalau pesan paket online?`,
    estimasi: `Estimasi pengiriman\n\nUntuk ke Luar Jawa\nEstimasi 6-7 harian\n\nUntuk ke Pulau Jawa - Bali\nEstimasi 3-5 harian`,
    gudang: `Lizel pengiriman dari 3 gudang yah,, Bandung, Malang dan Lombok✅\n\nNanti Lizel kirim dari gudang yang terdekat yah🥰`,
    keep: `Kalau kakak belum ada uang\nKakak juga bisa keep orderan untuk dikirim sesuai hari tanggal permintaan kakak loh dengan cara isi alamat lengkap di bawah ini biar kakak tetap kebagian harga promonya ya🥰🥰😍`,
    kalo: `Kalo kaka order sekarang, barangnya gak langsung sampai besok pagi kok kak ☺️\n\nJd butuh estimasi, karna kami juga kirim dri bandung\nJd bisa sambil nunggu barang datang sambil ngumpulin uangnya kak, karna kan bisa COD 🥰\n\nLumayan order skrg dapat banyak promo dan keuntungannya kak`,
    cod: `Ketentuan COD :\n\n1. Barang yang sudah dipesan TIDAK BISA DIBATALKAN\n2. Barang boleh dikembalikan dan akan diganti jika tidak sesuai dan ada kerusakan ( syarat cantumkan video unboxing paket )\n3. No HP mohon selalu aktif untuk memudahkan kurir mengirim pesan bapak/ibu\n\nPesanannya kami proses yaa  kak, tinggal ditunggu saja paketnya.\n\nNOTE : Simpan yaa kak nomer RISA ini 😊 dan minta tolong kalo kurir chat Kaka atau menghubungi Kaka, mohon untuk di terima ya paketnya🤗 jangan di tolak yaa Kaka, terimakasih, semoga rezekinya lancar dan di beri kesehatan 🙏aminn-`,

    // --- FOLLOW UP, TESTI, & GHOSTING ---
    read: `Jadi gimana kakak? Kok cuma di baca saja 😔\nAda yang kurang jelas Kak? Biar saya jelaskan\n\nMohon di balas ya kak🙏 seperti saya tadi balas chat kakak ☺️🥰`,
    tanya: `"Hallo kak cantik, maaf ganggu ya 🥰 kakak sempat tanya Fix Nutri Cream kira-kira keluhan kakak apa nih?\nBiarkan aku bantu untuk kasih saran yang paling cocok untuk kakak 💖✨"`,
    sisapromo: `*PROMO SISA HARI INI SAJA YA KAK 😍*\n\nPromo terbatas loh kak, kalo kaka ambil di lain hari harga udah kembali normal ya kaka, jadi sayang banget nih kak promo ga diambil😋\n\n*Kita juga bisa cod bayar ditempat ya💕*\n\nMasa buat badan sendiri jadi lebih bagus masih pikir pikir sih kak? Yuk buruan ambil promo nya kak 😍`,
    bukti: `✨ ini bukti paket customer Lizel yang sudah sampai ya kak 📦💖\nTenang saja kak, semua barang yang kami kirim 100% ORIGINAL dan pastinya sesuai dengan pesanan kakak ya! 💯✨\n*Lizel Sangat amanah ya kak,, Barang yang dikirim sesuai dengan yang di order kaka cantik😍\n\n100% Original & BPOM\nBarang yang di kirim adalah stock terbaru (masa expired lama)😍✅`,
    testihasil: `Bukti real testi pelanggan aku nih kak udah terlihat hasil nya 🥰\n\nMakin cerah, sehat, glowing, fleknya sudah memudar juga yah kak dengan menggunakan fix nutri glow perfect set hanya dalam pemakaian 7 hari  😍\n\nJangan ragu lagi ya kak cobain, yuk order sekarang agar keluhan nya segera teratasi dan glowing seperti yang lain🤗\n\nmau coba paket bundlingnya kak?🥰🤗`,
    bestseller: `Dijamin 💯 kak Fix Nutri D&N cream memang di formulasikan untuk mengatasi keluhan diwajah kaka ya .. \nterbukti 💯 kandungan niacinamide & Symwhitee 377 jugaa tinggi jadi bisa lebih maksimal lagi prosesnya🥰😁✨\n\nMau cobain si Best Seller Paket Lengkap dari Fix Nutri D&N cream  nya kak? 🥰`,
    member: `Nanti aku jadikan member juga khusus kaka🥰😍\n\nBenefit member card:\nSetiap kakak order kembali kakak akan dapatkan HARGA AWAL BELI dari kami meskipun harga naik/ kembali normal dan unlimited konsultasi sampai mendapatkan hasil yang kakak inginkan🥰`,
    stuck: `Halo kak sayy😍🌸\n\nDengan  produk berkualitas dan sudah terjamin khasiatnya, menyerap langsung ke kulit wajah dengan hasil yang begitu cepat cuma 1-2 minggu\n\nBisa cod ,bisa transfer & free member resmi 💳 100% loh kaka say🥰🌸\n\nBisa di lanjutkan konsultasi ya kak?🤗`,

    // --- CLOSING & PASCA-ORDER ---
    konfirmasi: `Lizel konfirmasi lagi untuk orderan kakak : paket lengkap🥰✅\n\n*Total : Rp 349.000*\n1 Day Cream + 1 Night Cream + 1 Collagen Soap\nCOD ✅`,
    terimakasih: `Terima kasih ya kak\nSemoga mendapat hasil yang maksimal 🤗😍\nJangan lupa konfirmasi jika paketnya sudah di terima 🙏🙏`,
    bukapaket: `Nanti kalau paketnya sudah datang kaka bisa *memvideokan* awal membuka paket sampai akhir supaya bisa klaim refund yaa🥰🫶`,
    paketsampai: `Alhamdulillah 🥰🥰\nTerima kasih sudah konfirmasi ke *Lizel* ☺️🙏\nJangan lupa pakainya secara rutin ya kakak sayang😘`,
    proses: `Baik kak Lizel bantu proses pengiriman barangnya hari ini kak \nMohon ditunggu☺️ \n\nSimpan nomor aku ya kak ,next order / mau jadi reseller bisa chat kesini lagi🥰\n\nfree konsultasi yah ka, jadi selama pemakaian kaka bisa konsultasi terus sama Lizel 😘🙏`,
    carapakai: `🌸CARA PEMAKAIAN FIX NUTRI COLLAGEN BEAUTY SOAP🌸\n\nnote : Simpan di tempat sejuk dan kering terhindar dari sinar matahari langsung\n\nBerikut cara pemakaian:\n1. Cuci wajah hingga bersih\n2. Gunakan Facial Wash bisa dengan Fix Nutri Collagen beauty soap😍🫧\n3. Keringkan Wajah menggunakan tissue wajah \n\nNext ⬇️\n\nPenggunaan Day Cream☀️✅\n\n1. Setelah membersihkan wajah dengan Facial Wash\n2. Ambil Day Cream secukupnya\n3. Oleskan secara merata pada wajah dan leher tidak perlu menggunakan sunscreen karena sudah ada kandungan SPF 50 +++\n4. Tunggu hingga Meresap selama 2 menit baru bisa ditimpa dengan bedak atau make up lainnya🌸😍\n\nNext⬇️\n\nPenggunaan Night Cream🌙⬇️\n\n1. Bersihkan wajah sebelum tidur\n2. Gunakan serum yang cocok jika diperlukan\n3. Oleskan night cream secara merata pada wajah dan leher\n4. Tepuk perlahan hingga meresap\n5. Hindari penggunaan cream di area lipatan wajah seperti :sudut bibir`,
  },

  // ==========================================
  // 3. TAMBAHAN: TEMPLATE PRICE FLOW & AUTO GREETING
  // ==========================================
  priceFlow: {
    askComplaint: `Hallo kakak sebelum keharga bisa di konsultasikan yaah keluhannya apa? Biar aku bantu untuk kasih saran yang paling cocok untuk kakak 💖✨`,
    step1Solusi: `Lizel bantu berikan solusi yaa kak say🤗`,
    step2Product: `✨ PAKET GLOWING 12 HARI - FIX NUTRI D&N CREAM ✨\n\nPaket lengkap 3 rangkaian perawatan:\n\n☀️ Day Cream - membantu mencerahkan kulit dan melindungi kulit saat beraktivitas\n🌙 Night Cream - membantu menyamarkan flek dan noda hitam saat kulit beristirahat di malam hari\n🧼 Collagen Beauty Soap - membersihkan lembut dan membantu menjaga kelembapan kulit\n\n💖 Manfaat yang bisa Kakak rasakan:\n• Mencerahkan kulit wajah\n• Menyamarkan flek dan noda hitam\n• Membantu menjaga skin barrier\n• Kulit tampak lebih lembap, halus, dan glowing merata\n\nGunakan rutin sesuai aturan pakai ya Kak 🤍`,
    step3Testi: `✨ FIX NUTRI GLOW SERIES✨\n\n🤍 Produk ini tidak mengandung merkuri maupun steroid, sehingga aman digunakan sesuai aturan pakai dan tidak menyebabkan ketergantungan.\n\n✅ Sudah terdaftar BPOM\n✅ Bersertifikat Halal\n✅ Cocok digunakan untuk perawatan kulit sehari-hari\n\n😊 Boleh tahu ya Kak, saat ini Kakak berdomisili di Kecamatan mana? Nanti aku cek promo dan estimasi pengiriman ke lokasi Kakak. 📦💖`,
  },
  autoGreeting: `Halo Kak! Terima kasih sudah menghubungi Lizel kembali 🥰 Ada yang bisa Lizel bantu? (Mau konsultasi lanjutan atau repeat order paketnya nih Kak?) 📦✨`,
};
