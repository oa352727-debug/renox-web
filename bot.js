#!/usr/bin/env node
'use strict';

/*
 * RENOX Telegram notifier for Termux
 * - Announces newly registered Renox accounts.
 * - Sends Pterodactyl server resource reports every 10 minutes.
 * - Read-only: it never starts, stops, restarts, or modifies servers.
 *
 * Node.js 18+; no npm packages required.
 * Run: node bot.js
 * Optional: node --env-file=.env bot.js (Node 20.6+)
 */

const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || Object.prototype.hasOwnProperty.call(process.env, m[1])) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value.replace(/\\n/g, '\n');
  }
}
loadEnvFile();

const CFG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  renoxUrl: (process.env.RENOX_API_URL || 'https://renox-web-1cnu.vercel.app').replace(/\/+$/, ''),
  renoxBotToken: process.env.RENOX_BOT_TOKEN || '',
  pteroUrl: (process.env.PTERO_URL || '').replace(/\/+$/, ''),
  pteroKey: process.env.PTERO_API_KEY || '',
  intervalMs: Math.max(1, Number(process.env.STATS_INTERVAL_MINUTES || 10)) * 60_000,
  stateFile: path.join(__dirname, 'renox-bot-state.json')
};

for (const [key, value] of Object.entries({
  TELEGRAM_BOT_TOKEN: CFG.telegramToken,
  TELEGRAM_CHAT_ID: CFG.chatId,
  RENOX_BOT_TOKEN: CFG.renoxBotToken,
  PTERO_URL: CFG.pteroUrl,
  PTERO_API_KEY: CFG.pteroKey
})) {
  if (!value) {
    console.error('Konfigurasi belum lengkap: ' + key + ' belum diisi di .env');
    process.exit(1);
  }
}

let state = { registrationCursor: Date.now(), telegramOffset: 0 };
try { state = { ...state, ...JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')) }; } catch {}
let stopped = false;
let lastStatsAt = 0;

function saveState() {
  const tmp = CFG.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CFG.stateFile);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function fmtBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + units[i];
}
function fmtUptime(ms) {
  const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return [d ? d + 'h' : '', h ? h + 'j' : '', m + 'm'].filter(Boolean).join(' ');
}
async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Respons bukan JSON (' + response.status + ')'); }
  if (!response.ok) throw new Error(data.errors?.[0]?.detail || data.error || data.message || ('HTTP ' + response.status));
  return data;
}
async function telegram(method, payload = {}) {
  const data = await requestJson('https://api.telegram.org/bot' + CFG.telegramToken + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!data.ok) throw new Error(data.description || 'Telegram API error');
  return data.result;
}
async function sendText(text) {
  const chunks = [];
  while (text.length > 3900) {
    let cut = text.lastIndexOf('\n', 3900);
    if (cut < 1000) cut = 3900;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).replace(/^\n/, '');
  }
  if (text) chunks.push(text);
  for (const chunk of chunks) {
    await telegram('sendMessage', {
      chat_id: CFG.chatId, text: chunk, parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  }
}
async function renoxHealth() {
  try {
    const d = await requestJson(CFG.renoxUrl + '/api/health');
    return { on: String(d.status).toUpperCase() === 'ONLINE', version: d.version || '—', uptime: d.uptime || 0 };
  } catch (e) { return { on: false, error: e.message }; }
}
const pteroHeaders = {
  Authorization: 'Bearer ' + CFG.pteroKey,
  Accept: 'Application/vnd.pterodactyl.v1+json',
  'Content-Type': 'application/json'
};
async function pteroServers() {
  const all = [];
  let page = 1, pages = 1;
  do {
    const d = await requestJson(CFG.pteroUrl + '/api/client?per_page=100&page=' + page, { headers: pteroHeaders });
    all.push(...(d.data || []));
    pages = Number(d.meta?.pagination?.total_pages || 1);
    page++;
  } while (page <= pages && page <= 30);
  return all;
}
async function pteroResources(server) {
  const a = server.attributes || {};
  const d = await requestJson(CFG.pteroUrl + '/api/client/servers/' + encodeURIComponent(a.identifier) + '/resources', { headers: pteroHeaders });
  return d.attributes || {};
}
async function collectStats() {
  const renox = await renoxHealth();
  let servers = [], panelOn = false, panelError = '';
  try { servers = await pteroServers(); panelOn = true; }
  catch (e) { panelError = e.message; }
  const lines = [
    '<b>RENOX · LAPORAN SERVER</b>',
    'Waktu: ' + esc(new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })),
    '',
    '<b>RENOX WEBSITE: ' + (renox.on ? '🟢 ON' : '🔴 OFF') + '</b>' + (renox.version ? ' · v' + esc(renox.version) : ''),
    '<b>PTERODACTYL PANEL: ' + (panelOn ? '🟢 ON' : '🔴 OFF') + '</b>'
  ];
  if (panelError) lines.push('Detail: ' + esc(panelError));
  if (panelOn) {
    lines.push('Server yang terlihat oleh API key: <b>' + servers.length + '</b>', '');
    for (const server of servers) {
      const a = server.attributes || {};
      const name = esc(a.name || a.identifier || 'Server');
      try {
        const r = await pteroResources(server);
        const v = r.resources || {};
        const running = String(r.current_state || '').toLowerCase() === 'running';
        lines.push((running ? '🟢' : '🔴') + ' <b>' + name + '</b> · ' + (running ? 'ON' : 'OFF'));
        lines.push('CPU: ' + Number(v.cpu_absolute || 0).toFixed(1) + '%');
        lines.push('RAM: ' + fmtBytes(v.memory_bytes) + ' / ' + fmtBytes(a.limits?.memory ? Number(a.limits.memory) * 1024 * 1024 : NaN));
        lines.push('Disk: ' + fmtBytes(v.disk_bytes) + ' / ' + fmtBytes(a.limits?.disk ? Number(a.limits.disk) * 1024 * 1024 : NaN));
        lines.push('Network RX/TX: ' + fmtBytes(v.network_rx_bytes) + ' / ' + fmtBytes(v.network_tx_bytes));
        lines.push('Uptime: ' + fmtUptime(v.uptime));
      } catch (e) {
        const known = String(a.status || '').toLowerCase();
        lines.push('🔴 <b>' + name + '</b> · OFF / data tidak tersedia');
        lines.push('Detail: ' + esc(e.message || known || 'resource API gagal'));
      }
      lines.push('');
    }
  }
  lines.push('<b>STATUS SERVER: ' + (renox.on && panelOn ? '🟢 ON' : '🔴 OFF') + '</b>');
  return lines.join('\n');
}
async function sendStats() {
  const report = await collectStats();
  await sendText(report);
  lastStatsAt = Date.now();
  console.log('Laporan statistik terkirim:', new Date(lastStatsAt).toISOString());
}
async function pollRegistrations() {
  const url = CFG.renoxUrl + '/api/bot/events?since=' + encodeURIComponent(state.registrationCursor);
  const d = await requestJson(url, { headers: { 'x-renox-bot-token': CFG.renoxBotToken } });
  const events = Array.isArray(d.events) ? d.events : [];
  for (const event of events) {
    const name = esc(event.username || 'Pengguna');
    const when = new Date(event.createdAt || Date.now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    await sendText('🆕 <b>PENGGUNA BARU MENDAFTAR</b>\nNama: <b>' + name + '</b>\nWaktu: ' + esc(when));
    state.registrationCursor = Math.max(Number(state.registrationCursor || 0), Number(event.createdAt || 0));
    saveState();
  }
  if (!events.length && Number(d.serverTime) > Number(state.registrationCursor)) {
    // Advance only to the server clock if there were no events in the queried range.
    state.registrationCursor = Number(d.serverTime);
    saveState();
  }
}
async function handleTelegramUpdates() {
  const updates = await telegram('getUpdates', { offset: state.telegramOffset, timeout: 25, allowed_updates: ['message'] });
  for (const update of updates || []) {
    state.telegramOffset = update.update_id + 1;
    saveState();
    const msg = update.message;
    if (!msg?.text) continue;
    if (String(msg.chat?.id) !== String(CFG.chatId)) continue;
    const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help') {
      await sendText('<b>RENOX MONITOR BOT</b>\nBot ini hanya memantau pendaftaran dan statistik server.\n/status — kirim statistik sekarang.\nLaporan otomatis setiap ' + Math.round(CFG.intervalMs / 60000) + ' menit.');
    } else if (cmd === '/status' || cmd === '/stats') {
      await sendText(await collectStats());
    }
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function loop() {
  console.log('Renox monitor aktif. Statistik tiap ' + CFG.intervalMs / 60000 + ' menit.');
  await sendText('🟢 <b>RENOX MONITOR BOT AKTIF</b>\nNotifikasi pendaftaran dan laporan statistik telah dimulai.');
  try { await sendStats(); } catch (e) { console.error('Statistik awal gagal:', e.message); await sendText('🔴 Gagal mengambil statistik awal: ' + esc(e.message)).catch(() => {}); }
  while (!stopped) {
    try { await pollRegistrations(); } catch (e) { console.error('Poll registrasi:', e.message); }
    try { await handleTelegramUpdates(); } catch (e) { console.error('Telegram polling:', e.message); await sleep(3000); }
    if (Date.now() - lastStatsAt >= CFG.intervalMs) {
      try { await sendStats(); } catch (e) { console.error('Statistik:', e.message); await sendText('🔴 Gagal mengambil statistik: ' + esc(e.message)).catch(() => {}); lastStatsAt = Date.now(); }
    }
  }
}
process.on('SIGINT', () => { stopped = true; console.log('Bot dihentikan.'); process.exit(0); });
process.on('SIGTERM', () => { stopped = true; process.exit(0); });
loop().catch(e => { console.error(e); process.exit(1); });
