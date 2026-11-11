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

## Dinonic tools (feature branch)
Set these values in Pterodactyl → Startup → Environment. Never put API keys or SMTP passwords in frontend code or Git:
- `DINONIC_API_KEY`: required for QR Generator, Google TTS, Gemini, Anime Latest, Pinterest/SFile/TikTok search, Free Fire/Mobile Legends lookup and fake lobby tools.
- `DINONIC_MAIL_HOST`, `DINONIC_MAIL_PORT`, `DINONIC_MAIL_USER`, `DINONIC_MAIL_PASS`: required for reseller email sending.
- `DINONIC_MAIL_FROM_NAME`: optional sender display name.

The email API is restricted server-side to authenticated reseller/admin accounts and rate-limited. New accounts default to member; the developer account has admin access. Reseller role assignment is controlled by the owner endpoint `POST /api/owner/account-role` with `username` and `role: "reseller"` or `"member"`.

QR and TTS endpoints are proxied by the backend. Nexo AI uses Dinonic Gemini. Anime Latest returns provider data for public listing; playback availability and rights remain with the source provider. Fake lobby endpoints produce mockups/simulations, not proof of real game activity.

OTP retrieval from phone numbers and automated NGL spam are intentionally disabled.
