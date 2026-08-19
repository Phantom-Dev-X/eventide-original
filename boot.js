// Panel boot + supervisor.
//
//  1) Stamps the local commit (CURRENT_COMMIT.txt) so the bot can show it.
//  2) Runs the bot (index.js) as a child process and keeps it alive.
//  3) Never exits — the panel's start command PID stays alive, logs stay in
//     the panel console.
//
// ⚠️ UPDATES: no auto-deploy anymore. New code is pulled ONLY from WhatsApp
// via .gitpull (dev only). This file never touches GitHub.
import './loadEnv.js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);

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

// Local stamp only — no network. The bot reads this for the deploy DM and
// .gitpull updates it after every successful pull.
function stampCommit() {
    if (!hasCmd('git --version') || !fs.existsSync(path.join(root, '.git'))) return;
    try {
        const hash = shQuiet('git rev-parse --short HEAD');
        const msg = shQuiet('git log -1 --pretty=%s');
        const line = `${hash} ${msg}`;
        fs.writeFileSync(path.join(root, 'CURRENT_COMMIT.txt'), `${line}\n`, 'utf8');
        console.log(`[SUPERVISOR] 📦 local commit: ${line}`);
    } catch (err) {
        console.log('[SUPERVISOR] could not read commit name:', err.message);
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
stampCommit();

if (!fs.existsSync(path.join(root, 'node_modules'))) {
    console.log('[SUPERVISOR] node_modules missing — npm install...');
    try {
        execSync('npm install --omit=dev --no-audit --no-fund', {
            cwd: root,
            stdio: 'inherit',
            timeout: 180000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
    } catch (err) {
        console.error('[SUPERVISOR] npm install failed:', err.message);
    }
}

startBot();
