import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sessions } from '../../db/schema.js';
import { readToken, clearSessionCookie } from '../../webauth.mjs';

export default async (req) => {
    const token = readToken(req);
    if (token) await db.delete(sessions).where(eq(sessions.token, token));

    return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
    });
};
