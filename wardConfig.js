// Resolve group/channel invite links or JIDs, join if needed, list groups.

export function parseInviteOrJid(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const invite = t.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{8,})/i);
    if (invite) return { type: 'invite', code: invite[1] };
    const chan = t.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
    if (chan) return { type: 'channel_link', code: chan[1] };
    const raw = t.replace(/^<|>$/g, '').trim();
    if (raw.endsWith('@g.us')) return { type: 'group_jid', jid: raw };
    if (raw.endsWith('@newsletter')) return { type: 'channel_jid', jid: raw };
    if (/^\d{10,}@newsletter$/.test(raw)) return { type: 'channel_jid', jid: raw };
    if (/^\d{5,}-\d{5,}@g\.us$/.test(raw)) return { type: 'group_jid', jid: raw };
    return null;
}

export async function listParticipatingGroups(sock) {
    const g = await sock.groupFetchAllParticipating();
    return Object.entries(g || {})
        .map(([id, v]) => ({ id, name: String(v?.subject || id).trim() || id }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveAndJoinTarget(sock, raw) {
    const p = parseInviteOrJid(raw);
    if (!p) {
        return {
            ok: false,
            error: 'Invalid link or ID. Send a group invite (chat.whatsapp.com/…), a channel link, or a group/channel ID.'
        };
    }
    if (p.type === 'invite') {
        try {
            const jid = await sock.groupAcceptInvite(p.code);
            let name = jid;
            try { name = (await sock.groupMetadata(jid))?.subject || jid; } catch (_) {}
            return { ok: true, kind: 'group', jid, name, joined: true };
        } catch (e) {
            try {
                const info = await sock.groupGetInviteInfo(p.code);
                const jid = info?.id || info?.jid;
                if (jid) {
                    try { await sock.groupAcceptInvite(p.code); } catch (_) {}
                    return { ok: true, kind: 'group', jid, name: info.subject || jid, joined: true };
                }
            } catch (_) {}
            return { ok: false, error: `Could not join that group. ${e?.message || e}` };
        }
    }
    if (p.type === 'group_jid') {
        let inIt = false;
        let name = p.jid;
        try {
            const g = await sock.groupFetchAllParticipating();
            if (g?.[p.jid]) {
                inIt = true;
                name = g[p.jid].subject || p.jid;
            }
        } catch (_) {}
        if (!inIt) {
            return { ok: false, error: 'I am not in that group. Send an invite link so I can join first.' };
        }
        return { ok: true, kind: 'group', jid: p.jid, name, joined: false };
    }
    if (p.type === 'channel_link') {
        try {
            if (typeof sock.newsletterMetadata === 'function') {
                const meta = await sock.newsletterMetadata('invite', p.code);
                const jid = meta?.id || meta?.jid;
                if (!jid) return { ok: false, error: 'That channel link did not resolve.' };
                if (typeof sock.newsletterFollow === 'function') {
                    try { await sock.newsletterFollow(jid); } catch (_) {}
                }
                return { ok: true, kind: 'channel', jid, name: meta?.name || jid, joined: true };
            }
        } catch (e) {
            return { ok: false, error: `Could not follow that channel. ${e?.message || e}` };
        }
        return { ok: false, error: 'Channel follow is not supported on this WhatsApp build. Send the channel ID (…@newsletter).' };
    }
    if (p.type === 'channel_jid') {
        if (typeof sock.newsletterFollow === 'function') {
            try { await sock.newsletterFollow(p.jid); } catch (_) {}
        }
        return { ok: true, kind: 'channel', jid: p.jid, name: p.jid, joined: true };
    }
    return { ok: false, error: 'Invalid link or ID.' };
}
