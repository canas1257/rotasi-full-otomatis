# Rotasi Full Otomatis

## Tanda kontribusi

**ANNA — inisialisasi repository dan perencanaan integrasi.**

File ini dibuat dan dikirim dari lingkungan kerja Anna untuk menguji akses tulis GitHub. Ini dokumentasi rencana, bukan aplikasi yang sudah berjalan. Identitas penulis commit adalah label kontribusi, bukan tanda tangan kriptografis.

## Rencana prototipe

- Salsa: backend Node.js dan penyimpanan status tugas.
- Anna: Lua controller dan review integrasi Lucifer.
- Sumber rotasi: https://github.com/canas1257/lucifer-rotation
- Node.js menyediakan tugas; controller Lua mengambilnya, menambahkan bot, menerapkan konfigurasi, lalu menjalankan engine rotasi.
- Dukung akun GrowID/password dan email/mac/rid/wk/ltoken. Jalur login harus diuji di runtime Lucifer sebelum dinyatakan bekerja.

## Kontrak awal

- `GET /api/jobs/poll`: tugas berisi `job_id`, `action`, `bot_id`, `account`, `config`; respons `204` jika kosong. Endpoint pengambilan tugas wajib autentikasi dan `Cache-Control: no-store`.
- Aksi awal: `add_and_start`.
- `POST /api/jobs/:job_id/status`: laporan `job_id`, `status`, `error`.
- Status: `pending`, `claimed`, `in_progress`, `success`, `failed`, `stalled`.
- `success` hanya berarti startup engine dikonfirmasi oleh script baru menggunakan `job_id`, bukan rotasi selesai. `isRunningScript()` saja tidak cukup.
- Config memakai struktur engine yang ada: `Rotasi`, `FARMS`, `HOME`, `STORAGE`, serta pengaturan engine lainnya. Storage awal satu world dengan dua pintu (`doorseed`, `doorpack`).

## Keandalan dan keamanan

- Klaim tugas diserialkan dan disimpan sebelum respons dikirim. Tugas yang sudah diklaim tidak dibagikan ulang otomatis.
- Prototipe JSON lokal: satu proses penulis, file sementara pada direktori yang sama, fsync file, rename atomik, lalu fsync direktori. Jika penyimpanan gagal, jangan kirim tugas; jika file rusak, hentikan pemrosesan.
- Setelah restart, tugas aktif yang keadaannya tidak pasti perlu rekonsiliasi; jangan otomatis diulang. Timeout ditandai `stalled`.
- Laporan status dapat dikirim ulang tanpa mengulangi eksekusi. Cegah dua tugas aktif untuk bot yang sama.
- Validasi input dan transisi status, batasi ukuran request, autentikasi endpoint, dan gunakan TLS untuk koneksi lintas mesin.
- Jangan menerima kode Lua arbitrer dari API. Gunakan engine lokal atau versi yang dipin dan ditinjau.
- Kredensial, token, webhook, dan data tugas tidak boleh masuk Git atau log. Batasi izin file lokal yang menyimpan rahasia.

## Verifikasi sebelum penggunaan

1. Uji pengambilan tugas bersamaan, restart server, kegagalan penyimpanan, dan file status rusak.
2. Uji konfirmasi startup, laporan ulang, timeout, serta pencegahan duplikasi.
3. Uji satu bot pada Lucifer nyata: login, konfigurasi world, startup, dan rotasi.

Belum ada implementasi atau pengujian runtime Lucifer dalam commit ini. Push dokumentasi ini tidak menjalankan atau men-deploy aplikasi. Push berikutnya, merge, dan deployment runtime tetap memerlukan persetujuan Bos Anas.
