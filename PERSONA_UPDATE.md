# 🎭 PERSONA SYSTEM — Eventide Omega

Two personas, chosen once at first pairing. The choice is permanent per session
(no re-pairing, no re-choosing on restarts).

## Flow

1. **First pairing** → the bot sends a welcome + a native WhatsApp poll:
   - 🌑 **ECLIPSE** — the original cinematic 3-stage animated menu (banner image + Owners/Group/Fun poll). This is the classic experience.
   - ⚙️ **RUIN** — clean, minimal, professional. No animations. A status panel + a categorized command index (SYSTEM / CONFIG / FUN / GROUP).
2. **On vote** → the poll is deleted, the choice is saved, the chosen menu is shown immediately.
3. **`.menu`** always renders the bound persona's menu. `.help` is unchanged.
4. **Switch anytime (owner only):** `.persona eclipse` / `.persona ruin`
   (`.persona` alone shows the current binding).

## 🔒 PERSONA GATE (new)

If the session has **no persona saved yet**, ANY command is blocked and the bot
asks for the persona pick instead of running:

- **DM (owner)** → persona prompt + poll. Commands only run after the vote.
- **While a poll is pending** → short "pick in the poll above 👆" nudge (no duplicate polls).
- **Groups (non-owner)** → "PERSONA LOCKED — ask the owner" (no poll spam in groups).
- **`.persona <eclipse|ruin>`** always passes the gate (manual setter).

Once `persona` is saved in config, the gate never triggers again — commands run
normally, on Render (Supabase restore) and panel (local disk) alike.

## Ruin menu

**Message 1 — status panel** (CODEx-style open frame, aligned borders, short lines):
```
╔══〔 𖣘 EVENTIDE OMEGA 〕═══════❐
║ ╔═══════════════════════════◆
║ ║ 𖣘 USER: <bot name>
║ ║ 𖣘 PERSONA: RUIN
║ ║ 𖣘 HOST: PANEL · LOCAL      (or RENDER · SUPABASE)
║ ║ 𖣘 PREFIX: .
║ ║ 𖣘 CMDS: 102
║ ║ 𖣘 UPTIME: 0d - 0h - 59m - 16s
║ ║ 𖣘 MODE: PUBLIC
║ ║ 𖣘 STORAGE: 173.5 KB
║ ║ 𖣘 TIME: 6:08 PM
║ ╚═══════════════════════════◆
╚══════════════════════════════❐
```
**Message 2 — menu poll:** ALL MENU · SYSTEM MENU · CONFIG MENU · GROUP MENU · FUN MENU.
Each vote opens its own framed view — ALL MENU shows the full command index
(⚙ SYSTEM / 🛠 CONFIG / 🎮 FUN / 👥 GROUP), and the four submenus show their
sections in matching boxes. Every view is one message, prefix-aware.

## Persistence (Render + Panel both covered)

The choice is stored as `persona: 'eclipse' | 'ruin'` inside
`sessions/<phone>/bot_config.json` — the SAME config file that already holds
prefix/aliases/autoreact etc.:

- **Render (Supabase on):** `saveBotConfig()` triggers the existing debounced
  Supabase sync; on restart the session (including `bot_config.json`) is
  downloaded back via `restoreAllSessions()` → persona survives.
- **Panel (local storage):** the `sessions/` folder lives on the panel disk;
  boot's auto-pull only touches code files, never `sessions/` → persona survives.

Defaults: `''` = **UNBOUND** — the persona gate asks on the first command.
Once picked (poll or `.persona`), the value is `'eclipse'` or `'ruin'`.
`.reset` returns to unbound (gate asks again on next command).

## Implementation notes

- Poll constants: `PERSONA_POLL_QUESTION/OPTIONS/IDS`
- Vote handling: `case 'persona_eclipse' / 'persona_ruin'` in `handleMenuVote()`
  (deletes poll via `personaPollKeys`, saves config, renders the chosen menu)
- Menu builders: `sendEclipseMenu()` (classic animation) and `sendRuinMenu()`
  (panel + `buildRuinCommandIndex()`)
- Welcome hook: the first-pairing `bootDmSent` block now sends the persona poll
  instead of the old two text DMs
- Verified offline with a stubbed Baileys socket: 12/12 scenarios pass
  (poll sent on first pair → vote deletes poll + persists choice → .menu
  renders the right persona → .persona switches back and forth)

## 🛎 Help AI persona (.helpconfig)

The help AI now has its own voice, separate from the menu persona:

- 🌑 **ECLIPSE** — the classic cinematic oracle (hype, terminal energy)
- 🛎 **RUIN** — friendly customer-care agent (warm, human, casual: "ohh, the
  antilink system! nice, let me walk you through it")

- **First `.help` while unbound** → the bot asks via a poll (deleted after the
  vote), choice saved forever.
- **`.helpconfig eclipse|ruin`** (owner only) switches the voice anytime;
  `.helpconfig` alone shows the current one (`ACTIVE :: RUIN` / `UNBOUND`).
- Both voices share the exact same fact sheet (full command registry +
  cheat sheet), so accuracy is identical — only the delivery changes.

## 🛡 Sudo system

`.addsudo` elevates a user so they can command the bot **even in owner mode**.

- **Target by reply** — reply to their message and send `.addsudo` (works in groups)
- **Or by number / mention** — `.addsudo 234939398382` or `.addsudo @234939398382`
- `.removesudo` / `.delsudo` revokes (same targeting) · `.sudos` lists them
- Owner/dev only; sudoes are **not** admins — they can *use* the bot in owner
  mode, but owner-only commands still reject them
- Persisted in `bot_config.json` per session → Supabase on Render / disk on
  panel; sudoes also get the ⚡ reaction on their commands in owner mode
