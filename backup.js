// Local rotating backups for panel disk (accounts + WhatsApp sessions).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_ROOT = path.join(root, 'backups');
const KEEP = Math.max(2, parseInt(process.env.BACKUP_KEEP || '7', 10) || 7);
const EVERY_MS = Math.max(30, parseInt(process.env.BACKUP_EVERY_MIN || '360', 10) || 360) * 60 * 1000;

const PATHS = [
    'sessions',
    'web_users.json',
    'web_id_sessions.json',
    'user_map.json',
    '.env'
];

function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return 0;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        let n = 0;
        for (const name of fs.readdirSync(src)) {
            n += copyRecursive(path.join(src, name), path.join(dest, name));
        }
        return n;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return 1;
}

function pruneOld(log) {
    if (!fs.existsSync(BACKUP_ROOT)) return;
    const dirs = fs.readdirSync(BACKUP_ROOT)
        .filter(n => n.startsWith('snap-'))
        .sort()
        .reverse();
    for (const extra of dirs.slice(KEEP)) {
        fs.rmSync(path.join(BACKUP_ROOT, extra), { recursive: true, force: true });
        log?.('BACKUP', `pruned old snapshot ${extra}`);
    }
}

export function runLocalBackup(reason = 'manual', log = console.log, logError = console.error) {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(BACKUP_ROOT, `snap-${stamp}`);
        fs.mkdirSync(dest, { recursive: true });
        let files = 0;
        for (const rel of PATHS) {
            files += copyRecursive(path.join(root, rel), path.join(dest, rel));
        }
        pruneOld(log);
        log?.('BACKUP', `snapshot ${path.basename(dest)} (${files} file(s), reason=${reason})`);
        return dest;
    } catch (err) {
        logError?.('BACKUP', 'snapshot failed', err);
        return null;
    }
}

export function startLocalBackups({ log, logError } = {}) {
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    setTimeout(() => runLocalBackup('boot', log, logError), 8000);
    setInterval(() => runLocalBackup('schedule', log, logError), EVERY_MS);
    log?.('BACKUP', `local snapshots on — keep ${KEEP}, every ${Math.round(EVERY_MS / 60000)} min`);
}
