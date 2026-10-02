const { Bot, InlineKeyboard } = require("grammy");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { kv } = require("@vercel/kv");
const crypto = require("crypto");

const API_ID = parseInt(process.env.TG_API_ID || "0", 10);
const API_HASH = process.env.TG_API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_SESSION = process.env.TG_SESSION || "";
const OWNER_ID = parseInt(process.env.OWNER_ID || "0", 10);
const CRON_SECRET = process.env.CRON_SECRET || "";

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
  auto_archive: false,
  exclude: [],
  paused: false,
  daily_report: true,
  pin_hash: null,
  pin_salt: null,
  stats: {},
  last_undo: []
};

let memAuth = { until: 0, fails: 0, ban: 0 };

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
    if (logs.length > 20) logs = logs.slice(-20);
    await kv.set("userbot_logs", logs);
  } catch (e) {}
}

function hashPin(pin, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(pin, salt, 64).toString("hex");
}

function checkPin(cfg, pin) {
  if (!cfg.pin_hash || !cfg.pin_salt) return false;
  const hash = hashPin(pin, cfg.pin_salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(cfg.pin_hash, "hex"));
}

function isUnlocked(cfg) {
  return Boolean(cfg.pin_hash) && Date.now() / 1000 < memAuth.until;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function esc(s, n = 26) {
  if (!s) return "";
  const str = s.length <= n ? s : s.substring(0, n - 1) + "…";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spark(vals) {
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const top = Math.max(...vals, 1);
  return vals.map(v => (v ? bars[Math.min(7, Math.floor((v / top) * 7))] : "▁")).join("");
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) {
    res.push(arr.slice(i, i + size));
  }
  return res;
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
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {}
    }

    cfg.last_undo = done;
    const today = new Date().toISOString().split("T")[0];
    if (!cfg.stats[today]) cfg.stats[today] = { runs: 0, chats: 0, msgs: 0 };
    cfg.stats[today].runs += 1;
    cfg.stats[today].chats += done.length;
    cfg.stats[today].msgs += totalMsgs;

    const dates = Object.keys(cfg.stats).sort();
    if (dates.length > 30) {
      for (const d of dates.slice(0, dates.length - 30)) {
        delete cfg.stats[d];
      }
    }

    await saveCfg(cfg);
    await appendLog(`READ source=${source} chats=${done.length} msgs=${totalMsgs}`);
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
        await new Promise(r => setTimeout(r, 300));
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
  kb.text("✅ Baca Semua", "read").text("👁 Pratinjau", "preview").row();
  kb.text("⏰ Jadwal", "sched").text("🗂 Kategori", "cats").text("📅 Hari", "days").row();
  kb.text(`🔕 Muted: ${cfg.skip_muted ? "dilewati" : "ikut"}`, "mute")
    .text(`📦 Archive: ${cfg.auto_archive ? "ON" : "OFF"}`, "archive").row();
  kb.text(cfg.paused ? "▶️ Lanjutkan" : "⏸ Jeda", "pause")
    .text("↩️️ Undo", "undo").row();
  kb.text("📊 Laporan", "rep").text("📜 Log", "log").text("🔒 Kunci", "lock").row();
  return kb;
}

function backKeyboard() {
  return new InlineKeyboard().text("🏠 Menu", "home");
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

  const activeDays = cfg.days.length === 7 ? "Setiap hari" : cfg.days.map(i => DAYS[i]).join(", ") || "—";
  const activeCats = Object.keys(cfg.categories).filter(k => cfg.categories[k]).map(k => CAT_LABEL[k].split(" ")[0]).join(" ") || "—";
  const ivStr = cfg.interval_min ? `${cfg.interval_min} mnt` : "off";
  const left = Math.max(0, Math.floor(memAuth.until - Date.now() / 1000));
  const minLeft = Math.floor(left / 60);
  const secLeft = String(left % 60).padStart(2, "0");

  const text =
    "<b>📬 Inbox Control v2.5</b>\n" +
    `<blockquote><b>${fmt(totalMsgs)}</b> pesan belum dibaca\n` +
    `<b>${fmt(todoCount)}</b> chat menunggu</blockquote>\n` +
    `⏰ <b>Jadwal</b> · ${cfg.schedules.join(", ") || "—"}\n` +
    `🔁 <b>Interval</b> · ${ivStr}\n` +
    `📅 <b>Hari</b> · ${activeDays}\n` +
    `🗂 <b>Kategori</b> · ${activeCats}\n` +
    `${cfg.paused ? "⏸ <b>Dijeda</b>" : "🟢 <b>Aktif</b>"}\n\n` +
    `<i>🔓 Sesi terbuka ${minLeft}:${secLeft}</i>`;

  return { text, reply_markup: buildHomeKeyboard(cfg) };
}

function renderSched(cfg) {
  const kb = new InlineKeyboard();

  const timeBtns = PRESET_TIMES.map(t => ({
    text: (cfg.schedules.includes(t) ? "✅ " : "▫️ ") + t,
    callback_data: `t:${t}`
  }));
  chunk(timeBtns, 3).forEach(row => {
    row.forEach(b => kb.text(b.text, b.callback_data));
    kb.row();
  });

  const ivs = [
    { label: "Off", val: 0 },
    { label: "15m", val: 15 },
    { label: "30m", val: 30 },
    { label: "1j", val: 60 },
    { label: "3j", val: 180 }
  ];
  ivs.forEach(item => {
    const mark = cfg.interval_min === item.val ? "🔘 " : "";
    kb.text(`${mark}${item.label}`, `iv:${item.val}`);
  });
  kb.row();
  kb.text("🏠 Menu", "home");

  const text =
    "<b>⏰ Jadwal Otomatis</b>\n" +
    "<blockquote>Ketuk jam untuk menambah/menghapus.\n" +
    "Jam khusus: kirim <code>/jam 07:45</code></blockquote>\n" +
    `Aktif: <b>${cfg.schedules.sort().join(", ") || "—"}</b>`;

  return { text, reply_markup: kb };
}

function renderDays(cfg) {
  const kb = new InlineKeyboard();
  DAYS.forEach((n, i) => {
    const active = cfg.days.includes(i);
    kb.text((active ? "✅ " : "▫️ ") + n, `d:${i}`);
    if (i === 3 || i === 6) kb.row();
  });
  kb.text("🏠 Menu", "home");

  return {
    text: "<b>📅 Hari Aktif</b>\n<blockquote>Jadwal hanya berjalan di hari terpilih.</blockquote>",
    reply_markup: kb
  };
}

function renderCats(cfg) {
  const kb = new InlineKeyboard();
  Object.keys(CAT_LABEL).forEach((k, idx) => {
    const active = cfg.categories[k];
    kb.text((active ? "✅ " : "▫️ ") + CAT_LABEL[k], `c:${k}`);
    if (idx % 2 === 1) kb.row();
  });
  kb.text("🏠 Menu", "home");

  return {
    text: "<b>🗂 Kategori</b>\n<blockquote>Hanya kategori terpilih yang akan diproses.</blockquote>",
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
    kb.text("🏠 Menu", "home");
    return { text: "<b>👁 Pratinjau</b>\nSemua inbox sudah bersih! 🎉", reply_markup: kb };
  }

  const lines = todo.slice(0, 10).map(d => `${String(d.unreadCount).padStart(6, " ")}  ${esc(d.name)}`);
  const more = todo.length > 10 ? `\n… dan ${todo.length - 10} chat lainnya` : "";

  kb.text("✅ Baca Sekarang", "read").row().text("🏠 Menu", "home");

  return {
    text: `<b>👁 Pratinjau</b> · ${todo.length} chat\n<pre>` + lines.join("\n") + `</pre>${more}`,
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
    .text(`🗓 Laporan harian 21:00: ${cfg.daily_report ? "ON" : "OFF"}`, "repT").row()
    .text("🏠 Menu", "home");

  const text =
    "<b>📊 Laporan 7 Hari</b>\n" +
    `<pre>${spark(vals)}\n${labels}</pre>\n` +
    `💬 <b>${fmt(totalMsgs)}</b> pesan · ` +
    `🗨 <b>${fmt(totalChats)}</b> chat · ` +
    `▶️ <b>${totalRuns}</b> proses`;

  return { text, reply_markup: kb };
}

async function renderLog() {
  const logs = (await kv.get("userbot_logs")) || [];
  const body = logs.length > 0 ? logs.map(l => esc(l.substring(5))).join("\n") : "Belum ada aktivitas";
  return {
    text: `<b>📜 Log Aktivitas</b>\n<pre>${body}</pre>`,
    reply_markup: backKeyboard()
  };
}

function lockScreen(cfg) {
  if (!cfg.pin_hash) {
    return {
      text: "<b>🔐 Atur PIN Terlebih Dahulu</b>\n<blockquote>Kirim <code>/setpin 123456</code>\nPesan PIN akan langsung dihapus demi keamanan.</blockquote>",
      reply_markup: null
    };
  }
  return {
    text: "<b>🔒 Terkunci</b>\n<blockquote>Kirim <code>/unlock PIN</code> untuk mengakses kontrol panel.</blockquote>",
    reply_markup: null
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
    const kb = new InlineKeyboard().text("↩️ Undo", "undo").text("🏠 Menu", "home");
    return {
      text: `<b>✅ Selesai</b>\n<blockquote><b>${fmt(res.msgs)}</b> pesan dari <b>${res.chats}</b> chat telah ditandai terbaca.</blockquote>`,
      reply_markup: kb
    };
  }

  if (kind === "undo") {
    const count = await undoLast();
    return {
      text: `<b>↩️ Dikembalikan</b>\n<blockquote><b>${count}</b> chat ditandai belum dibaca kembali.</blockquote>`,
      reply_markup: backKeyboard()
    };
  }

  if (kind === "lock") {
    memAuth.until = 0;
    return lockScreen(cfg);
  }

  return renderHome(cfg);
}

const bot = new Bot(BOT_TOKEN);

async function safeDelete(ctx) {
  try {
    await ctx.deleteMessage();
  } catch (e) {}
}

bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private" || ctx.from.id !== OWNER_ID) return;

  const text = (ctx.message.text || "").trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1);

  const cfg = await loadCfg();

  if (cmd === "/setpin") {
    await safeDelete(ctx);
    let newPin = "";
    if (cfg.pin_hash) {
      if (args.length !== 2 || !checkPin(cfg, args[0])) {
        return ctx.reply("❌ Format: <code>/setpin PIN_LAMA PIN_BARU</code>", { parse_mode: "HTML" });
      }
      newPin = args[1];
    } else {
      newPin = args[0] || "";
    }

    if (!/^\d{4,12}$/.test(newPin)) {
      return ctx.reply("❌ PIN harus berupa 4–12 digit angka.");
    }

    const salt = crypto.randomBytes(16).toString("hex");
    cfg.pin_salt = salt;
    cfg.pin_hash = hashPin(newPin, salt);
    await saveCfg(cfg);

    memAuth.until = Date.now() / 1000 + UNLOCK_TTL;
    await appendLog("PIN set");

    const screen = await renderHome(cfg);
    return ctx.reply("✅ PIN berhasil disimpan.\n\n" + screen.text, {
      reply_markup: screen.reply_markup,
      parse_mode: "HTML"
    });
  }

  if (cmd === "/unlock") {
    await safeDelete(ctx);
    if (Date.now() / 1000 < memAuth.ban) {
      const waitMin = Math.ceil((memAuth.ban - Date.now() / 1000) / 60);
      return ctx.reply(`⛔ Terlalu banyak percobaan gagal. Coba lagi ${waitMin} menit lagi.`);
    }

    if (args[0] && checkPin(cfg, args[0])) {
      memAuth.until = Date.now() / 1000 + UNLOCK_TTL;
      memAuth.fails = 0;
      await appendLog("UNLOCK ok");
      const screen = await renderHome(cfg);
      return ctx.reply(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
    }

    memAuth.fails += 1;
    await appendLog("UNLOCK gagal");
    if (memAuth.fails >= MAX_FAILS) {
      memAuth.ban = Date.now() / 1000 + BAN_SECONDS;
      memAuth.fails = 0;
    }
    return ctx.reply("❌ PIN salah.");
  }

  if (!isUnlocked(cfg)) {
    const screen = lockScreen(cfg);
    return ctx.reply(screen.text, { parse_mode: "HTML" });
  }

  if (cmd === "/jam" && args[0]) {
    if (!/^\d{2}:\d{2}$/.test(args[0])) {
      return ctx.reply("Format: <code>/jam 07:45</code>", { parse_mode: "HTML" });
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
      await ctx.reply(`Daftar exclude dihapus untuk ID: ${idStr}`);
    } else {
      cfg.exclude.push(idStr);
      await ctx.reply(`Daftar exclude ditambahkan untuk ID: ${idStr}`);
    }
    await saveCfg(cfg);
    return;
  }

  if (cmd === "/resetstats") {
    cfg.stats = {};
    await saveCfg(cfg);
    return ctx.reply("✅ Statistik berhasil direset.");
  }

  const screen = await renderHome(cfg);
  return ctx.reply(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
});

bot.on("callback_query:data", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.answerCallbackQuery();
  }

  const cfg = await loadCfg();
  if (!isUnlocked(cfg)) {
    return ctx.answerCallbackQuery({ text: "🔒 Kirim /unlock PIN terlebih dahulu", alert: true });
  }

  memAuth.until = Date.now() / 1000 + UNLOCK_TTL;
  await ctx.answerCallbackQuery();

  const act = ctx.callbackQuery.data;
  try {
    if (act === "read") {
      await ctx.editMessageText("⏳ <b>Membaca semua chat…</b>", { parse_mode: "HTML" });
    }
    const screen = await routeAction(act, cfg);
    await ctx.editMessageText(screen.text, {
      reply_markup: screen.reply_markup,
      parse_mode: "HTML"
    });
  } catch (e) {}
});

async function runCronJob() {
  const cfg = await loadCfg();
  if (cfg.paused) return { status: "paused" };

  const now = new Date();
  const dayIndex = now.getDay() === 0 ? 6 : now.getDay() - 1;
  if (!cfg.days.includes(dayIndex)) return { status: "day_skipped" };

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const currentTime = `${hh}:${mm}`;

  const lastRunKey = await kv.get("userbot_last_cron_run");
  const todayStr = now.toISOString().split("T")[0];
  const currentKey = `${todayStr}_${currentTime}`;

  let shouldRun = false;
  if (cfg.schedules.includes(currentTime) && lastRunKey !== currentKey) {
    shouldRun = true;
    await kv.set("userbot_last_cron_run", currentKey);
  }

  if (!shouldRun && cfg.interval_min > 0) {
    const lastIvRun = (await kv.get("userbot_last_iv_run")) || 0;
    const nowTs = Math.floor(Date.now() / 1000);
    if (nowTs - lastIvRun >= cfg.interval_min * 60) {
      shouldRun = true;
      await kv.set("userbot_last_iv_run", nowTs);
    }
  }

  if (shouldRun) {
    const res = await readNow("cron");
    if (res.chats > 0) {
      const kb = new InlineKeyboard().text("↩️ Undo", "undo").text("🏠 Menu", "home");
      await bot.api.sendMessage(
        OWNER_ID,
        `<b>⏰ Terjadwal Otomatis</b>\n✅ <b>${fmt(res.msgs)}</b> pesan dari <b>${res.chats}</b> chat telah ditandai terbaca.`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    }
    return { status: "executed", ...res };
  }

  if (cfg.daily_report && currentTime === "21:00") {
    const lastReportDate = await kv.get("userbot_last_report_date");
    if (lastReportDate !== todayStr) {
      await kv.set("userbot_last_report_date", todayStr);
      const rep = renderReport(cfg);
      await bot.api.sendMessage(OWNER_ID, rep.text, { parse_mode: "HTML" });
    }
  }

  return { status: "idle" };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/cron" || url.searchParams.get("action") === "cron") {
    if (CRON_SECRET) {
      const authHeader = req.headers["authorization"];
      if (authHeader !== `Bearer ${CRON_SECRET}` && url.searchParams.get("secret") !== CRON_SECRET) {
        res.statusCode = 401;
        return res.end("Unauthorized Cron Trigger");
      }
    }
    try {
      const result = await runCronJob();
      res.statusCode = 200;
      return res.json({ success: true, result });
    } catch (err) {
      res.statusCode = 500;
      return res.json({ success: false, error: err.message });
    }
  }

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
  res.end("Inbox Control Bot v2.5 Online");
};
