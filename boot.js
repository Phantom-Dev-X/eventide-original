// Panel boot + supervisor.
//
//  1) BOOT SYNC (panel): on every panel restart this checks GitHub main — if
//     a new commit exists it pulls it (npm-installs if package.json changed)
//     and stamps BOOT_STATUS.txt so the bot DMs the owner on WhatsApp once
//     online ("new commit deployed" / "already on the latest commit").
//  2) Runs the bot (index.js) as a child process and keeps it alive.
//  3) Never exits — the panel's start command PID stays alive, logs stay in
//     the panel console.
//  4) NO polling while running — deploys after boot happen only via .gitpull
//     in WhatsApp (dev only).
//
// Env knobs:
//   AUTO_UPDATE    on/off — pull latest on boot (panel default: ON,
//                  Render default: OFF — the platform redeploys itself)
//   GIT_REMOTE_URL optional fork remote
import './loadEnv.js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);

function flag(name) {
    return String(process.env[name] || '').trim().toLowerCase();
}
function isOff(v) {
    return ['0', 'false', 'off', 'no', 'disabled'].includes(v);
}
function isOn(v) {
    return ['1', 'true', 'on', 'yes', 'enabled'].includes(v);
}

const panelMode = isOff(flag('USE_SUPABASE'));
const auto = flag('AUTO_UPDATE');
const shouldSyncOnBoot = isOn(auto) || (!isOff(auto) && panelMode);

const REMOTE_URL = String(process.env.GIT_REMOTE_URL || 'https://github.com/Phantom-Dev-X/eventide-original.git').trim();

function hasCmd(cmd) {
    try {
        execSync(cmd, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function shQuiet(cmd, timeoutMs = 60000) {
    return execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }).trim();
}

function shNull(cmd, timeoutMs = 60000) {
    try {
        execSync(cmd, {
            cwd: root,
            stdio: 'ignore',
            timeout: timeoutMs,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
        return true;
    } catch {
        return false;
    }
}

function shInherit(cmd, timeoutMs = 180000) {
    execSync(cmd, {
        cwd: root,
        stdio: 'inherit',
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
}

function stampCommit() {
    try {
        const hash = shQuiet('git rev-parse --short HEAD');
        const msg = shQuiet('git log -1 --pretty=%s');
        const line = `${hash} ${msg}`;
        fs.writeFileSync(path.join(root, 'CURRENT_COMMIT.txt'), `${line}\n`, 'utf8');
        console.log(`[UPDATE] COMMIT: ${line}`);
        return line;
    } catch (err) {
        console.log('[UPDATE] could not read commit:', err.message);
        return '';
    }
}

// One-shot boot status file — the bot reads + deletes it once WhatsApp is
// online and turns it into a DM for the owner.
function writeBootStatus(kind, hash, name) {
    try {
        fs.writeFileSync(path.join(root, 'BOOT_STATUS.txt'), `${kind}|${hash}|${name}\n`, 'utf8');
    } catch (_) {}
}

function ensureGit() {
    if (!hasCmd('git --version')) return false;
    try { shNull('git config --global --add safe.directory ' + JSON.stringify(root)); } catch (_) {}
    if (!fs.existsSync(path.join(root, '.git'))) {
        console.log('[UPDATE] no .git folder — initializing + attaching origin');
        try { shQuiet('git init'); } catch (_) {}
    }
    if (!shNull(`git remote add origin ${REMOTE_URL}`)) {
        shNull(`git remote set-url origin ${REMOTE_URL}`);
    }
    return true;
}

// Boot sync: fetch + deploy if there's a new commit.
// Writes BOOT_STATUS.txt: deployed|<hash>|<name> | latest|<hash>|<name> | skipped
function syncFromGithub() {
    if (!ensureGit()) {
        console.log('[UPDATE] git not installed — skipping boot sync');
        writeBootStatus('skipped', '', '');
        return;
    }
    try {
        console.log('[UPDATE] checking GitHub main…');
        let before = '';
        try { before = shQuiet('git rev-parse HEAD'); } catch (_) {
            console.log('[UPDATE] no local commit yet (fresh repo)');
        }
        try { shQuiet('git fetch --depth 1 origin main'); } catch (err) {
            console.error('[UPDATE] fetch failed (offline?) — keeping current build:', err.message);
            stampCommit();
            writeBootStatus('skipped', '', '');
            return;
        }
        let remote = '';
        try { remote = shQuiet('git rev-parse origin/main'); } catch (_) {}
        if (!remote) {
            console.log('[UPDATE] fetch gave no remote commit — skipping deploy');
            stampCommit();
            writeBootStatus('skipped', '', '');
            return;
        }
        if (before !== remote) {
            console.log(`[UPDATE] 🚀 new commit ${remote.slice(0, 7)} — deploying...`);
            let pkgBefore = '';
            try { pkgBefore = shQuiet('git rev-parse HEAD:package.json'); } catch (_) {}
            shQuiet('git checkout -f -B main origin/main');
            let pkgAfter = '';
            try { pkgAfter = shQuiet('git rev-parse HEAD:package.json'); } catch (_) {}
            if (pkgBefore && pkgAfter && pkgBefore !== pkgAfter) {
                console.log('[UPDATE] package.json changed — npm install...');
                try { shInherit('npm install --omit=dev --no-audit --no-fund'); } catch (err) {
                    console.error('[UPDATE] npm install failed:', err.message);
                }
            }
            const line = stampCommit();
            const hash = (line.split(' ')[0] || remote.slice(0, 7));
            const name = line.split(' ').slice(1).join(' ') || 'new commit';
            console.log(`[UPDATE] ✅ deployed: ${line}`);
            writeBootStatus('deployed', hash, name);
        } else {
            const line = stampCommit();
            const hash = (line.split(' ')[0] || remote.slice(0, 7));
            const name = line.split(' ').slice(1).join(' ') || 'unknown commit';
            console.log(`[UPDATE] ✅ already on the latest commit (${line})`);
            writeBootStatus('latest', hash, name);
        }
    } catch (err) {
        console.error('[UPDATE] boot sync failed:', err.message);
        writeBootStatus('skipped', '', '');
    }
}

// ──────────────────────────────────────────────
// 🧑‍✈️ SUPERVISOR — bot child process lifecycle
// ──────────────────────────────────────────────
let child = null;
let shuttingDown = false;
let lastExitAt = 0;

function startBot() {
    console.log('[SUPERVISOR] starting bot process (node index.js)...');
    child = spawn(process.execPath, ['index.js'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, EVENTIDE_SUPERVISED: '1' }
    });
    child.on('exit', (code, signal) => {
        console.log(`[SUPERVISOR] bot exited (code=${code}, signal=${signal || '-'})`);
        child = null;
        if (shuttingDown) return;
        const now = Date.now();
        const backoff = (now - lastExitAt < 30000) ? 15000 : 5000;
        lastExitAt = now;
        console.log(`[SUPERVISOR] restarting in ${backoff / 1000}s...`);
        setTimeout(() => {
            if (shuttingDown) return;
            startBot();
        }, backoff);
    });
}

// ⚡ FAST GRACEFUL SHUTDOWN — Pterodactyl sends SIGTERM when Stop is pressed.
//   • SIGTERM the bot child, WAIT for it to actually exit (no orphan process
//     keeps the container alive)
//   • SIGKILL the child if it doesn't die in ~2.5s
//   • hard-exit with code 0 no later than ~4s so the panel registers the stop
//     immediately — no "Server marked as offline..." hangs
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[SUPERVISOR] SIGTERM/SIGINT received — fast shutdown...');

    const finish = (note) => {
        console.log(`[SUPERVISOR] ${note} — exiting (code 0)`);
        process.exit(0);
    };

    if (!child) {
        finish('no child running');
        return;
    }

    // 1) ask the child to stop cleanly
    child.once('exit', () => finish('bot child exited cleanly'));
    try { child.kill('SIGTERM'); } catch (_) {}

    // 2) if the child is still alive after 2.5s, force it down
    setTimeout(() => {
        if (!child) return;
        console.log('[SUPERVISOR] child still alive — sending SIGKILL');
        try { child.kill('SIGKILL'); } catch (_) {}
    }, 2500).unref();

    // 3) absolute hard cap — the panel must never wait on us
    setTimeout(() => {
        if (!child) return;
        finish('hard stop (child did not die)');
    }, 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ──────────────────────────────────────────────
// 🚀 BOOT
// ──────────────────────────────────────────────
if (shouldSyncOnBoot) {
    syncFromGithub();
} else {
    console.log('[UPDATE] auto-update off (Render / AUTO_UPDATE=false)');
    stampCommit();
    writeBootStatus('skipped', '', '');
}

if (!fs.existsSync(path.join(root, 'node_modules'))) {
    console.log('[SUPERVISOR] node_modules missing — npm install...');
    try { shInherit('npm install --omit=dev --no-audit --no-fund'); } catch (err) {
        console.error('[SUPERVISOR] npm install failed:', err.message);
    }
}

startBot();
