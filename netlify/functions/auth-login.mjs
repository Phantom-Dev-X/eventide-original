import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users, sessions } from '../../db/schema.js';
import { verifyPassword, createToken, sessionCookie } from '../../webauth.mjs';

export default async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body = {};
    try { body = await req.json(); } catch { /* empty body */ }
    const { email, password } = body || {};

    if (!email || !password) return Response.json({ ok: false, error: 'Email and password required' });
    const key = String(email).toLowerCase().trim();

    const [user] = await db.select().from(users).where(eq(users.email, key));
    if (!user || !verifyPassword(password, user.passwordHash)) {
        return Response.json({ ok: false, error: 'Invalid email or password' });
    }

    const token = createToken();
    await db.insert(sessions).values({ token, userId: user.id });

    return new Response(JSON.stringify({ ok: true, token, name: user.name }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(token) },
    });
};
