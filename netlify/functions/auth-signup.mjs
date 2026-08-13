import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users, sessions } from '../../db/schema.js';
import { hashPassword, createToken, sessionCookie } from '../../webauth.mjs';

export default async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body = {};
    try { body = await req.json(); } catch { /* empty body */ }
    const { email, password, name } = body || {};

    if (!email || !password) return Response.json({ ok: false, error: 'Email and password required' });
    const key = String(email).toLowerCase().trim();
    if (!key.includes('@')) return Response.json({ ok: false, error: 'Enter a valid email' });
    if (String(password).length < 4) return Response.json({ ok: false, error: 'Password too short' });

    const existing = await db.select().from(users).where(eq(users.email, key));
    if (existing.length) return Response.json({ ok: false, error: 'Account already exists' });

    const [user] = await db.insert(users).values({
        name: name || key.split('@')[0],
        email: key,
        passwordHash: hashPassword(password),
    }).returning();

    const token = createToken();
    await db.insert(sessions).values({ token, userId: user.id });

    return new Response(JSON.stringify({ ok: true, token, name: user.name }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(token) },
    });
};
