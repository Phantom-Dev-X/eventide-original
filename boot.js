// Panel boot + auto-deploy supervisor.
//
//  1) Boot sync: pull the latest commit from GitHub main (unless disabled).
//  2) Runs the bot (index.js) as a child process.
//  3) 🛰 AUTO-DEPLOY: polls GitHub every few minutes — when a new commit
//     appears it pulls it (npm-installs if package.json changed) and
//     restarts the child. No panel restart button needed.
//  4) Never exits — the panel's start command PID stays alive, logs stay in
//     the panel console.
//
// Env knobs:
//   AUTO_UPDATE              on/off — pull latest on boot (panel default: on)
//   AUTO_DEPLOY              on/off — poll GitHub while running (panel default: on)
//   AUTO_DEPLOY_POLL_MINUTES minutes between polls (default 3, fractional allowed, min 0.05)
//   DEPLOY_SECRET            optional secret for the POST /api/deploy webhook
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
const shouldUpdateOnBoot = isOn(auto) || (!isOff(auto) && panelMode);

// 🛰 AUTO-DEPLOY: panel default ON, Render default OFF (the platform redeploys
// from GitHub itself there).
const autoDeploy = flag('AUTO_DEPLOY');
const pollEnabled = autoDeploy === '' ? panelMode : isOn(autoDeploy);
const POLL_MIN = Math.max(0.05, parseFloat(process.env.AUTO_DEPLOY_POLL_MINUTES || '3') || 3);

function sh(cmd, timeoutMs = 30000) {
    execSync(cmd, {
        cwd: root,
        stdio: 'inherit',
        timeout: timeoutMs, // never let a sync op block the event loop forever — a
                            // queued SIGTERM handler must always be able to run
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
}

function hasCmd(cmd) {
    try {
        execSync(cmd, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function shQuiet(cmd, timeoutMs = 30000) {
    return execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }).trim();
}

function shNull(cmd) {
    try {
        execSync(cmd, {
            cwd: root,
            stdio: 'ignore',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
        return true;
    } catch {
        return false;
    }
}

function stampCommit(note) {
    try {
        const hash = shQuiet('git rev-parse --short HEAD');
        const msg = shQuiet('git log -1 --pretty=%s');
        const line = `${hash} ${msg}`;
        fs.writeFileSync(path.join(root, 'CURRENT_COMMIT.txt'), `${line}\n`, 'utf8');
        console.log('────────────────────────────────────────');
        console.log(`[UPDATE] ${note}`);
        console.log(`[UPDATE] COMMIT: ${line}`);
        console.log('────────────────────────────────────────');
        return line;
    } catch (err) {
        console.log('[UPDATE] could not read commit name:', err.message);
        return '';
    }
}

// Where auto-deploy pulls from. Overridable (e.g. a fork).
const REMOTE_URL = String(process.env.GIT_REMOTE_URL || 'https://github.com/Phantom-Dev-X/eventide-original.git').trim();

function ensureGit() {
    if (!hasCmd('git --version')) return false;
    try { sh('git config --global --add safe.directory ' + JSON.stringify(root)); } catch (_) {}
    const gitDir = path.join(root, '.git');
    if (!fs.existsSync(gitDir)) {
        console.log('[UPDATE] no .git yet — attaching origin');
        sh('git init');
    }
    if (!shNull(`git remote add origin ${REMOTE_URL}`)) {
        shNull(`git remote set-url origin ${REMOTE_URL}`);
    }
    return true;
}

// Pull latest main from GitHub. Installs deps when package.json changed.
function syncFromGithub(note) {
    if (!ensureGit()) {
        console.log('[UPDATE] git not installed in this image — skip auto-update');
        return '';
    }
    const before = shQuiet('git rev-parse HEAD');
    try { sh('git fetch --depth 1 origin main'); } catch (err) { console.error('[UPDATE] fetch failed:', err.message); }
    let remote = '';
    try { remote = shQuiet('git rev-parse origin/main'); } catch (_) {}
    let pkgBefore = '';
    try { pkgBefore = shQuiet('git rev-parse HEAD:package.json'); } catch (_) {}
    if (remote && before !== remote) {
        console.log(`[UPDATE] ${note} — new commit ${remote.slice(0, 7)}`);
        try { sh('git checkout -f -B main origin/main'); } catch (err) { console.error('[UPDATE] checkout failed:', err.message); }
    }
    let pkgAfter = '';
    try { pkgAfter = shQuiet('git rev-parse HEAD:package.json'); } catch (_) {}
    if (pkgBefore && pkgAfter && pkgBefore !== pkgAfter) {
        console.log('[UPDATE] package.json changed — npm install...');
        try { sh('npm install --omit=dev --no-audit --no-fund', 180000); } catch (err) { console.error('[UPDATE] npm install failed:', err.message); }
    }
    return stampCommit(note);
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
            syncFromGithub('restart sync');
            startBot();
        }, backoff);
    });
}

// ──────────────────────────────────────────────
// 🛰 AUTO-DEPLOY — poll GitHub while running
// ──────────────────────────────────────────────
let pollTimer = null;
if (pollEnabled) {
    console.log(`[AUTO-DEPLOY] 🛰 watching GitHub every ${POLL_MIN} min — pushes deploy automatically`);
    pollTimer = setInterval(() => {
        if (shuttingDown) return;
        try {
            if (!ensureGit()) return;
            const before = shQuiet('git rev-parse HEAD');
            try { shQuiet('git fetch --depth 1 origin main'); } catch (_) {}
            let remote = '';
            try { remote = shQuiet('git rev-parse origin/main'); } catch (_) {}
            if (remote && before !== remote) {
                console.log(`[AUTO-DEPLOY] 🚀 new commit detected (${remote.slice(0, 7)}) — deploying...`);
                syncFromGithub('auto-deploy');
                if (child) {
                    try { child.kill('SIGTERM'); } catch (_) {}
                } else {
                    startBot();
                }
            }
        } catch (err) {
            console.error('[AUTO-DEPLOY] poll failed:', err.message);
        }
    }, POLL_MIN * 60 * 1000);
} else {
    console.log('[AUTO-DEPLOY] off (AUTO_DEPLOY not enabled on this host)');
}

// ⚡ FAST GRACEFUL SHUTDOWN — Pterodactyl sends SIGTERM when Stop is pressed.
// Requirements:
//   • stop ALL background work instantly (clear the poll timer — no new
//     git/npm syncs start during shutdown)
//   • SIGTERM the bot child, WAIT for it to actually exit (so no orphan
//     process keeps the container alive — that's what made the panel hang on
//     "Server marked as offline..." and caused power action locks)
//   • SIGKILL the child if it doesn't die in ~2.5s (e.g. stuck in a sync op)
//   • hard-exit with code 0 no later than ~4s so the panel registers the stop
//     immediately
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[SUPERVISOR] SIGTERM/SIGINT received — fast shutdown...');

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

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
if (shouldUpdateOnBoot) {
    console.log('[UPDATE] checking GitHub main on boot…');
    syncFromGithub('boot sync');
} else {
    console.log('[UPDATE] auto-update off (Render / AUTO_UPDATE=false)');
    if (hasCmd('git --version') && fs.existsSync(path.join(root, '.git'))) stampCommit('auto-update off — this is the local commit');
}

if (!fs.existsSync(path.join(root, 'node_modules'))) {
    console.log('[UPDATE] node_modules missing — npm install...');
    try { sh('npm install --omit=dev --no-audit --no-fund', 180000); } catch (err) { console.error('[UPDATE] npm install failed:', err.message); }
}

startBot();
