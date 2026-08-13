// Panel boot: load .env, optionally sync from GitHub main, then start the bot.
// Render (Supabase on) does not auto-pull unless AUTO_UPDATE=true.
import './loadEnv.js';
import { execSync } from 'child_process';
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
const shouldUpdate = isOn(auto) || (!isOff(auto) && panelMode);

function sh(cmd) {
    execSync(cmd, {
        cwd: root,
        stdio: 'inherit',
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

function shQuiet(cmd) {
    return execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }).trim();
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

if (shouldUpdate) {
    if (hasCmd('git --version')) {
        console.log('[UPDATE] checking GitHub main…');
        try {
            try { sh('git config --global --add safe.directory ' + JSON.stringify(root)); } catch (_) {}
            const gitDir = path.join(root, '.git');
            if (!fs.existsSync(gitDir)) {
                console.log('[UPDATE] no .git yet — attaching origin');
                sh('git init');
            }
            try {
                sh('git remote add origin https://github.com/Phantom-Dev-X/eventide-original.git');
            } catch {
                sh('git remote set-url origin https://github.com/Phantom-Dev-X/eventide-original.git');
            }
            sh('git fetch --depth 1 origin main');
            sh('git checkout -f -B main origin/main');
            stampCommit('files now match GitHub main (.env and sessions/ kept)');
        } catch (err) {
            console.error('[UPDATE] git sync failed, starting whatever is on disk:', err.message);
            stampCommit('running last local commit (pull failed)');
        }
    } else {
        console.log('[UPDATE] git not installed in this image — skip auto-update');
    }
} else {
    console.log('[UPDATE] auto-update off (Render / AUTO_UPDATE=false)');
    if (hasCmd('git --version') && fs.existsSync(path.join(root, '.git'))) stampCommit('auto-update off — this is the local commit');
}

await import('./index.js');
