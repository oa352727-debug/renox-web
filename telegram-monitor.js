"use strict";

// Telegram monitor berjalan di proses server.js yang sama.
// Tidak memakai Pterodactyl API, proses kedua, atau port tambahan.

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const INTERVAL_MS = 10 * 60 * 1000;

function formatUptime(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(value / 86400); value %= 86400;
  const hours = Math.floor(value / 3600); value %= 3600;
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  const parts = [];
  if (days) parts.push(days + " hari");
  if (hours || days) parts.push(hours + " jam");
  if (minutes || hours || days) parts.push(minutes + " menit");
  parts.push(secs + " detik");
  return parts.join(" ");
}

function createTelegramMonitor() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[Renox Telegram] Nonaktif: isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID.");
    return { notifyNewRegistration() {} };
  }

  let offset = 0;
  let polling = false;
  let stopped = false;
  let lastReportAt = Date.now();

  async function api(method, payload = {}) {
    const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || "Telegram HTTP " + response.status);
    return data.result;
  }

  async function send(text) {
    return api("sendMessage", { chat_id: CHAT_ID, text, disable_web_page_preview: true });
  }

  function statusMessage() {
    return [
      "🟢 RENOX PROJECT: ON",
      "⏱ Running selama: " + formatUptime(process.uptime()),
      "🕒 Dicek: " + new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    ].join("\n");
  }

  async function notifyNewRegistration(username) {
    try {
      await send("🆕 USER BARU MENDAFTAR\nUsername: " + String(username || "Tidak diketahui"));
    } catch (error) {
      console.error("[Renox Telegram] Notifikasi pendaftaran gagal:", error.message);
    }
  }

  async function pollCommands() {
    if (polling || stopped) return;
    polling = true;
    try {
      const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message || String(message.chat?.id) !== CHAT_ID || !message.text) continue;
        const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
        if (command === "/start" || command === "/help") {
          await send("🤖 RENOX MONITOR BOT\n/status — cek status dan lama Renox berjalan.\nLaporan otomatis setiap 10 menit.");
        } else if (command === "/status") {
          await send(statusMessage());
        }
      }
    } catch (error) {
      console.error("[Renox Telegram] Polling gagal:", error.message);
    } finally {
      polling = false;
    }
  }

  async function report() {
    try {
      await send(statusMessage());
      lastReportAt = Date.now();
    } catch (error) {
      console.error("[Renox Telegram] Laporan uptime gagal:", error.message);
    }
  }

  send("✅ RENOX MONITOR AKTIF\n" + statusMessage()).catch(error => {
    console.error("[Renox Telegram] Pesan awal gagal:", error.message);
  });
  const reportTimer = setInterval(() => {
    if (Date.now() - lastReportAt >= INTERVAL_MS) report();
  }, 15_000);
  const pollTimer = setInterval(pollCommands, 1000);
  pollCommands();

  function stop() {
    stopped = true;
    clearInterval(reportTimer);
    clearInterval(pollTimer);
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return { notifyNewRegistration };
}

module.exports = { createTelegramMonitor };
