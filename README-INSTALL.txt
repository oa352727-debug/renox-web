RENOX PROJECT + TELEGRAM BOT (ONE PROCESS)

PTERODACTYL INSTALL
1. Backup the existing data/renox-db.json before replacing application files.
2. Upload and extract this ZIP into the Pterodactyl server root.
3. Replace server.js, bot.js, package.json, and the public/ folder.
4. Keep the existing data/renox-db.json unchanged. Do not upload an empty database over it.
5. Set the Pterodactyl allocation/environment PORT to 4807 (or the port shown by your panel).
6. Add the environment variables below in Pterodactyl Startup / Environment. Never put secrets in public/index.html or GitHub.
7. Run npm install, then restart the server.

ENVIRONMENT VARIABLES
PORT=4807
DINONIC_API_KEY=your_dinonic_api_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_private_chat_or_group_id
TELEGRAM_ADMIN_IDS=your_numeric_telegram_user_id

The Telegram bot is loaded by server.js from bot.js. It runs in the same Node.js process and does not need a second process or port.

BOT FEATURES
- Startup notification and new-registration notification.
- Server/user statistics every 10 minutes and on /stats or /status.
- Reports registered accounts, profiles, online users, messages, RAM, CPU cores, uptime, and maintenance.
- Dashboard announcements and maintenance changes are sent to Telegram.
- Admin commands: /maintenance_on [reason], /maintenance_off, /announce Title | Content.
- /start and /help show usage.

SECURITY / DATA
- Set TELEGRAM_ADMIN_IDS to trusted numeric Telegram user IDs. Without it, management commands stay locked.
- Keep TELEGRAM_BOT_TOKEN, DINONIC_API_KEY, and owner/session secrets private.
- Do not commit secrets or your production database to GitHub.
- Uptime is the current server.js process runtime and resets after a restart.
- If Renox is offline, the in-process bot is also offline.

VERCEL
The frontend is deployed on Vercel. vercel.json proxies /api/* to http://139.59.108.245:4807. Keep the backend process running in Pterodactyl for login and API features to work.

ACCOUNT MENU UPDATE
- Sidebar account menu includes role progression, coming-soon issue reports, app update info, and app information.
- Password changes require the current password and a valid login session. The current session is renewed; other sessions are invalidated.
- Update version and GitHub/MediaFire links are intentionally placeholders for the developer to fill in.
\n\nRENOX AUDIO UPDATE\n- Brand halaman pembuka dan player menggunakan Renox Music / Renox Audio.\n- Pencarian lagu memakai YouTube Data API v3 jika YOUTUBE_API_KEY dipasang.\n- Tambahkan YOUTUBE_API_KEY pada environment backend. Tanpa API key, aplikasi memberi tautan pencarian YouTube langsung (hasil tidak bisa diputar inline).\n- Ringkasan Profile dashboard menampilkan username, role, session label acak, dan masa berlaku sesi. Password tidak pernah dikirim atau ditampilkan karena disimpan sebagai hash.\n