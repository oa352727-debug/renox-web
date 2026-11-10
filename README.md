# Renox Project

## Backend Pterodactyl
- Gunakan Node.js 18 atau lebih baru.
- Startup command: `npm start`.
- Port fallback project: `26186`. Pastikan allocation Pterodactyl dan environment `PORT` sesuai.
- Database dibuat otomatis di `data/renox-db.json` saat file belum tersedia.
- Untuk penyimpanan permanen, atur `RENOX_DATA_DIR` atau `RENOX_DB_FILE` ke lokasi volume persisten.

## Vercel
Frontend dideploy dari repository ini. File `vercel.json` meneruskan request `/api/*` ke backend Pterodactyl pada port 26186. Backend harus aktif agar login dan API berfungsi.

## Keamanan
Jangan commit database aktif, token bot, atau kredensial Cloudflare R2. `bot.js` dan folder `data/` sengaja dikecualikan dari Git. Atur token dan kredensial melalui environment/secret manager.
