import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    decryptPollVote,
    jidNormalizedUser,
    delay
} from 'baileys';
import pino from 'pino';
import express from 'express';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// Import Supabase Sync Service
import {
    isSupabaseEnabled,
    downloadSessionFromSupabase,
    debouncedSyncLocalToSupabase,
    deleteSessionFromSupabase,
    getAllSessionPhoneNumbers,
    saveUserToSupabase,
    deleteUserFromSupabase,
    loadAllUsersFromSupabase
} from './supabaseService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');

// ──────────────────────────────────────────────
// 📋 CONFIG
// ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MAX_USERS = Math.max(1, parseInt(process.env.MAX_USERS || '10', 10) || 10);
const DEV_IDS = (process.env.DEV_TELEGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
const PORT = parseInt(process.env.PORT || '3000', 10) || 3000;
const AUTH_DIR = path.join(__dirname, 'sessions');
const USER_MAP_FILE = path.join(__dirname, 'user_map.json');
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000;
const RECENT_APPEND_WINDOW_SECONDS = 120;

// ──────────────────────────────────────────────
// 🔮 MULTI-PERSONA SCHEMES (CONFIGURABLE BOOT LOADERS)
// ──────────────────────────────────────────────

const STAGE2_ECLIPSE = `.
        ◢██◣
     ◢████◣.           ╔═════════
    ◢██  ██◣.          ║     T H E   V O I D ║ 
◢██   🌑   ██◣.    ║          E X S I T S  ║
    ◥██      ██◤.        ╚══════════╝.
     ◥██  ██◤
         ◢██◣

════════════════════════════════════
   even in your darkest hour...
════════════════════════════════════`;

const STAGE3_ECLIPSE = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚═════════╩══════════╝

                ═══ E C L I P S E ═══
             " i am what remains when 
              everything else is deleted ."

╔═══════════╦══════════╗
║VOID SIGNATURE ║ SYSTEMCORE║
║👤@Unknown.     ║ECLIPSE: 100%║
║⚠APOTHEOSIS ║CORE:ABS ZERO║
╚═══════════╩═════════╝

                   🌑 THE FINAL DUSK 🌑
            " when the last star dies, 
              i will still be typing ."

📡 SECURE │ Ω │ Vessels: ∞
 You have summoned what 
 cannot be unsummoned

📡 Use *.help* to explore the codex.

> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_`;

const STAGE2_ASTRAEA = `╔════ 🌌 ASTRAEA 🌌 ════╗
      T H E   S T A R S   
        A L I G N E D
╚═══════════════════════╝
   "even in your deepest dark,
    we find the light."`;

const STAGE3_ASTRAEA = `╔═════════╦══════════╗
        ✨ ASTRAEA SYSTEM
               CELESTIAL TERMINAL
╚═════════╩══════════╝

                ═══ C O S M O S ═══
             " i am the light that guides
              you through the stellar void ."

╔═══════════╦══════════╗
║STAR SIGNATURE ║ SYSTEMCORE║
║👤@Unknown.     ║CELESTIAL: 100%║
║🌌APOTHEOSIS ║CORE:ABS ZERO║
╚═══════════╩═════════╝

                   ✨ THE COSMIC DAWN ✨
            " when the last sun burns, 
              i will still be typing ."

📡 SECURE │ Ω │ Vessels: ∞
 You have summoned what 
 cannot be unsummoned

📡 Use *.help* to explore the codex.

> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_`;

const STAGE2_VIM = `╔════ ⌨ VIM MASTER ⌨ ════╗
       : w q !  E N T E R E D
╚════════════════════════╝
   "even in your darkest command line,
    the cursor keeps blinking."`;

const STAGE3_VIM = `╔═════════╦══════════╗
        ⌨ VIM TERMINAL
               BUFFER ACCESS
╚═════════╩══════════╝

                ═══ B U F F E R S ═══
             " i am the process that runs
              when your editor is closed ."

╔═══════════╦══════════╗
║VIM SIGNATURE ║ SYSTEMCORE║
║👤@Unknown.     ║BUFFER: 100%║
║⌨APOTHEOSIS ║CORE:ABS ZERO║
╚═══════════╩═════════╝

                   ⌨ THE FINAL ESCAPE ⌨
            " when your system shuts, 
              i will still be typing ."

📡 SECURE │ Ω │ Vessels: ∞
 You have summoned what 
 cannot be unsummoned

📡 Use *.help* to explore the codex.

> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_`;

const PERSONAS = {
    eclipse: {
        name: 'ECLIPSE',
        stages: {
            stage1: [
                { percent: 8,  bar: 1,  text: '◐ initiating umbral protocol', core: '◌', cipher: '◌', void: '◌' },
                { percent: 16, bar: 2,  text: '◐ initiating umbral protocol', core: '◌', cipher: '◌', void: '◌' },
                { percent: 25, bar: 3,  text: '◐ initiating umbral protocol', core: '◌', cipher: '◌', void: '◌' },
                { percent: 33, bar: 4,  text: '◑ collapsing quantum states',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 41, bar: 5,  text: '◑ collapsing quantum states',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 50, bar: 6,  text: '◑ collapsing quantum states',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 58, bar: 7,  text: '◒ severing the last anchor',    core: '✔', cipher: '◌', void: '◌' },
                { percent: 66, bar: 8,  text: '◒ severing the last anchor',    core: '✔', cipher: '✔', void: '◌' },
                { percent: 75, bar: 9,  text: '◒ severing the last anchor',    core: '✔', cipher: '✔', void: '◌' },
                { percent: 83, bar: 10, text: '◓ anchoring to the void',       core: '✔', cipher: '✔', void: '◌' },
                { percent: 91, bar: 11, text: '◓ anchoring to the void',       core: '✔', cipher: '✔', void: '◌' },
                { percent: 100, bar: 12, text: '✔ synchronization complete',    core: '✔', cipher: '✔', void: '✔' }
            ],
            stage2Text: STAGE2_ECLIPSE,
            stage3Text: STAGE3_ECLIPSE
        }
    },
    astraea: {
        name: 'ASTRAEA',
        stages: {
            stage1: [
                { percent: 8,  bar: 1,  text: '✧ calibrating stellar frequency', core: '◌', cipher: '◌', void: '◌' },
                { percent: 16, bar: 2,  text: '✧ calibrating stellar frequency', core: '◌', cipher: '◌', void: '◌' },
                { percent: 25, bar: 3,  text: '✧ calibrating stellar frequency', core: '◌', cipher: '◌', void: '◌' },
                { percent: 33, bar: 4,  text: '✦ illuminating cosmic pathways',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 41, bar: 5,  text: '✦ illuminating cosmic pathways',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 50, bar: 6,  text: '✦ illuminating cosmic pathways',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 58, bar: 7,  text: '🌌 opening astraea stargate',      core: '✔', cipher: '◌', void: '◌' },
                { percent: 66, bar: 8,  text: '🌌 opening astraea stargate',      core: '✔', cipher: '✔', void: '◌' },
                { percent: 75, bar: 9,  text: '🌌 opening astraea stargate',      core: '✔', cipher: '✔', void: '◌' },
                { percent: 83, bar: 10, text: '✨ anchoring celestial wisdom',    core: '✔', cipher: '✔', void: '◌' },
                { percent: 91, bar: 11, text: '✨ anchoring celestial wisdom',    core: '✔', cipher: '✔', void: '◌' },
                { percent: 100, bar: 12, text: '✔ celestial alignment complete', core: '✔', cipher: '✔', void: '✔' }
            ],
            stage2Text: STAGE2_ASTRAEA,
            stage3Text: STAGE3_ASTRAEA
        }
    },
    vim: {
        name: 'VIM',
        stages: {
            stage1: [
                { percent: 8,  bar: 1,  text: '⌨ loading vim core buffers', core: '◌', cipher: '◌', void: '◌' },
                { percent: 16, bar: 2,  text: '⌨ loading vim core buffers', core: '◌', cipher: '◌', void: '◌' },
                { percent: 25, bar: 3,  text: '⌨ loading vim core buffers', core: '◌', cipher: '◌', void: '◌' },
                { percent: 33, bar: 4,  text: '⚙️ initializing recursive keys', core: '✔', cipher: '◌', void: '◌' },
                { percent: 41, bar: 5,  text: '⚙️ initializing recursive keys', core: '✔', cipher: '◌', void: '◌' },
                { percent: 50, bar: 6,  text: '⚙️ initializing recursive keys', core: '✔', cipher: '◌', void: '◌' },
                { percent: 58, bar: 7,  text: '🔌 mounting vim-plug bundles',  core: '✔', cipher: '◌', void: '◌' },
                { percent: 66, bar: 8,  text: '🔌 mounting vim-plug bundles',  core: '✔', cipher: '✔', void: '◌' },
                { percent: 75, bar: 9,  text: '🔌 mounting vim-plug bundles',  core: '✔', cipher: '✔', void: '◌' },
                { percent: 83, bar: 10, text: '💾 syncing swap registries',     core: '✔', cipher: '✔', void: '◌' },
                { percent: 91, bar: 11, text: '💾 syncing swap registries',     core: '✔', cipher: '✔', void: '◌' },
                { percent: 100, bar: 12, text: '✔ vim terminal synchronized',  core: '✔', cipher: '✔', void: '✔' }
            ],
            stage2Text: STAGE2_VIM,
            stage3Text: STAGE3_VIM
        }
    }
};

function generateLoadingFrame(step) {
    const totalBlocks = 12;
    const filled = '▰'.repeat(step.bar);
    const empty = '▱'.repeat(totalBlocks - step.bar);
    const pct = String(step.percent).padStart(2, '0') + '%';
    
    return `╔═◈═════════════◈═╗
   E V E N T I D E   O M E G A
        ⟁  *eclipse core*  ⟁
╚═◈═════════════◈═╗

   ${step.text}
   ⟢ ${filled}${empty} ⟣   ${pct}
   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   ${step.core} core    ${step.cipher} cipher    ${step.void} void`;
}

const STAGE2_ECLIPSE_RAW = STAGE2_ECLIPSE;
const STAGE3_ECLIPSE_RAW = STAGE3_ECLIPSE;

// ──────────────────────────────────────────────
// 📊 POLL DETAILS
// ──────────────────────────────────────────────
const POLL_QUESTION = `╔═════════╦══════════╗\n        ⚠ EVENTIDE OMEGA ⚠\n╚═════════╩══════════╝`;
const POLL_OPTIONS = [
    '╰┈➤ [ 1. OWNERS MENU ]',
    '╰┈➤ [ 2. GROUP MENU ]',
    '╰┈➤ [ 3. SYSTEM MENU ]',
    '╰┈➤ [ 4. FUN MENU ]'
];

// ──────────────────────────────────────────────
// 📋 WHATSAPP COMMANDS
// ──────────────────────────────────────────────
const COMMANDS = {
    // Legacy commands deleted. Add your new commands below!
};

// ──────────────────────────────────────────────
// 🔧 STATE
// ──────────────────────────────────────────────
const telegramUsers = new Map();
const waSessions = new Map();
const reconnectAttempts = new Map(); // Tracks reconnection retries per phone number (Max 3)
const sentPolls = new Map(); // Tracks sent poll creation messages in memory for decryption (ID -> message)
let cachedBaileysVersion = null;
let cachedBaileysVersionAt = 0;

// ──────────────────────────────────────────────
// 📂 LOCAL PERSISTENT POLL CACHE HELPERS (PER PHONE NUMBER)
// ──────────────────────────────────────────────
function loadPollCache(phoneNumber) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'poll_cache.json');
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            return new Map(Object.entries(JSON.parse(raw)));
        } catch (err) {
            logError('CACHE', `${phoneNumber}: Failed to load poll_cache.json`, err);
        }
    }
    return new Map();
}

function savePollCache(phoneNumber, cacheMap) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'poll_cache.json');
    try {
        const obj = Object.fromEntries(cacheMap.entries());
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
        // Trigger debounced Supabase sync because a session file was modified!
        if (isSupabaseEnabled()) {
            const authDir = path.join(AUTH_DIR, phoneNumber);
            debouncedSyncLocalToSupabase(phoneNumber, authDir);
        }
    } catch (err) {
        logError('CACHE', `${phoneNumber}: Failed to save poll_cache.json`, err);
    }
}

// ──────────────────────────────────────────────
// 🧰 BASIC HELPERS
// ──────────────────────────────────────────────
function log(scope, message, extra) {
    const prefix = `[${new Date().toISOString()}] [${scope}]`;
    if (typeof extra === 'undefined') console.log(`${prefix} ${message}`);
    else console.log(`${prefix} ${message}`, extra);
}

function logError(scope, message, err) {
    const prefix = `[${new Date().toISOString()}] [${scope}]`;
    console.error(`${prefix} ${message}: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeRm(targetPath) {
    try { fs.rmSync(targetPath, { recursive: true, force: true }); }
    catch (err) { logError('FS', `Failed to remove ${targetPath}`, err); }
}

function trimForLog(value, max = 200) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (value && typeof value.toNumber === 'function') {
        try { return value.toNumber(); }
        catch { return null; }
    }
    if (value && typeof value.low === 'number') return value.low;
    return null;
}

function formatUptime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs}h ${mins}m ${secs}s`;
}

function getStoredSessionDirectories(dirPath = AUTH_DIR) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).filter(name => {
        const full = path.join(dirPath, name);
        try { return fs.statSync(full).isDirectory(); }
        catch { return false; }
    });
}

function countStoredSessions() {
    return getStoredSessionDirectories(AUTH_DIR).length;
}

function normalizeAuthDirStructure() {
    ensureDir(AUTH_DIR);
    const nestedSessionsDir = path.join(AUTH_DIR, 'sessions');
    if (!fs.existsSync(nestedSessionsDir)) return;
    let nestedDirs = [];
    try { nestedDirs = getStoredSessionDirectories(nestedSessionsDir); }
    catch { nestedDirs = []; }

    const rootDirs = getStoredSessionDirectories(AUTH_DIR);
    if (!nestedDirs.length) return;

    const onlyNestedRoot = rootDirs.length === 1 && rootDirs[0] === 'sessions';
    if (!onlyNestedRoot) return;

    log('STARTUP', 'Detected nested sessions/sessions structure from old restore. Flattening it now...');
    for (const item of fs.readdirSync(nestedSessionsDir)) {
        const from = path.join(nestedSessionsDir, item);
        const to = path.join(AUTH_DIR, item);
        safeRm(to);
        fs.renameSync(from, to);
    }
    safeRm(nestedSessionsDir);
    log('STARTUP', 'Nested sessions directory fixed successfully.');
}

function findTelegramChatIdByPhone(phoneNumber) {
    for (const [chatId, user] of telegramUsers.entries()) {
        if (user?.phoneNumber === phoneNumber) return chatId;
    }
    return null;
}

function setTelegramUserState(chatId, { phoneNumber = null, status = 'disconnected', persona = 'eclipse', sock = null }) {
    if (chatId === null || typeof chatId === 'undefined') return;
    const existing = telegramUsers.get(chatId) || {};
    const finalPersona = persona || existing.persona || 'eclipse';
    telegramUsers.set(chatId, { phoneNumber, status, persona: finalPersona, sock });
    if (isSupabaseEnabled()) {
        saveUserToSupabase(chatId, phoneNumber, status, finalPersona);
    }
}

function clearTelegramUser(chatId) {
    if (chatId === null || typeof chatId === 'undefined') return;
    telegramUsers.set(chatId, { phoneNumber: null, status: 'disconnected', persona: 'eclipse', sock: null });
    if (isSupabaseEnabled()) {
        deleteUserFromSupabase(chatId);
    }
}

function saveUserMap() {
    const map = {};
    for (const [chatId, user] of telegramUsers.entries()) {
        if (user?.phoneNumber) {
            map[String(chatId)] = {
                phoneNumber: user.phoneNumber,
                status: user.status || 'disconnected',
                persona: user.persona || 'eclipse'
            };
        }
    }

    try {
        fs.writeFileSync(USER_MAP_FILE, JSON.stringify(map, null, 2));
        log('STATE', `Saved user map with ${Object.keys(map).length} user(s)`);
    } catch (err) {
        logError('STATE', 'Failed to save user map', err);
    }
}

async function loadUserMap({ clearExisting = false } = {}) {
    if (clearExisting) telegramUsers.clear();

    // Try Supabase first if enabled
    if (isSupabaseEnabled()) {
        const dbMap = await loadAllUsersFromSupabase();
        if (dbMap) {
            for (const [chatIdText, data] of Object.entries(dbMap)) {
                const chatId = Number(chatIdText);
                if (!Number.isFinite(chatId)) continue;
                telegramUsers.set(chatId, {
                    phoneNumber: data?.phoneNumber || null,
                    status: data?.status || 'disconnected',
                    persona: data?.persona || 'eclipse',
                    sock: null
                });
            }
            log('STATE', `Loaded ${telegramUsers.size} user(s) from Supabase.`);
            return;
        }
    }

    // Fallback to local user_map.json file
    if (!fs.existsSync(USER_MAP_FILE)) {
        log('STATE', 'user_map.json not found. Continuing without stored Telegram user map.');
        return;
    }

    try {
        const raw = fs.readFileSync(USER_MAP_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        for (const [chatIdText, data] of Object.entries(parsed)) {
            const chatId = Number(chatIdText);
            if (!Number.isFinite(chatId)) continue;
            telegramUsers.set(chatId, {
                phoneNumber: data?.phoneNumber || null,
                status: data?.status || 'disconnected',
                persona: data?.persona || 'eclipse',
                sock: null
            });
        }
        log('STATE', `Loaded ${telegramUsers.size} user(s) from user_map.json`);
    } catch (err) {
        logError('STATE', 'Failed to load user map', err);
    }
}

function isDev(chatId) {
    if (DEV_IDS.length === 0) return true;
    return DEV_IDS.includes(Number(chatId));
}

// ──────────────────────────────────────────────
// 🔧 BAILEYS HELPERS
// ──────────────────────────────────────────────
function getDisconnectCode(lastDisconnect) {
    return lastDisconnect?.error?.output?.statusCode
        ?? lastDisconnect?.error?.statusCode
        ?? lastDisconnect?.statusCode
        ?? null;
}

// Decrypt / Retrieve messages from memory map OR local persistent JSON
async function getMessageFromStore(key) {
    const inMemory = sentPolls.get(key.id);
    if (inMemory) return inMemory;

    // Fallback: search poll_cache.json files
    const sessionDirs = getStoredSessionDirectories(AUTH_DIR);
    for (const number of sessionDirs) {
        const cache = loadPollCache(number);
        const cached = cache.get(key.id);
        if (cached && cached.fullMessage) {
            return cached.fullMessage;
        }
    }
    return null;
}

function isRecentMessage(msg, maxAgeSeconds = RECENT_APPEND_WINDOW_SECONDS) {
    const ts = asNumber(msg?.messageTimestamp);
    if (!ts) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
    return age <= maxAgeSeconds;
}

function isIgnoredRemoteJid(remoteJid) {
    if (!remoteJid) return true;
    if (remoteJid === 'status@broadcast') return true;
    if (remoteJid.endsWith('@broadcast')) return true;
    if (remoteJid.includes('@newsletter')) return true;
    return false;
}

async function getBaileysVersion() {
    const maxCacheAgeMs = 60 * 60 * 1000;
    const now = Date.now();
    if (cachedBaileysVersion && (now - cachedBaileysVersionAt) < maxCacheAgeMs) {
        return cachedBaileysVersion;
    }

    const { version } = await fetchLatestBaileysVersion();
    cachedBaileysVersion = version;
    cachedBaileysVersionAt = now;
    log('BAILEYS', `Using WA version ${version.join('.')}`);
    return version;
}

function resolveCommandReply(command, phoneNumber) {
    if (command === '.ping') {
        return `🏓 *Pong!*\n\n📱 *Device*: ${phoneNumber}\n⏱️ *Uptime*: ${formatUptime(process.uptime())}\n👥 *Active connections*: ${waSessions.size}`;
    }
    return COMMANDS[command] || null;
}

// Unwraps layered messages (like view-once, ephemeral, edited, etc.)
function unwrapMessageContent(message) {
    let current = message;
    const wrapperChain = [];

    for (let depth = 0; current && depth < 10; depth += 1) {
        if (current.deviceSentMessage?.message) {
            wrapperChain.push('deviceSentMessage');
            current = current.deviceSentMessage.message;
            continue;
        }
        if (current.ephemeralMessage?.message) {
            wrapperChain.push('ephemeralMessage');
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current.viewOnceMessage?.message) {
            wrapperChain.push('viewOnceMessage');
            current = current.viewOnceMessage.message;
            continue;
        }
        if (current.viewOnceMessageV2?.message) {
            wrapperChain.push('viewOnceMessageV2');
            current = current.viewOnceMessageV2.message;
            continue;
        }
        if (current.viewOnceMessageV2Extension?.message) {
            wrapperChain.push('viewOnceMessageV2Extension');
            current = current.viewOnceMessageV2Extension.message;
            continue;
        }
        if (current.documentWithCaptionMessage?.message) {
            wrapperChain.push('documentWithCaptionMessage');
            current = current.documentWithCaptionMessage.message;
            continue;
        }
        if (current.editedMessage?.message) {
            wrapperChain.push('editedMessage');
            current = current.editedMessage.message;
            continue;
        }
        break;
    }

    return { message: current, wrapperChain };
}

function extractMessageText(msg) {
    const topLevelType = msg?.message ? Object.keys(msg.message)[0] : 'none';
    const { message, wrapperChain } = unwrapMessageContent(msg?.message);
    const leafType = message ? (Object.keys(message)[0] || 'unknown') : 'none';

    if (!message) {
        return {
            text: '',
            topLevelType,
            leafType,
            wrapperChain,
            source: 'none'
        };
    }

    const candidates = [
        ['conversation', message.conversation],
        ['extendedTextMessage.text', message.extendedTextMessage?.text],
        ['imageMessage.caption', message.imageMessage?.caption],
        ['videoMessage.caption', message.videoMessage?.caption],
        ['documentMessage.caption', message.documentMessage?.caption],
        ['buttonsResponseMessage.selectedButtonId', message.buttonsResponseMessage?.selectedButtonId],
        ['buttonsResponseMessage.selectedDisplayText', message.buttonsResponseMessage?.selectedDisplayText],
        ['listResponseMessage.title', message.listResponseMessage?.title],
        ['templateButtonReplyMessage.selectedId', message.templateButtonReplyMessage?.selectedId],
        ['templateButtonReplyMessage.selectedDisplayText', message.templateButtonReplyMessage?.selectedDisplayText]
    ];

    for (const [source, value] of candidates) {
        if (typeof value === 'string' && value.trim()) {
            return {
                text: value,
                topLevelType,
                leafType,
                wrapperChain,
                source
            };
        }
    }

    return {
        text: '',
        topLevelType,
        leafType,
        wrapperChain,
        source: 'unhandled'
    };
}

/**
 * Sends a reply with simulated typing ("composing" state) and organic delay.
 * Helps protect against WhatsApp anti-spam automated bot scanners.
 */
async function safeWaReply(sock, remoteJid, text, quoted) {
    try {
        // 1. Send "composing" (typing...) presence update
        try {
            await sock.sendPresenceUpdate('composing', remoteJid);
            // 2. Human-like variable delay: 15ms per character, min 1.5s, max 4s
            const delayMs = Math.min(4000, Math.max(1500, text.length * 15));
            await delay(delayMs);
            // 3. Stop typing presence
            await sock.sendPresenceUpdate('paused', remoteJid);
        } catch (presErr) {
            logError('WA-SEND', 'Failed to send presence update', presErr);
        }

        // 4. Send the actual message
        await sock.sendMessage(remoteJid, { text }, quoted ? { quoted } : undefined);
        return true;
    } catch (err) {
        logError('WA-SEND', `Quoted reply failed for ${remoteJid}. Retrying without quote`, err);
        try {
            await sock.sendMessage(remoteJid, { text });
            return true;
        } catch (retryErr) {
            logError('WA-SEND', `Reply failed for ${remoteJid}`, retryErr);
            return false;
        }
    }
}

// ──────────────────────────────────────────────
// 📱 TELEGRAM BOT
// ──────────────────────────────────────────────
if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_TOKEN not set!');
    process.exit(1);
}

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

tgBot.on('polling_error', err => logError('TELEGRAM', 'Polling error', err));

// ──────────────────────────────────────────────
// 🔒 TELEGRAM SEND HELPER
// ──────────────────────────────────────────────
async function safeTgSend(chatId, text) {
    try {
        await tgBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
        logError('TELEGRAM', `Markdown send failed to ${chatId}, retrying plain text`, err);
        await delay(1000);
        try {
            await tgBot.sendMessage(chatId, text);
        } catch (retryErr) {
            logError('TELEGRAM', `Plain text send failed to ${chatId}`, retryErr);
        }
    }
}

async function requireAdminOrExplain(chatId) {
    if (isDev(chatId)) return true;
    await safeTgSend(chatId, '⛔ Admins only. Add your Telegram ID to DEV_TELEGRAM_IDS to unlock this command.');
    return false;
}

async function stopAllSessions(reason = 'unspecified') {
    log('SESSION', `Stopping all active sockets. Reason: ${reason}`);
    for (const [phoneNumber, session] of waSessions.entries()) {
        try {
            log('SESSION', `Closing socket for ${phoneNumber}`);
            await session?.sock?.end(undefined);
        } catch (err) {
            logError('SESSION', `Failed to close socket for ${phoneNumber}`, err);
        }
    }
    waSessions.clear();
    for (const [chatId, user] of telegramUsers.entries()) {
        telegramUsers.set(chatId, {
            phoneNumber: user?.phoneNumber || null,
            status: user?.phoneNumber ? 'connecting' : 'disconnected',
            sock: null
        });
    }
    saveUserMap();
}

// ──────────────────────────────────────────────
// 🔌 SOCKET / SESSION MANAGEMENT
// ──────────────────────────────────────────────
async function createSocketForSession({ phoneNumber, tgId, authDir, version = null, isRestore = false }) {
    ensureDir(authDir);

    // Download session files from Supabase if integration is active
    if (isSupabaseEnabled()) {
        log('SUPABASE', `${phoneNumber}: Fetching credentials from Supabase before initialization...`);
        const restored = await downloadSessionFromSupabase(phoneNumber, authDir);
        if (restored) {
            log('SUPABASE', `${phoneNumber}: Credentials loaded from Supabase successfully.`);
        } else {
            log('SUPABASE', `${phoneNumber}: No credentials found on Supabase or failed to restore.`);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const resolvedVersion = version || await getBaileysVersion();

    const existingUser = tgId !== null && typeof tgId !== 'undefined'
        ? telegramUsers.get(tgId)
        : null;
    const nextStatus = !state?.creds?.registered && !isRestore
        ? 'pairing'
        : (existingUser?.status === 'pairing' && !isRestore ? 'pairing' : 'connecting');

    log('SOCKET', `${phoneNumber}: creating socket (registered=${!!state?.creds?.registered}, restore=${isRestore}, tgId=${tgId ?? 'none'})`);

    const sock = makeWASocket({
        version: resolvedVersion,
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: getMessageFromStore // Pass custom getMessage handler for poll decryption
    });

    // Wrap saveCreds to trigger Supabase sync ONLY if authorized/connected for 10s
    const originalSaveCreds = saveCreds;
    const wrappedSaveCreds = async () => {
        await originalSaveCreds();
        if (isSupabaseEnabled()) {
            const session = waSessions.get(phoneNumber);
            if (session && session.allowSupabaseSync) {
                debouncedSyncLocalToSupabase(phoneNumber, authDir);
            }
        }
    };
    sock.ev.on('creds.update', wrappedSaveCreds);

    // Wrap state.keys.set to trigger Supabase sync ONLY if authorized/connected for 10s
    if (isSupabaseEnabled()) {
        const originalKeysSet = state.keys.set;
        state.keys.set = async (data) => {
            await originalKeysSet(data);
            const session = waSessions.get(phoneNumber);
            if (session && session.allowSupabaseSync) {
                debouncedSyncLocalToSupabase(phoneNumber, authDir);
            }
        };
    }

    // Set initial session state with allowSupabaseSync: false (won't backup until 10s after connection opens)
    waSessions.set(phoneNumber, {
        telegramChatId: tgId ?? null,
        sock,
        authDir,
        allowSupabaseSync: false
    });

    if (tgId !== null && typeof tgId !== 'undefined') {
        setTelegramUserState(tgId, {
            phoneNumber,
            status: nextStatus,
            sock
        });
        saveUserMap();
    }

    setupSocketEvents(sock, phoneNumber, tgId ?? null, authDir, resolvedVersion, isRestore);
    setupMessageHandler(sock, phoneNumber, tgId ?? null);

    return { sock, state, version: resolvedVersion };
}

async function cleanupDisconnectedSession({ phoneNumber, tgId, authDir, notifyText = null, removeAuthDir = false, reason = 'unspecified' }) {
    log('SESSION', `${phoneNumber}: cleaning up session. Reason: ${reason}`);
    waSessions.delete(phoneNumber);

    if (removeAuthDir) {
        safeRm(authDir);
        if (isSupabaseEnabled()) {
            await deleteSessionFromSupabase(phoneNumber);
        }
    }

    if (tgId !== null && typeof tgId !== 'undefined') {
        clearTelegramUser(tgId);
        saveUserMap();
        if (notifyText) await safeTgSend(tgId, notifyText);
    }
}

async function restartSocketAfterClose({ closingSock, phoneNumber, tgId, authDir, version, isRestore, reason, delayMs = 5000 }) {
    const liveSession = waSessions.get(phoneNumber);
    if (liveSession?.sock && liveSession.sock !== closingSock) {
        log('SOCKET', `${phoneNumber}: stale socket close ignored. Reason: ${reason}`);
        return;
    }

    waSessions.delete(phoneNumber);

    // Track reconnect retries (Max 3)
    const attempts = (reconnectAttempts.get(phoneNumber) || 0) + 1;
    reconnectAttempts.set(phoneNumber, attempts);

    log('SOCKET', `${phoneNumber}: Connection closed (Attempt ${attempts}/3). Reason: ${reason}`);

    if (attempts > 3) {
        log('SOCKET', `${phoneNumber}: Max reconnect attempts (3) exceeded. Cleaning up session.`);
        reconnectAttempts.delete(phoneNumber);
        
        await cleanupDisconnectedSession({
            phoneNumber,
            tgId,
            authDir,
            removeAuthDir: true,
            reason: 'Max reconnect attempts exceeded (3)',
            notifyText: `⚠️ *Connection Lost Permanently!*\n\n📱 ${phoneNumber}\nWe failed to reconnect after 3 attempts. This login session has been flagged as stale and deleted from Supabase.\n\nPlease link your WhatsApp again using /pair.`
        });
        return;
    }

    if (tgId !== null && typeof tgId !== 'undefined') {
        setTelegramUserState(tgId, { phoneNumber, status: 'connecting', sock: null });
        saveUserMap();
    }

    log('SOCKET', `${phoneNumber}: rebuilding socket in ${delayMs}ms. Reason: ${reason}`);
    await delay(delayMs);

    try {
        await createSocketForSession({ phoneNumber, tgId, authDir, version, isRestore });
        log('SOCKET', `${phoneNumber}: socket rebuilt successfully after close.`);
    } catch (err) {
        logError('SOCKET', `${phoneNumber}: failed to rebuild socket`, err);
    }
}

function setupSocketEvents(sock, phoneNumber, tgId, authDir, version, isRestore) {
    let pairingCodeSentForThisSocket = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update || {};
        const code = getDisconnectCode(lastDisconnect);
        const registered = !!sock?.authState?.creds?.registered;

        log('CONNECTION', `${phoneNumber}: connection.update connection=${connection || 'unknown'} code=${code ?? 'none'} registered=${registered} restore=${isRestore}`);

        if (connection === 'connecting' && !isRestore && !registered && !pairingCodeSentForThisSocket) {
            pairingCodeSentForThisSocket = true;
            try {
                if (tgId !== null && typeof tgId !== 'undefined') {
                    setTelegramUserState(tgId, { phoneNumber, status: 'pairing', sock });
                    saveUserMap();
                }

                await delay(2000);
                log('PAIR', `${phoneNumber}: requesting pairing code now...`);
                const pairingCode = await sock.requestPairingCode(phoneNumber);
                log('PAIR', `${phoneNumber}: pairing code generated successfully: ${pairingCode}`);

                if (tgId !== null && typeof tgId !== 'undefined') {
                    await safeTgSend(
                        tgId,
                        `🔓 *PAIRING CODE*\n\nCode: ${pairingCode}\n\n📋 *Steps:*\n1. WhatsApp → Settings → Linked Devices\n2. Tap "Link a Device"\n3. Tap "Link with phone number"\n4. Enter this code: ${pairingCode}\n\n⚠️ This code expires quickly, so use it now.`
                    );
                }
            } catch (err) {
                pairingCodeSentForThisSocket = false;
                logError('PAIR', `${phoneNumber}: failed to request pairing code`, err);
                if (tgId !== null && typeof tgId !== 'undefined') {
                    await safeTgSend(tgId, `❌ Failed to generate pairing code.\n\n${err.message}\n\nUse /pair to retry.`);
                }
            }
            return;
        }

        if (connection === 'open') {
            log('CONNECTION', `${phoneNumber}: connection opened successfully.`);

            // Reset reconnection counter on successful open
            reconnectAttempts.set(phoneNumber, 0);

            // Initialize the session in map, keep allowSupabaseSync as false
            const sessionObj = {
                telegramChatId: tgId ?? null,
                sock,
                authDir,
                allowSupabaseSync: false
            };
            waSessions.set(phoneNumber, sessionObj);

            if (tgId !== null && typeof tgId !== 'undefined') {
                setTelegramUserState(tgId, { phoneNumber, status: 'connected', sock });
                saveUserMap();
                await safeTgSend(
                    tgId,
                    `✅✅✅ *Connected!* ✅✅✅\n\n📱 ${phoneNumber}\n🤖 Bot active now.\n\nType .menu in WhatsApp.`
                );
            }

            // ⏱️ Delay initial Supabase sync until exactly 10 seconds after confirmed successful connection
            setTimeout(async () => {
                const currentSession = waSessions.get(phoneNumber);
                if (currentSession) {
                    currentSession.allowSupabaseSync = true;
                    if (isSupabaseEnabled()) {
                        log('SUPABASE', `${phoneNumber}: Connection has been open and verified for 10 seconds. Performing first complete cloud sync...`);
                        debouncedSyncLocalToSupabase(phoneNumber, authDir, 100); // Trigger sync immediately
                    }
                }
            }, 10000);

            // Send Persona Selection Poll DM on successful connection
            setTimeout(async () => {
                try {
                    const myJid = sock?.authState?.creds?.me?.id;
                    if (!myJid) return;
                    const selfJid = `${myJid.split(':')[0]}@s.whatsapp.net`;

                    log('PAIR', `${phoneNumber}: Sending Persona Selection Poll to self...`);
                    
                    const pollTitle = `╔══════════════════╗\n     SELECT YOUR PERSONA\n╚══════════════════╝\n\nChoose which persona you want to activate for your Eventide Omega bot:`;
                    const pollOptions = [
                        '╰┈➤ [ 1. ECLIPSE ]',
                        '╰┈➤ [ 2. ASTRAEA ]',
                        '╰┈➤ [ 3. VIM ]'
                    ];
                    const pollIds = ['eclipse', 'astraea', 'vim'];

                    const secret = crypto.randomBytes(32);

                    const pollMsg = await sock.sendMessage(selfJid, {
                        poll: {
                            name: pollTitle,
                            values: pollOptions,
                            selectableCount: 1,
                            messageSecret: secret
                        }
                    });

                    // CRITICAL: read the secret back from the actual sent message as per original Baileys specs!
                    const actualSecret =
                        pollMsg?.message?.messageContextInfo?.messageSecret ||
                        pollMsg?.messageContextInfo?.messageSecret ||
                        secret;

                    // Save to our clean isolated poll cache
                    const cache = loadPollCache(phoneNumber);
                    cache.set(pollMsg.key.id, {
                        secretHex: actualSecret.toString('hex'),
                        options: pollOptions,
                        ids: pollIds,
                        fullMessage: pollMsg.message || null
                    });
                    savePollCache(phoneNumber, cache);

                    log('PAIR', `${phoneNumber}: Saved poll message ${pollMsg.key.id} for decryption.`);
                } catch (err) {
                    logError('PAIR', `${phoneNumber}: failed to send Persona Selection Poll`, err);
                }
            }, 5000);
            return;
        }

        if (connection === 'close') {
            log('CONNECTION', `${phoneNumber}: connection closed. Status code=${code ?? 'unknown'}`);

            if (code === 500) {
                await cleanupDisconnectedSession({
                    phoneNumber,
                    tgId,
                    authDir,
                    removeAuthDir: true,
                    reason: 'bad session (500)',
                    notifyText: `⚠️ *Session Error!*\n\n📱 ${phoneNumber}\nThis session became invalid and has been deleted. Use /pair again.`
                });
                return;
            }

            if (code === DisconnectReason.loggedOut) {
                await cleanupDisconnectedSession({
                    phoneNumber,
                    tgId,
                    authDir,
                    removeAuthDir: true,
                    reason: 'logged out',
                    notifyText: `📱 *Logged Out!*\n\n📱 ${phoneNumber}\nThis session was logged out from WhatsApp. Credentials have been removed from Supabase. Use /pair to reconnect.`
                });
                return;
            }

            if (code === 515) {
                await restartSocketAfterClose({
                    closingSock: sock,
                    phoneNumber,
                    tgId,
                    authDir,
                    version,
                    isRestore,
                    reason: 'Baileys requested new socket (515)',
                    delayMs: 3000
                });
                return;
            }

            await restartSocketAfterClose({
                closingSock: sock,
                phoneNumber,
                tgId,
                authDir,
                version,
                isRestore,
                reason: `connection closed (${code ?? 'unknown'})`,
                delayMs: 5000
            });
        }
    });
}

// ──────────────────────────────────────────────
// 🔐 THE ULTIMATE BRUTE-FORCE DECRYPTION ENGINE (AS PER SPECIFICATION)
// ──────────────────────────────────────────────
function handlePollVote(sock, phoneNumber, key, pollUpdates) {
    const cache = loadPollCache(phoneNumber);
    const cached = cache.get(key.id);
    if (!cached) return null;

    // 1. Gather all possible normalized Creator candidate JIDs
    const mePN  = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
    const rawLID = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
    const meLID = rawLID ? jidNormalizedUser(rawLID) : '';

    const creators = [...new Set([meLID, mePN].filter(Boolean))];
    const keyJid = jidNormalizedUser(key.participant || key.remoteJid || '');
    if (keyJid) creators.push(keyJid);

    // 2. Gather all possible normalized Voter candidate JIDs
    const voters = [];
    if (key.fromMe) { 
        voters.push(mePN, meLID); 
    } else if (key.participant) {
        voters.push(jidNormalizedUser(key.participant));
    } else {
        voters.push(jidNormalizedUser(key.remoteJid));
    }
    const uniqVoters = [...new Set(voters.filter(Boolean))];

    const secretBuf = Buffer.from(cached.secretHex, 'hex');
    
    // 3. Brute force decryption combinations
    for (const update of pollUpdates) {
        if (!update?.vote) continue;
        for (const creator of creators) {
            for (const voter of uniqVoters) {
                try {
                    const d = decryptPollVote(update.vote, {
                        pollEncKey: secretBuf, 
                        pollCreatorJid: creator,
                        pollMsgId: key.id, 
                        voterJid: voter,
                    });
                    if (d?.selectedOptions?.length) {
                        const hash = Buffer.from(d.selectedOptions[0]).toString('hex');
                        const idx = cached.options.findIndex(
                            (o) => crypto.createHash('sha256').update(Buffer.from(o)).digest('hex') === hash
                        );
                        if (idx >= 0) return cached.ids[idx]; // Returns chosen option ID
                    }
                } catch (_) { /* wrong combo, try next */ }
            }
        }
    }
    return null;
}

/**
 * Handles decrypted poll votes cast by users on our poll messages.
 */
async function handlePersonaSelectionVote(sock, remoteJid, optionId, pollKey) {
    // Only accept eclipse for now. Astraea and Vim do not exist yet (thinking phase)
    if (optionId !== 'eclipse') {
        log('PERSONA', `Voted option '${optionId}' is under development (thinking phase). Ignoring and sending no confirmation msg.`);
        
        // Delete the selection poll message with a delay of 1.5 seconds anyway to keep screen clean
        setTimeout(async () => {
            try {
                await sock.sendMessage(remoteJid, { delete: pollKey });
            } catch (err) {
                logError('POLL', 'Failed to delete poll message', err);
            }
        }, 1500);
        return;
    }

    const phoneNumber = remoteJid.split('@')[0];
    const tgId = findTelegramChatIdByPhone(phoneNumber);
    
    log('PERSONA', `${phoneNumber}: Selected persona: ECLIPSE`);

    // Save selected persona in our state
    if (tgId !== null && typeof tgId !== 'undefined') {
        setTelegramUserState(tgId, {
            phoneNumber,
            status: 'connected',
            persona: 'eclipse',
            sock
        });
        saveUserMap();
    }

    // Delete the poll message with a delay of 1.5 seconds
    setTimeout(async () => {
        try {
            log('POLL', `${phoneNumber}: Deleting poll message ${pollKey.id}`);
            await sock.sendMessage(remoteJid, { delete: pollKey });
        } catch (err) {
            logError('POLL', 'Failed to delete poll message', err);
        }
    }, 1500);

    // Send custom connected message for Eclipse
    setTimeout(async () => {
        try {
            await sock.sendMessage(remoteJid, { 
                text: `✅ *EVENTIDE OMEGA CONNECTED!*\n\nType *.menu* to launch the terminal.` 
            });
        } catch (err) {
            logError('PERSONA', 'Failed to send connection confirmation', err);
        }
    }, 2500);
}

async function handleWhatsAppMessage(sock, msg, phoneNumber, tgId, eventType) {
    const remoteJid = msg?.key?.remoteJid || 'unknown';
    const msgId = msg?.key?.id || 'unknown';
    const participant = msg?.key?.participant || 'none';
    const fromMe = !!msg?.key?.fromMe;
    const pushName = msg?.pushName || 'unknown';
    const recent = isRecentMessage(msg);

    log(
        'WA-MSG',
        `${phoneNumber}: incoming event message seen | eventType=${eventType} id=${msgId} jid=${remoteJid} participant=${participant} fromMe=${fromMe} pushName=${trimForLog(pushName, 60)} recent=${recent}`
    );

    if (isIgnoredRemoteJid(remoteJid)) {
        log('WA-MSG', `${phoneNumber}: skipping ignored jid ${remoteJid}`);
        return;
    }

    if (!msg?.message) {
        log('WA-MSG', `${phoneNumber}: message ${msgId} has no message payload. Skipping.`);
        return;
    }

    const shouldProcessEvent = eventType === 'notify' || (eventType === 'append' && recent);
    if (!shouldProcessEvent) {
        log('WA-MSG', `${phoneNumber}: skipping eventType=${eventType} for message ${msgId} because it is not processable.`);
        return;
    }

    const parsed = extractMessageText(msg);
    log(
        'WA-PARSE',
        `${phoneNumber}: parse result | topLevel=${parsed.topLevelType} wrappers=${parsed.wrapperChain.join(' > ') || 'none'} leaf=${parsed.leafType} source=${parsed.source} text=${JSON.stringify(trimForLog(parsed.text, 250))}`
    );

    const text = parsed.text.trim();
    if (!text) {
        log('WA-PARSE', `${phoneNumber}: no command text extracted from message ${msgId}.`);
        return;
    }

    const normalized = text.trim();
    const token = normalized.split(/\s+/)[0].toLowerCase();
    const startsWithDot = normalized.startsWith('.');

    log(
        'WA-CMD',
        `${phoneNumber}: command flow | raw=${JSON.stringify(trimForLog(text, 250))} normalized=${JSON.stringify(trimForLog(normalized, 250))} token=${JSON.stringify(token)} startsWithDot=${startsWithDot}`
    );

    if (!startsWithDot) {
        log('WA-CMD', `${phoneNumber}: message ${msgId} is not a dot command. Ignoring.`);
        return;
    }

    // ──────────────────────────────────────────────
    // 🌌 SPECIAL MULTI-STAGE GRANULAR LOADING MENU COMMAND
    // ──────────────────────────────────────────────
    if (token === '.menu') {
        log('WA-CMD', `${phoneNumber}: Granular menu loading animation triggered.`);
        try {
            // Find active persona for this user (default is 'eclipse')
            const tgId = findTelegramChatIdByPhone(phoneNumber);
            const userState = tgId !== null ? telegramUsers.get(tgId) : null;
            const activePersonaName = userState?.persona || 'eclipse';

            log('WA-CMD', `${phoneNumber}: Active persona in menu command: ${activePersonaName.toUpperCase()}`);

            // If selected persona is under development (Vim or Astraea), reply "under production"
            if (activePersonaName === 'astraea' || activePersonaName === 'vim') {
                log('WA-CMD', `${phoneNumber}: Persona ${activePersonaName.toUpperCase()} is under production. Replying.`);
                await safeWaReply(
                    sock, 
                    remoteJid, 
                    `⚠️ *This command is under production.*\n\nPersona *${activePersonaName.toUpperCase()}* is currently in development and thinking phase. Stay tuned!`, 
                    msg
                );
                return;
            }

            const personaConfig = PERSONAS.eclipse; // Load Eclipse config

            // Send initial Step 1 (08%)
            const firstFrame = generateLoadingFrame(personaConfig.stages.stage1[0]);
            const sentMsg = await sock.sendMessage(remoteJid, { text: firstFrame });
            const messageKey = sentMsg.key;

            // Step through frames 2 to 12 with a smooth 600ms transition
            for (let i = 1; i < personaConfig.stages.stage1.length; i++) {
                await delay(600);
                const nextFrame = generateLoadingFrame(personaConfig.stages.stage1[i]);
                await sock.sendMessage(remoteJid, { text: nextFrame, edit: messageKey });
            }

            // Stage 2 (The Persona-specific Art/Message)
            await delay(1500);
            await sock.sendMessage(remoteJid, { text: personaConfig.stages.stage2Text, edit: messageKey });

            // Stage 3 (Stay on screen for 3 seconds, then edit to final terminal)
            await delay(3000);
            await sock.sendMessage(remoteJid, { text: personaConfig.stages.stage3Text, edit: messageKey });

            // Send a beautiful native Poll Message containing the premium buttons look
            await delay(1500);
            
            const secret = crypto.randomBytes(32);
            const pollMsg = await sock.sendMessage(remoteJid, {
                poll: {
                    name: POLL_QUESTION,
                    values: POLL_OPTIONS,
                    selectableCount: 1,
                    messageSecret: secret
                }
            });

            // Save poll creation in memory & phone cache for decryption
            const actualSecret =
                pollMsg?.message?.messageContextInfo?.messageSecret ||
                pollMsg?.messageContextInfo?.messageSecret ||
                secret;

            const cache = loadPollCache(phoneNumber);
            cache.set(pollMsg.key.id, {
                secretHex: actualSecret.toString('hex'),
                options: POLL_OPTIONS,
                ids: ['owners', 'group', 'system', 'fun'],
                fullMessage: pollMsg.message || null
            });
            savePollCache(phoneNumber, cache);

            log('WA-CMD', `${phoneNumber}: Menu animation & poll delivery completed successfully.`);
        } catch (err) {
            logError('WA-CMD', `${phoneNumber}: Failed executing granular Menu animation/poll`, err);
        }
        return;
    }

    const replyText = resolveCommandReply(token, phoneNumber);
    if (!replyText) {
        log('WA-CMD', `${phoneNumber}: no reply mapped for command ${token}. Ignoring.`);
        return;
    }

    log('WA-CMD', `${phoneNumber}: matched command ${token}. Sending simulated typing reply...`);
    const sent = await safeWaReply(sock, remoteJid, replyText, msg);
    if (sent) {
        log('WA-CMD', `${phoneNumber}: reply sent successfully for ${token} to ${remoteJid}`);
    } else {
        log('WA-CMD', `${phoneNumber}: failed to send reply for ${token} to ${remoteJid}`);
    }
}

// Attach event listeners
function setupMessageHandler(sock, phoneNumber, tgId) {
    log('WA-HANDLER', `${phoneNumber}: attaching message handlers (tgId=${tgId ?? 'none'})`);

    sock.ev.on('messages.upsert', async (event) => {
        const type = event?.type || 'unknown';
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        log('WA-EVENT', `${phoneNumber}: messages.upsert received | type=${type} count=${messages.length}`);

        for (const msg of messages) {
            try {
                await handleWhatsAppMessage(sock, msg, phoneNumber, tgId, type);
            } catch (err) {
                logError('WA-HANDLER', `${phoneNumber}: error while handling message`, err);
            }
        }
    });

    // ──────────────────────────────────────────────
    // 🗳️ REAL-TIME POLL VOTE INTERCEPTOR
    // ──────────────────────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
        const count = Array.isArray(updates) ? updates.length : 0;
        log('WA-EVENT', `${phoneNumber}: messages.update received | count=${count}`);

        for (const { key, update } of updates) {
            if (update.pollUpdates) {
                log('POLL', `${phoneNumber}: Poll vote update received for message ${key.id}`);
                
                // Call our brute-force decryption block
                const votedOptionId = handlePollVote(sock, phoneNumber, key, update.pollUpdates);
                if (votedOptionId) {
                    log('POLL', `${phoneNumber}: Decrypted vote on option ID: ${votedOptionId}`);
                    
                    // Run our persona-specific action
                    await handlePersonaSelectionVote(sock, key.remoteJid, votedOptionId, key);
                }
            }
        }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
        log(
            'WA-EVENT',
            `${phoneNumber}: messaging-history.set received | chats=${chats?.length || 0} contacts=${contacts?.length || 0} messages=${messages?.length || 0} isLatest=${!!isLatest}`
        );
    });
}

async function initiatePairing(tgId, phoneNumber) {
    log('PAIR', `Starting pairing flow for ${phoneNumber} (Telegram ${tgId})`);

    const sessionCount = countStoredSessions();
    if (sessionCount >= MAX_USERS) {
        await safeTgSend(tgId, `🚫 *Server Full!*\n\nMax users reached: ${MAX_USERS}`);
        clearTelegramUser(tgId);
        saveUserMap();
        return;
    }

    for (const [chatId, user] of telegramUsers.entries()) {
        if (chatId !== tgId && user?.phoneNumber === phoneNumber && user?.status !== 'disconnected') {
            await safeTgSend(tgId, '❌ That number is already in use on this server.');
            clearTelegramUser(tgId);
            saveUserMap();
            return;
        }
    }

    const authDir = path.join(AUTH_DIR, phoneNumber);
    ensureDir(authDir);
    setTelegramUserState(tgId, { phoneNumber, status: 'pairing', sock: null });
    saveUserMap();

    try {
        await createSocketForSession({ phoneNumber, tgId, authDir, isRestore: false });
        log('PAIR', `${phoneNumber}: pairing socket created successfully.`);
    } catch (err) {
        logError('PAIR', `${phoneNumber}: initiatePairing failed`, err);
        clearTelegramUser(tgId);
        saveUserMap();
        throw err;
    }
}

async function restoreAllSessions() {
    normalizeAuthDirStructure();
    ensureDir(AUTH_DIR);

    let sessionDirs = getStoredSessionDirectories(AUTH_DIR);

    // Sync database-stored sessions if Supabase is active
    if (isSupabaseEnabled()) {
        log('RESTORE', 'Fetching session list from Supabase for startup recovery...');
        const dbPhoneNumbers = await getAllSessionPhoneNumbers();
        const combined = new Set([...sessionDirs, ...dbPhoneNumbers]);
        sessionDirs = Array.from(combined);
    }

    if (!sessionDirs.length) {
        log('RESTORE', 'No local or database session folders found to reconnect.');
        return 0;
    }

    let restoredCount = 0;
    for (const phoneNumber of sessionDirs) {
        const authDir = path.join(AUTH_DIR, phoneNumber);
        try {
            // Pre-download from Supabase if active
            if (isSupabaseEnabled()) {
                await downloadSessionFromSupabase(phoneNumber, authDir);
            }

            const { state } = await useMultiFileAuthState(authDir);
            if (!state?.creds?.registered) {
                log('RESTORE', `${phoneNumber}: credentials are not registered. Skipping this folder.`);
                continue;
            }

            const tgId = findTelegramChatIdByPhone(phoneNumber);
            await createSocketForSession({ phoneNumber, tgId, authDir, isRestore: true });
            restoredCount += 1;
            log('RESTORE', `${phoneNumber}: socket recreation queued successfully${tgId ? ` (TG ${tgId})` : ''}.`);
        } catch (err) {
            logError('RESTORE', `${phoneNumber}: failed to restore session`, err);
        }
    }

    return restoredCount;
}

// ──────────────────────────────────────────────
// 📱 TELEGRAM COMMANDS
// ──────────────────────────────────────────────

tgBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    log('TELEGRAM', `/start from ${chatId}`);

    const existing = telegramUsers.get(chatId);
    if (existing?.status === 'connected') {
        await safeTgSend(chatId, `✅ *Connected!*\n\n📱 ${existing.phoneNumber}\n🤖 Bot is active.`);
        return;
    }

    await safeTgSend(
        chatId,
        `🤖 *WhatsApp Multi-Bot*\n\nSend your number to pair using country code without + sign.\nExample: 2348012345678\n\n/pair — Start pairing\n/status — Show status\n/disconnect — Disconnect your session\n/help — Commands`
    );
});

tgBot.onText(/\/pair/, async (msg) => {
    const chatId = msg.chat.id;
    log('TELEGRAM', `/pair from ${chatId}`);

    const existing = telegramUsers.get(chatId);
    if (existing?.status === 'connected') {
        await safeTgSend(chatId, '❌ You are already connected. Use /disconnect first if you want to re-pair.');
        return;
    }

    if (existing?.status === 'pairing' || existing?.status === 'waiting_number') {
        await safeTgSend(chatId, '⏳ Pairing is already in progress. Please send your number now.');
        return;
    }

    setTelegramUserState(chatId, { phoneNumber: null, status: 'waiting_number', sock: null });
    saveUserMap();
    await safeTgSend(chatId, '📱 *Enter your number*\n\nUse country code + number and do not include the + sign.\nExample: 2348012345678');
});

tgBot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const chatType = msg.chat.type;
        const text = msg.text?.trim();

        if (chatType !== 'private') return;
        if (!text) return;
        if (text.startsWith('/')) return;

        log('TELEGRAM', `Text message from ${chatId}: ${trimForLog(text, 120)}`);

        const user = telegramUsers.get(chatId);
        if (!user) {
            await safeTgSend(chatId, '🤖 Use /start to begin first.');
            return;
        }

        if (user.status !== 'waiting_number') return;

        const phoneNumber = text.replace(/\D/g, '');
        if (phoneNumber.length < 10 || phoneNumber.length > 15) {
            await safeTgSend(chatId, '❌ Invalid number. Example: 2348012345678');
            return;
        }

        await safeTgSend(chatId, `🔑 *Connecting...*\n\n📱 ${phoneNumber}\n\n⏳ Generating your pairing code...`);

        try {
            await initiatePairing(chatId, phoneNumber);
        } catch (err) {
            await safeTgSend(chatId, `❌ Pairing failed.\n\n${err.message}\n\nUse /pair to retry.`);
        }
    } catch (err) {
        logError('TELEGRAM', 'Error inside message handler', err);
    }
});

tgBot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    log('TELEGRAM', `/status from ${chatId}`);

    if (!(await requireAdminOrExplain(chatId))) return;

    const user = telegramUsers.get(chatId);
    const statusMap = {
        waiting_number: '⏳ Waiting for number',
        pairing: '🔑 Pairing in progress',
        connecting: '🔄 Connecting',
        connected: '✅ Connected',
        disconnected: '❌ Disconnected'
    };

    const sessionDirs = countStoredSessions();
    await safeTgSend(
        chatId,
        `📊 *Status*\n\nYour state: ${statusMap[user?.status || 'disconnected'] || '❓ Unknown'}\nYour number: ${user?.phoneNumber || 'None'}\n\n👥 Active sockets: ${waSessions.size}\n📁 Stored sessions: ${sessionDirs}/${MAX_USERS}\n🧠 Loaded Telegram users: ${telegramUsers.size}\n⏱️ Uptime: ${formatUptime(process.uptime())}\n☁️ Supabase Sync: ${isSupabaseEnabled() ? '✅ Enabled' : '❌ Disabled'}`
    );
});

tgBot.onText(/\/disconnect/, async (msg) => {
    const chatId = msg.chat.id;
    log('TELEGRAM', `/disconnect from ${chatId}`);

    const user = telegramUsers.get(chatId);
    if (!user?.phoneNumber) {
        await safeTgSend(chatId, '❌ You do not have an active session to disconnect.');
        return;
    }

    const phoneNumber = user.phoneNumber;
    const session = waSessions.get(phoneNumber);
    if (session?.sock) {
        try {
            await session.sock.end(undefined);
        } catch (err) {
            logError('SESSION', `Manual disconnect failed to close socket for ${phoneNumber}`, err);
        }
    }

    waSessions.delete(phoneNumber);
    safeRm(path.join(AUTH_DIR, phoneNumber));
    if (isSupabaseEnabled()) {
        await deleteSessionFromSupabase(phoneNumber);
    }
    clearTelegramUser(chatId);
    saveUserMap();

    await safeTgSend(chatId, `✅ Disconnected ${phoneNumber} successfully.`);
});

tgBot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    log('TELEGRAM', `/help from ${chatId}`);

    await safeTgSend(
        chatId,
        `📖 *Commands*\n\n/start — Welcome message\n/pair — Connect your WhatsApp\n/status — Show status\n/disconnect — Disconnect your session\n/help — Show commands\n\n*WhatsApp commands:*\n.ping`
    );
});

// ──────────────────────────────────────────────
// 🌐 EXPRESS
// ──────────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        activeSockets: waSessions.size,
        storedSessions: countStoredSessions(),
        loadedTelegramUsers: telegramUsers.size,
        maxUsers: MAX_USERS,
        uptime: process.uptime(),
        supabaseSync: isSupabaseEnabled() ? 'enabled' : 'disabled'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
        activeSockets: waSessions.size,
        storedSessions: countStoredSessions(),
        supabaseSync: isSupabaseEnabled() ? 'enabled' : 'disabled'
    });
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

// ──────────────────────────────────────────────
// 🚀 MAIN
// ──────────────────────────────────────────────
async function main() {
    ensureDir(AUTH_DIR);
    normalizeAuthDirStructure();
    await loadUserMap({ clearExisting: true });

    log('BOOT', '🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷');
    log('BOOT', '🤖 WHATSAPP MULTI-BOT');
    log('BOOT', '📦 Baileys v7.0.0-rc13');
    log('BOOT', '📱 Telegram Pairing + Supabase Database Sync');
    log('BOOT', '🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷🔷');

    if (DEV_IDS.length === 0) {
        log('BOOT', '⚠️ DEV_TELEGRAM_IDS is empty. Admin commands are open to any Telegram private chat user.');
    } else {
        log('BOOT', `🔒 Dev Telegram IDs: ${DEV_IDS.join(', ')}`);
    }

    if (isSupabaseEnabled()) {
        log('BOOT', '☁️ Supabase Cloud Sync integration is ENABLED.');
    } else {
        log('BOOT', '⚠️ Supabase integration is DISABLED. Local storage will act as primary.');
    }

    const restoredCount = await restoreAllSessions();
    log('BOOT', `🔁 Session reconnection startup pass finished. Sessions queued: ${restoredCount}`);

    app.listen(PORT, () => {
        log('HTTP', `Server listening on port ${PORT}`);
        log('HTTP', `GET / -> status summary`);
        log('HTTP', `GET /health -> health info`);
        log('HTTP', `GET /ping -> pong`);
        log('BOT', `Telegram bot polling is active.`);
        log('BOT', `Max users: ${MAX_USERS}`);
    });
}

process.on('unhandledRejection', err => logError('PROCESS', 'Unhandled promise rejection', err));
process.on('uncaughtException', err => logError('PROCESS', 'Uncaught exception', err));
process.on('SIGTERM', () => {
    log('PROCESS', 'Received SIGTERM. Shutting down...');
    process.exit(0);
});
process.on('SIGINT', () => {
    log('PROCESS', 'Received SIGINT. Shutting down...');
    process.exit(0);
});

main().catch(err => {
    logError('BOOT', 'Fatal startup error', err);
    process.exit(1);
});

const renderUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => {
    try {
        await fetch(`${renderUrl}/ping`);
    } catch (err) {
        logError('KEEPALIVE', `Failed keep-alive ping to ${renderUrl}/ping`, err);
    }
}, KEEP_ALIVE_INTERVAL);
