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

## Ruin menu

**Message 1 — status panel:**
```
╔══〔 𖣘 EVENTIDE OMEGA 〕══════════❐
║ ╔══════════════════════════════◆
║ ║ 𖣘 USER: <bot name>
║ ║ 𖣘 PERSONA: RUIN
║ ║ 𖣘 HOST: RENDER · SUPABASE   (or PANEL · LOCAL)
║ ║ 𖣘 PREFIX: .
║ ║ 𖣘 CMDS: 102
║ ║ 𖣘 UPTIME: 0d - 0h - 0m - 58s
║ ║ 𖣘 MODE: PUBLIC
║ ║ 𖣘 STORAGE: 12.4 MB          (sessions folder size)
║ ║ 𖣘 TIME: 11:40 AM
║ ╚══════════════════════════════◆
╚══════════════════════════════════❐
```
**Message 2 — command index** grouped under ⚙ SYSTEM, 🛠 CONFIG, 🎮 FUN, 👥 GROUP,
wrapped to WhatsApp width, prefix-aware (shows your custom prefix if you set one).

## Persistence (Render + Panel both covered)

The choice is stored as `persona: 'eclipse' | 'ruin'` inside
`sessions/<phone>/bot_config.json` — the SAME config file that already holds
prefix/aliases/autoreact etc.:

- **Render (Supabase on):** `saveBotConfig()` triggers the existing debounced
  Supabase sync; on restart the session (including `bot_config.json`) is
  downloaded back via `restoreAllSessions()` → persona survives.
- **Panel (local storage):** the `sessions/` folder lives on the panel disk;
  boot's auto-pull only touches code files, never `sessions/` → persona survives.

Defaults: `'eclipse'` (existing users keep their current experience until they
pick a persona or run `.persona ruin`). `.reset` returns to eclipse.

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
