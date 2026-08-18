# 🔍 Reaction Debug Report — eventide-original

**Date:** 2026-08-17 · **Commit base:** `a8a8456` (REACT-V4)

## TL;DR

The instant ⚡ command reaction (REACT-V4) code is **correct** — I proved it by
booting the real `index.js` with a stubbed Baileys socket and feeding it fake
WhatsApp messages (12/12 scenarios pass after the fixes below).

But **auto-react had two genuine bugs** that made it silently never fire for
contacts and channels:

| # | Bug | Impact |
|---|-----|--------|
| 1 | **Contact endpoint mismatch** — contacts are stored as digits (`2348011111111`) but compared against `jidNormalizedUser(remoteJid)` which returns the full JID (`2348011111111@s.whatsapp.net`). They can never be equal. | `.autoreact on` never reacts in DMs with configured contacts |
| 2 | **Channel endpoint dead code** — `isIgnoredRemoteJid()` returned `true` for every `@newsletter` JID, and `handleWhatsAppMessage` returns early on it — *before* the autoreact block. The `channels` branch was unreachable. | `.autoreact` never reacts to configured channels (same guard also blocked channel antidelete) |

## Fixes applied to `index.js`

1. **`isIgnoredRemoteJid()`** — no longer ignores `@newsletter`; a dedicated
   return *after* the AUTOREACT pass keeps channel posts out of the command flow.
2. **Autoreact contacts** — compare digits to digits
   (`String(jid).split('@')[0].replace(/\D/g,'')`), like the antidelete watcher
   already did correctly.
3. **Autoreact channels** — substring/full-JID match against stored channel
   refs (people store links, IDs, or full JIDs).
4. **⚡ command reaction** — now explicitly skips channel posts (channels get
   autoreact only, not ⚡/command handling).

## Proof

Offline harness (stub socket + real message pipeline), 12 scenarios:

- ✅ ⚡ on DM `.menu` (notify), ✅ ⚡ on `.ping` (append/offline delivery)
- ✅ ⚡ in groups with participant, ✅ custom prefix `>menu`
- ✅ stale >5 min skipped, ✅ plain chat text ignored, ✅ `fromMe` skipped
- ✅ owner-mode correctly blocks non-owners
- ✅ autoreact: group, **contact (after fix)**, **channel (after fix)**

## ⚠️ If it's STILL not reacting — check these first

1. **Stale deployment** — the commit history is a saga of reaction fixes. Your
   bot must print at boot:
   `⚡ REACT-V4 BUILD ACTIVE — in-handler reactions armed`
   If that line is missing you're running OLD code. On Render the boot script
   only auto-pulls from GitHub when `AUTO_UPDATE=true`; on the panel it
   auto-pulls by default. Redeploy after this fix.
   (`.settings` also shows `REACT :: V3_ARMED` when a current build is running.)
2. **Testing from the bot's own number** — messages from a linked device of the
   paired account arrive with `fromMe=true` and are deliberately not reacted to
   (anti-echo). Test from a *different* number.
3. **Owner mode** — `.mode owner` only allows reactions for the owner / DEV_NUMBERS.
4. **Autoreact is a two-step feature** — `.autoreact on` (owner-only) AND
   endpoints added via `.autoreactconfig`.
5. **Reactions on messages older than 5 minutes** are skipped by design.
6. **Check the logs** — every reaction outcome logs unconditionally:
   - `REACT … sending ⚡ now…` → `⚡ reaction SENT` = bot sent it (network/WA side if you don't see it)
   - `REACT … stale cmd … skipped` = freshness gate
   - `REACT … react FAILED …` = exception (read the error)
   - no `REACT` lines at all = handler never reached → old build or the gates above.
