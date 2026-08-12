// Eventide Omega website + auth + web pairing + dashboard APIs.
// Mounted on the existing Express app. Serves public/ at / (no redirect).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'web_users.json');
const ID_SESS_FILE = path.join(__dirname, 'web_id_sessions.json');

let deps = {};
let webUsers = {};
const webAuthTokens = {}; // token -> { email, createdAt }
const webIdSessions = {}; // sessionId -> { phone, email, status, code, connectedAt }
const pwResetTokens = {};

export function initWebApp(app, incoming) {
    deps = incoming || {};
    loadWebUsers();
    loadIdSessions();

    app.use((req, res, next) => {
        const origin = req.headers.origin || '';
        const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (origin) {
            if (!allowed.length || allowed.includes(origin) || allowed.includes('*')) {
                res.setHeader('Access-Control-Allow-Origin', origin);
            }
        }
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    app.use((req, res, next) => {
        req.cookies = {};
        const raw = req.headers.cookie;
        if (raw) {
            raw.split(';').forEach(c => {
                const [k, v] = c.trim().split('=');
                if (k && v) req.cookies[k] = decodeURIComponent(v);
            });
        }
        next();
    });

    app.use((req, res, next) => {
        const orig = res.cookie?.bind(res);
        res.cookie = (name, value, opts = {}) => {
            if (typeof orig === 'function') return orig(name, value, opts);
            const parts = [`${name}=${encodeURIComponent(value)}`];
            if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
            if (opts.httpOnly) parts.push('HttpOnly');
            parts.push(`Path=${opts.path || '/'}`);
            parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
            res.setHeader('Set-Cookie', parts.join('; '));
            return res;
        };
        res.clearCookie = (name) => {
            res.setHeader('Set-Cookie', `${name}=; Max-Age=0; Path=/`);
            return res;
        };
        next();
    });

    // Pages — send the file, do NOT redirect /
    const page = (file) => (req, res) => {
        const fp = path.join(PUBLIC_DIR, file);
        if (!fs.existsSync(fp)) return res.status(404).send('Not found');
        res.sendFile(fp);
    };
    app.get('/', page('index.html'));
    app.get('/index.html', page('index.html'));
    app.get('/login.html', page('login.html'));
    app.get('/signup.html', page('signup.html'));
    app.get('/forgot.html', page('forgot.html'));
    app.get('/pair.html', page('pair.html'));
    app.get('/pair', page('pair.html'));
    app.get('/dashboard.html', page('dashboard.html'));
    app.get('/features.html', page('features.html'));
    app.get('/newfeatures.html', page('newfeatures.html'));
    app.get('/go/channel', (req, res) => {
        const link = (process.env.GROUP_CHANNEL_LINK || '').trim();
        if (!link) return res.status(404).send('Channel link not configured');
        return res.redirect(302, link);
    });

    app.use(deps.express.static(PUBLIC_DIR));

    // ── Auth ──
    app.post('/api/auth/signup', (req, res) => {
        const { email, password, name } = req.body || {};
        if (!email || !password) return res.json({ ok: false, error: 'Email and password required' });
        loadWebUsers();
        const key = String(email).toLowerCase().trim();
        if (!key.includes('@')) return res.json({ ok: false, error: 'Enter a valid email' });
        if (String(password).length < 4) return res.json({ ok: false, error: 'Password too short' });
        if (webUsers[key]) return res.json({ ok: false, error: 'Account already exists' });
        webUsers[key] = {
            name: name || key.split('@')[0],
            email: key,
            password: hashPassword(password),
            createdAt: new Date().toISOString()
        };
        saveWebUsers();
        const token = createWebToken();
        webAuthTokens[token] = { email: key, createdAt: Date.now() };
        res.cookie('eo_token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        notifyTg(`👤 *New Web Signup*\n\n📧 \`${key}\`\n👤 ${webUsers[key].name}`);
        res.json({ ok: true, token, name: webUsers[key].name });
    });

    app.post('/api/auth/login', (req, res) => {
        const { email, password } = req.body || {};
        if (!email || !password) return res.json({ ok: false, error: 'Email and password required' });
        loadWebUsers();
        const key = String(email).toLowerCase().trim();
        const user = webUsers[key];
        if (!user || user.password !== hashPassword(password)) {
            return res.json({ ok: false, error: 'Invalid email or password' });
        }
        const token = createWebToken();
        webAuthTokens[token] = { email: key, createdAt: Date.now() };
        res.cookie('eo_token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        notifyTg(`🔑 *Web Login*\n\n📧 \`${key}\`\n👤 ${user.name}`);
        res.json({ ok: true, token, name: user.name });
    });

    app.get('/api/auth/me', (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.json({ ok: false });
        loadWebUsers();
        const user = webUsers[email];
        res.json({ ok: true, authed: true, email, name: user?.name || email });
    });

    app.post('/api/auth/logout', (req, res) => {
        const token = readToken(req);
        if (token) delete webAuthTokens[token];
        res.clearCookie('eo_token');
        res.json({ ok: true });
    });

    app.post('/api/auth/forgot-check', (req, res) => {
        const email = String(req.body?.email || '').toLowerCase().trim();
        if (!email) return res.json({ ok: false, error: 'Email required' });
        loadWebUsers();
        const generic = { ok: true, message: 'If an account exists for that email, a reset token has been sent to the admin.' };
        if (!webUsers[email]) return res.json(generic);
        pruneResetTokens();
        const token = crypto.randomBytes(24).toString('hex');
        pwResetTokens[token] = { email, expiresAt: Date.now() + 15 * 60 * 1000 };
        const msg = `🔐 *Password Reset Request*\n\n📧 \`${email}\`\n👤 ${webUsers[email].name || 'Unknown'}\n\n🔑 *Reset Token (share ONLY with the user):*\n\`${token}\`\n\n⏰ Expires in 15 minutes.`;
        const sent = notifyTg(msg);
        if (!sent) {
            deps.log?.('WEB', `Password reset token for ${email}: ${token}`);
        }
        res.json(generic);
    });

    app.post('/api/auth/reset-password', (req, res) => {
        const email = String(req.body?.email || '').toLowerCase().trim();
        const { password, token } = req.body || {};
        if (!email || !password || !token) return res.json({ ok: false, error: 'Email, token and new password required' });
        pruneResetTokens();
        const rec = pwResetTokens[token];
        if (!rec || rec.email !== email || rec.expiresAt < Date.now()) {
            return res.json({ ok: false, error: 'Invalid or expired reset token' });
        }
        loadWebUsers();
        if (!webUsers[email]) return res.json({ ok: false, error: 'Account not found' });
        webUsers[email].password = hashPassword(password);
        saveWebUsers();
        delete pwResetTokens[token];
        res.json({ ok: true });
    });

    // ── Pairing (Omega pair.html) ──
    app.post('/api/pair', async (req, res) => {
        try {
            const email = getAuthEmail(req);
            if (!email) return res.status(401).json({ ok: false, error: 'Authentication required' });
            const phone = String(req.body?.phone || '').replace(/\D/g, '');
            const force = !!req.body?.force;
            if (phone.length < 8 || phone.length > 15) {
                return res.json({ ok: false, error: 'Invalid phone number' });
            }
            const maxUsers = deps.MAX_USERS || 10;
            const stored = typeof deps.countStoredSessions === 'function' ? deps.countStoredSessions() : 0;
            if (stored >= maxUsers && !deps.waSessions?.has(phone)) {
                return res.json({ ok: false, error: `This server is full (max ${maxUsers} users).` });
            }

            if (force) await dropPhoneSession(phone);

            const live = deps.waSessions?.get(phone)?.sock;
            if (live?.user?.id && !force) {
                const sid = sidForPhone(phone, email) || createSid();
                webIdSessions[sid] = {
                    phone, email, status: 'connected',
                    code: null, connectedAt: new Date().toISOString()
                };
                saveIdSessions();
                return res.json({ ok: true, code: 'ALREADY', sessionId: sid, alreadyConnected: true });
            }

            const started = await deps.initiateWebPairing(phone);
            if (!started?.ok) return res.json({ ok: false, error: started?.error || 'Pairing failed' });

            const code = await waitForPairCode(phone, 28000);
            if (!code) return res.json({ ok: false, error: 'Failed to generate pairing code. Try again.' });

            const sessionId = createSid();
            const pretty = String(code).match(/.{1,4}/g)?.join('-') || code;
            webIdSessions[sessionId] = {
                phone, email, status: 'code_ready',
                code: pretty, connectedAt: null, pairingStartedAt: Date.now()
            };
            saveIdSessions();
            notifyTg(`📲 *Web Pairing Started*\n\n📞 \`${phone}\`\n📧 \`${email}\`\n🔑 \`${sessionId}\``);
            res.json({ ok: true, code: pretty, sessionId });
        } catch (e) {
            deps.logError?.('WEB-PAIR', 'pair failed', e);
            res.json({ ok: false, error: e.message || 'Pairing failed' });
        }
    });

    app.get('/api/status', (req, res) => {
        const id = String(req.query?.id || '');
        const sess = webIdSessions[id];
        if (!sess) return res.json({ ok: false, status: 'not_found' });
        const sock = deps.waSessions?.get(sess.phone)?.sock;
        let status = sess.status || 'waiting';
        if (sock?.user?.id) {
            status = 'connected';
            sess.status = 'connected';
            sess.connectedAt = sess.connectedAt || new Date().toISOString();
            saveIdSessions();
        }
        res.json({
            ok: true,
            status,
            phone: sess.phone,
            connectedAt: sess.connectedAt || null,
            botNumber: sock?.user?.id?.split(':')[0]?.split('@')[0] || null
        });
    });

    // Keep old endpoints so nothing else breaks
    app.post('/api/pair/start', async (req, res) => {
        const phone = String(req.body?.phone || '').replace(/\D/g, '');
        if (phone.length < 7) return res.json({ ok: false, error: 'Invalid number.' });
        const result = await deps.initiateWebPairing(phone);
        res.json(result);
    });
    app.get('/api/pair/status', (req, res) => {
        const phone = String(req.query?.phone || '').replace(/\D/g, '');
        const session = deps.webPairSessions?.get(phone);
        if (!session) return res.json({ ok: false, status: 'not_found' });
        const sock = deps.waSessions?.get(phone)?.sock;
        const connected = !!(sock && sock.user?.id);
        res.json({ ok: true, status: connected ? 'connected' : (session.status || 'waiting'), code: session.code || null, connected });
    });
    app.post('/api/pair/disconnect', async (req, res) => {
        const phone = String(req.body?.phone || '').replace(/\D/g, '');
        if (!phone) return res.json({ ok: false, error: 'No number given' });
        await dropPhoneSession(phone);
        res.json({ ok: true, message: `Disconnected ${phone}` });
    });

    // ── Dashboard session APIs ──
    app.get('/api/s/:sid/info', (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        const sess = webIdSessions[req.params.sid];
        if (!sock || !sess) return res.json({ ok: false, error: 'Session not found' });
        res.json({
            ok: true,
            connected: !!sock.user?.id,
            phone: sess.phone,
            email: sess.email || null,
            botNumber: sock.user?.id?.split(':')[0]?.split('@')[0] || null,
            platform: sock.authState?.creds?.platform || 'unknown',
            uptime: deps.formatUptime ? deps.formatUptime(process.uptime()) : String(Math.floor(process.uptime())),
            connectedAt: sess.connectedAt || null
        });
    });

    app.get('/api/s/:sid/groups', async (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        if (!sock) return res.json({ ok: false, error: 'Session not found' });
        try {
            const groups = await sock.groupFetchAllParticipating();
            const list = Object.entries(groups).map(([id, meta]) => ({
                id,
                name: meta.subject || 'Unknown',
                members: meta.participants?.length || 0,
                isAdmin: meta.participants?.some(p => {
                    const pNum = p.id?.split(':')[0]?.split('@')[0];
                    const botNum = sock.user?.id?.split(':')[0]?.split('@')[0];
                    return pNum === botNum && (p.admin === 'admin' || p.admin === 'superadmin');
                }) || false,
                announce: !!meta.announce
            }));
            res.json({ ok: true, groups: list });
        } catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.post('/api/s/:sid/send', async (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        if (!sock) return res.json({ ok: false, error: 'Session not found' });
        const { jid, message } = req.body || {};
        if (!jid || !message) return res.json({ ok: false, error: 'jid and message required' });
        try {
            await sock.sendMessage(jid, { text: String(message) });
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.get('/api/s/:sid/group/invite', async (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        if (!sock) return res.json({ ok: false, error: 'Session not found' });
        const jid = req.query?.jid;
        if (!jid) return res.json({ ok: false, error: 'jid required' });
        try {
            const code = await sock.groupInviteCode(jid);
            res.json({ ok: true, link: `https://chat.whatsapp.com/${code}` });
        } catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.post('/api/s/:sid/group/leave', async (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        if (!sock) return res.json({ ok: false, error: 'Session not found' });
        const groupJid = req.body?.groupJid;
        if (!groupJid) return res.json({ ok: false, error: 'groupJid required' });
        try {
            await sock.groupLeave(groupJid);
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.post('/api/s/:sid/group/revoke', async (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        if (!sock) return res.json({ ok: false, error: 'Session not found' });
        const groupJid = req.body?.groupJid;
        if (!groupJid) return res.json({ ok: false, error: 'groupJid required' });
        try {
            await sock.groupRevokeInvite(groupJid);
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.post('/api/s/:sid/toggle', async (req, res) => {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ ok: false, error: 'Not authenticated' });
        const sock = getWebSock(req.params.sid, email);
        if (!sock) return res.json({ ok: false, error: 'Session not found' });
        const { groupJid, setting, value } = req.body || {};
        try {
            if (setting === 'lock') {
                await sock.groupSettingUpdate(groupJid, value ? 'announcement' : 'not_announcement');
            }
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false, error: e.message }); }
    });

    app.get('/api/s/:sid/stream', (req, res) => {
        const email = getAuthEmail(req);
        if (!email) { res.status(401).end(); return; }
        const sess = webIdSessions[req.params.sid];
        if (!sess || (sess.email && sess.email !== email)) { res.status(403).end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('data: {"type":"connected"}\n\n');
        const interval = setInterval(() => {
            const s = webIdSessions[req.params.sid];
            const sock = s ? deps.waSessions?.get(s.phone)?.sock : null;
            res.write(`data: ${JSON.stringify({ type: 'status', connected: !!(sock && sock.user?.id) })}\n\n`);
        }, 5000);
        req.on('close', () => clearInterval(interval));
    });
}

function createWebToken() { return crypto.randomBytes(24).toString('hex'); }
function createSid() { return crypto.randomBytes(8).toString('hex'); }
function hashPassword(pw) { return crypto.createHash('sha256').update(String(pw)).digest('hex'); }

function loadWebUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) webUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {};
    } catch (_) { webUsers = {}; }
}
function saveWebUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(webUsers, null, 2)); } catch (_) {}
}
function loadIdSessions() {
    try {
        if (fs.existsSync(ID_SESS_FILE)) Object.assign(webIdSessions, JSON.parse(fs.readFileSync(ID_SESS_FILE, 'utf8')) || {});
    } catch (_) {}
}
function saveIdSessions() {
    try { fs.writeFileSync(ID_SESS_FILE, JSON.stringify(webIdSessions, null, 2)); } catch (_) {}
}

function readToken(req) {
    return req.cookies?.eo_token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
}
function getAuthEmail(req) {
    const token = readToken(req);
    if (!token || !webAuthTokens[token]) return null;
    return webAuthTokens[token].email || null;
}
function getWebSock(sessionId, callerEmail) {
    const sess = webIdSessions[sessionId];
    if (!sess || !sess.email || sess.email !== callerEmail) return null;
    return deps.waSessions?.get(sess.phone)?.sock || null;
}
function sidForPhone(phone, email) {
    return Object.keys(webIdSessions).find(id => webIdSessions[id].phone === phone && webIdSessions[id].email === email) || null;
}
function pruneResetTokens() {
    const now = Date.now();
    for (const [t, v] of Object.entries(pwResetTokens)) {
        if (v.expiresAt < now) delete pwResetTokens[t];
    }
}

async function waitForPairCode(phone, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const s = deps.webPairSessions?.get(phone);
        if (s?.code) return s.code;
        const sock = deps.waSessions?.get(phone)?.sock;
        if (sock?.user?.id) return s?.code || 'LINKED';
        await new Promise(r => setTimeout(r, 400));
    }
    return deps.webPairSessions?.get(phone)?.code || null;
}

async function dropPhoneSession(phone) {
    const session = deps.waSessions?.get(phone);
    if (session?.sock) { try { await session.sock.end(undefined); } catch (_) {} }
    deps.waSessions?.delete(phone);
    deps.webPairSessions?.delete(phone);
    if (typeof deps.safeRm === 'function') deps.safeRm(path.join(deps.AUTH_DIR || path.join(__dirname, 'sessions'), phone));
    if (typeof deps.isSupabaseEnabled === 'function' && deps.isSupabaseEnabled() && deps.deleteSessionFromSupabase) {
        try { await deps.deleteSessionFromSupabase(phone); } catch (_) {}
    }
}

function notifyTg(text) {
    const bot = deps.tgBot;
    const chat = process.env.TELEGRAM_BACKUP_CHANNEL || process.env.DEV_TELEGRAM_IDS?.split(',')[0];
    if (!bot || !chat) return false;
    bot.sendMessage(chat, text, { parse_mode: 'Markdown' }).catch(() => {});
    return true;
}
