// Loads .env from the app folder and from the process working directory.
// Does not override vars the panel / Render already set.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function parseEnvFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let n = 0;
    for (const line0 of raw.split(/\r?\n/)) {
        let line = line0.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7).trim();
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!key) continue;
        if (process.env[key] === undefined) {
            process.env[key] = val;
            n += 1;
        }
    }
    return n;
}

const appDir = path.dirname(fileURLToPath(import.meta.url));
const tried = [
    path.join(appDir, '.env'),
    path.join(process.cwd(), '.env')
];
const seen = new Set();
let loaded = 0;
let from = '';
for (const p of tried) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const n = parseEnvFile(abs);
    if (n) {
        loaded += n;
        from = abs;
    }
}
if (loaded) {
    console.log(`[ENV] loaded ${loaded} var(s) from ${from}`);
} else {
    console.log('[ENV] no .env file found next to index.js (or it was empty). Using panel/Render env only.');
}
