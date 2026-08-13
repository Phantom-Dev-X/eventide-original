// Shared password hashing + session cookie helpers for the Netlify Functions auth API.
import crypto from 'crypto';

export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createToken() {
    return crypto.randomBytes(24).toString('hex');
}

export function sessionCookie(token, maxAgeSeconds = 7 * 24 * 60 * 60) {
    return `eo_token=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie() {
    return 'eo_token=; Max-Age=0; Path=/';
}

export function readToken(req) {
    const auth = req.headers.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const cookie = req.headers.get('cookie') || '';
    const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('eo_token='));
    return match ? decodeURIComponent(match.slice('eo_token='.length)) : null;
}
