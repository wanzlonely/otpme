```javascript
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API_ID = parseInt(process.env.TG_API_ID || "0", 10);
const API_HASH = process.env.TG_API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_SESSION = process.env.TG_SESSION || "";
const OWNER = parseInt(process.env.OWNER_ID || "0", 10);

const CFG_PATH = path.join("/tmp", "userbot_cfg.json");
const AUDIT_PATH = path.join("/tmp", "userbot_audit.log");

const UNLOCK_TTL = 300;
const MAX_FAILS = 5;
const BAN_SECONDS = 600;
const DAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const PRESET_TIMES = ["06:00", "08:00", "12:00", "15:00", "18:00", "21:00"];
const CAT_LABEL = {
  private: "👤 Pribadi",
  group: "👥 Grup",
  channel: "📢 Channel",
  bot: "🤖 Bot"
};

const DEFAULT_CFG = {
  schedules: [],
  interval_min: 0,
  days: [0, 1, 2, 3, 4, 5, 6],
  categories: { private: true, group: true, channel: true, bot: true },
  skip_muted: false,
  exclude: [],
  paused: false,
  daily_report: true,
  pin_hash: null,
  pin_salt: null,
  stats: {},
  last_undo: [],
  last_iv_timestamp: 0,
  last_cron_key: "",
  last_report_date: ""
};

let cfg = loadCfg();
let auth = { until: 0, fails: 0, ban: 0 };

function loadCfg() {
  try {
    if (fs.existsSync(CFG_PATH)) {
      const raw = fs.readFileSync(CFG_PATH, "utf8");
      return Object.assign({}, DEFAULT_CFG, JSON.parse(raw));
    }
  } catch (e) {}
  return Object.assign({}, DEFAULT_CFG);
}

function saveCfg() {
  try {
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {}
}

function audit(event) {
  try {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    fs.appendFileSync(AUDIT_PATH, `${timestamp} | ${event}\n`, "utf8");
  } catch (e) {}
}

function hashPin(pin, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(pin, salt, 32).toString("hex");
}

function setPin(pin) {
  const salt = crypto.randomBytes(16);
  cfg.pin_salt = salt.toString("hex");
  cfg.pin_hash = hashPin(pin, cfg.pin_salt);
  saveCfg();
}

function checkPin(pin) {
  if (!cfg.pin_hash || !cfg.pin_salt) return false;
  const hash = hashPin(pin, cfg.pin_salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(cfg.pin_hash));
}

function unlocked() {
  return Boolean(cfg.pin_hash) && (Date.now() / 1000) < auth.until;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function esc(s, n = 26) {
  if (!s) return "";
  const trimmed = s.length <= n ? s : s.substring(0, n - 1) + "…";
  return trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spark(vals) {
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const top = Math.max(...vals, 1);
  return vals.map(v => v ? bars[Math.min(7, Math.floor((v / top) * 7))] : "▁").join("");
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) {
    res.push(arr.slice(i, i + size));
  }
  return res;
}

function getCategory(dialog) {
  if (dialog.entity && dialog.entity.bot) return "bot";
  if (dialog.isUser) return "private";
  if (dialog.isGroup) return "group";
  return "channel";
}

function isMuted(dialog) {
  try {
    const until = dialog.dialog && dialog.dialog.notifySettings && dialog.dialog.notifySettings.muteUntil;
    if (!until) return false;
    return until * 1000 > Date.now();
  } catch (e) {
    return false;
  }
}

let userClientInstance = null;
async function getUserClient() {
  if (!userClientInstance) {
    const session = new StringSession(TG_SESSION);
    userClientInstance = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 3,
      useWSS: true
    });
    await userClientInstance.connect();
  }
  return userClientInstance;
}

async function pickDialogs() {
  const client = await getUserClient();
  const dialogs = await client.getDialogs({});
  const filtered = [];

  for (const d of dialogs) {
    const dialogId = d.id ? d.id.toString() : "";
    if (cfg.exclude.includes(dialogId)) continue;
    const cat = getCategory(d);
    if (!cfg.categories[cat]) continue;
    if (cfg.skip_muted && isMuted(d)) continue;
    if ((d.unreadCount && d.unreadCount > 0) || (d.unreadMentionsCount && d.unreadMentionsCount > 0)) {
      filtered.push(d);
    }
  }
  return filtered;
}

async function readNow(source) {
  const client = await getUserClient();
  const todo = await pickDialogs();
  const done = [];
  let msgs = 0;

  for (const d of todo) {
    try {
      await client.markAsRead(d.entity);
      done.push(d.id ? d.id.toString() : "");
      msgs += (d.unreadCount || 0);
      await new Promise(r => setTimeout(r, 350));
    } catch (e) {
      if (e.errorMessage === "FLOOD" || e.seconds) {
        await new Promise(r => setTimeout(r, ((e.seconds || 5) + 1) * 1000));
      }
    }
  }

  cfg.last_undo = done;
  const todayKey = new Date().toISOString().split("T")[0];
  if (!cfg.stats[todayKey]) {
    cfg.stats[todayKey] = { runs: 0, chats: 0, msgs: 0 };
  }
  cfg.stats[todayKey].runs += 1;
  cfg.stats[todayKey].chats += done.length;
  cfg.stats[todayKey].msgs += msgs;

  const keys = Object.keys(cfg.stats).sort();
  if (keys.length > 30) {
    for (let i = 0; i < keys.length - 30; i++) {
      delete cfg.stats[keys[i]];
    }
  }

  saveCfg();
  audit(`READ source=${source} chats=${done.length} msgs=${msgs}`);
  return [done.length, msgs];
}

async function undoLast() {
  const client = await getUserClient();
  let n = 0;
  for (const cid of cfg.last_undo) {
    try {
      await client.invoke(new Api.messages.MarkDialogUnread({
        peer: cid,
        unread: true
      }));
      n += 1;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {}
  }
  cfg.last_undo = [];
  saveCfg();
  audit(`UNDO chats=${n}`);
  return n;
}

function homeKeyboard() {
  const kb = new InlineKeyboard();
  kb.text("✅ Baca Semua", "read").text("👁 Pratinjau", "preview").row();
  kb.text("⏰ Jadwal", "sched").text("🗂 Kategori", "cats").text("📅 Hari", "days").row();
  kb.text(`🔕 Muted: ${cfg.skip_muted ? "dilewati" : "ikut"}`, "mute")
    .text(cfg.paused ? "▶️ Lanjutkan" : "⏸ Jeda", "pause").row();
  kb.text("↩️ Undo", "undo").text("📊 Laporan", "rep").text("📜 Log", "log").row();
  kb.text("🔒 Kunci", "lock").row();
  return kb;
}

function backKeyboard() {
  return new InlineKeyboard().text("🏠 Menu", "home");
}

async function screenHome() {
  const todo = await pickDialogs();
  const total = todo.reduce((acc, d) => acc + (d.unreadCount || 0), 0);
  const activeDays = cfg.days.length === 7 ? "Setiap hari" : cfg.days.map(i => DAYS[i]).join(", ") || "—";
  const activeCats = Object.keys(cfg.categories).filter(k => cfg.categories[k]).map(k => CAT_LABEL[k].split(" ")[0]).join(" ") || "—";
  const iv = cfg.interval_min ? `${cfg.interval_min} mnt` : "off";
  const left = Math.max(0, Math.floor(auth.until - Date.now() / 1000));
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");

  const text = `<b>📬 Inbox Control</b>\n` +
    `<blockquote><b>${fmt(total)}</b> pesan belum dibaca\n` +
    `<b>${fmt(todo.length)}</b> chat menunggu</blockquote>\n` +
    `⏰ <b>Jadwal</b> · ${cfg.schedules.join(", ") || "—"}\n` +
    `🔁 <b>Interval</b> · ${iv}\n` +
    `📅 <b>Hari</b> · ${activeDays}\n` +
    `🗂 <b>Kategori</b> · ${activeCats}\n` +
    `${cfg.paused ? "⏸ <b>Dijeda</b>" : "🟢 <b>Aktif</b>"}\n\n` +
    `<i>🔓 Sesi terbuka ${m}:${s}</i>`;

  return [text, homeKeyboard()];
}

function screenSched() {
  const kb = new InlineKeyboard();
  const timeBtns = PRESET_TIMES.map(t => {
    const sel = cfg.schedules.includes(t) ? "✅ " : "▫️ ";
    return { text: sel + t, callback_data: `t:${t}` };
  });
  chunk(timeBtns, 3).forEach(row => {
    row.forEach(b => kb.text(b.text, b.callback_data));
    kb.row();
  });

  const ivs = [["Off", 0], ["30m", 30], ["1j", 60], ["3j", 180]];
  ivs.forEach(([lbl, m]) => {
    const prefix = cfg.interval_min === m ? "🔘 " : "";
    kb.text(prefix + lbl, `iv:${m}`);
  });
  kb.row();
  kb.text("🏠 Menu", "home");

  const text = `<b>⏰ Jadwal Otomatis</b>\n` +
    `<blockquote>Ketuk jam untuk menambah/menghapus.\n` +
    `Jam lain: kirim <code>/jam 07:45</code></blockquote>\n` +
    `Aktif: <b>${cfg.schedules.slice().sort().join(", ") || "—"}</b>`;

  return [text, kb];
}

function screenDays() {
  const kb = new InlineKeyboard();
  const btns = DAYS.map((n, i) => {
    const sel = cfg.days.includes(i) ? "✅ " : "▫️ ";
    return { text: sel + n, callback_data: `d:${i}` };
  });
  chunk(btns, 4).forEach(row => {
    row.forEach(b => kb.text(b.text, b.callback_data));
    kb.row();
  });
  kb.text("🏠 Menu", "home");

  const text = `<b>📅 Hari Aktif</b>\n<blockquote>Jadwal hanya berjalan di hari terpilih.</blockquote>`;
  return [text, kb];
}

function screenCats() {
  const kb = new InlineKeyboard();
  const keys = Object.keys(CAT_LABEL);
  const btns = keys.map(k => {
    const sel = cfg.categories[k] ? "✅ " : "▫️ ";
    return { text: sel + CAT_LABEL[k], callback_data: `c:${k}` };
  });
  chunk(btns, 2).forEach(row => {
    row.forEach(b => kb.text(b.text, b.callback_data));
    kb.row();
  });
  kb.text("🏠 Menu", "home");

  const text = `<b>🗂 Kategori</b>\n<blockquote>Hanya kategori terpilih yang dibaca.</blockquote>`;
  return [text, kb];
}

async function screenPreview() {
  const todo = (await pickDialogs()).sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0));
  if (todo.length === 0) {
    return ["<b>👁 Pratinjau</b>\nSemua sudah bersih 🎉", backKeyboard()];
  }
  const lines = todo.slice(0, 10).map(d => `${String(d.unreadCount || 0).padStart(6, " ")}  ${esc(d.title || d.name || "Chat")}`);
  const more = todo.length > 10 ? `\n… dan ${todo.length - 10} chat lain` : "";
  const kb = new InlineKeyboard().text("✅ Baca Sekarang", "read").row().text("🏠 Menu", "home");
  const text = `<b>👁 Pratinjau</b> · ${todo.length} chat\n<pre>${lines.join("\n")}</pre>${more}`;
  return [text, kb];
}

function screenReport() {
  const today = new Date();
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d);
  }
  const st = dates.map(d => cfg.stats[d.toISOString().split("T")[0]] || {});
  const vals = st.map(s => s.msgs || 0);
  const labels = dates.map(d => DAYS[(d.getDay() + 6) % 7][0]).join(" ");
  const totalMsgs = vals.reduce((a, b) => a + b, 0);
  const totalChats = st.reduce((a, s) => a + (s.chats || 0), 0);
  const totalRuns = st.reduce((a, s) => a + (s.runs || 0), 0);

  const text = `<b>📊 Laporan 7 Hari</b>\n` +
    `<pre>${spark(vals)}\n${labels}</pre>\n` +
    `💬 <b>${fmt(totalMsgs)}</b> pesan · ` +
    `🗨 <b>${fmt(totalChats)}</b> chat · ` +
    `▶️ <b>${fmt(totalRuns)}</b> proses`;

  const kb = new InlineKeyboard()
    .text(`🗓 Laporan harian 21:00: ${cfg.daily_report ? "on" : "off"}`, "repT").row()
    .text("🏠 Menu", "home");

  return [text, kb];
}

function screenLog() {
  let lines = [];
  try {
    if (fs.existsSync(AUDIT_PATH)) {
      lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").slice(-8);
    }
  } catch (e) {}
  const body = esc(lines.map(l => l.substring(5)).join("\n")) || "Belum ada aktivitas";
  return [`<b>📜 Log Aktivitas</b>\n<pre>${body}</pre>`, backKeyboard()];
}

function lockScreen() {
  if (!cfg.pin_hash) {
    return [
      `<b>🔐 Atur PIN dulu</b>\n<blockquote>Kirim <code>/setpin 123456</code>\nPesan akan otomatis dihapus.</blockquote>`,
      null
    ];
  }
  return [
    `<b>🔒 Terkunci</b>\n<blockquote>Kirim <code>/unlock PIN</code> untuk membuka.</blockquote>`,
    null
  ];
}

async function route(act) {
  const parts = act.split(":");
  const kind = parts[0];
  const arg = parts[1];

  if (kind === "t") {
    const idx = cfg.schedules.indexOf(arg);
    if (idx > -1) cfg.schedules.splice(idx, 1);
    else cfg.schedules.push(arg);
    cfg.schedules.sort();
    saveCfg();
    audit(`SCHED toggle ${arg}`);
    return screenSched();
  }
  if (kind === "iv") {
    cfg.interval_min = parseInt(arg, 10);
    saveCfg();
    audit(`INTERVAL ${arg}`);
    return screenSched();
  }
  if (kind === "d") {
    const i = parseInt(arg, 10);
    const idx = cfg.days.indexOf(i);
    if (idx > -1) cfg.days.splice(idx, 1);
    else cfg.days.push(i);
    saveCfg();
    return screenDays();
  }
  if (kind === "c") {
    cfg.categories[arg] = !cfg.categories[arg];
    saveCfg();
    return screenCats();
  }
  if (kind === "mute") {
    cfg.skip_muted = !cfg.skip_muted;
    saveCfg();
    return await screenHome();
  }
  if (kind === "pause") {
    cfg.paused = !cfg.paused;
    saveCfg();
    audit(`PAUSE ${cfg.paused}`);
    return await screenHome();
  }
  if (kind === "repT") {
    cfg.daily_report = !cfg.daily_report;
    saveCfg();
    return screenReport();
  }
  if (kind === "home") return await screenHome();
  if (kind === "sched") return screenSched();
  if (kind === "days") return screenDays();
  if (kind === "cats") return screenCats();
  if (kind === "preview") return await screenPreview();
  if (kind === "rep") return screenReport();
  if (kind === "log") return screenLog();
  if (kind === "read") {
    const [chats, msgs] = await readNow("manual");
    const kb = new InlineKeyboard().text("↩️ Undo", "undo").text("🏠 Menu", "home");
    return [
      `<b>✅ Selesai</b>\n<blockquote><b>${fmt(msgs)}</b> pesan dari <b>${chats}</b> chat ditandai terbaca</blockquote>`,
      kb
    ];
  }
  if (kind === "undo") {
    const n = await undoLast();
    return [
      `<b>↩️ Dikembalikan</b>\n<blockquote>${n} chat ditandai belum dibaca lagi.\n<i>Catatan: hanya tanda biru, jumlah pesan tidak kembali persis.</i></blockquote>`,
      backKeyboard()
    ];
  }
  if (kind === "lock") {
    auth.until = 0;
    return lockScreen();
  }

  return await screenHome();
}

const bot = new Bot(BOT_TOKEN);

async function safeDelete(ctx) {
  try {
    await ctx.deleteMessage();
  } catch (e) {}
}

bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private" || ctx.from.id !== OWNER) return;

  const text = (ctx.message.text || "").trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().split("@")[0];
  const a = parts.slice(1);

  if (cmd === "/setpin") {
    await safeDelete(ctx);
    let newPin = "";
    if (cfg.pin_hash) {
      if (a.length !== 2 || !checkPin(a[0])) {
        return await ctx.reply("❌ Format: /setpin PIN_LAMA PIN_BARU");
      }
      newPin = a[1];
    } else {
      newPin = a[0] || "";
    }

    if (!/^\d{4,12}$/.test(newPin)) {
      return await ctx.reply("PIN harus 4–12 angka.");
    }

    setPin(newPin);
    auth.until = Date.now() / 1000 + UNLOCK_TTL;
    audit("PIN set");
    const [homeTxt, btns] = await screenHome();
    return await ctx.reply("✅ PIN tersimpan.\n\n" + homeTxt, {
      parse_mode: "HTML",
      reply_markup: btns
    });
  }

  if (cmd === "/unlock") {
    await safeDelete(ctx);
    const nowSec = Date.now() / 1000;
    if (nowSec < auth.ban) {
      const rem = Math.ceil((auth.ban - nowSec) / 60);
      return await ctx.reply(`⛔ Terlalu banyak percobaan. Coba ${rem} menit lagi.`);
    }

    if (a.length > 0 && checkPin(a[0])) {
      auth.until = nowSec + UNLOCK_TTL;
      auth.fails = 0;
      audit("UNLOCK ok");
      const [homeTxt, btns] = await screenHome();
      return await ctx.reply(homeTxt, {
        parse_mode: "HTML",
        reply_markup: btns
      });
    }

    auth.fails += 1;
    audit("UNLOCK gagal");
    if (auth.fails >= MAX_FAILS) {
      auth.ban = nowSec + BAN_SECONDS;
      auth.fails = 0;
    }
    return await ctx.reply("❌ PIN salah.");
  }

  if (!unlocked()) {
    const [lTxt] = lockScreen();
    return await ctx.reply(lTxt, { parse_mode: "HTML" });
  }

  if (cmd === "/jam" && a.length > 0) {
    if (!/^\d{2}:\d{2}$/.test(a[0])) {
      return await ctx.reply("Format: /jam 07:45");
    }
    const idx = cfg.schedules.indexOf(a[0]);
    if (idx > -1) cfg.schedules.splice(idx, 1);
    else cfg.schedules.push(a[0]);
    cfg.schedules.sort();
    saveCfg();

    const [sTxt, sBtns] = screenSched();
    return await ctx.reply(sTxt, { parse_mode: "HTML", reply_markup: sBtns });
  }

  const [homeTxt, btns] = await screenHome();
  await ctx.reply(homeTxt, { parse_mode: "HTML", reply_markup: btns });
});

bot.on("callback_query:data", async (ctx) => {
  if (ctx.from.id !== OWNER) {
    return await ctx.answerCallbackQuery();
  }

  if (!unlocked()) {
    return await ctx.answerCallbackQuery({
      text: "🔒 Kirim /unlock PIN dulu",
      show_alert: true
    });
  }

  const act = ctx.callbackQuery.data;
  auth.until = Date.now() / 1000 + UNLOCK_TTL;
  await ctx.answerCallbackQuery();

  try {
    if (act === "read") {
      await ctx.editMessageText("⏳ <b>Membaca semua chat…</b>", { parse_mode: "HTML" });
    }
    const [txt, btns] = await route(act);
    await ctx.editMessageText(txt, {
      parse_mode: "HTML",
      reply_markup: btns || undefined
    });
  } catch (e) {}
});

async function runCronTask() {
  if (cfg.paused) return;

  const now = new Date();
  const dayIndex = (now.getDay() + 6) % 7;
  if (!cfg.days.includes(dayIndex)) return;

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const hhmm = `${hh}:${mm}`;
  const dateStr = now.toISOString().split("T")[0];
  const currentKey = `${dateStr}_${hhmm}`;

  let fire = false;

  if (cfg.schedules.includes(hhmm) && cfg.last_cron_key !== currentKey) {
    cfg.last_cron_key = currentKey;
    fire = true;
  }

  const nowMs = Date.now();
  if (cfg.interval_min > 0) {
    if (!cfg.last_iv_timestamp) cfg.last_iv_timestamp = nowMs;
    if (nowMs - cfg.last_iv_timestamp >= cfg.interval_min * 60 * 1000) {
      cfg.last_iv_timestamp = nowMs;
      fire = true;
    }
  }

  if (fire) {
    const [chats, msgs] = await readNow("jadwal");
    if (chats > 0) {
      const undoKb = new InlineKeyboard().text("↩️ Undo", "undo").text("🏠 Menu", "home");
      await bot.api.sendMessage(
        OWNER,
        `<b>⏰ Terjadwal</b>\n✅ <b>${fmt(msgs)}</b> pesan · ${chats} chat dibaca`,
        { parse_mode: "HTML", reply_markup: undoKb }
      );
    }
  }

  if (cfg.daily_report && hhmm === "21:00" && cfg.last_report_date !== dateStr) {
    cfg.last_report_date = dateStr;
    const [repTxt] = screenReport();
    await bot.api.sendMessage(OWNER, repTxt, { parse_mode: "HTML" });
  }

  saveCfg();
}

module.exports = async (req, res) => {
  if (req.method === "GET" && req.url.includes("/api/cron")) {
    await runCronTask();
    return res.status(200).json({ status: "ok", executed: true });
  }

  if (req.method === "POST") {
    const handleWebhook = webhookCallback(bot, "express");
    return handleWebhook(req, res);
  }

  return res.status(200).send("Inbox Control Bot Running on Vercel");
};
```