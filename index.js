import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay
} from 'baileys';
import pino from 'pino';
import express from 'express';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');

// ──────────────────────────────────────────────
// 📋 CONFIG
// ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
// FIX: Ensure MAX_USERS is a valid number, min 1
const MAX_USERS = Math.max(1, parseInt(process.env.MAX_USERS || '10', 10) || 10);
const DEV_IDS = (process.env.DEV_TELEGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number);
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'sessions');
const USER_MAP_FILE = path.join(__dirname, 'user_map.json');
const BACKUP_ZIP_PATH = path.join(__dirname, 'sessions_backup.zip');
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000;

// ──────────────────────────────────────────────
// 📋 COMMANDS
// ──────────────────────────────────────────────
const COMMANDS = {
    '.menu': `✅ *Yes, I am able to respond anywhere!* 🌍

You can customize my menu now. 

💡 Try me in:
• 📱 Personal chats
• 👥 Groups  
• 💬 Self chat

I'm listening everywhere! 🚀`,
    '.ping': 'Pinging... Please wait ⏳',
    '.help': `📖 *Available Commands:*

.menu — Shows bot menu
.ping — Ping test
.help — Shows this help
.info — Bot info

💡 Commands start with a dot (.)`,
    '.info': `🤖 *WhatsApp Multi-Bot*

⚡ Powered by Baileys v7.0.0-rc13
📱 Multi-user support
💬 Type .menu to get started!`
};

// ──────────────────────────────────────────────
// 🔧 STATE
// ──────────────────────────────────────────────
const telegramUsers = new Map();
const waSessions = new Map();
let backupScheduled = false;

function saveUserMap() {
    const map = {};
    for (const [chatId, user] of telegramUsers) {
        if (user.phoneNumber) {
            map[String(chatId)] = { phoneNumber: user.phoneNumber, status: user.status };
        }
    }
    try { fs.writeFileSync(USER_MAP_FILE, JSON.stringify(map, null, 2)); }
    catch (err) { console.error('⚠️ Save user map:', err.message); }
}

function loadUserMap() {
    if (!fs.existsSync(USER_MAP_FILE)) return;
    try {
        const map = JSON.parse(fs.readFileSync(USER_MAP_FILE, 'utf8'));
        for (const [idStr, data] of Object.entries(map)) {
            telegramUsers.set(parseInt(idStr), { phoneNumber: data.phoneNumber, status: data.status, sock: null });
        }
        console.log(`📋 Loaded ${telegramUsers.size} user(s) from disk`);
    } catch (err) { console.error('⚠️ Load user map:', err.message); }
}

// ──────────────────────────────────────────────
// 📱 TELEGRAM BOT
// ──────────────────────────────────────────────
if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_TOKEN not set!');
    process.exit(1);
}

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ──────────────────────────────────────────────
// 🔒 HELPERS
// ──────────────────────────────────────────────
async function safeTgSend(chatId, text) {
    try { await tgBot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); }
    catch {
        await delay(2000);
        try { await tgBot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); }
        catch (e) { console.error('❌ TG send:', e.message); }
    }
}

// FIX: Secure default — if DEV_IDS not set, block everyone
function isDev(chatId) { return DEV_IDS.length > 0 && DEV_IDS.includes(chatId); }

// ──────────────────────────────────────────────
// 📦 BACKUP: Create ZIP
// ──────────────────────────────────────────────
function createBackupZip() {
    return new Promise((resolve, reject) => {
        try {
            const output = fs.createWriteStream(BACKUP_ZIP_PATH);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', () => {
                console.log(`📦 Backup: ${(archive.pointer() / 1024).toFixed(2)} KB`);
                resolve(BACKUP_ZIP_PATH);
            });
            archive.on('error', reject);
            archive.pipe(output);
            if (fs.existsSync(AUTH_DIR)) {
                archive.directory(AUTH_DIR, 'sessions');
            }
            archive.finalize();
        } catch (err) { reject(err); }
    });
}

// ──────────────────────────────────────────────
// 📥 RESTORE FROM TELEGRAM
// ──────────────────────────────────────────────
async function downloadTelegramFile(fileId) {
    const file = await tgBot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Download ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
}

async function restoreFromTelegram() {
    if (!TELEGRAM_CHANNEL_ID) {
        console.log('⚠️ No channel ID, skipping restore');
        return false;
    }
    try {
        console.log('📥 Looking for backup...');
        const chat = await tgBot.getChat(TELEGRAM_CHANNEL_ID);
        if (!chat.pinned_message) {
            console.log('ℹ️ No pinned backup, starting fresh');
            return false;
        }
        const pinned = chat.pinned_message;
        console.log(`📌 Backup from ${new Date(pinned.date * 1000).toLocaleString()}`);

        let fileId = null;
        if (pinned.document) fileId = pinned.document.file_id;
        else if (pinned.photo) fileId = pinned.photo[pinned.photo.length - 1].file_id;
        if (!fileId) { console.log('⚠️ No file in pinned msg'); return false; }

        console.log('📥 Downloading...');
        const buffer = await downloadTelegramFile(fileId);

        // FIX: Extract to temp dir first — only delete AUTH_DIR if extract succeeds
        console.log('📂 Extracting...');
        const TEMP_DIR = path.join(__dirname, 'sessions_restore_temp');
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        const zip = new AdmZip(buffer);
        zip.extractAllTo(TEMP_DIR, true);

        // Verify extraction produced sessions before deleting current AUTH_DIR
        const restoredCount = fs.readdirSync(TEMP_DIR).filter(f =>
            fs.statSync(path.join(TEMP_DIR, f)).isDirectory()
        ).length;

        if (restoredCount === 0) {
            console.log('⚠️ Backup had no sessions, keeping current state');
            try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
            return false;
        }

        // Extraction successful — now replace AUTH_DIR
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.renameSync(TEMP_DIR, AUTH_DIR);

        if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
            const count = restoredCount;
            console.log(`✅ Restored ${count} session(s)`);
            return true;
        }
        return false;
    } catch (err) {
        console.error('❌ Restore failed:', err.message);
        return false;
    }
}

// ──────────────────────────────────────────────
// 📤 BACKUP TO CHANNEL
// FIX: Debounced — schedules one backup, prevents concurrent uploads
// Always resets backupScheduled flag in finally
// ──────────────────────────────────────────────
function scheduleBackup() {
    if (backupScheduled || !TELEGRAM_CHANNEL_ID) return;
    backupScheduled = true;

    setTimeout(async () => {
        try {
            await createBackupZip();
            if (!fs.existsSync(BACKUP_ZIP_PATH)) return;

            let oldPinId = null;
            try {
                const chat = await tgBot.getChat(TELEGRAM_CHANNEL_ID);
                if (chat.pinned_message) oldPinId = chat.pinned_message.message_id;
            } catch {}

            console.log('📤 Uploading backup...');
            const sent = await tgBot.sendDocument(TELEGRAM_CHANNEL_ID, BACKUP_ZIP_PATH, {
                caption: `🔄 Backup\n📅 ${new Date().toLocaleString()}\n👥 ${waSessions.size} users`
            });
            await tgBot.pinChatMessage(TELEGRAM_CHANNEL_ID, sent.message_id, { disable_notification: true });
            console.log('📌 Pinned');

            if (oldPinId) {
                try { await tgBot.deleteMessage(TELEGRAM_CHANNEL_ID, oldPinId); console.log('🗑️ Old deleted'); } catch {}
            }
            try { fs.unlinkSync(BACKUP_ZIP_PATH); } catch {}
        } catch (err) {
            console.error('❌ Backup failed:', err.message);
        } finally {
            backupScheduled = false;
        }
    }, 3000);
}

// ──────────────────────────────────────────────
// 💬 MESSAGE EXTRACT
// ──────────────────────────────────────────────
function extractMessageText(msg) {
    if (!msg.message) return '';
    try {
        if (msg.message.conversation) return msg.message.conversation;
        if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
        if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
        if (msg.message.videoMessage?.caption) return msg.message.videoMessage.caption;
        if (msg.message.documentMessage?.caption) return msg.message.documentMessage.caption;
        const mt = Object.keys(msg.message)[0];
        if (msg.message[mt]?.text) return msg.message[mt].text;
        return '';
    } catch { return ''; }
}

async function handleWhatsAppMessage(sock, msg, phoneNumber, tgId) {
    const text = extractMessageText(msg).trim();
    if (!text || !text.startsWith('.')) return;
    console.log(`📨 ${phoneNumber}: "${text}" from ${msg.key.remoteJid}`);
    const cmd = Object.keys(COMMANDS).find(c => text.toLowerCase() === c.toLowerCase());
    if (cmd) {
        try {
            await sock.sendMessage(msg.key.remoteJid, { text: COMMANDS[cmd] }, { quoted: msg });
            console.log(`✅ ${phoneNumber} → ${cmd}`);
        } catch (e) { console.error('❌ Send:', e.message); }
    } else {
        try {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Unknown: "${text}"\n\nType .help`
            }, { quoted: msg });
        } catch (e) { console.error('Send:', e.message); }
    }
}

// ──────────────────────────────────────────────
// 🔌 SOCKET EVENT SETUP
// FIX: 500 (Bad Session) → Clean auth folder immediately to prevent loops
// FIX: 515 → Create new socket with saved creds (per Baileys wiki)
// ──────────────────────────────────────────────
async function restartAfter515(phoneNumber, tgId, userAuthDir, version) {
    console.log(`🔄 ${phoneNumber}: 515 — creating new socket with saved creds...`);

    // Wait for creds to flush to disk (Baileys fires creds.update before 515)
    await delay(3000);

    try {
        // Reload auth state from disk (contains freshly saved credentials)
        const { state, saveCreds } = await useMultiFileAuthState(userAuthDir);

        if (!state.creds?.registered) {
            console.log(`⚠️ ${phoneNumber}: Creds not saved yet, retrying in 5s...`);
            await delay(5000);
            // Try once more
            const { state: rs, saveCreds: rsc } = await useMultiFileAuthState(userAuthDir);
            if (!rs.creds?.registered) {
                console.log(`❌ ${phoneNumber}: Creds still not ready after 515. Cleaning up...`);
                // FIX: Clean corrupted auth folder
                try { fs.rmSync(userAuthDir, { recursive: true, force: true }); } catch {}
                telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null });
                waSessions.delete(phoneNumber);
                saveUserMap();
                if (tgId) await safeTgSend(tgId, `❌ *Pairing Failed!*\n\nCredentials not saved. Please try /pair again.`);
                scheduleBackup();
                return;
            }
            // Use retry state
            const newSock = makeWASocket({
                version, logger: pino({ level: 'silent' }), auth: rs,
                browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
                printQRInTerminal: false, generateHighQualityLinkPreview: true,
                syncFullHistory: false, markOnlineOnConnect: true
            });
            newSock.ev.on('creds.update', rsc);
            waSessions.set(phoneNumber, { telegramChatId: tgId, sock: newSock });
            telegramUsers.set(tgId, { phoneNumber, status: 'connecting', sock: newSock });
            saveUserMap();
            setupSocketEvents(newSock, phoneNumber, tgId, userAuthDir, version, false);
            setupMessageHandler(newSock, phoneNumber, tgId);
            return;
        }

        // Creds are ready — create new socket
        const newSock = makeWASocket({
            version, logger: pino({ level: 'silent' }), auth: state,
            browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
            printQRInTerminal: false, generateHighQualityLinkPreview: true,
            syncFullHistory: false, markOnlineOnConnect: true
        });
        newSock.ev.on('creds.update', saveCreds);

        waSessions.set(phoneNumber, { telegramChatId: tgId, sock: newSock });
        telegramUsers.set(tgId, { phoneNumber, status: 'connecting', sock: newSock });
        saveUserMap();

        setupSocketEvents(newSock, phoneNumber, tgId, userAuthDir, version, false);
        setupMessageHandler(newSock, phoneNumber, tgId);

    } catch (err) {
        console.error(`❌ ${phoneNumber}: 515 restart failed:`, err.message);
    }
}

function setupSocketEvents(sock, phoneNumber, tgId, userAuthDir, version, isRestore) {
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;

            // ── 515: WhatsApp forces reconnect after pairing ──
            if (code === 515) {
                await restartAfter515(phoneNumber, tgId, userAuthDir, version);
                return;
            }

            // ── 500: Bad Session (Corrupted Auth) ──
            // FIX: If pairing attempt fails with 500, clean auth folder to prevent loop
            if (code === 500) {
                console.log(`⚠️ ${phoneNumber}: Bad Session (500). Cleaning auth folder...`);
                try { fs.rmSync(userAuthDir, { recursive: true, force: true }); } catch {}
                telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null });
                waSessions.delete(phoneNumber);
                saveUserMap();
                if (tgId) await safeTgSend(tgId, `⚠️ *Session Error!*\n\nBad session detected. Auth files cleaned.\nPlease try pairing again with /pair.`);
                scheduleBackup();
                return;
            }

            // ── Normal close ──
            console.log(`❌ ${phoneNumber} closed (code: ${code})`);

            if (code === DisconnectReason.loggedOut) {
                console.log(`📱 ${phoneNumber}: Logged out`);
                telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null });
                waSessions.delete(phoneNumber);
                saveUserMap();
                try { fs.rmSync(userAuthDir, { recursive: true, force: true }); } catch {}
                try { if (tgId) await safeTgSend(tgId, `📱 *Logged Out!*\n\nUse /pair again.`); } catch {}
                scheduleBackup();
                return;
            }

            // Other codes — Baileys auto-reconnects
            if (code !== DisconnectReason.loggedOut) {
                console.log(`🔄 ${phoneNumber}: Reconnecting (${code})`);
                telegramUsers.set(tgId, { phoneNumber, status: 'connecting', sock });
                saveUserMap();
                await delay(5000);
            } else {
                telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null });
                waSessions.delete(phoneNumber);
                saveUserMap();
            }

        } else if (connection === 'open') {
            console.log(`✅ ${phoneNumber}: Connected!`);
            telegramUsers.set(tgId, { phoneNumber, status: 'connected', sock });
            saveUserMap();
            scheduleBackup();

            try {
                if (tgId) await safeTgSend(tgId,
                    `✅✅✅ *Connected!* ✅✅✅\n\n📱 ${phoneNumber}\n🤖 Bot active!\n\nType .menu in WhatsApp.`
                );
            } catch {}

            // Self-chat message after 5s
            setTimeout(async () => {
                try {
                    const myJid = sock.authState.creds.me?.id;
                    if (myJid) {
                        const jid = myJid.split(':')[0] + '@s.whatsapp.net';
                        await sock.sendMessage(jid, { text: '✅ Bot connected! Type .menu' });
                        console.log(`📨 Self msg → ${jid}`);
                    }
                } catch (e) { console.error('Self msg:', e.message); }
            }, 5000);

        } else if (connection === 'connecting' && !sock.authState.creds.registered && !isRestore) {
            // Generate pairing code (new pairings only)
            try {
                await delay(2000);
                const code = await sock.requestPairingCode(phoneNumber);
                await safeTgSend(tgId,
                    `🔓 *PAIRING CODE*\n\nCode: ${code}\n\n📋 *Steps:*\n1. WhatsApp → Settings → Linked Devices\n2. "Link a Device"\n3. "Link with phone number"\n4. Enter: ${code}\n\n⚠️ 60 seconds!`
                );
                console.log(`🔑 Code for ${phoneNumber}: ${code}`);
            } catch (err) {
                console.error(`❌ Code failed:`, err.message);
                await safeTgSend(tgId, `❌ Failed: ${err.message}\n\nUse /pair to retry.`);
            }
        }
    });
}

function setupMessageHandler(sock, phoneNumber, tgId) {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key?.fromMe || !msg.message) continue;
            try { await handleWhatsAppMessage(sock, msg, phoneNumber, tgId); }
            catch (e) { console.error(`Msg ${phoneNumber}:`, e.message); }
        }
    });
}

// ──────────────────────────────────────────────
// 🔑 INITIATE PAIRING
// ──────────────────────────────────────────────
async function initiatePairing(tgId, phoneNumber) {
    console.log(`\n🔑 Pairing ${phoneNumber} (TG: ${tgId})`);

    // Check MAX_USERS
    const count = fs.existsSync(AUTH_DIR)
        ? fs.readdirSync(AUTH_DIR).filter(f => fs.statSync(path.join(AUTH_DIR, f)).isDirectory()).length
        : 0;
    if (count >= MAX_USERS) {
        await safeTgSend(tgId, `🚫 *Server Full!*\n\nMax ${MAX_USERS} users.`);
        telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null });
        saveUserMap();
        return;
    }

    // Check duplicate
    for (const [id, u] of telegramUsers) {
        if (id !== tgId && u.phoneNumber === phoneNumber && u.status === 'connected') {
            await safeTgSend(tgId, '❌ Number already connected.');
            telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null });
            saveUserMap();
            return;
        }
    }

    const userAuthDir = path.join(AUTH_DIR, phoneNumber);
    if (!fs.existsSync(userAuthDir)) fs.mkdirSync(userAuthDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(userAuthDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, logger: pino({ level: 'silent' }), auth: state,
        browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
        printQRInTerminal: false, generateHighQualityLinkPreview: true,
        syncFullHistory: false, markOnlineOnConnect: true
    });
    sock.ev.on('creds.update', saveCreds);
    setupSocketEvents(sock, phoneNumber, tgId, userAuthDir, version, false);
    setupMessageHandler(sock, phoneNumber, tgId);
    saveUserMap();
}

// ──────────────────────────────────────────────
// 🔄 RESTORE ALL SESSIONS
// ──────────────────────────────────────────────
async function restoreAllSessions() {
    const dirs = fs.readdirSync(AUTH_DIR);
    for (const dir of dirs) {
        const authPath = path.join(AUTH_DIR, dir);
        if (!fs.statSync(authPath).isDirectory()) continue;
        try {
            const phoneNumber = dir;
            const { state, saveCreds } = await useMultiFileAuthState(authPath);
            if (!state?.creds?.registered) {
                console.log(`⚠️ ${phoneNumber}: Not registered`);
                continue;
            }
            let tgId = null;
            for (const [cid, u] of telegramUsers) {
                if (u.phoneNumber === phoneNumber) { tgId = cid; break; }
            }
            const { version } = await fetchLatestBaileysVersion();
            const sock = makeWASocket({
                version, logger: pino({ level: 'silent' }), auth: state,
                browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
                printQRInTerminal: false, generateHighQualityLinkPreview: true,
                syncFullHistory: false, markOnlineOnConnect: true
            });
            sock.ev.on('creds.update', saveCreds);
            waSessions.set(phoneNumber, { telegramChatId: tgId, sock });
            if (tgId) telegramUsers.set(tgId, { phoneNumber, status: 'connecting', sock });
            saveUserMap();

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    // 515 — Baileys auto-reconnects for already-paired sessions
                    if (code === 515) {
                        console.log(`🔄 ${phoneNumber}: 515 — reconnecting`);
                        return;
                    }
                    // 500 — Bad session for restored user
                    if (code === 500) {
                        console.log(`⚠️ ${phoneNumber}: Bad session (500). Cleaning...`);
                        waSessions.delete(phoneNumber);
                        if (tgId) { telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null }); saveUserMap(); }
                        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
                        scheduleBackup();
                        return;
                    }
                    if (code === DisconnectReason.loggedOut) {
                        console.log(`📱 ${phoneNumber}: Logged out`);
                        waSessions.delete(phoneNumber);
                        if (tgId) { telegramUsers.set(tgId, { phoneNumber: null, status: 'disconnected', sock: null }); saveUserMap(); }
                        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
                        return;
                    }
                    console.log(`🔄 ${phoneNumber}: Reconnecting (${code})`);
                    await delay(5000);
                } else if (connection === 'open') {
                    console.log(`✅ ${phoneNumber}: Restored & connected!`);
                    if (tgId) { telegramUsers.set(tgId, { phoneNumber, status: 'connected', sock }); saveUserMap(); }
                    setTimeout(async () => {
                        try {
                            const myJid = sock.authState.creds.me?.id;
                            if (myJid) {
                                const jid = myJid.split(':')[0] + '@s.whatsapp.net';
                                await sock.sendMessage(jid, { text: '✅ Bot connected! Type .menu' });
                            }
                        } catch (e) { console.error('Self msg:', e.message); }
                    }, 5000);
                }
            });
            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;
                for (const m of messages) {
                    if (m.key?.fromMe || !m.message) continue;
                    try { await handleWhatsAppMessage(sock, m, phoneNumber, tgId); }
                    catch (e) { console.error('Msg:', e.message); }
                }
            });
            console.log(`✅ Restored: ${phoneNumber}${tgId ? ` (TG: ${tgId})` : ''}`);
        } catch (err) {
            console.error(`❌ Restore ${dir}:`, err.message);
        }
    }
}

// ──────────────────────────────────────────────
// 📱 TELEGRAM HANDLERS
// FIX: Single message handler skips commands (let onText handle them)
// ──────────────────────────────────────────────

tgBot.onText(/\/start/, async (msg) => {
    try {
        const cid = msg.chat.id;
        const ex = telegramUsers.get(cid);
        if (ex?.status === 'connected') {
            await safeTgSend(cid, `✅ *Connected!*\n📱 ${ex.phoneNumber}`);
            return;
        }
        await safeTgSend(cid, `🤖 *WhatsApp Multi-Bot*\n\nSend your number to pair (with country code, NO + sign).\nExample: 2348012345678\n\n/pair — Start pairing\n/status — Status (Admin)\n/disconnect — Disconnect (Admin)\n/help — Commands`);
    } catch (err) { console.error('❌ /start:', err.message); }
});

tgBot.onText(/\/pair/, async (msg) => {
    try {
        const cid = msg.chat.id;
        const ex = telegramUsers.get(cid);
        if (ex?.status === 'connected') {
            await safeTgSend(cid, '❌ Already connected. Use /disconnect first.');
            return;
        }
        if (ex?.status === 'pairing' || ex?.status === 'waiting_number') {
            await safeTgSend(cid, '⏳ Already pairing. Send your number.');
            return;
        }
        telegramUsers.set(cid, { phoneNumber: null, status: 'waiting_number', sock: null });
        saveUserMap();
        await safeTgSend(cid, `📱 *Enter your number*\n\nCountry code + number (NO + sign)\nExample: 2348012345678`);
    } catch (err) { console.error('❌ /pair:', err.message); }
});

// FIX: Skip commands — let onText handlers deal with them
tgBot.on('message', async (msg) => {
    try {
        const cid = msg.chat.id;
        const text = msg.text?.trim();

        if (msg.chat.type !== 'private') return;
        if (!text) return;
        if (text.startsWith('/')) return; // Skip commands

        const user = telegramUsers.get(cid);
        if (!user) { await safeTgSend(cid, '🤖 Use /start to begin!'); return; }

        if (user.status === 'waiting_number') {
            const num = text.replace(/\D/g, '');
            if (num.length < 10 || num.length > 15) {
                await safeTgSend(cid, '❌ Invalid. Example: 2348012345678');
                return;
            }
            // Check duplicate
            for (const [id, u] of telegramUsers) {
                if (id !== cid && u.phoneNumber === num && u.status === 'connected') {
                    await safeTgSend(cid, '❌ Number already connected.');
                    telegramUsers.set(cid, { phoneNumber: null, status: 'disconnected', sock: null });
                    saveUserMap();
                    return;
                }
            }
            telegramUsers.set(cid, { phoneNumber: num, status: 'pairing', sock: null });
            saveUserMap();
            await safeTgSend(cid, `🔑 *Connecting...*\n\n📱 ${num}\n\n⏳ Generating code...`);
            try {
                await initiatePairing(cid, num);
            } catch (err) {
                console.error(`Pairing failed ${num}:`, err.message);
                await safeTgSend(cid, `❌ Failed.\n${err.message}\n\nUse /pair to retry.`);
                telegramUsers.set(cid, { phoneNumber: null, status: 'disconnected', sock: null });
                saveUserMap();
            }
        }
    } catch (err) { console.error('❌ message:', err.message); }
});

tgBot.onText(/\/status/, async (msg) => {
    try {
        const cid = msg.chat.id;
        if (!isDev(cid)) { await safeTgSend(cid, '⛔ Admins only.'); return; }
        const user = telegramUsers.get(cid);
        if (!user || user.status === 'disconnected') {
            await safeTgSend(cid, '❌ Not connected.\n/pair to connect.');
            return;
        }
        const info = {
            'waiting_number': '⏳ Waiting',
            'pairing': '🔑 Pairing',
            'connecting': '🔄 Connecting',
            'connected': '✅ Connected'
        };
        await safeTgSend(cid, `📊 *Status*\n\n📱 ${user.phoneNumber}\n${info[user.status] || '❓'}\n👥 ${waSessions.size}/${MAX_USERS}`);
    } catch (err) { console.error('❌ /status:', err.message); }
});

tgBot.onText(/\/disconnect/, async (msg) => {
    try {
        const cid = msg.chat.id;
        if (!isDev(cid)) { await safeTgSend(cid, '⛔ Admins only.'); return; }
        const user = telegramUsers.get(cid);
        if (!user || !user.phoneNumber) { await safeTgSend(cid, '❌ No connection.'); return; }
        const pn = user.phoneNumber;

        // End socket cleanly
        const sess = waSessions.get(pn);
        if (sess?.sock) {
            try { await sess.sock.end(undefined); } catch {}
        }
        waSessions.delete(pn);

        // Delete auth folder
        const ap = path.join(AUTH_DIR, pn);
        try { fs.rmSync(ap, { recursive: true, force: true }); } catch {}

        // Reset user
        telegramUsers.set(cid, { phoneNumber: null, status: 'disconnected', sock: null });
        saveUserMap();

        scheduleBackup();

        await safeTgSend(cid, `✅ Disconnected ${pn}.`);
    } catch (err) { console.error('❌ /disconnect:', err.message); }
});

tgBot.onText(/\/help/, async (msg) => {
    try {
        await safeTgSend(msg.chat.id, `📖 *Commands*\n\n/start — Welcome\n/pair — Connect\n/status — Status (Admin)\n/disconnect — Disconnect (Admin)\n/help — This\n\n*WhatsApp:*\n.menu .ping .help .info`);
    } catch (err) { console.error('❌ /help:', err.message); }
});

// ──────────────────────────────────────────────
// 🌐 EXPRESS
// ──────────────────────────────────────────────
const app = express();
app.get('/', (req, res) => {
    res.json({ status: 'online', sessions: waSessions.size, users: telegramUsers.size, max: MAX_USERS, uptime: process.uptime() });
});
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB' });
});
app.get('/ping', (req, res) => { res.send('pong'); });

// ──────────────────────────────────────────────
// 🚀 MAIN
// ──────────────────────────────────────────────
async function main() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    loadUserMap();

    console.log('\n' + '🔷'.repeat(30));
    console.log('   🤖  WHATSAPP MULTI-BOT');
    console.log('   📦  Baileys v7.0.0-rc13');
    console.log('   📱  Telegram Pairing + Backup');
    console.log('🔷'.repeat(30) + '\n');

    const restored = await restoreFromTelegram();
    if (restored) {
        console.log('✅ Restored. Reconnecting...\n');
        await restoreAllSessions();
    } else {
        console.log('ℹ️ Starting fresh\n');
    }

    app.listen(PORT, () => {
        console.log(`🌐 Port ${PORT}`);
        console.log(`📱 Telegram active`);
        console.log(`👥 Max: ${MAX_USERS}`);
        console.log(`🔒 Devs: ${DEV_IDS.length ? DEV_IDS.join(', ') : 'NONE'}`);
        console.log(`📡 Channel: ${TELEGRAM_CHANNEL_ID || 'NOT SET'}`);
        console.log(`\n💬 Users can message the bot!\n`);
    });
}

main().catch(err => { console.error('💥 Fatal:', err); process.exit(1); });

const renderUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => { try { await fetch(`${renderUrl}/ping`); } catch {} }, KEEP_ALIVE_INTERVAL);

process.on('SIGTERM', () => { console.log('\n👋 Shutting down...'); process.exit(0); });
process.on('SIGINT', () => { console.log('\n👋 Shutting down...'); process.exit(0); });
