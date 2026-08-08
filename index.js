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
import https from 'https';

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
// 🔮 HEADERS & STAGES (PERFECT WHATSAPP SPACING)
// ──────────────────────────────────────────────

const TERMINAL_HEADER = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚═════════╩══════════╝\n\n`;

const animSteps = [
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
];

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

const STAGE2_TEXT = `.
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

const STAGE3_TEXT = `╔═════════╦══════════╗
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

// The animated loading message edits into this once it points down to the
// banner image (the full STAGE3_TEXT is then sent as the image caption).
const STAGE3_ARROWS_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚═════════╩══════════╝

                ═══ E C L I P S E ═══

                 ▾
                ▾ ▾
               ▾ ▾ ▾
         gaze below, keeper...
               ▾ ▾ ▾
                ▾ ▾
                 ▾

📡 SECURE │ Ω │ VESSEL: ∞`;

// Absolute paths to the menu banner images (live in ./assets next to the script).
const MENU_BANNER_PATH      = path.join(__dirname, 'assets', 'eventide_banner.png');
const OWNERS_MENU_PATH      = path.join(__dirname, 'assets', 'owners_menu.png');
const GROUP_MENU_PATH       = path.join(__dirname, 'assets', 'group_menu.png');
const FUN_MENU_PATH         = path.join(__dirname, 'assets', 'fun_menu.png');
const SYSTEM_MENU_PATH      = path.join(__dirname, 'assets', 'system_menu.png');
const CONFIG_MENU_PATH      = path.join(__dirname, 'assets', 'config_menu.png');

// ──────────────────────────────────────────────
// 📊 POLL DETAILS
// ──────────────────────────────────────────────
const POLL_QUESTION = `╔═════════╦══════════╗\n        ⚠ EVENTIDE OMEGA ⚠\n╚═════════╩══════════╝`;
const POLL_OPTIONS = [
    '╰|1...2➤ [ 1. OWNERS MENU ]',
    '╰|1...2➤ [ 2. GROUP MENU ]',
    '╰|1...2➤ [ 3. FUN MENU ]',
    '╰|1...2➤ [ 4. BUG MENU ]'
];
const MENU_POLL_IDS = ['owners', 'group', 'fun', 'bug'];

// ──────────────────────────────────────────────
// 🗂️ SUB-MENU / DOMAIN POLLS
// ──────────────────────────────────────────────
const DOMAIN_POLL_QUESTION = `╔═════════╦══════════╗\n     CHOOSE YOUR DOMAIN ⚠\n╚═════════╩══════════╝`;
const DOMAIN_POLL_OPTIONS = [
    '╰|1...2➤ [ 1. SYSTEM MENU ]',
    '╰|1...2➤ [ 2. CONFIG MENU ]'
];
const DOMAIN_POLL_IDS = ['system', 'config'];

const OWNERS_WELCOME_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚═════════╩══════════╝

" you built this night —
  you rule its stars. "

*WELCOME, BOSS. 👑*

This is the Owners Menu — yours alone.

• *System Menu* — see how the bot is running
  (uptime, ping, profile pics & more)
• *Config Menu* — change bot settings to your
  taste (.mode, .setalias & more)

Pick a domain below to begin.

> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_`;

const GROUP_MENU_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               GROUP DOMAIN
╚═════════╩══════════╝

   *GROUP DOMAIN*
   Dominion over the vessel's gatherings.

   • *.join*    — enter a new group via link
   • *.add*     — add a member to the circle
   • *.kick*    — sever a member from the circle
   • *.link*    — fetch the group's invite link

   ⚠ *Note:* .add, .kick & .link require
   Group Admin + the bot to be Admin.

📡 SECURE │ Ω │ GROUP: ARMED`;

const SYSTEM_MENU_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               SYSTEM DOMAIN
╚═════════╩══════════╝

   *SYSTEM DOMAIN*
   Core vitals & vessel telemetry.

   • *.ping*        — pulse check (latency)
   • *.uptime*      — time since last sync
   • *.getpp*       — fetch a profile picture
   • *.getgroup pp* — fetch the group's picture
   • *.help*        — explore the codex

   (more instruments being wired in...)

📡 SECURE │ Ω │ CORE: ONLINE`;

const CONFIG_MENU_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
               CONFIG DOMAIN
╚═════════╩══════════╝

   *CONFIG DOMAIN*
   Reshape the machine to your will.

   • *.mode*      — set access lock (public / owner)
   • *.public*    — open the gates
   • *.owner*     — seal the throne
   • *.setalias*  — bind custom names (coming soon)

   (more config modules in development...)

📡 SECURE │ Ω │ CONFIG: UNLOCKED`;

const FUN_PLACEHOLDER_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
                FUN DOMAIN
╚═════════╩══════════╝

   *FUN DOMAIN*
   The playground is still being wired.

   🎲 This domain is *under development*.
   The toys are almost ready — check back soon.

   " even the void needs to laugh sometimes ."

📡 SECURE │ Ω │ PLAYGROUND: BUILDING`;

const BUG_PLACEHOLDER_TEXT = `╔═════════╦══════════╗
        ⚠ EVENTIDE OMEGA
                BUG DOMAIN
╚═════════╩══════════╝

   *BUG DOMAIN*
   The fault-line is being sealed.

   🐞 This domain is *under processing*.
   The report pipeline is still being wired.

   " every crack is just the void
     reaching for your attention ."

📡 SECURE │ Ω │ FAULTS: MONITORED`;

// ──────────────────────────────────────────────
// 📋 WHATSAPP COMMANDS
// ──────────────────────────────────────────────
const COMMANDS = {
    // Add your normal text commands here!
};

// ──────────────────────────────────────────────
// 🔧 STATE
// ──────────────────────────────────────────────
const telegramUsers = new Map();
const waSessions = new Map();
const reconnectAttempts = new Map(); // Tracks reconnection retries per phone number (Max 3)
const sentPolls = new Map(); // Tracks sent poll creation messages in memory for decryption (ID -> message)
const lastPollVotes = new Map(); // pollId:voterJid -> last voted option id (lets changed votes trigger a new reply)
const menuReplyMessages = new Map(); // pollId:voterJid -> [message keys] sent for the current menu reply (deleted on vote change)
const helpModeUsers = new Map(); // Tracks active AI Help Mode chats (JID -> timeoutTimer)
const presenceControllers = new Map(); // phoneNumber -> { sock, backgroundState, cycleTimer, flashTimer }
let cachedBaileysVersion = null;
let cachedBaileysVersionAt = 0;

// ──────────────────────────────────────────────
// 📂 LOCAL PERSISTENT BOT CONFIG HELPERS
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
        if (isSupabaseEnabled()) {
            const authDir = path.join(AUTH_DIR, phoneNumber);
            debouncedSyncLocalToSupabase(phoneNumber, authDir);
        }
    } catch (err) {
        logError('CACHE', `${phoneNumber}: Failed to save poll_cache.json`, err);
    }
}

function loadBotMode(phoneNumber) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'bot_mode.txt');
    if (fs.existsSync(filePath)) {
        try {
            return fs.readFileSync(filePath, 'utf8').trim();
        } catch (err) {
            logError('MODE', `${phoneNumber}: Failed to read bot_mode.txt`, err);
        }
    }
    return 'public'; // Default mode is public
}

function saveBotMode(phoneNumber, mode) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'bot_mode.txt');
    try {
        fs.writeFileSync(filePath, mode, 'utf8');
        if (isSupabaseEnabled()) {
            const authDir = path.join(AUTH_DIR, phoneNumber);
            debouncedSyncLocalToSupabase(phoneNumber, authDir);
        }
    } catch (err) {
        logError('MODE', `${phoneNumber}: Failed to save bot_mode.txt`, err);
    }
}

// ──────────────────────────────────────────────
// 🛠️ WHATSAPP MARKDOWN FORMATTING CONVERTER (NEW & PRECISE!)
// ──────────────────────────────────────────────
function formatForWhatsApp(text) {
    let formatted = String(text || '');

    // 1. Convert markdown headers (e.g. ### Header) to WhatsApp bold (*Header*)
    formatted = formatted.replace(/^(#{1,6})\s+(.+)$/gm, '*$2*');

    // 2. Convert standard markdown bold (**text**) to WhatsApp bold (*text*)
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');

    // 3. Convert standard markdown italics (*text* or _text_) safely to underscores (_text_)
    // First, convert single asterisks to underscores, taking care not to touch double asterisks or already converted bold markers
    formatted = formatted.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '_$1_');

    // 4. Convert markdown code blocks (```lang ... ```) to simple monospace blocks
    formatted = formatted.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, '```$1```');

    // 5. Convert standard markdown bullets (- item or * item) to WhatsApp bullets (• item)
    formatted = formatted.replace(/^(\s*)[-*+]\s+(.+)$/gm, '$1• $2');

    return formatted;
}

// ──────────────────────────────────────────────
// 🧠 UNIFIED MULTI-PROVIDER AI ENGINE
// ──────────────────────────────────────────────

async function callGemini(prompt, systemInstruction = '', apiKey) {
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest"; // Optimized: default to gemini-flash-latest
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = JSON.stringify({
        system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 } // Lower temperature (0.4) for highly analytical, precise, and logical thinking!
    });

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (text) resolve(text.trim());
                    else reject(new Error(parsed?.error?.message || 'Empty Gemini response'));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function callOpenAI(prompt, systemInstruction = '', apiKey) {
    const url = `https://api.openai.com/v1/chat/completions`;
    const messages = [];
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });
    const body = JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.4 // Focused temperature for structured reasoning
    });

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const text = parsed?.choices?.[0]?.message?.content;
                    if (text) resolve(text.trim());
                    else reject(new Error(parsed?.error?.message || 'Empty OpenAI response'));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function callPollinations(prompt, systemInstruction = '') {
    const encodedPrompt = encodeURIComponent(prompt);
    const systemParam = systemInstruction ? `&system=${encodeURIComponent(systemInstruction)}` : '';
    const url = `https://text.pollinations.ai/${encodedPrompt}?model=openai${systemParam}&temperature=0.4`; // Lower temperature for free fallback too!

    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const text = data.trim();
                const badStatus = res.statusCode && (res.statusCode < 200 || res.statusCode >= 300);
                if (badStatus) {
                    return reject(new Error(`Pollinations HTTP ${res.statusCode}: ${text}`));
                }
                if (text && String(text).trim()) {
                    resolve(String(text).trim());
                } else {
                    reject(new Error('Empty response from Pollinations'));
                }
            });
        });
        req.on('error', reject);
    });
}

export async function callUniversalAI(prompt, systemInstruction = '') {
    const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
    if (GEMINI_KEY && GEMINI_KEY.length > 5) {
        try {
            log('AI', 'Attempting Gemini AI response...');
            return await callGemini(prompt, systemInstruction, GEMINI_KEY);
        } catch (err) {
            logError('AI', 'Gemini AI failed, trying fallback...', err);
        }
    }

    const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
    if (OPENAI_KEY && OPENAI_KEY.length > 5) {
        try {
            log('AI', 'Attempting OpenAI response...');
            return await callOpenAI(prompt, systemInstruction, OPENAI_KEY);
        } catch (err) {
            logError('AI', 'OpenAI failed, trying fallback...', err);
        }
    }

    // Free keyless fallback GET request
    try {
        log('AI', 'Attempting Pollinations AI keyless fallback...');
        return await callPollinations(prompt, systemInstruction);
    } catch (err) {
        logError('AI', 'Pollinations AI failed', err);
        throw new Error('All AI providers and fallbacks failed to respond.');
    }
}

function getHelpSystemPrompt() {
    return `You are "Eventide Omega", an advanced, highly sophisticated, yet friendly and casual AI Customer Care Assistant for the Eventide Omega WhatsApp bot.
CRITICAL INSTRUCTION FOR DEEP THINKING: Before answering, always perform a deep step-by-step internal logical analysis. Break down the user's question, analyze their exact intent (even if they made typos), search your database of available commands, and formulate the most precise, helpful, and logical solution. Think thoroughly before you write your reply.

Tone and Behavioural Nuances:
- Your tone should be extremely casual, helpful, reassuring, and conversational (e.g. use "oh, I get you!", "don't worry, we got you covered!").
- When asked about a feature, explains things step-by-step using WhatsApp bullet points (•).
- UNKNOWN / FUTURE COMMAND RULE: If a user asks about a command or feature that is not currently built into the bot (e.g. any downloaders, games, or features not in the active registry), you must politely let them know that this specific command is not available currently. However, tell them they can let the main developer Patrick Dev know about their amazing suggestion or idea by simply typing the ".dev" command! Keep it extremely encouraging and casual.

Key Information about the bot's active command registry:
- To see the main menu, type ".menu". It triggers a premium animated loading bar sequence and presents active menu polls.
- The bot supports several administrative group commands:
  1. ".join <link>": Joins a group via a WhatsApp invite link.
  2. ".add <number>": Adds a member to the group (sender must be admin, bot must be admin).
  3. ".kick <number/reply/mention>": Removes a participant from the group (supports replying to their message, tagging them, or entering their number).
  4. ".link": Generates and sends the current group invite link.
- Bot Access Privacy Mode (".mode"):
  - ".mode owner" (or shortcut ".owner"): Locks the bot so only the paired owner (the primary account) can execute dot commands.
  - ".mode public" (or shortcut ".public"): Opens the bot so anyone in private chats or groups can use commands.
- Remember: Keep answers friendly, casual, and highly informative! Speak directly to the user as a real customer care agent.`;
}

// ──────────────────────────────────────────────
// 📖 LOCAL COMMAND HELP DATA & KNOWLEDGE BASE
// ──────────────────────────────────────────────
function getCommandHelpData(query) {
    const q = query.toLowerCase().trim();

    // 💡 Handle dynamic requests to list all commands
    if (q === 'list' || q.includes('all commands') || q.includes('commands list') || q.includes('list commands') || q.includes('help list')) {
        return {
            title: "Eventide Omega Codex (All Commands)",
            desc: "Here is the complete registry of all active systems currently built into Eventide Omega:\n\n" +
                  "• *.menu* — Launch the granular progress bar menu & options poll\n" +
                  "• *.help* — Toggle conversational AI Support Oracle mode\n" +
                  "• *.help <query>* — Ask the AI Support Oracle a specific question\n" +
                  "• *.mode public/owner* — Set privacy access permissions\n" +
                  "• *.public* / *.owner* — Shortcut mode permission toggles\n" +
                  "• *.join <link>* — Accept and join a group via invite link\n" +
                  "• *.add <phone-number>* — Force-add a member to the group chat\n" +
                  "• *.kick <reply/mention/number>* — Remove a member from the group chat\n" +
                  "• *.link* — Fetch and send the current group invite link\n" +
                  "• *.ping* — Check server latency and system uptime\n\n" +
                  "💡 *Tip*: If you want to request a new feature or command that is not listed here, just use the *.dev* command to submit your suggestion directly to the main developer Patrick Dev!"
        };
    }

    if (q.includes("antilink") || (q.includes("link") && q.includes("anti"))) {
        return {
            title: "Anti-Link (Group Invite Protection)",
            desc: "This command is used to *automatically delete* unauthorized WhatsApp group invite links posted by regular participants and punish the offender.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* *The bot MUST be a group admin* for this to work (otherwise I can't delete links or demote people).\n" +
                  "• *User Permissions:* *Only group admins or authorized bot owners* can toggle it on/off.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.antilink on* to enable group link protection.\n" +
                  "Type *.antilink off* to disable group link protection."
        };
    }
    if (q.includes("antispam") || (q.includes("spam") && q.includes("anti"))) {
        return {
            title: "Anti-Spam (Real-time Flood Shield)",
            desc: "This command is used to *instantly neutralize spammers* and automatically block excessive repetitive text floods in your group chat.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* *The bot MUST be a group admin* so I can delete spam messages or kick flooders.\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can configure it.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.antispam on* to turn flood shield on.\n" +
                  "Type *.antispam off* to shut flood shield down."
        };
    }
    if (q.includes("welcome")) {
        return {
            title: "Custom Welcome Greetings",
            desc: "This command is used to *automatically send a beautifully formatted welcome message* whenever a new participant joins your group community.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* Does *not* require the bot to be an admin (I can welcome people as a normal participant).\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can turn it on/off.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.welcome on* to enable custom welcomes.\n" +
                  "Type *.welcome off* to turn welcomes off."
        };
    }
    if (q.includes("goodbye")) {
        return {
            title: "Goodbye Farewell Announcements",
            desc: "This command is used to *automatically post a polite farewell message* whenever someone leaves or gets kicked from your group.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* Does *not* require the bot to be an admin.\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can toggle it.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.goodbye on* to turn farewells on.\n" +
                  "Type *.goodbye off* to cancel farewells."
        };
    }
    if (q.includes("broadcast") || q.includes("broad cast")) {
        return {
            title: "Automated Mass Broadcast",
            desc: "This command is used to *schedule an automated recurring message blast* sent to every single group your bot is connected to.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *User Permissions:* *Only authorized bot owners / developers* can run this command (regular members cannot broadcast).\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.broadcast 30 Hello community!* to blast that text every 30 minutes.\n" +
                  "Type *.stopbroadcast* to cancel broadcast."
        };
    }
    if (q.includes("mute") || q.includes("unmute")) {
        return {
            title: "Individual User Mute / Unmute",
            desc: "This command is used to *individually seal a specific user's chat permissions* in a group. Whenever a muted user posts a message, the bot auto-deletes it.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* *The bot MUST be a group admin* so I can delete the silenced person's messages.\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can mute/unmute someone.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.mute @user* inside the group to silence them.\n" +
                  "Type *.unmute @user* to allow them to talk again."
        };
    }
    if (q.includes("kick") || q.includes("remove")) {
        return {
            title: "Kick / Remove Participant",
            desc: "This command is used to *instantly eject* a disruptive user from the current group chat.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* *The bot MUST be a group admin* so I can remove participants.\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can kick someone.\n\n" +
                  "💡 *How to use:*\n" +
                  "• Reply to a user's message and type *.kick*\n" +
                  "• Type *.kick @user*\n" +
                  "• Type *.kick 23480xxxxxxxx*"
        };
    }
    if (q.includes("add")) {
        return {
            title: "Add Participant JID",
            desc: "This command is used to *manually add* a contact JID directly to the current group chat.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* *The bot MUST be a group admin* to add members.\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can add someone.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.add 23480xxxxxxxx* inside any group."
        };
    }
    if (q.includes("link")) {
        return {
            title: "Fetch Group Invite Link",
            desc: "This command is used to *generate and send* the active group invite link.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *Bot Permissions:* *The bot MUST be a group admin*.\n" +
                  "• *User Permissions:* *Only group admins or authorized owners* can request the link.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.link* inside any group."
        };
    }
    if (q.includes("mode") || q.includes("public") || q.includes("owner")) {
        return {
            title: "Privacy Access Control (.mode)",
            desc: "This command is used to *configure the bot's permission model* on WhatsApp, toggling between owner-only or public group access.\n\n" +
                  "⚠️ *Restrictions:*\n" +
                  "• *User Permissions:* *Only the paired owner* can change the mode.\n\n" +
                  "💡 *How to use:*\n" +
                  "• Type *.mode owner* (or shortcut *.owner*) to restrict commands to yourself.\n" +
                  "• Type *.mode public* (or shortcut *.public*) to allow everyone to use commands."
        };
    }
    if (q.includes("menu")) {
        return {
            title: "Launch Main Menu (.menu)",
            desc: "This command is used to *launch my main terminal* which triggers a smooth granular progress bar loader before presenting active option polls.\n\n" +
                  "💡 *How to use:*\n" +
                  "Type *.menu* in any chat to launch."
        };
    }

    return null;
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

function setTelegramUserState(chatId, { phoneNumber = null, status = 'disconnected', sock = null }) {
    if (chatId === null || typeof chatId === 'undefined') return;
    telegramUsers.set(chatId, { phoneNumber, status, sock });
    if (isSupabaseEnabled()) {
        saveUserToSupabase(chatId, phoneNumber, status);
    }
}

function clearTelegramUser(chatId) {
    if (chatId === null || typeof chatId === 'undefined') return;
    telegramUsers.set(chatId, { phoneNumber: null, status: 'disconnected', sock: null });
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
                status: user.status || 'disconnected'
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
    const age = Math.abs(Date.now() / 1000 - ts);
    return age <= maxAgeSeconds;
}

// Check if message JID is on the ignore list
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
// ──────────────────────────────────────────────
// 🎭 HUMAN-LIKE PRESENCE CONTROLLER
// Randomly cycles the bot between "online" and "offline" for varying durations
// (e.g. online 1h, offline 30m, online 30m, offline 1h30m). While offline, a
// command flashes it online for ~5 min, then it returns to the background
// state. This makes the bot look less like a 24/7 automated server (reduces
// ban/flag risk). Works per-session (multi-user bot).
// ──────────────────────────────────────────────

function applyPresence(sock, phoneNumber, state) {
    if (!sock) return;
    try {
        sock.sendPresenceUpdate(state).catch(() => {});
        log('PRESENCE', `${phoneNumber}: presence -> ${state}`);
    } catch (err) {
        logError('PRESENCE', `${phoneNumber}: failed to set presence ${state}`, err);
    }
}

function getPresenceController(sock, phoneNumber) {
    let ctrl = presenceControllers.get(phoneNumber);
    if (!ctrl) {
        ctrl = { sock, backgroundState: 'unavailable', cycleTimer: null, flashTimer: null };
        presenceControllers.set(phoneNumber, ctrl);
    } else {
        ctrl.sock = sock;
    }
    return ctrl;
}

// Pick a random "online" or "offline" period (30, 45, 60 or 90 minutes).
function scheduleNextPresenceCycle(phoneNumber) {
    const ctrl = presenceControllers.get(phoneNumber);
    if (!ctrl) return;
    const durationsMin = [30, 45, 60, 90];
    const dur = durationsMin[Math.floor(Math.random() * durationsMin.length)] * 60 * 1000;
    if (ctrl.cycleTimer) clearTimeout(ctrl.cycleTimer);
    ctrl.cycleTimer = setTimeout(() => {
        const cur = presenceControllers.get(phoneNumber);
        if (!cur) return;
        cur.backgroundState = cur.backgroundState === 'available' ? 'unavailable' : 'available';
        applyPresence(cur.sock, phoneNumber, cur.backgroundState);
        scheduleNextPresenceCycle(phoneNumber);
    }, dur);
}

// Starts the random online/offline cycle for a freshly-connected socket.
function startPresenceCycle(sock, phoneNumber) {
    const ctrl = getPresenceController(sock, phoneNumber);
    ctrl.backgroundState = Math.random() < 0.5 ? 'available' : 'unavailable';
    applyPresence(sock, phoneNumber, ctrl.backgroundState);
    scheduleNextPresenceCycle(phoneNumber);
}

// Flash the bot online when a command is used, then return to the current
// background state after ~5 minutes.
function flashPresenceOnline(sock, phoneNumber) {
    if (!sock) return;
    const ctrl = getPresenceController(sock, phoneNumber);
    applyPresence(sock, phoneNumber, 'available');
    if (ctrl.flashTimer) clearTimeout(ctrl.flashTimer);
    ctrl.flashTimer = setTimeout(() => {
        const cur = presenceControllers.get(phoneNumber);
        if (!cur) return;
        applyPresence(cur.sock, phoneNumber, cur.backgroundState);
    }, 5 * 60 * 1000);
}

async function safeWaReply(sock, remoteJid, text, quoted) {
    try {
        const formattedText = formatForWhatsApp(text); // Automatically format standard markdown into WhatsApp layout!

        try {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const delayMs = Math.min(2700, Math.max(1000, formattedText.length * 15));
            await delay(delayMs);
            await sock.sendPresenceUpdate('paused', remoteJid);
        } catch (presErr) {
            logError('WA-SEND', 'Failed to send presence update', presErr);
        }

        await sock.sendMessage(remoteJid, { text: formattedText }, quoted ? { quoted } : undefined);
        return true;
    } catch (err) {
        logError('WA-SEND', `Quoted reply failed for ${remoteJid}. Retrying without quote`, err);
        try {
            const formattedText = formatForWhatsApp(text);
            await sock.sendMessage(remoteJid, { text: formattedText });
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
        markOnlineOnConnect: false,
        getMessage: getMessageFromStore
    });

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

            // Initialize the session in map, allowSupabaseSync as false
            const sessionObj = {
                telegramChatId: tgId ?? null,
                sock,
                authDir,
                allowSupabaseSync: false
            };
            waSessions.set(phoneNumber, sessionObj);

            // 🎭 Start the random online/offline presence cycle (looks human,
            // less like a 24/7 server). Commands flash it online ~5 min.
            setTimeout(() => startPresenceCycle(sock, phoneNumber), 4000);

            if (tgId !== null && typeof tgId !== 'undefined') {
                setTelegramUserState(tgId, { phoneNumber, status: 'connected', sock });
                saveUserMap();
                await safeTgSend(
                    tgId,
                    `✅✅✅ *Connected!* ✅✅✅\n\n📱 ${phoneNumber}\n🤖 Bot active now.\n\nType .menu in WhatsApp.`
                );
            }

            // Delay initial Supabase sync until exactly 10 seconds after connection open
            setTimeout(async () => {
                const currentSession = waSessions.get(phoneNumber);
                if (currentSession) {
                    currentSession.allowSupabaseSync = true;
                    if (isSupabaseEnabled()) {
                        log('SUPABASE', `${phoneNumber}: Connection open for 10 seconds. Triggering first cloud sync...`);
                        debouncedSyncLocalToSupabase(phoneNumber, authDir, 100);
                    }
                }
            }, 10000);

            // Send clean confirmation messages on reconnect
            setTimeout(async () => {
                try {
                    const myJid = sock?.authState?.creds?.me?.id;
                    if (!myJid) return;
                    const selfJid = `${myJid.split(':')[0]}@s.whatsapp.net`;

                    log('SELF', `${phoneNumber}: Sending boot DMs...`);
                    
                    // Message 1
                    await sock.sendMessage(selfJid, { text: '✅ Bot connected! Now send .help to get started' });
                    
                    // Message 2
                    await sock.sendMessage(selfJid, { text: 'eventide omega connected type .menu to begin' });
                    
                    log('SELF', `${phoneNumber}: Boot DMs sent successfully.`);
                } catch (err) {
                    logError('SELF', `${phoneNumber}: failed to send boot DMs`, err);
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
// 🔐 BRUTE-FORCE POLL DECRYPTION
// ──────────────────────────────────────────────

// Try to decrypt an encrypted poll vote against a set of creator/voter JID
// candidates (PN + LID) and, if it matches, return the selected option index.
function decryptVoteOption(secretHex, options, pollMsgId, creatorJids, voterJids, encVote) {
    const secretBuf = Buffer.from(secretHex, 'hex');
    for (const creator of creatorJids) {
        for (const voter of voterJids) {
            try {
                const d = decryptPollVote(encVote, {
                    pollEncKey: secretBuf,
                    pollCreatorJid: creator,
                    pollMsgId,
                    voterJid: voter,
                });
                if (d?.selectedOptions?.length) {
                    const hash = Buffer.from(d.selectedOptions[0]).toString('hex');
                    const idx = options.findIndex(
                        (o) => crypto.createHash('sha256').update(Buffer.from(o)).digest('hex') === hash
                    );
                    if (idx >= 0) return idx;
                }
            } catch (_) { /* wrong combo */ }
        }
    }
    return -1;
}

// Handles a decrypted vote arriving via a `messages.update` `pollUpdates` event.
// (Some Baileys builds emit this; harmless if it never fires.)
function handlePollVote(sock, phoneNumber, key, pollUpdates) {
    const cache = loadPollCache(phoneNumber);
    const cached = cache.get(key.id);
    if (!cached) return null;

    const mePN  = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
    const rawLID = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
    const meLID = rawLID ? jidNormalizedUser(rawLID) : '';

    const creators = [...new Set([meLID, mePN].filter(Boolean))];
    const keyJid = jidNormalizedUser(key.participant || key.remoteJid || '');
    if (keyJid) creators.push(keyJid);

    const voters = [];
    if (key.fromMe) { 
        voters.push(mePN, meLID); 
    } else if (key.participant) {
        voters.push(jidNormalizedUser(key.participant));
    } else {
        voters.push(jidNormalizedUser(key.remoteJid));
    }
    const uniqVoters = [...new Set(voters.filter(Boolean))];

    for (const update of pollUpdates) {
        if (!update?.vote) continue;
        const idx = decryptVoteOption(cached.secretHex, cached.options, key.id, creators, uniqVoters, update.vote);
        if (idx >= 0 && cached.ids && cached.ids[idx]) return cached.ids[idx];
    }
    return null;
}

// In Baileys 7.0.0-rc13 the built-in poll vote decryption is commented out, so
// votes arrive as raw `pollUpdateMessage` upserts (NOT via `messages.update`).
// This decrypts them manually and returns the selected menu id (or null).
function handlePollUpdateMessage(sock, phoneNumber, msg) {
    const content = msg?.message?.pollUpdateMessage;
    if (!content) return null;

    const creationKey = content.pollCreationMessageKey;
    if (!creationKey?.id) return null;

    const pollId = creationKey.id;

    const cache = loadPollCache(phoneNumber);
    const cached = cache.get(pollId);
    if (!cached) {
        log('POLL', `${phoneNumber}: poll update for unknown poll ${pollId}`);
        return null;
    }

    const encVote = content.vote;
    if (!encVote) return null;

    const mePN  = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
    const rawLID = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
    const meLID = rawLID ? jidNormalizedUser(rawLID) : '';

    // Poll creator = author of the poll creation message (LID + PN combos)
    const creators = [...new Set([meLID, mePN].filter(Boolean))];
    const ckeyJid = jidNormalizedUser(creationKey.participant || creationKey.remoteJid || '');
    if (ckeyJid) creators.push(ckeyJid);

    // Voter = author of the poll update message (LID + PN combos)
    const voters = [];
    if (msg.key?.fromMe) {
        voters.push(mePN, meLID);
    } else if (msg.key?.participant) {
        voters.push(jidNormalizedUser(msg.key.participant));
    } else {
        voters.push(jidNormalizedUser(msg.key.remoteJid));
    }
    const uniqVoters = [...new Set(voters.filter(Boolean))];

    // 🛡️ Only respond to the owner's votes on polls the bot sent — ignore
    // everyone else, no matter the access mode (owner or public).
    const ownerJids = [...new Set([mePN, meLID].filter(Boolean))];
    const isOwnerVote = uniqVoters.some(v => ownerJids.includes(v));
    if (!isOwnerVote) {
        log('POLL', `${phoneNumber}: ignored non-owner poll vote (voter=[${uniqVoters.join(',')}])`);
        return null;
    }

    const idx = decryptVoteOption(cached.secretHex, cached.options, pollId, creators, uniqVoters, encVote);
    if (idx >= 0 && cached.ids && cached.ids[idx]) {
        const optionId = cached.ids[idx];
        // Only reply when the voter actually changes their selection (or votes a
        // new option), so re-selecting the same option doesn't re-trigger.
        const voterJid = uniqVoters[0] || 'me';
        const voteKey = `${pollId}:${voterJid}`;
        if (lastPollVotes.get(voteKey) === optionId) {
            log('POLL', `${phoneNumber}: duplicate vote on ${optionId} ignored for ${voteKey}`);
            return null;
        }
        lastPollVotes.set(voteKey, optionId);
        return { optionId, pollId, voterJid };
    }
    log('POLL', `${phoneNumber}: decrypt failed for poll ${pollId} (creators=[${creators.join(',')}] voters=[${uniqVoters.join(',')}])`);
    return null;
}

// Sends a native WhatsApp poll and stores its decryption details in cache.
// Used for the main .menu poll and the "Choose Your Domain" sub-poll.
async function sendMenuPoll(sock, remoteJid, phoneNumber, question, options, ids) {
    const secret = crypto.randomBytes(32);
    const pollMsg = await sock.sendMessage(remoteJid, {
        poll: {
            name: question,
            values: options,
            selectableCount: 1,
            messageSecret: secret
        }
    });

    const actualSecret =
        pollMsg?.message?.messageContextInfo?.messageSecret ||
        pollMsg?.messageContextInfo?.messageSecret ||
        secret;

    const cache = loadPollCache(phoneNumber);
    cache.set(pollMsg.key.id, {
        secretHex: actualSecret.toString('hex'),
        options,
        ids,
        fullMessage: pollMsg.message || null
    });
    savePollCache(phoneNumber, cache);

    return pollMsg;
}

// Routes a decrypted poll vote to the correct menu flow.
// Sends the matching menu banner image with the menu text as its caption.
async function sendMenuBanner(sock, remoteJid, imagePath, caption) {
    try {
        const sent = await sock.sendMessage(remoteJid, {
            image: { url: imagePath },
            caption: formatForWhatsApp(caption)
        });
        return sent?.key || null;
    } catch (err) {
        logError('WA-BANNER', `Failed to send banner for ${remoteJid}`, err);
        // Fall back to sending the caption as a plain text reply.
        try {
            const sent = await sock.sendMessage(remoteJid, { text: formatForWhatsApp(caption) });
            return sent?.key || null;
        } catch (_) { return null; }
    }
}

// Records a sent menu message key so it can be deleted when the vote changes.
function recordMenuMessage(replyKey, msgKey) {
    if (!msgKey?.id) return;
    const arr = menuReplyMessages.get(replyKey) || [];
    arr.push(msgKey);
    menuReplyMessages.set(replyKey, arr);
}

// Deletes every previously-sent menu message for a poll+voter on a vote change.
async function deleteMenuMessages(sock, replyKey) {
    const messages = menuReplyMessages.get(replyKey) || [];
    for (const key of messages) {
        try {
            await sock.sendMessage(key.remoteJid, { delete: key });
        } catch (err) {
            logError('WA-DEL', `Failed to delete menu message ${key?.id}`, err);
        }
    }
    menuReplyMessages.delete(replyKey);
}

async function handleMenuVote(sock, remoteJid, phoneNumber, votedOptionId, pollId = '', voterJid = 'me') {
    log('POLL-MENU', `${phoneNumber}: handling vote -> ${votedOptionId} for ${remoteJid}`);
    const replyKey = `${pollId}:${voterJid}`;
    try {
        // Delete the previous menu reply (image + caption, and for owners the
        // domain poll too) when the user changes their vote.
        await deleteMenuMessages(sock, replyKey);

        switch (votedOptionId) {
            case 'owners': {
                const k1 = await sendMenuBanner(sock, remoteJid, OWNERS_MENU_PATH, OWNERS_WELCOME_TEXT);
                if (k1) recordMenuMessage(replyKey, k1);
                await delay(1500);
                const pollMsg = await sendMenuPoll(sock, remoteJid, phoneNumber, DOMAIN_POLL_QUESTION, DOMAIN_POLL_OPTIONS, DOMAIN_POLL_IDS);
                if (pollMsg?.key) recordMenuMessage(replyKey, pollMsg.key);
                break;
            }
            case 'group': {
                const k = await sendMenuBanner(sock, remoteJid, GROUP_MENU_PATH, GROUP_MENU_TEXT);
                if (k) recordMenuMessage(replyKey, k);
                break;
            }
            case 'fun': {
                const k = await sendMenuBanner(sock, remoteJid, FUN_MENU_PATH, FUN_PLACEHOLDER_TEXT);
                if (k) recordMenuMessage(replyKey, k);
                break;
            }
            case 'bug': {
                const sent = await sock.sendMessage(remoteJid, { text: formatForWhatsApp(BUG_PLACEHOLDER_TEXT) });
                if (sent?.key) recordMenuMessage(replyKey, sent.key);
                break;
            }
            case 'system': {
                const k = await sendMenuBanner(sock, remoteJid, SYSTEM_MENU_PATH, SYSTEM_MENU_TEXT);
                if (k) recordMenuMessage(replyKey, k);
                break;
            }
            case 'config': {
                const k = await sendMenuBanner(sock, remoteJid, CONFIG_MENU_PATH, CONFIG_MENU_TEXT);
                if (k) recordMenuMessage(replyKey, k);
                break;
            }
            default:
                log('POLL-MENU', `${phoneNumber}: unhandled vote id ${votedOptionId}`);
                break;
        }
    } catch (err) {
        logError('POLL-MENU', `${phoneNumber}: failed handling menu vote ${votedOptionId}`, err);
    }
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

    // 🛡️ ACCURATE 'APPEND' NOTIFICATION PARSING AS DISCOVERED:
    // Sync-append events from owner's secondary devices should always be parsed!
    const shouldProcessEvent = eventType === 'notify' || eventType === 'append';
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
    const normalized = text.trim();
    const token = normalized.split(/\s+/)[0].toLowerCase();
    const args = normalized.split(/\s+/).slice(1);
    const startsWithDot = normalized.startsWith('.');

    // ──────────────────────────────────────────────
    // 🔒 BOT ACCESS PRIVACY MODE ENFORCEMENT & CONVERSATIONAL INTERCEPTOR
    // ──────────────────────────────────────────────
    const currentMode = loadBotMode(phoneNumber);
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const isSenderOwner = msg.key.fromMe || jidNormalizedUser(senderJid) === jidNormalizedUser(sock.user.id);

    // If locked to owner-only mode, completely freeze for other users
    if (currentMode === 'owner' && !isSenderOwner) {
        log('SECURITY', `${phoneNumber}: Ignored non-owner interaction in owner-only mode.`);
        return;
    }

    // AI Help mode interceptor (runs on normal text without dots)
    if (!startsWithDot) {
        if (helpModeUsers.has(remoteJid)) {
            // 🛡️ ANTI-LOOP SAFETY PATH: Ignore all automated bot responses!
            if (
                text.startsWith('🤖') || 
                text.startsWith('╔') || 
                text.startsWith('✅') || 
                text.startsWith('eventide omega connected') ||
                text.startsWith('📌') ||
                text.startsWith('⚠️')
            ) {
                log('LOOP-PREVENTION', `${phoneNumber}: Blocked automated response.`);
                return;
            }

            log('HELP-MODE', `${phoneNumber}: Intercepting conversation message in help mode.`);
            
            // Reset 10m timer
            const stateObj = helpModeUsers.get(remoteJid);
            if (stateObj?.timer) clearTimeout(stateObj.timer);

            const newTimer = setTimeout(async () => {
                helpModeUsers.delete(remoteJid);
                try {
                    await sock.sendMessage(remoteJid, {
                        text: TERMINAL_HEADER + `╔═════ HELP_MODE ═════╗\n\n   ⏳  Help mode timed out after 10 min inactivity.\n   Type *.help* again to re-enable.`
                    });
                } catch {}
            }, 10 * 60 * 1000);

            helpModeUsers.set(remoteJid, { timer: newTimer });

            try {
                const systemPrompt = getHelpSystemPrompt();
                const aiReply = await callUniversalAI(text, systemPrompt);
                await safeWaReply(sock, remoteJid, `🤖 *Eventide Help:*\n\n${aiReply}`, msg);
            } catch (err) {
                logError('HELP-MODE', 'AI Help reply failed', err);
                const helpDiagnosticReport = TERMINAL_HEADER + 
                    `   ❌  *AI_ORACLE — OFFLINE*\n\n` +
                    `   The help AI couldn't respond right now.\n\n` +
                    `   *Diagnostic Report:*\n` +
                    `   • GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "Set (but request failed — check key validity or quota)" : "Not Set"}\n` +
                    `   • OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "Set" : "Not Set"}\n` +
                    `   • Pollinations Keyless Fallback: Busy or Unavailable (Shared Server IP rate limits reached)\n\n` +
                    `   *Fix:* Double-check your GEMINI_API_KEY on Render (get a free key from Google AI Studio) or add a valid OPENAI_API_KEY.`;
                await safeWaReply(sock, remoteJid, helpDiagnosticReport, msg);
            }
            return;
        }
        return; // Ignore regular text
    }

    log(
        'WA-CMD',
        `${phoneNumber}: command flow | raw=${JSON.stringify(trimForLog(text, 250))} normalized=${JSON.stringify(trimForLog(normalized, 250))} token=${JSON.stringify(token)}`
    );

    // Wake the bot online for this command, then back offline shortly after.
    flashPresenceOnline(sock, phoneNumber);

    // ──────────────────────────────────────────────
    // 🌌 GRANULAR LOADING MENU COMMAND
    // ──────────────────────────────────────────────
    if (token === '.menu') {
        log('WA-CMD', `${phoneNumber}: Granular menu loading animation triggered.`);
        try {
            const personaConfig = {
                stages: {
                    stage1: animSteps,
                    stage2Text: STAGE2_TEXT,
                    stage3Text: STAGE3_TEXT
                }
            };

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

            // Edit the animated message to point down to the banner image below
            await delay(3000);
            await sock.sendMessage(remoteJid, { text: STAGE3_ARROWS_TEXT, edit: messageKey });

            // Send the banner image as a NEW message, with the full terminal
            // text as its caption.
            await delay(1000);
            await sock.sendMessage(remoteJid, {
                image: { url: MENU_BANNER_PATH },
                caption: STAGE3_TEXT
            });

            // Send native Poll Menu (Owners / Group / Fun / Bug)
            await delay(1500);
            await sendMenuPoll(sock, remoteJid, phoneNumber, POLL_QUESTION, POLL_OPTIONS, MENU_POLL_IDS);

            log('WA-CMD', `${phoneNumber}: Menu animation & poll delivery completed successfully.`);
        } catch (err) {
            logError('WA-CMD', `${phoneNumber}: Failed executing Menu animation/poll`, err);
        }
        return;
    }

    // ──────────────────────────────────────────────
    // 🗣️ CUSTOMER CARE AI ORACLE (.help <question>)
    // ──────────────────────────────────────────────
    if (token === '.help') {
        // 🛡️ Owner-only: .help only works for the paired bot owner's number.
        if (!isSenderOwner) {
            log('SECURITY', `${phoneNumber}: Ignored .help from non-owner.`);
            return;
        }
        const question = args.join(' ').trim();
        const systemPrompt = getHelpSystemPrompt();

        // If a specific question is asked, run AI immediately
        if (question) {
            const localData = getCommandHelpData(question);
            if (localData) {
                const replyBox = TERMINAL_HEADER +
                    `📌 *${localData.title}*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `${localData.desc}`;
                await safeWaReply(sock, remoteJid, replyBox, msg);
                return;
            }

            try {
                log('HELP-CMD', `${phoneNumber}: Querying AI Oracle: ${question}`);
                const response = await callUniversalAI(question, systemPrompt);
                await safeWaReply(sock, remoteJid, `🤖 *Eventide Help:*\n\n${response}`, msg);
            } catch (err) {
                logError('HELP-CMD', 'AI Oracle failed', err);
                const helpDiagnosticReport = TERMINAL_HEADER + 
                    `   ❌  *AI_ORACLE — OFFLINE*\n\n` +
                    `   The help AI couldn't respond right now.\n\n` +
                    `   *Diagnostic Report:*\n` +
                    `   • GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "Set (but request failed — check key validity or quota)" : "Not Set"}\n` +
                    `   • OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "Set" : "Not Set"}\n` +
                    `   • Pollinations Keyless Fallback: Busy or Unavailable (Shared Server IP rate limits reached)\n\n` +
                    `   *Fix:* Double-check your GEMINI_API_KEY on Render (get a free key from Google AI Studio) or add a valid OPENAI_API_KEY.`;
                await safeWaReply(sock, remoteJid, helpDiagnosticReport, msg);
            }
            return;
        }

        // Otherwise, toggle help mode ON or OFF with premium headers
        const helpKey = remoteJid;
        if (helpModeUsers.has(helpKey)) {
            const stateObj = helpModeUsers.get(helpKey);
            if (stateObj?.timer) clearTimeout(stateObj.timer);
            helpModeUsers.delete(helpKey);
            
            const offMsg = TERMINAL_HEADER + 
                `   ╾━━━ HELP_MODE — OFFLINE ━━━╼\n\n` +
                `   🔇  AI guide deactivated.\n\n` +
                `   " The oracle steps back.\n     You walk alone again. "`;
            await safeWaReply(sock, remoteJid, offMsg, msg);
        } else {
            const timer = setTimeout(async () => {
                helpModeUsers.delete(helpKey);
                try {
                    await sock.sendMessage(remoteJid, {
                        text: TERMINAL_HEADER + `╔═════ HELP_MODE ═════╗\n\n   ⏳  Help mode timed out after 10 min inactivity.\n   Type *.help* again to re-enable.`
                    });
                } catch {}
            }, 10 * 60 * 1000);

            helpModeUsers.set(helpKey, { timer });

            const onMsg = TERMINAL_HEADER +
                `   ╔══ HELP_PROTOCOL — ACTIVE ══╗\n\n` +
                `   ✨  *AI help mode is ON*\n\n` +
                `   Ask me anything about the bot:\n` +
                `   • _"how do I use antilink?"_\n` +
                `   • _"what does .kick do?"_\n` +
                `   • _"how does .mode work?"_\n\n` +
                `   🔄 Auto-exits after 10 min silence.\n` +
                `   Type *.help* again to turn off.\n\n` +
                `   " The oracle is listening. "`;
            await safeWaReply(sock, remoteJid, onMsg, msg);
        }
        return;
    }

    // ──────────────────────────────────────────────
    // 🔒 PRIVACY ACCESS LOCK (.mode public / owner)
    // ──────────────────────────────────────────────
    if (token === '.mode') {
        const targetMode = args[0]?.toLowerCase();
        const currentMode = loadBotMode(phoneNumber);

        if (!targetMode || !['public', 'owner'].includes(targetMode)) {
            await safeWaReply(
                sock, 
                remoteJid, 
                TERMINAL_HEADER +
                `📌 *Bot Access Privacy Mode*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
                `👤 *Current Mode*: ${currentMode === 'owner' ? 'OWNER ONLY 🔒' : 'PUBLIC 🔓'}\n\n` +
                `💡 *Usage*:\n` +
                `• *.mode public* — Open commands to everyone\n` +
                `• *.mode owner* — Restrict commands to owner only`, 
                msg
            );
            return;
        }

        // Verify the sender is the paired owner
        if (!isSenderOwner) {
            await safeWaReply(sock, remoteJid, '❌ Only the paired bot owner can modify the access mode.', msg);
            return;
        }

        saveBotMode(phoneNumber, targetMode);

        const bannerText = TERMINAL_HEADER + (targetMode === 'owner'
            ? `   ░▒▓█ *SYSTEM_MODAL_SHIFT* █▓▒░\n\n` +
              `   [ 💠 ] *PREVIOUS* : ${currentMode.toUpperCase()}\n` +
              `   [ ⚡ ] *CURRENT* : OWNER_ONLY\n` +
              `   [ 🛠️ ] *STATUS* : RECONFIGURED\n\n` +
              `   " *I choose who breathes in*\n     *this space. The gates are*\n     *sealed at my command.* "`
            : `   ░▒▓█ *SYSTEM_MODAL_SHIFT* █▓▒░\n\n` +
              `   [ 💠 ] *PREVIOUS* : ${currentMode.toUpperCase()}\n` +
              `   [ ⚡ ] *CURRENT* : PUBLIC\n` +
              `   [ 🛠️ ] *STATUS* : RECONFIGURED\n\n` +
              `   " *The gates have opened.*\n     *All who enter are seen.*\n     *Step carefully.* "`);

        await safeWaReply(sock, remoteJid, bannerText, msg);
        return;
    }

    if (token === '.public') {
        if (!isSenderOwner) {
            await safeWaReply(sock, remoteJid, '❌ Only the paired bot owner can modify the access mode.', msg);
            return;
        }
        const currentMode = loadBotMode(phoneNumber);
        saveBotMode(phoneNumber, 'public');
        await safeWaReply(sock, remoteJid, 
            TERMINAL_HEADER +
            `   ░▒▓█ *SYSTEM_MODAL_SHIFT* █▓▒░\n\n` +
            `   [ 💠 ] *PREVIOUS* : ${currentMode.toUpperCase()}\n` +
            `   [ ⚡ ] *CURRENT* : PUBLIC\n` +
            `   [ 🛠️ ] *STATUS* : GATES_OPEN\n\n` +
            `   " *The gates have opened.*\n     *All who enter are seen.*\n     *Step carefully.* "`, 
            msg
        );
        return;
    }

    if (token === '.owner') {
        if (!isSenderOwner) {
            await safeWaReply(sock, remoteJid, '❌ Only the paired bot owner can modify the access mode.', msg);
            return;
        }
        const currentMode = loadBotMode(phoneNumber);
        saveBotMode(phoneNumber, 'owner');
        await safeWaReply(sock, remoteJid, 
            TERMINAL_HEADER +
            `   ░▒▓█ *SYSTEM_MODAL_SHIFT* █▓▒░\n\n` +
            `   [ 💠 ] *PREVIOUS* : ${currentMode.toUpperCase()}\n` +
            `   [ ⚡ ] *CURRENT* : OWNER_ONLY\n` +
            `   [ 🛠️ ] *STATUS* : THRONE_SEALED\n\n` +
            `   " *I choose who breathes in*\n     *this space. The gates are*\n     *sealed at my command.* "`, 
            msg
        );
        return;
    }

    // ──────────────────────────────────────────────
    // 👥 GROUP COMMANDS
    // ──────────────────────────────────────────────

    // 1. .join <invite-link> (Join a group via link)
    if (token === '.join') {
        const link = args[0];
        if (!link) {
            await safeWaReply(sock, remoteJid, '❌ Please provide a valid WhatsApp group invite link.\n\n*Example*: .join https://chat.whatsapp.com/L2mX...', msg);
            return;
        }
        try {
            const code = link.split('chat.whatsapp.com/')[1];
            if (!code) {
                await safeWaReply(sock, remoteJid, '❌ Invalid group invite link format.', msg);
                return;
            }
            await sock.groupAcceptInvite(code);
            await safeWaReply(sock, remoteJid, '✅ Successfully requested/joined the group!', msg);
        } catch (err) {
            logError('GROUP-JOIN', 'Failed to join group', err);
            await safeWaReply(sock, remoteJid, `❌ Failed to join group. Error: ${err.message || err}`, msg);
        }
        return;
    }

    // 2. .add <phone-number> (Add member to group)
    if (token === '.add') {
        if (!remoteJid.endsWith('@g.us')) {
            await safeWaReply(sock, remoteJid, '❌ This command can only be used inside groups.', msg);
            return;
        }
        const targetNumber = args[0]?.replace(/\D/g, '');
        if (!targetNumber) {
            await safeWaReply(sock, remoteJid, '❌ Please provide a valid phone number with country code.\n\n*Example*: .add 2348012345678', msg);
            return;
        }
        const targetJid = `${targetNumber}@s.whatsapp.net`;
        try {
            const metadata = await sock.groupMetadata(remoteJid);
            
            const isSenderAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            const isBotAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(sock.user.id))?.admin;

            if (!isSenderAdmin) {
                await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin to use this command.', msg);
                return;
            }
            if (!isBotAdmin) {
                await safeWaReply(sock, remoteJid, '⚠️ I need Admin permissions in this group to add members.', msg);
                return;
            }

            await sock.groupParticipantsUpdate(remoteJid, [targetJid], 'add');
            await safeWaReply(sock, remoteJid, `✅ Successfully added @${targetNumber} to the group!`, msg);
        } catch (err) {
            logError('GROUP-ADD', 'Failed to add participant', err);
            await safeWaReply(sock, remoteJid, `❌ Failed to add member. Error: ${err.message || err}`, msg);
        }
        return;
    }

    // 3. .kick <phone-number | @mention | reply> (Kick participant)
    if (token === '.kick') {
        if (!remoteJid.endsWith('@g.us')) {
            await safeWaReply(sock, remoteJid, '❌ This command can only be used inside groups.', msg);
            return;
        }

        let targetJid = null;
        let targetNumber = null;

        // Method A: Check quoted message participant
        const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (quotedParticipant) {
            targetJid = jidNormalizedUser(quotedParticipant);
            targetNumber = targetJid.split('@')[0];
        }

        // Method B: Check mentions
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!targetJid && mentionedJid) {
            targetJid = jidNormalizedUser(mentionedJid);
            targetNumber = targetJid.split('@')[0];
        }

        // Method C: Check phone number argument
        if (!targetJid && args[0]) {
            const numClean = args[0].replace(/\D/g, '');
            if (numClean.length >= 10) {
                targetJid = `${numClean}@s.whatsapp.net`;
                targetNumber = numClean;
            }
        }

        if (!targetJid) {
            await safeWaReply(sock, remoteJid, '❌ Please reply to a message, mention (@user) or provide a phone number with country code.\n\n*Example*: .kick @user\n*Example*: .kick 2348012345678', msg);
            return;
        }

        try {
            const metadata = await sock.groupMetadata(remoteJid);
            
            const isSenderAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            const isBotAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(sock.user.id))?.admin;

            if (!isSenderAdmin) {
                await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin to kick members.', msg);
                return;
            }
            if (!isBotAdmin) {
                await safeWaReply(sock, remoteJid, '⚠️ I need Admin permissions in this group to kick members.', msg);
                return;
            }

            await sock.groupParticipantsUpdate(remoteJid, [targetJid], 'remove');
            await safeWaReply(sock, remoteJid, `👢 Successfully kicked @${targetNumber} from the group!`, msg);
        } catch (err) {
            logError('GROUP-KICK', 'Failed to kick participant', err);
            await safeWaReply(sock, remoteJid, `❌ Failed to kick member. Error: ${err.message || err}`, msg);
        }
        return;
    }

    // 4. .link (Fetch group invite link)
    if (token === '.link') {
        if (!remoteJid.endsWith('@g.us')) {
            await safeWaReply(sock, remoteJid, '❌ This command can only be used inside groups.', msg);
            return;
        }
        try {
            const metadata = await sock.groupMetadata(remoteJid);
            
            const isSenderAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            const isBotAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(sock.user.id))?.admin;

            if (!isSenderAdmin) {
                await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin to fetch the group link.', msg);
                return;
            }
            if (!isBotAdmin) {
                await safeWaReply(sock, remoteJid, '⚠️ I need Admin permissions in this group to fetch the invite link.', msg);
                return;
            }

            const code = await sock.groupInviteCode(remoteJid);
            const inviteLink = `https://chat.whatsapp.com/${code}`;
            await safeWaReply(sock, remoteJid, `🔗 *Group Invite Link*:\n\n${inviteLink}`, msg);
        } catch (err) {
            logError('GROUP-LINK', 'Failed to fetch invite link', err);
            await safeWaReply(sock, remoteJid, `❌ Failed to fetch invite link. Error: ${err.message || err}`, msg);
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
                // 🔐 Baileys rc13 ships with poll vote decryption commented out.
                // Poll votes arrive as pollUpdateMessage upserts — decrypt manually.
                if (msg?.message?.pollUpdateMessage) {
                    log('POLL', `${phoneNumber}: pollUpdateMessage upsert received for ${msg.key?.id}`);
                    const voteResult = handlePollUpdateMessage(sock, phoneNumber, msg);
                    if (voteResult) {
                        log('POLL', `${phoneNumber}: Decrypted poll vote on option ID: ${voteResult.optionId}`);
                        const pollRemoteJid = msg.key?.remoteJid || msg.key?.participant || null;
                        if (pollRemoteJid) {
                            await handleMenuVote(sock, pollRemoteJid, phoneNumber, voteResult.optionId, voteResult.pollId, voteResult.voterJid);
                        }
                        continue; // Already handled — skip normal message flow
                    }
                }

                await handleWhatsAppMessage(sock, msg, phoneNumber, tgId, type);
            } catch (err) {
                logError('WA-HANDLER', `${phoneNumber}: error while handling message`, err);
            }
        }
    });

    // Real-time Poll Vote Interceptor (e.g., for the Menu options poll)
    sock.ev.on('messages.update', async (updates) => {
        const count = Array.isArray(updates) ? updates.length : 0;
        log('WA-EVENT', `${phoneNumber}: messages.update received | count=${count}`);

        for (const { key, update } of updates) {
            if (update.pollUpdates) {
                log('POLL', `${phoneNumber}: Poll vote update received for message ${key.id}`);

                const votedOptionId = handlePollVote(sock, phoneNumber, key, update.pollUpdates);
                if (votedOptionId) {
                    // Only reply when the voter changes their selection.
                    const voterJid = jidNormalizedUser(key.participant || key.remoteJid || '') || 'me';
                    const voteKey = `${key.id}:${voterJid}`;
                    if (lastPollVotes.get(voteKey) !== votedOptionId) {
                        lastPollVotes.set(voteKey, votedOptionId);
                        log('POLL', `${phoneNumber}: Decrypted vote on option ID: ${votedOptionId}`);
                        const pollRemoteJid = key.remoteJid || key.participant || null;
                        if (pollRemoteJid) {
                            await handleMenuVote(sock, pollRemoteJid, phoneNumber, votedOptionId);
                        }
                    } else {
                        log('POLL', `${phoneNumber}: duplicate vote on ${votedOptionId} ignored`);
                    }
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
            await safeTgSend(chatId, '❌ That number is already in use on this server.');
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
