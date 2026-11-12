# RENOX PROJECT + TELEGRAM BOT

## Backend Pterodactyl
1. Gunakan Node.js 18 atau lebih baru.
2. Upload dan extract ZIP backend ke root server Pterodactyl.
3. Backup database lama sebelum mengganti file aplikasi.
4. Pertahankan `data/renox-db.json`; jangan menimpa database aktif dengan file kosong.
5. Atur allocation dan environment `PORT=4807`.
6. Isi environment variables yang diperlukan melalui Pterodactyl Startup / Environment.
7. Jalankan `npm install`, lalu restart server dengan `npm start`.

## Environment
- `PORT=4807`
- `DINONIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_ADMIN_IDS` (ID Telegram numerik, pisahkan dengan koma)

Server memuat konfigurasi lokal dari `.env` melalui dotenv. Jangan commit file `.env` atau menaruh API key/token di frontend maupun repository.

## Telegram Bot
Bot dimuat oleh `server.js` dalam proses Node.js yang sama.
- Notifikasi startup dan pendaftaran user baru.
- Statistik server/user melalui `/stats` atau `/status`.
- Status maintenance melalui `/maintenance`.
- Admin: `/maintenance_on [alasan]`, `/maintenance_off`, dan `/announce Judul | Isi`.
- Isi `TELEGRAM_ADMIN_IDS` agar perintah pengelolaan aktif.

## Database dan keamanan
- Simpan backup `data/renox-db.json` sebelum update.
- Gunakan volume persisten dengan `RENOX_DATA_DIR` atau `RENOX_DB_FILE` bila diperlukan.
- Jangan commit database aktif, API key, token bot, atau kredensial Cloudflare R2.

## Vercel
Frontend dideploy dari repository ini. `vercel.json` meneruskan request `/api/*` ke backend Pterodactyl `http://139.59.108.245:4807`. Backend harus tetap aktif agar login dan API berfungsi.
