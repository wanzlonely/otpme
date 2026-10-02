const { Bot, InlineKeyboard } = require("grammy");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { kv } = require("@vercel/kv");

const API_ID = parseInt(process.env.TG_API_ID || "0", 10);
const API_HASH = process.env.TG_API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_SESSION = process.env.TG_SESSION || "";
const OWNER_ID = parseInt(process.env.OWNER_ID || "0", 10);

let cachedClient = null;

function fmt(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function esc(s, n = 24) {
  if (!s) return "";
  const str = s.length <= n ? s : s.substring(0, n - 1) + "…";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getClient() {
  if (cachedClient && cachedClient.connected) {
    try {
      await cachedClient.getMe();
      return cachedClient;
    } catch (e) {
      cachedClient = null;
    }
  }
  const client = new TelegramClient(new StringSession(TG_SESSION), API_ID, API_HASH, {
    connectionRetries: 3,
    useWSS: false
  });
  await client.connect();
  cachedClient = client;
  return client;
}

async function fetchAllUnreadDialogs(client) {
  const out = [];
  try {
    const dialogs = await client.getDialogs({ limit: 300 });
    for (const d of dialogs) {
      if (d.unreadCount > 0 || d.unreadMentionsCount > 0) {
        out.push(d);
      }
    }
  } catch (e) {}
  return out;
}

async function readNow() {
  const client = await getClient();
  const done = [];
  let totalMsgs = 0;
  let totalChats = 0;

  let loop = 3;
  while (loop > 0) {
    loop--;
    const dialogs = await fetchAllUnreadDialogs(client);
    if (dialogs.length === 0) break;

    const batchSize = 10;
    for (let i = 0; i < dialogs.length; i += batchSize) {
      const batch = dialogs.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map(async (d) => {
          try {
            const count = d.unreadCount || 1;
            await client.markAsRead(d.entity);

            if (d.isChannel) {
              await client.invoke(
                new Api.channels.ReadHistory({
                  channel: d.inputEntity,
                  maxId: 0
                })
              );
            } else {
              await client.invoke(
                new Api.messages.ReadHistory({
                  peer: d.inputEntity,
                  maxId: 0
                })
              );
            }

            done.push(d.id.toString());
            totalMsgs += count;
            totalChats++;
          } catch (err) {}
        })
      );
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  try {
    await kv.set("userbot_undo", done);
  } catch (e) {}

  return { chats: totalChats, msgs: totalMsgs };
}

async function undoLast() {
  let done = [];
  try {
    done = (await kv.get("userbot_undo")) || [];
  } catch (e) {}

  if (!done || done.length === 0) return 0;
  const client = await getClient();
  let count = 0;

  const batchSize = 8;
  for (let i = 0; i < done.length; i += batchSize) {
    const batch = done.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (cid) => {
        try {
          const ent = await client.getInputEntity(cid);
          await client.invoke(
            new Api.messages.MarkDialogUnread({
              peer: new Api.InputDialogPeer({ peer: ent }),
              unread: true
            })
          );
          count++;
        } catch (e) {}
      })
    );
    await new Promise((r) => setTimeout(r, 40));
  }

  try {
    await kv.set("userbot_undo", []);
  } catch (e) {}

  return count;
}

async function renderHome() {
  const client = await getClient();
  let totalMsgs = 0;
  let todoCount = 0;

  try {
    const dialogs = await fetchAllUnreadDialogs(client);
    todoCount = dialogs.length;
    totalMsgs = dialogs.reduce((acc, curr) => acc + (curr.unreadCount || 0), 0);
  } catch (e) {}

  const text =
    "⚡ <b>USERBOT INBOX CONTROL</b>\n" +
    "───────────────────────────\n" +
    "📌 <b>STATUS INBOX SAAT INI</b>\n" +
    `├ 💬 <b>Total Pesan Unread:</b> <code>${fmt(totalMsgs)}</code>\n` +
    `└ 🗨 <b>Total Chat Pending:</b> <code>${fmt(todoCount)}</code>\n\n` +
    "🎯 <b>SISTEM OTOMATIS</b>\n" +
    "└ Membaca seluruh Channel, Grup, Bot, Kontak & Chat Muted secara langsung.\n" +
    "───────────────────────────";

  const kb = new InlineKeyboard();
  kb.text("⚡ BACA SEMUA SEKARANG", "read").row();
  kb.text("👁 Pratinjau Inbox", "preview").text("↩️ Undo (Urungkan)", "undo").row();
  kb.text("🔄 Refresh Dashboard", "home").row();

  return { text, reply_markup: kb };
}

async function renderPreview() {
  const client = await getClient();
  let todo = [];

  try {
    todo = await fetchAllUnreadDialogs(client);
    todo.sort((a, b) => b.unreadCount - a.unreadCount);
  } catch (e) {}

  const kb = new InlineKeyboard();
  if (todo.length === 0) {
    kb.text("🔄 Refresh Dashboard", "home");
    return {
      text: "✨ <b>INBOX SUDAH BERSIH</b>\n───────────────────────────\nTidak ada pesan tertunda saat ini.",
      reply_markup: kb
    };
  }

  let text = "👁 <b>PRATINJAU CHAT UNREAD</b>\n───────────────────────────\n";
  text += `📊 <b>Total Terdeteksi:</b> <code>${fmt(todo.length)} Chat Pending</code>\n\n`;
  text += "<b>Daftar Chat Unread Terbanyak:</b>\n";

  todo.slice(0, 6).forEach((d, idx) => {
    text += `├ <b>${idx + 1}.</b> ${esc(d.name)} — <code>${fmt(d.unreadCount)} Pesan</code>\n`;
  });

  if (todo.length > 6) {
    text += `└ <i>…dan ${todo.length - 6} chat unread lainnya.</i>\n`;
  }
  text += "───────────────────────────";

  kb.text("⚡ BACA SEMUA SEKARANG", "read").row();
  kb.text("🏠 Kembali Ke Menu Utama", "home");

  return { text, reply_markup: kb };
}

const bot = new Bot(BOT_TOKEN);

bot.on("message", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;

  const screen = await renderHome();
  return ctx.reply(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
});

bot.on("callback_query:data", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.answerCallbackQuery();
  }

  await ctx.answerCallbackQuery();
  const act = ctx.callbackQuery.data;

  try {
    if (act === "read") {
      await ctx.editMessageText("⏳ <b>Sedang membersihkan seluruh pesan belum dibaca...</b>", { parse_mode: "HTML" });
      const res = await readNow();
      const kb = new InlineKeyboard().text("↩️ Undo (Urungkan)", "undo").text("🏠 Menu Utama", "home");
      return ctx.editMessageText(
        `✅ <b>PEMBACAAN SELESAI SEPENUHNYA</b>\n───────────────────────────\nBerhasil membersihkan total <b>${fmt(res.msgs)}</b> pesan di <b>${fmt(res.chats)}</b> chat.`,
        { reply_markup: kb, parse_mode: "HTML" }
      );
    }

    if (act === "undo") {
      await ctx.editMessageText("⏳ <b>Mengembalikan status chat...</b>", { parse_mode: "HTML" });
      const count = await undoLast();
      const kb = new InlineKeyboard().text("🏠 Menu Utama", "home");
      return ctx.editMessageText(
        `↩️ <b>PEMBATALAN SELESAI</b>\n───────────────────────────\nSebanyak <b>${count}</b> chat telah ditandai belum dibaca kembali.`,
        { reply_markup: kb, parse_mode: "HTML" }
      );
    }

    if (act === "preview") {
      const screen = await renderPreview();
      return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
    }

    const screen = await renderHome();
    return ctx.editMessageText(screen.text, { reply_markup: screen.reply_markup, parse_mode: "HTML" });
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
  res.end("Inbox Control Bot Direct Engine Active");
};
