import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users, sessions } from '../../db/schema.js';
import { readToken } from '../../webauth.mjs';

export default async (req) => {
    const token = readToken(req);
    if (!token) return Response.json({ ok: false });

    const [session] = await db.select().from(sessions).where(eq(sessions.token, token));
    if (!session) return Response.json({ ok: false });

    const [user] = await db.select().from(users).where(eq(users.id, session.userId));
    if (!user) return Response.json({ ok: false });

    return Response.json({ ok: true, authed: true, email: user.email, name: user.name });
};
