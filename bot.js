import { Telegraf } from 'telegraf';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import XLSX from 'xlsx';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

const CONFIG = {
    botToken:      '8228167242:AAH8tGPdLUdiNGCG4EYG21s5twEy8M-xfXA',
    ownerId:       '8062935882',
    adminUsername: 'walzspy',
    groupLink:     'https://t.me/otpspyx',
    groupId:       '-1003887790861',
    botImage:      'https://files.catbox.moe/kjfe0d.jpg',
    dbPath:        './database',
    batchSize:     50,
    delayPerBatch: 3000,
    maxSessions:   5
};

class Database {
    constructor() {
        if (!fs.existsSync(CONFIG.dbPath)) {
            fs.mkdirSync(CONFIG.dbPath, { recursive: true });
        }
        this.paths = {
            users:    path.join(CONFIG.dbPath, 'users.json'),
            settings: path.join(CONFIG.dbPath, 'settings.json')
        };
        this._init();
    }

    _init() {
        if (!fs.existsSync(this.paths.settings)) {
            fs.writeFileSync(this.paths.settings, JSON.stringify({
                owners:      [CONFIG.ownerId],
                maintenance: false
            }, null, 2));
        }
        if (!fs.existsSync(this.paths.users)) {
            fs.writeFileSync(this.paths.users, JSON.stringify({}, null, 2));
        }
    }

    _read(key) {
        try { return JSON.parse(fs.readFileSync(this.paths[key], 'utf8')); }
        catch { return null; }
    }

    _write(key, data) {
        fs.writeFileSync(this.paths[key], JSON.stringify(data, null, 2));
    }

    get users()    { return this._read('users') || {}; }
    get settings() {
        const d = this._read('settings') || {};
        if (!Array.isArray(d.owners))           d.owners = [CONFIG.ownerId];
        if (!d.owners.includes(CONFIG.ownerId)) d.owners.push(CONFIG.ownerId);
        if (typeof d.maintenance !== 'boolean') d.maintenance = false;
        return d;
    }
    set settings(v) { this._write('settings', v); }

    isOwner(id)  { return this.settings.owners.includes(String(id)) || String(id) === CONFIG.ownerId; }
    isSuperAdmin(id) { return String(id) === CONFIG.ownerId; }

    addOwner(id) {
        const s = this.settings;
        if (s.owners.includes(String(id))) return false;
        s.owners.push(String(id));
        this.settings = s;
        return true;
    }

    removeOwner(id) {
        if (String(id) === CONFIG.ownerId) return 'SUPER_ADMIN';
        const s = this.settings;
        const before = s.owners.length;
        s.owners = s.owners.filter(o => o !== String(id));
        this.settings = s;
        return s.owners.length < before ? 'SUCCESS' : 'NOT_FOUND';
    }

    toggleMaintenance() {
        const s = this.settings;
        s.maintenance = !s.maintenance;
        this.settings = s;
        return s.maintenance;
    }

    getUser(id) { return this.users[String(id)] || null; }

    upsertUser(id, data) {
        const all = this.users;
        const uid = String(id);
        if (!all[uid]) {
            all[uid] = {
                id: uid, username: 'User',
                joined: Date.now(), expired: 0, sessions: []
            };
        }
        if (uid === CONFIG.ownerId) data.expired = 9_999_999_999_999;
        all[uid] = { ...all[uid], ...data };
        this._write('users', all);
        return all[uid];
    }

    addTime(id, days) {
        const u = this.getUser(id);
        if (!u) return null;
        const now    = Date.now();
        const base   = Number(u.expired) > now ? Number(u.expired) : now;
        const newExp = base + days * 86_400_000;
        return this.upsertUser(id, { expired: newExp });
    }

    cutTime(id, days) {
        const u = this.getUser(id);
        if (!u) return null;
        const newExp = Math.max(0, Number(u.expired) - days * 86_400_000);
        return this.upsertUser(id, { expired: newExp });
    }

    updateSessions(id, sessions) {
        this.upsertUser(id, { sessions });
    }
}

const db = new Database();

const fmt = {
    timeLeft(exp) {
        if (exp > 9_000_000_000_000) return '♾️ VIP';
        const diff = exp - Date.now();
        if (diff <= 0) return '❌ Habis';
        const d = Math.ceil(diff / 86_400_000);
        return `${d} Hari`;
    },
    date(ms) {
        if (!ms || ms === 0) return '-';
        if (ms > 9_000_000_000_000) return 'Selamanya';
        return new Date(ms).toLocaleDateString('id-ID');
    },
    dateIndo(d) {
        if (!d) return '-';
        try { return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
        catch { return '-'; }
    },
    progressBar(cur, max) {
        const filled = Math.round((cur / max) * 5);
        return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
    }
};

function getPhoneData(num) {
    try {
        const pn = parsePhoneNumberWithError('+' + num);
        return {
            country: pn.country || 'Unknown',
            intl: pn.formatInternational()
        };
    } catch {
        return { country: 'Unknown', intl: '+' + num };
    }
}

function isValidNumber(str) {
    return /^\d{8,15}$/.test(str.replace(/\D/g, ''));
}

const bot         = new Telegraf(CONFIG.botToken, { handlerTimeout: 9_000_000 });
const waManager   = new WAManager();
const userStates  = new Map();
const tempStorage = new Map();
const checkQueue  = [];
let   isChecking  = false;

const MENUS = {
    superAdmin: {
        keyboard: [
            [{ text: '🔎 CEK BIO NOMOR' }],
            [{ text: '📱 KONEKSI WA' }, { text: '👑 PANEL SUPER ADMIN' }],
            [{ text: '👥 KELOLA USER'  }, { text: '❓ BANTUAN' }]
        ],
        resize_keyboard: true
    },
    owner: {
        keyboard: [
            [{ text: '🔎 CEK BIO NOMOR' }],
            [{ text: '📱 KONEKSI WA' }, { text: '👥 KELOLA USER' }],
            [{ text: '❓ BANTUAN' }]
        ],
        resize_keyboard: true
    },
    user: {
        keyboard: [
            [{ text: '🔎 CEK BIO NOMOR' }],
            [{ text: '📱 KONEKSI WA' }, { text: '👤 PROFIL SAYA' }],
            [{ text: '❓ BANTUAN' }]
        ],
        resize_keyboard: true
    },
    superAdminPanel: {
        keyboard: [
            [{ text: '➕ TAMBAH ADMIN' }, { text: '➖ HAPUS ADMIN' }],
            [{ text: '🚧 MAINTENANCE'  }, { text: '📢 BROADCAST'   }],
            [{ text: '📦 BACKUP DATA'  }, { text: '📋 LIST ADMIN'  }],
            [{ text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    userMan: {
        keyboard: [
            [{ text: '➕ TAMBAH DURASI' }, { text: '➖ POTONG DURASI' }],
            [{ text: '👥 DAFTAR USER'   }, { text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    waMenu: {
        keyboard: [
            [{ text: '➕ TAMBAH NOMOR' }, { text: '📋 LIHAT SESI' }],
            [{ text: '❌ HAPUS SESI'   }, { text: '🔙 KEMBALI'   }]
        ],
        resize_keyboard: true
    },
    cancel: {
        keyboard: [[{ text: '🔙 KEMBALI' }]],
        resize_keyboard: true
    },
    verify: {
        inline_keyboard: [
            [{ text: '🚀 Gabung Grup Resmi', url: CONFIG.groupLink }],
            [{ text: '✅ Saya Sudah Join',   callback_data: 'verify_join' }]
        ]
    }
};

function mainMenu(role) {
    if (role === 'superadmin') return MENUS.superAdmin;
    if (role === 'owner')      return MENUS.owner;
    return MENUS.user;
}

function WAManager() {
    const sessions       = new Map();
    const sessionStatus  = new Map();
    const lastNotifTime  = new Map();

    async function startSession(userId, sessionId) {
        const uid      = String(userId);
        const key      = `${uid}_${sessionId}`;
        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${sessionId}`);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version }          = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger:              P({ level: 'silent' }),
            printQRInTerminal:   false,
            auth: {
                creds: state.creds,
                keys:  makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
            },
            browser:             ['Ubuntu', 'Chrome', '20.0.04'],
            connectTimeoutMs:    60_000,
            markOnlineOnConnect: true,
            syncFullHistory:     false
        });

        if (!sessions.has(uid)) sessions.set(uid, new Map());
        sessions.get(uid).set(sessionId, sock);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                sessionStatus.set(key, 'open');
                const now  = Date.now();
                const last = lastNotifTime.get(key) || 0;
                if (now - last > 60_000) {
                    lastNotifTime.set(key, now);
                    try {
                        await bot.telegram.sendMessage(
                            uid,
                            `✅ <b>WhatsApp Terhubung!</b>\nSesi ke-${sessionId} aktif.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch {}
                }
            } else if (connection === 'close') {
                sessionStatus.set(key, 'close');
                sessions.has(uid) && sessions.get(uid).delete(sessionId);

                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                    const u = db.getUser(uid);
                    if (u?.sessions) {
                        db.updateSessions(uid, u.sessions.filter(s => s !== sessionId));
                    }
                    try {
                        await bot.telegram.sendMessage(
                            uid,
                            `⚠️ <b>Sesi Terputus!</b>\nSesi ke-${sessionId} dihapus otomatis.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch {}
                } else if (code !== 401) {
                    startSession(userId, sessionId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        return sock;
    }

    async function requestPairing(userId, phoneNumber) {
        const uid = String(userId);
        const u   = db.getUser(uid);

        let newId = 1;
        const cur = u?.sessions || [];
        if (cur.length >= CONFIG.maxSessions) throw new Error('Batas maksimal sesi tercapai.');

        for (let i = 1; i <= CONFIG.maxSessions; i++) {
            if (!cur.includes(i)) { newId = i; break; }
        }

        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${newId}`);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

        const sock = await startSession(userId, newId);
        await delay(5000);

        try {
            const num  = phoneNumber.replace(/\D/g, '');
            const code = await sock.requestPairingCode(num);
            if (!cur.includes(newId)) db.updateSessions(uid, [...cur, newId]);
            return code;
        } catch {
            throw new Error('Gagal mengambil kode pairing.');
        }
    }

    async function deleteSession(userId, sessionId) {
        const uid = String(userId);
        if (sessions.has(uid)) {
            sessions.get(uid).get(sessionId)?.end();
            sessions.get(uid).delete(sessionId);
        }
        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${sessionId}`);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

        const u = db.getUser(uid);
        if (u?.sessions) db.updateSessions(uid, u.sessions.filter(s => s !== sessionId));
    }

    function isConnected(userId) {
        const uid = String(userId);
        const u   = db.getUser(uid);
        if (!u?.sessions?.length) return false;
        return u.sessions.some(s => sessionStatus.get(`${uid}_${s}`) === 'open');
    }

    function getActiveSockets(userId) {
        const uid = String(userId);
        if (!sessions.has(uid)) return [];
        return [...sessions.get(uid).values()];
    }

    function getSessionStatusText(userId) {
        const uid = String(userId);
        const u   = db.getUser(uid);
        if (!u?.sessions?.length) return 'Belum ada sesi.';
        return u.sessions
            .map(s => {
                const st = sessionStatus.get(`${uid}_${s}`) === 'open' ? '🟢 Online' : '🔴 Offline';
                return `Perangkat ${s}: ${st}`;
            })
            .join('\n');
    }

    function countActive(userId) {
        const uid = String(userId);
        const u   = db.getUser(uid);
        if (!u?.sessions?.length) return 0;
        return u.sessions.filter(s => sessionStatus.get(`${uid}_${s}`) === 'open').length;
    }

    async function loadAll() {
        const users = db.users;
        for (const [uid, u] of Object.entries(users)) {
            if (u?.sessions?.length) {
                for (const sid of u.sessions) {
                    await startSession(uid, sid);
                    await delay(1000);
                }
            }
        }
    }

    return { startSession, requestPairing, deleteSession, isConnected, getActiveSockets, getSessionStatusText, countActive, loadAll };
}

async function extractNumbersFromFile(url, fileName) {
    const res    = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);
    const ext    = fileName.split('.').pop().toLowerCase();

    if (ext === 'txt') {
        return (buffer.toString('utf-8').match(/\d{8,15}/g) || []);
    }
    if (ext === 'xlsx' || ext === 'xls') {
        const wb   = XLSX.read(buffer, { type: 'buffer' });
        const nums = [];
        for (const name of wb.SheetNames) {
            XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 })
                .flat()
                .forEach(cell => {
                    if (cell) {
                        const s = String(cell).replace(/\D/g, '');
                        if (s.length >= 8) nums.push(s);
                    }
                });
        }
        return nums;
    }
    throw new Error('Format file tidak didukung.');
}

async function checkAuth(ctx, enforceGroup = true) {
    const uid      = String(ctx.from.id);
    const settings = db.settings;
    const isSuper  = db.isSuperAdmin(uid);
    const isOwner  = db.isOwner(uid);

    if (settings.maintenance && !isSuper) {
        await ctx.reply('🚧 <b>MAINTENANCE</b>\n\nSistem sedang dalam perbaikan.', { parse_mode: 'HTML' });
        return false;
    }

    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'User');
    const u        = db.getUser(uid);
    if (!u) {
        db.upsertUser(uid, { username });
    } else if (u.username !== username) {
        db.upsertUser(uid, { username });
    }

    if (!isSuper && !isOwner) {
        if (enforceGroup && CONFIG.groupId !== '0') {
            try {
                const member = await ctx.telegram.getChatMember(CONFIG.groupId, Number(uid));
                if (!['creator', 'administrator', 'member'].includes(member.status)) {
                    await ctx.replyWithPhoto(CONFIG.botImage, {
                        caption: `🛑 <b>AKSES DITOLAK</b>\n\nSilakan bergabung ke grup resmi terlebih dahulu.`,
                        parse_mode: 'HTML',
                        reply_markup: MENUS.verify
                    });
                    return false;
                }
            } catch {}
        }

        const userData = db.getUser(uid);
        if (!userData?.expired || Date.now() > Number(userData.expired)) {
            await ctx.reply(
                `⏰ <b>AKSES BERAKHIR</b>\n\nID: <code>${uid}</code>\nHubungi admin untuk perpanjang.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '💬 Hubungi Admin', url: `https://t.me/${CONFIG.adminUsername}` }]]
                    }
                }
            );
            return false;
        }
    }

    if (isSuper)  return 'superadmin';
    if (isOwner)  return 'owner';
    return 'user';
}

async function showDashboard(ctx, uid, role) {
    const u       = db.getUser(uid) || {};
    const active  = waManager.countActive(uid);
    const expired = fmt.timeLeft(u.expired || 0);
    const bar     = fmt.progressBar(active, 5);

    const badge = role === 'superadmin' ? '👑 Super Admin'
                : role === 'owner'      ? '🛡️ Admin'
                : '💎 User Premium';

    const caption =
`╭─── [ 𝗪𝗔𝗟𝗭𝗬 𝗜𝗡𝗧𝗘𝗟 ] ───╮
│  👤 User : ${u.username || 'User'}
│  🏅 Role : ${badge}
╰────────────────────────╯
╭── ⚡ STATUS SISTEM ──╮
│  🟢 Server : Online
│  🔗 WA     : ${bar} (${active}/5)
╰──────────────────────╯
╭── 🔐 INFO AKUN ──╮
│  🆔 ID  : <code>${uid}</code>
│  ⏳ Exp : ${expired}
╰──────────────────╯`;

    await ctx.replyWithPhoto(CONFIG.botImage, {
        caption,
        parse_mode: 'HTML',
        reply_markup: mainMenu(role)
    });
}

async function runNextCheck() {
    if (isChecking || checkQueue.length === 0) return;
    isChecking = true;
    const { ctx, nums, uid } = checkQueue.shift();

    try {
        await ctx.reply(
            `⏳ <b>MEMPROSES DATA CEK BIO</b>\n\n📂 Total  : ${nums.length} Nomor\n🔍 Metode : Intelligence Scan`,
            { parse_mode: 'HTML' }
        );
        await processCekBio(ctx, nums, uid);
    } catch (err) {
        await ctx.reply(`❌ Gagal: ${err.message}`, { reply_markup: mainMenu('user') });
    } finally {
        isChecking = false;
        runNextCheck();
    }
}

async function processCekBio(ctx, nums, uid) {
    let allSocks = waManager.getActiveSockets(uid);
    if (allSocks.length === 0) throw new Error('Semua sesi terputus.');

    const results = [];
    const invalid = [];
    let abortScan = false;

    async function fetchUSync(sock, jid) {
        try {
            const { USyncQuery, USyncUser } = await import('@whiskeysockets/baileys/lib/WAUSync/index.js');
            const query  = new USyncQuery().withContext('interactive').withStatusProtocol().withUser(new USyncUser().withId(jid));
            const result = await sock.executeUSyncQuery(query);
            if (result?.list?.[0]?.status) {
                return { status: result.list[0].status.status, setAt: result.list[0].status.setAt };
            }
        } catch {}
        return null;
    }

    const getRandSock = () => {
        allSocks = waManager.getActiveSockets(uid);
        if(allSocks.length === 0) return null;
        return allSocks[Math.floor(Math.random() * allSocks.length)];
    };

    for (let i = 0; i < nums.length; i += CONFIG.batchSize) {
        if (abortScan) break;
        const batch = nums.slice(i, i + CONFIG.batchSize);

        await Promise.all(batch.map(async (num) => {
            if (abortScan) return;
            const clean = num.replace(/\D/g, '');
            const jid   = `${clean}@s.whatsapp.net`;
            let   sock  = getRandSock();
            
            if (!sock) {
                abortScan = true;
                return;
            }

            let   done  = false;
            let   tries = 0;

            while (!done && tries < 3) {
                try {
                    const [onWa] = await sock.onWhatsApp(jid);
                    if (onWa?.exists) {
                        let bio = 'Kosong / Privasi';
                        let bioDate = '-';
                        let rawDate = 0;
                        let type = 'Pribadi';
                        let ppStatus = 'Tidak Ada / Privasi';
                        let bizCategory = '-';
                        let profName = '-';
                        let coverBiz = '-';
                        let isVerified = '❌';
                        let pd = getPhoneData(clean);

                        try { await sock.presenceSubscribe(jid); } catch {}
                        
                        try {
                            const ppUrl = await sock.profilePictureUrl(jid, 'image');
                            if (ppUrl) ppStatus = 'Ada';
                        } catch {}

                        let statusData = await fetchUSync(sock, jid);
                        if (!statusData) {
                            try { statusData = await sock.fetchStatus(jid); } catch {}
                        }

                        if (statusData?.status) {
                            bio = statusData.status;
                            bioDate = fmt.dateIndo(statusData.setAt);
                            rawDate = statusData.setAt ? new Date(statusData.setAt).getTime() : 0;
                        }

                        try {
                            const biz = await sock.getBusinessProfile(jid);
                            if (biz) {
                                type = 'Bisnis';
                                bizCategory = biz.category || '-';
                                profName = biz.name || '-';
                                coverBiz = biz.profileOptions?.coverPhoto ? 'Ada' : 'Tidak Ada';
                                isVerified = biz.isVerified ? '✅' : '❌';

                                if (biz.description && bio === 'Kosong / Privasi') {
                                    bio = biz.description;
                                    bioDate = 'Deskripsi Bisnis';
                                    rawDate = 9_999_999_999_999;
                                }
                            }
                        } catch {}

                        results.push({ 
                            num: clean, 
                            intl: pd.intl,
                            country: pd.country,
                            type, 
                            name: profName,
                            category: bizCategory,
                            cover: coverBiz,
                            verified: isVerified,
                            ppStatus,
                            date: bioDate, 
                            rawDate, 
                            bio: bio.replace(/[\r\n]+/g, ' ').trim() 
                        });
                    } else {
                        invalid.push(clean);
                    }
                    done = true;
                } catch (e) {
                    const nextSock = getRandSock();
                    if (nextSock) {
                        sock = nextSock;
                    } else {
                        abortScan = true;
                        done = true;
                    }
                }
                tries++;
            }
        }));

        if (i + CONFIG.batchSize < nums.length && !abortScan) await delay(CONFIG.delayPerBatch);
    }

    const withDate    = results.filter(r => r.rawDate > 0).sort((a, b) => a.rawDate - b.rawDate);
    const withoutDate = results.filter(r => r.rawDate === 0);
    const sorted      = [...withDate, ...withoutDate];

    let content = `HASIL CEK BIO — INTELLIGENCE CHECKER\n`;
    content    += `Scan: ${new Date().toLocaleString('id-ID')}\n`;
    content    += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (sorted.length > 0) {
        content += `✅ TERDAFTAR (${sorted.length})\n${'─'.repeat(36)}\n`;
        for (const r of sorted) {
            content += `NOMOR       : ${r.num}\n`;
            content += `INTL FORMAT : ${r.intl}\n`;
            content += `NEGARA      : ${r.country}\n`;
            content += `TIPE AKUN   : ${r.type.toUpperCase()}\n`;
            if (r.type === 'Bisnis') {
                content += `NAMA PROFIL : ${r.name}\n`;
                content += `KATEGORI    : ${r.category}\n`;
                content += `COVER BIZ   : ${r.cover}\n`;
                content += `VERIFIED    : ${r.verified}\n`;
            }
            content += `FOTO PROFIL : ${r.ppStatus}\n`;
            content += `UPDATE BIO  : ${r.date}\n`;
            content += `BIO / DESC  : ${r.bio}\n`;
            content += `${'─'.repeat(36)}\n`;
        }
    }

    if (invalid.length > 0) {
        content += `\n❌ TIDAK TERDAFTAR / INVALID (${invalid.length})\n${'─'.repeat(36)}\n`;
        invalid.forEach(n => { content += `• ${n}\n`; });
    }

    const fileName = `WalzyIntel_${uid}_${Date.now()}.txt`;
    fs.writeFileSync(fileName, content);

    const bizCount = results.filter(r => r.type === 'Bisnis').length;
    const perCount = results.filter(r => r.type === 'Pribadi').length;

    let caption = `✅ <b>PEMINDAIAN SELESAI</b>\n\n`;
    
    if (abortScan) {
        caption = `⚠️ <b>PEMINDAIAN TERHENTI</b>\n<i>Semua sesi terputus. Mengirim hasil parsial secara otomatis.</i>\n\n`;
    }

    caption += `📊 <b>RINGKASAN DATA</b>\n`;
    caption += `<code>Total Input : ${nums.length}</code>\n`;
    caption += `<code>Valid WA    : ${results.length}</code>\n`;
    caption += `<code>Tidak Valid : ${invalid.length}</code>\n\n`;
    
    caption += `📂 <b>KLASIFIKASI</b>\n`;
    caption += `<code>Bisnis      : ${bizCount}</code>\n`;
    caption += `<code>Pribadi     : ${perCount}</code>`;

    await ctx.replyWithDocument({ source: fileName }, { caption, parse_mode: 'HTML' });
    fs.unlinkSync(fileName);
}

bot.command('start', async (ctx) => {
    const role = await checkAuth(ctx);
    if (!role) return;
    const uid = String(ctx.from.id);
    userStates.delete(uid);
    await showDashboard(ctx, uid, role);
});

bot.action('verify_join', async (ctx) => {
    const uid = String(ctx.from.id);
    try {
        const member = await ctx.telegram.getChatMember(CONFIG.groupId, Number(uid));
        if (['creator', 'administrator', 'member'].includes(member.status)) {
            try { await ctx.deleteMessage(); } catch {}
            const role = db.isSuperAdmin(uid) ? 'superadmin' : (db.isOwner(uid) ? 'owner' : 'user');
            return showDashboard(ctx, uid, role);
        }
    } catch {}
    await ctx.answerCbQuery('❌ Anda belum bergabung!', { show_alert: true });
});

bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery('Salin kode pairing di atas!', { show_alert: false });
});

bot.on(['text', 'photo', 'video'], async (ctx) => {
    const uid  = String(ctx.from.id);
    const text = ctx.message.text || ctx.message.caption || '';
    const role = await checkAuth(ctx);
    if (!role) return;

    const isSuper = role === 'superadmin';
    const isAdmin = role === 'owner' || role === 'superadmin';
    const state   = userStates.get(uid);
    const kb      = mainMenu(role);

    if (text === '🔙 KEMBALI') {
        userStates.delete(uid);
        tempStorage.delete(uid);
        return showDashboard(ctx, uid, role);
    }

    if (state) {
        try {
            switch (state) {
                case 'ADD_OWNER_ID': {
                    if (!isSuper) break;
                    const id = text.trim();
                    const ok = db.addOwner(id);
                    userStates.delete(uid);
                    return ctx.reply(
                        ok ? `✅ ID <code>${id}</code> berhasil diangkat jadi Admin.`
                           : `❌ ID tersebut sudah menjadi Admin.`,
                        { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel }
                    );
                }
                case 'DEL_OWNER_ID': {
                    if (!isSuper) break;
                    const res = db.removeOwner(text.trim());
                    userStates.delete(uid);
                    const msg = res === 'SUCCESS'    ? `✅ Admin <code>${text.trim()}</code> berhasil dihapus.`
                              : res === 'SUPER_ADMIN' ? '🛡️ Super Admin tidak dapat dihapus.'
                              : '❌ ID tidak ditemukan.';
                    return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
                }
                case 'BROADCAST': {
                    if (!isSuper) break;
                    const targets = Object.keys(db.users);
                    await ctx.reply(`⏳ Mengirim broadcast...`, { parse_mode: 'HTML' });
                    let ok = 0, fail = 0;
                    for (const t of targets) {
                        try {
                            await bot.telegram.copyMessage(t, ctx.chat.id, ctx.message.message_id);
                            ok++;
                            await delay(200);
                        } catch { fail++; }
                    }
                    userStates.delete(uid);
                    return ctx.reply(
                        `✅ <b>Broadcast Selesai</b>\n\n✅ Terkirim : ${ok}\n❌ Gagal    : ${fail}`,
                        { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel }
                    );
                }
                case 'ADD_TIME_ID': {
                    if (!isAdmin) break;
                    tempStorage.set(uid, { target: text.trim() });
                    userStates.set(uid, 'ADD_TIME_DAYS');
                    return ctx.reply('📅 Tambah berapa hari?', { reply_markup: MENUS.cancel });
                }
                case 'ADD_TIME_DAYS': {
                    if (!isAdmin) break;
                    const days = parseInt(text);
                    if (isNaN(days) || days <= 0) return ctx.reply('❌ Masukkan angka valid.', { reply_markup: MENUS.cancel });
                    const target = tempStorage.get(uid)?.target;
                    const result = db.addTime(target, days);
                    userStates.delete(uid);
                    tempStorage.delete(uid);
                    if (!result) return ctx.reply('❌ User ID tidak ditemukan.', { reply_markup: MENUS.userMan });
                    return ctx.reply(
                        `✅ <b>Durasi Ditambah</b>\nUser <code>${target}</code> + ${days} hari\nExp: ${fmt.date(result.expired)}`,
                        { parse_mode: 'HTML', reply_markup: MENUS.userMan }
                    );
                }
                case 'DEL_TIME_ID': {
                    if (!isAdmin) break;
                    tempStorage.set(uid, { target: text.trim() });
                    userStates.set(uid, 'DEL_TIME_DAYS');
                    return ctx.reply('📅 Potong berapa hari?', { reply_markup: MENUS.cancel });
                }
                case 'DEL_TIME_DAYS': {
                    if (!isAdmin) break;
                    const days = parseInt(text);
                    if (isNaN(days) || days <= 0) return ctx.reply('❌ Masukkan angka valid.', { reply_markup: MENUS.cancel });
                    const target = tempStorage.get(uid)?.target;
                    const result = db.cutTime(target, days);
                    userStates.delete(uid);
                    tempStorage.delete(uid);
                    if (!result) return ctx.reply('❌ User ID tidak ditemukan.', { reply_markup: MENUS.userMan });
                    return ctx.reply(
                        `✅ <b>Durasi Dipotong</b>\nUser <code>${target}</code> - ${days} hari\nExp: ${fmt.date(result.expired)}`,
                        { parse_mode: 'HTML', reply_markup: MENUS.userMan }
                    );
                }
                case 'ADD_WA_NUM': {
                    const num = text.replace(/\D/g, '');
                    if (!isValidNumber(num)) return ctx.reply('❌ Nomor tidak valid.', { reply_markup: MENUS.cancel });
                    await ctx.reply('⏳ Meminta kode pairing...', { parse_mode: 'HTML' });
                    try {
                        const code = await waManager.requestPairing(uid, num);
                        userStates.delete(uid);
                        return ctx.reply(
                            `🔐 <b>KODE PAIRING WHATSAPP</b>\n\n📱 Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Masukkan kode pada tombol di bawah.`,
                            { 
                                parse_mode: 'HTML',
                                reply_markup: {
                                    inline_keyboard: [[{ text: code, callback_data: 'noop' }]]
                                }
                            }
                        );
                    } catch (e) {
                        userStates.delete(uid);
                        return ctx.reply(`❌ ${e.message}`, { reply_markup: MENUS.waMenu });
                    }
                }
                case 'DEL_WA_ID': {
                    const sid = parseInt(text);
                    if (isNaN(sid)) return ctx.reply('❌ Masukkan nomor sesi valid.', { reply_markup: MENUS.cancel });
                    await waManager.deleteSession(uid, sid);
                    userStates.delete(uid);
                    return ctx.reply(`✅ Sesi ke-${sid} berhasil dihapus.`, { reply_markup: MENUS.waMenu });
                }
                case 'CEK_BIO_INPUT': {
                    if (!waManager.isConnected(uid)) {
                        userStates.delete(uid);
                        return ctx.reply('❌ Tidak ada WhatsApp terhubung.', { parse_mode: 'HTML', reply_markup: MENUS.waMenu });
                    }
                    const nums = (text.match(/\d{8,15}/g) || []).map(n => n.replace(/\D/g, ''));
                    if (nums.length === 0) return ctx.reply('❌ Tidak ada nomor terdeteksi.');
                    checkQueue.push({ ctx, nums, uid });
                    userStates.delete(uid);
                    if (isChecking) return ctx.reply(`⏳ <b>Masuk Antrian</b>\nPosisi: ${checkQueue.length}`, { parse_mode: 'HTML' });
                    return runNextCheck();
                }
            }
        } catch (err) {
            ctx.reply(`❌ Error: ${err.message}`, { reply_markup: kb });
            userStates.delete(uid);
        }
        return;
    }

    switch (text) {
        case '🔎 CEK BIO NOMOR':
            if (!waManager.isConnected(uid)) {
                return ctx.reply(
                    '❌ <b>Belum Ada WhatsApp Terhubung</b>\n\nHubungkan WhatsApp terlebih dahulu di menu 📱 KONEKSI WA.',
                    { parse_mode: 'HTML', reply_markup: MENUS.waMenu }
                );
            }
            userStates.set(uid, 'CEK_BIO_INPUT');
            return ctx.reply(
                '✍️ <b>KIRIM DATA NOMOR</b>\n\nKirim list nomor atau file <code>.txt</code> / <code>.xlsx</code>',
                { parse_mode: 'HTML', reply_markup: MENUS.cancel }
            );

        case '📱 KONEKSI WA':
            return ctx.reply(
                '📱 <b>KONEKSI WHATSAPP</b>\n\n' + waManager.getSessionStatusText(uid),
                { parse_mode: 'HTML', reply_markup: MENUS.waMenu }
            );

        case '➕ TAMBAH NOMOR':
            userStates.set(uid, 'ADD_WA_NUM');
            return ctx.reply('📱 Masukkan nomor WhatsApp (format: 628xxx):', { reply_markup: MENUS.cancel });

        case '📋 LIHAT SESI':
            return ctx.reply(
                `📋 <b>STATUS SESI</b>\n\n${waManager.getSessionStatusText(uid)}`,
                { parse_mode: 'HTML', reply_markup: MENUS.waMenu }
            );

        case '❌ HAPUS SESI':
            userStates.set(uid, 'DEL_WA_ID');
            return ctx.reply('🗑️ Masukkan nomor sesi yang ingin dihapus (contoh: 1):', { reply_markup: MENUS.cancel });

        case '👑 PANEL SUPER ADMIN':
            if (!isSuper) return;
            return ctx.reply(
                `👑 <b>PANEL SUPER ADMIN</b>\n\n🔧 Maintenance: <b>${db.settings.maintenance ? '🔴 Aktif' : '🟢 Mati'}</b>`,
                { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel }
            );

        case '➕ TAMBAH ADMIN':
            if (!isSuper) return;
            userStates.set(uid, 'ADD_OWNER_ID');
            return ctx.reply('🆔 Masukkan Telegram ID calon Admin:', { reply_markup: MENUS.cancel });

        case '➖ HAPUS ADMIN': {
            if (!isSuper) return;
            const admins = db.settings.owners.filter(o => o !== CONFIG.ownerId);
            userStates.set(uid, 'DEL_OWNER_ID');
            return ctx.reply(
                `📋 <b>Daftar Admin:</b>\n${admins.length ? admins.map(a => `• <code>${a}</code>`).join('\n') : '— Kosong —'}\n\nMasukkan ID yang dihapus:`,
                { parse_mode: 'HTML', reply_markup: MENUS.cancel }
            );
        }

        case '🚧 MAINTENANCE': {
            if (!isSuper) return;
            const on = db.toggleMaintenance();
            return ctx.reply(
                `🔧 <b>Mode Maintenance: ${on ? '🔴 Aktif' : '🟢 Dimatikan'}</b>`,
                { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel }
            );
        }

        case '📢 BROADCAST':
            if (!isSuper) return;
            userStates.set(uid, 'BROADCAST');
            return ctx.reply('📢 Kirim pesan yang ingin di-broadcast:', { reply_markup: MENUS.cancel });

        case '📦 BACKUP DATA':
            if (!isSuper) return;
            await ctx.reply('📦 Mengirim file database...');
            for (const p of Object.values(db.paths)) {
                if (fs.existsSync(p)) await ctx.replyWithDocument({ source: p });
            }
            return;

        case '📋 LIST ADMIN': {
            if (!isSuper) return;
            const list = db.settings.owners.map(id =>
                id === CONFIG.ownerId ? `👑 <code>${id}</code> — Super Admin` : `🛡️ <code>${id}</code> — Admin`
            ).join('\n');
            return ctx.reply(`📋 <b>Struktur Admin</b>\n\n${list}`, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
        }

        case '👥 KELOLA USER':
            if (!isAdmin) return;
            return ctx.reply('👥 <b>MANAJEMEN PENGGUNA</b>', { parse_mode: 'HTML', reply_markup: MENUS.userMan });

        case '➕ TAMBAH DURASI':
            if (!isAdmin) return;
            userStates.set(uid, 'ADD_TIME_ID');
            return ctx.reply('🆔 Masukkan ID User:', { reply_markup: MENUS.cancel });

        case '➖ POTONG DURASI':
            if (!isAdmin) return;
            userStates.set(uid, 'DEL_TIME_ID');
            return ctx.reply('🆔 Masukkan ID User:', { reply_markup: MENUS.cancel });

        case '👥 DAFTAR USER': {
            if (!isAdmin) return;
            const all  = Object.values(db.users);
            const list = all.map((u, i) => {
                const exp = u.expired > 9_000_000_000_000 ? '♾️ VIP'
                          : u.expired > Date.now()        ? fmt.date(u.expired)
                          : '❌ Expired';
                return `${i + 1}. <code>${u.id}</code> | ${u.username} | ${exp}`;
            }).join('\n') || '— Kosong —';
            return ctx.reply(`👥 <b>DATABASE USER (${all.length})</b>\n\n${list}`, { parse_mode: 'HTML', reply_markup: MENUS.userMan });
        }

        case '👤 PROFIL SAYA':
            return showDashboard(ctx, uid, role);

        case '❓ BANTUAN':
            return ctx.reply(
`📖 <b>BANTUAN</b>

1️⃣ <b>KONEKSI WA</b>
   Menu 📱 KONEKSI WA → ➕ TAMBAH NOMOR → Masukkan Nomor → Salin Kode dari tombol → Masukkan ke WhatsApp.

2️⃣ <b>CEK BIO</b>
   Menu 🔎 CEK BIO NOMOR → Kirim list angka/teks.

⚠️ <b>FAILOVER</b>
   Jika sesi terputus, bot akan otomatis pakai sesi lain. Jika semua mati, hasil sebagian akan dikirim.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
    }
});

bot.on('document', async (ctx) => {
    const uid   = String(ctx.from.id);
    const state = userStates.get(uid);
    const role  = await checkAuth(ctx);
    if (!role) return;

    if (state !== 'CEK_BIO_INPUT') return;

    if (!waManager.isConnected(uid)) {
        userStates.delete(uid);
        return ctx.reply('❌ Tidak ada WhatsApp terhubung.', { reply_markup: MENUS.waMenu });
    }

    try {
        const link = await bot.telegram.getFileLink(ctx.message.document.file_id);
        const nums = await extractNumbersFromFile(link.href, ctx.message.document.file_name);
        if (nums.length === 0) return ctx.reply('❌ Tidak ada nomor valid dalam file.');
        checkQueue.push({ ctx, nums, uid });
        userStates.delete(uid);
        if (isChecking) return ctx.reply(`⏳ <b>Masuk Antrian</b>\nPosisi: ${checkQueue.length}`, { parse_mode: 'HTML' });
        runNextCheck();
    } catch (e) {
        ctx.reply(`❌ ${e.message}`);
    }
});

(async () => {
    await waManager.loadAll();
    await bot.launch({ dropPendingUpdates: true });
})();

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
