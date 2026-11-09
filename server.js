const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const { promisify } = require("util");
const execFile = promisify(require("child_process").execFile);

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 2429);
const HOST = "0.0.0.0";
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "renox-db.json");
const OWNER_KEY = process.env.RENOX_OWNER_KEY || "RenoxGanteng";
const SESSION_SECRET = process.env.RENOX_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PRESENCE_TTL = 90_000;
const MAX_BODY = 16_000_000;
const NOXTOK_MAX_VIDEO_BYTES = Math.max(1, Number(process.env.NOXTOK_MAX_VIDEO_MB || 250)) * 1024 * 1024;
const RELEASE = {
  version: "10.2.1",
  name: "Renox Project · Lookup & Web Tools Update",
  publishedAt: "2026-11-08",
  changes: [
    "Unban: formulir pengajuan wajib berisi nomor, alasan, dan tanggal pemblokiran.",
    "Unban: pemeriksaan ulang status sebelum pengajuan disimpan.",
    "Unban: nomor dengan status banned permanen yang dinyatakan provider akan ditolak.",
    "Unban: daftar pengajuan dan tindakan review tersedia untuk owner.",
    "Update: endpoint changelog publik agar halaman pembaruan dapat menampilkan versi dan catatan patch.",
    "Profile: nama akun login diverifikasi dari cookie sesi server, bukan dari input browser."
  ]
};
function isPermanentBan(data) {
  const text = [data?.status, data?.reason, data?.violation_type, data?.ban_type]
    .map(x => String(x || "")).join(" ");
  return /permanent(?:ly)?|permanen|perma[- ]ban|banned permanently/i.test(text);
}
async function fetchBanDetails(number) {
  const endpoint = new URL("https://xzc-corporation.biz.id/lrp");
  endpoint.searchParams.set("number", number);
  const r = await fetch(endpoint, {
    headers: { "Accept": "application/json", "User-Agent": "RenoxProject/10.1" },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`Checkban API merespons ${r.status}.`);
  return await r.json();
}
let r2Client = null;
function getR2Client() {
  const { S3Client } = require("@aws-sdk/client-s3");
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    throw new Error("Cloudflare R2 belum dikonfigurasi. Isi R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, dan R2_BUCKET di Environment Pterodactyl.");
  }
  if (!r2Client) r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
  });
  return r2Client;
}
function r2PublicUrl(key) {
  const base = String(process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("R2_PUBLIC_URL belum diisi. Hubungkan bucket ke custom domain Cloudflare terlebih dahulu.");
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ profiles: {}, messages: [], announcements: [], leaks: [], unbanRequests: [], dailyClaims: {}, accounts: {}, friends: {}, settings: { maintenance: false, maintenanceReason:"", maintenanceAffected:"", maintenanceUntil:"", globalTheme:"#42e8ff", developerTitle: {text:'RENOX DEVELOPER',color:'#42e8ff'} } }, null, 2));

function readDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      profiles: d.profiles || {},
      accounts: d.accounts || {},
      friends: d.friends || {},
      dailyClaims: d.dailyClaims || {},
      messages: Array.isArray(d.messages) ? d.messages : [],
      announcements: Array.isArray(d.announcements) ? d.announcements : [],
      leaks: Array.isArray(d.leaks) ? d.leaks : [],
      unbanRequests: Array.isArray(d.unbanRequests) ? d.unbanRequests : [],
      privateMessages: Array.isArray(d.privateMessages) ? d.privateMessages : [],
      statuses: Array.isArray(d.statuses) ? d.statuses : [],
      mutedUsers: d.mutedUsers || {},
      bannedIps: d.bannedIps || {}, ipLog: d.ipLog || {}, noxtok: Array.isArray(d.noxtok) ? d.noxtok : [], follows: d.follows || {},
      settings: { maintenance: Boolean(d.settings?.maintenance), maintenanceReason: cleanText(d.settings?.maintenanceReason,180), maintenanceAffected: cleanText(d.settings?.maintenanceAffected,500), maintenanceUntil: String(d.settings?.maintenanceUntil || ""), globalTheme: d.settings?.globalTheme || "#42e8ff", developerTitle: d.settings?.developerTitle || {text:'RENOX DEVELOPER',color:'#42e8ff'}, pinnedFeature: d.settings?.pinnedFeature || {title:"Coming Soon Board",description:"Fitur baru pilihan developer akan muncul di sini."}, staffUsers: Array.isArray(d.settings?.staffUsers) ? d.settings.staffUsers : [], updatePolicy: { enabled:Boolean(d.settings?.updatePolicy?.enabled), requiredVersion:String(d.settings?.updatePolicy?.requiredVersion||"30.0.1"), downloadUrl:String(d.settings?.updatePolicy?.downloadUrl||""), message:cleanText(d.settings?.updatePolicy?.message,180) } }
    };
  } catch {
    return { profiles: {}, dailyClaims: {}, messages: [], announcements: [], leaks: [], unbanRequests: [], privateMessages: [], statuses: [], mutedUsers: {}, bannedIps:{}, ipLog:{}, noxtok:[], follows:{}, accounts: {}, friends: {}, settings: { maintenance: false, maintenanceReason:"", maintenanceAffected:"", maintenanceUntil:"", globalTheme:"#42e8ff", pinnedFeature:{title:"Coming Soon Board",description:"Fitur baru pilihan developer akan muncul di sini."}, staffUsers:[] } };
  }
}
let db = readDB();
let writeQueue = Promise.resolve();
function saveDB() {
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.then(() => {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, snapshot);
    fs.renameSync(tmp, DB_FILE);
  }).catch(err => console.error("Database save failed:", err));
  return writeQueue;
}
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) { reject(new Error("Request terlalu besar.")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Format JSON tidak valid.")); } });
    req.on("error", reject);
  });
}
function cleanText(value, max) { return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max); }
function validGuestId(id) { return typeof id === "string" && /^[a-f0-9-]{20,80}$/i.test(id); }
function sign(value) { return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex"); }
function cookieMap(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim().split("=")).filter(x => x.length === 2));
}
function isOwner(req) {
  const token = cookieMap(req).renox_owner || "";
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = sign(parts[0]);
  return Number(parts[0]) > Date.now() && parts[1].length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected));
}
function getClientKey(req) { return req.socket.remoteAddress || "unknown"; }
function getClientIp(req) { return String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, ""); }
function getAccountKey(req) { const raw=cookieMap(req).renox_account||"", first=raw.indexOf("."); return first>0?raw.slice(0,first):""; }
function trackIp(req,key) { if(!key)return; const ip=getClientIp(req); db.ipLog=db.ipLog||{}; db.ipLog[key]={ip,lastLogin:Date.now()}; }
let botHeartbeatAt=0;
const rateLimits = new Map();
const tempMailSessions = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now(); let item = rateLimits.get(key);
  if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
  item.count++; rateLimits.set(key, item); return item.count <= limit;
}
const robloxLookupCache = new Map();
async function robloxLookup(query) {
  const cacheKey=String(query).trim().toLowerCase(),cached=robloxLookupCache.get(cacheKey);
  if(cached && Date.now()-cached.at<90000)return cached.data;
  async function getJSON(url, options = {}) {
    let r=await fetch(url, { ...options, headers: { "User-Agent": "Mozilla/5.0 (compatible; RenoxProject/8.4)", "Accept":"application/json", ...(options.headers || {}) }, signal: AbortSignal.timeout(12000) });
    if(r.status===429){const wait=Math.min(5000,Math.max(1000,Number(r.headers.get("retry-after")||2)*1000));await new Promise(resolve=>setTimeout(resolve,wait));r=await fetch(url,{...options,headers:{"User-Agent":"Mozilla/5.0 (compatible; RenoxProject/8.4)","Accept":"application/json",...(options.headers||{})},signal:AbortSignal.timeout(12000)});}
    if (!r.ok) throw new Error(r.status===429?"Roblox sedang membatasi request (429). Tunggu 1–2 menit lalu coba lagi.":"Roblox API error: " + r.status);
    return r.json();
  }
  async function limited(items, concurrency=3){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(true){const i=next++;if(i>=items.length)return;try{out[i]=await items[i]()}catch{out[i]=null}}}));return out;}
  let user;
  if (/^\d+$/.test(query)) user = await getJSON(`https://users.roblox.com/v1/users/${query}`);
  else {
    const result = await getJSON(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(query)}&limit=10`);
    const users = result.data || [];
    const found = users.find(x => (x.name||"").toLowerCase() === query.toLowerCase()) || users.find(x => (x.displayName||"").toLowerCase() === query.toLowerCase()) || users[0];
    if (!found) throw new Error("Username tidak ditemukan.");
    user = await getJSON(`https://users.roblox.com/v1/users/${found.id}`);
  }
  const id = user.id, safe = async (url, options = {}) => { try { return await getJSON(url, options); } catch { return null; } };
  const jobs=[
    ()=>safe(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=720x720&format=Png&isCircular=false`),
    ()=>safe(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=420x420&format=Png&isCircular=false`),
    ()=>safe(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    ()=>safe(`https://friends.roblox.com/v1/users/${id}/followers/count`),
    ()=>safe(`https://friends.roblox.com/v1/users/${id}/followings/count`),
    ()=>safe(`https://accountinformation.roblox.com/v1/users/${id}/roblox-badges?limit=25`),
    ()=>safe(`https://groups.roblox.com/v2/users/${id}/groups/roles`),
    ()=>safe(`https://games.roblox.com/v2/users/${id}/games?accessFilter=Public&sortOrder=Desc&limit=10`),
    ()=>safe(`https://users.roblox.com/v1/users/${id}/status`),
    ()=>safe(`https://presence.roblox.com/v1/presence/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds: [id] }) })
  ];
  const [avatar,headshot,friends,followers,following,badges,groups,games,status,presence]=await limited(jobs,3);
  const groupRows = (groups?.data || []).slice(0,12).map(x => ({name:x.group?.name || "Unknown group", role:x.role?.name || "Member", id:x.group?.id || null}));
  const gameRows = (games?.data || []).slice(0,10).map(x => ({name:x.name || "Untitled experience", visits:x.placeVisits || 0, id:x.id || null}));
  const live = presence?.userPresences?.[0] || null;
  let liveGame = null;
  if (live && live.universeId && Number(live.userPresenceType) === 2) {
    try { const detail = await getJSON(`https://games.roblox.com/v1/games?universeIds=${live.universeId}`); const g = detail.data?.[0]; if (g) liveGame = { name: g.name, rootPlaceId: g.rootPlaceId, universeId: g.id }; } catch {}
  }
  const output={
    user, avatar: avatar?.data?.[0]?.imageUrl || headshot?.data?.[0]?.imageUrl || null, headshot: headshot?.data?.[0]?.imageUrl || null, avatarQuality:"720x720 Roblox thumbnail when available",
    friends: friends?.count ?? null, followers: followers?.count ?? null, following: following?.count ?? null,
    badges: Array.isArray(badges) ? badges.slice(0,25) : [],
    groups: groupRows, games: gameRows, status: status?.status || "",
    presence: { type: live?.userPresenceType ?? 0, online: Number(live?.userPresenceType || 0) > 0, lastLocation: live?.lastLocation || "", game: liveGame }
  };
  robloxLookupCache.set(cacheKey,{at:Date.now(),data:output});if(robloxLookupCache.size>300)robloxLookupCache.delete(robloxLookupCache.keys().next().value);return output;
}

async function publicSearch(query, limit=7) {
  const endpoint = new URL("https://html.duckduckgo.com/html/");
  endpoint.searchParams.set("q", query);
  const r = await fetch(endpoint, {headers:{"User-Agent":"Mozilla/5.0 (compatible; RenoxProject/6.0)","Accept":"text/html"},signal:AbortSignal.timeout(12000)});
  if (!r.ok) throw new Error("Layanan pencarian publik sedang tidak tersedia.");
  const html = await r.text();
  const results = [];
  const blocks = html.match(/<div class="result[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) || [];
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    if (!link) continue;
    const strip = x => String(x||"").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim();
    let href=link[1]; try {const u=new URL(href,"https://duckduckgo.com");href=u.searchParams.get("uddg")||href;}catch{}
    results.push({title:strip(link[2]),url:href,snippet:strip(snippet?.[1]||snippet?.[2]||"")});
    if(results.length>=limit)break;
  }
  return results;
}
async function configuredGameLookup(envName, id, label) {
  const endpoint = process.env[envName];
  if (!endpoint) throw new Error(`${label} Lookup belum dikonfigurasi. Owner perlu memasang endpoint provider API yang sah di environment server.`);
  const url = new URL(endpoint); url.searchParams.set("id", id);
  const response = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "RenoxProject/4.0" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`${label} provider error: ${response.status}`);
  return response.json();
}
async function synoxGet(pathname, params) {
  const endpoint = new URL(`https://api.synoxcloud.xyz${pathname}`);
  for (const [key, value] of Object.entries(params || {})) endpoint.searchParams.set(key, String(value));
  endpoint.searchParams.set("apikey", "FREE");
  const response = await fetch(endpoint, { headers: { "Accept": "application/json", "User-Agent": "RenoxProject/10.2" }, signal: AbortSignal.timeout(18000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) throw new Error(payload.message || `SynoxCloud HTTP ${response.status}`);
  return payload;
}
function isPublicWebUrl(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fe80:)/i.test(host)) return false;
  const m = host.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return false;
  return true;
}

async function redditMemes() {
  const subs = ["memes", "dankmemes", "wholesomememes"];
  const results = await Promise.all(subs.map(async sub => {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=12`, {
        headers: { "User-Agent": "web:renox-gaming-hub:v3.2 (meme feed)" }, signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.data?.children || []).map(x => x.data).filter(p =>
        p && !p.over_18 && !p.stickied && p.post_hint === "image" && /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(p.url || "")
      ).slice(0, 8).map(p => ({ title: cleanText(p.title, 180), image: p.url, permalink: "https://www.reddit.com" + p.permalink, subreddit: p.subreddit, score: p.score }));
    } catch { return []; }
  }));
  return results.flat().sort((a,b) => b.score-a.score).slice(0, 18);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`), route = url.pathname;
    const requestIp=getClientIp(req); if(db.bannedIps?.[requestIp] && !route.startsWith("/api/owner/")) return json(res,403,{error:"Akses dari alamat IP ini dibatasi oleh developer."});
  try {
    if (req.method === "GET" && route === "/api/health") return json(res, 200, { project: "RENOX PROJECT", status: "ONLINE", version: RELEASE.version, uptime: Math.floor(process.uptime()), pid: process.pid });
    if(req.method==="GET"&&route==="/api/bot/events"){
      const configured=String(process.env.RENOX_BOT_TOKEN||"");
      const supplied=String(req.headers["x-renox-bot-token"]||"");
      if(!configured)return json(res,503,{error:"Bot notifier belum dikonfigurasi di server."});
      const a=Buffer.from(configured),b=Buffer.from(supplied);
      if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return json(res,401,{error:"Token bot tidak valid."});
      const since=Math.max(0,Number(url.searchParams.get("since")||0));
      const events=(db.registrationEvents||[]).filter(e=>Number(e.createdAt)>since).slice(0,100);
      return json(res,200,{events,serverTime:Date.now()});
    }
    if (req.method === "GET" && route === "/api/update-policy") { const p=db.settings.updatePolicy||{}; return json(res,200,{enabled:Boolean(p.enabled),requiredVersion:String(p.requiredVersion||"30.0.1"),downloadUrl:String(p.downloadUrl||""),message:cleanText(p.message,180)}); }
    if (req.method === "GET" && route === "/api/updates") {
      return json(res, 200, { current: RELEASE, releases: [RELEASE] });
    }
    if (req.method === "GET" && route === "/api/prayer-times") {
      const city=cleanText(url.searchParams.get("city")||"Tasikmalaya",80);
      if(!city)return json(res,400,{error:"Pilih nama kota terlebih dahulu."});
      const now=new Date();
      const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Jakarta",day:"2-digit",month:"2-digit",year:"numeric"}).formatToParts(now);
      const part=Object.fromEntries(parts.map(x=>[x.type,x.value]));
      const date=`${part.day}-${part.month}-${part.year}`;
      const cacheKey=`prayer-aladhan:${city.toLowerCase()}:${date}`;
      const cached=robloxLookupCache.get(cacheKey);
      if(cached && Date.now()-cached.at<30*60*1000)return json(res,200,cached.data);
      const endpoint=new URL("https://api.aladhan.com/v1/timingsByCity");
      endpoint.searchParams.set("city",city);endpoint.searchParams.set("country","Indonesia");endpoint.searchParams.set("method","20");endpoint.searchParams.set("date",date);
      let payload=null,lastError="";
      for(const host of ["https://api.aladhan.com","https://api.aladhan.com"]){
        try{const target=new URL(endpoint.href.replace("https://api.aladhan.com",host));const r=await fetch(target,{headers:{"Accept":"application/json","User-Agent":"RenoxProject/9.3"},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error(`AlAdhan HTTP ${r.status}`);const data=await r.json();if(data.code!==200||!data.data?.timings)throw new Error(data.status||"Data jadwal tidak ditemukan.");payload=data;break;}catch(e){lastError=e.message||"Provider tidak merespons";}
      }
      if(payload){
        const result={city,date:payload.data.date?.readable||date,timings:payload.data.timings,source:"AlAdhan · metode Kemenag Indonesia (20)",timezone:payload.data.meta?.timezone||"Asia/Jakarta"};
        robloxLookupCache.set(cacheKey,{at:Date.now(),data:result});return json(res,200,result);
      }
      // Provider cadangan Indonesia: MyQuran. Cari ID kota lalu ambil jadwal harian.
      try{
        const cityRes=await fetch(`https://api.myquran.com/v2/sholat/kota/cari/${encodeURIComponent(city)}`,{headers:{"Accept":"application/json","User-Agent":"RenoxProject/9.3"},signal:AbortSignal.timeout(10000)});
        if(!cityRes.ok)throw new Error(`MyQuran city HTTP ${cityRes.status}`);
        const cityData=await cityRes.json();const cityItem=(cityData.data||[]).find(x=>String(x.lokasi||"").toLowerCase().includes(city.toLowerCase()))||(cityData.data||[])[0];
        if(!cityItem?.id)throw new Error("Kota tidak ditemukan di provider cadangan.");
        const [dd,mm,yyyy]=date.split("-");
        const scheduleRes=await fetch(`https://api.myquran.com/v2/sholat/jadwal/${encodeURIComponent(cityItem.id)}/${yyyy}/${mm}/${dd}`,{headers:{"Accept":"application/json","User-Agent":"RenoxProject/9.3"},signal:AbortSignal.timeout(12000)});
        if(!scheduleRes.ok)throw new Error(`MyQuran schedule HTTP ${scheduleRes.status}`);
        const scheduleData=await scheduleRes.json();const j=scheduleData.data?.jadwal;
        if(!scheduleData.status||!j)throw new Error("Provider cadangan tidak mengirim jadwal.");
        const result={city:cityItem.lokasi||city,date:j.tanggal||date,timings:{Fajr:j.subuh,Dhuhr:j.dzuhur,Asr:j.ashar,Maghrib:j.maghrib,Isha:j.isya},source:"MyQuran API · jadwal sholat Indonesia",timezone:"Asia/Jakarta"};
        robloxLookupCache.set(cacheKey,{at:Date.now(),data:result});return json(res,200,result);
      }catch(fallbackError){return json(res,502,{error:`Jadwal sholat belum tersedia. AlAdhan: ${lastError}. MyQuran: ${fallbackError.message||"gagal diakses"}. Pastikan server memiliki akses internet.`});}
    }
    if (req.method === "GET" && route === "/api/checkban") {
      const number=String(url.searchParams.get("number")||"").replace(/\\D/g,"");
      if(!/^\\d{8,15}$/.test(number))return json(res,400,{error:"Nomor harus 8–15 digit dengan kode negara."});
      if(!rateLimit(`checkban:${getClientKey(req)}`,6,60000))return json(res,429,{error:"Terlalu banyak pemeriksaan. Coba lagi sebentar."});
      const d=await fetchBanDetails(number);
      return json(res,200,{number:d.number||number,banned:!!d.banned,permanent:isPermanentBan(d),bannedAt:d.bannedAt||d.banned_at||d.banDate||d.ban_date||d.blockedAt||d.blocked_at||d.date_banned||null,otp_ready:!!d.otp_ready,wa_clone:!!d.wa_clone,status:cleanText(d.status,40),reason:cleanText(d.reason,80),violation_type:cleanText(d.violation_type,30),cooldowns:d.cooldowns||{}});
    }
    if (req.method === "POST" && route === "/api/unban-request") {
      const b=await readBody(req);
      const number=String(b.number||"").replace(/\\D/g,"");
      const reason=cleanText(b.reason,1000);
      const bannedAt=String(b.bannedAt||"");
      const bannedDate=new Date(bannedAt+"T00:00:00Z");
      if(!/^\\d{8,15}$/.test(number))return json(res,400,{error:"Nomor harus 8–15 digit termasuk kode negara."});
      if(reason.length<15)return json(res,400,{error:"Alasan pengajuan minimal 15 karakter."});
      if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(bannedAt)||Number.isNaN(bannedDate.getTime())||bannedDate.toISOString().slice(0,10)!==bannedAt||bannedDate.getTime()>Date.now())return json(res,400,{error:"Tanggal pemblokiran tidak valid atau berada di masa depan."});
      if(!rateLimit(`unban:${getClientKey(req)}`,3,60*60*1000))return json(res,429,{error:"Batas pengajuan tercapai. Coba lagi nanti."});
      const check=await fetchBanDetails(number);
      if(isPermanentBan(check))return json(res,403,{ok:false,code:"PERMANENT_BAN",status:"rejected",number,message:"Unban ditolak: nomor ini tidak bisa dibuka karena banned Permanently."});
      if(!check.banned)return json(res,409,{ok:false,code:"NOT_BANNED",message:"Nomor ini tidak terdeteksi sedang dibanned. Pengajuan tidak dikirim."});
      const duplicate=(db.unbanRequests||[]).find(x=>x.number===number&&x.status==="pending");
      if(duplicate)return json(res,409,{ok:false,code:"PENDING_EXISTS",message:"Pengajuan untuk nomor ini masih menunggu peninjauan.",requestId:duplicate.id});
      const item={id:crypto.randomUUID(),number,reason,bannedAt,status:"pending",createdAt:Date.now(),providerStatus:cleanText(check.status,40),providerReason:cleanText(check.reason,120)};
      db.unbanRequests=db.unbanRequests||[];
      db.unbanRequests.unshift(item);
      db.unbanRequests=db.unbanRequests.slice(0,500);
      await saveDB();
      return json(res,201,{ok:true,status:"submitted",requestId:item.id,number,message:"Pengajuan berhasil dikirim. Silakan tinjau kembali status dan mohon tunggu hingga 6 jam untuk proses peninjauan."});
    }
    if (req.method === "GET" && route === "/api/temp-mail") {
      const action=url.searchParams.get("action")||"new";
      if(!rateLimit(`tempmail:${getClientKey(req)}`,20,60000))return json(res,429,{error:"Terlalu banyak permintaan Temp Mail. Tunggu sebentar."});
      const api="https://api.mail.tm";
      async function mailRequest(pathname,options={}){
        const r=await fetch(api+pathname,{...options,headers:{"Accept":"application/json","Content-Type":"application/json",...(options.token?{Authorization:`Bearer ${options.token}`} : {}),...(options.headers||{})},signal:AbortSignal.timeout(18000)});
        const data=await r.json().catch(()=>({}));
        if(!r.ok)throw new Error(data["hydra:description"]||data.message||`Mail.tm HTTP ${r.status}`);
        return data;
      }
      if(action==="new"){
        const domainData=await mailRequest("/domains");
        const domain=(domainData["hydra:member"]||[]).find(x=>x.isActive&&x.isPrivate===false)?.domain||(domainData["hydra:member"]||[]).find(x=>x.isActive)?.domain;
        if(!domain)throw new Error("Mail.tm tidak menyediakan domain aktif saat ini.");
        const login=`renox${crypto.randomBytes(7).toString("hex")}@${domain}`;
        const password=crypto.randomBytes(24).toString("base64url");
        await mailRequest("/accounts",{method:"POST",body:JSON.stringify({address:login,password})});
        const tokenData=await mailRequest("/token",{method:"POST",body:JSON.stringify({address:login,password})});
        if(!tokenData.token)throw new Error("Token inbox Mail.tm tidak berhasil dibuat.");
        tempMailSessions.set(login,{token:tokenData.token,createdAt:Date.now()});
        if(tempMailSessions.size>500)tempMailSessions.delete(tempMailSessions.keys().next().value);
        return json(res,200,{email:login,login,provider:"Mail.tm"});
      }
      const login=String(url.searchParams.get("login")||"").toLowerCase();
      const session=tempMailSessions.get(login);
      if(!session)return json(res,404,{error:"Sesi email tidak ditemukan. Buat alamat baru setelah server dimulai ulang."});
      if(action==="inbox"){
        const data=await mailRequest("/messages?page=1",{token:session.token});
        return json(res,200,{messages:data["hydra:member"]||[]});
      }
      if(action==="read"){
        const id=String(url.searchParams.get("id")||"");
        if(!/^[-a-f0-9]{1,80}$/i.test(id))return json(res,400,{error:"ID email tidak valid."});
        const data=await mailRequest("/messages/"+encodeURIComponent(id),{token:session.token});
        return json(res,200,data);
      }
      return json(res,400,{error:"Aksi Temp Mail tidak dikenal."});
    }
    if (req.method === "POST" && route === "/api/bot/heartbeat") { if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(requestIp))return json(res,403,{error:"Local bot heartbeat only."}); botHeartbeatAt=Date.now(); return json(res,200,{ok:true}); }
    if (req.method === "GET" && route === "/api/server-stats") {
      const total=os.totalmem(), free=os.freemem(), used=total-free, proc=process.memoryUsage();
      return json(res,200,{panel:process.env.PTERODACTYL?"Pterodactyl":(process.env.PANEL_NAME||"Node.js Server"),cpu:{cores:os.cpus().length,load1:Number((os.loadavg()[0]||0).toFixed(2)),usagePercent:Math.min(100,Math.round((os.loadavg()[0]/Math.max(1,os.cpus().length))*100))},ram:{total,used,free,percent:Math.round(used/total*100)},process:{rss:proc.rss,heapUsed:proc.heapUsed,heapTotal:proc.heapTotal,external:proc.external},uptime:Math.floor(process.uptime()),platform:process.platform,botActive:Date.now()-botHeartbeatAt<45000});
    }
    if (req.method === "GET" && route === "/api/public") return json(res, 200, {
      maintenance: db.settings.maintenance, maintenanceReason: db.settings.maintenanceReason || "", maintenanceAffected: db.settings.maintenanceAffected || "", maintenanceUntil: db.settings.maintenanceUntil || "", maintenanceReasonTitle: "Informasi maintenance", staffUsers: db.settings.staffUsers || [], globalTheme: db.settings.globalTheme || "#42e8ff", pinnedFeature: db.settings.pinnedFeature, announcements: db.announcements.slice(0, 30),
      leaks: db.leaks.slice(0, 30), features: ["Free Fire Lookup", "Mobile Legends Lookup", "Indonesian Memes", "Private Chat", "Orbit Mode", "Wallpaper", "School Schedule", "TikTok Lookup"]
    });
    if (req.method === "GET" && route === "/api/memes") {
      const memes = await redditMemes();
      return json(res, 200, { memes });
    }
    if (req.method === "GET" && route === "/api/memes-id") {
      try {
        const r = await fetch("https://meme-api.com/gimme/indonesia/20", { headers: { "User-Agent": "RenoxProject/4.0" }, signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error("Meme API sedang tidak tersedia.");
        const payload = await r.json();
        const items = (payload.memes || [payload]).filter(x => x && !x.nsfw && x.url && /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(x.url)).slice(0,20).map(x => ({ title: cleanText(x.title,180), image:x.url, permalink:x.postLink || x.url, subreddit:x.subreddit || "indonesia" }));
        return json(res,200,{memes:items});
      } catch (e) { return json(res,502,{error:e.message || "Meme Indonesia belum tersedia."}); }
    }
    if (req.method === "GET" && route === "/api/tiktok") {
      const username = cleanText(url.searchParams.get("username"), 30).replace(/^@+/, "");
      if (!/^[a-zA-Z0-9._]{2,30}$/.test(username)) return json(res,400,{error:"Username TikTok tidak valid."});
      if (!rateLimit(`tiktok:${getClientKey(req)}`, 8, 60000)) return json(res,429,{error:"Terlalu banyak pencarian. Coba lagi sebentar."});
      const payload = await synoxGet("/stalker/tiktokstalk", { user: username });
      const root=payload.data||payload.result||payload;
      const user=root.user||root.userInfo||root.user_info||root.profile||root;
      const stats=root.stats||root.statsV2||user.stats||user.statistics||{};
      const uniqueId=user.uniqueId||user.unique_id||user.username||user.uniqueID||"";
      if ((payload.status===false)||!uniqueId) return json(res,404,{error:payload.message||"Profil TikTok tidak ditemukan atau format data provider berubah."});
      return json(res,200,{user:{uniqueId:cleanText(uniqueId,30),nickname:cleanText(user.nickname||user.displayName||user.name||uniqueId,80),signature:cleanText(user.signature||user.bio||"",300),avatarLarger:user.avatarLarger||user.avatarMedium||user.avatarThumb||user.avatar||user.avatar_url||"",avatarMedium:user.avatarMedium||user.avatar||"",avatarThumb:user.avatarThumb||user.avatar||"",followerCount:Number(stats.followerCount||stats.followers||user.followerCount||0),followingCount:Number(stats.followingCount||stats.following||user.followingCount||0),videoCount:Number(stats.videoCount||stats.videos||user.videoCount||0),heartCount:Number(stats.heartCount||stats.heart||stats.likes||user.heartCount||0),verified:Boolean(user.verified||user.isVerified),privateAccount:Boolean(user.privateAccount||user.isPrivate),region:cleanText(user.region||user.regionCode||"",40),userId:cleanText(user.id||user.uid||user.secUid||"",80),createTime:Number(user.createTime||user.create_time||0)}});
    }
    if (req.method === "GET" && route === "/api/email-public") {
      const email=cleanText(url.searchParams.get("email"),120).toLowerCase();
      if(!/^[^\s@]+@gmail\.com$/.test(email))return json(res,400,{error:"Masukkan alamat Gmail yang valid."});
      if(!rateLimit(`email-public:${getClientKey(req)}`,8,60000))return json(res,429,{error:"Terlalu banyak lookup. Tunggu sebentar."});
      const hash=crypto.createHash("md5").update(email.trim()).digest("hex");
      const avatarUrl=`https://www.gravatar.com/avatar/${hash}?s=160&d=404`;
      let hasPublicAvatar=false;
      try{const r=await fetch(avatarUrl,{method:"HEAD",redirect:"follow",signal:AbortSignal.timeout(5000)});hasPublicAvatar=r.ok;}catch{}
      return json(res,200,{email,hasPublicAvatar,avatarUrl:hasPublicAvatar?avatarUrl:"https://www.gravatar.com/avatar/00000000000000000000000000000000?s=160&d=identicon",accountCreatedAt:null,notice:"Gmail tidak menyediakan tanggal pembuatan akun atau foto profil privat melalui pencarian publik. Avatar hanya dari Gravatar jika dipublikasikan pemilik email."});
    }
    if (req.method === "GET" && route === "/api/google-public") {
      const q = cleanText(url.searchParams.get("q"), 80);
      if (!q || q.length < 2) return json(res,400,{error:"Masukkan nama tampilan atau username publik (minimal 2 karakter)."});
      if (!rateLimit(`google:${getClientKey(req)}`,12,60000)) return json(res,429,{error:"Terlalu banyak pencarian. Coba lagi sebentar."});
      const results = await publicSearch(`"${q}"`,8);
      return json(res,200,{query:q,results,notice:"Hasil hanya berasal dari halaman web publik yang mengandung alamat tersebut. Tidak memeriksa inbox, keberadaan akun, login, atau data privat."});
    }
    if (req.method === "POST" && route === "/api/nexo-ai") {
      const body=await readBody(req), prompt=cleanText(body.prompt,1200);
      if(!prompt)return json(res,400,{error:"Tulis pertanyaan terlebih dahulu."});
      if(!rateLimit(`nexo:${getClientKey(req)}`,8,60000))return json(res,429,{error:"Terlalu banyak permintaan. Tunggu sebentar."});
      const needsWeb=/(terbaru|terkini|hari ini|sekarang|minggu ini|tahun ini|update|berita|harga saat ini|jadwal terbaru)/i.test(prompt);
      let sources=[];
      if(needsWeb){try{sources=await Promise.race([publicSearch(prompt,4),new Promise((_,reject)=>setTimeout(()=>reject(new Error("search-timeout")),4500))]);}catch{sources=[];}}
      const sourceText=sources.map((x,i)=>`${i+1}. ${x.title}: ${x.snippet} (${x.url})`).join("\n");
      const systemPrompt=`Kamu adalah Nexo AI di Renox Project. Jawab dalam bahasa Indonesia yang natural, langsung, jelas, dan tidak bertele-tele. Jangan mengarang fakta. Jika sumber web tidak tersedia, jelaskan keterbatasannya.`;
      const userPrompt=`Pertanyaan: ${prompt}\n${needsWeb?`Sumber web publik (jika tersedia):\n${sourceText||"Tidak ada sumber web yang berhasil ditemukan; jawaban belum diverifikasi."}`:""}`;
      let answer="", provider="", deepseekError="";
      const apiKey=process.env.DEEPSEEK_API_KEY;
      if(apiKey){
        try{
          const response=await fetch("https://api.deepseek.com/chat/completions",{
            method:"POST",
            headers:{"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json","Accept":"application/json"},
            body:JSON.stringify({model:process.env.DEEPSEEK_MODEL||"deepseek-chat",messages:[{role:"system",content:systemPrompt},{role:"user",content:userPrompt}],temperature:0.7,max_tokens:1800}),
            signal:AbortSignal.timeout(35000)
          });
          const payload=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(payload.error?.message||`DeepSeek API HTTP ${response.status}`);
          answer=String(payload.choices?.[0]?.message?.content||"").trim();
          if(!answer)throw new Error("DeepSeek mengirim jawaban kosong.");
          provider="DeepSeek";
        }catch(e){deepseekError=e.message||"DeepSeek gagal";}
      }
      if(!answer){
        // Fallback publik tanpa token. Jangan kirim data rahasia atau informasi pribadi ke layanan ini.
        const fallbackPrompt=`${systemPrompt}\n\n${userPrompt}`;
        const providers=[
          async()=>{const u=new URL("https://text.pollinations.ai/"+encodeURIComponent(fallbackPrompt));u.searchParams.set("model",process.env.NEXO_FREE_MODEL||"openai");const r=await fetch(u,{headers:{"Accept":"text/plain","User-Agent":"RenoxProject/9.3"},signal:AbortSignal.timeout(30000)});const txt=await r.text();if(!r.ok)throw new Error(`Pollinations HTTP ${r.status}`);return txt;},
          async()=>{const r=await fetch("https://text.pollinations.ai/openai",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({messages:[{role:"system",content:systemPrompt},{role:"user",content:userPrompt}],model:process.env.NEXO_FREE_MODEL||"openai"}),signal:AbortSignal.timeout(30000)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`Pollinations POST HTTP ${r.status}`);return j.choices?.[0]?.message?.content||j.response||j.text||"";}
        ];let fallbackErrors=[];
        for(const call of providers){try{const candidate=String(await call()||"").trim();if(candidate){answer=candidate;provider="AI publik tanpa token";break;}}catch(e){fallbackErrors.push(e.message)}}
        if(!answer)throw new Error(`Nexo AI belum terhubung. ${deepseekError?`DeepSeek: ${deepseekError}. `:""}${fallbackErrors.join("; ")||"Provider publik tidak memberi jawaban."} Konfigurasikan DEEPSEEK_API_KEY untuk koneksi yang lebih stabil.`);
      }
      return json(res,200,{answer,sources,provider,notice:provider==="AI publik tanpa token"?"Pesan diproses oleh provider pihak ketiga tanpa token. Hindari mengirim data sensitif.":undefined});
    }
    if (req.method === "GET" && route === "/api/pinterest-search") {
      const q=cleanText(url.searchParams.get("q"),120);
      const offset=Math.max(0,Math.min(500,Number(url.searchParams.get("bookmark")||0)||0));
      if(q.length<2)return json(res,400,{error:"Masukkan kata kunci minimal 2 karakter."});
      if(!rateLimit(`pinterest:${getClientKey(req)}`,12,60000))return json(res,429,{error:"Pencarian terlalu cepat. Tunggu sebentar."});
      const searchUrl=new URL("https://www.pinterest.com/search/pins/");
      searchUrl.searchParams.set("q",q);
      const response=await fetch(searchUrl,{headers:{
        "User-Agent":"Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language":"id-ID,id;q=0.9,en-US;q=0.8"
      },redirect:"follow",signal:AbortSignal.timeout(22000)});
      if(!response.ok)throw new Error(`Pinterest membatasi pencarian tidak resmi (HTTP ${response.status}). Coba lagi nanti.`);
      let html=await response.text();
      html=html.replace(/\\u002F/g,"/").replace(/\\u003A/g,":").replace(/\\\//g,"/").replace(/&amp;/g,"&");
      const found=new Map();
      const addImage=(raw,title="")=>{
        let src=String(raw||"").replace(/\\u002F/g,"/").replace(/\\\//g,"/").replace(/&amp;/g,"&");
        if(!src.startsWith("https://i.pinimg.com/"))return;
        src=src.replace(/\/\d+x\d+\//,"/originals/");
        if(!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(src))return;
        if(!found.has(src))found.set(src,{id:crypto.createHash("sha1").update(src).digest("hex").slice(0,12),title:cleanText(title||q,160),image:src,thumb:src,source:"https://www.pinterest.com/search/pins/?q="+encodeURIComponent(q)});
      };
      const patterns=[
        /"(?:url|src|image_url)"\s*:\s*"(https?:\\?\/\\?\/i\.pinimg\.com[^"]+)"/gi,
        /https?:\\?\/\\?\/i\.pinimg\.com\\?\/(?:originals|[0-9]+x[0-9]+)\\?\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi,
        /(?:src|data-src)="(https:\/\/i\.pinimg\.com\/[^"]+)"/gi
      ];
      for(const re of patterns){let m;while((m=re.exec(html))!==null){const raw=m[1]||m[0];addImage(raw,q);if(found.size>=180)break;}}
      const all=[...found.values()];
      const page=all.slice(offset,offset+20);
      return json(res,200,{query:q,provider:"Pinterest public page · unofficial scraper",results:page,bookmark:all.length>offset+20?String(offset+20):null,hasMore:all.length>offset+20,notice:all.length?"Hasil dari halaman publik Pinterest. Jumlah hasil bergantung pada akses yang diberikan Pinterest.":"Pinterest tidak mengirim gambar yang dapat dibaca; situs dapat sedang membatasi scraper."});
    }
    if (req.method === "GET" && route === "/api/pinterest-download") {
      const raw=url.searchParams.get("url")||"";let imageUrl;
      try{imageUrl=new URL(raw)}catch{return json(res,400,{error:"URL gambar tidak valid."})}
      const allowed=["i.pinimg.com","i.pinimg.com.cdn.cloudflare.net","www.pinterest.com","pinterest.com"];
      if(imageUrl.protocol!=="https:"||!allowed.includes(imageUrl.hostname.toLowerCase()))return json(res,400,{error:"Sumber unduhan bukan CDN Pinterest yang diizinkan."});
      const r=await fetch(imageUrl,{headers:{"User-Agent":"Mozilla/5.0 RenoxProject/8.8","Accept":"image/avif,image/webp,image/png,image/jpeg,*/*"},signal:AbortSignal.timeout(20000)});
      const finalUrl=new URL(r.url);
      if(!r.ok||!allowed.includes(finalUrl.hostname.toLowerCase()))throw new Error("Gambar tidak dapat diunduh dari sumbernya.");
      const type=r.headers.get("content-type")||"";
      if(!type.startsWith("image/"))throw new Error("Sumber tidak mengirim file gambar.");
      const length=Number(r.headers.get("content-length")||0);
      if(length>12*1024*1024)throw new Error("Ukuran gambar terlalu besar (maksimum 12 MB).");
      const bytes=Buffer.from(await r.arrayBuffer());
      if(bytes.length>12*1024*1024)throw new Error("Ukuran gambar terlalu besar (maksimum 12 MB).");
      res.writeHead(200,{"Content-Type":type,"Content-Length":bytes.length,"Content-Disposition":`attachment; filename="renox-pinterest-${Date.now()}.${type.includes("png")?"png":type.includes("webp")?"webp":"jpg"}`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
      return res.end(bytes);
    }
    if (req.method === "GET" && route === "/api/maps-search") {
      const q=cleanText(url.searchParams.get("q"),160);
      if(!q)return json(res,400,{error:"Masukkan nama tempat atau alamat."});
      if(!rateLimit(`maps:${getClientKey(req)}`,10,60000))return json(res,429,{error:"Pencarian peta terlalu cepat. Tunggu sebentar."});
      const endpoint=new URL("https://nominatim.openstreetmap.org/search");
      endpoint.searchParams.set("q",q);endpoint.searchParams.set("format","jsonv2");endpoint.searchParams.set("limit","8");endpoint.searchParams.set("addressdetails","1");
      const r=await fetch(endpoint,{headers:{"User-Agent":"RenoxProject/6.0 (map search)","Accept":"application/json"},signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw new Error("Layanan peta sedang tidak tersedia.");
      const items=(await r.json()).map(x=>({name:x.name||x.display_name.split(",")[0],displayName:x.display_name,lat:Number(x.lat),lon:Number(x.lon),type:x.type||x.class}));
      return json(res,200,{results:items});
    }
    if (req.method === "GET" && route === "/api/music/search") {
      const q=cleanText(url.searchParams.get("q"),100); if(!q)return json(res,400,{error:"Masukkan judul lagu atau nama artis."});
      const variants=[q,q+" official audio",q+" lyric video",q+" slowed",q+" remix"];
      return json(res,200,{provider:"YouTube Search",results:variants.map(term=>({title:term,url:"https://www.youtube.com/results?search_query="+encodeURIComponent(term)}))});
    }
    if (req.method === "GET" && route === "/api/am-finder") {
      const raw=String(url.searchParams.get("url")||"").trim(); let u;
      try{u=new URL(raw)}catch{return json(res,400,{error:"URL video tidak valid."})}
      const host=u.hostname.toLowerCase().replace(/^www\./,"");
      if(u.protocol!=="https:"||!(host==="youtube.com"||host==="youtu.be"||host.endsWith(".youtube.com")||host==="tiktok.com"||host.endsWith(".tiktok.com"))) return json(res,400,{error:"Gunakan URL HTTPS video YouTube atau TikTok publik."});
      let title="", note="";
      try { const meta=await execFile("yt-dlp",["--no-warnings","--no-playlist","--skip-download","--dump-single-json",raw],{timeout:18000,maxBuffer:1024*1024}); const info=JSON.parse(meta.stdout||"{}"); title=cleanText(info.title||info.description||"",180); }
      catch { note="Judul video tidak dapat dibaca oleh server. Hasil pencarian memakai URL video."; }
      const base=title||u.pathname.split("/").filter(Boolean).pop()||u.hostname;
      const terms=[base+" alight motion preset",base+" AM preset XML",base+" preset download",base+" edit preset tutorial"];
      return json(res,200,{title,note,results:terms.map(term=>({title:term,youtube:"https://www.youtube.com/results?search_query="+encodeURIComponent(term),tiktok:"https://www.tiktok.com/search?q="+encodeURIComponent(term)}))});
    }
    if (req.method === "POST" && route === "/api/tiktok-download") {
      const body=await readBody(req), raw=String(body.url||"").trim(); let u;
      try{u=new URL(raw)}catch{return json(res,400,{error:"URL TikTok tidak valid."})}
      const host=u.hostname.toLowerCase().replace(/^www\./,"");
      if(u.protocol!=="https:"||!(host==="tiktok.com"||host.endsWith(".tiktok.com")))return json(res,400,{error:"Masukkan URL video TikTok publik."});
      if(!rateLimit(`tiktok-download:${getClientKey(req)}`,5,60000))return json(res,429,{error:"Terlalu banyak permintaan. Coba lagi sebentar."});
      const upstream=await fetch("https://www.tikwm.com/api/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json","User-Agent":"Mozilla/5.0 RenoxProject/9.3"},body:new URLSearchParams({url:raw,hd:"1"}),signal:AbortSignal.timeout(25000)});
      if(!upstream.ok)return json(res,502,{error:`Provider TikWM merespons HTTP ${upstream.status}.`});
      const payload=await upstream.json(), d=payload.data||{}, video=d.hdplay||d.play||d.wmplay;
      if(payload.code!==0||!video)return json(res,502,{error:payload.msg||"TikTok tidak dapat diproses. Coba tautan publik lain."});
      return json(res,200,{success:true,title:cleanText(d.title||"TikTok video",180),author:cleanText(d.author?.unique_id||"",60),cover:d.cover||"",videoUrl:video,provider:"TikWM"});
    }
    if (req.method === "POST" && route === "/api/video-download") {
      const body=await readBody(req), raw=String(body.url||"").trim(); let u; try{u=new URL(raw)}catch{return json(res,400,{error:"URL tidak valid."})}
      const host=u.hostname.toLowerCase().replace(/^www\./,"");
      if(!["youtube.com","m.youtube.com","youtu.be","tiktok.com","instagram.com"].includes(host) && !host.endsWith(".tiktok.com") && !host.endsWith(".instagram.com")) return json(res,400,{error:"Hanya URL publik YouTube, TikTok, dan Instagram yang didukung."});
      if(u.protocol!=="https:")return json(res,400,{error:"Gunakan URL HTTPS."});
      const file=path.join(os.tmpdir(),"renox-"+crypto.randomUUID()+".mp4");
      try { await execFile("yt-dlp",["--no-playlist","--no-warnings","-f","bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b","--merge-output-format","mp4","-o",file,raw],{timeout:90000,maxBuffer:2*1024*1024});
        if(!fs.existsSync(file))throw new Error("File hasil tidak ditemukan.");
        res.writeHead(200,{"Content-Type":"video/mp4","Content-Disposition":"attachment; filename=renox-video.mp4","Cache-Control":"no-store"}); const stream=fs.createReadStream(file); stream.pipe(res); stream.on("close",()=>fs.promises.unlink(file).catch(()=>{})); stream.on("error",()=>fs.promises.unlink(file).catch(()=>{}));
      } catch(e){fs.promises.unlink(file).catch(()=>{});const msg=String(e.message||"").includes("ENOENT")?"Downloader belum terpasang di server. Pasang yt-dlp dan FFmpeg terlebih dahulu.":"Video tidak dapat diunduh. Pastikan konten publik, tidak dibatasi, dan kamu memiliki izin untuk mengunduhnya.";return json(res,502,{error:msg});}
      return;
    }
    if (req.method === "GET" && route === "/api/telegram-lookup") {
      const username = cleanText(url.searchParams.get("username"), 32).replace(/^@+/, "");
      if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return json(res,400,{error:"Username Telegram tidak valid."});
      if (!rateLimit(`telegram:${getClientKey(req)}`,8,60000)) return json(res,429,{error:"Terlalu banyak pencarian. Coba lagi sebentar."});
      const payload = await synoxGet("/stalker/telegram", { username });
      const r = payload.result || {};
      if (!payload.status || !r.username) return json(res,404,{error:"Preview Telegram publik tidak ditemukan."});
      return json(res,200,{username:r.username,name:cleanText(r.name,100),bio:cleanText(r.bio,500),photo:r.photo||"",subscribers:Number(r.subscribers||0),type:cleanText(r.type,40),profile_url:r.profile_url||`https://t.me/${encodeURIComponent(username)}`,extra:cleanText(r.extra,100),notice:"Hanya metadata profil publik yang dikembalikan provider."});
    }
    if (req.method === "GET" && route === "/api/ml-lookup") {
      const id=cleanText(url.searchParams.get("id"),24), serverId=cleanText(url.searchParams.get("server"),16);
      if(!/^\d{5,20}$/.test(id)||!/^\d{1,10}$/.test(serverId))return json(res,400,{error:"User ID dan Server ID harus berupa angka yang valid."});
      if(!rateLimit(`ml:${getClientKey(req)}`,8,60000))return json(res,429,{error:"Terlalu banyak lookup. Coba lagi sebentar."});
      const payload=await synoxGet("/stalker/mobile-legend",{id,server:serverId});
      if(!payload.status||!payload.result?.id)return json(res,404,{error:"Akun Mobile Legends tidak ditemukan."});
      return json(res,200,{id:String(payload.result.id),server:String(payload.result.server),username:cleanText(payload.result.username,80),region:cleanText(payload.result.region,60)});
    }
    if (req.method === "GET" && route === "/api/web2zip") {
      const target=String(url.searchParams.get("url")||"").trim();
      if(!isPublicWebUrl(target))return json(res,400,{error:"Masukkan URL website publik HTTP/HTTPS. Alamat lokal atau jaringan internal ditolak."});
      if(!rateLimit(`web2zip:${getClientKey(req)}`,3,60000))return json(res,429,{error:"Terlalu banyak proses arsip. Coba lagi sebentar."});
      const payload=await synoxGet("/tools/web2zip",{url:target});
      const result=payload.result||{};
      if(!payload.status||!result.status||!/^https:\/\/copier\.saveweb2zip\.com\/api\/downloadArchive\/[A-Za-z0-9_-]+$/.test(result.download||""))return json(res,502,{error:"Provider tidak menghasilkan arsip ZIP yang valid."});
      return json(res,200,{status:true,md5:cleanText(result.md5,100),copiedFilesAmount:Number(result.copiedFilesAmount||0),download:result.download});
    }
    if (req.method === "GET" && route === "/api/otp-checker") {
      return json(res,403,{status:false,code:"OWNERSHIP_VERIFICATION_REQUIRED",error:"Pemeriksaan OTP dinonaktifkan. Renox tidak dapat mengambil atau menampilkan kode OTP dari nomor yang kepemilikannya belum diverifikasi."});
    }
    if (req.method === "GET" && route === "/api/lookup") {
      const q = cleanText(url.searchParams.get("q"), 50);
      if (!q) return json(res, 400, { error: "Masukkan username atau User ID." });
      if(!rateLimit(`roblox:${getClientKey(req)}`,5,60000))return json(res,429,{error:"Terlalu banyak pencarian Roblox dari koneksi ini. Tunggu 1 menit."});
      return json(res, 200, await robloxLookup(q));
    }
    if (req.method === "GET" && route === "/api/ff-lookup") {
      const id = cleanText(url.searchParams.get("id"), 40);
      if (!id) return json(res, 400, { error: "Masukkan Player ID Free Fire." });
      return json(res, 200, await configuredGameLookup("FF_LOOKUP_API", id, "Free Fire"));
    }
    if (req.method === "GET" && route === "/api/ml-lookup") {
      const id = cleanText(url.searchParams.get("id"), 60);
      if (!id) return json(res, 400, { error: "Masukkan User ID Mobile Legends." });
      return json(res, 200, await configuredGameLookup("ML_LOOKUP_API", id, "Mobile Legends"));
    }
    if (req.method === "POST" && route === "/api/profile") {
      const body = await readBody(req);
      let id = body.guestId;
      if (!validGuestId(id)) return json(res, 400, { error: "Guest ID tidak valid." });

      // Resolve the signed account cookie server-side. Never trust a client-supplied
      // username when a valid Renox account session is present.
      const rawAccount = cookieMap(req).renox_account || "";
      const dot = rawAccount.indexOf(".");
      const accountKey = dot > 0 ? rawAccount.slice(0, dot) : "";
      const token = dot > 0 ? rawAccount.slice(dot + 1) : "";
      const parts = token.split(".");
      const expected = parts.length === 3 ? sign(parts[0] + "|" + accountKey + "|" + parts[1]) : "";
      const account = db.accounts?.[accountKey];
      const sessionValid = parts.length === 3 &&
        Number(parts[0]) > Date.now() &&
        parts[2].length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected)) &&
        account && account.sessionId === parts[1];
      if (sessionValid) {
        const accountGuestId = crypto.createHash("sha256")
          .update("renox-account:" + accountKey).digest("hex").slice(0, 32);
        if (id !== accountGuestId) return json(res, 403, { error: "Profil tidak sesuai dengan akun yang sedang login." });
      }
      const name = sessionValid ? cleanText(account.username, 24) : (cleanText(body.name, 24) || "Guest");
      let avatar = typeof body.avatar === "string" ? body.avatar : "";
      const banner=typeof body.banner==="string"?body.banner:""; const bannerUrl=/^https:\/\/(files\.catbox\.moe|catbox\.moe)\//i.test(banner); const bannerData=/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(banner)&&banner.length<=5_600_000; if(banner && !bannerUrl && !bannerData) return json(res,400,{error:"Banner harus berupa gambar Catbox HTTPS atau gambar PNG/JPG/WebP maksimal 4 MB."});
      if (avatar && !/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatar)) return json(res, 400, { error: "Format foto harus PNG, JPG, WEBP, atau GIF." });
      if (avatar.length > 1_200_000) return json(res, 413, { error: "Ukuran foto maksimal sekitar 900 KB." });
      const old = db.profiles[id] || {};
      db.profiles[id] = { ...old, id, name, avatar: avatar || old.avatar || "", banner: banner || old.banner || "", balance: Number.isFinite(old.balance) ? old.balance : 0, ownedTitles: Array.isArray(old.ownedTitles) ? old.ownedTitles : [], equippedTitle: old.equippedTitle || '', titleColor: /^#[0-9a-f]{6}$/i.test(old.titleColor||'') ? old.titleColor : '#b879ff', createdAt: old.createdAt || Date.now(), updatedAt: Date.now(), lastSeen: Date.now() };
      await saveDB(); return json(res, 200, { profile: db.profiles[id] });
    }
    if (req.method === "GET" && route === "/api/economy") {
      const id=url.searchParams.get("guestId"); if(!validGuestId(id)) return json(res,400,{error:"Guest ID tidak valid."});
      const p=db.profiles[id] || {id,name:"Guest-"+id.slice(0,4),avatar:"",balance:0,ownedTitles:[],equippedTitle:"",titleColor:"#b879ff"};
      return json(res,200,{balance:Number(p.balance||0),ownedTitles:p.ownedTitles||[],equippedTitle:p.equippedTitle||"",titleColor:p.titleColor||"#b879ff",lastDailyClaim:db.dailyClaims[id]||null,shop:[{id:"neon",name:"Neon Elite",price:2500},{id:"royal",name:"Royal Renox",price:5000},{id:"cyber",name:"Cyber Phantom",price:7500}],banner:{name:"Profile Banner",status:"SOON"}});
    }
    if (req.method === "POST" && route === "/api/daily-claim") {
      const body=await readBody(req),id=body.guestId;if(!validGuestId(id))return json(res,400,{error:"Guest ID tidak valid."});
      const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());if(db.dailyClaims[id]===today)return json(res,409,{error:"Daily login hari ini sudah diklaim."});
      const p=db.profiles[id]||(db.profiles[id]={id,name:"Guest-"+id.slice(0,4),avatar:"",createdAt:Date.now(),ownedTitles:[]});p.balance=Number(p.balance||0)+1000;db.dailyClaims[id]=today;await saveDB();return json(res,200,{balance:p.balance,reward:1000});
    }
    if (req.method === "POST" && route === "/api/shop/buy") {
      const body=await readBody(req),id=body.guestId,item=String(body.item||"");if(!validGuestId(id))return json(res,400,{error:"Guest ID tidak valid."});
      const catalog={neon:{name:"Neon Elite",price:2500},royal:{name:"Royal Renox",price:5000},cyber:{name:"Cyber Phantom",price:7500}};const itemData=catalog[item];if(!itemData)return json(res,404,{error:"Item tidak ditemukan."});
      const p=db.profiles[id];if(!p)return json(res,400,{error:"Buat profil terlebih dahulu."});p.ownedTitles=p.ownedTitles||[];if(p.ownedTitles.includes(item))return json(res,409,{error:"Title sudah dimiliki."});if(Number(p.balance||0)<itemData.price)return json(res,400,{error:"Saldo Renox tidak cukup."});p.balance-=itemData.price;p.ownedTitles.push(item);await saveDB();return json(res,200,{balance:p.balance,ownedTitles:p.ownedTitles});
    }
    if (req.method === "POST" && route === "/api/profile/title") {
      const body=await readBody(req),id=body.guestId,item=String(body.item||"");if(!validGuestId(id)||!db.profiles[id])return json(res,400,{error:"Profil tidak ditemukan."});
      const p=db.profiles[id];if(item&&!((p.ownedTitles||[]).includes(item)))return json(res,403,{error:"Title belum dimiliki."});const colors=['#b879ff','#42e8ff','#62e6ad','#ffbd59','#ff6e9f'];const color=String(body.color||'');if(!colors.includes(color))return json(res,400,{error:"Warna tidak tersedia."});p.equippedTitle=item;p.titleColor=color;await saveDB();return json(res,200,{profile:p});
    }
    if (req.method === "GET" && route.startsWith("/api/profile/")) {
      const id = route.slice("/api/profile/".length);
      if (!validGuestId(id)) return json(res, 400, { error: "Guest ID tidak valid." });
      const profile = db.profiles[id];
      return profile ? json(res, 200, { profile: { id: profile.id, name: profile.name, avatar: profile.avatar, banner:profile.banner||"", balance:profile.balance||0, ownedTitles:profile.ownedTitles||[], equippedTitle:profile.equippedTitle||"", titleColor:profile.titleColor||"#b879ff", developerTitle:profile.developerTitle||"", developerTitleColor:profile.developerTitleColor||"#42e8ff", isDeveloper:String(profile.name||"").trim().toLowerCase()==="noxxd", role:String(profile.name||"").trim().toLowerCase()==="noxxd"?"developer":"member", lastSeen: profile.lastSeen } }) : json(res, 404, { error: "Profil guest belum ditemukan." });
    }
    if (req.method === "POST" && route === "/api/presence") {
      const body = await readBody(req);
      if (!validGuestId(body.guestId)) return json(res, 400, { error: "Guest ID tidak valid." });
      let p = db.profiles[body.guestId];
      if (!p) p = db.profiles[body.guestId] = { id: body.guestId, name: "Guest-" + body.guestId.slice(0,4), avatar: "", balance:0, ownedTitles:[], equippedTitle:"", titleColor:"#b879ff", createdAt: Date.now(), updatedAt: Date.now(), lastSeen: Date.now() };
      else p.lastSeen = Date.now();
      const online = Object.values(db.profiles).filter(x => Date.now() - (x.lastSeen || 0) < PRESENCE_TTL);
      await saveDB(); return json(res, 200, { onlineCount: online.length, users: online.slice(0,50).map(x => ({ id:x.id,name:x.name,avatar:x.avatar,role:String(x.name||"").trim().toLowerCase()==="noxxd"?"developer":"member" })) });
    }
    if (req.method === "GET" && route === "/api/members") {
      const q=cleanText(url.searchParams.get("q")||"",40).toLowerCase();
      const viewer=String(url.searchParams.get("guestId")||"");
      const members=Object.values(db.profiles).filter(p=>p&&validGuestId(p.id)&&p.id!==viewer&&(!q||String(p.name||"").toLowerCase().includes(q)));
      members.sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0));
      return json(res,200,{members:members.slice(0,100).map(p=>({id:p.id,name:p.name||"Member",avatar:p.avatar||"",banner:p.banner||"",lastSeen:p.lastSeen||0}))});
    }
    if (req.method === "GET" && route === "/api/friends") {
      const id=String(url.searchParams.get("guestId")||"");
      if(!validGuestId(id))return json(res,400,{error:"Identitas akun tidak valid."});
      const ids=Array.isArray(db.friends?.[id])?db.friends[id]:[];
      const friends=ids.map(friendId=>db.profiles[friendId]).filter(Boolean).map(p=>({id:p.id,name:p.name||"Member",avatar:p.avatar||"",lastSeen:p.lastSeen||0}));
      return json(res,200,{friends});
    }
    if (req.method === "POST" && route === "/api/friends") {
      const b=await readBody(req),id=String(b.guestId||""),target=String(b.targetId||"");
      if(!validGuestId(id)||!validGuestId(target)||id===target||!db.profiles[id]||!db.profiles[target])return json(res,400,{error:"Kontak Renox tidak valid atau tidak ditemukan."});
      db.friends=db.friends||{};db.friends[id]=Array.isArray(db.friends[id])?db.friends[id]:[];
      if(!db.friends[id].includes(target))db.friends[id].unshift(target);
      db.friends[id]=db.friends[id].slice(0,500);await saveDB();return json(res,201,{ok:true});
    }
    if (req.method === "DELETE" && route === "/api/friends") {
      const b=await readBody(req),id=String(b.guestId||""),target=String(b.targetId||"");
      if(!validGuestId(id)||!validGuestId(target))return json(res,400,{error:"Identitas kontak tidak valid."});
      db.friends=db.friends||{};db.friends[id]=(db.friends[id]||[]).filter(x=>x!==target);await saveDB();return json(res,200,{ok:true});
    }

    if (req.method === "GET" && route === "/api/statuses") {
      const viewer=url.searchParams.get("guestId");if(!validGuestId(viewer))return json(res,400,{error:"Guest ID tidak valid."});
      const cutoff=Date.now()-24*60*60*1000;db.statuses=db.statuses.filter(x=>x.createdAt>cutoff);
      return json(res,200,{statuses:db.statuses.slice().sort((a,b)=>a.createdAt-b.createdAt).map(x=>({...x,viewerCount:(x.viewers||[]).length,viewers:(x.guestId===viewer||isOwner(req))?(x.viewers||[]):[]}))});
    }
    if (req.method === "POST" && route === "/api/statuses") {
      const body=await readBody(req),id=body.guestId,text=cleanText(body.text,240),description=cleanText(body.description,500);
      const mediaItems=Array.isArray(body.mediaItems)?body.mediaItems.slice(0,2):(typeof body.media==="string"&&body.media?[{media:body.media,type:body.mediaType}]:[]);
      if(!validGuestId(id))return json(res,400,{error:"Guest ID tidak valid."});
      if(!text&&!description&&!mediaItems.length)return json(res,400,{error:"Status tidak boleh kosong."});
      if(Array.isArray(body.mediaItems)&&body.mediaItems.length>2)return json(res,400,{error:"Satu status maksimal berisi 2 foto/video."});
      const normalized=[];
      for(const item of mediaItems){
        const value=typeof item?.media==="string"?item.media:"",type=["image","video"].includes(item?.type)?item.type:"";
        const mime=value.match(/^data:([^;,]+);base64,/i)?.[1]||"";
        const allowed=type==="video"?/^video\/(mp4|webm|quicktime)$/i.test(mime):type==="image"?/^image\/(jpeg|png|webp|gif)$/i.test(mime):false;
        const encoded=value.split(",")[1]||"",bytes=Math.floor(encoded.length*3/4);
        if(!allowed||!encoded||bytes>5*1024*1024)return json(res,400,{error:"Setiap foto/video harus valid dan maksimal 5 MB."});
        normalized.push({media:value,type});
      }
      const profile=db.profiles[id];if(!profile)return json(res,400,{error:"Simpan profil terlebih dahulu sebelum membuat status."});
      const first=normalized[0]||{};
      const status={id:crypto.randomUUID(),guestId:id,name:profile.name||"Member",avatar:profile.avatar||"",text,description,media:first.media||"",mediaType:first.type||"",mediaItems:normalized,createdAt:Date.now(),viewers:[],likes:[]};
      db.statuses=db.statuses.filter(x=>x.guestId!==id||x.createdAt>Date.now()-24*60*60*1000);db.statuses.push(status);db.statuses=db.statuses.slice(-300);await saveDB();return json(res,201,{status});
    }
    if (req.method === "POST" && route === "/api/statuses/view") {
      const body=await readBody(req),id=body.guestId,status=db.statuses.find(x=>x.id===body.statusId);if(!validGuestId(id))return json(res,400,{error:"Guest ID tidak valid."});if(!status)return json(res,404,{error:"Status sudah kedaluwarsa atau tidak ditemukan."});
      status.viewers=status.viewers||[];if(id!==status.guestId&&!status.viewers.some(v=>v.guestId===id)){const viewer=db.profiles[id]||{name:"Guest"};status.viewers.push({guestId:id,name:viewer.name||"Guest",viewedAt:Date.now()});await saveDB();}
      return json(res,200,{status:{...status,viewerCount:(status.viewers||[]).length,viewers:(id===status.guestId||isOwner(req))?(status.viewers||[]):[]}});
    }
    if (req.method === "POST" && route === "/api/statuses/like") {
      const b=await readBody(req),id=b.guestId,status=db.statuses.find(x=>x.id===b.statusId);
      if(!validGuestId(id)||!status)return json(res,404,{error:"Status tidak ditemukan."});
      status.likes=Array.isArray(status.likes)?status.likes:[];
      const at=status.likes.indexOf(id);if(at>=0)status.likes.splice(at,1);else status.likes.push(id);
      await saveDB();return json(res,200,{liked:status.likes.includes(id),likes:status.likes.length});
    }
    if (req.method === "GET" && route === "/api/chat") {
      const after = Number(url.searchParams.get("after") || 0);
      return json(res, 200, { messages: db.messages.filter(m => m.createdAt > after).slice(-100) });
    }
    if (req.method === "POST" && route === "/api/chat") {
      const body = await readBody(req), id = body.guestId;
      if (!validGuestId(id)) return json(res, 400, { error: "Guest ID tidak valid." });
      const profile = db.profiles[id]; if (!profile) return json(res, 400, { error: "Buat profil guest terlebih dahulu." });
      const message = cleanText(body.message, 500), image = typeof body.image==="string"?body.image:"";
       if (!message&&!image) return json(res, 400, { error: "Pesan tidak boleh kosong." });
       if(image&&(image.length>900000||!/^data:image\/(jpeg|png|webp|gif);base64,/.test(image)))return json(res,400,{error:"Foto tidak valid atau terlalu besar (maks. 650 KB)."});
      if (db.mutedUsers?.[id]) return json(res, 403, { error: "Akun kamu sedang dibisukan oleh developer karena pelanggaran chat." });
      if (!rateLimit(`chat:${id}`, 5, 10000)) return json(res, 429, { error: "Terlalu cepat. Tunggu sebentar." });
      const item = { id: crypto.randomUUID(), guestId: id, name: profile.name, avatar: profile.avatar || "", title: profile.equippedTitle || "", titleColor: profile.titleColor || "#b879ff", developerTitle:profile.developerTitle||"", developerTitleColor:profile.developerTitleColor||"#42e8ff", message, image, createdAt: Date.now() };
      db.messages.push(item);
       if(/^!bot\\b|@renox\\b/i.test(message)){db.messages.push({id:crypto.randomUUID(),guestId:"renox-system-bot",name:"RENOX BOT",avatar:"",title:"",developerTitle:"COMMUNITY BOT",developerTitleColor:"#58e9a7",message:"Halo! Aku RENOX BOT. Aku bisa menyapa dan membantu menjawab pertanyaan sederhana di Global Chat.",createdAt:Date.now()+1});}
       db.messages = db.messages.slice(-300); await saveDB();
      return json(res, 201, { message: item });
    }
    if (req.method === "POST" && route === "/api/noxtok/upload-url") {
      const b = await readBody(req), id = b.guestId;
      if (!validGuestId(id) || !db.profiles[id]) return json(res, 400, { error: "Profil tidak ditemukan." });
      const type = String(b.contentType || "").toLowerCase();
      const allowed = { "video/mp4":"mp4", "video/webm":"webm", "video/quicktime":"mov" };
      const size = Number(b.size || 0);
      if (!allowed[type]) return json(res, 400, { error: "Format video harus MP4, WebM, atau QuickTime." });
      if (!Number.isFinite(size) || size <= 0 || size > NOXTOK_MAX_VIDEO_BYTES) return json(res, 413, { error: `Ukuran video melewati batas server (${Math.round(NOXTOK_MAX_VIDEO_BYTES/1024/1024)} MB).` });
      try {
        const { PutObjectCommand } = require("@aws-sdk/client-s3");
        const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
        const key = `videos/${id}/${Date.now()}-${crypto.randomUUID()}.${allowed[type]}`;
        const command = new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: type });
        const uploadUrl = await getSignedUrl(getR2Client(), command, { expiresIn: 600 });
        return json(res, 200, { uploadUrl, videoUrl: r2PublicUrl(key), objectKey: key, maxBytes: NOXTOK_MAX_VIDEO_BYTES });
      } catch (e) { return json(res, 503, { error: e.message || "Gagal membuat URL upload Cloudflare R2." }); }
    }
    if (req.method === "GET" && route === "/api/noxtok") {
      const viewer=url.searchParams.get("guestId")||"";
      return json(res,200,{videos:(db.noxtok||[]).slice().sort((a,b)=>b.createdAt-a.createdAt).map(v=>({...v,liked:(v.likes||[]).includes(viewer),likes:(v.likes||[]).length,comments:v.comments||[]}))});
    }
    if (req.method === "POST" && route === "/api/noxtok") {
      const b=await readBody(req),id=b.guestId,videoUrl=String(b.videoUrl||""),objectKey=String(b.objectKey||"");
      if(!validGuestId(id)||!db.profiles[id])return json(res,400,{error:"Profil tidak ditemukan."});
      const expectedPrefix=`videos/${id}/`;
      const publicBase=String(process.env.R2_PUBLIC_URL||"").replace(/\/$/,"");
      if(!publicBase||!objectKey.startsWith(expectedPrefix)||!videoUrl.startsWith(publicBase+"/"))return json(res,400,{error:"Referensi video R2 tidak valid. Upload ke Cloudflare R2 terlebih dahulu."});
      const item={id:crypto.randomUUID(),guestId:id,name:db.profiles[id].name||"Member",avatar:db.profiles[id].avatar||"",caption:cleanText(b.caption,180),video:videoUrl,objectKey,likes:[],comments:[],createdAt:Date.now()};
      db.noxtok=db.noxtok||[];db.noxtok.unshift(item);await saveDB();return json(res,201,{video:{...item,liked:false,likes:0}});
    }
    if (req.method === "POST" && route === "/api/noxtok/like") {
      const b=await readBody(req),id=b.guestId,v=(db.noxtok||[]).find(x=>x.id===b.videoId);
      if(!validGuestId(id)||!v)return json(res,404,{error:"Video tidak ditemukan."});
      v.likes=v.likes||[];const i=v.likes.indexOf(id);if(i>=0)v.likes.splice(i,1);else v.likes.push(id);await saveDB();return json(res,200,{liked:v.likes.includes(id),likes:v.likes.length});
    }
    if (req.method === "POST" && route === "/api/noxtok/comment") {
      const b=await readBody(req),id=b.guestId,v=(db.noxtok||[]).find(x=>x.id===b.videoId),comment=cleanText(b.comment,300);
      if(!validGuestId(id)||!v||!comment)return json(res,400,{error:"Komentar tidak valid."});
      v.comments=v.comments||[];v.comments.push({id:crypto.randomUUID(),guestId:id,name:db.profiles[id]?.name||"Member",comment,createdAt:Date.now()});v.comments=v.comments.slice(-100);await saveDB();return json(res,201,{ok:true});
    }
    if (req.method === "POST" && route === "/api/noxtok/follow") {
      const b=await readBody(req),from=b.guestId,to=String(b.targetId||"");
      if(!validGuestId(from)||!validGuestId(to)||from===to)return json(res,400,{error:"Akun tidak valid."});
      db.follows=db.follows||{};db.follows[from]=db.follows[from]||[];const i=db.follows[from].indexOf(to);if(i>=0)db.follows[from].splice(i,1);else db.follows[from].push(to);await saveDB();return json(res,200,{following:db.follows[from].includes(to)});
    }
    if (req.method === "GET" && route === "/api/private-chat") {
      const me=url.searchParams.get("me")||"", peer=url.searchParams.get("with")||"", after=Number(url.searchParams.get("after")||0);
      if (!validGuestId(me) || !validGuestId(peer) || me===peer) return json(res,400,{error:"Identitas chat tidak valid."});
      const messages=db.privateMessages.filter(m=>m.createdAt>after&&((m.from===me&&m.to===peer)||(m.from===peer&&m.to===me))).slice(-100);
      return json(res,200,{messages});
    }
    if (req.method === "POST" && route === "/api/private-chat") {
      const b=await readBody(req),from=b.guestId,to=String(b.to||""),message=cleanText(b.message,500);
      if(!validGuestId(from)||!validGuestId(to)||from===to||!db.profiles[from]||!db.profiles[to])return json(res,400,{error:"Penerima tidak ditemukan atau identitas tidak valid."});
      if(!message)return json(res,400,{error:"Pesan tidak boleh kosong."});
      if(!rateLimit(`dm:${from}`,8,10000))return json(res,429,{error:"Terlalu cepat. Coba lagi sebentar."});
      const item={id:crypto.randomUUID(),from,to,fromName:db.profiles[from].name,toName:db.profiles[to].name,message,createdAt:Date.now()};
      db.privateMessages.push(item);db.privateMessages=db.privateMessages.slice(-2000);await saveDB();return json(res,201,{message:item});
    }
    if (req.method === "GET" && route === "/api/noxtok") {
      const viewer=url.searchParams.get("guestId")||"";
      return json(res,200,{videos:(db.noxtok||[]).slice().sort((a,b)=>b.createdAt-a.createdAt).map(v=>({...v,liked:(v.likes||[]).includes(viewer),likes:(v.likes||[]).length,comments:v.comments||[]}))});
    }
    if (req.method === "POST" && route === "/api/noxtok") {
      const b=await readBody(req),id=b.guestId,video=String(b.video||"");
      if(!validGuestId(id)||!db.profiles[id])return json(res,400,{error:"Profil tidak ditemukan."});
      if(!/^data:video\/(mp4|webm|quicktime);base64,/.test(video)||video.length>1800000)return json(res,400,{error:"Video harus MP4/WebM/QuickTime dan maksimal sekitar 1.3 MB."});
      const item={id:crypto.randomUUID(),guestId:id,name:db.profiles[id].name||"Member",avatar:db.profiles[id].avatar||"",caption:cleanText(b.caption,180),video,likes:[],comments:[],createdAt:Date.now()};
      db.noxtok=db.noxtok||[];db.noxtok.unshift(item);db.noxtok=db.noxtok.slice(0,30);await saveDB();return json(res,201,{video:{...item,liked:false,likes:0}});
    }
    if (req.method === "POST" && route === "/api/noxtok/like") {
      const b=await readBody(req),id=b.guestId,v=(db.noxtok||[]).find(x=>x.id===b.videoId);
      if(!validGuestId(id)||!v)return json(res,404,{error:"Video tidak ditemukan."});
      v.likes=v.likes||[];const i=v.likes.indexOf(id);if(i>=0)v.likes.splice(i,1);else v.likes.push(id);await saveDB();return json(res,200,{liked:v.likes.includes(id),likes:v.likes.length});
    }
    if (req.method === "POST" && route === "/api/noxtok/comment") {
      const b=await readBody(req),id=b.guestId,v=(db.noxtok||[]).find(x=>x.id===b.videoId),comment=cleanText(b.comment,300);
      if(!validGuestId(id)||!v||!comment)return json(res,400,{error:"Komentar tidak valid."});
      v.comments=v.comments||[];v.comments.push({id:crypto.randomUUID(),guestId:id,name:db.profiles[id]?.name||"Member",comment,createdAt:Date.now()});v.comments=v.comments.slice(-100);await saveDB();return json(res,201,{ok:true});
    }
    if (req.method === "POST" && route === "/api/noxtok/follow") {
      const b=await readBody(req),from=b.guestId,to=String(b.targetId||"");
      if(!validGuestId(from)||!validGuestId(to)||from===to)return json(res,400,{error:"Akun tidak valid."});
      db.follows=db.follows||{};db.follows[from]=db.follows[from]||[];const i=db.follows[from].indexOf(to);if(i>=0)db.follows[from].splice(i,1);else db.follows[from].push(to);await saveDB();return json(res,200,{following:db.follows[from].includes(to)});
    }
    if (req.method === "GET" && route === "/api/private-chat") {
      const me=url.searchParams.get("me")||"", peer=url.searchParams.get("with")||"", after=Number(url.searchParams.get("after")||0);
      if (!validGuestId(me) || !validGuestId(peer) || me===peer) return json(res,400,{error:"Identitas chat tidak valid."});
      const messages=db.privateMessages.filter(m=>m.createdAt>after&&((m.from===me&&m.to===peer)||(m.from===peer&&m.to===me))).slice(-100);
      return json(res,200,{messages});
    }
    if (req.method === "POST" && route === "/api/private-chat") {
      const b=await readBody(req),from=b.guestId,to=String(b.to||""),message=cleanText(b.message,500);
      if(!validGuestId(from)||!validGuestId(to)||from===to||!db.profiles[from]||!db.profiles[to])return json(res,400,{error:"Penerima tidak ditemukan atau identitas tidak valid."});
      if(!message)return json(res,400,{error:"Pesan tidak boleh kosong."});
      if(!rateLimit(`dm:${from}`,8,10000))return json(res,429,{error:"Terlalu cepat. Coba lagi sebentar."});
      const item={id:crypto.randomUUID(),from,to,fromName:db.profiles[from].name,toName:db.profiles[to].name,message,createdAt:Date.now()};
      db.privateMessages.push(item);db.privateMessages=db.privateMessages.slice(-2000);await saveDB();return json(res,201,{message:item});
    }

    if (req.method === "POST" && route === "/api/auth/register") {
      const b=await readBody(req), username=cleanText(b.username,24), password=String(b.password||""), remember=!!b.remember;
      if(!/^[A-Za-z0-9_]{3,24}$/.test(username)||password.length<8||password.length>128) return json(res,400,{error:"Username 3-24 karakter; password minimal 8 karakter."});
      const key=username.toLowerCase(); db.accounts=db.accounts||{};
      if(db.accounts[key]) return json(res,409,{error:"Username sudah digunakan."});
      if(db.settings.maintenance) return json(res,503,{error:"RENOX sedang maintenance. Pendaftaran sementara ditutup."});
      const salt=crypto.randomBytes(16).toString("hex"), hash=crypto.scryptSync(password,salt,64).toString("hex"),sid=crypto.randomUUID();
      db.accounts[key]={username,salt,hash,createdAt:Date.now(),sessionId:sid}; db.registrationEvents=Array.isArray(db.registrationEvents)?db.registrationEvents:[]; db.registrationEvents.push({id:crypto.randomUUID(),username,createdAt:Date.now()}); db.registrationEvents=db.registrationEvents.slice(-500); trackIp(req,key); await saveDB();
      const maxAge=remember?2592000:43200, expiry=String(Date.now()+maxAge*1000), token=`${expiry}.${sid}.${sign(expiry+"|"+key+"|"+sid)}`;
      res.writeHead(201,{"Content-Type":"application/json","Set-Cookie":`renox_account=${encodeURIComponent(key)}.${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV==="production"?"; Secure":""}`});
      return res.end(JSON.stringify({ok:true,username}));
    }
    if (req.method === "POST" && route === "/api/auth/login") {
      const b=await readBody(req), username=cleanText(b.username,24), password=String(b.password||""), remember=!!b.remember, key=username.toLowerCase();
      const devUser=process.env.RENOX_DEV_USERNAME||"NoxXd",devPass=process.env.RENOX_DEV_PASSWORD||"AldiGanteng";
      let acc=db.accounts?.[key],developer=username.toLowerCase()===devUser.toLowerCase()&&password===devPass;
      if(developer&&!acc){const salt=crypto.randomBytes(16).toString("hex"),hash=crypto.scryptSync(password,salt,64).toString("hex");db.accounts=db.accounts||{};acc=db.accounts[key]={username,salt,hash,createdAt:Date.now()};}
      if(!acc||password.length>128) return json(res,401,{error:"Username atau password salah."});
      if(!developer){const hash=crypto.scryptSync(password,acc.salt,64),expected=Buffer.from(acc.hash,"hex");if(hash.length!==expected.length||!crypto.timingSafeEqual(hash,expected))return json(res,401,{error:"Username atau password salah."});}
      const isStaff=(db.settings.staffUsers||[]).some(x=>String(x).toLowerCase()===key);
      if(db.settings.maintenance&&!developer&&!isStaff)return json(res,503,{error:"RENOX sedang maintenance. Hanya developer dan staff yang dapat login."});
      const sid=crypto.randomUUID();acc.sessionId=sid;acc.developer=developer;trackIp(req,key);await saveDB();
      const maxAge=remember?2592000:43200,expiry=String(Date.now()+maxAge*1000),token=`${expiry}.${sid}.${sign(expiry+"|"+key+"|"+sid)}`;
      const cookies=[`renox_account=${encodeURIComponent(key)}.${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV==="production"?"; Secure":""}`];
      if(developer){const ownerExpiry=String(Date.now()+7*86400000);cookies.push(`renox_owner=${ownerExpiry}.${sign(ownerExpiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV==="production"?"; Secure":""}`);}
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":cookies});
      return res.end(JSON.stringify({ok:true,username:acc.username,developer,notice:"Jika akun dibuka di perangkat lain, sesi sebelumnya akan keluar."}));
    }
    if(req.method==="GET"&&route==="/api/auth/me"){
      const raw=cookieMap(req).renox_account||"",first=raw.indexOf("."),key=first>0?raw.slice(0,first):"",token=first>0?raw.slice(first+1):"",parts=token.split(".");
      const expected=parts.length===3?sign(parts[0]+"|"+key+"|"+parts[1]):"";
      const valid=parts.length===3&&Number(parts[0])>Date.now()&&parts[2].length===expected.length&&crypto.timingSafeEqual(Buffer.from(parts[2]),Buffer.from(expected));
      const staff=(db.settings.staffUsers||[]).some(x=>String(x).toLowerCase()===key);
      const accountAllowed=!db.settings.maintenance||db.accounts?.[key]?.developer||staff;
      const ok=valid&&db.accounts?.[key]&&db.accounts[key].sessionId===parts[1]&&accountAllowed;
      if(ok&&db.accounts[key].developer){const ownerExpiry=String(Date.now()+7*86400000),ownerToken=ownerExpiry+"."+sign(ownerExpiry);res.setHeader("Set-Cookie","renox_owner="+ownerToken+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800"+(process.env.NODE_ENV==="production"?"; Secure":""));} return json(res,200,{authenticated:!!ok,developer:!!(ok&&db.accounts[key].developer),revoked:!!valid&&!ok&&accountAllowed,blockedByMaintenance:!!valid&&!accountAllowed,maintenance:Boolean(db.settings.maintenance),username:ok?db.accounts[key].username:null,guestId:ok?crypto.createHash("sha256").update("renox-account:"+key).digest("hex").slice(0,32):null});
    }
    if(req.method==="POST"&&route==="/api/auth/logout"){
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":"renox_account=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"});return res.end(JSON.stringify({ok:true}));
    }
    if(req.method==="POST"&&route==="/api/owner/developer-login"){
      const b=await readBody(req), user=String(b.username||""), pass=String(b.password||"");
      const devUser=process.env.RENOX_DEV_USERNAME||"NoxXd", devPass=process.env.RENOX_DEV_PASSWORD||"AldiGanteng";
      const a=Buffer.from(user),bb=Buffer.from(devUser),p=Buffer.from(pass),pp=Buffer.from(devPass);
      if(a.length!==bb.length||p.length!==pp.length||!crypto.timingSafeEqual(a,bb)||!crypto.timingSafeEqual(p,pp))return json(res,401,{error:"Login developer salah."});
      const expiry=String(Date.now()+7*86400000),token=`${expiry}.${sign(expiry)}`;
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":`renox_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV==="production"?"; Secure":""}`});return res.end(JSON.stringify({ok:true}));
    }
    if (req.method === "POST" && route === "/api/owner/session") {
      const body = await readBody(req), supplied = String(body.key || ""), a = Buffer.from(supplied), b = Buffer.from(OWNER_KEY);
      if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return json(res, 401, { error: "Owner key salah." });
      const expiry = String(Date.now() + 7*24*60*60*1000), token = `${expiry}.${sign(expiry)}`;
      res.writeHead(200, { "Content-Type":"application/json", "Cache-Control":"no-store", "Set-Cookie":`renox_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === "production" ? "; Secure" : ""}` });
      return res.end(JSON.stringify({ ok:true, message:"Owner session aktif selama 7 hari." }));
    }
    if (route.startsWith("/api/owner/")) {
      if (!isOwner(req)) return json(res, 401, { error:"Owner access required." });
      if (req.method === "GET" && route === "/api/owner/unban-requests") {
        return json(res,200,{requests:(db.unbanRequests||[]).map(x=>({...x,numberMasked:x.number.replace(/(\\d{3})\\d+(\\d{2})/,"$1••••$2")}))});
      }
      if (req.method === "POST" && route === "/api/owner/unban-requests/review") {
        const b=await readBody(req),id=String(b.id||""),decision=String(b.decision||"");
        const item=(db.unbanRequests||[]).find(x=>x.id===id);
        if(!item)return json(res,404,{error:"Pengajuan unban tidak ditemukan."});
        if(item.status!=="pending")return json(res,409,{error:"Pengajuan ini sudah ditinjau."});
        if(!["approved","rejected"].includes(decision))return json(res,400,{error:"Keputusan harus approved atau rejected."});
        item.status=decision;item.reviewedAt=Date.now();item.reviewNote=cleanText(b.note,500);
        await saveDB();
        return json(res,200,{ok:true,request:item});
      }
      if(req.method==="POST"&&route==="/api/owner/update-policy"){const b=await readBody(req),requiredVersion=cleanText(b.requiredVersion,24),downloadUrl=String(b.downloadUrl||"").trim(),message=cleanText(b.message,180);if(!/^\\d+(?:\\.\\d+){1,3}$/.test(requiredVersion))return json(res,400,{error:"Versi minimum harus format angka, contoh 30.0.1."});if(Boolean(b.enabled)){let u;try{u=new URL(downloadUrl)}catch{return json(res,400,{error:"URL unduhan tidak valid."})}if(u.protocol!=="https:")return json(res,400,{error:"URL unduhan wajib menggunakan HTTPS."})}db.settings.updatePolicy={enabled:Boolean(b.enabled),requiredVersion,downloadUrl,message,updatedAt:Date.now()};await saveDB();return json(res,200,{ok:true,policy:db.settings.updatePolicy})}
      if(req.method==="POST"&&route==="/api/owner/theme"){
        const b=await readBody(req),c=String(b.color||"");
        if(!/^#[0-9a-f]{6}$/i.test(c))return json(res,400,{error:"Warna tema tidak valid."});
        db.settings.globalTheme=c;await saveDB();return json(res,200,{ok:true,color:c});
      }
      if (req.method === "POST" && route === "/api/owner/pinned-feature") {
        const b = await readBody(req), title = cleanText(b.title,60), description = cleanText(b.description,140);
        if (!title || !description) return json(res,400,{error:"Judul dan deskripsi pin wajib diisi."});
        db.settings.pinnedFeature = {title,description,updatedAt:Date.now()}; await saveDB();
        return json(res,200,{ok:true,pinnedFeature:db.settings.pinnedFeature});
      }
      if (req.method === "POST" && route === "/api/owner/developer-title") {
        const b=await readBody(req),id=b.guestId,title=cleanText(b.title,28),color=String(b.color||"");
        if(!validGuestId(id)||!db.profiles[id])return json(res,400,{error:"Profil developer belum ditemukan."});
        if(!title||!/^#[0-9a-f]{6}$/i.test(color))return json(res,400,{error:"Title atau warna tidak valid."});
        db.profiles[id].developerTitle=title;db.profiles[id].developerTitleColor=color;await saveDB();return json(res,200,{ok:true});
      }
      if (req.method === "DELETE" && route.startsWith("/api/owner/chat/")) {
        const id=route.split("/").pop();db.messages=db.messages.filter(m=>m.id!==id);await saveDB();return json(res,200,{ok:true});
      }
      if (req.method === "POST" && route === "/api/owner/chat/mute") {
        const b=await readBody(req),id=String(b.guestId||"");if(!validGuestId(id)||!db.profiles[id])return json(res,400,{error:"Pengguna tidak ditemukan."});
        db.mutedUsers=db.mutedUsers||{};if(b.muted===false)delete db.mutedUsers[id];else db.mutedUsers[id]=true;await saveDB();return json(res,200,{ok:true,muted:Boolean(db.mutedUsers[id])});
      }
      if (req.method === "GET" && route === "/api/owner/stats") {
        const online = Object.values(db.profiles).filter(p => Date.now()-(p.lastSeen||0)<PRESENCE_TTL).length;
        return json(res,200,{ profiles:Object.keys(db.profiles).length, online, messages:db.messages.length, maintenance:db.settings.maintenance, botActive:Date.now()-botHeartbeatAt<45000 });
      }
      if (req.method === "GET" && route === "/api/owner/ip-users") {
        return json(res,200,{users:Object.entries(db.ipLog||{}).map(([username,v])=>({username,ip:v.ip,lastLogin:v.lastLogin,banned:Boolean(db.bannedIps?.[v.ip])}))});
      }
      if (req.method === "POST" && route === "/api/owner/ip-ban") {
        const b=await readBody(req),ip=String(b.ip||"").trim();
        if(!/^(?:\\d{1,3}\\.){3}\\d{1,3}$|^[0-9a-f:]{3,39}$/i.test(ip))return json(res,400,{error:"Alamat IP tidak valid."});
        db.bannedIps=db.bannedIps||{};if(b.banned===false)delete db.bannedIps[ip];else db.bannedIps[ip]={at:Date.now(),reason:cleanText(b.reason,120)||"Diblokir developer"};await saveDB();return json(res,200,{ok:true,banned:Boolean(db.bannedIps[ip])});
      }
      if (req.method === "POST" && route === "/api/owner/staff") {
        const b=await readBody(req),username=cleanText(b.username,24);
        if(!/^[A-Za-z0-9_]{3,24}$/.test(username))return json(res,400,{error:"Username staff tidak valid."});
        db.settings.staffUsers=db.settings.staffUsers||[];const key=username.toLowerCase(),idx=db.settings.staffUsers.findIndex(x=>String(x).toLowerCase()===key);
        if(b.remove){if(idx>=0)db.settings.staffUsers.splice(idx,1);}else if(idx<0)db.settings.staffUsers.push(username);
        await saveDB();return json(res,200,{staffUsers:db.settings.staffUsers});
      }
      if (req.method === "POST" && route === "/api/owner/maintenance") {
        const b = await readBody(req); db.settings.maintenance = Boolean(b.enabled); db.settings.maintenanceReason = cleanText(b.reason,180); db.settings.maintenanceAffected = cleanText(b.affected,500); db.settings.maintenanceUntil = String(b.until || "").slice(0,32); await saveDB();
        return json(res,200,{ ok:true, maintenance:db.settings.maintenance, maintenanceReason:db.settings.maintenanceReason, maintenanceAffected:db.settings.maintenanceAffected, maintenanceUntil:db.settings.maintenanceUntil, botActive:Date.now()-botHeartbeatAt<45000 });
      }
      if (req.method === "POST" && (route === "/api/owner/announcements" || route === "/api/owner/leaks")) {
        const b = await readBody(req), title = cleanText(b.title,100), content = cleanText(b.content,1200);
        if (!title || !content) return json(res,400,{error:"Judul dan isi wajib diisi."});
        const target = route.endsWith("announcements") ? db.announcements : db.leaks;
        target.unshift({ id:crypto.randomUUID(), title, content, createdAt:Date.now(), author:"RENOX OWNER" });
        while(target.length>50)target.pop(); await saveDB(); return json(res,201,{ok:true,item:target[0]});
      }
      if (req.method === "DELETE" && route.startsWith("/api/owner/announcements/")) {
        const id = route.split("/").pop(); db.announcements=db.announcements.filter(x=>x.id!==id); await saveDB(); return json(res,200,{ok:true});
      }
      if (req.method === "DELETE" && route.startsWith("/api/owner/leaks/")) {
        const id = route.split("/").pop(); db.leaks=db.leaks.filter(x=>x.id!==id); await saveDB(); return json(res,200,{ok:true});
      }
      return json(res,404,{error:"Owner endpoint not found."});
    }

    let relative = route === "/" ? "index.html" : decodeURIComponent(route).replace(/^\/+/,"");
    const filePath = path.resolve(PUBLIC,relative);
    if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC+path.sep)) return json(res,403,{error:"Forbidden"});
    fs.readFile(filePath,(err,data)=>{
      if(err){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});return res.end("File not found. Place index.html inside public.");}
      const ext=path.extname(filePath).toLowerCase(), types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml"};
      res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":ext===".html"?"no-store":"public, max-age=3600"});res.end(data);
    });
  } catch(error) {
    console.error(error); if(!res.headersSent)json(res,error.name==="AbortError"?504:400,{error:error.message||"Server error."});else res.end();
  }
});
server.listen(PORT,HOST,()=>{console.log("RENOX PROJECT ONLINE");console.log(`Host: ${HOST}`);console.log(`Port: ${PORT}`);console.log(`Public directory: ${PUBLIC}`);});