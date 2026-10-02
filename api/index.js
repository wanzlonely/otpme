const { Bot, InlineKeyboard } = require("grammy");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { kv } = require("@vercel/kv");

const API_ID = parseInt(process.env.TG_API_ID || "0", 10);
const API_HASH = process.env.TG_API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_SESSION = process.env.TG_SESSION || "";
const OWNER_ID = parseInt(process.env.OWNER_ID || "0", 10);

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
  auto_archive: false,
  exclude: [],
  paused: false,
  daily_report: true,
  stats: {},
  last_undo: []
};

async function loadCfg() {
  try {
    const data = await kv.get("userbot_config");
    if (!data) return { ...DEFAULT_CFG };
    return { ...DEFAULT_CFG, ...data };
  } catch (e) {
    return { ...DEFAULT_CFG };
  }
}

async function saveCfg(cfg) {
  try {
    await kv.set("userbot_config", cfg);
  } catch (e) {}
}

async function appendLog(event) {
  try {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    const logLine = `${timestamp} | ${event}`;
    let logs = (await kv.get("userbot_logs")) || [];
    logs.push(logLine);
    if (logs.length > 15) logs = logs.slice(-15);
    await kv.set("userbot_logs", logs);
  } catch (e) {}
}

function fmt(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function esc(s, n = 24) {
  if (!s) return "";
  const str = s.length <= n ? s : s.substring(0, n - 1) + "…";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spark(vals) {
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const top = Math.max(...vals, 1);
  return vals.map(v => (v ? bars[Math.min(7, Math.floor((v / top) * 7))] : "▁")).join("");
}

async function getClient() {
  const client = new TelegramClient(new StringSession(TG_SESSION), API_ID, API_HASH, {
    connectionRetries: 3
  });
  await client.connect();
  return client;
}

function getCategory(dialog) {
  if (dialog.entity && dialog.entity.bot) return "bot";
  if (dialog.isUser) return "private";
  if (dialog.isGroup) return "group";
  return "channel";
}

function isMuted(dialog) {
  if (!dialog.dialog || !dialog.dialog.notifySettings) return false;
  const until = dialog.dialog.notifySettings.muteUntil;
  if (!until) return false;
  return until * 1000 > Date.now();
}

async function pickDialogs(client, cfg) {
  const dialogs = await client.getDialogs({ limit: 100 });
  const out = [];
  for (const d of dialogs) {
    const dId = d.id.toString();
    const cat = getCategory(d);
    if (cfg.exclude.includes(dId) || !cfg.categories[cat]) continue;
    if (cfg.skip_muted && isMuted(d)) continue;
    if (d.unreadCount > 0 || d.unreadMentionsCount > 0) {
      out.push(d);
    }
  }
  return out;
}

async function readNow(source) {
  const cfg = await loadCfg();
  const client = await getClient();
  const done = [];
  let totalMsgs = 0;

  try {
    const dialogs = await pickDialogs(client, cfg);
    for (const d of dialogs) {
      try {
        await client.markAsRead(d.entity);
        if (cfg.auto_archive && !d.archived) {
          await client.invoke(
            new Api.folders.EditPeerFolders({
              folderPeers: [
                new Api.InputFolderPeer({
                  peer: d.inputEntity,
                  folderId: 1
                })
              ]
            })
          );
        }
        done.push(d.id.toString());
        totalMsgs += d.unreadCount;
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {}
    }

    cfg.last_undo = done;
    const today = new Date().toISOString().split("T")[0];
    if (!cfg.stats[today]) cfg.stats[today] = { runs: 0, chats: 0, msgs: 0 };
    cfg.stats[today].runs += 1;
    cfg.stats[today].chats += done.length;
    cfg.stats[today].msgs += totalMsgs;

    await saveCfg(cfg);
    await appendLog(`READ src=${source} chats=${done.length} msgs=${totalMsgs}`);
    return { chats: done.length, msgs: totalMsgs };
  } finally {
    await client.disconnect();
  }
}

async function undoLast() {
  const cfg = await loadCfg();
  if (!cfg.last_undo || cfg.last_undo.length === 0) return 0;
  const client = await getClient();
  let count = 0;

  try {
    for (const cid of cfg.last_undo) {
      try {
        const ent = await client.getInputEntity(cid);
        await client.invoke(
          new Api.messages.MarkDialogUnread({
            peer: new Api.InputDialogPeer({ peer: ent }),
            unread: true
          })
        );
        count++;
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {}
    }
    cfg.last_undo = [];
    await saveCfg(cfg);
    await appendLog(`UNDO chats=${count}`);
    return count;
  } finally {
    await client.disconnect();
  }
}

function buildHomeKeyboard(cfg) {
  const kb = new InlineKeyboard();
  kb.text("⚡ Baca Semua", "read").text("👁 Pratinjau", "preview").row();
  kb.text("⏰ Atur Jadwal", "sched").text("🗂 Atur Kategori", "cats").row();
  kb.text("📅 Atur Hari", "days").text(`🔕 Muted: ${cfg.skip_muted ? "Dilewati" : "Ikut"}`, "mute").row();
  kb.text(`📦 Archive: ${cfg.auto_archive ? "ON" : "OFF"}`, "archive").text(cfg.paused ? "▶️ Lanjutkan" : "⏸ Jeda System", "pause").row();
  kb.text("📊 Laporan 7 Hari", "rep").text("📜 Log Aktivitas", "log").row();
  kb.text("↩️ Urungkan (Undo)", "undo").text("🔄 Refresh Panel", "home").row();
  return kb;
}

function backKeyboard() {
  return new InlineKeyboard().text("🏠 Kembali Ke Menu Utama", "home");
}

async function renderHome(cfg) {
  const client = await getClient();
  let totalMsgs = 0;
  let todoCount = 0;
  try {
    const dialogs = await pickDialogs(client, cfg);
    todoCount = dialogs.length;
    totalMsgs = dialogs.reduce((acc, curr) => acc + curr.unreadCount, 0);
  } finally {
    await client.disconnect();
  }

  const activeDays = cfg.days.length === 7 ? "Setiap Hari" : cfg.days.map(i => DAYS[i]).join(", ") || "—";
  const activeCats = Object.keys(cfg.categories).filter(k => cfg.categories[k]).map(k => CAT_LABEL[k].split(" ")[0]).join(" ") || "—";
  const ivStr = cfg.interval_min ? `${cfg.interval_min} Mnt` : "Off";

  const text =
    "⚡ <b>USERBOT INBOX CONTROL v3.0</b>\n" +
    "───────────────────────────\n" +
    "📌 <b>STATUS INBOX SAAT INI</b>\n" +
    `├ 💬 <b>Total Pesan:</b> <code>${fmt(totalMsgs)}</code>\n` +
    `└ 🗨 <b>Chat Pending:</b> <code>${fmt(todoCount)}</code>\n\n` +
    "⚙️ <b>KONFIGURASI SISTEM</b>\n" +
    `├ ⏰ <b>Jadwal:</b> <code>${cfg.schedules.join(", ") || "—"}</code>\n` +
    `├ 🔁 <b>Interval:</b> <code>${ivStr}</code>\n` +
    `├ 📅 <b>Hari:</b> <code>${activeDays}</code>\n` +
    `├ 🗂 <b>Kategori:</b> ${activeCats}\n` +
    `├ 🔕 <b>Muted Chat:</b> <code>${cfg.skip_muted ? "Dilewati" : "Ikut"}</code>\n` +
    `├ 📦 <b>Auto Archive:</b> <code>${cfg.auto_archive ? "ON" : "OFF"}</code>\n` +
    `└ 🚀 <b>Status Bot:</b> ${cfg.paused ? "⏸ <b>Dijeda</b>" : "🟢 <b>Aktif</b>"}\n` +
    "───────────────────────────";

  return { text, reply_markup: buildHomeKeyboard(cfg) };
}

function renderSched(cfg) {
  const kb = new InlineKeyboard();

  for (let i = 0; i < PRESET_TIMES.length; i += 2) {
    const t1 = PRESET_TIMES[i];
    const t2 = PRESET_TIMES[i + 1];
    kb.text((cfg.schedules.includes(t1) ? "✅ " : "▫️ ") + t1, `t:${t1}`);
    if (t2) kb.text((cfg.schedules.includes(t2) ? "✅ " : "▫️ ") + t2, `t:${t2}`);
    kb.row();
  }

  const ivs = [
    { label: "Off", val: 0 },
    { label: "15m", val: 15 },
    { label: "30m", val: 30 },
    { label: "1j", val: 60 }
  ];
  ivs.forEach(item => {
    const mark = cfg.interval_min === item.val ? "🔘 " : "";
    kb.text(`${mark}${item.label}`, `iv:${item.val}`);
  });
  kb.row();
  kb.text("🏠 Kembali Ke Menu Utama", "home");

  const text =
    "⏰ <b>PENGATURAN JADWAL OTOMATIS</b>\n" +
    "───────────────────────────\n" +
    "Pilih waktu jam atau interval di bawah.\n" +
    "Tambah jam khusus: <code>/jam 07:45</code>\n\n" +
    `Aktif Saat Ini: <b>${cfg.schedules.sort().join(", ") || "—"}</b>\n` +
    "───────────────────────────";

  return { text, reply_markup: kb };
}

function renderDays(cfg) {
  const kb = new InlineKeyboard();
  for (let i = 0; i < DAYS.length; i += 2) {
    const d1 = DAYS[i];
    const d2 = DAYS[i + 1];
    kb.text((cfg.days.includes(i) ? "✅ " : "▫️ ") + d1, `d:${i}`);
    if (d2) kb.text((cfg.days.includes(i + 1) ? "✅ " : "▫️ ") + d2, `d:${i + 1}`);
    kb.row();
  }
  kb.text("🏠 Kembali Ke Menu Utama", "home");

  return {
    text: "📅 <b>PENGATURAN HARI AKTIF</b>\n───────────────────────────\nKetuk hari untuk mengaktifkan atau menonaktifkan pemrosesan otomatis.",
    reply_markup: kb
  };
}

function renderCats(cfg) {
  const kb = new InlineKeyboard();
  const keys = Object.keys(CAT_LABEL);
  for (let i = 0; i < keys.length; i += 2) {
    const k1 = keys[i];
    const k2 = keys[i + 1];
    kb.text((cfg.categories[k1] ? "✅ " : "▫️ ") + CAT_LABEL[k1], `c:${k1}`);
    if (k2) kb.text((cfg.categories[k2] ? "✅ " : "▫️ ") + CAT_LABEL[k2], `c:${k2}`);
    kb.row();
  }
  kb.text("🏠 Kembali Ke Menu Utama", "home");

  return {
    text: "🗂 <b>PENGATURAN KATEGORI CHAT</b>\n───────────────────────────\nHanya kategori dengan tanda centang (✅) yang akan dibaca.",
    reply_markup: kb
  };
}

async function renderPreview(cfg) {
  const client = await getClient();
  let todo = [];
  try {
    todo = await pickDialogs(client, cfg);
    todo.sort((a, b) => b.unreadCount - a.unreadCount);
  } finally {
    await client.disconnect();
  }

  const kb = new InlineKeyboard();
  if (todo.length === 0) {
    kb.text("🏠 Kembali Ke Menu Utama", "home");
    return { text: "👁 <b>PRATINJAU INBOX</b>\n───────────────────────────\n✨ Semua inbox kamu sudah bersih sempurna!", reply_markup: kb };
  }

  const lines = todo.slice(0, 10).map(d => `${String(d.unreadCount).padStart(5, " ")}  ${esc(d.name)}`);
  const more = todo.length > 10 ? `\n… dan ${todo.length - 10} chat lainnya` : "";

  kb.text("⚡ Baca Sekarang", "read").row().text("🏠 Kembali Ke Menu Utama", "home");

  return {
    text: `👁 <b>PRATINJAU INBOX</b> (${todo.length} Chat Pending)\n───────────────────────────\n<pre>` + lines.join("\n") + `</pre>${more}`,
    reply_markup: kb
  };
}

function renderReport(cfg) {
  const dates = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }

  const statsList = dates.map(d => cfg.stats[d] || { runs: 0, chats: 0, msgs: 0 });
  const vals = statsList.map(s => s.msgs);
  const totalMsgs = vals.reduce((a, b) => a + b, 0);
  const totalChats = statsList.reduce((a, b) => a + b.chats, 0);
  const totalRuns = statsList.reduce((a, b) => a + b.runs, 0);

  const labels = dates.map(d => DAYS[new Date(d).getDay() === 0 ? 6 : new Date(d).getDay() - 1][0]).join(" ");

  const kb = new InlineKeyboard()
    .text(`🗓 Laporan Harian 21:00: ${cfg.daily_report ? "ON" : "OFF"}`, "repT").row()
    .text("🏠 Kembali Ke Menu Utama", "home");

  const text =
    "📊 <b>LAPORAN PEMBACAAN 7 HARI</b>\n" +
    "───────────────────────────\n" +
    `<pre>${spark(vals)}\n${labels}</pre>\n\n` +
    `💬 <b>Total Pesan:</b> <code>${fmt(totalMsgs)}</code>\n` +
    `🗨 <b>Total Chat:</b> <code>${fmt(totalChats)}</code>\n` +
    `▶️ <b>Total Eksekusi:</b> <code>${totalRuns} kali</code>\n` +
    "───────────────────────────";

  return { text, reply_markup: kb };
}

async function renderLog() {
  const logs = (await kv.get("userbot_logs")) || [];
  const body = logs.length > 0 ? logs.map(l => esc(l.substring(5))).join("\n") : "Belum ada catatan aktivitas";
  return {
    text: `📜 <b>LOG AKTIVITAS TERAKHIR</b>\n───────────────────────────\n<pre>${body}</pre>`,
    reply_markup: backKeyboard()
  };
}

async function routeAction(act, cfg) {
  const [kind, arg] = act.split(":");

  if (kind === "t") {
    if (cfg.schedules.includes(arg)) {
      cfg.schedules = cfg.schedules.filter(x => x !== arg);
    } else {
      cfg.schedules.push(arg);
      cfg.schedules.sort();
    }
    await saveCfg(cfg);
    await appendLog(`SCHED toggle ${arg}`);
    return renderSched(cfg);
  }

  if (kind === "iv") {
    cfg.interval_min = parseInt(arg, 10);
    await saveCfg(cfg);
    await appendLog(`INTERVAL ${arg}`);
    return renderSched(cfg);
  }

  if (kind === "d") {
    const idx = parseInt(arg, 10);
    if (cfg.days.includes(idx)) {
      cfg.days = cfg.days.filter(x => x !== idx);
    } else {
      cfg.days.push(idx);
    }
    await saveCfg(cfg);
    return renderDays(cfg);
  }

  if (kind === "c") {
    cfg.categories[arg] = !cfg.categories[arg];
    await saveCfg(cfg);
    return renderCats(cfg);
  }

  if (kind === "mute") {
    cfg.skip_muted = !cfg.skip_muted;
    await saveCfg(cfg);
    return renderHome(cfg);
  }

  if (kind === "archive") {
    cfg.auto_archive = !cfg.auto_archive;
    await saveCfg(cfg);
    return renderHome(cfg);
  }

  if (kind === "pause") {
    cfg.paused = !cfg.paused;
    await saveCfg(cfg);
    await appendLog(`PAUSE ${cfg.paused}`);
    return renderHome(cfg);
  }

  if (kind === "repT") {
    cfg.daily_report = !cfg.daily_report;
    await saveCfg(cfg);
    return renderReport(cfg);
  }

  if (kind === "home") return renderHome(cfg);
  if (kind === "sched") return renderSched(cfg);
  if (kind === "days") return renderDays(cfg);
  if (kind === "cats") return renderCats(cfg);
  if (kind === "preview") return renderPreview(cfg);
  if (kind === "rep") return renderReport(cfg);
  if (kind === "log") return renderLog();

  if (kind === "read") {
    const res = await readNow("manual");
    const kb = new InlineKeyboard().text("↩️ Urungkan (Undo)", "undo").text("🏠 Menu Utama", "home");
    return {
      text: `✅ <b>PEMBACAAN SELESAI</b>\n───────────────────────────\nBerhasil menandai <b>${fmt(res.msgs)}</b> pesan di <b>${res.chats}</b> chat sebagai terbaca.`,
      reply_markup: kb
    };
  }

  if (kind === "undo") {
    const count = await undoLast();
    return {
      text: `↩️ <b>PEMBATALAN SELESAI</b>\n───────────────────────────\nSebanyak <b>${count}</b> chat telah ditandai belum dibaca kembali.`,
      reply_markup: backKeyboard()
    };
  }

  return renderHome(cfg);
}

const bot = new Bot(BOT_TOKEN);

bot.on("message", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;

  const text = (ctx.message.text || "").trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1);

  const cfg = await loadCfg();

  if (cmd === "/jam" && args[0]) {
    if (!/^\d{2}:\d{2}$/.test(args[0])) {
      return ctx.reply("Format jam salah! Gunakan: <code>/jam 07:45</code>", { parse_mode: "HTML" });
    }
    if (cfg.schedules.includes(args[0])) {
      cfg.schedules = cfg.schedules.filter(x => x !== args[0]);
    } else {
      cfg.schedules.push(args[0]);
      cfg.schedules.sort();
    }
    await saveCfg(cfg);
    const screen = renderSched(cfg);
    return ctx.reply(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
  }

  if (cmd === "/exclude" && args[0]) {
    const idStr = args[0];
    if (cfg.exclude.includes(idStr)) {
      cfg.exclude = cfg.exclude.filter(x => x !== idStr);
      await ctx.reply(`ID <code>${idStr}</code> dihapus dari daftar pengecualian.`, { parse_mode: "HTML" });
    } else {
      cfg.exclude.push(idStr);
      await ctx.reply(`ID <code>${idStr}</code> ditambahkan ke daftar pengecualian.`, { parse_mode: "HTML" });
    }
    await saveCfg(cfg);
    return;
  }

  if (cmd === "/resetstats") {
    cfg.stats = {};
    await saveCfg(cfg);
    return ctx.reply("✅ Data statistik berhasil dibersihkan.");
  }

  const screen = await renderHome(cfg);
  return ctx.reply(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
});

bot.on("callback_query:data", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.answerCallbackQuery();
  }

  const cfg = await loadCfg();
  await ctx.answerCallbackQuery();

  const act = ctx.callbackQuery.data;
  try {
    if (act === "read") {
      await ctx.editMessageText("⏳ <b>Sedang memproses pembacaan inbox…</b>", { parse_mode: "HTML" });
    }
    const screen = await routeAction(act, cfg);
    await ctx.editMessageText(screen.text, {
      reply_markup: screen.reply_markup,
      parse_mode: "HTML"
    });
  } catch (e) {}
});

module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      await bot.init();
      await bot.handleUpdate(req.body);
      res.statusCode = 200;
      return res.end("OK");
    } catch (err) {
      res.statusCode = 500;
      return res.end(err.message);
    }
  }

  res.statusCode = 200;
  res.end("Inbox Control Bot v3.0 (Owner Only - No Cron - No PIN) Active");
};
