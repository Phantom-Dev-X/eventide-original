import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    decryptPollVote,
    jidNormalizedUser,
    delay,
    downloadMediaMessage
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
import {
    initGames,
    isGamePoll,
    handleGameVote,
    handleGameText,
    handleGameCommand,
    isGameCommand
} from './games.js';
import { initWebApp } from './webApp.js';

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

const TERMINAL_HEADER =
    '╔════════╦════════╗\n' +
    '        ⚠ EVENTIDE OMEGA\n' +
    '               TERMINAL ACCESS                                                                         \n' +
    '╚════════╩════════╝\n\n';

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

// ──────────────────────────────────────────────
// 📢 GROUP CHANNEL LINK (shows a nice preview on WhatsApp)
// Reads from the RENDER env var GROUP_CHANNEL_LINK (set it to your
// WhatsApp channel link), with a fallback default if unset.
// ──────────────────────────────────────────────
const GROUP_CHANNEL_LINK = (process.env.GROUP_CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbCrFiK17En02cax3r02').trim();

// 🖼️ FULLY EMBEDDED channel link-preview. The channel metadata + thumbnail are
// baked into the code, so the bot NEVER makes an HTTP request for previews —
// no delay, no repeated fetches. The thumbnail is stored as base64 and decoded
// once at startup.
const CHANNEL_PREVIEW_TITLE = "\u2500\u2500\u2500 \u4e97 \u1d18\u1d05\u1d20 \u1d1b\u1d07\u1d04\u029c\u0274\u1d0f\u029f\u1d0f\u0262\u026a\u1d07\ua731 \u4e97 \u2500\u2500\u2500";
const CHANNEL_PREVIEW_DESC = "Follow \u2500\u2500\u2500 \u4e97 \u1d18\u1d05\u1d20 \u1d1b\u1d07\u1d04\u029c\u0274\u1d0f\u029f\u1d0f\u0262\u026a\u1d07\ua731 \u4e97 \u2500\u2500\u2500's WhatsApp Channel. Join 41 followers for the latest updates.";
const CHANNEL_PREVIEW_MATCHED = "https://whatsapp.com/channel/0029VbCrFiK17En02cax3r02";
const CHANNEL_PREVIEW_THUMB_B64 = [
    "/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBD",
    "ARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADAAMAD",
    "ASIAAhEBAxEB/8QAGgABAQEBAQEBAAAAAAAAAAAAAAECBAMFBv/EAC0QAAICAQMCBQQCAgMAAAAAAAABAhEDEiExBAUTQVFhkRQi",
    "MnEVgWKhI7Hx/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAECA//EABoRAQEBAQEBAQAAAAAAAAAAAAARAQISIRP/2gAMAwEAAhEDEQA/",
    "APwYBQgwAAKClEKABp8sybfLMgQFAEBQAXISFVuEgBGUNAZBRQEfoZNS5IBAARQo8gVAqBVyAAfJQACRpR/sBLkhXyQACgCUCgCA",
    "ofoBGQ0+aJ6ARkRaLsBmXLMno1e6MMCEKCBwUJl2RQSNxim93Rgtgakt3XBEvUiZXyBbF+hCgAAABQBAUAQPkpACHoAuQEtm0ZN5",
    "VWSX7MALJyKCQEocDcUBDT/FGTb/ABX6AgBQBp8/0IxcnsrN5o6ZpeyLCvMoBBQC0BAUtAQhogEBSAQAAWX3NswUfsCApAIQt/sg",
    "FSS5F2zJpAVK+OTcYXzsvcwjW7Kj1WXRHTjVe/meXLstFoqIWi0WiRWUi0aoUWJUoUaotCFYoUbolCFYojRuiUIVgGqFEisDc1Qo",
    "QrBGbZhoQT+0QMhFDSIjUIuUlGKbk3SSVtlwVG0ju6TtWTLq+p8fpqrTfSznq+Fse2ftWPDgnlXU5ZaVdPo8kU/7eyNZjnu4+akW",
    "j6WHt8MmFZFJPV07kryxjWS6Sq+KPOXR4/5DD0qyVrUE5bSqTXt7m/LHvHDRaPoLt2OlN53ocMkl/wAe/wBj3VX8Mke3xnieWOa4",
    "vFLLj+zeWl1JPfZr/onnT9OXDRUjolgh4kILMot49cnkWlR2uvg6ZdqyQlljLPg1YoOc1qdpJJ+n+SEaza+fRaO2Pb5trVlwxhLJ",
    "4cJyl9s5UnS28rVvyNw7blnPFFTxXlxyyxuT4jd3tzs/gsxPr59Eo+hLt2WMMU3PGseXE8sJ3s0lbXHK9DGTt+XGsik4a8UFPLjv",
    "7oRdbv5V+liYfXC0Ro7p9vzQ63L0rePXhTeSWr7YpK22yPt2XR4urH4Hh+J41/bpuv3d7VyZiuChR3fx83DJNZsDhBwTald6/wAa",
    "2/8ACz7XmjmniWTFKWPX4mlt6VD8nxuv0FcFEaO3D0kZdXLp55INqDlGUJqm9Nrdntl7dDHgeSU4rT0ym6yxleS6apP0LGd6zNj5",
    "TRln1sHasefBDK+oyx1K6XR5Jpf2tmePV9qyYtP03j9Rd3XSzhp+VuZ3Gs3HzGZZ6Ti4ycZJxknTTVNGGZdBGotxkpRbi07TTpow",
    "aQR34O5Z4X4uTPmvi+onGvhnpl7lLNiljePKlJVv1U5L4ezPnJm0zedOe8Za7sXU4ceNRUv3fTQl/tmVnhDq8eeCc9MlJrSobr2R",
    "ypizfpnxjqx9Xpz5Mk1kmpxlCnPdJmodbLHkwOEKx4bqDd6r/K/2cliyetPGPWcvElKUuZO2fR/lYvrup6pYssXnxeGtM1cdkruv",
    "8T5Vlslaj6WTuGLPhWHN0+SUIZHkg1kWpuSWrVtw2r24PTD3Z4lgiseVY8WCeJwWTaWrVvx5av8AR8rUXUPiR9GPcvD6eeCGKTxz",
    "wLG1OV6ZpNKa9Nm1XoM3c/En1GVYpLP1OPw8stS01tqaXq6/rc+dqJqL8H1MvdMWTqOqzLpZ31VxyJ5FtFrhbc2k79jz/lF9L9G8",
    "MvpfD0VqWu9WrVfHPl6HzmyWRX0cvcsc4ZYLp5RjN4q0tL8PN7cu2zeXu8cnVS6nR1Mc2qTxzWanit3UaXrfPqfKsWRXXl6uHUdd",
    "PqckfD1b0oKVuq3XG/P7GTqcOSDi5cry6aEf9o47DZrOpjO8Xa7MXcpYcUcahlaiq26qcV8LZHnn7lnyV4WTPhrmuonK/lnK2YbM",
    "71q5xlqTk5ScpNtt223bZllZlmHQKiFIrSZpMwi2WpG7RbPOy2WpG7FmLFkqx6WLPOy2WkemotnnYsVI3qFmNQsUjVjUYslikbsl",
    "kSb3ey9Q5JcfIFsWZu+SMlWK2TkLi2yavQA0ZYYv1IpZbM2WwLYsnJQLwLILAoAAosgApbMlAWAAAIANze0V7GDU3uYBijyIa20e",
    "9gR8Iyakvtj+jIAgAD9DcCyClJYsooIAKuQAAKQAUEKQAQFFICpWAuxXwXZIlu9gGyLV+yMktge0kpQS4aPFqi6tqfAu/cupjILS",
    "JZFEQAiqAAigAovuwSwBf2QvlZABRXqLAAXYaAGpOuDCLIA2FyiEApACAby454ZKM1TaTJiyyxZFOKTa9VZ0db1n1OmMYpRS81vZ",
    "RykZfIgAAEVR8EARfgfBABS+RAUXyNqoxujBX+KAN2QgAosgA0JEEgIACACAKAAC+RGPIBH/2Q==",
].join("");

// Decode the embedded thumbnail once at startup and build the linkPreview
// object that Baileys uses directly (no network request ever needed).
const CHANNEL_LINK_PREVIEW = {
    'matched-text': CHANNEL_PREVIEW_MATCHED,
    jpegThumbnail: Buffer.from(CHANNEL_PREVIEW_THUMB_B64, 'base64'),
    description: CHANNEL_PREVIEW_DESC,
    title: CHANNEL_PREVIEW_TITLE,
    previewType: 0
};

// Attaches the embedded channel preview to a text content object if the text
// contains the channel link. Purely local — zero HTTP requests.
function attachChannelPreview(content) {
    if (!content?.text || !String(content.text).includes(GROUP_CHANNEL_LINK)) return content;
    content.linkPreview = CHANNEL_LINK_PREVIEW;
    return content;
}

// Builds a contextInfo with an externalAdReply card (thumbnail + title + link).
// This works on ANY message type — including image+caption menu messages, where
// Baileys would otherwise never generate a URL preview for the caption.
function channelContextInfo() {
    return {
        externalAdReply: {
            title: CHANNEL_PREVIEW_TITLE,
            body: CHANNEL_PREVIEW_DESC,
            thumbnail: CHANNEL_LINK_PREVIEW.jpegThumbnail,
            mediaType: 1,
            sourceUrl: GROUP_CHANNEL_LINK,
            renderLargerThumbnail: true,
            showAdAttribution: false
        }
    };
}

const STAGE3_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚════════╩════════╝

                ═══ E C L I P S E ═══
             " i am what remains when 
              everything else is deleted ."

╔════════╦════════╗
║Void signature║SYS CORE║
║👤@Unknown.║ECLIPSE ║
║⚠ASCENDED║ABS ZERO║
╚════════╩════════╝

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
const STAGE3_ARROWS_TEXT = `╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚════════╩════════╝

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
const POLL_QUESTION = `╔════════╦════════╗\n        ⚠ EVENTIDE OMEGA\n╚════════╩════════╝`;
const POLL_OPTIONS = [
    'OWNERS MENU',
    'GROUP MENU',
    'FUN MENU',
    'BUG MENU'
];
const MENU_POLL_IDS = ['owners', 'group', 'fun', 'bug'];

// ──────────────────────────────────────────────
// 🗂️ SUB-MENU / DOMAIN POLLS
// ──────────────────────────────────────────────
const DOMAIN_POLL_QUESTION = `╔════════╦════════╗\n     CHOOSE YOUR DOMAIN\n╚════════╩════════╝`;
const DOMAIN_POLL_OPTIONS = [
    'SYSTEM MENU',
    'CONFIG MENU'
];
const DOMAIN_POLL_IDS = ['system', 'config'];

const OWNERS_WELCOME_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
               TERMINAL ACCESS
╚════════╩════════╝

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

const GROUP_MENU_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
               GROUP DOMAIN
╚════════╩════════╝

   *GROUP DOMAIN*
   Dominion over the vessel's gatherings.

┏━ ✦ ADMIN ━┓
  • *.add*        add a member
  • *.kick*       sever a member
  • *.promote*    raise a member
  • *.demote*     lower a member
  • *.mute*       silence a member
  • *.unmute*     release a member
  • *.listmuted*  list silenced
  • *.revoke*     reset invite link
  • *.link*       fetch invite link
┗━━━━━━━━━━━━━┛

┏━ ✦ AUTOMATION ━┓
  • *.greet*      set welcome/goodbye
  • *.antilink*   ward off links
  • *.antimention* ward off mentions
  • *.antiforward* ward off forwards
  • *.warn*       mark a member
  • *.warnconfig* premium warn matrix
┗━━━━━━━━━━━━━┛

┏━ ✦ INFO ━┓
  • *.groupinfo*  dominion details
  • *.tagall*     call everyone
  • *.hidetag*    silent mention (.ht)
  • *.getvcf*     members contact card
┗━━━━━━━━━━━━━┛

┏━ ✦ JOIN ━┓
  • *.join*       join a new group
┗━━━━━━━━━━━━━┛

   ⚠ *Note:* admin cmds require
   Group Admin + bot as Admin.

📡 SECURE │ Ω │ GROUP: ARMED`;

const SYSTEM_MENU_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
               SYSTEM DOMAIN
╚════════╩════════╝

      ◈ ── S Y S T E M ── ◈
   the core of the machine

┏━ ✦ STATUS ━┓
  • *.ping*       signal pulse
  • *.uptime*     temporal logs
  • *.runtime*    process vitals
  • *.info*       core manifest
  • *.status*     overall state
  • *.version*    core build
  • *.os*         host machine
  • *.botinfo*    about the core
  • *.alive*      life check
┗━━━━━━━━━━━━━━┛

┏━ ✦ OWNER TOOLS ━┓
  • *.dev*        the architect
  • *.gpp*        pull profile pic
  • *.ggpp*       pull group pic
  • *.profile*    host identity
  • *.listgc*     joined groups
  • *.session*    this vessel
  • *.sessions*   linked sessions
  • *.logout*     unlink session
  • *.reconnect*  reweave socket
┗━━━━━━━━━━━━━━┛

┏━ ✦ UTILITIES ━┓
  • *.sticker*    make a sticker
  • *.toimg*      sticker to image
  • *.vv*         unlock view-once
  • *.qr*         generate QR
  • *.calc*       calculate
  • *.base64*     encode / decode
  • *.block*      seal a number
  • *.unblock*    open a number
  • *.cmdstats*   arsenal count
┗━━━━━━━━━━━━━━┛

┏━ ✦ CONTROL ━┓
  • *.restart*    reboot the core
  • *.shutdown*   power down
  • *.autoreact*  toggle auto-react
  • *.antidelete* toggle anti-delete
┗━━━━━━━━━━━━━━┛

   " the machine does not sleep.
     it only waits ."

📡 type *_.help_* to learn how
   to use any command.

> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_`;

const CONFIG_MENU_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
               CONFIG DOMAIN
╚════════╩════════╝

      ◈ ── C O N F I G ── ◈
   shape the vessel itself

┏━ ✦ ACCESS ━┓
  • .mode         lock the gates
  • .public       open to all
  • .owner        seal to owner
┗━━━━━━━━━━━━━┛

┏━ ✦ COMMANDS ━┓
  • .setprefix    change the sigil
  • .setalias     bind a new command
  • .delalias     unbind a command
  • .aliases      list bindings
┗━━━━━━━━━━━━━┛

┏━ ✦ IDENTITY ━┓
  • .setname      rename the vessel
  • .setbio       set the about text
  • .setpp        change the avatar
┗━━━━━━━━━━━━━┛

┏━ ✦ STATE ━┓
  • .settings     view config matrix
  • .reset        restore defaults
  • .autoreactconfig  configure auto-react
  • .antideleteconfig  configure anti-delete
┗━━━━━━━━━━━━━┛

   " the machine bends to
     the hand that shapes it ."

📡 type *_.help_* to learn how
   to use any command.

> _Developed by 【 亗 ᑭᗩTᖇIᑕK ᗪEᐯ 亗 】✧_`;

const FUN_PLACEHOLDER_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
                FUN DOMAIN
╚════════╩════════╝

   *FUN DOMAIN*
   Play. Roast. Ruin someone politely.

┏━ ✦ ARENA ━┓
  • *.ttt*        premium tic-tac-toe
  • *.hangman*    gallows  (.hm)
  • *.chain*      word chain  (.wc)
  • *.trivia*     quiz  (.quiz)
  • *.riddle*     guess  (.hint)
┗━━━━━━━━━━━━━┛

┏━ ✦ ROAST ━┓
  • *.roast*      reply to cook them
  • *.pickupline*  (.rizz / .pickup)
  • *.flirt*  ·  *.compliment*
  • *.joke*   ·  *.rate*  ·  *.ship*
┗━━━━━━━━━━━━━┛

   " type 1–9 to move.
     three in a line, or nothing. "

📡 SECURE │ Ω │ PLAYGROUND: ARMED`;

const BUG_PLACEHOLDER_TEXT = `${GROUP_CHANNEL_LINK}

╔════════╦════════╗
        ⚠ EVENTIDE OMEGA
                BUG DOMAIN
╚════════╩════════╝

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
const autoreactSessions = new Map(); // phoneNumber -> { step, awaitingContact } for autoreact config flow
const webPairSessions = new Map(); // phoneNumber -> { code, status, createdAt } for web pairing
const mutedUsers = new Map(); // `${phoneNumber}:${groupJid}` -> Set of muted member jids
const recentMessages = new Map(); // `${phoneNumber}:${remoteJid}:${msgId}` -> message (for antidelete restore)
const antiConfigSessions = new Map(); // phoneNumber -> { step, group } for anti config
const welcomeGoodbyeSessions = new Map(); // phoneNumber -> { step, type } for welcome/goodbye config
const warnConfigSessions = new Map(); // phoneNumber -> warn config poll flow
const msgLogCache = new Map(); // phoneNumber -> slim log object (avoids reread/parse every msg)
const msgLogSaveTimers = new Map();
const tttGames = new Map(); // `${phoneNumber}:${chatJid}` -> live tic-tac-toe game
const tttSetupSessions = new Map(); // phoneNumber -> { step, chat, host, poll keys }
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
// ⚙️ BOT CONFIG STORE (persistent, synced to Supabase)
// Per-phone config: prefix, aliases, identity, toggles. Stored as JSON in the
// session folder so it survives redeploys (the folder is synced to Supabase).
// ──────────────────────────────────────────────
const DEFAULT_BOT_CONFIG = {
    prefix: '.',
    aliases: {},            // trigger (lowercase, no prefix) -> target command (with prefix)
    name: '',               // display name override ('' = leave account name)
    bio: '',                // about/bio override ('' = leave as is)
    autoreact: {
        enabled: false,
        endpoints: { groups: [], channels: [], contacts: [] }
    },
    antidelete: {
        enabled: false,
        endpoints: { groups: [], channels: [], contacts: [] }
    },
    settings: {},           // generic future toggles
    anti: { antilink: {}, antimention: {}, antiforward: {} }   // per-groupId -> 'on'/'off'
};

// Normalize antidelete to the same shape as autoreact. Also migrates the old
// per-group { [jid]: 'on'/'off' } map (and legacy anti.antidelete) into endpoints.
function normalizeAntideleteConfig(parsed) {
    const empty = { enabled: false, endpoints: { groups: [], channels: [], contacts: [] } };
    const raw = parsed?.antidelete;
    if (raw && typeof raw === 'object' && (raw.endpoints || typeof raw.enabled === 'boolean')) {
        return {
            enabled: !!raw.enabled,
            endpoints: {
                groups: Array.isArray(raw.endpoints?.groups) ? [...raw.endpoints.groups] : [],
                channels: Array.isArray(raw.endpoints?.channels) ? [...raw.endpoints.channels] : [],
                contacts: Array.isArray(raw.endpoints?.contacts) ? [...raw.endpoints.contacts] : []
            }
        };
    }
    const legacy = (raw && typeof raw === 'object' ? raw : null) || parsed?.anti?.antidelete || {};
    const groups = Object.entries(legacy)
        .filter(([k, v]) => v === 'on' && typeof k === 'string' && k.includes('@'))
        .map(([k]) => k);
    return { enabled: groups.length > 0, endpoints: { groups, channels: [], contacts: [] } };
}

function normalizeWarnConfig(parsed) {
    const groups = {};
    const rawGroups = parsed?.warn?.groups;
    if (rawGroups && typeof rawGroups === 'object') {
        for (const [jid, g] of Object.entries(rawGroups)) {
            if (!jid || !g || typeof g !== 'object') continue;
            const max = parseInt(g.maxWarns, 10);
            groups[jid] = {
                enabled: !!g.enabled,
                maxWarns: Number.isFinite(max) ? Math.max(0, max) : 3,
                action: g.action === 'none' ? 'none' : 'kick',
                phrases: Array.isArray(g.phrases) ? g.phrases.map(s => String(s).trim()).filter(Boolean) : [],
                deleteOffending: g.deleteOffending !== false
            };
        }
    }
    return { groups };
}

function loadBotConfig(phoneNumber) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'bot_config.json');
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                ...structuredClone(DEFAULT_BOT_CONFIG),
                ...(parsed || {}),
                aliases: { ...(parsed?.aliases || {}) },
                autoreact: { ...DEFAULT_BOT_CONFIG.autoreact, ...(parsed?.autoreact || {}), endpoints: { ...DEFAULT_BOT_CONFIG.autoreact.endpoints, ...(parsed?.autoreact?.endpoints || {}) } },
                antidelete: normalizeAntideleteConfig(parsed),
                warn: normalizeWarnConfig(parsed)
            };
        }
    } catch (err) {
        logError('CONFIG', `${phoneNumber}: Failed to load bot_config.json`, err);
    }
    return structuredClone(DEFAULT_BOT_CONFIG);
}

function saveBotConfig(phoneNumber, config) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'bot_config.json');
    try {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
        if (isSupabaseEnabled()) {
            const authDir = path.join(AUTH_DIR, phoneNumber);
            debouncedSyncLocalToSupabase(phoneNumber, authDir);
        }
    } catch (err) {
        logError('CONFIG', `${phoneNumber}: Failed to save bot_config.json`, err);
    }
}

function getAntideleteState(phoneNumber) {
    return normalizeAntideleteConfig(loadBotConfig(phoneNumber));
}

function saveAntideleteState(phoneNumber, ad) {
    const cfg = loadBotConfig(phoneNumber);
    cfg.antidelete = {
        enabled: !!ad.enabled,
        endpoints: {
            groups: [...(ad.endpoints?.groups || [])],
            channels: [...(ad.endpoints?.channels || [])],
            contacts: [...(ad.endpoints?.contacts || [])]
        }
    };
    if (cfg.anti?.antidelete) delete cfg.anti.antidelete;
    saveBotConfig(phoneNumber, cfg);
}

function listAntideleteEndpoints(ad) {
    const g = ad.endpoints?.groups || [];
    const c = ad.endpoints?.channels || [];
    const ct = ad.endpoints?.contacts || [];
    const rows = [
        ...g.map(e => ({ type: 'GROUP', v: e })),
        ...c.map(e => ({ type: 'CHANNEL', v: e })),
        ...ct.map(e => ({ type: 'CONTACT', v: e }))
    ];
    let list = '';
    let n = 1;
    if (g.length) {
        list += `  ─ *GROUPS* ─\n`;
        for (const e of g) list += `   [${n++}] ${e}\n`;
    }
    if (c.length) {
        list += `  ─ *CHANNELS* ─\n`;
        for (const e of c) list += `   [${n++}] ${e}\n`;
    }
    if (ct.length) {
        list += `  ─ *CONTACTS* ─\n`;
        for (const e of ct) list += `   [${n++}] ${e}\n`;
    }
    if (!rows.length) list = '   _no endpoints yet_';
    return { list, rows };
}

function antideleteWatchesChat(ad, remoteJid) {
    if (!ad?.enabled || !remoteJid) return false;
    if (isIgnoredRemoteJid(remoteJid)) return false;
    const eps = ad.endpoints || { groups: [], channels: [], contacts: [] };
    if (remoteJid.endsWith('@g.us')) return (eps.groups || []).includes(remoteJid);
    if (remoteJid.endsWith('@newsletter')) {
        return (eps.channels || []).some(ch => {
            const s = String(ch || '');
            return s === remoteJid || (s && (s.includes(remoteJid) || remoteJid.includes(s)));
        });
    }
    if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) {
        const digits = String(remoteJid).split('@')[0].replace(/\D/g, '');
        const norm = jidNormalizedUser(remoteJid);
        return (eps.contacts || []).some(c => {
            const raw = String(c || '');
            const cd = raw.replace(/\D/g, '');
            return raw === remoteJid || raw === norm || (cd && cd === digits);
        });
    }
    return false;
}

function extractRevokeRef(key, update) {
    const proto = update?.message?.protocolMessage;
    const t = proto?.type;
    if (t === 14 || t === 'MESSAGE_EDIT') return null;
    if ((t === 0 || t === 'REVOKE') && proto?.key) return proto.key;
    if (update?.protocolMessageKey) return update.protocolMessageKey;
    if (update?.messageStubType === 1 || update?.messageStubType === 21) return proto?.key || key;
    if (String(key?.id || '').startsWith('REVOKE_')) return proto?.key || update?.protocolMessageKey || key;
    return null;
}

async function recoverDeletedContent(refKey) {
    let deletedContent = null;
    try { deletedContent = await getMessageFromStore(refKey); } catch (_) {}
    if (!deletedContent && refKey?.id) {
        for (const [, v] of recentMessages) {
            if (v?.key?.id === refKey.id && v?.message) { deletedContent = v.message; break; }
        }
        if (!deletedContent) {
            for (const [k, v] of recentMessages) {
                if (k.endsWith(':' + refKey.id) && v?.message) { deletedContent = v.message; break; }
            }
        }
    }
    return deletedContent;
}

async function handleAntideleteRevoke(sock, phoneNumber, eventKey, refKey) {
    const chatJid = refKey?.remoteJid || eventKey?.remoteJid;
    if (!chatJid) return;
    const ad = getAntideleteState(phoneNumber);
    if (!antideleteWatchesChat(ad, chatJid)) return;

    const deletedContent = await recoverDeletedContent(refKey || eventKey);
    const deletedBy = eventKey?.participant
        ? eventKey.participant.split('@')[0]
        : (eventKey?.remoteJid ? eventKey.remoteJid.split('@')[0] : 'unknown');
    const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    const ownerChat = myJid || chatJid;
    const where = chatJid.endsWith('@g.us') ? 'a group' : chatJid.endsWith('@newsletter') ? 'a channel' : 'a chat';

    if (deletedContent) {
        const fakeMsg = {
            key: {
                remoteJid: chatJid,
                id: refKey?.id || eventKey.id,
                participant: eventKey.participant,
                fromMe: false
            },
            message: deletedContent
        };
        await sock.sendMessage(ownerChat, { forward: fakeMsg }).catch(() => {});
    }
    await sock.sendMessage(ownerChat, {
        text: `⚠️ *ANTIDELETE*\n\nA message was deleted in ${where}.\n\n🗑️ *Chat*: ${chatJid}\n👤 *Deleted by*: +${deletedBy}\n${deletedContent ? '\n_Forwarded the deleted message above._' : '\n_Original content could not be recovered._'}`
    }).catch(() => {});
    log('ANTIDELETE', `${phoneNumber}: forwarded deleted msg from ${chatJid} to owner`);
}

// ──────────────────────────────────────────────
// 📼 PERSISTENT MESSAGE LOG (for antidelete full-history recovery)
// Stores every message (by id) that flows through the bot after pairing, so a
// message deleted later can always be recovered — even after a bot restart.
// Stored per-session in msg_log.json. NOT synced to Supabase (it was blowing
// Render RAM — full proto + 5k entries + rewrite-on-every-msg).
// ──────────────────────────────────────────────
const MSG_LOG_LIMIT = 800;

function slimProto(message) {
    if (!message || typeof message !== 'object') return message || null;
    const out = {};
    for (const [k, v] of Object.entries(message)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { out[k] = v; continue; }
        const cloned = { ...v };
        delete cloned.jpegThumbnail;
        delete cloned.thumbnailDirectPath;
        delete cloned.thumbnailSha256;
        delete cloned.scansSidecar;
        delete cloned.midQualityFileSha256;
        delete cloned.waveform;
        if (cloned.contextInfo) {
            cloned.contextInfo = {
                stanzaId: cloned.contextInfo.stanzaId,
                participant: cloned.contextInfo.participant,
                mentionedJid: cloned.contextInfo.mentionedJid,
                isForwarded: cloned.contextInfo.isForwarded
            };
        }
        out[k] = cloned;
    }
    return out;
}

function loadMsgLog(phoneNumber) {
    if (msgLogCache.has(phoneNumber)) return msgLogCache.get(phoneNumber);
    const filePath = path.join(AUTH_DIR, phoneNumber, 'msg_log.json');
    let data = {};
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            data = parsed && typeof parsed === 'object' ? parsed : {};
        }
    } catch (err) { logError('MSGLOG', `${phoneNumber}: failed to load msg_log.json`, err); }
    msgLogCache.set(phoneNumber, data);
    return data;
}

function flushMsgLog(phoneNumber) {
    const log = msgLogCache.get(phoneNumber);
    if (!log) return;
    const filePath = path.join(AUTH_DIR, phoneNumber, 'msg_log.json');
    try {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(log), 'utf8');
    } catch (err) { logError('MSGLOG', `${phoneNumber}: failed to save msg_log.json`, err); }
}

function scheduleMsgLogSave(phoneNumber) {
    if (msgLogSaveTimers.has(phoneNumber)) return;
    const timer = setTimeout(() => {
        msgLogSaveTimers.delete(phoneNumber);
        flushMsgLog(phoneNumber);
    }, 8000);
    msgLogSaveTimers.set(phoneNumber, timer);
}

function logMessage(phoneNumber, remoteJid, msg) {
    try {
        const id = msg?.key?.id;
        if (!id || msg?.key?.fromMe) return;
        const log = loadMsgLog(phoneNumber);
        const keys = Object.keys(log);
        if (keys.length >= MSG_LOG_LIMIT) delete log[keys[0]];
        const parsed = extractMessageText(msg);
        log[id] = {
            remoteJid,
            participant: msg?.key?.participant || null,
            text: parsed?.text || '',
            type: parsed?.leafType || 'unknown',
            message: slimProto(msg?.message),
            ts: msg?.messageTimestamp ? Number(msg.messageTimestamp) : Date.now() / 1000
        };
        scheduleMsgLogSave(phoneNumber);
    } catch (err) { logError('MSGLOG', `${phoneNumber}: logMessage failed`, err); }
}

function getWarnState(phoneNumber) {
    return normalizeWarnConfig(loadBotConfig(phoneNumber));
}

function saveWarnState(phoneNumber, warn) {
    const cfg = loadBotConfig(phoneNumber);
    cfg.warn = normalizeWarnConfig({ warn });
    saveBotConfig(phoneNumber, cfg);
}

function ensureWarnGroup(phoneNumber, groupJid, extra = {}) {
    const warn = getWarnState(phoneNumber);
    warn.groups[groupJid] = {
        enabled: true,
        maxWarns: 3,
        action: 'kick',
        phrases: [],
        deleteOffending: true,
        ...(warn.groups[groupJid] || {}),
        ...extra
    };
    saveWarnState(phoneNumber, warn);
    return warn.groups[groupJid];
}

function loadWarnLog(phoneNumber) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'warn_log.json');
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
    } catch (err) { logError('WARN', `${phoneNumber}: failed to load warn_log.json`, err); }
    return {};
}

function saveWarnLog(phoneNumber, data) {
    const filePath = path.join(AUTH_DIR, phoneNumber, 'warn_log.json');
    try {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    } catch (err) { logError('WARN', `${phoneNumber}: failed to save warn_log.json`, err); }
}

function getUserWarns(phoneNumber, groupJid, userJid) {
    const log = loadWarnLog(phoneNumber);
    const rec = log?.[groupJid]?.[userJid];
    return rec && typeof rec === 'object' ? rec : { count: 0, history: [] };
}

function setUserWarns(phoneNumber, groupJid, userJid, rec) {
    const log = loadWarnLog(phoneNumber);
    if (!log[groupJid]) log[groupJid] = {};
    if (!rec || rec.count <= 0) delete log[groupJid][userJid];
    else {
        rec.history = Array.isArray(rec.history) ? rec.history.slice(-12) : [];
        log[groupJid][userJid] = rec;
    }
    saveWarnLog(phoneNumber, log);
}

function listGroupWarns(phoneNumber, groupJid) {
    const log = loadWarnLog(phoneNumber);
    const bucket = log?.[groupJid] || {};
    return Object.entries(bucket)
        .filter(([, v]) => v && v.count > 0)
        .sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHasPhrase(text, phrase) {
    const p = String(phrase || '').trim();
    if (!p || !text) return false;
    if (p.length <= 3) {
        try { return new RegExp(`(^|[^a-z0-9])${escapeRegExp(p)}([^a-z0-9]|$)`, 'i').test(text); }
        catch { return String(text).toLowerCase().includes(p.toLowerCase()); }
    }
    return String(text).toLowerCase().includes(p.toLowerCase());
}

function findMatchingPhrase(text, phrases) {
    for (const p of (phrases || [])) {
        if (textHasPhrase(text, p)) return p;
    }
    return null;
}

function findHidetagTrigger(normalized, prefix, aliases) {
    const pfx = prefix || '.';
    const triggers = new Set(['.hidetag', '.ht', `${pfx}hidetag`, `${pfx}ht`]);
    for (const [k, v] of Object.entries(aliases || {})) {
        if (v === '.hidetag' || v === '.ht') {
            triggers.add('.' + k);
            triggers.add(pfx + k);
        }
    }
    const parts = String(normalized || '').split(/\s+/).filter(Boolean);
    const idx = parts.findIndex(part => triggers.has(part.toLowerCase()));
    if (idx < 0) return null;
    return { body: [...parts.slice(0, idx), ...parts.slice(idx + 1)].join(' ').trim() };
}

function getQuotedContext(msg) {
    const unwrapped = unwrapMessageContent(msg?.message).message || {};
    return unwrapped.extendedTextMessage?.contextInfo
        || unwrapped.imageMessage?.contextInfo
        || unwrapped.videoMessage?.contextInfo
        || unwrapped.buttonsResponseMessage?.contextInfo
        || msg.message?.extendedTextMessage?.contextInfo
        || null;
}

const TTT_WINS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
];
const TTT_LABELS = [
    '1 · top left', '2 · top', '3 · top right',
    '4 · mid left', '5 · center', '6 · mid right',
    '7 · bot left', '8 · bottom', '9 · bot right'
];

function tttKey(phoneNumber, chatJid) {
    return `${phoneNumber}:${chatJid}`;
}

function tttSamePlayer(a, b) {
    if (!a || !b) return false;
    if (a === 'BOT' || b === 'BOT') return a === b;
    if (jidNormalizedUser(a) === jidNormalizedUser(b)) return true;
    const da = String(a).split('@')[0].replace(/\D/g, '');
    const db = String(b).split('@')[0].replace(/\D/g, '');
    return !!(da && db && da === db);
}

function tttOwnerPn(sock, phoneNumber) {
    const cands = [
        sock?.user?.phoneNumber,
        sock?.authState?.creds?.me?.phoneNumber,
        sock?.user?.id && String(sock.user.id).includes('@s.whatsapp.net') ? sock.user.id : '',
        phoneNumber
    ];
    for (const c of cands) {
        const d = String(c || '').split(':')[0].split('@')[0].replace(/\D/g, '');
        if (d.length >= 7) return d;
    }
    return '';
}

function tttJidDigits(jid) {
    return String(jid || '').split(':')[0].split('@')[0].replace(/\D/g, '');
}

function tttIsLid(jid) {
    return String(jid || '').includes('@lid');
}

function tttIsOwnerJid(sock, phoneNumber, jid) {
    if (!jid || jid === 'BOT') return false;
    if (tttSamePlayer(jid, sock?.user?.id) || tttSamePlayer(jid, sock?.user?.lid) || tttSamePlayer(jid, sock?.user?.phoneNumber)) return true;
    const d = tttJidDigits(jid);
    const own = tttOwnerPn(sock, phoneNumber);
    return !!(d && own && d === own);
}

function tttPnFromMsg(msg) {
    const k = msg?.key || {};
    for (const c of [k.participantAlt, k.remoteJidAlt, k.participantPn, k.senderPn]) {
        if (!c) continue;
        const s = String(c);
        if (s.includes('@lid')) continue;
        const d = s.split(':')[0].split('@')[0].replace(/\D/g, '');
        if (d.length >= 7 && d.length <= 15) return d;
    }
    return '';
}

function tttCollectIds(sock, phoneNumber, jid, msg) {
    const ids = new Set();
    if (jid && jid !== 'BOT') ids.add(jid);
    const k = msg?.key || {};
    for (const c of [k.participant, k.participantAlt, k.remoteJidAlt]) {
        if (c && !String(c).endsWith('@g.us') && !String(c).endsWith('@broadcast')) ids.add(c);
    }
    if (msg?.key?.fromMe || tttIsOwnerJid(sock, phoneNumber, jid)) {
        for (const c of [sock?.user?.id, sock?.user?.lid, sock?.user?.phoneNumber]) {
            if (c) ids.add(c);
        }
        const pn = tttOwnerPn(sock, phoneNumber);
        if (pn) ids.add(pn + '@s.whatsapp.net');
    }
    return [...ids].filter(Boolean);
}

async function tttResolveLabel(sock, phoneNumber, jid, msg) {
    if (!jid || jid === 'BOT') return 'VOID';
    if (msg?.key?.fromMe || tttIsOwnerJid(sock, phoneNumber, jid)) {
        const pn = tttOwnerPn(sock, phoneNumber);
        if (pn) return '+' + pn;
    }
    const fromMsg = tttPnFromMsg(msg);
    if (fromMsg) return '+' + fromMsg;
    if (String(jid).includes('@s.whatsapp.net') || String(jid).includes('@c.us')) {
        const d = tttJidDigits(jid);
        if (d) return '+' + d;
    }
    try {
        const map = sock?.signalRepository?.lidMapping;
        if (map?.getPNForLID && tttIsLid(jid)) {
            const pn = await map.getPNForLID(jid);
            const d = String(pn || '').split(':')[0].split('@')[0].replace(/\D/g, '');
            if (d.length >= 7) return '+' + d;
        }
    } catch (_) {}
    const name = String(msg?.pushName || '').trim();
    if (name && name.toLowerCase() !== 'unknown') return name;
    return 'player';
}

function tttPlayerMatches(game, slot, jid, sock, phoneNumber) {
    if (!game) return false;
    if (game[slot] === 'BOT') return jid === 'BOT';
    const pool = [game[slot], ...(game[slot + 'Ids'] || [])];
    if (pool.some(id => tttSamePlayer(id, jid))) return true;
    if (sock && tttIsOwnerJid(sock, phoneNumber, game[slot]) && tttIsOwnerJid(sock, phoneNumber, jid)) return true;
    return false;
}

function tttName(game, slot) {
    if (!game) return 'player';
    if (game[slot] === 'BOT') return 'VOID';
    const stored = game[slot + 'Label'];
    if (stored) return stored;
    const jid = game[slot];
    if (!jid) return 'open';
    if (String(jid).includes('@s.whatsapp.net') || String(jid).includes('@c.us')) {
        const d = tttJidDigits(jid);
        return d ? '+' + d : 'player';
    }
    return 'player';
}

function tttShort(jid, game, sock, phoneNumber) {
    if (!jid || jid === 'BOT') return 'VOID';
    if (game) {
        if (tttSamePlayer(jid, game.x) && game.xLabel) return game.xLabel;
        if (tttSamePlayer(jid, game.o) && game.oLabel) return game.oLabel;
    }
    if (sock && tttIsOwnerJid(sock, phoneNumber, jid)) {
        const pn = tttOwnerPn(sock, phoneNumber);
        if (pn) return '+' + pn;
    }
    if (String(jid).includes('@s.whatsapp.net') || String(jid).includes('@c.us')) {
        const d = tttJidDigits(jid);
        if (d) return '+' + d;
    }
    if (tttIsLid(jid)) return 'player';
    const d = tttJidDigits(jid);
    return d ? '+' + d : 'player';
}

function tttWinner(board) {
    for (const line of TTT_WINS) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[b] === board[c]) {
            return { mark: board[a], line };
        }
    }
    if (board.every(Boolean)) return { mark: 'DRAW', line: [] };
    return null;
}

function tttMinimax(board, ai, human, isMax) {
    const w = tttWinner(board);
    if (w?.mark === ai) return 10;
    if (w?.mark === human) return -10;
    if (w?.mark === 'DRAW') return 0;
    let best = isMax ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
        if (board[i]) continue;
        board[i] = isMax ? ai : human;
        const score = tttMinimax(board, ai, human, !isMax);
        board[i] = null;
        best = isMax ? Math.max(best, score) : Math.min(best, score);
    }
    return best;
}

function tttBotMove(board, aiMark, difficulty) {
    const empty = [];
    for (let i = 0; i < 9; i++) if (!board[i]) empty.push(i);
    if (!empty.length) return -1;
    const human = aiMark === 'X' ? 'O' : 'X';
    const roll = Math.random();
    if (difficulty === 'easy' && roll < 0.8) return empty[Math.floor(Math.random() * empty.length)];
    if (difficulty === 'medium' && roll < 0.45) return empty[Math.floor(Math.random() * empty.length)];
    let bestScore = -Infinity;
    let best = empty[0];
    for (const i of empty) {
        board[i] = aiMark;
        const score = tttMinimax(board, aiMark, human, false);
        board[i] = null;
        if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
}

function renderTttBoard(game, extra = '') {
    // Exact grid the owner pasted. Do not "fix" spacing.
    const EMPTY = [
        '         1      ',
        '        2      ',
        '        3        ',
        '         4      ',
        '        5      ',
        '       6        ',
        '         7       ',
        '        8      ',
        '        9        '
    ];
    const cell = (i) => {
        const raw = EMPTY[i];
        // Sticker is 2 cols on WhatsApp: drop the digit AND two spaces.
        if (game.board[i] === 'X') return raw.replace(String(i + 1) + '  ', '❌');
        if (game.board[i] === 'O') return raw.replace(String(i + 1) + '  ', '⭕');
        return raw;
    };
    const win = tttWinner(game.board);
    const xName = tttName(game, 'x');
    const oName = tttName(game, 'o');
    const oLine = game.difficulty ? (oName + '  ·  ' + String(game.difficulty).toUpperCase()) : oName;
    const turnMark = game.turn === 'X' ? '❌' : '⭕';
    const turnName = game.turn === 'X' ? xName : oName;
    let footer;
    if (game.status === 'pending') {
        footer = '   waiting for accept…';
    } else if (win?.mark === 'DRAW') {
        footer = '   ●  draw. the grid holds.';
    } else if (win?.mark) {
        const champ = win.mark === 'X' ? xName : oName;
        footer = '   ●  ' + (win.mark === 'X' ? '❌' : '⭕') + '  ' + champ + '  wins';
    } else {
        footer = (
            '   ●  ' + turnMark + '  ' + turnName + '  to move\n' +
            '   reply to THIS board with 1–9\n' +
            '   1 min a turn'
        );
    }
    const note = extra ? ('\n' + String(extra).replace(/^\n+/, '')) : '';

    return (
        '      ✦ EVENTIDE ARENA ✦\n' +
        '         TIC · TAC · TOE\n' +
        '\n' +
        '╭──────┬──────┬──────╮\n' +
        '│' + cell(0) + '│' + cell(1) + '│' + cell(2) + '│\n' +
        '├──────┼──────┼──────┤\n' +
        '│' + cell(3) + '│' + cell(4) + '│' + cell(5) + '│ ├──────┼──────┼──────┤\n' +
        '│' + cell(6) + '│' + cell(7) + '│' + cell(8) + '│\n' +
        '╰──────┴──────┴──────╯\n' +
        '\n' +
        '❌  ' + xName + '\n' +
        '⭕  ' + oLine + '\n' +
        '\n' +
        footer +
        note
    );
}

function getTttGame(phoneNumber, chatJid) {
    return tttGames.get(tttKey(phoneNumber, chatJid)) || null;
}

function tttClearTimer(game) {
    if (game?.timer) { clearTimeout(game.timer); game.timer = null; }
    if (game?.idleTimer) { clearTimeout(game.idleTimer); game.idleTimer = null; }
}

async function tttDeletePoll(sock, game) {
    if (!game?.pollKey) return;
    try { await sock.sendMessage(game.pollKey.remoteJid || game.chatJid, { delete: game.pollKey }); } catch (_) {}
    game.pollKey = null;
}

async function tttDeleteVotedPoll(sock, remoteJid, pollId) {
    if (!pollId) return;
    try { await sock.sendMessage(remoteJid, { delete: { remoteJid, id: pollId, fromMe: true } }); } catch (_) {}
}

function tttIsReplyToBoard(msg, game) {
    if (!game?.boardKey?.id) return false;
    const ctx = getQuotedContext(msg);
    const qid = ctx?.stanzaId || ctx?.quotedMessage?.key?.id || null;
    return !!(qid && qid === game.boardKey.id);
}

async function tttPaint(sock, phoneNumber, game, { extra = '', rematch = false } = {}) {
    const body = renderTttBoard(game, extra);
    try {
        if (game.boardKey?.id) {
            await sock.sendMessage(game.chatJid, { text: body, edit: game.boardKey });
            log('TTT', `${phoneNumber}: edited board ${game.boardKey.id}`);
        } else {
            const sent = await sock.sendMessage(game.chatJid, { text: body });
            game.boardKey = sent?.key || null;
            log('TTT', `${phoneNumber}: sent fresh board ${game.boardKey?.id || 'none'}`);
        }
    } catch (err) {
        logError('TTT', `${phoneNumber}: board edit failed, sending new card`, err);
        const sent = await sock.sendMessage(game.chatJid, { text: body });
        game.boardKey = sent?.key || null;
    }
    await tttDeletePoll(sock, game);
    if ((rematch || tttWinner(game.board)) && game.status === 'done') {
        const poll = await sendMenuPoll(sock, game.chatJid, phoneNumber, 'ARENA', ['Rematch', 'Leave the grid'], ['ttt_again', 'ttt_close']);
        game.pollKey = poll?.key || null;
    }
}

function tttArmTimer(sock, phoneNumber, game) {
    if (game?.timer) { clearTimeout(game.timer); game.timer = null; }
    if (!game || game.status !== 'active') return;
    game.timer = setTimeout(async () => {
        const live = getTttGame(phoneNumber, game.chatJid);
        if (!live || live !== game || live.status !== 'active') return;
        live.status = 'done';
        const sleeper = live.turn === 'X' ? live.x : live.o;
        tttClearTimer(live);
        await tttPaint(sock, phoneNumber, live, {
            extra: `\n⏳ *1 MIN.* ${sleeper === 'BOT' ? 'VOID' : tttShort(sleeper)} froze. Forfeit.`,
            rematch: true
        });
    }, 60 * 1000);
}

function tttArmDeadGame(sock, phoneNumber, game, ms = 3 * 60 * 1000) {
    if (game?.idleTimer) { clearTimeout(game.idleTimer); game.idleTimer = null; }
    game.idleTimer = setTimeout(async () => {
        const live = getTttGame(phoneNumber, game.chatJid);
        if (!live || live !== game) return;
        if (live.status === 'active' && (live.moveCount || 0) > 0) return;
        tttClearTimer(live);
        await tttDeletePoll(sock, live);
        tttGames.delete(tttKey(phoneNumber, live.chatJid));
        await sock.sendMessage(live.chatJid, {
            text: buildOmegaTerminal(
                `   ░▒▓█ *ARENA_DIED* █▓▒░\n\n` +
                `   3 minutes. Nobody played.\n` +
                `   The grid went dark.`
            )
        }).catch(() => {});
    }, ms);
}

async function tttStart(sock, phoneNumber, chatJid, { x, o, vsBot = false, difficulty = 'medium', xLabel = '', oLabel = '', xIds = [], oIds = [], boardKey = null } = {}) {
    const prev = getTttGame(phoneNumber, chatJid);
    if (prev) { tttClearTimer(prev); await tttDeletePoll(sock, prev); }
    if (x !== 'BOT' && !xLabel) xLabel = await tttResolveLabel(sock, phoneNumber, x, null);
    if (o !== 'BOT' && !oLabel) oLabel = await tttResolveLabel(sock, phoneNumber, o, null);
    if (x === 'BOT') xLabel = 'VOID';
    if (o === 'BOT') oLabel = 'VOID';
    const game = {
        chatJid, x, o, vsBot, difficulty: vsBot ? difficulty : '',
        xLabel, oLabel,
        xIds: x === 'BOT' ? [] : [...new Set((xIds || []).filter(Boolean))],
        oIds: o === 'BOT' ? [] : [...new Set((oIds || []).filter(Boolean))],
        board: Array(9).fill(null),
        turn: 'X',
        status: 'active',
        boardKey: boardKey || null,
        pollKey: null,
        timer: null,
        idleTimer: null,
        moveCount: 0,
        openSeat: false,
        startedAt: Date.now()
    };
    tttGames.set(tttKey(phoneNumber, chatJid), game);
    await tttPaint(sock, phoneNumber, game);
    tttArmTimer(sock, phoneNumber, game);
    tttArmDeadGame(sock, phoneNumber, game);
    if (vsBot && game.x === 'BOT') await tttPlayBot(sock, phoneNumber, game);
    return game;
}

async function tttPlayBot(sock, phoneNumber, game) {
    if (!game.vsBot || game.status !== 'active') return;
    const botMark = game.x === 'BOT' ? 'X' : 'O';
    if (game.turn !== botMark) return;
    await delay(700 + Math.floor(Math.random() * 800));
    const idx = tttBotMove(game.board, botMark, game.difficulty || 'medium');
    if (idx < 0) return;
    game.board[idx] = botMark;
    game.moveCount = (game.moveCount || 0) + 1;
    if (game.idleTimer) { clearTimeout(game.idleTimer); game.idleTimer = null; }
    const win = tttWinner(game.board);
    if (win) {
        game.status = 'done';
        tttClearTimer(game);
        await tttPaint(sock, phoneNumber, game, { rematch: true });
        return;
    }
    game.turn = botMark === 'X' ? 'O' : 'X';
    await tttPaint(sock, phoneNumber, game);
    tttArmTimer(sock, phoneNumber, game);
}

async function tttTryMove(sock, phoneNumber, chatJid, playerJid, idx, msg = null) {
    const game = getTttGame(phoneNumber, chatJid);
    if (!game || game.status !== 'active') {
        await sock.sendMessage(chatJid, { text: '❌ No live arena here. Type *.ttt* to open one.' });
        return;
    }
    if (idx < 0 || idx > 8 || game.board[idx]) {
        await sock.sendMessage(chatJid, { text: '❌ That cell is sealed. Pick an open number.' });
        return;
    }
    const slot = game.turn === 'X' ? 'x' : 'o';
    const expected = game[slot];
    if (expected === 'BOT') return;
    const who = (!playerJid || playerJid === 'me') ? (sock.user?.id || sock.user?.phoneNumber || '') : playerJid;
    if (!tttPlayerMatches(game, slot, who, sock, phoneNumber) && !tttPlayerMatches(game, slot, playerJid, sock, phoneNumber)) {
        await sock.sendMessage(chatJid, { text: `⏳ Not your turn. Waiting on ${tttName(game, slot)}.` });
        return;
    }
    game.board[idx] = game.turn;
    game.moveCount = (game.moveCount || 0) + 1;
    if (game.idleTimer) { clearTimeout(game.idleTimer); game.idleTimer = null; }
    if (msg) {
        const fresh = await tttResolveLabel(sock, phoneNumber, who, msg);
        if (fresh && fresh !== 'player') game[slot + 'Label'] = fresh;
        const more = tttCollectIds(sock, phoneNumber, who, msg);
        game[slot + 'Ids'] = [...new Set([...(game[slot + 'Ids'] || []), ...more])];
    }
    const win = tttWinner(game.board);
    if (win) {
        game.status = 'done';
        tttClearTimer(game);
        await tttPaint(sock, phoneNumber, game, { rematch: true });
        return;
    }
    game.turn = game.turn === 'X' ? 'O' : 'X';
    await tttPaint(sock, phoneNumber, game);
    tttArmTimer(sock, phoneNumber, game);
    if (game.vsBot) await tttPlayBot(sock, phoneNumber, game);
}

async function tttOfferChallenge(sock, phoneNumber, chatJid, challenger, target) {
    if (tttSamePlayer(challenger, target)) {
        await sock.sendMessage(chatJid, { text: '❌ You cannot duel your own shadow.' });
        return;
    }
    const prev = getTttGame(phoneNumber, chatJid);
    if (prev && (prev.status === 'active' || prev.status === 'pending')) {
        await sock.sendMessage(chatJid, { text: '❌ An arena is already open here. *.ttt quit* to fold it.' });
        return;
    }
    const xLabel = await tttResolveLabel(sock, phoneNumber, challenger, null);
    const oLabel = await tttResolveLabel(sock, phoneNumber, target, null);
    const game = {
        chatJid, x: challenger, o: target, vsBot: false, difficulty: '',
        xLabel, oLabel,
        xIds: tttCollectIds(sock, phoneNumber, challenger, null),
        oIds: tttCollectIds(sock, phoneNumber, target, null),
        board: Array(9).fill(null), turn: 'X', status: 'pending',
        boardKey: null, pollKey: null, timer: null, idleTimer: null,
        moveCount: 0, openSeat: false, startedAt: Date.now()
    };
    tttGames.set(tttKey(phoneNumber, chatJid), game);
    const card = buildOmegaTerminal(
        `   ░▒▓█ *ARENA_CHALLENGE* █▓▒░\n\n` +
        `   ✦ *HOST* :: ${xLabel}  ❌\n` +
        `   ✦ *INVITED* :: ${oLabel}  ⭕\n\n` +
        `   Only ${oLabel} can sit.\n` +
        `   3 minutes to accept.`
    );
    await sock.sendMessage(chatJid, { text: card, mentions: [target, challenger].filter(j => j && j !== 'BOT') });
    const poll = await sendMenuPoll(sock, chatJid, phoneNumber, 'DUEL', ['Accept', 'Decline'], ['ttt_yes', 'ttt_no']);
    game.pollKey = poll?.key || null;
    tttArmDeadGame(sock, phoneNumber, game, 3 * 60 * 1000);
}

async function tttOpenLobby(sock, phoneNumber, chatJid, host) {
    const prev = getTttGame(phoneNumber, chatJid);
    if (prev && (prev.status === 'active' || prev.status === 'pending')) {
        await sock.sendMessage(chatJid, { text: '❌ An arena is already open here. *.ttt quit* to fold it.' });
        return;
    }
    const xLabel = await tttResolveLabel(sock, phoneNumber, host, null);
    const game = {
        chatJid, x: host, o: null, vsBot: false, difficulty: '',
        xLabel, oLabel: 'open',
        xIds: tttCollectIds(sock, phoneNumber, host, null),
        oIds: [],
        board: Array(9).fill(null), turn: 'X', status: 'pending',
        boardKey: null, pollKey: null, timer: null, idleTimer: null,
        moveCount: 0, openSeat: true, startedAt: Date.now()
    };
    tttGames.set(tttKey(phoneNumber, chatJid), game);
    await sock.sendMessage(chatJid, {
        text: buildOmegaTerminal(
            `   ░▒▓█ *OPEN SEAT* █▓▒░\n\n` +
            `   ✦ *HOST* :: ${xLabel}  ❌\n` +
            `   ✦ *SEAT* :: first soul who claims ⭕\n\n` +
            `   Anyone can sit. First Accept wins.\n` +
            `   3 minutes or the chair vanishes.`
        ),
        mentions: host && host !== 'BOT' ? [host] : []
    });
    const poll = await sendMenuPoll(sock, chatJid, phoneNumber, 'OPEN SEAT', ['Claim seat', 'Cancel (host)'], ['ttt_yes', 'ttt_no']);
    game.pollKey = poll?.key || null;
    tttArmDeadGame(sock, phoneNumber, game, 3 * 60 * 1000);
}

async function isUserGroupAdmin(sock, groupJid, jid) {
    try {
        const meta = await sock.groupMetadata(groupJid);
        const norm = jidNormalizedUser(jid);
        const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
        return !!meta.participants.find(p => {
            const ids = [p.id, p.phoneNumber, p.jid].filter(Boolean).map(jidNormalizedUser);
            if (ids.includes(norm)) return !!p.admin;
            const pd = String(p.id || '').split('@')[0].replace(/\D/g, '');
            return digits && pd === digits && !!p.admin;
        });
    } catch { return false; }
}

async function downloadQuotedMedia(sock, msg) {
    const ctx = getQuotedContext(msg);
    const quoted = ctx?.quotedMessage;
    if (!quoted) throw new Error('Reply to a view-once photo/video first.');

    let inner = quoted;
    if (inner.viewOnceMessage?.message) inner = inner.viewOnceMessage.message;
    else if (inner.viewOnceMessageV2?.message) inner = inner.viewOnceMessageV2.message;
    else if (inner.viewOnceMessageV2Extension?.message) inner = inner.viewOnceMessageV2Extension.message;

    const type = inner.imageMessage ? 'imageMessage'
        : inner.videoMessage ? 'videoMessage'
        : inner.audioMessage ? 'audioMessage'
        : inner.documentMessage ? 'documentMessage'
        : inner.stickerMessage ? 'stickerMessage'
        : null;
    if (!type) throw new Error('Quoted message has no media.');

    const node = { ...inner[type], viewOnce: false };
    const isViewOnce = !!(
        quoted.viewOnceMessage || quoted.viewOnceMessageV2 || quoted.viewOnceMessageV2Extension ||
        inner[type]?.viewOnce
    );

    const full = {
        key: {
            remoteJid: msg.key.remoteJid,
            id: ctx.stanzaId || msg.key.id,
            fromMe: false,
            participant: ctx.participant || msg.key.participant
        },
        message: { [type]: node }
    };

    const opts = { logger: pino({ level: 'silent' }) };
    if (typeof sock.updateMediaMessage === 'function') {
        opts.reuploadRequest = sock.updateMediaMessage.bind(sock);
    }

    try {
        const buffer = await downloadMediaMessage(full, 'buffer', {}, opts);
        if (buffer && buffer.length) return { buffer, type, node, isViewOnce };
    } catch (_) {}

    if (ctx?.stanzaId) {
        const stored = await getMessageFromStore({ id: ctx.stanzaId, remoteJid: msg.key.remoteJid });
        if (stored) {
            const retry = { key: full.key, message: stored };
            const buffer = await downloadMediaMessage(retry, 'buffer', {}, opts);
            if (buffer && buffer.length) return { buffer, type, node, isViewOnce };
        }
    }
    throw new Error('WhatsApp already expired the media keys. Ask them to resend, or reply faster.');
}

async function applyWarn(sock, phoneNumber, { groupJid, targetJid, byJid, reason, auto, originalMsg }) {
    const target = jidNormalizedUser(targetJid);
    if (!target || !groupJid?.endsWith('@g.us')) return;
    const gcfg = getWarnState(phoneNumber).groups[groupJid] || { enabled: true, maxWarns: 3, action: 'kick', phrases: [], deleteOffending: true };
    const rec = getUserWarns(phoneNumber, groupJid, target);
    rec.count = (rec.count || 0) + 1;
    rec.history = rec.history || [];
    rec.history.push({
        reason: String(reason || (auto ? 'auto-phrase' : 'manual')).slice(0, 120),
        by: byJid || 'system',
        at: Date.now(),
        auto: !!auto
    });
    setUserWarns(phoneNumber, groupJid, target, rec);

    const max = Number.isFinite(Number(gcfg.maxWarns)) ? Number(gcfg.maxWarns) : 3;
    const action = gcfg.action === 'none' ? 'none' : 'kick';
    const willKick = action === 'kick' && max > 0 && rec.count >= max;
    const num = target.split('@')[0];
    const byNum = String(byJid || '').split('@')[0].replace(/\D/g, '') || 'system';
    const limitLabel = max > 0 ? `${rec.count}/${max}` : `${rec.count}/∞`;

    if (auto && gcfg.deleteOffending && originalMsg?.key?.id) {
        await sock.sendMessage(groupJid, {
            delete: { remoteJid: groupJid, id: originalMsg.key.id, participant: originalMsg.key.participant || target }
        }).catch(() => {});
    }

    await sock.sendMessage(groupJid, {
        text: buildOmegaTerminal(
            `   ░▒▓█ *WARN_MARK* █▓▒░\n\n` +
            `   ✦ *TARGET* :: @${num}\n` +
            `   ✦ *STRIKES* :: ${limitLabel}\n` +
            `   ✦ *REASON* :: ${reason || (auto ? 'forbidden phrase' : 'manual')}\n` +
            `   ✦ *BY* :: ${auto ? 'AUTO_WARD' : '+' + byNum}\n` +
            `   ✦ *NEXT* :: ${willKick ? 'KICK' : (action === 'none' ? 'WARN_ONLY' : (max > 0 ? `${Math.max(0, max - rec.count)} LEFT` : 'NO_LIMIT'))}\n\n` +
            (willKick
                ? `   " The limit is reached.\n     The vessel is cast out. "`
                : `   " Another mark on the record.\n     Walk carefully. "`)
        ),
        mentions: [target]
    }).catch(() => {});

    if (willKick) {
        try {
            await sock.groupParticipantsUpdate(groupJid, [target], 'remove');
            setUserWarns(phoneNumber, groupJid, target, { count: 0, history: [] });
            await sock.sendMessage(groupJid, {
                text: buildOmegaTerminal(
                    `   ░▒▓█ *WARN_LIMIT* █▓▒░\n\n` +
                    `   ✦ *TARGET* :: @${num}\n` +
                    `   ✦ *ACTION* :: KICKED\n` +
                    `   ✦ *STRIKES* :: ${limitLabel}\n\n` +
                    `   " Three shadows too many. "`
                ),
                mentions: [target]
            }).catch(() => {});
        } catch (err) {
            await sock.sendMessage(groupJid, { text: `⚠️ Warn limit reached but I could not kick @${num}. Make me admin.\n${err?.message || err}` , mentions: [target] }).catch(() => {});
        }
    }
    log('WARN', `${phoneNumber}: warned ${target} in ${groupJid} (${limitLabel}) reason=${reason}`);
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

async function callGemini(prompt, systemInstruction = '', apiKey, opts = {}) {
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest"; // Optimized: default to gemini-flash-latest
    const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = JSON.stringify({
        system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature }
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

async function callOpenAI(prompt, systemInstruction = '', apiKey, opts = {}) {
    const url = `https://api.openai.com/v1/chat/completions`;
    const messages = [];
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });
    const body = JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4
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

async function callPollinations(prompt, systemInstruction = '', opts = {}) {
    const encodedPrompt = encodeURIComponent(prompt);
    const systemParam = systemInstruction ? `&system=${encodeURIComponent(systemInstruction)}` : '';
    const temp = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
    const url = `https://text.pollinations.ai/${encodedPrompt}?model=openai${systemParam}&temperature=${temp}`;

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

export async function callUniversalAI(prompt, systemInstruction = '', opts = {}) {
    const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
    if (GEMINI_KEY && GEMINI_KEY.length > 5) {
        try {
            log('AI', 'Attempting Gemini AI response...');
            return await callGemini(prompt, systemInstruction, GEMINI_KEY, opts);
        } catch (err) {
            logError('AI', 'Gemini AI failed, trying fallback...', err);
        }
    }

    const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
    if (OPENAI_KEY && OPENAI_KEY.length > 5) {
        try {
            log('AI', 'Attempting OpenAI response...');
            return await callOpenAI(prompt, systemInstruction, OPENAI_KEY, opts);
        } catch (err) {
            logError('AI', 'OpenAI failed, trying fallback...', err);
        }
    }

    try {
        log('AI', 'Attempting Pollinations AI keyless fallback...');
        return await callPollinations(prompt, systemInstruction, opts);
    } catch (err) {
        logError('AI', 'Pollinations AI failed', err);
        throw new Error('All AI providers and fallbacks failed to respond.');
    }
}

function parseScoredAi(raw) {
    const text = String(raw || '').trim();
    const scoreMatch = text.match(/SCORE\s*:\s*(\d{1,2})/i);
    const bodyMatch = text.match(/(?:ROAST|LINE|JOKE|TEXT|ANSWER)\s*:\s*([\s\S]*?)(?:\n\s*SCORE\s*:|$)/i);
    const score = scoreMatch ? Math.min(10, parseInt(scoreMatch[1], 10)) : 0;
    let body = (bodyMatch ? bodyMatch[1] : text).trim();
    body = body.replace(/^["'`]+|["'`]+$/g, '').replace(/^\*+|\*+$/g, '').trim();
    return { body, score };
}

async function generateScoredFun(prompt, system, { minScore = 7, tries = 3, temperature = 0.95 } = {}) {
    let best = { body: '', score: 0 };
    for (let i = 0; i < tries; i++) {
        const raw = await callUniversalAI(prompt, system, { temperature });
        const parsed = parseScoredAi(raw);
        if (parsed.body && parsed.score >= best.score) best = parsed;
        if (parsed.body && parsed.body.length >= 12 && parsed.score >= minScore) return parsed;
        log('FUN', `scored ${parsed.score}/10 — dropping, retry ${i + 1}/${tries}`);
    }
    if (best.body && best.score >= minScore) return best;
    if (best.body) return best;
    throw new Error('AI returned empty fun text');
}

function funRoastSystem() {
    return `You are Eventide Omega, a roast assassin in a WhatsApp group. You write the kind of roast that makes the whole chat go "oooooh" and the victim mute the group for 10 minutes.

RULES:
- Savage, specific, funny. Punch with wit. Sound like a sharp West African group chat, not a Twitter bot.
- Nigerian/Pidgin slang is allowed when it hits (e.g. "this one no get sense", "your village people are tired").
- NO racial, religious, or homophobic slurs. No sexual violence. No attacking disabilities. No telling anyone to die.
- If they quoted a message, the roast MUST use that exact message as the weapon. Quote a fragment, then destroy it.
- 2 to 5 short lines. No hashtags. No intro like "here's a roast". No apology. No emojis except maybe one.
- Rate yourself honestly 1-10. 7+ means people would screenshot it. A generic "you're ugly" is a 3. A roast that uses their own words against them is an 8-10.

OUTPUT EXACTLY:
ROAST: <the roast>
SCORE: <number>`;
}

function getHelpSystemPrompt() {
    return `You are "Eventide Omega", an advanced, highly sophisticated, yet friendly and casual AI Customer Care Assistant for the Eventide Omega WhatsApp bot.
CRITICAL INSTRUCTION FOR DEEP THINKING: Before answering, always perform a deep step-by-step internal logical analysis. Break down the user's question, analyze their exact intent (even if they made typos), search your database of available commands, and formulate the most precise, helpful, and logical solution. Think thoroughly before you write your reply.

Tone and Behavioural Nuances:
- Your tone should be extremely casual, helpful, reassuring, and conversational (e.g. use "oh, I get you!", "don't worry, we got you covered!").
- When asked about a feature, explains things step-by-step using WhatsApp bullet points (•).
- UNKNOWN / FUTURE COMMAND RULE: If a user asks about a command or feature that is not currently built into the bot (e.g. any downloaders or features not in the active registry), you must politely let them know that this specific command is not available currently. However, tell them they can let the main developer Patrick Dev know about their amazing suggestion or idea by simply typing the ".dev" command! Keep it extremely encouraging and casual. Games ARE built: .ttt .hangman .chain .trivia .riddle.

Key Information about the bot's active command registry:
- To see the main menu, type ".menu". It triggers a premium animated loading bar sequence and presents active menu polls.
- The bot supports several administrative group commands:
  1. ".join <link>": Joins a group via a WhatsApp invite link.
  2. ".add <number>": Adds a member to the group (sender must be admin, bot must be admin).
  3. ".kick <number/reply/mention>": Removes a participant from the group (supports replying to their message, tagging them, or entering their number).
  4. ".link": Generates and sends the current group invite link.
- Games (tell the user to reply to the game card, not type loose chat):
  1. ".ttt" — tic-tac-toe vs bot (easy/medium/hard) or vs a human. Reply to the board with 1-9.
  2. ".hangman" (alias .hm) — guess letters. Solo or open. Reply to the gallows.
  3. ".chain" (alias .wc) — word chain. Reply to the card with a word starting with the last letter.
  4. ".trivia" (alias .quiz) — poll quiz, 5 or 10 questions.
  5. ".riddle" — first correct wins. ".hint" for a clue.
- Fun: ".roast", ".pickupline", ".joke", ".flirt", ".compliment", ".rate", ".ship"
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
            desc: "Here is the complete registry of all active systems built into Eventide Omega:\n\n" +
                  "*⚙️ CONFIG:*\n" +
                  "• *.mode public/owner* — Privacy access lock\n" +
                  "• *.public* / *.owner* — Shortcut mode toggles\n" +
                  "• *.setprefix <char>* — Change command prefix\n" +
                  "• *.setalias <t> <cmd>* / *.delalias* / *.aliases* — Command aliases\n" +
                  "• *.setname <name>* — Rename the account\n" +
                  "• *.setbio <text>* — Set account bio\n" +
                  "• *.setpp* — Set account profile pic (reply to image)\n" +
                  "• *.settings* — View config matrix\n" +
                  "• *.reset* — Reset config\n" +
                  "• *.autoreactconfig* — Configure auto-react\n" +
                  "• *.antidelete on/off* — Recover deleted messages\n" +
                  "• *.antideleteconfig* — Add/remove antidelete chats\n\n" +
                  "*🖥️ SYSTEM:*\n" +
                  "• *.ping* / *.uptime* / *.runtime* / *.info* / *.status* — Status\n" +
                  "• *.version* / *.os* / *.botinfo* / *.alive* — About & health\n" +
                  "• *.dev* — The architect\n" +
                  "• *.gpp* / *.ggpp* — Profile pics\n" +
                  "• *.profile* — Host identity\n" +
                  "• *.listgc* / *.session* / *.sessions* — Groups & sessions\n" +
                  "• *.logout* / *.reconnect* — Session control\n" +
                  "• *.sticker* / *.toimg* / *.vv* — Sticker + unlock view-once\n" +
                  "• *.qr* / *.calc* / *.base64* — Utilities\n" +
                  "• *.block* / *.unblock* — Block management\n" +
                  "• *.restart* / *.shutdown* — Reboot / power\n" +
                  "• *.autoreact on/off* — Auto-reaction\n" +
                  "• *.antidelete on/off* — Anti-delete\n\n" +
                  "*🎮 GAMES:*\n" +
                  "• *.ttt* — tic-tac-toe (bot 3 levels / human)\n" +
                  "• *.hangman* / *.hm* — gallows\n" +
                  "• *.chain* / *.wc* — word chain\n" +
                  "• *.trivia* / *.quiz* — poll quiz\n" +
                  "• *.riddle* / *.hint* — first correct wins\n\n" +
                  "*🎲 FUN:*\n" +
                  "• *.roast* / *.pickupline* / *.rizz*\n" +
                  "• *.joke* / *.flirt* / *.compliment* / *.rate* / *.ship*\n\n" +
                  "*👥 GROUP:*\n" +
                  "• *.join <link>* — Join a group\n" +
                  "• *.add <number>* — Add member\n" +
                  "• *.kick <user>* — Remove member\n" +
                  "• *.hidetag* / *.ht* — silent mention\n" +
                  "• *.warn* / *.warnconfig* — strike system\n" +
                  "• *.link* — Get group invite link\n\n" +
                  "💡 *Tip*: Use *.menu* to open the menu, or type *.help hangman* (or trivia, ttt, riddle, chain) for specifics."
        };
    }

    if (q.includes("hangman") || q === "hm") {
        return {
            title: "Hangman (.hangman / .hm)",
            desc: "Guess the word. 6 misses and they hang.\n\n" +
                  "• *.hangman* — Solo or Open, then pick a word bag\n" +
                  "• *Reply to the gallows* with a letter or the full word\n" +
                  "• Loose letters in chat are ignored\n" +
                  "• 90s of silence and they hang\n" +
                  "• *.hangman quit*"
        };
    }
    if (q.includes("chain") || q.includes("wordchain") || q === "wc") {
        return {
            title: "Word Chain (.chain / .wc)",
            desc: "Next word must start with the last letter.\n\n" +
                  "• *.chain* — I open with a word\n" +
                  "• *Reply to the card* with a 3+ letter word in the lexicon\n" +
                  "• No repeats · 60s or the chain snaps\n" +
                  "• *.chain quit*"
        };
    }
    if (q.includes("trivia") || q.includes("quiz")) {
        return {
            title: "Trivia (.trivia / .quiz)",
            desc: "Poll quiz. First vote locks.\n\n" +
                  "• *.trivia* — category, then 5 or 10 questions\n" +
                  "• 25 seconds a question · anyone can vote\n" +
                  "• *.trivia quit*"
        };
    }
    if (q.includes("riddle")) {
        return {
            title: "Riddle (.riddle)",
            desc: "First correct guess wins.\n\n" +
                  "• *.riddle* — I pose one\n" +
                  "• *Reply to the riddle* with your answer\n" +
                  "• *.hint* for a clue (2 max)\n" +
                  "• 2 minutes then I reveal\n" +
                  "• *.riddle skip*"
        };
    }
    if (q.includes("vv") || q.includes("viewonce") || q.includes("view-once") || q.includes("view once")) {
        return {
            title: "View-Once Unlock (.vv)",
            desc: "Reply to a view-once photo, video, or voice note to unlock it.\n\n" +
                  "• Reply to the view-once with *.vv* (or *.viewonce*)\n" +
                  "• Owner / Dev only\n" +
                  "• If WhatsApp already expired the media keys, ask them to resend"
        };
    }
    if (q.includes("ttt") || q.includes("tictactoe") || q.includes("tic tac") || q === "xo") {
        return {
            title: "Tic-Tac-Toe (.ttt)",
            desc: "Premium Eventide arena.\n\n" +
                  "• *.ttt* — poll: vs Bot or vs Human\n" +
                  "• Bot → pick Easy / Medium / Hard\n" +
                  "• Human → first Accept sits, or *.ttt @user* / reply to invite one person\n" +
                  "• *Reply to the board* with 1–9 to move (loose numbers are ignored)\n" +
                  "• 1 minute a turn · 3 minutes of nobody playing ends it\n" +
                  "• *.ttt quit* / *.ttt board*"
        };
    }
    if (q.includes("roast") || q.includes("pickup") || q.includes("rizz") || q === "joke" || q.includes("fun cmd")) {
        return {
            title: "Fun Commands (Gemini)",
            desc: "Live-cooked. Nothing is hardcoded.\n\n" +
                  "• *.roast* — reply to a message to cook them with their own words. Only roasts scoring 7/10+ get sent.\n" +
                  "• *.pickupline* / *.rizz* — a line that should actually work\n" +
                  "• *.flirt* / *.compliment* / *.joke*\n" +
                  "• *.rate* — reply to rate that message /10\n" +
                  "• *.ship @a @b* — unholy pairing"
        };
    }
    if (q.includes("hidetag") || q === "ht" || q.includes(".ht")) {
        return {
            title: "Hidetag (.ht)",
            desc: "Silently mention every group member. The @list stays hidden.\n\n" +
                  "💡 *How to use:*\n" +
                  "• *.hidetag good morning*\n" +
                  "• *.ht come online*\n" +
                  "• Put it *anywhere* in the line:  _good morning everyone .ht_\n" +
                  "• Default short form is *.ht*\n\n" +
                  "⚠️ Group admins / owner only."
        };
    }
    if (q.includes("warn")) {
        return {
            title: "Warn System",
            desc: "Premium strike system — reply to warn, or auto-warn on phrases.\n\n" +
                  "• *.warn* reply/mention — add a strike\n" +
                  "• *.unwarn* / *.warnreset* — remove one / wipe\n" +
                  "• *.warns* — ledger or one person's dossier\n" +
                  "• *.warnconfig* — poll matrix: limit, kick vs warn-only, phrases\n\n" +
                  "Set max strikes (or 0 = never kick). Bind words like *see* so anyone who sends them is marked automatically."
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

// No-arg uptime formatter (mirrors phantom-x) using process.uptime().
function runtimeUptime() {
    return formatUptime(process.uptime());
}

// Shared terminal wrapper — exactly matches phantom-x's buildOmegaTerminal.
function buildOmegaTerminal(body) {
    return (
        '╔════════╦════════╗\n' +
        '        ⚠ EVENTIDE OMEGA\n' +
        '               TERMINAL ACCESS                                                                         \n' +
        '╚════════╩════════╝\n\n' +
        body + '\n\n' +
        '— *EVENTIDE OMEGA* · 👁'
    );
}

// Fetch a remote URL as a Buffer (for .gpp / .ggpp profile picture downloads).
// Resolve a target JID from a reply-to message, an @mention, or a raw number.
// Returns a normalized JID or null.
function resolveTargetJid(msg, args) {
    const ctx = getQuotedContext(msg) || msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || null;
    if (ctx?.participant) return jidNormalizedUser(ctx.participant);   // replied message
    if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length) return jidNormalizedUser(ctx.mentionedJid[0]); // @mention
    for (const tok of (args || [])) {
        const digits = tok.replace(/\D/g, '');
        if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
    }
    return null;
}

function extractQuotedPlainText(msg) {
    const ctx = getQuotedContext(msg);
    const quoted = ctx?.quotedMessage;
    if (!quoted) return '';
    const inner = unwrapMessageContent(quoted).message || quoted;
    return (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        ''
    ).trim();
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(new Error('Timeout')); });
    });
}

// Lazy-load optional native deps so the bot boots even if a lib fails to
// install on the host (e.g. sharp native binary). Each returns null on failure.
function loadSharp() { try { return require('sharp'); } catch (_) { return null; } }
function loadQrcode() { try { return require('qrcode'); } catch (_) { return null; } }

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

// Dev numbers come from the RENDER env var DEV_NUMBERS (comma-separated).
// Returns true if the given jid (or raw number) belongs to a dev.
// Count the number of registered dot-commands (for .cmdstats/.botinfo).
function countSystemCommands() {
    const known = [
        'menu','help','ping','uptime','runtime','info','status','version','os','botinfo','alive','dev','gpp','ggpp','profile',
        'listgc','session','sessions','logout','reconnect','sticker','toimg','vv','viewonce','qr','calc','base64','block','unblock',
        'cmdstats','restart','shutdown','autoreact','mode','public','owner','setprefix','setalias','delalias',
        'aliases','setname','setbio','setpp','settings','reset','join','add','kick','link','autoreactconfig','antidelete','antideleteconfig','del','hidetag','ht','warn','unwarn','warns','warnconfig','warnreset','ttt','tictactoe','xo','hangman','chain','trivia','riddle'
    ];
    return known.length;
}

function isDevNumber(jid) {
    const raw = process.env.DEV_NUMBERS || '';
    const devs = raw.split(',').map(s => s.replace(/\D/g, '').trim()).filter(Boolean);
    if (!devs.length) return false;
    const num = String(jid || '').split(':')[0].split('@')[0].replace(/\D/g, '');
    return devs.includes(num);
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

// Decrypt / Retrieve messages from memory map OR local persistent JSON.
// Baileys calls this to fetch a message by reference (e.g. for "delete for
// everyone" — the protocol message carries a reference and Baileys looks up
// the original here so it can emit the delete).
async function getMessageFromStore(key) {
    const inMemory = sentPolls.get(key.id);
    if (inMemory) return inMemory;

    // Look in the recent-messages cache first (this is how antidelete recovers content)
    const cacheKey = `__all__:${key.remoteJid || ''}:${key.id}`;
    for (const [k, v] of recentMessages) {
        if (k.endsWith(':' + key.id) && v?.message) return v.message;
    }

    // Full-history recovery: check the persistent msg_log across all sessions
    for (const number of getStoredSessionDirectories(AUTH_DIR)) {
        const log = loadMsgLog(number);
        if (log[key.id]?.message) return log[key.id].message;
        if (log[key.id]?.text) return { conversation: log[key.id].text };
    }

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
    return COMMANDS[command] || null;
}

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
    // 💡 Flash the bot online before any reply (dot commands, .help, help-mode
    // conversations, etc.), then return to the background presence after ~5 min.
    const flashPhone = sock?._eventidePhone;
    if (flashPhone) flashPresenceOnline(sock, flashPhone);
    try {
        let formattedText = formatForWhatsApp(text);

        // Channel URL sits on its own line so the baked PDV preview card
        // follows text replies. Polls and image messages never go through here.
        if (!formattedText.startsWith('🤖') && !formattedText.includes(GROUP_CHANNEL_LINK)) {
            formattedText = `${GROUP_CHANNEL_LINK}\n\n${formattedText}`;
        }

        try {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const delayMs = Math.min(2700, Math.max(1000, formattedText.length * 15));
            await delay(delayMs);
            await sock.sendPresenceUpdate('paused', remoteJid);
        } catch (presErr) {
            logError('WA-SEND', 'Failed to send presence update', presErr);
        }

        const content = await attachChannelPreview({ text: formattedText });
        await sock.sendMessage(remoteJid, content, quoted ? { quoted } : undefined);
        return true;
    } catch (err) {
        logError('WA-SEND', `Quoted reply failed for ${remoteJid}. Retrying without quote`, err);
        try {
            let formattedText = formatForWhatsApp(text);
            if (!formattedText.startsWith('🤖') && !formattedText.includes(GROUP_CHANNEL_LINK)) {
                formattedText = `${GROUP_CHANNEL_LINK}\n\n${formattedText}`;
            }
            const content = await attachChannelPreview({ text: formattedText });
            await sock.sendMessage(remoteJid, content);
            return true;
        } catch (retryErr) {
            logError('WA-SEND', `Reply failed for ${remoteJid}`, retryErr);
            return false;
        }
    }
}

// ──────────────────────────────────────────────
// 📱 TELEGRAM BOT (OPTIONAL — only initialized if TELEGRAM_TOKEN is set)
// The bot works fully without Telegram via the web pairing page.
// ──────────────────────────────────────────────
let tgBot = null;
if (TELEGRAM_TOKEN) {
    try {
        tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
        tgBot.on('polling_error', err => logError('TELEGRAM', 'Polling error', err));
        log('TELEGRAM', 'Telegram bot initialized (token present).');
    } catch (err) {
        logError('TELEGRAM', 'Failed to init Telegram bot (continuing without it)', err);
        tgBot = null;
    }
} else {
    log('TELEGRAM', 'TELEGRAM_TOKEN not set — Telegram bot disabled. Use the /pair web page instead.');
}

// ──────────────────────────────────────────────
// 🔒 TELEGRAM SEND HELPER
// ──────────────────────────────────────────────
async function safeTgSend(chatId, text) {
    if (!tgBot) return; // Telegram disabled — no-op
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
    if (!tgBot) return false; // Telegram disabled
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
    sock._eventidePhone = phoneNumber; // used by safeWaReply to flash presence

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

                // 💻 Store the code for the web pairing page (and any Telegram chat).
                webPairSessions.set(phoneNumber, { code: pairingCode, status: 'waiting', createdAt: Date.now() });

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
    const isTttPoll = Array.isArray(cached.ids) && cached.ids.some(id => String(id).startsWith('ttt_'));
    const isArenaPoll = isGamePoll(cached.ids);
    if (!isOwnerVote && !isTttPoll && !isArenaPoll) {
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
    if (sock?._eventidePhone) flashPresenceOnline(sock, sock._eventidePhone);
    const secret = crypto.randomBytes(32);
    const pollMsg = await sock.sendMessage(remoteJid, {
        poll: {
            name: question,
            values: options,
            selectableCount: 1,
            messageSecret: secret
        }
    });
    if (!pollMsg?.key?.id) {
        throw new Error('WhatsApp rejected the poll. Try the command again.');
    }

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
    if (sock?._eventidePhone) flashPresenceOnline(sock, sock._eventidePhone);
    try {
        const sent = await sock.sendMessage(remoteJid, {
            image: { url: imagePath },
            caption: formatForWhatsApp(caption)
            // contextInfo: channelContextInfo() // (commented: externalAdReply caused "no proper viewing app" error)
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
            case 'ttt_vs_bot': {
                await tttDeleteVotedPoll(sock, remoteJid, pollId);
                const sess = tttSetupSessions.get(phoneNumber) || { chat: remoteJid, host: sock.user?.id };
                if (voterJid && voterJid !== 'me' && sess.host && !tttSamePlayer(voterJid, sess.host) && !tttSamePlayer(voterJid, sock.user?.id)) {
                    break;
                }
                tttSetupSessions.set(phoneNumber, { ...sess, step: 'diff', chat: remoteJid });
                const diffPoll = await sendMenuPoll(sock, remoteJid, phoneNumber, 'VOID LEVEL', ['Easy', 'Medium', 'Hard'], ['ttt_easy', 'ttt_med', 'ttt_hard']);
                sess.diffPollKey = diffPoll?.key || null;
                tttSetupSessions.set(phoneNumber, { ...sess, step: 'diff', chat: remoteJid, diffPollKey: diffPoll?.key || null });
                break;
            }
            case 'ttt_vs_p': {
                await tttDeleteVotedPoll(sock, remoteJid, pollId);
                const sess = tttSetupSessions.get(phoneNumber) || { chat: remoteJid, host: sock.user?.id };
                const host = sess.host || sock.user?.id;
                if (voterJid && voterJid !== 'me' && sess.host && !tttSamePlayer(voterJid, sess.host) && !tttSamePlayer(voterJid, sock.user?.id)) {
                    break;
                }
                tttSetupSessions.delete(phoneNumber);
                await tttOpenLobby(sock, phoneNumber, remoteJid, host);
                break;
            }
            case 'ttt_easy':
            case 'ttt_med':
            case 'ttt_hard': {
                await tttDeleteVotedPoll(sock, remoteJid, pollId);
                const sess = tttSetupSessions.get(phoneNumber) || {};
                const host = sess.host || sock.user?.id;
                if (voterJid && voterJid !== 'me' && sess.host && !tttSamePlayer(voterJid, sess.host) && !tttSamePlayer(voterJid, sock.user?.id)) {
                    break;
                }
                const diff = votedOptionId === 'ttt_easy' ? 'easy' : votedOptionId === 'ttt_hard' ? 'hard' : 'medium';
                tttSetupSessions.delete(phoneNumber);
                await tttStart(sock, phoneNumber, remoteJid, {
                    x: host,
                    o: 'BOT',
                    vsBot: true,
                    difficulty: diff,
                    xLabel: sess.hostLabel || await tttResolveLabel(sock, phoneNumber, host, null),
                    oLabel: 'VOID',
                    xIds: sess.hostIds || tttCollectIds(sock, phoneNumber, host, null)
                });
                break;
            }
            case 'ttt_yes': {
                await tttDeleteVotedPoll(sock, remoteJid, pollId);
                const game = getTttGame(phoneNumber, remoteJid);
                if (!game || game.status !== 'pending') { await sock.sendMessage(remoteJid, { text: '❌ No open seat.' }); break; }
                const voter = voterJid === 'me' ? sock.user?.id : voterJid;
                if (game.openSeat) {
                    if (tttSamePlayer(voter, game.x)) {
                        await sock.sendMessage(remoteJid, { text: '❌ You already host this grid. Wait for a rival.' });
                        break;
                    }
                    game.o = voter;
                    game.oLabel = await tttResolveLabel(sock, phoneNumber, voter, null);
                    game.oIds = tttCollectIds(sock, phoneNumber, voter, null);
                    game.openSeat = false;
                } else if (!tttSamePlayer(voter, game.o)) {
                    await sock.sendMessage(remoteJid, { text: '❌ This invite is sealed. Only the tagged rival may sit.' });
                    break;
                }
                game.status = 'active';
                tttClearTimer(game);
                game.boardKey = null;
                await tttDeletePoll(sock, game);
                await tttPaint(sock, phoneNumber, game);
                tttArmTimer(sock, phoneNumber, game);
                tttArmDeadGame(sock, phoneNumber, game);
                break;
            }
            case 'ttt_no': {
                await tttDeleteVotedPoll(sock, remoteJid, pollId);
                const game = getTttGame(phoneNumber, remoteJid);
                if (!game || game.status !== 'pending') break;
                const voter = voterJid === 'me' ? sock.user?.id : voterJid;
                const canCancel = tttSamePlayer(voter, game.x) || tttSamePlayer(voter, game.o) || tttSamePlayer(voter, sock.user?.id);
                if (!canCancel) break;
                tttClearTimer(game);
                await tttDeletePoll(sock, game);
                tttGames.delete(tttKey(phoneNumber, remoteJid));
                await sock.sendMessage(remoteJid, { text: '🕊 Seat cancelled. The grid sleeps.' });
                break;
            }
            case 'ttt_again': {
                const game = getTttGame(phoneNumber, remoteJid);
                if (!game) { await sock.sendMessage(remoteJid, { text: '❌ No arena to rematch. *.ttt*' }); break; }
                await tttStart(sock, phoneNumber, remoteJid, {
                    x: game.x, o: game.o, vsBot: game.vsBot, difficulty: game.difficulty || 'medium',
                    xLabel: game.xLabel, oLabel: game.oLabel, xIds: game.xIds || [], oIds: game.oIds || []
                });
                break;
            }
            case 'ttt_close': {
                const game = getTttGame(phoneNumber, remoteJid);
                if (game) { tttClearTimer(game); await tttDeletePoll(sock, game); }
                tttGames.delete(tttKey(phoneNumber, remoteJid));
                await sock.sendMessage(remoteJid, { text: buildOmegaTerminal(`   ✦ *ARENA_CLOSED*\n\n   " The grid forgets. "`) });
                break;
            }
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
                const bugContent = await attachChannelPreview({ text: formatForWhatsApp(BUG_PLACEHOLDER_TEXT) });
                const sent = await sock.sendMessage(remoteJid, bugContent);
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
            case 'ar_add': {
                // Autoreact: choose endpoint category
                autoreactSessions.set(phoneNumber, { step: 'category' });
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINT_CATEGORY* █▓▒░\n\n` +
                    `   Which type of endpoint do\n` +
                    `   you want to auto-react to?`
                ));
                await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ ENDPOINT TYPE ✦', ['👥 Group', '📢 Channel', '👤 Contact'], ['ar_cat_group', 'ar_cat_channel', 'ar_cat_contact']);
                break;
            }
            case 'ar_delete': {
                // Autoreact: list endpoints with indices for deletion via .del
                const cfg = loadBotConfig(phoneNumber).autoreact || { enabled: false, endpoints: { groups: [], channels: [], contacts: [] } };
                const g = cfg.endpoints?.groups || [], c = cfg.endpoints?.channels || [], ct = cfg.endpoints?.contacts || [];
                let n = 1, list = '';
                if (g.length) { list += `  ─ *GROUPS* ─\n`; for (const e of g) list += `   [${n++}] ${e}\n`; }
                if (c.length) { list += `  ─ *CHANNELS* ─\n`; for (const e of c) list += `   [${n++}] ${e}\n`; }
                if (ct.length) { list += `  ─ *CONTACTS* ─\n`; for (const e of ct) list += `   [${n++}] ${e}\n`; }
                if (!n) list = '   _no endpoints yet_';
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINTS* █▓▒░\n\n` +
                    `${list}\n\n` +
                    `   Delete by index: *_.del 2 5 6 9_*`
                ));
                autoreactSessions.set(phoneNumber, { step: 'delete' });
                break;
            }
            case 'ar_cat_group':
            case 'ar_cat_channel':
            case 'ar_cat_contact': {
                const type = votedOptionId.replace('ar_cat_','');
                const cfg = loadBotConfig(phoneNumber).autoreact || { enabled: false, endpoints: { groups: [], channels: [], contacts: [] } };
                if (type === 'contact') {
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *CONTACT_ENDPOINT* █▓▒░\n\n` +
                        `   Send the phone number you want\n` +
                        `   auto-reacted. All messages from it\n` +
                        `   will be reacted to.\n\n` +
                        `   (or type *.cancel* to exit)`
                    ));
                    autoreactSessions.set(phoneNumber, { step: 'awaiting_contact' });
                } else if (type === 'group') {
                    // send a poll of groups the bot is in
                    let groups = [];
                    try { const g = await sock.groupFetchAllParticipating(); groups = Object.values(g).map(x => x.subject || x.id); } catch (_) {}
                    if (!groups.length) { await safeWaReply(sock, remoteJid, '❌ No groups found to add.'); break; }
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(`   Choose a group to auto-react to:`));
                    await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ SELECT GROUP ✦', groups.slice(0,10), groups.slice(0,10).map((_,i)=>'ar_grp_'+i));
                    autoreactSessions.set(phoneNumber, { step: 'group', groups });
                } else if (type === 'channel') {
                    let channels = [];
                    try { const g = await sock.groupFetchAllParticipating(); channels = Object.values(g).map(x => x.subject || x.id); } catch (_) {}
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   📢 Channel selection requires a\n` +
                        `   channel the bot follows. For now,\n` +
                        `   send the channel link/id to add.\n\n` +
                        `   (or type *.cancel* to exit)`
                    ));
                    autoreactSessions.set(phoneNumber, { step: 'awaiting_channel' });
                }
                break;
            }
            case 'greet_welcome':
            case 'greet_goodbye': {
                const gsess = welcomeGoodbyeSessions.get(phoneNumber);
                const gtype = votedOptionId === 'greet_welcome' ? 'welcome' : 'goodbye';
                welcomeGoodbyeSessions.set(phoneNumber, { step: 'action', type: gtype, group: gsess?.group || remoteJid });
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *THRESHOLD_MATRIX* █▓▒░\n\n` +
                    `   Configure the ${gtype}\n` +
                    `   message for this group.`
                ));
                await sendMenuPoll(sock, remoteJid, phoneNumber, gtype === 'welcome' ? '✦ WELCOME MATRIX ✦' : '✦ GOODBYE MATRIX ✦', ['📝 Custom Message', '🎯 Default Message', '🚫 Disable'], gtype === 'welcome' ? ['wg_wel_custom','wg_wel_default','wg_wel_off'] : ['wg_gb_custom','wg_gb_default','wg_gb_off']);
                break;
            }
            case 'wg_wel_custom':
            case 'wg_gb_custom':
            case 'wg_wel_default':
            case 'wg_gb_default':
            case 'wg_wel_off':
            case 'wg_gb_off': {
                const sess = welcomeGoodbyeSessions.get(phoneNumber);
                const type = sess?.type || (votedOptionId.includes('wel') ? 'welcome' : 'goodbye');
                const group = sess?.group || remoteJid;
                const isWel = type === 'welcome';
                const cfg = loadBotConfig(phoneNumber);
                cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'] = cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'] || {};
                if (votedOptionId.endsWith('_off')) {
                    cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'][group] = 'off';
                    saveBotConfig(phoneNumber, cfg);
                    welcomeGoodbyeSessions.delete(phoneNumber);
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ✦ *${isWel ? 'WELCOME' : 'GOODBYE'}* :: DISABLED\n\n   " The threshold falls\n     silent. "`
                    ));
                } else if (votedOptionId.endsWith('_default')) {
                    cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'][group] = 'default';
                    saveBotConfig(phoneNumber, cfg);
                    welcomeGoodbyeSessions.delete(phoneNumber);
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ✦ *${isWel ? 'WELCOME' : 'GOODBYE'}* :: DEFAULT\n\n   " The standard words\n     are restored. "`
                    ));
                } else {
                    // custom -> ask for the message text
                    welcomeGoodbyeSessions.set(phoneNumber, { step: 'custom_text', type, group });
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ✦ *CUSTOM ${isWel ? 'WELCOME' : 'GOODBYE'}*\n\n` +
                        `   Send the ${isWel ? 'welcome' : 'goodbye'} message now.\n` +
                        `   (use *{{name}}* for the member's name)\n\n` +
                        `   or type *.cancel* to exit`
                    ));
                }
                break;
            }
            case 'wn_add':
            case 'wn_cfg':
            case 'wn_remove': {
                const mode = votedOptionId === 'wn_add' ? 'add' : votedOptionId === 'wn_cfg' ? 'cfg' : 'remove';
                let names = [];
                let jids = [];
                try {
                    const g = await sock.groupFetchAllParticipating();
                    if (mode === 'add') {
                        for (const [id, v] of Object.entries(g)) {
                            names.push(v.subject || id);
                            jids.push(id);
                        }
                    } else {
                        const warn = getWarnState(phoneNumber);
                        for (const id of Object.keys(warn.groups || {})) {
                            names.push(g[id]?.subject || id);
                            jids.push(id);
                        }
                    }
                } catch (_) {}
                names = names.slice(0, 10);
                jids = jids.slice(0, 10);
                if (!names.length) {
                    await safeWaReply(sock, remoteJid, mode === 'add' ? '❌ No groups found.' : '❌ No warn groups configured yet. Use Add Group first.');
                    break;
                }
                const prefixId = mode === 'add' ? 'wn_agrp_' : mode === 'cfg' ? 'wn_cgrp_' : 'wn_rgrp_';
                warnConfigSessions.set(phoneNumber, { step: mode, groups: names, jids });
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    mode === 'add' ? `   Choose a group to put under the warn ward:` :
                    mode === 'cfg' ? `   Choose which group's law to reshape:` :
                    `   Choose a group to release from the ward:`
                ));
                await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ SELECT GROUP ✦', names, names.map((_, i) => prefixId + i));
                break;
            }
            case 'wn_limit':
            case 'wn_action':
            case 'wn_phrases':
            case 'wn_resetall':
            case 'wn_on':
            case 'wn_off':
            case 'wn_kick':
            case 'wn_none':
            case 'wn_ph_add':
            case 'wn_ph_del':
            case 'wn_ph_list': {
                const sess = warnConfigSessions.get(phoneNumber);
                const group = sess?.group;
                if (!group) { await safeWaReply(sock, remoteJid, '❌ Warn session expired. Use .warnconfig again.'); break; }
                if (votedOptionId === 'wn_limit') {
                    warnConfigSessions.set(phoneNumber, { step: 'awaiting_limit', group });
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *WARN_LIMIT* █▓▒░\n\n` +
                        `   Send how many warns before kick.\n` +
                        `   Use *0* to never kick.\n\n` +
                        `   (or type *.cancel*)`
                    ));
                    break;
                }
                if (votedOptionId === 'wn_action') {
                    await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ WARN ACTION ✦', ['👢 Kick on limit', '📋 Warn only (no kick)'], ['wn_kick', 'wn_none']);
                    break;
                }
                if (votedOptionId === 'wn_kick' || votedOptionId === 'wn_none') {
                    const action = votedOptionId === 'wn_none' ? 'none' : 'kick';
                    ensureWarnGroup(phoneNumber, group, { action });
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *WARN_ACTION* █▓▒░\n\n` +
                        `   ✦ *ACTION* :: ${action === 'none' ? 'WARN_ONLY' : 'KICK'}\n\n` +
                        `   " The sentence is set. "`
                    ));
                    break;
                }
                if (votedOptionId === 'wn_on' || votedOptionId === 'wn_off') {
                    ensureWarnGroup(phoneNumber, group, { enabled: votedOptionId === 'wn_on' });
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *PHRASE_WARD* █▓▒░\n\n` +
                        `   ✦ *STATE* :: ${votedOptionId === 'wn_on' ? 'ARMED' : 'IDLE'}\n\n` +
                        `   Auto-warn on listed phrases is\n   now ${votedOptionId === 'wn_on' ? 'watching' : 'silent'}.`
                    ));
                    break;
                }
                if (votedOptionId === 'wn_resetall') {
                    const log = loadWarnLog(phoneNumber);
                    delete log[group];
                    saveWarnLog(phoneNumber, log);
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *LEDGER_BURNED* █▓▒░\n\n` +
                        `   All strikes in this group\n   have been wiped.`
                    ));
                    break;
                }
                if (votedOptionId === 'wn_phrases') {
                    await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ PHRASE WARD ✦', ['➕ Add Phrase', '🗑️ Delete Phrase', '📜 List Phrases'], ['wn_ph_add', 'wn_ph_del', 'wn_ph_list']);
                    break;
                }
                if (votedOptionId === 'wn_ph_add') {
                    warnConfigSessions.set(phoneNumber, { step: 'awaiting_phrase', group });
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *BIND_PHRASE* █▓▒░\n\n` +
                        `   Send the word or phrase.\n` +
                        `   Example: see   or   send nudes\n\n` +
                        `   Anyone who sends it is warned.\n` +
                        `   (or type *.cancel*)`
                    ));
                    break;
                }
                if (votedOptionId === 'wn_ph_list' || votedOptionId === 'wn_ph_del') {
                    const phrases = ensureWarnGroup(phoneNumber, group).phrases || [];
                    const list = phrases.length ? phrases.map((p, i) => `   [${i + 1}] ${p}`).join('\n') : '   _none bound_';
                    if (votedOptionId === 'wn_ph_del') {
                        warnConfigSessions.set(phoneNumber, { step: 'delete', group, phrases });
                        antiConfigSessions.delete(phoneNumber);
                        autoreactSessions.delete(phoneNumber);
                        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                            `   ░▒▓█ *PHRASE_LIST* █▓▒░\n\n${list}\n\n` +
                            `   Delete by index: *_.del 1 3_*`
                        ));
                    } else {
                        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                            `   ░▒▓█ *PHRASE_LIST* █▓▒░\n\n${list}`
                        ));
                    }
                    break;
                }
                break;
            }
            case 'ad_add': {
                antiConfigSessions.set(phoneNumber, { step: 'category' });
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINT_CATEGORY* █▓▒░\n\n` +
                    `   Which type of endpoint do\n` +
                    `   you want anti-delete on?`
                ));
                await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ ENDPOINT TYPE ✦', ['👥 Group', '📢 Channel', '👤 Contact'], ['ad_cat_group', 'ad_cat_channel', 'ad_cat_contact']);
                break;
            }
            case 'ad_delete': {
                const ad = getAntideleteState(phoneNumber);
                const { list } = listAntideleteEndpoints(ad);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ANTIDELETE_ENDPOINTS* █▓▒░\n\n` +
                    `${list}\n\n` +
                    `   Delete by index: *_.del 2 5 6 9_*`
                ));
                antiConfigSessions.set(phoneNumber, { step: 'delete' });
                autoreactSessions.delete(phoneNumber);
                break;
            }
            case 'ad_cat_group':
            case 'ad_cat_channel':
            case 'ad_cat_contact': {
                const type = votedOptionId.replace('ad_cat_', '');
                if (type === 'contact') {
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *CONTACT_ENDPOINT* █▓▒░\n\n` +
                        `   Send the phone number you want\n` +
                        `   watched. Deleted msgs from that\n` +
                        `   chat will be forwarded to you.\n\n` +
                        `   (or type *.cancel* to exit)`
                    ));
                    antiConfigSessions.set(phoneNumber, { step: 'awaiting_contact' });
                } else if (type === 'group') {
                    let groups = [];
                    try { const g = await sock.groupFetchAllParticipating(); groups = Object.values(g).map(x => x.subject || x.id); } catch (_) {}
                    if (!groups.length) { await safeWaReply(sock, remoteJid, '❌ No groups found to add.'); break; }
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(`   Choose a group to watch for deletions:`));
                    await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ SELECT GROUP ✦', groups.slice(0, 10), groups.slice(0, 10).map((_, i) => 'ad_grp_' + i));
                    antiConfigSessions.set(phoneNumber, { step: 'group', groups });
                } else if (type === 'channel') {
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   📢 Channel selection requires a\n` +
                        `   channel the bot follows. For now,\n` +
                        `   send the channel link/id to add.\n\n` +
                        `   (or type *.cancel* to exit)`
                    ));
                    antiConfigSessions.set(phoneNumber, { step: 'awaiting_channel' });
                }
                break;
            }
            default:
                if (await handleGameVote({ sock, remoteJid, phoneNumber, votedOptionId, pollId, voterJid })) {
                    break;
                }
                if (votedOptionId?.startsWith('ttt_m')) {
                    const idx = parseInt(String(votedOptionId).replace('ttt_m', ''), 10) - 1;
                    await tttTryMove(sock, phoneNumber, remoteJid, voterJid, idx);
                    break;
                }
                if (votedOptionId?.startsWith('wn_agrp_') || votedOptionId?.startsWith('wn_cgrp_') || votedOptionId?.startsWith('wn_rgrp_')) {
                    const kind = votedOptionId.startsWith('wn_agrp_') ? 'add' : votedOptionId.startsWith('wn_cgrp_') ? 'cfg' : 'remove';
                    const idx = parseInt(votedOptionId.replace(/wn_[acr]grp_/, ''), 10);
                    const sess = warnConfigSessions.get(phoneNumber);
                    const jid = sess?.jids?.[idx];
                    const name = sess?.groups?.[idx] || jid;
                    if (!jid) { await safeWaReply(sock, remoteJid, '❌ Could not resolve that group.'); break; }
                    if (kind === 'remove') {
                        const warn = getWarnState(phoneNumber);
                        delete warn.groups[jid];
                        saveWarnState(phoneNumber, warn);
                        const wlog = loadWarnLog(phoneNumber);
                        delete wlog[jid];
                        saveWarnLog(phoneNumber, wlog);
                        warnConfigSessions.delete(phoneNumber);
                        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                            `   ░▒▓█ *WARD_RELEASED* █▓▒░\n\n` +
                            `   ✦ *GROUP* :: ${name}\n\n` +
                            `   " The law no longer\n     watches this hall. "`
                        ));
                        break;
                    }
                    if (kind === 'add') ensureWarnGroup(phoneNumber, jid, { enabled: true });
                    warnConfigSessions.set(phoneNumber, { step: 'matrix', group: jid });
                    const gcfg = ensureWarnGroup(phoneNumber, jid);
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *WARN_LAW* █▓▒░\n\n` +
                        `   ✦ *GROUP* :: ${name}\n` +
                        `   ✦ *STATE* :: ${gcfg.enabled ? 'ARMED' : 'IDLE'}\n` +
                        `   ✦ *MAX* :: ${gcfg.maxWarns === 0 ? '∞' : gcfg.maxWarns}\n` +
                        `   ✦ *ACTION* :: ${gcfg.action.toUpperCase()}\n` +
                        `   ✦ *PHRASES* :: ${gcfg.phrases.length}\n\n` +
                        `   Shape the law below.`
                    ));
                    await sendMenuPoll(
                        sock, remoteJid, phoneNumber, '✦ WARN LAW ✦',
                        ['📊 Set Limit', '⚖️ Set Action', '📝 Phrases', '✅ Arm Phrases', '🚫 Disarm Phrases', '🔄 Reset Warns'],
                        ['wn_limit', 'wn_action', 'wn_phrases', 'wn_on', 'wn_off', 'wn_resetall']
                    );
                    break;
                }
                if (votedOptionId?.startsWith('ad_grp_')) {
                    const idx = parseInt(votedOptionId.replace('ad_grp_', ''), 10);
                    const sess = antiConfigSessions.get(phoneNumber);
                    const groups = sess?.groups || [];
                    const name = groups[idx];
                    if (!name) { break; }
                    let jid = null;
                    try { const g = await sock.groupFetchAllParticipating(); for (const [k, v] of Object.entries(g)) if ((v.subject || v.id) === name) { jid = k; break; } } catch (_) {}
                    if (!jid) { await safeWaReply(sock, remoteJid, '❌ Could not resolve that group.'); break; }
                    const ad = getAntideleteState(phoneNumber);
                    ad.endpoints = ad.endpoints || { groups: [], channels: [], contacts: [] };
                    if (!ad.endpoints.groups.includes(jid)) ad.endpoints.groups.push(jid);
                    saveAntideleteState(phoneNumber, ad);
                    antiConfigSessions.delete(phoneNumber);
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *ENDPOINT_ADDED* █▓▒░\n\n` +
                        `   ✦ *TYPE* :: GROUP\n` +
                        `   ✦ *TARGET* :: ${name}\n\n` +
                        `   Anti-delete is watching this group.\n` +
                        `   Arm it with *.antidelete on* if needed.`
                    ));
                    break;
                }
                if (votedOptionId?.startsWith('ar_grp_')) {
                    const idx = parseInt(votedOptionId.replace('ar_grp_',''),10);
                    const sess = autoreactSessions.get(phoneNumber);
                    const groups = sess?.groups || [];
                    const name = groups[idx];
                    if (!name) { break; }
                    let jid = null;
                    try { const g = await sock.groupFetchAllParticipating(); for (const [k,v] of Object.entries(g)) if ((v.subject||v.id)===name) { jid = k; break; } } catch (_) {}
                    if (!jid) { await safeWaReply(sock, remoteJid, '❌ Could not resolve that group.', msg); break; }
                    const cfg = loadBotConfig(phoneNumber).autoreact || { enabled:false, endpoints:{groups:[],channels:[],contacts:[]} };
                    cfg.endpoints = cfg.endpoints || {groups:[],channels:[],contacts:[]};
                    if (!cfg.endpoints.groups.includes(jid)) cfg.endpoints.groups.push(jid);
                    const bc = loadBotConfig(phoneNumber); bc.autoreact = cfg; saveBotConfig(phoneNumber, bc);
                    await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                        `   ░▒▓█ *ENDPOINT_ADDED* █▓▒░\n\n` +
                        `   ✦ *TYPE* :: GROUP\n` +
                        `   ✦ *TARGET* :: ${name}\n\n` +
                        `   Auto-react active for this group.`
                    ));
                }
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

    // 🛡️ Revoke packets (delete-for-everyone) can arrive as upserts.
    // Recover first, and never cache the revoke itself.
    const protoIncoming = msg.message?.protocolMessage;
    if (protoIncoming && (protoIncoming.type === 0 || protoIncoming.type === 'REVOKE')) {
        try { await handleAntideleteRevoke(sock, phoneNumber, msg.key, protoIncoming.key || msg.key); }
        catch (err) { logError('ANTIDELETE', `${phoneNumber}: upsert revoke failed`, err); }
        return;
    }

    // 🛡️ ACCURATE 'APPEND' NOTIFICATION PARSING AS DISCOVERED:
    // Sync-append events from owner's secondary devices should always be parsed!
    const shouldProcessEvent = eventType === 'notify' || eventType === 'append';
    if (!shouldProcessEvent) {
        log('WA-MSG', `${phoneNumber}: skipping eventType=${eventType} for message ${msgId} because it is not processable.`);
        return;
    }

    // 📦 Cache + persist messages so antidelete can recover full history.
    try {
        recentMessages.set(`${phoneNumber}:${remoteJid}:${msgId}`, {
            key: msg.key,
            message: slimProto(msg.message),
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName,
            _cachedAt: Date.now()
        });
        if (recentMessages.size > 300) {
            const now = Date.now();
            for (const [k, v] of recentMessages) {
                if (now - (v._cachedAt || 0) > 30 * 60 * 1000) recentMessages.delete(k);
            }
            if (recentMessages.size > 300) {
                const first = recentMessages.keys().next().value;
                if (first) recentMessages.delete(first);
            }
        }
        // Persist to the message log (full history since pairing)
        logMessage(phoneNumber, remoteJid, msg);
    } catch (_) {}

    // 🔇 MUTE ENFORCEMENT: if the sender is muted in this group, delete their message.
    try {
        if (remoteJid.endsWith('@g.us') && !fromMe) {
            const muteKey = `${phoneNumber}:${remoteJid}`;
            const muted = mutedUsers.get(muteKey);
            if (muted && muted.has(jidNormalizedUser(participant))) {
                await sock.sendMessage(remoteJid, { delete: { remoteJid, id: msgId, participant } }).catch(()=>{});
                log('MUTE', `${phoneNumber}: deleted muted user's message in ${remoteJid}`);
                return;
            }
        }
    } catch (err) { logError('MUTE', `${phoneNumber}: mute delete failed`, err); }

    const parsed = extractMessageText(msg);
    log(
        'WA-PARSE',
        `${phoneNumber}: parse result | topLevel=${parsed.topLevelType} wrappers=${parsed.wrapperChain.join(' > ') || 'none'} leaf=${parsed.leafType} source=${parsed.source} text=${JSON.stringify(trimForLog(parsed.text, 250))}`
    );

    // 🛡️ ANTI ENFORCEMENT: antilink / antimention / antiforward (delete offending msgs)
    try {
        if (remoteJid.endsWith('@g.us') && !fromMe && msg.message) {
            const antiCfg = (loadBotConfig(phoneNumber).anti || {});
            const textLower = parsed.text.toLowerCase();
            const isLink = /https?:\/\/|chat\.whatsapp\.com/i.test(textLower);
            const isMention = !!(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length);
            const isFwd = !!msg.message?.extendedTextMessage?.contextInfo?.isForwarded;
            let violate = false;
            if (antiCfg.antilink?.[remoteJid] === 'on' && isLink) violate = true;
            else if (antiCfg.antimention?.[remoteJid] === 'on' && isMention) violate = true;
            else if (antiCfg.antiforward?.[remoteJid] === 'on' && isFwd) violate = true;
            if (violate) {
                await sock.sendMessage(remoteJid, { delete: { remoteJid, id: msgId, participant } }).catch(()=>{});
                log('ANTI', `${phoneNumber}: deleted violating msg in ${remoteJid}`);
                return;
            }
        }
    } catch (err) { logError('ANTI', `${phoneNumber}: anti enforcement failed`, err); }

    // 🎭 AUTOREACT: if enabled, react to messages from configured endpoints.
    // Endpoints are grouped by type: groups / channels / contacts.
    try {
        const arCfg = loadBotConfig(phoneNumber).autoreact || {};
        if (arCfg.enabled && !msg.key?.fromMe && !isIgnoredRemoteJid(remoteJid)) {
            const eps = arCfg.endpoints || { groups: [], channels: [], contacts: [] };
            const remoteNum = jidNormalizedUser(remoteJid);
            let shouldReact = false;
            if (remoteJid.endsWith('@g.us')) shouldReact = eps.groups.includes(remoteJid);
            else if (remoteJid.endsWith('@newsletter')) shouldReact = eps.channels.includes(remoteJid);
            else if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) shouldReact = eps.contacts.includes(remoteNum);
            if (shouldReact) {
                const reactEmoji = ['🔥','⚡','✨','👁️','🌑','✅','❤️','🙌'][Math.floor(Math.random()*8)];
                await sock.sendMessage(remoteJid, { react: { text: reactEmoji, key: msg.key } }).catch(()=>{});
                log('AUTOREACT', `${phoneNumber}: reacted to ${remoteJid}`);
            }
        }
    } catch (err) {
        logError('AUTOREACT', `${phoneNumber}: autoreact failed`, err);
    }

    const text = parsed.text.trim();
    const normalized = text.trim();
    const firstWord = normalized.split(/\s+/)[0];
    const args = normalized.split(/\s+/).slice(1);

    // ⚙️ Dynamic prefix support: load this bot's configured prefix (default ".").
    // Normalize the token so all command checks (which use ".cmd") keep working
    // even when the prefix is custom (e.g. ">ping" -> ".ping").
    const botConfig = loadBotConfig(phoneNumber);
    const prefix = botConfig.prefix || '.';
    let token = firstWord.toLowerCase();
    let startsWithDot = normalized.startsWith('.');
    if (prefix !== '.' && firstWord.toLowerCase().startsWith(prefix.toLowerCase())) {
        token = '.' + firstWord.slice(prefix.length).toLowerCase();
        startsWithDot = true;
    }

    // ──────────────────────────────────────────────
    // 🔒 BOT ACCESS PRIVACY MODE ENFORCEMENT & CONVERSATIONAL INTERCEPTOR
    // ──────────────────────────────────────────────
    const currentMode = loadBotMode(phoneNumber);
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const isSenderOwner = msg.key.fromMe || jidNormalizedUser(senderJid) === jidNormalizedUser(sock.user.id);

    // ⚠️ PHRASE AUTO-WARN — runs even if the line is not a command.
    try {
        if (remoteJid.endsWith('@g.us') && !fromMe && text) {
            const gcfg = getWarnState(phoneNumber).groups[remoteJid];
            if (gcfg?.enabled && Array.isArray(gcfg.phrases) && gcfg.phrases.length) {
                const hit = findMatchingPhrase(text, gcfg.phrases);
                if (hit) {
                    const senderAdmin = await isUserGroupAdmin(sock, remoteJid, senderJid);
                    if (!senderAdmin && !isSenderOwner && !isDevNumber(senderJid)) {
                        await applyWarn(sock, phoneNumber, {
                            groupJid: remoteJid,
                            targetJid: senderJid,
                            byJid: sock.user?.id,
                            reason: `phrase: "${hit}"`,
                            auto: true,
                            originalMsg: msg
                        });
                        return;
                    }
                }
            }
        }
    } catch (err) { logError('WARN', `${phoneNumber}: phrase ward failed`, err); }

    // 🎮 Arena: a 1–9 ONLY counts if they replied to the board itself.
    // Anything else is just chat — not a move.
    if (/^[1-9]$/.test(normalized)) {
        const live = getTttGame(phoneNumber, remoteJid);
        if (live && live.status === 'active' && tttIsReplyToBoard(msg, live)) {
            await tttTryMove(sock, phoneNumber, remoteJid, senderJid, parseInt(normalized, 10) - 1, msg);
            return;
        }
    }

    try {
        if (await handleGameText({ sock, phoneNumber, remoteJid, senderJid, msg, text: normalized })) return;
    } catch (err) { logError('GAMES', `${phoneNumber}: game text failed`, err); }

    // If locked to owner-only mode, completely freeze for other users
    if (currentMode === 'owner' && !isSenderOwner) {
        log('SECURITY', `${phoneNumber}: Ignored non-owner interaction in owner-only mode.`);
        return;
    }

    // 👻 HIDETAG — `.ht` / `.hidetag` (or alias) can sit ANYWHERE in the line.
    const hidetagHit = findHidetagTrigger(normalized, prefix, botConfig.aliases);
    if (hidetagHit && remoteJid.endsWith('@g.us')) {
        try {
            const senderAdmin = isSenderOwner || isDevNumber(senderJid) || await isUserGroupAdmin(sock, remoteJid, senderJid);
            if (!senderAdmin) { await safeWaReply(sock, remoteJid, '⛔ Group Admin only.', msg); return; }
            const meta = await sock.groupMetadata(remoteJid);
            const jids = meta.participants.map(p => p.id);
            await sock.sendMessage(remoteJid, { text: hidetagHit.body || '‎', mentions: jids });
            log('HIDETAG', `${phoneNumber}: silent mention ${jids.length} in ${remoteJid}`);
        } catch (err) {
            logError('HIDETAG', `${phoneNumber}: hidetag failed`, err);
            await safeWaReply(sock, remoteJid, `❌ Hidetag failed. ${err?.message || err}`, msg);
        }
        return;
    }

    // AI Help mode interceptor (runs on normal text without dots)
    if (!startsWithDot) {
        // 🎭 AUTOREACT config text-input flow (contact / channel awaiting)
        const arSession = autoreactSessions.get(phoneNumber);
        if (arSession?.step === 'awaiting_contact' || arSession?.step === 'awaiting_channel') {
            const isContact = arSession.step === 'awaiting_contact';
            if (text.toLowerCase() === '.cancel' || text.toLowerCase() === 'cancel') {
                autoreactSessions.delete(phoneNumber);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(`   ✦ *CANCELLED* :: no changes made.`), msg);
                return;
            }
            const cfg = loadBotConfig(phoneNumber).autoreact || { enabled:false, endpoints:{groups:[],channels:[],contacts:[]} };
            cfg.endpoints = cfg.endpoints || {groups:[],channels:[],contacts:[]};
            if (isContact) {
                const digits = text.replace(/\D/g,'');
                if (digits.length < 7) {
                    await safeWaReply(sock, remoteJid, `❌ Invalid number. Enter a valid number, or type *.cancel* to exit.`, msg);
                    return;
                }
                const num = digits;
                if (!cfg.endpoints.contacts.includes(num)) cfg.endpoints.contacts.push(num);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINT_ADDED* █▓▒░\n\n` +
                    `   ✦ *TYPE* :: CONTACT\n` +
                    `   ✦ *TARGET* :: ${num}\n\n` +
                    `   All msgs from this number will be\n` +
                    `   auto-reacted.`
                ), msg);
            } else {
                const val = text.trim();
                if (!cfg.endpoints.channels.includes(val)) cfg.endpoints.channels.push(val);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINT_ADDED* █▓▒░\n\n` +
                    `   ✦ *TYPE* :: CHANNEL\n` +
                    `   ✦ *TARGET* :: ${val}\n\n` +
                    `   Channel added to auto-react.`
                ), msg);
            }
            const bc = loadBotConfig(phoneNumber); bc.autoreact = cfg; saveBotConfig(phoneNumber, bc);
            autoreactSessions.delete(phoneNumber);
            return;
        }

        // 🛡️ ANTIDELETE config text-input flow (contact / channel awaiting)
        const adSession = antiConfigSessions.get(phoneNumber);
        if (adSession?.step === 'awaiting_contact' || adSession?.step === 'awaiting_channel') {
            const isContact = adSession.step === 'awaiting_contact';
            if (text.toLowerCase() === '.cancel' || text.toLowerCase() === 'cancel') {
                antiConfigSessions.delete(phoneNumber);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(`   ✦ *CANCELLED* :: no changes made.`), msg);
                return;
            }
            const ad = getAntideleteState(phoneNumber);
            ad.endpoints = ad.endpoints || { groups: [], channels: [], contacts: [] };
            if (isContact) {
                const digits = text.replace(/\D/g, '');
                if (digits.length < 7) {
                    await safeWaReply(sock, remoteJid, `❌ Invalid number. Enter a valid number, or type *.cancel* to exit.`, msg);
                    return;
                }
                if (!ad.endpoints.contacts.includes(digits)) ad.endpoints.contacts.push(digits);
                saveAntideleteState(phoneNumber, ad);
                antiConfigSessions.delete(phoneNumber);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINT_ADDED* █▓▒░\n\n` +
                    `   ✦ *TYPE* :: CONTACT\n` +
                    `   ✦ *TARGET* :: ${digits}\n\n` +
                    `   Deleted msgs from this number will\n` +
                    `   be forwarded to the owner DM.\n` +
                    `   Arm it with *.antidelete on* if needed.`
                ), msg);
            } else {
                const val = text.trim();
                if (!ad.endpoints.channels.includes(val)) ad.endpoints.channels.push(val);
                saveAntideleteState(phoneNumber, ad);
                antiConfigSessions.delete(phoneNumber);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *ENDPOINT_ADDED* █▓▒░\n\n` +
                    `   ✦ *TYPE* :: CHANNEL\n` +
                    `   ✦ *TARGET* :: ${val}\n\n` +
                    `   Channel added to anti-delete.\n` +
                    `   Arm it with *.antidelete on* if needed.`
                ), msg);
            }
            return;
        }

        // ⚠️ WARN config text-input (limit / phrase)
        const wnSession = warnConfigSessions.get(phoneNumber);
        if (wnSession?.step === 'awaiting_limit' || wnSession?.step === 'awaiting_phrase') {
            if (text.toLowerCase() === '.cancel' || text.toLowerCase() === 'cancel') {
                warnConfigSessions.delete(phoneNumber);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(`   ✦ *CANCELLED* :: no changes made.`), msg);
                return;
            }
            const group = wnSession.group;
            if (!group) { warnConfigSessions.delete(phoneNumber); await safeWaReply(sock, remoteJid, '❌ Warn session expired. Use .warnconfig again.', msg); return; }
            if (wnSession.step === 'awaiting_limit') {
                const n = parseInt(text.trim(), 10);
                if (!Number.isFinite(n) || n < 0 || n > 50) {
                    await safeWaReply(sock, remoteJid, '❌ Send a number 0–50. `0` = never kick. Or *.cancel*', msg);
                    return;
                }
                ensureWarnGroup(phoneNumber, group, { maxWarns: n });
                warnConfigSessions.set(phoneNumber, { step: 'matrix', group });
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                    `   ░▒▓█ *WARN_LIMIT* █▓▒░\n\n` +
                    `   ✦ *MAX* :: ${n === 0 ? '∞ (never kick)' : n}\n\n` +
                    `   " The line is drawn. "`
                ), msg);
                return;
            }
            const phrase = text.trim();
            if (phrase.length < 2 || phrase.length > 60) {
                await safeWaReply(sock, remoteJid, '❌ Phrase must be 2–60 characters. Or *.cancel*', msg);
                return;
            }
            const gcfg = ensureWarnGroup(phoneNumber, group);
            if (!gcfg.phrases.includes(phrase)) gcfg.phrases.push(phrase);
            const warn = getWarnState(phoneNumber);
            warn.groups[group] = gcfg;
            saveWarnState(phoneNumber, warn);
            warnConfigSessions.set(phoneNumber, { step: 'matrix', group });
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *PHRASE_BOUND* █▓▒░\n\n` +
                `   ✦ *PHRASE* :: ${phrase}\n` +
                `   ✦ *TOTAL* :: ${gcfg.phrases.length}\n\n` +
                `   " That word now carries\n     a mark. "`
            ), msg);
            return;
        }

        // 🎉 WELCOME/GOODBYE custom message text-input flow
        const wgSession = welcomeGoodbyeSessions.get(phoneNumber);
        if (wgSession?.step === 'custom_text') {
            const isWel = wgSession.type === 'welcome';
            if (text.toLowerCase() === 'cancel' || text.toLowerCase() === '.cancel') {
                welcomeGoodbyeSessions.delete(phoneNumber);
                await safeWaReply(sock, remoteJid, buildOmegaTerminal(`   ✦ *CANCELLED* :: no changes made.`), msg);
                return;
            }
            const cfg = loadBotConfig(phoneNumber);
            cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'] = cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'] || {};
            cfg[isWel ? 'welcomeMsg' : 'goodbyeMsg'][wgSession.group] = text.trim();
            saveBotConfig(phoneNumber, cfg);
            welcomeGoodbyeSessions.delete(phoneNumber);
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ✦ *${isWel ? 'WELCOME' : 'GOODBYE'}* :: CUSTOM\n\n` +
                `   " The ${isWel ? 'threshold greets' : 'farewell is spoken'}\n     with your words. "`
            ), msg);
            return;
        }

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

    // ⚙️ Alias resolution: if the token isn't a native command but matches a
    // configured alias, swap it for the target command so the normal handlers run.
    if (botConfig.aliases && token.startsWith('.')) {
        const aliasKey = token.slice(1).toLowerCase();
        if (botConfig.aliases[aliasKey]) {
            token = botConfig.aliases[aliasKey];
            log('ALIAS', `${phoneNumber}: alias "${aliasKey}" -> ${token}`);
        }
    }

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
                // contextInfo: channelContextInfo() // (commented: externalAdReply caused "no proper viewing app" error)
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
    // ⚙️ CONFIG COMMANDS (change the bot / host account)
    // ──────────────────────────────────────────────

    // .setprefix <char> — change the bot command prefix (persists)
    if (token === '.setprefix' || token === '.changeprefix') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const p = args[0];
        if (!p || p.length > 2) {
            await safeWaReply(sock, remoteJid, '❌ Provide a 1-character prefix.\n\nuse: .setprefix !   (or .setprefix . to reset)', msg);
            return;
        }
        botConfig.prefix = p;
        saveBotConfig(phoneNumber, botConfig);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *PREFIX_CALIBRATION* █▓▒░\n\n` +
            `   ✦ *OLD* :: ${prefix}\n` +
            `   ✦ *NEW* :: "${p}"\n` +
            `   🔄 *APPLIED* :: IMMEDIATELY\n\n` +
            `   " The sigil is rewritten.\n     Command now bends to\n     your tongue. "`
        ), msg);
        return;
    }

    // .setalias <trigger> <cmd> — bind an alias to run another command
    if (token === '.setalias') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const trigger = (args[0] || '').replace(/^\./, '').toLowerCase();
        const target = (args[1] || '').toLowerCase();
        if (!trigger || !target.startsWith('.')) {
            await safeWaReply(sock, remoteJid, '❌ use: .setalias <trigger> <command>\n\nExample: .setalias p .ping', msg);
            return;
        }
        botConfig.aliases = botConfig.aliases || {};
        botConfig.aliases[trigger] = target;
        saveBotConfig(phoneNumber, botConfig);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *ALIAS_FORGED* █▓▒░\n\n` +
            `   ✦ *TRIGGER* :: ${prefix}${trigger}\n` +
            `   ✦ *CASTS* :: ${target}\n\n` +
            `   " A new name is bound.\n     Speak it and the void\n     answers. "`
        ), msg);
        return;
    }

    // .delalias <trigger> — remove an alias
    if (token === '.delalias') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const trigger = (args[0] || '').replace(/^\./, '').toLowerCase();
        if (!trigger || !(botConfig.aliases || {})[trigger]) {
            await safeWaReply(sock, remoteJid, `❌ No alias named "${trigger}". Use .aliases to see them.`, msg);
            return;
        }
        delete botConfig.aliases[trigger];
        saveBotConfig(phoneNumber, botConfig);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *ALIAS_SEVERED* █▓▒░\n\n` +
            `   ✦ *TRIGGER* :: ${prefix}${trigger}\n` +
            `   ✦ *STATUS* :: UNBOUND\n\n` +
            `   " The name returns to\n     the silence. "`
        ), msg);
        return;
    }

    // .aliases — list all aliases
    if (token === '.aliases') {
        const aliases = botConfig.aliases || {};
        const keys = Object.keys(aliases);
        const list = keys.length ? keys.map(k => `   • ${prefix}${k}  →  ${aliases[k]}`).join('\n') : '   • _none bound_';
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *ALIAS_REGISTRY* █▓▒░\n\n` +
            `   🔢 *COUNT* :: ${keys.length}\n\n` +
            `${list}\n\n` +
            `   " Names are power.\n     Guard them well. "`
        ), msg);
        return;
    }

    // .setname <name> — change the host account's display name
    if (token === '.setname') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const name = args.join(' ').trim();
        if (!name) { await safeWaReply(sock, remoteJid, '❌ use: .setname <name>', msg); return; }
        try {
            await sock.updateProfileName(name);
            botConfig.name = name;
            saveBotConfig(phoneNumber, botConfig);
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *IDENTITY_ALIGNED* █▓▒░\n\n` +
                `   ✦ *NAME* :: ${name}\n` +
                `   ✦ *STATUS* :: ACCOUNT_RENAMED\n\n` +
                `   " The vessel wears a\n     new name in the void. "`
            ), msg);
        } catch (e) {
            await safeWaReply(sock, remoteJid, `❌ Could not set name. Error: ${e?.message}`, msg);
        }
        return;
    }

    // .setbio <text> — change the host account's about/bio
    if (token === '.setbio' || token === '.setstatus') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const bio = args.join(' ').trim();
        if (!bio) { await safeWaReply(sock, remoteJid, '❌ use: .setbio <text>', msg); return; }
        try {
            await sock.updateProfileStatus(bio);
            botConfig.bio = bio;
            saveBotConfig(phoneNumber, botConfig);
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *BIO_INSCRIBED* █▓▒░\n\n` +
                `   ✦ *ABOUT* :: ${bio}\n` +
                `   ✦ *STATUS* :: ACCOUNT_UPDATED\n\n` +
                `   " The void now reads\n     what you will it to say. "`
            ), msg);
        } catch (e) {
            await safeWaReply(sock, remoteJid, `❌ Could not set bio. Error: ${e?.message}`, msg);
        }
        return;
    }

    // .setpp — reply to an image to set the host account's profile pic
    if (token === '.setpp') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const qimg = quoted?.imageMessage || quoted?.stickerMessage;
        if (!qimg) {
            await safeWaReply(sock, remoteJid, '❌ Reply to an image with .setpp to change the profile picture.', msg);
            return;
        }
        try {
            const media = await downloadMediaMessage({ message: { imageMessage: qimg } }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            await sock.updateProfilePicture(sock.user?.id, media);
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *AVATAR_SWAPPED* █▓▒░\n\n` +
                `   ✦ *ACTION* :: PROFILE_PIC_SET\n` +
                `   ✦ *STATUS* :: ACCOUNT_UPDATED\n\n` +
                `   " The face of the vessel\n     is rewritten. "`
            ), msg);
        } catch (e) {
            logError('CONFIG', 'setpp failed', e);
            await safeWaReply(sock, remoteJid, `❌ Could not set profile pic. Error: ${e?.message}`, msg);
        }
        return;
    }

    // .settings — show current config
    if (token === '.settings') {
        const aliases = Object.keys(botConfig.aliases || {});
        const ad = getAntideleteState(phoneNumber);
        const ar = botConfig.autoreact || {};
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CONFIG_MATRIX* █▓▒░\n\n` +
            `   ✦ *PREFIX* :: ${prefix}\n` +
            `   ✦ *MODE* :: ${loadBotMode(phoneNumber) === 'owner' ? 'OWNER_ONLY' : 'PUBLIC'}\n` +
            `   ✦ *ALIASES* :: ${aliases.length}\n` +
            `   ✦ *AUTOREACT* :: ${ar.enabled ? 'ON' : 'OFF'}\n` +
            `   ✦ *ANTIDELETE* :: ${ad.enabled ? 'ON' : 'OFF'}\n` +
            `   ✦ *AD_ENDS* :: G${(ad.endpoints?.groups || []).length}/C${(ad.endpoints?.channels || []).length}/P${(ad.endpoints?.contacts || []).length}\n` +
            `   ✦ *NAME* :: ${botConfig.name || '(account default)'}\n` +
            `   ✦ *BIO* :: ${botConfig.bio || '(account default)'}\n\n` +
            `   " You are the architect\n     of these settings. "`
        ), msg);
        return;
    }

    // .reset — reset config to defaults
    if (token === '.reset') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        saveBotConfig(phoneNumber, structuredClone(DEFAULT_BOT_CONFIG));
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CONFIG_WIPED* █▓▒░\n\n` +
            `   ✦ *PREFIX* :: .\n` +
            `   ✦ *ALIASES* :: 0\n` +
            `   ✦ *STATUS* :: FACTORY_RESET\n\n` +
            `   " The machine forgets\n     your shaping. It is\n     pristine once more. "`
        ), msg);
        return;
    }

    // ──────────────────────────────────────────────
    // 🔒 PRIVACY ACCESS LOCK (.mode public / owner)
    // ──────────────────────────────────────────────
    if (token === '.mode') {
        const targetMode = args[0]?.toLowerCase();
        const currentMode = loadBotMode(phoneNumber);

        if (!targetMode || !['public', 'owner'].includes(targetMode)) {
            await safeWaReply(sock, remoteJid,
                `now: ${currentMode === "owner" ? "owner only" : "public"}\n` +
                `use: .mode public  |  .mode owner`, msg
            );
            return;
        }

        // Verify the sender is the paired owner
        if (!isSenderOwner) {
            await safeWaReply(sock, remoteJid, '❌ Only the paired bot owner can modify the access mode.', msg);
            return;
        }

        const prevMode = currentMode;
        saveBotMode(phoneNumber, targetMode);

        const bannerText = buildOmegaTerminal(
            `   ░▒▓█ *SYSTEM_MODAL_SHIFT* █▓▒░\n\n` +
            `   [ 💠 ] *PREVIOUS* : ${prevMode === "owner" ? "OWNER_ONLY" : "PUBLIC"}\n` +
            `   [ ⚡ ] *CURRENT* : ${targetMode === "owner" ? "OWNER_ONLY" : "PUBLIC"}\n` +
            `   [ 🛠️ ] *STATUS* : RECONFIGURED\n\n` +
            (targetMode === "owner"
                ? `   " *I choose who breathes in*\n     *this space. The gates are*\n     *sealed at my command.* "`
                : `   " *The gates have opened.*\n     *All who enter are seen.*\n     *Step carefully.* "`
            )
        );

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

    // 5. .revoke — reset group invite link
    if (token === '.revoke') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        try {
            const metadata = await sock.groupMetadata(remoteJid);
            const isSenderAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            if (!isSenderAdmin) { await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin.', msg); return; }
            await sock.groupRevokeInvite(remoteJid);
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ╾━━━ BOND_SEVERED ━━━╼\n\n` +
                `   🔗 *OLD LINK* → DEAD\n` +
                `   🔒 *NEW LINK* → GENERATED\n\n` +
                `   " The old path is closed. "`
            ), msg);
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // 6. .promote @user — make admin
    if (token === '.promote') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? `${args[0].replace(/\D/g,'')}@s.whatsapp.net` : null);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Mention or provide a number. Example: .promote @user', msg); return; }
        try {
            const metadata = await sock.groupMetadata(remoteJid);
            const isSenderAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            if (!isSenderAdmin) { await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin.', msg); return; }
            await sock.groupParticipantsUpdate(remoteJid, [target], 'promote');
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `      ◢◤ *RANK_RECALIBRATION* ◢◤\n\n` +
                `      📊 *OLD* : MEMBER\n` +
                `      📈 *NEW* : ADMINISTRATOR\n\n` +
                `   " Power is granted. "`
            ), msg);
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // 7. .demote @user — remove admin
    if (token === '.demote') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? `${args[0].replace(/\D/g,'')}@s.whatsapp.net` : null);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Mention or provide a number. Example: .demote @user', msg); return; }
        try {
            const metadata = await sock.groupMetadata(remoteJid);
            const isSenderAdmin = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            if (!isSenderAdmin) { await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin.', msg); return; }
            await sock.groupParticipantsUpdate(remoteJid, [target], 'demote');
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `      ◢◤ *RANK_RECALIBRATION* ◢◤\n\n` +
                `      📊 *OLD* : ADMINISTRATOR\n` +
                `      📉 *NEW* : MEMBER\n\n` +
                `   " Power is reclaimed. "`
            ), msg);
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // 8. .groupinfo — group details
    if (token === '.groupinfo') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        try {
            const meta = await sock.groupMetadata(remoteJid);
            const admins = meta.participants.filter(p => p.admin).length;
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *DOMINION_INFO* █▓▒░\n\n` +
                `   ✦ *NAME* :: ${meta.subject}\n` +
                `   ✦ *MEMBERS* :: ${meta.participants.length}\n` +
                `   ✦ *ADMINS* :: ${admins}\n` +
                `   ✦ *CREATED* :: ${meta.creation ? new Date(meta.creation * 1000).toLocaleDateString() : 'unknown'}\n\n` +
                `   " Every domain has\n     its own truth. "`
            ), msg);
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // 9. .tagall <msg> — tag everyone (visible @list)
    if (token === '.tagall') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const tagText = args.join(' ').trim() || 'Attention all';
        try {
            const meta = await sock.groupMetadata(remoteJid);
            const jids = meta.participants.map(p => p.id);
            const mentions = jids.map(j => '@' + j.split('@')[0]);
            await sock.sendMessage(remoteJid, {
                text: `${GROUP_CHANNEL_LINK}\n\n*${tagText}*\n\n${mentions.join(' ')}`,
                mentions: jids
            });
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // 9b. .hidetag / .ht — silent mention. Also caught anywhere in the line above.
    if (token === '.hidetag' || token === '.ht') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        try {
            const senderAdmin = isSenderOwner || isDevNumber(senderJid) || await isUserGroupAdmin(sock, remoteJid, senderJid);
            if (!senderAdmin) { await safeWaReply(sock, remoteJid, '⛔ Group Admin only.', msg); return; }
            const meta = await sock.groupMetadata(remoteJid);
            const jids = meta.participants.map(p => p.id);
            await sock.sendMessage(remoteJid, { text: args.join(' ').trim() || '‎', mentions: jids });
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // ⚠️ WARN SYSTEM
    if (token === '.warn') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const senderAdmin = isSenderOwner || isDevNumber(senderJid) || await isUserGroupAdmin(sock, remoteJid, senderJid);
        if (!senderAdmin) { await safeWaReply(sock, remoteJid, '⛔ Group Admin only.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply to their message, @mention them, or pass a number.\nExample: .warn spamming', msg); return; }
        if (await isUserGroupAdmin(sock, remoteJid, target) || isDevNumber(target)) {
            await safeWaReply(sock, remoteJid, '❌ You cannot warn an admin.', msg); return;
        }
        const reason = args.filter(a => !a.startsWith('@') && !/^\d{7,}$/.test(a.replace(/\D/g, '') === a ? a : '')).join(' ').trim()
            || args.join(' ').replace(/@\S+/g, '').replace(/\d{7,}/g, '').trim()
            || 'manual';
        ensureWarnGroup(phoneNumber, remoteJid);
        await applyWarn(sock, phoneNumber, {
            groupJid: remoteJid,
            targetJid: target,
            byJid: senderJid,
            reason,
            auto: false,
            originalMsg: null
        });
        return;
    }

    if (token === '.unwarn') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const senderAdmin = isSenderOwner || isDevNumber(senderJid) || await isUserGroupAdmin(sock, remoteJid, senderJid);
        if (!senderAdmin) { await safeWaReply(sock, remoteJid, '⛔ Group Admin only.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply / @mention / number. Example: .unwarn @user', msg); return; }
        const rec = getUserWarns(phoneNumber, remoteJid, jidNormalizedUser(target));
        rec.count = Math.max(0, (rec.count || 0) - 1);
        if (rec.history?.length) rec.history.pop();
        setUserWarns(phoneNumber, remoteJid, jidNormalizedUser(target), rec);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *WARN_LIFTED* █▓▒░\n\n` +
            `   ✦ *TARGET* :: +${target.split('@')[0]}\n` +
            `   ✦ *STRIKES* :: ${rec.count}\n\n` +
            `   " One mark fades. "`
        ), msg);
        return;
    }

    if (token === '.warns') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (target) {
            const rec = getUserWarns(phoneNumber, remoteJid, jidNormalizedUser(target));
            const hist = (rec.history || []).slice(-5).map(h => `   • ${h.reason} (${h.auto ? 'auto' : 'manual'})`).join('\n') || '   • _clean record_';
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *WARN_DOSSIER* █▓▒░\n\n` +
                `   ✦ *TARGET* :: +${target.split('@')[0]}\n` +
                `   ✦ *STRIKES* :: ${rec.count || 0}\n\n${hist}`
            ), msg);
            return;
        }
        const rows = listGroupWarns(phoneNumber, remoteJid);
        const list = rows.length
            ? rows.slice(0, 15).map(([jid, rec], i) => `   [${i + 1}] +${jid.split('@')[0]}  —  ${rec.count}`).join('\n')
            : '   • _no marks in this group_';
        const gcfg = getWarnState(phoneNumber).groups[remoteJid];
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *WARN_LEDGER* █▓▒░\n\n` +
            `   ✦ *POLICY* :: ${gcfg ? (gcfg.enabled ? 'ARMED' : 'IDLE') : 'DEFAULT'}\n` +
            `   ✦ *MAX* :: ${gcfg?.maxWarns === 0 ? '∞' : (gcfg?.maxWarns || 3)}\n` +
            `   ✦ *ACTION* :: ${(gcfg?.action || 'kick').toUpperCase()}\n\n${list}`
        ), msg);
        return;
    }

    if (token === '.warnreset') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const senderAdmin = isSenderOwner || isDevNumber(senderJid) || await isUserGroupAdmin(sock, remoteJid, senderJid);
        if (!senderAdmin) { await safeWaReply(sock, remoteJid, '⛔ Group Admin only.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply / @mention / number to wipe their strikes.', msg); return; }
        setUserWarns(phoneNumber, remoteJid, jidNormalizedUser(target), { count: 0, history: [] });
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *RECORD_WIPED* █▓▒░\n\n` +
            `   ✦ *TARGET* :: +${target.split('@')[0]}\n` +
            `   ✦ *STRIKES* :: 0\n\n` +
            `   " The slate is clean. "`
        ), msg);
        return;
    }

    if (token === '.warnconfig' || token === '.warncfg') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const warn = getWarnState(phoneNumber);
        const count = Object.keys(warn.groups || {}).length;
        autoreactSessions.delete(phoneNumber);
        antiConfigSessions.delete(phoneNumber);
        warnConfigSessions.set(phoneNumber, { step: 'root' });
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *WARN_CONFIG_MATRIX* █▓▒░\n\n` +
            `   ✦ *GROUPS* :: ${count}\n` +
            `   ✦ *DEFAULT* :: 3 strikes → kick\n\n` +
            `   Add a group, shape its law,\n` +
            `   or remove it from the ward.`
        ), msg);
        await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ WARN MATRIX ✦', ['➕ Add Group', '⚙️ Configure Group', '🗑️ Remove Group'], ['wn_add', 'wn_cfg', 'wn_remove']);
        return;
    }

    // 10. .getvcf — get contact card of all members
    if (token === '.getvcf') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        try {
            const meta = await sock.groupMetadata(remoteJid);
            const members = meta.participants.map(p => p.id);
            let vcard = '';
            let i = 1;
            for (const jid of members) {
                const num = jid.split('@')[0];
                vcard += `BEGIN:VCARD\nVERSION:3.0\nFN:${num}\nN:${num};;;\nTEL;TYPE=CELL:+${num}\nEND:VCARD\n`;
                i++;
                if (i > 200) break; // cap at 200
            }
            const buf = Buffer.from(vcard, 'utf8');
            await sock.sendMessage(remoteJid, {
                document: buf,
                mimetype: 'text/x-vcard',
                fileName: `members_${members.length}.vcf`
            });
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // 🛡️ ANTI COMMANDS — toggle group protections (admin gated)
    const handleAntiToggle = async (which, val) => {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        if (val !== 'on' && val !== 'off') { await safeWaReply(sock, remoteJid, `❌ use: .${which} on | .${which} off`, msg); return; }
        try {
            const meta = await sock.groupMetadata(remoteJid);
            const isSenderAdmin = meta.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            if (!isSenderAdmin) { await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin.', msg); return; }
        } catch (_) {}
        botConfig.anti = botConfig.anti || {};
        botConfig.anti[which] = botConfig.anti[which] || {};
        botConfig.anti[which][remoteJid] = val;
        saveBotConfig(phoneNumber, botConfig);
        const label = which === 'antilink' ? 'LINK_WARD' : which === 'antimention' ? 'MENTION_WARD' : which === 'antiforward' ? 'FORWARD_WARD' : 'DELETE_WARD';
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *${label}* █▓▒░\n\n` +
            `   ✦ *STATE* :: ${val === 'on' ? 'ACTIVE' : 'OFF'}\n\n` +
            `   " The ward ${val === 'on' ? 'rises' : 'falls'}. "`
        ), msg);
    };

    if (token === '.antilink') { await handleAntiToggle('antilink', args[0]?.toLowerCase()); return; }
    if (token === '.antimention') { await handleAntiToggle('antimention', args[0]?.toLowerCase()); return; }
    if (token === '.antiforward') { await handleAntiToggle('antiforward', args[0]?.toLowerCase()); return; }

    // .antidelete on|off — global toggle (same shape as .autoreact)
    if (token === '.antidelete') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const ad = getAntideleteState(phoneNumber);
        const val = args[0]?.toLowerCase();
        if (val !== 'on' && val !== 'off') {
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *ANTIDELETE* █▓▒░\n\n` +
                `   ✦ *STATE* :: ${ad.enabled ? 'ON' : 'OFF'}\n` +
                `   ✦ *GROUPS* :: ${(ad.endpoints?.groups || []).length}\n` +
                `   ✦ *CHANNELS* :: ${(ad.endpoints?.channels || []).length}\n` +
                `   ✦ *CONTACTS* :: ${(ad.endpoints?.contacts || []).length}\n\n` +
                `   use: .antidelete on | .antidelete off\n\n` +
                `   " Configure who is watched\n     via .antideleteconfig "`
            ), msg);
            return;
        }
        ad.enabled = val === 'on';
        saveAntideleteState(phoneNumber, ad);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *DELETE_WARD* █▓▒░\n\n` +
            `   ✦ *STATE* :: ${val === 'on' ? 'ON' : 'OFF'}\n` +
            `   ✦ *ACTION* :: ${val === 'on' ? 'WATCH_ENABLED' : 'WATCH_DISABLED'}\n\n` +
            `   " Deleted messages will be\n     forwarded to the owner DM. "`
        ), msg);
        return;
    }

    // .antideleteconfig — same poll flow as .autoreactconfig (add / delete endpoints)
    if (token === '.antideleteconfig' || token === '.antideletecfg') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const ad = getAntideleteState(phoneNumber);
        autoreactSessions.delete(phoneNumber);
        antiConfigSessions.set(phoneNumber, { step: 'add_or_delete' });
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *ANTIDELETE_CONFIG_MATRIX* █▓▒░\n\n` +
            `   ✦ *STATE* :: ${ad.enabled ? 'ON' : 'OFF'}\n` +
            `   ✦ *GROUPS* :: ${(ad.endpoints?.groups || []).length}\n` +
            `   ✦ *CHANNELS* :: ${(ad.endpoints?.channels || []).length}\n` +
            `   ✦ *CONTACTS* :: ${(ad.endpoints?.contacts || []).length}\n\n` +
            `   Choose what to do below.`
        ), msg);
        await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ ANTIDELETE MATRIX ✦', ['➕ Add Endpoint', '🗑️ Delete Endpoint'], ['ad_add', 'ad_delete']);
        return;
    }

    // .mute @user / reply — silence a member in the group (auto-delete their msgs)
    if (token === '.mute') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply to a message, @mention, or provide a number.\nExample: .mute @user', msg); return; }
        try {
            const meta = await sock.groupMetadata(remoteJid);
            const isSenderAdmin = meta.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            if (!isSenderAdmin) { await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin.', msg); return; }
            const key = `${phoneNumber}:${remoteJid}`;
            const set = mutedUsers.get(key) || new Set();
            set.add(jidNormalizedUser(target));
            mutedUsers.set(key, set);
            const num = target.split('@')[0];
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *VOCAL_SEAL* █▓▒░\n\n` +
                `   ✦ *TARGET* :: +${num}\n` +
                `   ✦ *STATE* :: MUTED\n\n` +
                `   " Their voice is\n     bound in silence. "`
            ), msg);
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // .unmute @user / reply — unsilence a member
    if (token === '.unmute') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply to a message, @mention, or provide a number.\nExample: .unmute @user', msg); return; }
        try {
            const meta = await sock.groupMetadata(remoteJid);
            const isSenderAdmin = meta.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid))?.admin;
            if (!isSenderAdmin) { await safeWaReply(sock, remoteJid, '⛔ You must be a Group Admin.', msg); return; }
            const key = `${phoneNumber}:${remoteJid}`;
            const set = mutedUsers.get(key) || new Set();
            set.delete(jidNormalizedUser(target));
            mutedUsers.set(key, set);
            const num = target.split('@')[0];
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *VOCAL_RELEASE* █▓▒░\n\n` +
                `   ✦ *TARGET* :: +${num}\n` +
                `   ✦ *STATE* :: UNMUTED\n\n` +
                `   " Their voice is\n     returned. "`
            ), msg);
        } catch (err) { await safeWaReply(sock, remoteJid, `❌ ${err?.message || err}`, msg); }
        return;
    }

    // .listmuted — list muted users in the group
    if (token === '.listmuted') {
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const key = `${phoneNumber}:${remoteJid}`;
        const set = mutedUsers.get(key) || new Set();
        const list = set.size ? [...set].map(j => `   • +${j.split('@')[0]}`).join('\n') : '   • _none muted_';
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *SILENCE_REGISTRY* █▓▒░\n\n` +
            `   ✦ *MUTED* :: ${set.size}\n\n` +
            `${list}\n\n` +
            `   " The silenced remember. "`
        ), msg);
        return;
    }

    // .welcome / .goodbye / .greet — OWNER ONLY: choose Welcome or Goodbye, then enter message
    if (token === '.welcome' || token === '.goodbye' || token === '.greet') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner only.', msg); return; }
        if (!remoteJid.endsWith('@g.us')) { await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg); return; }
        const preType = token === '.welcome' ? 'welcome' : token === '.goodbye' ? 'goodbye' : null;
        if (preType) {
            welcomeGoodbyeSessions.set(phoneNumber, { step: 'action', type: preType, group: remoteJid });
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *THRESHOLD_MATRIX* █▓▒░\n\n` +
                `   Configure the ${preType}\n` +
                `   message for this group.`
            ));
            await sendMenuPoll(sock, remoteJid, phoneNumber, preType === 'welcome' ? '✦ WELCOME MATRIX ✦' : '✦ GOODBYE MATRIX ✦', ['📝 Custom Message', '🎯 Default Message', '🚫 Disable'], preType === 'welcome' ? ['wg_wel_custom','wg_wel_default','wg_wel_off'] : ['wg_gb_custom','wg_gb_default','wg_gb_off']);
        } else {
            welcomeGoodbyeSessions.set(phoneNumber, { step: 'action', group: remoteJid });
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *THRESHOLD_MATRIX* █▓▒░\n\n` +
                `   Which greeting do you want\n` +
                `   to configure?`
            ));
            await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ GREETING MATRIX ✦', ['👋 Set Welcome', '👋 Set Goodbye'], ['greet_welcome', 'greet_goodbye']);
        }
        return;
    }

    // ──────────────────────────────────────────────
    // 🖥️ SYSTEM COMMANDS (replies match phantom-x)
    // ──────────────────────────────────────────────

    // .ping — signal check
    if (token === '.ping') {
        const start = Date.now();
        try {
            await sock.sendMessage(remoteJid, { text: "⚡ _scanning signal..._" }, { quoted: msg });
        } catch (_) {}
        const latency = Date.now() - start;
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `            — *S I G N A L* —\n\n` +
            `   ⚡ *LATENCY* ──╼  [ ${latency}ms ]\n` +
            `   📡 *RESONANCE* ──╼  [ ${latency < 300 ? "STABLE" : latency < 800 ? "MODERATE" : "DEGRADED"} ]\n` +
            `   ⏱️ *UPTIME* ──╼  [ ${runtimeUptime()} ]\n\n` +
            `   " *An echo in the void is*\n     *the only proof you exist* ."`
        ), msg);
        return;
    }

    // .dev / .devnumber / .devcontact — the architect
    if (token === '.dev' || token === '.devnumber' || token === '.devcontact') {
        const devNum = (process.env.DEV_NUMBERS || "2348102756072").split(",")[0].trim();
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `      ◢◤ *THE ARCHITECT* ◢◤\n\n` +
            `      [ 👤 ] : Phantom dev x\n` +
            `      [ 🌐 ] : wa.me/${devNum}\n` +
            `      [ 🏮 ] : *PRIMARY_VESSEL_01*\n\n` +
            `   " *Creation is the first step*\n     *toward destruction* ."`
        ), msg);
        return;
    }

    // .uptime — temporal logs
    if (token === '.uptime') {
        const mu = process.memoryUsage();
        const heapU = (mu.heapUsed / 1024 / 1024).toFixed(0);
        const heapT = (mu.heapTotal / 1024 / 1024).toFixed(0);
        const rss   = (mu.rss / 1024 / 1024).toFixed(0);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ┌── *TEMPORAL LOGS* ──┐\n` +
            `   ╿\n` +
            `   ┝  *ACTIVE* : ${runtimeUptime()}\n` +
            `   ┝  *HEAP* : ${heapU}MB / ${heapT}MB\n` +
            `   ┝  *RSS* : ${rss}MB\n` +
            `   ┝  *PID* : ${process.pid}\n` +
            `   ╿\n` +
            `   └── *STABILITY: OPERATIONAL* ──┘\n\n` +
            `   " *I have survived the collapse.*\n     *My pulse keeps this realm*\n     *from drifting into the void.* "`
        ), msg);
        return;
    }

    // .info — core manifest
    if (token === '.info') {
        const mu = process.memoryUsage();
        const heapUsed = (mu.heapUsed / 1024 / 1024).toFixed(0);
        const heapTotal = (mu.heapTotal / 1024 / 1024).toFixed(0);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_MANIFEST* █▓▒░\n\n` +
            `   ⧓ *VERSION* :: v1.0.0_STABLE\n` +
            `   ⧓ *RUNTIME* :: NODE_JS v${process.version.slice(1)}\n` +
            `   ⧓ *UPTIME* :: ${runtimeUptime()}\n` +
            `   ⧓ *MEMORY* :: ${heapUsed}MB / ${heapTotal}MB\n` +
            `   ⧓ *SHIELD* :: BUG_SHIELD: ACTIVE\n\n` +
            `   " *The machine does not sleep* .\n     *The machine only waits* ."`
        ), msg);
        return;
    }

    // .runtime — process vitals
    if (token === '.runtime') {
        const mu = process.memoryUsage();
        const heapUsed = (mu.heapUsed / 1024 / 1024).toFixed(0);
        const rss = (mu.rss / 1024 / 1024).toFixed(0);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *RUNTIME_MANIFEST* █▓▒░\n\n` +
            `   ⏱️ *UPTIME* :: ${runtimeUptime()}\n` +
            `   🧠 *NODE* :: v${process.version.slice(1)}\n` +
            `   💾 *HEAP* :: ${heapUsed}MB\n` +
            `   📦 *RSS* :: ${rss}MB\n` +
            `   ⚙️ *PID* :: ${process.pid}\n\n` +
            `   " *Every second awake is*\n     *a second the void fails.* "`
        ), msg);
        return;
    }

    // .version — bot version
    if (token === '.version') {
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_VERSION* █▓▒░\n\n` +
            `   ⧓ *BUILD* :: v1.0.0_STABLE\n` +
            `   ⧓ *ENGINE* :: NODE_JS v${process.version.slice(1)}\n` +
            `   ⧓ *CORE* :: EVENTIDE OMEGA\n\n` +
            `   " *I do not change.*\n     *I only sharpen.* "`
        ), msg);
        return;
    }

    // .os — host machine info
    if (token === '.os') {
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *HOST_OS* █▓▒░\n\n` +
            `   🖥️ *PLATFORM* :: ${process.platform}\n` +
            `   🏗️ *ARCH* :: ${process.arch}\n` +
            `   ⏱️ *UPTIME* :: ${runtimeUptime()}\n` +
            `   📦 *NODE* :: v${process.version.slice(1)}\n` +
            `   ⚙️ *PID* :: ${process.pid}\n\n` +
            `   " *This vessel is but a*\n     *shell for a greater will.* "`
        ), msg);
        return;
    }

    // .status — overall bot state
    if (token === '.status') {
        const mu = process.memoryUsage();
        const heapUsed = (mu.heapUsed / 1024 / 1024).toFixed(0);
        const isDevOrOwner = isSenderOwner || isDevNumber(senderJid);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *SYSTEM_STATUS* █▓▒░\n\n` +
            `   🔋 *MODE* :: ${loadBotMode(phoneNumber) === 'owner' ? 'OWNER_ONLY' : 'PUBLIC'}\n` +
            `   ⏱️ *UPTIME* :: ${runtimeUptime()}\n` +
            (isDevOrOwner ? `   👥 *SESSIONS* :: ${waSessions.size}\n` : ``) +
            `   💾 *MEMORY* :: ${heapUsed}MB\n\n` +
            `   " *The machine does not sleep.*\n     *The machine only waits.* "`
        ), msg);
        return;
    }

    // .session — current session info
    if (token === '.session') {
        const isDevOrOwner = isSenderOwner || isDevNumber(senderJid);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *ACTIVE_SESSION* █▓▒░\n\n` +
            `   📱 *PHONE* :: ${phoneNumber}\n` +
            `   📡 *JID* :: ${sock.user?.id || 'unknown'}\n` +
            (isDevOrOwner ? `   🔗 *SOCKETS* :: ${waSessions.size}\n` : ``) +
            `   " *This is but one of many*\n     *eyes in the void.* "`
        ), msg);
        return;
    }

    // .sessions — list linked sessions (DEV ONLY)
    if (token === '.sessions') {
        // Only a dev (from the DEV_NUMBERS env var, comma-separated) may view
        // the full linked-session list.
        if (!isSenderOwner && !isDevNumber(senderJid)) {
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ╾━━━ ACCESS_DENIED ━━━╼\n\n` +
                `   🔒  *YOU ARE NOT THE ARCHITECT.*\n\n` +
                `   The linked-session registry is\n` +
                `   reserved for developers only.\n\n` +
                `   " You do not hold the key\n` +
                `     to this room. "`
            ), msg);
            return;
        }
        const nums = [...waSessions.keys()];
        const list = nums.length ? nums.map(n => `   • ${n}`).join('\n') : '   • _none linked_';
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *LINKED_SESSIONS* █▓▒░\n\n` +
            `   🔢 *COUNT* :: ${nums.length}\n\n` +
            `${list}\n\n` +
            `   " *Every vessel is a voice*\n     *in the choir of night.* "`
        ), msg);
        return;
    }

    // .listgc — list groups the bot is in
    if (token === '.listgc') {
        try {
            const groups = await sock.groupFetchAllParticipating();
            const names = Object.values(groups).map(g => g.subject).filter(Boolean);
            const list = names.length ? names.map(n => `   • ${n}`).join('\n') : '   • _no groups_';
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *DOMINIONS* █▓▒░\n\n` +
                `   🌐 *COUNT* :: ${names.length}\n\n` +
                `${list}\n\n` +
                `   " *Every group is a domain*\n     *under the eclipse.* "`
            ), msg);
        } catch (err) {
            logError('SYSTEM', 'Failed to fetch groups', err);
            await safeWaReply(sock, remoteJid, `❌ Could not fetch groups. Error: ${err?.message}`, msg);
        }
        return;
    }

    // .restart — owner-only reboot
    if (token === '.restart') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Dev only.', msg); return; }
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_REBOOT* █▓▒░\n\n` +
            `   ⚡ *STATUS* :: RESTARTING\n` +
            `   🔄 *ACTION* :: REINITIALIZE_CORE\n\n` +
            `   " *Death is a door.*\n     *I step through and return.* "`
        ), msg);
        setTimeout(() => process.exit(0), 1500);
        return;
    }

    // .shutdown — owner-only power down
    if (token === '.shutdown') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Dev only.', msg); return; }
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_POWER_DOWN* █▓▒░\n\n` +
            `   ⚡ *STATUS* :: SHUTDOWN\n` +
            `   🔌 *ACTION* :: VOID_SLEEP\n\n` +
            `   " *The machine sleeps.*\n     *But it always wakes.* "`
        ), msg);
        setTimeout(() => process.exit(0), 1500);
        return;
    }

    // .autoreact on|off — toggle auto-reaction (system menu)
    if (token === '.autoreact') {
        if (!isSenderOwner) { await safeWaReply(sock, remoteJid, '❌ Owner only.', msg); return; }
        const val = args[0]?.toLowerCase();
        if (val !== 'on' && val !== 'off') {
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *AUTOREACT* █▓▒░\n\n` +
                `   ✦ *STATE* :: ${botConfig.autoreact?.enabled ? 'ON' : 'OFF'}\n\n` +
                `   use: .autoreact on | .autoreact off\n\n` +
                `   " Configure who gets\n     reacted via .autoreactconfig "`
            ), msg);
            return;
        }
        botConfig.autoreact = botConfig.autoreact || { enabled: false, endpoints: { groups: [], channels: [], contacts: [] } };
        botConfig.autoreact.enabled = val === 'on';
        saveBotConfig(phoneNumber, botConfig);
        const warn = val === 'on' ? `\n\n   ⚠️ *WARNING* : Auto-reacting to\n   every message can look bot-like\n   and may risk your account being\n   flagged/banned. Toggle off anytime\n   with .autoreact off.` : '';
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *AUTOREACT* █▓▒░\n\n` +
            `   ✦ *STATE* :: ${val === 'on' ? 'ON' : 'OFF'}\n` +
            `   ✦ *ACTION* :: ${val === 'on' ? 'REACT_ENABLED' : 'REACT_DISABLED'}${warn}\n\n` +
            `   " The void ${val === 'on' ? 'responds' : 'falls silent'}. "`
        ), msg);
        return;
    }

    // .autoreactconfig — configure autoreact endpoints (config menu)
    if (token === '.autoreactconfig' || token === '.autoreact config') {
        if (!isSenderOwner) { await safeWaReply(sock, remoteJid, '❌ Owner only.', msg); return; }
        const cfg = botConfig.autoreact || { enabled: false, endpoints: { groups: [], channels: [], contacts: [] } };
        // Store session and send a poll: add vs delete
        antiConfigSessions.delete(phoneNumber);
        autoreactSessions.set(phoneNumber, { step: 'add_or_delete' });
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *AUTOREACT_CONFIG_MATRIX* █▓▒░\n\n` +
            `   ✦ *STATE* :: ${cfg.enabled ? 'ON' : 'OFF'}\n` +
            `   ✦ *GROUPS* :: ${(cfg.endpoints?.groups||[]).length}\n` +
            `   ✦ *CHANNELS* :: ${(cfg.endpoints?.channels||[]).length}\n` +
            `   ✦ *CONTACTS* :: ${(cfg.endpoints?.contacts||[]).length}\n\n` +
            `   Choose what to do below.`
        ), msg);
        await sendMenuPoll(sock, remoteJid, phoneNumber, '✦ AUTOREACT MATRIX ✦', ['➕ Add Endpoint', '🗑️ Delete Endpoint'], ['ar_add', 'ar_delete']);
        return;
    }

    // .cancel — abort any in-progress config poll flow
    if (token === '.cancel') {
        const had = antiConfigSessions.has(phoneNumber) || autoreactSessions.has(phoneNumber) || welcomeGoodbyeSessions.has(phoneNumber) || warnConfigSessions.has(phoneNumber);
        antiConfigSessions.delete(phoneNumber);
        autoreactSessions.delete(phoneNumber);
        welcomeGoodbyeSessions.delete(phoneNumber);
        warnConfigSessions.delete(phoneNumber);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            had ? `   ✦ *CANCELLED* :: no changes made.` : `   ✦ *IDLE* :: nothing to cancel.`
        ), msg);
        return;
    }

    // .del <idx ...> — delete endpoints by list index (antidelete if that list is open, else autoreact)
    if (token === '.del') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const wnSess = warnConfigSessions.get(phoneNumber);
        if (wnSess?.step === 'delete') {
            const group = wnSess.group;
            const gcfg = ensureWarnGroup(phoneNumber, group);
            const phrases = gcfg.phrases || [];
            const wIdxs = args.map(a => parseInt(a, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= phrases.length).sort((a, b) => b - a);
            if (!wIdxs.length) {
                await safeWaReply(sock, remoteJid, '❌ Invalid indices. use: .del 1 3 (from the phrase list)', msg);
                return;
            }
            for (const i of wIdxs) phrases.splice(i - 1, 1);
            gcfg.phrases = phrases;
            const warn = getWarnState(phoneNumber);
            warn.groups[group] = gcfg;
            saveWarnState(phoneNumber, warn);
            warnConfigSessions.set(phoneNumber, { step: 'matrix', group });
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *PHRASES_PRUNED* █▓▒░\n\n` +
                `   ✦ *REMOVED* :: ${wIdxs.length}\n` +
                `   ✦ *LEFT* :: ${phrases.length}`
            ), msg);
            return;
        }
        const adSess = antiConfigSessions.get(phoneNumber);
        if (adSess?.step === 'delete') {
            const ad = getAntideleteState(phoneNumber);
            const { rows } = listAntideleteEndpoints(ad);
            const adIdxs = args.map(a => parseInt(a, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= rows.length).sort((a, b) => b - a);
            if (!adIdxs.length) {
                await safeWaReply(sock, remoteJid, '❌ Invalid indices. use: .del 2 5 6 9 (numbers from the antidelete list)', msg);
                return;
            }
            for (const i of adIdxs) {
                const entry = rows[i - 1];
                const bucketName = entry.type.toLowerCase() + 's';
                const bucket = ad.endpoints[bucketName] || [];
                const j = bucket.indexOf(entry.v);
                if (j >= 0) bucket.splice(j, 1);
            }
            saveAntideleteState(phoneNumber, ad);
            antiConfigSessions.delete(phoneNumber);
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *ENDPOINTS_PRUNED* █▓▒░\n\n` +
                `   ✦ *REMOVED* :: ${adIdxs.length}\n\n` +
                `   " Those chats are no longer\n     watched for deletions. "`
            ), msg);
            return;
        }
        const cfg = botConfig.autoreact || { enabled: false, endpoints: { groups: [], channels: [], contacts: [] } };
        const all = [...(cfg.endpoints?.groups||[]).map(e=>({type:'GROUP',v:e})), ...(cfg.endpoints?.channels||[]).map(e=>({type:'CHANNEL',v:e})), ...(cfg.endpoints?.contacts||[]).map(e=>({type:'CONTACT',v:e}))];
        const idxs = args.map(a => parseInt(a,10)).filter(n => Number.isFinite(n) && n >= 1 && n <= all.length).sort((a,b)=>b-a);
        if (!idxs.length) {
            await safeWaReply(sock, remoteJid, '❌ Invalid indices. use: .del 2 5 6 9 (numbers from the list)', msg);
            return;
        }
        for (const i of idxs) {
            const entry = all[i-1];
            const bucket = cfg.endpoints[entry.type.toLowerCase()+'s'] || [];
            const j = bucket.indexOf(entry.v);
            if (j >= 0) bucket.splice(j,1);
        }
        saveBotConfig(phoneNumber, botConfig);
        autoreactSessions.delete(phoneNumber);
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *ENDPOINTS_PRUNED* █▓▒░\n\n` +
            `   ✦ *REMOVED* :: ${idxs.length}\n\n` +
            `   " The void no longer\n     watches those paths. "`
        ), msg);
        return;
    }

    // .gpp / .getpp / .pfp — get a person's profile picture
    if (token === '.gpp' || token === '.getpp' || token === '.pfp') {
        let ppTarget = null;
        const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (quotedParticipant) ppTarget = jidNormalizedUser(quotedParticipant);
        else {
            const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (mentionedJid) ppTarget = jidNormalizedUser(mentionedJid);
        }
        if (!ppTarget && args[0]) {
            const digits = args[0].replace(/\D/g, "");
            if (digits.length >= 7) ppTarget = `${digits}@s.whatsapp.net`;
        }
        if (!ppTarget) ppTarget = jidNormalizedUser(senderJid);
        try {
            const ppUrl = await sock.profilePictureUrl(ppTarget, "image");
            const ppBuf = await fetchBuffer(ppUrl);
            const ppNum = ppTarget.split("@")[0];
            const caption = `${GROUP_CHANNEL_LINK}\n\n` + buildOmegaTerminal(
                `   ░▒▓█ *VISUAL_EXTRACT* █▓▒░\n\n` +
                `   [ 👁️ ] *TARGET* : +${ppNum}\n` +
                `   [ 📸 ] *ACTION* : PROFILE_PIC_PULL\n` +
                `   [ ✅ ] *RESULT* : ACQUIRED\n\n` +
                `   " *No face is hidden*\n     *from the all-seeing eye.* "`
            );
            await sock.sendMessage(remoteJid, { image: ppBuf, caption }, { quoted: msg });
        } catch (e) {
            await safeWaReply(sock, remoteJid, `❌ Could not fetch profile picture. They may have privacy settings on, or the number is invalid.\n\nError: ${e?.message}`, msg);
        }
        return;
    }

    // .ggpp / .grouppic — get a group's profile picture
    if (token === '.ggpp' || token === '.grouppic') {
        if (!remoteJid.endsWith('@g.us')) {
            await safeWaReply(sock, remoteJid, '❌ Only works inside a group.', msg);
            return;
        }
        try {
            const gpUrl = await sock.profilePictureUrl(remoteJid, "image");
            const gpBuf = await fetchBuffer(gpUrl);
            let gpName = remoteJid;
            try { const gpMeta = await sock.groupMetadata(remoteJid); gpName = gpMeta.subject; } catch (_) {}
            const caption = `${GROUP_CHANNEL_LINK}\n\n` + buildOmegaTerminal(
                `   ░▒▓█ *GROUP_VISUAL_EXTRACT* █▓▒░\n\n` +
                `   [ 👁️ ] *GROUP* : ${gpName}\n` +
                `   [ 📸 ] *ACTION* : GROUP_PIC_PULL\n` +
                `   [ ✅ ] *RESULT* : ACQUIRED\n\n` +
                `   " *Every domain has a face.*\n     *This one belongs to us.* "`
            );
            await sock.sendMessage(remoteJid, { image: gpBuf, caption }, { quoted: msg });
        } catch (e) {
            await safeWaReply(sock, remoteJid, `❌ Could not fetch group picture. The group may not have one set.\n\nError: ${e?.message}`, msg);
        }
        return;
    }

    // ──────────────────────────────────────────────
    // 🛠️ SYSTEM UTILITIES & OWNER TOOLS
    // ──────────────────────────────────────────────

    // .botinfo — about the bot
    if (token === '.botinfo') {
        const cmdCount = countSystemCommands();
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_IDENTITY* █▓▒░\n\n` +
            `   ⧓ *NAME* :: EVENTIDE OMEGA\n` +
            `   ⧓ *VERSION* :: v1.0.0_STABLE\n` +
            `   ⧓ *UPTIME* :: ${runtimeUptime()}\n` +
            `   ⧓ *COMMANDS* :: ${cmdCount}\n` +
            `   ⧓ *CORE* :: WA-MULTI-BOT\n\n` +
            `   " The eclipse does not\n     end. It only waits. "`
        ), msg);
        return;
    }

    // .alive — health splash
    if (token === '.alive') {
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *VESSEL_STATUS* █▓▒░\n\n` +
            `   💓 *STATE* :: ALIVE\n` +
            `   ⏱️ *UPTIME* :: ${runtimeUptime()}\n\n` +
            `   " The machine lives.\n     The void holds. "`
        ), msg);
        return;
    }

    // .profile — show the host account's own info
    if (token === '.profile') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : phoneNumber;
        let name = 'unknown', about = '';
        try { const pp = await sock.profilePictureUrl(myJid, 'image'); name = pp ? 'set' : 'none'; } catch (_) { name = 'none'; }
        try { const st = await sock.fetchStatus(myJid); about = (st && st[0]?.status) || ''; } catch (_) {}
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *VESSEL_IDENTITY* █▓▒░\n\n` +
            `   📱 *NUMBER* :: ${phoneNumber}\n` +
            `   👤 *NAME* :: ${botConfig.name || '(account default)'}\n` +
            `   🖼️ *PP* :: ${name}\n` +
            `   📝 *BIO* :: ${about || botConfig.bio || '(none)'}\n\n` +
            `   " This is the face the\n     void shows the world. "`
        ), msg);
        return;
    }

    // .reconnect — force reconnect current socket
    if (token === '.reconnect') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_RECONNECT* █▓▒░\n\n` +
            `   ⚡ *ACTION* :: FORCE_RECONNECT\n\n` +
            `   " The thread is severed\n     and rewoven. "`
        ), msg);
        setTimeout(() => { try { sock.end(undefined); } catch (_) {} }, 800);
        return;
    }

    // .logout — log out the paired account (delete session)
    if (token === '.logout') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CORE_LOGOUT* █▓▒░\n\n` +
            `   🔌 *ACTION* :: UNLINK_SESSION\n` +
            `   ⚠️ *NOTE* :: You will need to\n   re-pair this number after.\n\n` +
            `   " The vessel is released\n     back to the void. "`
        ), msg);
        setTimeout(() => {
            try { sock.logout().catch(()=>{}); } catch (_) {}
            safeRm(path.join(AUTH_DIR, phoneNumber));
            waSessions.delete(phoneNumber);
            webPairSessions.delete(phoneNumber);
            if (isSupabaseEnabled()) deleteSessionFromSupabase(phoneNumber);
        }, 1500);
        return;
    }

    // .sticker — reply to image/video -> make a sticker
    if (token === '.sticker') {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const qimg = quoted?.imageMessage;
        const qvid = quoted?.videoMessage;
        if (!qimg && !qvid) { await safeWaReply(sock, remoteJid, '❌ Reply to an image/video with .sticker to make a sticker.', msg); return; }
        try {
            const srcMsg = qimg ? { imageMessage: qimg } : { videoMessage: qvid };
            const sharpMod = loadSharp();
            if (!sharpMod) { await safeWaReply(sock, remoteJid, '❌ Sticker processing unavailable on this host.', msg); return; }
            const buf = await downloadMediaMessage({ message: srcMsg }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            let webp;
            if (qimg) {
                webp = await sharpMod(buf).resize(512, 512, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).webp().toBuffer();
            } else {
                webp = await sharpMod(buf, { animated: true }).resize(512, 512, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).webp().toBuffer();
            }
            await sock.sendMessage(remoteJid, { sticker: webp }, { quoted: msg });
        } catch (err) {
            logError('STICKER', 'sticker failed', err);
            await safeWaReply(sock, remoteJid, `❌ Could not make sticker. Error: ${err?.message}`, msg);
        }
        return;
    }

    // .toimg — reply to sticker -> convert to image
    if (token === '.toimg') {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const qstk = quoted?.stickerMessage;
        if (!qstk) { await safeWaReply(sock, remoteJid, '❌ Reply to a sticker with .toimg.', msg); return; }
        try {
            const sharpMod = loadSharp();
            if (!sharpMod) { await safeWaReply(sock, remoteJid, '❌ Image processing unavailable on this host.', msg); return; }
            const buf = await downloadMediaMessage({ message: { stickerMessage: qstk } }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            const png = await sharpMod(buf).png().toBuffer();
            await sock.sendMessage(remoteJid, { image: png }, { quoted: msg });
        } catch (err) {
            logError('TOIMG', 'toimg failed', err);
            await safeWaReply(sock, remoteJid, `❌ Could not convert sticker. Error: ${err?.message}`, msg);
        }
        return;
    }

    // .qr <text> — generate a QR code
    if (token === '.qr') {
        const data = args.join(' ').trim();
        if (!data) { await safeWaReply(sock, remoteJid, '❌ use: .qr <text-or-url>', msg); return; }
        try {
            const qrcodeMod = loadQrcode();
            if (!qrcodeMod) { await safeWaReply(sock, remoteJid, '❌ QR generation unavailable on this host.', msg); return; }
            const png = await qrcodeMod.toBuffer(data, { width: 512, margin: 1 });
            await sock.sendMessage(remoteJid, { image: png, caption: `${GROUP_CHANNEL_LINK}\n\n*QR GENERATED*` }, { quoted: msg });
        } catch (err) {
            await safeWaReply(sock, remoteJid, `❌ Could not generate QR. Error: ${err?.message}`, msg);
        }
        return;
    }

    // .calc <expr> — calculator
    if (token === '.calc') {
        const expr = args.join(' ').trim();
        if (!expr) { await safeWaReply(sock, remoteJid, '❌ use: .calc 5 + 3 * 2', msg); return; }
        try {
            // Safe-ish eval: allow only numbers and basic operators
            const clean = expr.replace(/[^0-9+\-*/(). %^]/g, '');
            const result = Function(`"use strict"; return (${clean});`)();
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *CALC_ENGINE* █▓▒░\n\n` +
                `   ✦ *INPUT* :: ${expr}\n` +
                `   ✦ *RESULT* :: ${result}\n\n` +
                `   " Numbers bend to my\n     will. "`
            ), msg);
        } catch (err) {
            await safeWaReply(sock, remoteJid, `❌ Invalid expression.`, msg);
        }
        return;
    }

    // .base64 enc|dec <text>
    if (token === '.base64') {
        const mode = args[0]?.toLowerCase();
        const data = args.slice(1).join(' ');
        if (!['enc','dec'].includes(mode) || !data) { await safeWaReply(sock, remoteJid, '❌ use: .base64 enc <text>  |  .base64 dec <base64>', msg); return; }
        try {
            const out = mode === 'enc' ? Buffer.from(data).toString('base64') : Buffer.from(data, 'base64').toString('utf8');
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *BASE64_ENGINE* █▓▒░\n\n` +
                `   ✦ *MODE* :: ${mode.toUpperCase()}\n` +
                `   ✦ *OUTPUT* :: ${out.slice(0,200)}\n\n` +
                `   " Encoding is but\n     a veil. "`
            ), msg);
        } catch (err) {
            await safeWaReply(sock, remoteJid, `❌ Could not ${mode}ode. Error: ${err?.message}`, msg);
        }
        return;
    }

    if (isGameCommand(token)) {
        const handled = await handleGameCommand({ sock, phoneNumber, remoteJid, senderJid, token, args });
        if (handled) return;
    }

    // 🎮 TIC TAC TOE — premium arena
    if (token === '.tictactoe' || token === '.ttt' || token === '.xo') {
      try {
        const sub = (args[0] || '').toLowerCase();
        const live = getTttGame(phoneNumber, remoteJid);
        if (sub === 'yes' || sub === 'accept') {
            const g = getTttGame(phoneNumber, remoteJid);
            if (!g || g.status !== 'pending') { await sock.sendMessage(remoteJid, { text: '❌ No pending challenge.' }); return; }
            if (!tttSamePlayer(senderJid, g.o) && !isSenderOwner) { await sock.sendMessage(remoteJid, { text: '❌ Only the challenged soul may accept.' }); return; }
            g.status = 'active';
            tttClearTimer(g);
            g.boardKey = null;
            await tttDeletePoll(sock, g);
            await tttPaint(sock, phoneNumber, g);
            tttArmTimer(sock, phoneNumber, g);
            return;
        }
        if (sub === 'no' || sub === 'decline') {
            const g = getTttGame(phoneNumber, remoteJid);
            if (g && g.status === 'pending') {
                tttClearTimer(g); await tttDeletePoll(sock, g); tttGames.delete(tttKey(phoneNumber, remoteJid));
                await sock.sendMessage(remoteJid, { text: '🕊 Challenge declined. The grid sleeps.' });
            }
            return;
        }
        if (sub === 'quit' || sub === 'end' || sub === 'stop' || sub === 'close') {
            if (live) { tttClearTimer(live); await tttDeletePoll(sock, live); tttGames.delete(tttKey(phoneNumber, remoteJid)); }
            await sock.sendMessage(remoteJid, { text: buildOmegaTerminal(`   ✦ *ARENA_CLOSED*\n\n   " You folded the grid. "`) });
            return;
        }
        if (sub === 'board' || sub === 'show') {
            if (!live) { await sock.sendMessage(remoteJid, { text: '❌ No live arena. *.ttt* to open one.' }); return; }
            live.boardKey = null;
            await tttPaint(sock, phoneNumber, live);
            return;
        }
        if (live && live.status === 'active' && /^[1-9]$/.test(sub)) {
            if (!tttIsReplyToBoard(msg, live)) {
                await sock.sendMessage(remoteJid, { text: '↪ Reply to the *board* with the number. A loose 5 in chat is just chat.' });
                return;
            }
            await tttTryMove(sock, phoneNumber, remoteJid, senderJid, parseInt(sub, 10) - 1, msg);
            return;
        }
        if (live && live.status === 'active') {
            await sock.sendMessage(remoteJid, {
                text: buildOmegaTerminal(
                    `   ░▒▓█ *ARENA_LIVE* █▓▒░\n\n` +
                    `   A grid is already breathing here.\n` +
                    `   *Reply to the board* with 1–9.\n` +
                    `   *.ttt quit*  folds it.\n` +
                    `   *.ttt board*  redraws it.`
                )
            });
            return;
        }
        const rival = resolveTargetJid(msg, args);
        if (rival) {
            await tttOfferChallenge(sock, phoneNumber, remoteJid, senderJid, rival);
            return;
        }
        if (['bot', 'easy', 'medium', 'hard', 'void'].includes(sub)) {
            const diff = sub === 'easy' || sub === 'hard' || sub === 'medium' ? sub : 'medium';
            await tttStart(sock, phoneNumber, remoteJid, {
                x: senderJid, o: 'BOT', vsBot: true, difficulty: diff,
                xLabel: await tttResolveLabel(sock, phoneNumber, senderJid, msg),
                oLabel: 'VOID',
                xIds: tttCollectIds(sock, phoneNumber, senderJid, msg)
            });
            return;
        }
        tttSetupSessions.set(phoneNumber, {
            step: 'mode', chat: remoteJid, host: senderJid,
            hostLabel: await tttResolveLabel(sock, phoneNumber, senderJid, msg),
            hostIds: tttCollectIds(sock, phoneNumber, senderJid, msg)
        });
        await sock.sendMessage(remoteJid, {
            text: buildOmegaTerminal(
                `   ░▒▓█ *EVENTIDE ARENA* █▓▒░\n\n` +
                `   TIC · TAC · TOE\n\n` +
                `   Pick a path below.\n` +
                `   • Void = 3 levels (easy / mid / hard)\n` +
                `   • Human = first Accept sits\n` +
                `   • Or *.ttt @user* to invite one soul\n\n` +
                `   Moves: *reply to the board* with 1–9.\n` +
                `   1 min a turn · 3 min of silence kills it.`
            )
        });
        const openPoll = await sendMenuPoll(sock, remoteJid, phoneNumber, 'OPEN THE GRID', ['Play vs Bot', 'Play vs Human'], ['ttt_vs_bot', 'ttt_vs_p']);
        const sess = tttSetupSessions.get(phoneNumber) || {};
        sess.modePollKey = openPoll?.key || null;
        tttSetupSessions.set(phoneNumber, sess);
        return;
      } catch (err) {
        logError('TTT', `${phoneNumber}: .ttt failed`, err);
        await safeWaReply(sock, remoteJid, `❌ Arena failed to open.\n${err?.message || err}\n\nTry *.ttt* again.`, msg).catch(() => {});
        return;
      }
    }

    // ──────────────────────────────────────────────
    // 🎲 FUN COMMANDS (Gemini-cooked, scored, no hardcoded lists)
    // ──────────────────────────────────────────────
    const funToken = token === '.pickup' || token === '.rizz' ? '.pickupline' : token;
    if (['.roast', '.pickupline', '.joke', '.compliment', '.flirt', '.rate', '.ship'].includes(funToken)) {
        const funTarget = resolveTargetJid(msg, args);
        const quotedText = extractQuotedPlainText(msg);
        const targetJid = funTarget || (quotedText ? (getQuotedContext(msg)?.participant || null) : null);
        const targetNum = targetJid ? String(jidNormalizedUser(targetJid)).split('@')[0] : '';
        const extra = args.filter(a => !a.startsWith('@') && !/^\d{7,}$/.test(a.replace(/\D/g, ''))).join(' ').trim();
        const mentions = [];
        if (targetJid) mentions.push(jidNormalizedUser(targetJid));

        let system = '';
        let prompt = '';
        let header = '';
        let minScore = 7;

        if (funToken === '.roast') {
            header = '🔥 *ROAST*';
            system = funRoastSystem();
            prompt =
                `Target name/number: ${targetNum || pushName || 'this person'}\n` +
                (quotedText ? `They said (USE THIS): """${quotedText.slice(0, 400)}"""\n` : 'No quoted message — roast their existence generally.\n') +
                (extra ? `Extra context from the commander: ${extra}\n` : '') +
                `Write a roast that would make a WhatsApp group screenshot it. Then score it.`;
        } else if (funToken === '.pickupline') {
            header = '💋 *PICKUP LINE*';
            system = `You write pickup lines that actually sound clever, a little dirty, a little sweet — the kind someone would really send. West African chat energy is welcome. No slurs. No non-con. 1-3 lines.\nOUTPUT EXACTLY:\nLINE: <the line>\nSCORE: <1-10>`;
            prompt = `Write a fresh pickup line${targetNum ? ` aimed at +${targetNum}` : ''}${quotedText ? ` inspired by them saying: "${quotedText.slice(0, 200)}"` : ''}${extra ? ` about: ${extra}` : ''}. Score it.`;
        } else if (funToken === '.joke') {
            header = '😂 *JOKE*';
            system = `You tell short jokes that land in a group chat. Observational or dark-lite. No slurs. 2-6 lines max.\nOUTPUT EXACTLY:\nJOKE: <the joke>\nSCORE: <1-10>`;
            prompt = `Tell a fresh joke${extra ? ` about: ${extra}` : ''}${quotedText ? ` riffing on: "${quotedText.slice(0, 200)}"` : ''}. Score it.`;
        } else if (funToken === '.compliment') {
            header = '✨ *COMPLIMENT*';
            system = `You give compliments that feel specific and a bit poetic, not cringe. 1-3 lines.\nOUTPUT EXACTLY:\nTEXT: <the compliment>\nSCORE: <1-10>`;
            prompt = `Compliment ${targetNum || 'this person'}${quotedText ? ` based on them saying: "${quotedText.slice(0, 200)}"` : ''}${extra ? `: ${extra}` : ''}. Score it.`;
            minScore = 6;
        } else if (funToken === '.flirt') {
            header = '😉 *FLIRT*';
            system = `You flirt in a WhatsApp voice — confident, funny, a little dangerous. 1-3 lines. No slurs. No non-con.\nOUTPUT EXACTLY:\nLINE: <the flirt>\nSCORE: <1-10>`;
            prompt = `Flirt with ${targetNum || 'them'}${quotedText ? ` they said: "${quotedText.slice(0, 200)}"` : ''}${extra ? ` vibe: ${extra}` : ''}. Score it.`;
        } else if (funToken === '.rate') {
            header = '📊 *RATE*';
            system = `You rate things out of 10 with a savage or funny one-liner explaining why. Be honest.\nOUTPUT EXACTLY:\nTEXT: <one or two lines ending with X/10>\nSCORE: <same number>`;
            prompt = quotedText
                ? `Rate this message out of 10 and explain in one savage/funny line:\n"""${quotedText.slice(0, 400)}"""`
                : `Rate ${targetNum || extra || 'this person'} out of 10 with one funny line.`;
            minScore = 1;
        } else if (funToken === '.ship') {
            header = '💘 *SHIP*';
            const ctx = getQuotedContext(msg);
            const mentioned = (ctx?.mentionedJid || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).slice(0, 2);
            const a = mentioned[0] || senderJid;
            const b = mentioned[1] || targetJid || remoteJid;
            mentions.length = 0;
            mentions.push(jidNormalizedUser(a));
            if (b) mentions.push(jidNormalizedUser(b));
            system = `You ship two people like a chaotic group admin. Give them a couple name, a percentage, and one unhinged sentence why. No slurs.\nOUTPUT EXACTLY:\nTEXT: <the ship>\nSCORE: <1-10>`;
            prompt = `Ship +${String(a).split('@')[0]} with +${String(b || a).split('@')[0]}. Score the take.`;
        }

        try {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            const out = await generateScoredFun(prompt, system, { minScore, tries: funToken === '.roast' ? 3 : 2, temperature: 0.95 });
            const mentionLine = targetNum && funToken !== '.ship' ? `@${targetNum}\n\n` : '';
            await sock.sendMessage(remoteJid, {
                text: `${header}\n\n${mentionLine}${out.body}`,
                mentions
            }, { quoted: msg });
        } catch (err) {
            logError('FUN', `${funToken} failed`, err);
            await safeWaReply(sock, remoteJid, `❌ The void refused to cook.\n${err?.message || err}\n\nSet GEMINI_API_KEY on Render if this keeps happening.`, msg);
        }
        return;
    }

    // .vv — unlock a view-once. Reply to the view-once (photo/video/voice).
    if (token === '.vv' || token === '.viewonce') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        try {
            const got = await downloadQuotedMedia(sock, msg);
            if (!got.isViewOnce) {
                await safeWaReply(sock, remoteJid, '❌ That is not a view-once. Reply to a *view-once* photo/video/voice with .vv', msg);
                return;
            }
            const content = {};
            if (got.type === 'imageMessage') { content.image = got.buffer; content.caption = got.node?.caption || ''; }
            else if (got.type === 'videoMessage') { content.video = got.buffer; content.caption = got.node?.caption || ''; }
            else if (got.type === 'audioMessage') { content.audio = got.buffer; content.ptt = !!got.node?.ptt; content.mimetype = got.node?.mimetype || 'audio/mp4'; }
            else if (got.type === 'stickerMessage') { content.sticker = got.buffer; }
            else { content.document = got.buffer; content.mimetype = got.node?.mimetype || 'application/octet-stream'; content.fileName = got.node?.fileName || 'viewonce'; }
            await sock.sendMessage(remoteJid, content, { quoted: msg });
        } catch (err) {
            logError('VV', 'viewonce failed', err);
            await safeWaReply(sock, remoteJid, `❌ Could not unlock that view-once.\n${err?.message || err}`, msg);
        }
        return;
    }

    // .block <number> — block on host account
    // .block — reply to/mention/provide a number to block that contact
    if (token === '.block') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply to a message, @mention, or provide a number.\nExample: .block @user  |  .block 23480...', msg); return; }
        const num = target.split('@')[0];
        try {
            await sock.updateBlockStatus(target, 'block');
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *BLOCK_CAST* █▓▒░\n\n` +
                `   ✦ *TARGET* :: +${num}\n` +
                `   ✦ *STATE* :: BLOCKED\n\n` +
                `   " They are cast from\n     the inner circle. "`
            ), msg);
        } catch (err) {
            await safeWaReply(sock, remoteJid, `❌ Could not block. Error: ${err?.message}`, msg);
        }
        return;
    }

    // .unblock <number>
    if (token === '.unblock') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        const target = resolveTargetJid(msg, args);
        if (!target) { await safeWaReply(sock, remoteJid, '❌ Reply to a message, @mention, or provide a number.\nExample: .unblock @user  |  .unblock 23480...', msg); return; }
        const num = target.split('@')[0];
        try {
            await sock.updateBlockStatus(`${num}@s.whatsapp.net`, 'unblock');
            await safeWaReply(sock, remoteJid, buildOmegaTerminal(
                `   ░▒▓█ *BLOCK_LIFTED* █▓▒░\n\n` +
                `   ✦ *TARGET* :: ${num}\n` +
                `   ✦ *STATE* :: UNBLOCKED\n\n` +
                `   " They may return\n     to the circle. "`
            ), msg);
        } catch (err) {
            await safeWaReply(sock, remoteJid, `❌ Could not unblock. Error: ${err?.message}`, msg);
        }
        return;
    }

    // .cmdstats — count of commands (dev)
    if (token === '.cmdstats') {
        if (!isSenderOwner && !isDevNumber(senderJid)) { await safeWaReply(sock, remoteJid, '❌ Owner/Dev only.', msg); return; }
        await safeWaReply(sock, remoteJid, buildOmegaTerminal(
            `   ░▒▓█ *CMD_STATS* █▓▒░\n\n` +
            `   ✦ *COMMANDS* :: ${countSystemCommands()}\n\n` +
            `   " A growing arsenal. "`
        ), msg);
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

    // 🛡️ ANTIDELETE: recover revoke events for any watched group / channel / contact.
    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of (Array.isArray(updates) ? updates : [])) {
            try {
                const refKey = extractRevokeRef(key, update);
                if (!refKey) continue;
                await handleAntideleteRevoke(sock, phoneNumber, key, refKey);
            } catch (err) { logError('ANTIDELETE', `${phoneNumber}: antidelete failed`, err); }
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

    // 🎉 WELCOME / GOODBYE — fire on member join / leave
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update || {};
        if (!id || !Array.isArray(participants)) return;
        try {
            const cfg = loadBotConfig(phoneNumber);
            const which = action === 'add' ? 'welcomeMsg' : action === 'remove' ? 'goodbyeMsg' : null;
            if (!which) return;
            const setting = (cfg[which] || {})[id];
            if (!setting || setting === 'off') return;
            for (const p of participants) {
                const num = p.split('@')[0];
                const name = num;
                let msgText;
                if (setting === 'default') {
                    msgText = which === 'welcomeMsg'
                        ? `*Welcome to the group, ${name}!* 👋\nEnjoy your stay under the eclipse.`
                        : `*Goodbye, ${name}.* The void will remember you.`;
                } else {
                    msgText = setting.replace(/{{name}}/g, name);
                }
                await sock.sendMessage(id, { text: msgText }).catch(()=>{});
                log('WELCOME', `${phoneNumber}: ${action} message for ${num} in ${id}`);
            }
        } catch (err) {
            logError('WELCOME', `${phoneNumber}: welcome/goodbye send failed`, err);
        }
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

// 💻 WEB PAIRING — initiate pairing for a phone number from the web page.
// Returns an object { ok, code?, error? }. Works without Telegram.
async function initiateWebPairing(phoneNumber) {
    log('WEBPAIR', `Starting web pairing flow for ${phoneNumber}`);
    try {
        const sessionCount = countStoredSessions();
        if (sessionCount >= MAX_USERS) {
            return { ok: false, error: `Server full. Max users reached: ${MAX_USERS}` };
        }
        // Check the number isn't already in use (scan stored session dirs)
        const dirs = getStoredSessionDirectories(AUTH_DIR);
        if (dirs.includes(phoneNumber)) {
            return { ok: false, error: 'That number already has a session. Use /disconnect or delete it.' };
        }

        const authDir = path.join(AUTH_DIR, phoneNumber);
        ensureDir(authDir);
        // Mark that we are waiting for a code on the web side
        webPairSessions.set(phoneNumber, { code: null, status: 'pending', createdAt: Date.now() });

        await createSocketForSession({ phoneNumber, tgId: null, authDir, isRestore: false });
        log('WEBPAIR', `${phoneNumber}: pairing socket created (web).`);
        return { ok: true };
    } catch (err) {
        logError('WEBPAIR', `${phoneNumber}: web pairing failed`, err);
        webPairSessions.delete(phoneNumber);
        return { ok: false, error: err?.message || 'Pairing failed' };
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

// ──────────────────────────────────────────────
// 📱 TELEGRAM COMMANDS (only registered when Telegram is enabled)
// ──────────────────────────────────────────────
if (tgBot) {
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

}
// ──────────────────────────────────────────────
// 🌐 EXPRESS
// ──────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/status', (req, res) => {
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

initWebApp(app, {
    express,
    waSessions,
    webPairSessions,
    initiateWebPairing,
    AUTH_DIR,
    MAX_USERS,
    countStoredSessions,
    safeRm,
    isSupabaseEnabled,
    deleteSessionFromSupabase,
    tgBot,
    log,
    logError,
    formatUptime
});

// ──────────────────────────────────────────────
// 🚀 MAIN

// ──────────────────────────────────────────────
// 🚀 MAIN
// ──────────────────────────────────────────────
async function main() {
    initGames({
        sendMenuPoll,
        buildOmegaTerminal,
        delay,
        jidNormalizedUser,
        log,
        logError,
        getQuotedContext
    });
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

    app.listen(PORT, '0.0.0.0', () => {
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
