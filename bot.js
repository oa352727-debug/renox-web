"use strict";

/**
 * Renox Telegram control bot.
 * Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * Optional env: TELEGRAM_ADMIN_IDS (comma-separated numeric Telegram user IDs).
 * Admin commands are disabled when TELEGRAM_ADMIN_IDS is empty.
 */

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const ADMIN_IDS = new Set(String(process.env.TELEGRAM_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const REPORT_INTERVAL = 10 * 60 * 1000;

function duration(seconds) {
  let n = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(n / 86400); n %= 86400;
  const h = Math.floor(n / 3600); n %= 3600;
  const m = Math.floor(n / 60); n %= 60;
  return [d && d + "h", h && h + "j", m && m + "m", n + "d"].filter(Boolean).join(" ");
}
function mb(bytes) { return (Number(bytes || 0) / 1024 / 1024).toFixed(1) + " MB"; }

function createRenoxBot(handlers = {}) {
  if (!TOKEN || !CHAT_ID) {
    console.log("[Renox Bot] Nonaktif. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID.");
    return {
      notifyNewRegistration: async () => {}, notifyAnnouncement: async () => {},
      notifyMaintenance: async () => {}, stop: () => {}
    };
  }

  let offset = 0, polling = false, stopped = false, lastReport = Date.now();
  async function api(method, payload = {}) {
    const response = await fetch("https://api.telegram.org/bot" + TOKEN + "/" + method, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(35000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || "Telegram HTTP " + response.status);
    return data.result;
  }
  async function send(text) {
    return api("sendMessage", { chat_id: CHAT_ID, text: String(text).slice(0, 4000), disable_web_page_preview: true });
  }
  function statsText() {
    const s = handlers.getStats ? handlers.getStats() : {};
    const mem = s.memory || process.memoryUsage();
    const totalMem = require("os").totalmem();
    const usedMem = totalMem - require("os").freemem();
    return [
      "📊 RENOX PROJECT — SERVER STATS",
      "🟢 Status: ONLINE",
      "👥 Total akun: " + (s.users ?? 0),
      "🪪 Total profil: " + (s.profiles ?? 0),
      "🟢 Pengguna online: " + (s.online ?? 0),
      "💬 Total pesan: " + (s.messages ?? 0),
      "🧠 RAM proses: " + mb(mem.rss) + " (heap " + mb(mem.heapUsed) + ")",
      "💻 RAM server: " + mb(usedMem) + " / " + mb(totalMem),
      "⚙️ CPU core: " + (s.cpuCount ?? require("os").cpus().length),
      "⏱ Uptime: " + duration(s.uptime ?? process.uptime()),
      "🛠 Maintenance: " + (s.maintenance ? "ON" : "OFF"),
      "🕒 " + new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    ].join("\n");
  }
  async function notifyNewRegistration(username) {
    return send("🆕 USER BARU TERDAFTAR\n👤 Username: " + String(username || "Tidak diketahui"));
  }
  async function notifyAnnouncement(item) {
    if (!item) return;
    return send("📢 PENGUMUMAN BARU — RENOX PROJECT\n\n📌 " + item.title + "\n\n" + item.content + "\n\n— RENOX OWNER");
  }
  async function notifyMaintenance(enabled, reason) {
    return send((enabled ? "🛠 MAINTENANCE DIAKTIFKAN" : "✅ MAINTENANCE DINONAKTIFKAN") +
      "\nRenox Project: " + (enabled ? "Maintenance" : "Online") +
      (reason ? "\nKeterangan: " + reason : ""));
  }
  async function handleMessage(message) {
    if (!message || String(message.chat?.id) !== CHAT_ID || !message.text) return;
    const text = message.text.trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split("@")[0].toLowerCase();
    const senderId = String(message.from?.id || "");
    const isAdmin = ADMIN_IDS.has(senderId);
    if (command === "/start" || command === "/help") {
      return send("🤖 RENOX PROJECT BOT\n\n/status atau /stats — statistik server & user\n/maintenance — status maintenance\n\nPerintah admin:\n/maintenance_on [alasan]\n/maintenance_off\n/announce Judul | Isi\n\nAdmin ID harus diatur pada TELEGRAM_ADMIN_IDS.");
    }
    if (command === "/status" || command === "/stats") return send(statsText());
    if (command === "/maintenance") {
      const s = handlers.getStats ? handlers.getStats() : {};
      return send("🛠 MAINTENANCE: " + (s.maintenance ? "ON" : "OFF"));
    }
    if (["/maintenance_on", "/maintenance_off", "/announce"].includes(command) && !isAdmin) {
      return send("⛔ Perintah ini khusus admin Renox. Minta developer menambahkan Telegram user ID kamu ke TELEGRAM_ADMIN_IDS.");
    }
    if (command === "/maintenance_on" || command === "/maintenance_off") {
      if (!handlers.setMaintenance) return send("Fitur maintenance belum dikonfigurasi.");
      const enabled = command === "/maintenance_on";
      const result = await handlers.setMaintenance(enabled, args.join(" "));
      await notifyMaintenance(result.maintenance, result.reason);
      return send("✅ Maintenance " + (enabled ? "diaktifkan." : "dinonaktifkan."));
    }
    if (command === "/announce") {
      if (!handlers.createAnnouncement) return send("Fitur pengumuman belum dikonfigurasi.");
      const payload = text.slice(rawCommand.length).trim();
      const split = payload.split("|");
      if (split.length < 2) return send("Format: /announce Judul | Isi pengumuman");
      const item = await handlers.createAnnouncement(split.shift().trim(), split.join("|").trim());
      await notifyAnnouncement(item);
      return send("✅ Pengumuman disimpan ke database Renox dan dikirim ke grup.");
    }
  }
  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        try { await handleMessage(update.message); }
        catch (error) { console.error("[Renox Bot] Command error:", error.message); }
      }
    } catch (error) {
      if (!stopped) console.error("[Renox Bot] Polling gagal:", error.message);
    } finally { polling = false; }
  }
  send("🚀 RENOX PROJECT BOT AKTIF\n\n" + statsText()).catch(e => console.error("[Renox Bot] Startup:", e.message));
  const pollTimer = setInterval(poll, 1000);
  const reportTimer = setInterval(() => {
    if (Date.now() - lastReport >= REPORT_INTERVAL) {
      send(statsText()).then(() => { lastReport = Date.now(); })
        .catch(e => console.error("[Renox Bot] Laporan gagal:", e.message));
    }
  }, 15000);
  poll();
  function stop() { stopped = true; clearInterval(pollTimer); clearInterval(reportTimer); }
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return { notifyNewRegistration, notifyAnnouncement, notifyMaintenance, stop };
}
module.exports = { createRenoxBot };
