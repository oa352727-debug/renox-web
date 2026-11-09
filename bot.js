"use strict";

/*
 * RENOX TELEGRAM MONITOR
 * Berjalan di proses Node.js Renox yang sama.
 * Isi token bot dan chat ID grup di bawah ini.
 * Tidak membutuhkan Pterodactyl API atau proses bot terpisah.
 */

const BOT_TOKEN = "ISI_TOKEN_BOT_DI_SINI";
const GROUP_CHAT_ID = "ISI_CHAT_ID_GRUP_DI_SINI";
const REPORT_INTERVAL_MS = 10 * 60 * 1000;

function formatUptime(totalSeconds) {
  let s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(s / 86400); s %= 86400;
  const hours = Math.floor(s / 3600); s %= 3600;
  const minutes = Math.floor(s / 60); s %= 60;
  return [days ? days + " hari" : "", hours ? hours + " jam" : "",
    minutes ? minutes + " menit" : "", s + " detik"].filter(Boolean).join(" ");
}

function createTelegramMonitor() {
  if (!BOT_TOKEN || BOT_TOKEN === "ISI_TOKEN_BOT_DI_SINI" ||
      !GROUP_CHAT_ID || GROUP_CHAT_ID === "ISI_CHAT_ID_GRUP_DI_SINI") {
    console.log("[Renox Bot] Token atau Chat ID belum diatur; monitor Telegram nonaktif.");
    return { notifyNewRegistration() {} };
  }

  let offset = 0;
  let stopped = false;
  let polling = false;
  let lastReportAt = Date.now();
  const startedAt = Date.now();

  async function telegram(method, payload = {}) {
    const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || "Telegram HTTP " + response.status);
    return data.result;
  }

  async function sendMessage(text) {
    return telegram("sendMessage", {
      chat_id: GROUP_CHAT_ID, text, disable_web_page_preview: true
    });
  }

  function statusMessage() {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const uptime = formatUptime(seconds);
    return "🟢 RENOX PROJECT: ONLINE\n" +
      "⏱️ Berjalan selama: " + uptime + "\n" +
      "📅 Waktu: " + new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  }

  async function notifyNewRegistration(username) {
    try {
      await sendMessage("🆕 USER BARU MENDAFTAR\nUsername: " + String(username || "Tidak diketahui"));
    } catch (error) {
      console.error("[Renox Bot] Notifikasi pendaftaran gagal:", error.message);
    }
  }

  async function pollCommands() {
    if (polling || stopped) return;
    polling = true;
    try {
      const updates = await telegram("getUpdates", {
        offset, timeout: 25, allowed_updates: ["message"]
      });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message || String(message.chat && message.chat.id) !== String(GROUP_CHAT_ID) || !message.text) continue;
        const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
        if (command === "/start" || command === "/help") {
          await sendMessage("🤖 RENOX MONITOR BOT\n/status — cek status dan lama Renox berjalan.\nLaporan otomatis setiap 10 menit.");
        } else if (command === "/status") {
          await sendMessage(statusMessage());
        }
      }
    } catch (error) {
      if (!stopped) console.error("[Renox Bot] Polling gagal:", error.message);
    } finally {
      polling = false;
    }
  }

  sendMessage("✅ RENOX MONITOR AKTIF\n" + statusMessage()).catch(error =>
    console.error("[Renox Bot] Pesan awal gagal:", error.message));

  const reportTimer = setInterval(async () => {
    if (stopped || Date.now() - lastReportAt < REPORT_INTERVAL_MS) return;
    try {
      await sendMessage(statusMessage());
      lastReportAt = Date.now();
    } catch (error) {
      console.error("[Renox Bot] Laporan otomatis gagal:", error.message);
    }
  }, 15000);

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
