// Hangman, Word Chain, Trivia, Riddle — quote-to-play, polls delete as you go.
import { HANGMAN, CHAIN_STARTERS, CHAIN_WORDS, TRIVIA, RIDDLES } from './gameData.js';

let d = {
    sendMenuPoll: async () => null,
    buildOmegaTerminal: (s) => s,
    delay: (ms) => new Promise(r => setTimeout(r, ms)),
    jidNormalizedUser: (j) => j,
    log: () => {},
    logError: () => {},
    getQuotedContext: () => null
};

export function initGames(deps) {
    d = { ...d, ...deps };
}

const hangmanGames = new Map();
const chainGames = new Map();
const triviaGames = new Map();
const riddleGames = new Map();
const hangmanSetup = new Map();
const triviaSetup = new Map();

function key(phone, chat) { return `${phone}:${chat}`; }
function short(jid) {
    const n = String(jid || '').split('@')[0].replace(/\D/g, '');
    return n ? '+' + n.slice(-10) : 'someone';
}
function samePlayer(a, b) {
    if (!a || !b) return false;
    if (d.jidNormalizedUser(a) === d.jidNormalizedUser(b)) return true;
    const da = String(a).split('@')[0].replace(/\D/g, '');
    const db = String(b).split('@')[0].replace(/\D/g, '');
    return !!(da && db && da === db);
}
function quotedId(msg) {
    const ctx = d.getQuotedContext(msg);
    return ctx?.stanzaId || ctx?.quotedMessage?.key?.id || null;
}
function isReplyTo(msg, msgKey) {
    if (!msgKey?.id) return false;
    return quotedId(msg) === msgKey.id;
}
async function delPoll(sock, pollKey) {
    if (!pollKey?.id) return;
    try { await sock.sendMessage(pollKey.remoteJid, { delete: pollKey }); } catch (_) {}
}
async function delVoted(sock, remoteJid, pollId) {
    if (!pollId) return;
    try { await sock.sendMessage(remoteJid, { delete: { remoteJid, id: pollId, fromMe: true } }); } catch (_) {}
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function clearTimer(obj, field = 'timer') {
    if (obj?.[field]) { clearTimeout(obj[field]); obj[field] = null; }
}

export function isGamePoll(ids) {
    if (!Array.isArray(ids)) return false;
    return ids.some(id => /^(hm_|ch_|tr_|rd_)/.test(String(id)));
}

export function isGameCommand(token) {
    return [
        '.hangman', '.hm',
        '.chain', '.wordchain', '.wc',
        '.trivia', '.quiz',
        '.riddle', '.hint'
    ].includes(token);
}

// ──────────────────────────────────────────────
// HANGMAN
// ──────────────────────────────────────────────
const HANG_ART = [
    '  +---+\n  |   |\n      |\n      |\n      |\n      |\n =====',
    '  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n =====',
    '  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n =====',
    '  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n =====',
    '  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n =====',
    '  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n =====',
    '  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n ====='
];
const HANG_LIVES = 6;

function hangMasked(word, guessed) {
    return word.split('').map(ch => (guessed.has(ch) ? ch.toUpperCase() : '_')).join(' ');
}

function renderHangman(g) {
    const art = HANG_ART[Math.min(g.wrong, HANG_ART.length - 1)];
    const hearts = '♥'.repeat(Math.max(0, HANG_LIVES - g.wrong)) + '○'.repeat(g.wrong);
    const used = [...g.guessed].sort().map(c => c.toUpperCase()).join(' ') || '—';
    let footer = `reply to THIS gallows with a letter\nor the full word · 90s a guess`;
    if (g.status === 'won') footer = `✦ SAVED · the word was ${g.word.toUpperCase()}`;
    if (g.status === 'lost') footer = `✦ HANGED · the word was ${g.word.toUpperCase()}`;
    return (
        '```\n' +
        '   ✦ EVENTIDE GALLOWS ✦\n\n' +
        art + '\n\n' +
        `WORD   ${hangMasked(g.word, g.guessed)}\n` +
        `USED   ${used}\n` +
        `LIVES  ${hearts}\n` +
        `MODE   ${g.open ? 'OPEN · anyone' : 'SOLO · host only'}\n\n` +
        footer + '\n```'
    );
}

function armHangman(sock, phone, g) {
    clearTimer(g);
    if (g.status !== 'live') return;
    g.timer = setTimeout(async () => {
        const live = hangmanGames.get(key(phone, g.chat));
        if (live !== g || g.status !== 'live') return;
        g.status = 'lost';
        clearTimer(g);
        await paintHangman(sock, phone, g, '\n⏳ Nobody guessed. The rope took them.');
    }, 90 * 1000);
}

async function paintHangman(sock, phone, g, extra = '') {
    const body = renderHangman(g) + (extra ? `\n${extra}` : '');
    try {
        if (g.boardKey) await sock.sendMessage(g.chat, { text: body, edit: g.boardKey });
        else {
            const sent = await sock.sendMessage(g.chat, { text: body });
            g.boardKey = sent?.key || null;
        }
    } catch (_) {
        const sent = await sock.sendMessage(g.chat, { text: body });
        g.boardKey = sent?.key || null;
    }
    if (g.status === 'won' || g.status === 'lost') {
        const poll = await d.sendMenuPoll(sock, g.chat, phone, '✦ GALLOWS ✦', ['🔁 Another word', '🕊 Leave'], ['hm_again', 'hm_close']);
        g.pollKey = poll?.key || null;
    }
}

async function startHangman(sock, phone, chat, host, { open, category }) {
    const pool = category === 'random'
        ? Object.values(HANGMAN).flat()
        : (HANGMAN[category] || Object.values(HANGMAN).flat());
    const word = pick(pool).toLowerCase();
    const prev = hangmanGames.get(key(phone, chat));
    if (prev) { clearTimer(prev); await delPoll(sock, prev.pollKey); }
    const g = {
        chat, host, open: !!open, category,
        word, guessed: new Set(), wrong: 0,
        status: 'live', boardKey: null, pollKey: null, timer: null
    };
    hangmanGames.set(key(phone, chat), g);
    await paintHangman(sock, phone, g);
    armHangman(sock, phone, g);
}

async function hangmanGuess(sock, phone, chat, player, raw) {
    const g = hangmanGames.get(key(phone, chat));
    if (!g || g.status !== 'live') return false;
    if (!g.open && !samePlayer(player, g.host)) {
        await sock.sendMessage(chat, { text: '❌ Solo gallows. Only the host may guess.' });
        return true;
    }
    const guess = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!guess) {
        await sock.sendMessage(chat, { text: '↪ Reply to the gallows with *one letter* or the *full word*.' });
        return true;
    }
    if (guess.length > 1) {
        if (guess === g.word) {
            for (const ch of g.word) g.guessed.add(ch);
            g.status = 'won';
            clearTimer(g);
            await paintHangman(sock, phone, g, `\n👑 ${short(player)} named the word.`);
            return true;
        }
        g.wrong += 1;
        if (g.wrong >= HANG_LIVES) {
            g.status = 'lost';
            clearTimer(g);
            await paintHangman(sock, phone, g, `\n💀 Wrong word from ${short(player)}.`);
            return true;
        }
        await paintHangman(sock, phone, g, `\n✖ ${short(player)} tried *${guess}* — not it.`);
        armHangman(sock, phone, g);
        return true;
    }
    if (g.guessed.has(guess)) {
        await sock.sendMessage(chat, { text: `Already carved: *${guess.toUpperCase()}*. Try another.` });
        return true;
    }
    g.guessed.add(guess);
    if (g.word.includes(guess)) {
        const done = g.word.split('').every(ch => g.guessed.has(ch));
        if (done) {
            g.status = 'won';
            clearTimer(g);
            await paintHangman(sock, phone, g, `\n👑 ${short(player)} pulled them off the rope.`);
            return true;
        }
        await paintHangman(sock, phone, g, `\n✔ ${guess.toUpperCase()} lives in the word.`);
        armHangman(sock, phone, g);
        return true;
    }
    g.wrong += 1;
    if (g.wrong >= HANG_LIVES) {
        g.status = 'lost';
        clearTimer(g);
        await paintHangman(sock, phone, g, `\n💀 ${guess.toUpperCase()} was the last miss.`);
        return true;
    }
    await paintHangman(sock, phone, g, `\n✖ No ${guess.toUpperCase()} in there.`);
    armHangman(sock, phone, g);
    return true;
}

// ──────────────────────────────────────────────
// WORD CHAIN
// ──────────────────────────────────────────────
function renderChain(g) {
    const last = g.words[g.words.length - 1];
    const need = last.slice(-1).toUpperCase();
    const board = g.words.slice(-8).map((w, i) => `  ${g.words.length - g.words.slice(-8).length + i + 1}. ${w}`).join('\n');
    const top = Object.entries(g.scores).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([j, s], i) => `  ${i + 1}. ${short(j)}  ·  ${s}`).join('\n') || '  —';
    let footer = `next word must start with  ${need}\nreply to THIS card · 60s · min 3 letters`;
    if (g.status === 'done') footer = 'chain snapped.';
    return (
        '```\n' +
        '   ✦ WORD CHAIN ✦\n\n' +
        board + '\n\n' +
        `NEED   ${need}…\n` +
        `USED   ${g.words.length} words\n\n` +
        'SCORE\n' + top + '\n\n' +
        footer + '\n```'
    );
}

function armChain(sock, phone, g) {
    clearTimer(g);
    if (g.status !== 'live') return;
    g.timer = setTimeout(async () => {
        const live = chainGames.get(key(phone, g.chat));
        if (live !== g || g.status !== 'live') return;
        g.status = 'done';
        clearTimer(g);
        await paintChain(sock, phone, g, '\n⏳ 60s of silence. The chain snapped.');
    }, 60 * 1000);
}

async function paintChain(sock, phone, g, extra = '') {
    const body = renderChain(g) + (extra ? `\n${extra}` : '');
    try {
        if (g.boardKey) await sock.sendMessage(g.chat, { text: body, edit: g.boardKey });
        else {
            const sent = await sock.sendMessage(g.chat, { text: body });
            g.boardKey = sent?.key || null;
        }
    } catch (_) {
        const sent = await sock.sendMessage(g.chat, { text: body });
        g.boardKey = sent?.key || null;
    }
}

async function startChain(sock, phone, chat, host) {
    const prev = chainGames.get(key(phone, chat));
    if (prev) clearTimer(prev);
    const start = pick(CHAIN_STARTERS);
    const g = {
        chat, host, status: 'live',
        words: [start], used: new Set([start]),
        scores: {}, boardKey: null, timer: null, lastAt: 0, lastPlayer: null
    };
    chainGames.set(key(phone, chat), g);
    await sock.sendMessage(chat, {
        text: d.buildOmegaTerminal(
            `   ░▒▓█ *WORD CHAIN* █▓▒░\n\n` +
            `   I open with *${start.toUpperCase()}*.\n` +
            `   Reply to the card with a word that\n` +
            `   starts with *${start.slice(-1).toUpperCase()}*.\n\n` +
            `   3+ letters · no repeats · 60s\n` +
            `   Loose chat is ignored.`
        )
    });
    await paintChain(sock, phone, g);
    armChain(sock, phone, g);
}

function validChainWord(word, g) {
    if (!/^[a-z]{3,16}$/.test(word)) return 'use 3–16 letters only.';
    const need = g.words[g.words.length - 1].slice(-1);
    if (word[0] !== need) return `must start with *${need.toUpperCase()}*.`;
    if (g.used.has(word)) return `*${word}* already walked this road.`;
    if (!CHAIN_WORDS.has(word)) return `*${word}* is not in the void lexicon.`;
    return null;
}

async function chainPlay(sock, phone, chat, player, raw) {
    const g = chainGames.get(key(phone, chat));
    if (!g || g.status !== 'live') return false;
    const word = String(raw || '').toLowerCase().trim();
    const err = validChainWord(word, g);
    if (err) {
        await sock.sendMessage(chat, { text: `❌ ${err}` });
        return true;
    }
    const now = Date.now();
    if (g.lastPlayer && samePlayer(player, g.lastPlayer) && now - g.lastAt < 2000) {
        await sock.sendMessage(chat, { text: '⏳ Breathe. 2s between your links.' });
        return true;
    }
    g.words.push(word);
    g.used.add(word);
    g.scores[player] = (g.scores[player] || 0) + 1;
    g.lastPlayer = player;
    g.lastAt = now;
    await paintChain(sock, phone, g, `\n✔ ${short(player)} → *${word}*`);
    armChain(sock, phone, g);
    return true;
}

// ──────────────────────────────────────────────
// TRIVIA
// ──────────────────────────────────────────────
function triviaPool(cat) {
    if (cat === 'mixed') return Object.values(TRIVIA).flat();
    return (TRIVIA[cat] || TRIVIA.general).slice();
}

function renderTrivia(g, reveal = false) {
    const i = g.index;
    const item = g.qs[i];
    if (!item) return '```\n   ✦ TRIVIA OVER ✦\n```';
    const lines = item.show.map((t, n) => {
        const mark = reveal ? (n === item.correct ? ' ✔' : (g.picked && g.picked[n] ? ' ✖' : '')) : '';
        return `  ${['A', 'B', 'C', 'D'][n]}. ${t}${mark}`;
    }).join('\n');
    return (
        '```\n' +
        `   ✦ TRIVIA  ·  Q${i + 1}/${g.qs.length} ✦\n` +
        `   ${g.catLabel}\n\n` +
        `   ${item.q}\n\n` +
        lines + '\n\n' +
        (reveal ? '   next in a breath…' : '   vote the poll · 25s') +
        '\n```'
    );
}

function triviaBoard(g) {
    const rows = Object.entries(g.scores).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '   nobody scored.';
    return rows.map(([j, s], i) => `   ${i + 1}. ${short(j)}  ·  ${s}`).join('\n');
}

function armTrivia(sock, phone, g) {
    clearTimer(g);
    if (g.status !== 'asking') return;
    g.timer = setTimeout(() => revealTrivia(sock, phone, g).catch(() => {}), 25 * 1000);
}

async function sendTriviaQ(sock, phone, g) {
    const item = g.qs[g.index];
    if (!item) return endTrivia(sock, phone, g);
    g.status = 'asking';
    g.answers = {};
    g.picked = {};
    const body = renderTrivia(g, false);
    try {
        if (g.boardKey) await sock.sendMessage(g.chat, { text: body, edit: g.boardKey });
        else {
            const sent = await sock.sendMessage(g.chat, { text: body });
            g.boardKey = sent?.key || null;
        }
    } catch (_) {
        const sent = await sock.sendMessage(g.chat, { text: body });
        g.boardKey = sent?.key || null;
    }
    await delPoll(sock, g.pollKey);
    const labels = item.show.map((t, i) => `${['A', 'B', 'C', 'D'][i]} · ${t}`.slice(0, 80));
    const ids = item.show.map((_, i) => 'tr_a' + i);
    const poll = await d.sendMenuPoll(sock, g.chat, phone, '✦ ANSWER ✦', labels, ids);
    g.pollKey = poll?.key || null;
    armTrivia(sock, phone, g);
}

async function revealTrivia(sock, phone, g) {
    if (g.status !== 'asking') return;
    g.status = 'reveal';
    clearTimer(g);
    await delPoll(sock, g.pollKey);
    g.pollKey = null;
    const item = g.qs[g.index];
    g.picked = {};
    for (const [who, idx] of Object.entries(g.answers)) {
        g.picked[idx] = true;
        if (idx === item.correct) g.scores[who] = (g.scores[who] || 0) + 1;
    }
    const body = renderTrivia(g, true);
    try { await sock.sendMessage(g.chat, { text: body, edit: g.boardKey }); }
    catch (_) {
        const sent = await sock.sendMessage(g.chat, { text: body });
        g.boardKey = sent?.key || null;
    }
    await d.delay(1800);
    const live = triviaGames.get(key(phone, g.chat));
    if (live !== g || g.status === 'dead') return;
    g.index += 1;
    if (g.index >= g.qs.length) return endTrivia(sock, phone, g);
    await sendTriviaQ(sock, phone, g);
}

async function endTrivia(sock, phone, g) {
    g.status = 'done';
    clearTimer(g);
    await delPoll(sock, g.pollKey);
    const body =
        '```\n   ✦ TRIVIA FINAL ✦\n\n' +
        triviaBoard(g) +
        '\n```';
    try { await sock.sendMessage(g.chat, { text: body, edit: g.boardKey }); }
    catch (_) { await sock.sendMessage(g.chat, { text: body }); }
    const poll = await d.sendMenuPoll(sock, g.chat, phone, '✦ TRIVIA ✦', ['🔁 Again', '🕊 Done'], ['tr_again', 'tr_close']);
    g.pollKey = poll?.key || null;
}

async function beginTrivia(sock, phone, chat, host, cat, count) {
    const labels = { general: 'GENERAL', science: 'SCIENCE', history: 'HISTORY', sports: 'SPORTS', naija: 'NAIJA', mixed: 'MIXED' };
    const pool = shuffle(triviaPool(cat));
    const take = pool.slice(0, Math.min(count, pool.length)).map(item => {
        const order = shuffle([0, 1, 2, 3]);
        const show = order.map(i => item.opts[i]);
        const correct = order.indexOf(item.a);
        return { q: item.q, show, correct };
    });
    const prev = triviaGames.get(key(phone, chat));
    if (prev) { clearTimer(prev); await delPoll(sock, prev.pollKey); }
    const g = {
        chat, host, cat, catLabel: labels[cat] || cat,
        qs: take, index: 0, answers: {}, scores: {},
        status: 'asking', boardKey: null, pollKey: null, timer: null
    };
    triviaGames.set(key(phone, chat), g);
    await sendTriviaQ(sock, phone, g);
}

// ──────────────────────────────────────────────
// RIDDLE
// ──────────────────────────────────────────────
function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function riddleHit(guess, accepted) {
    const g = norm(guess);
    if (!g) return false;
    return accepted.some(a => {
        const n = norm(a);
        if (!n) return false;
        if (g === n) return true;
        if (n.length >= 4 && (g.includes(n) || n.includes(g))) return true;
        return false;
    });
}

function renderRiddle(g, reveal = false) {
    let footer = 'reply to THIS riddle with your answer\n.hint for a clue · 2 min';
    if (reveal || g.status === 'solved') footer = `ANSWER  ${g.item.a[0].toUpperCase()}`;
    if (g.status === 'solved') footer = `SOLVED by ${short(g.winner)}\n${g.item.a[0].toUpperCase()}`;
    return (
        '```\n' +
        '   ✦ RIDDLE ✦\n\n' +
        `   ${g.item.q}\n\n` +
        `HINTS  ${g.hintsUsed}/${g.item.hints.length}\n` +
        footer + '\n```'
    );
}

function armRiddle(sock, phone, g) {
    clearTimer(g);
    if (g.status !== 'live') return;
    g.timer = setTimeout(async () => {
        const live = riddleGames.get(key(phone, g.chat));
        if (live !== g || g.status !== 'live') return;
        g.status = 'revealed';
        clearTimer(g);
        await paintRiddle(sock, phone, g, true, '\n⏳ Time. The answer walks free.');
    }, 2 * 60 * 1000);
}

async function paintRiddle(sock, phone, g, reveal = false, extra = '') {
    const body = renderRiddle(g, reveal) + (extra ? `\n${extra}` : '');
    try {
        if (g.boardKey) await sock.sendMessage(g.chat, { text: body, edit: g.boardKey });
        else {
            const sent = await sock.sendMessage(g.chat, { text: body });
            g.boardKey = sent?.key || null;
        }
    } catch (_) {
        const sent = await sock.sendMessage(g.chat, { text: body });
        g.boardKey = sent?.key || null;
    }
}

async function startRiddle(sock, phone, chat) {
    const prev = riddleGames.get(key(phone, chat));
    if (prev) clearTimer(prev);
    const used = prev?.used || new Set();
    const pool = RIDDLES.filter(r => !used.has(r.q));
    const item = pick(pool.length ? pool : RIDDLES);
    used.add(item.q);
    const g = { chat, item, hintsUsed: 0, status: 'live', winner: null, boardKey: null, timer: null, used };
    riddleGames.set(key(phone, chat), g);
    await paintRiddle(sock, phone, g);
    armRiddle(sock, phone, g);
}

async function riddleGuess(sock, phone, chat, player, text) {
    const g = riddleGames.get(key(phone, chat));
    if (!g || g.status !== 'live') return false;
    const t = String(text || '').trim();
    if (/^hint$/i.test(t) || t.toLowerCase() === '.hint') {
        return riddleHint(sock, phone, g);
    }
    if (riddleHit(t, g.item.a)) {
        g.status = 'solved';
        g.winner = player;
        clearTimer(g);
        await paintRiddle(sock, phone, g, true, `\n👑 ${short(player)} cracked it.`);
        return true;
    }
    await sock.sendMessage(chat, { text: `✖ Not it, ${short(player)}. Try again — or *.hint*` });
    return true;
}

async function riddleHint(sock, phone, g) {
    if (!g || g.status !== 'live') return true;
    if (g.hintsUsed >= g.item.hints.length) {
        await sock.sendMessage(g.chat, { text: 'No more hints. The void is quiet.' });
        return true;
    }
    const h = g.item.hints[g.hintsUsed];
    g.hintsUsed += 1;
    await paintRiddle(sock, phone, g, false, `\n💡 Hint ${g.hintsUsed}: ${h}`);
    return true;
}

// ──────────────────────────────────────────────
// PUBLIC HANDLERS
// ──────────────────────────────────────────────
export async function handleGameVote({ sock, remoteJid, phoneNumber, votedOptionId, pollId, voterJid }) {
    const id = String(votedOptionId || '');
    if (!/^(hm_|ch_|tr_|rd_)/.test(id)) return false;
    const voter = (!voterJid || voterJid === 'me') ? null : voterJid;

    // hangman setup
    if (id === 'hm_solo' || id === 'hm_open') {
        await delVoted(sock, remoteJid, pollId);
        const sess = hangmanSetup.get(phoneNumber) || { host: voter, chat: remoteJid };
        hangmanSetup.set(phoneNumber, { ...sess, open: id === 'hm_open', chat: remoteJid });
        await d.sendMenuPoll(sock, remoteJid, phoneNumber, '✦ WORD BAG ✦',
            ['🐾 Animals', '🍲 Food', '🌍 Places', '💻 Tech', '🎲 Random'],
            ['hm_cat_animals', 'hm_cat_food', 'hm_cat_places', 'hm_cat_tech', 'hm_cat_random']);
        return true;
    }
    if (id.startsWith('hm_cat_')) {
        await delVoted(sock, remoteJid, pollId);
        const cat = id.replace('hm_cat_', '');
        const sess = hangmanSetup.get(phoneNumber) || { host: voter, open: true, chat: remoteJid };
        hangmanSetup.delete(phoneNumber);
        await startHangman(sock, phoneNumber, remoteJid, sess.host || voter, { open: !!sess.open, category: cat });
        return true;
    }
    if (id === 'hm_again') {
        await delVoted(sock, remoteJid, pollId);
        const g = hangmanGames.get(key(phoneNumber, remoteJid));
        await startHangman(sock, phoneNumber, remoteJid, g?.host || voter, { open: g ? g.open : true, category: g?.category || 'random' });
        return true;
    }
    if (id === 'hm_close') {
        await delVoted(sock, remoteJid, pollId);
        const g = hangmanGames.get(key(phoneNumber, remoteJid));
        if (g) { clearTimer(g); await delPoll(sock, g.pollKey); }
        hangmanGames.delete(key(phoneNumber, remoteJid));
        await sock.sendMessage(remoteJid, { text: '🕊 Gallows folded.' });
        return true;
    }

    // trivia setup + answers
    if (id.startsWith('tr_cat_')) {
        await delVoted(sock, remoteJid, pollId);
        const cat = id.replace('tr_cat_', '');
        const sess = triviaSetup.get(phoneNumber) || { host: voter, chat: remoteJid };
        triviaSetup.set(phoneNumber, { ...sess, cat, chat: remoteJid });
        await d.sendMenuPoll(sock, remoteJid, phoneNumber, '✦ HOW MANY ✦', ['5 questions', '10 questions'], ['tr_n5', 'tr_n10']);
        return true;
    }
    if (id === 'tr_n5' || id === 'tr_n10') {
        await delVoted(sock, remoteJid, pollId);
        const sess = triviaSetup.get(phoneNumber) || { cat: 'mixed', host: voter, chat: remoteJid };
        triviaSetup.delete(phoneNumber);
        await beginTrivia(sock, phoneNumber, remoteJid, sess.host || voter, sess.cat || 'mixed', id === 'tr_n10' ? 10 : 5);
        return true;
    }
    if (id.startsWith('tr_a')) {
        const g = triviaGames.get(key(phoneNumber, remoteJid));
        if (!g || g.status !== 'asking') return true;
        const who = voter || 'anon';
        if (g.answers[who] !== undefined) return true;
        const idx = parseInt(id.replace('tr_a', ''), 10);
        if (!Number.isFinite(idx) || idx < 0 || idx > 3) return true;
        g.answers[who] = idx;
        return true;
    }
    if (id === 'tr_again') {
        await delVoted(sock, remoteJid, pollId);
        const g = triviaGames.get(key(phoneNumber, remoteJid));
        await beginTrivia(sock, phoneNumber, remoteJid, g?.host || voter, g?.cat || 'mixed', g?.qs?.length || 5);
        return true;
    }
    if (id === 'tr_close') {
        await delVoted(sock, remoteJid, pollId);
        const g = triviaGames.get(key(phoneNumber, remoteJid));
        if (g) { g.status = 'dead'; clearTimer(g); await delPoll(sock, g.pollKey); }
        triviaGames.delete(key(phoneNumber, remoteJid));
        await sock.sendMessage(remoteJid, { text: '🕊 Trivia closed.' });
        return true;
    }
    return false;
}

export async function handleGameText({ sock, phoneNumber, remoteJid, senderJid, msg, text }) {
    const raw = String(text || '').trim();
    // Dot-commands on a quoted board must not be eaten as guesses.
    if (/^[.!\/]/.test(raw)) return false;

    const hang = hangmanGames.get(key(phoneNumber, remoteJid));
    if (hang && hang.status === 'live' && isReplyTo(msg, hang.boardKey)) {
        return hangmanGuess(sock, phoneNumber, remoteJid, senderJid, raw);
    }

    const chain = chainGames.get(key(phoneNumber, remoteJid));
    if (chain && chain.status === 'live' && isReplyTo(msg, chain.boardKey)) {
        return chainPlay(sock, phoneNumber, remoteJid, senderJid, raw);
    }

    const rid = riddleGames.get(key(phoneNumber, remoteJid));
    if (rid && rid.status === 'live' && isReplyTo(msg, rid.boardKey)) {
        return riddleGuess(sock, phoneNumber, remoteJid, senderJid, raw);
    }
    return false;
}

export async function handleGameCommand({ sock, phoneNumber, remoteJid, senderJid, token, args }) {
    const sub = (args[0] || '').toLowerCase();

    if (token === '.hangman' || token === '.hm') {
        if (sub === 'quit' || sub === 'end' || sub === 'stop') {
            const g = hangmanGames.get(key(phoneNumber, remoteJid));
            if (g) { clearTimer(g); await delPoll(sock, g.pollKey); hangmanGames.delete(key(phoneNumber, remoteJid)); }
            await sock.sendMessage(remoteJid, { text: '🕊 Hangman folded.' });
            return true;
        }
        const live = hangmanGames.get(key(phoneNumber, remoteJid));
        if (live && live.status === 'live') {
            await sock.sendMessage(remoteJid, { text: 'A gallows is already up. *Reply to it* with a letter, or *.hangman quit*.' });
            return true;
        }
        hangmanSetup.set(phoneNumber, { host: senderJid, chat: remoteJid });
        await sock.sendMessage(remoteJid, {
            text: d.buildOmegaTerminal(
                `   ░▒▓█ *GALLOWS* █▓▒░\n\n` +
                `   Guess the word, letter by letter.\n` +
                `   6 misses and they hang.\n\n` +
                `   Reply to the gallows — loose\n` +
                `   letters in chat are ignored.`
            )
        });
        await d.sendMenuPoll(sock, remoteJid, phoneNumber, '✦ WHO GUESSES ✦', ['👤 Solo · only you', '👥 Open · anyone'], ['hm_solo', 'hm_open']);
        return true;
    }

    if (token === '.chain' || token === '.wordchain' || token === '.wc') {
        if (sub === 'quit' || sub === 'end' || sub === 'stop') {
            const g = chainGames.get(key(phoneNumber, remoteJid));
            if (g) {
                g.status = 'done';
                clearTimer(g);
                await paintChain(sock, phoneNumber, g, '\nHost snapped the chain.');
            }
            chainGames.delete(key(phoneNumber, remoteJid));
            return true;
        }
        const live = chainGames.get(key(phoneNumber, remoteJid));
        if (live && live.status === 'live') {
            await sock.sendMessage(remoteJid, { text: 'A chain is already live. *Reply to the card* with a word, or *.chain quit*.' });
            return true;
        }
        await startChain(sock, phoneNumber, remoteJid, senderJid);
        return true;
    }

    if (token === '.trivia' || token === '.quiz') {
        if (sub === 'quit' || sub === 'end' || sub === 'stop') {
            const g = triviaGames.get(key(phoneNumber, remoteJid));
            if (g) { g.status = 'dead'; clearTimer(g); await delPoll(sock, g.pollKey); }
            triviaGames.delete(key(phoneNumber, remoteJid));
            await sock.sendMessage(remoteJid, { text: '🕊 Trivia folded.' });
            return true;
        }
        const live = triviaGames.get(key(phoneNumber, remoteJid));
        if (live && (live.status === 'asking' || live.status === 'reveal')) {
            await sock.sendMessage(remoteJid, { text: 'Trivia is mid-round. Vote the poll, or *.trivia quit*.' });
            return true;
        }
        triviaSetup.set(phoneNumber, { host: senderJid, chat: remoteJid });
        await sock.sendMessage(remoteJid, {
            text: d.buildOmegaTerminal(
                `   ░▒▓█ *TRIVIA* █▓▒░\n\n` +
                `   Pick a bag of questions.\n` +
                `   Then how many.\n` +
                `   25 seconds a question.\n` +
                `   First vote locks.`
            )
        });
        await d.sendMenuPoll(sock, remoteJid, phoneNumber, '✦ CATEGORY ✦',
            ['🧠 General', '🔬 Science', '📜 History', '⚽ Sports', '🇳🇬 Naija', '🎲 Mixed'],
            ['tr_cat_general', 'tr_cat_science', 'tr_cat_history', 'tr_cat_sports', 'tr_cat_naija', 'tr_cat_mixed']);
        return true;
    }

    if (token === '.riddle') {
        if (sub === 'quit' || sub === 'end' || sub === 'skip') {
            const g = riddleGames.get(key(phoneNumber, remoteJid));
            if (g && g.status === 'live') {
                g.status = 'revealed';
                clearTimer(g);
                await paintRiddle(sock, phoneNumber, g, true, '\nSkipped.');
            } else {
                riddleGames.delete(key(phoneNumber, remoteJid));
                await sock.sendMessage(remoteJid, { text: 'No live riddle.' });
            }
            return true;
        }
        const live = riddleGames.get(key(phoneNumber, remoteJid));
        if (live && live.status === 'live') {
            await sock.sendMessage(remoteJid, { text: 'A riddle is already breathing. *Reply to it* with a guess, *.hint*, or *.riddle skip*.' });
            return true;
        }
        await startRiddle(sock, phoneNumber, remoteJid);
        return true;
    }

    if (token === '.hint') {
        const g = riddleGames.get(key(phoneNumber, remoteJid));
        if (!g || g.status !== 'live') {
            await sock.sendMessage(remoteJid, { text: 'No live riddle. *.riddle* first.' });
            return true;
        }
        await riddleHint(sock, phoneNumber, g);
        return true;
    }

    return false;
}
