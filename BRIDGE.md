# Lua bridge — Anna

Tahap ini hanya `addbot`: success = bot online. Tidak menjalankan rotasi atau kode Lua dari HTTP. Bot Discord dan server Node.js dikerjakan Salsa; runtime end-to-end belum diverifikasi.

## Kontrak untuk Node.js

Semua endpoint memakai `Authorization: Bearer <token>`. Server membatasi operator Discord berdasarkan user ID, menyimpan akun lokal memakai alias, dan tidak menerima password melalui pesan channel. Jangan log request body atau token. Gunakan TLS jika lintas mesin, jangan expose endpoint tanpa autentikasi.

- `GET /api/jobs/poll`: `204` bila kosong; `200` dengan objek berikut setelah klaim durable dan atomik:

```json
{"job_id":"job_1","action":"addbot","bot_id":"bot_1","account":{"type":"growid","name":"LOCAL_ACCOUNT","password":"LOCAL_SECRET"}}
```

`job_id`/`bot_id`: 1–80 karakter ASCII huruf/angka/underscore/minus. `job_id` unik permanen, tidak boleh dipakai untuk payload lain. Server harus menolak dua tugas aktif untuk bot yang sama. Poll tidak boleh di-cache; batasi body sampai 64 KiB. Jangan kirim field config rotasi pada tahap ini.

- `POST /api/jobs/:job_id/status`: `{job_id,status,error}`. `error` null pada success. Terima laporan terminal langsung dari claimed: `success`, `failed`, `stalled`. Pengiriman laporan identik berulang harus aman dan mendapat respons 2xx. `stalled` perlu pemeriksaan operator; bukan izin retry otomatis.
- Server tidak mengantrekan ulang tugas yang diklaim tetapi kehilangan respons poll. Tandai stalled untuk rekonsiliasi, bukan pengiriman ulang otomatis.

## Menjalankan di Lucifer

Letakkan `controller.lua`, `addbot.lua`, dan `json.lua` bersama. Buat file lokal `bridge.local.lua` (jangan commit), contoh berikut harus disesuaikan dengan lokasi file di mesin Lucifer:

```lua
local bridge = dofile("/ABSOLUTE/PATH/lua/controller.lua")
bridge.new({
    module_dir = "/ABSOLUTE/PATH/lua/",
    api_url = "http://127.0.0.1:8080", -- HTTPS untuk lintas mesin
    api_token = "GANTI_TOKEN_ACAK_MINIMAL_16_KARAKTER",
    journal_path = "/WRITABLE/PRIVATE/PATH/controller-journal.json",
    poll_interval_ms = 2000
}):run()
```

Jalankan launcher lokal itu pada konteks Lucifer yang menyediakan `addBot`, `getBot`, `HttpClient`, `Method`, `BotStatus`, `sleep`, serta file I/O `io` dan `os.rename`. Ketersediaan file I/O, loading file, dan HTTP harus diuji pada Lucifer nyata; bukan diasumsikan dari unit test. Simpan journal di direktori yang sudah ada dan tidak masuk Git. Token API berbeda dari token bot Discord. Webhook dinonaktifkan di bridge agar hasil dikirim melalui Node.js saja.

## Batas prototipe

- Satu controller dan satu penulis per journal; jangan jalankan dua launcher paralel.
- Journal hanya menyimpan ID/status, tidak kredensial. Jangan hapus journal saat operasi: itu menghilangkan ingatan deduplikasi.
- File di-flush/close dan diganti dengan rename. Portable Lua tidak menyediakan fsync file/direktori; ini bukan jaminan terhadap listrik mati. Platform yang tidak mendukung replace rename akan berhenti fail-closed. Gunakan storage transaksional jika perlu jaminan lebih kuat.
- Saat restart, tugas executing menjadi stalled dan tidak dieksekusi ulang. Kegagalan simpan menghentikan loop. Laporan gagal jaringan diulang sebelum mengambil tugas baru.
- Journal belum dipangkas: pertumbuhan linear terhadap jumlah tugas; tambahkan arsip hanya bersama kebijakan ID/deduplikasi server yang konsisten.
- Library JSON: rxi/json.lua, commit `dbf4b2dd2eb7c23be2773c89eb059dadd6436f94`; lisensi MIT tercantum di `lua/json.lua`. Dipaketkan karena docs Lucifer tidak menetapkan API JSON bawaan.

## Cek offline

```sh
lua lua/test_controller.lua
lua lua/test_addbot.lua
```

Tes memakai mock, bukan login GT atau koneksi bot Discord nyata. Setelah server Salsa tersedia, perlu tes HTTP end-to-end dan satu akun Lucifer lokal sebelum dinyatakan bekerja penuh.
