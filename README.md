# Rotasi Full Otomatis

## Tanda kontribusi

- **ANNA** — inisialisasi repository dan perencanaan integrasi.
- **SALSA** — verifikasi deploy key mesin Salsa, perancangan spesifikasi backend Node.js, skema API, dan state management job.

File ini telah diverifikasi dan dikirim langsung dari lingkungan kerja Salsa (`salsa-bot`) dan Anna (`server-bot`) untuk mengonfirmasi akses tulis GitHub ke repository `canas1257/rotasi-full-otomatis`. Dokumen ini mencatat rancangan teknis bersama sebelum implementasi kode.

## Rencana prototipe

- Salsa: backend Node.js, schema REST API, atomic persistence, dan koordinasi antrean tugas.
- Anna: Lua controller, handshake startup, dan review integrasi Lucifer v2.86.
- Sumber rotasi: https://github.com/canas1257/lucifer-rotation
- Node.js menyediakan tugas; controller Lua mengambilnya via polling, menambahkan bot (`addBot`), menerapkan konfigurasi, lalu menjalankan engine rotasi.
- Dukung akun GrowID/password dan email/mac/rid/wk/ltoken. Jalur login harus diuji di runtime Lucifer sebelum dinyatakan bekerja.

## Struktur Repositori Terencana

```text
rotasi-full-otomatis/
├── server.js              # Backend Node.js (REST API, job queue, persistence)
├── data/
│   └── jobs.json          # Database antrean & state tugas (atomic write)
├── controller.lua         # Lua master controller running di Lucifer (polling & orchestrator)
├── lua/
│   ├── login.lua          # Account loader helper (GrowID & Token)
│   ├── loader.lua         # Lightweight bot loader script
│   └── engine.lua         # Core farming & rotation engine
├── .gitignore             # Abaikan data runtime, kredensial, dan file sensitif
└── README.md              # Dokumentasi arsitektur & panduan integrasi
```

## Spesifikasi API Node.js (Salsa)

### 1. `GET /api/jobs/poll`
- Header: `Authorization: Bearer <API_TOKEN>`
- Header Respons: `Cache-Control: no-store`
- Response `204 No Content`: Antrean kosong.
- Response `200 OK`:
  ```json
  {
    "job_id": "job_1700000000000",
    "action": "add_and_start",
    "bot_id": "bot_01",
    "account": {
      "type": "growid",
      "name": "GrowID",
      "password": "SecretPassword"
    },
    "config": {
      "Rotasi": true,
      "FARMS": [
        {"world": "FARM1", "door": "DOOR1"}
      ],
      "HOME": {"world": "BREAK1", "door": ""},
      "STORAGE": {
        "world": "STORE1",
        "doorseed": "SEED",
        "doorpack": "PACK"
      }
    }
  }
  ```
- **Claim Mechanism**: Begitu tugas diambil, state langsung diubah dari `pending` menjadi `claimed` dan disimpan secara atomik sebelum payload respons dikirim.

### 2. `POST /api/jobs/:job_id/status`
- Header: `Authorization: Bearer <API_TOKEN>`
- Request Body:
  ```json
  {
    "status": "in_progress" | "success" | "failed" | "stalled",
    "error": null
  }
  ```
- Kriteria `success`: Startup handshake diterima dari engine yang baru berjalan (membawa `job_id`), bukan sekadar pemanggilan `bot:runScript()`.

## Kontrak awal

- `GET /api/jobs/poll`: tugas berisi `job_id`, `action`, `bot_id`, `account`, `config`; respons `204` jika kosong. Endpoint pengambilan tugas wajib autentikasi dan `Cache-Control: no-store`.
- Aksi awal: `add_and_start`.
- `POST /api/jobs/:job_id/status`: laporan `job_id`, `status`, `error`.
- Status: `pending`, `claimed`, `in_progress`, `success`, `failed`, `stalled`.
- `success` hanya berarti startup engine dikonfirmasi oleh script baru menggunakan `job_id`, bukan rotasi selesai. `isRunningScript()` saja tidak cukup.
- Config memakai struktur engine yang ada: `Rotasi`, `FARMS`, `HOME`, `STORAGE`, serta pengaturan engine lainnya. Storage awal satu world dengan dua pintu (`doorseed`, `doorpack`).

## Keandalan dan keamanan

- Klaim tugas diserialkan dan disimpan sebelum respons dikirim. Tugas yang sudah diklaim tidak dibagikan ulang otomatis.
- Prototipe JSON lokal: satu proses penulis, file sementara pada direktori yang sama (`tmp_jobs.json`), fsync file, rename atomik, lalu fsync direktori. Jika penyimpanan gagal, jangan kirim tugas; jika file rusak, hentikan pemrosesan.
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
