# Eventide Omega — Pterodactyl panel (no Supabase)

Render stays on Supabase (ephemeral disk).  
This panel box uses the **persistent volume** only.

## 🛰 Auto-deploy (push → live, no restart button)

The panel **auto-pulls from GitHub** and restarts the bot whenever you push a
commit. It also DMs your WhatsApp when the new build is online. Details:
**[AUTO_DEPLOY.md](./AUTO_DEPLOY.md)** — recommended start command is `npm start`
(boot.js supervises + auto-deploys); `node index.js` also self-updates.

## Startup command

```bash
npm install --omit=dev
npm start
```

(or `node index.js` — auto-deploy works either way)

Node **18+**. Docker image: `node:20-bookworm` (or whatever your host has ≥18).

## Environment (easiest: a `.env` file)

Most panel.na eggs only show Git boxes. You do **not** need a hidden “Environment” page.

**File Manager** → **New File** → name it exactly `.env` → paste:

```
USE_SUPABASE=false
MAX_USERS=15
DEV_NUMBERS=234xxxxxxxxxx
```

Do not put `PORT` in the file if the egg already injects `SERVER_PORT` (this bot reads that). If the site fails to open, add `PORT=20006` (your allocation).

**Or** put it on the start command (Startup → Command Run):

```bash
USE_SUPABASE=false MAX_USERS=15 npm start
```

## Environment (Server → Startup)

| Key | Value | Notes |
|---|---|---|
| `USE_SUPABASE` | `false` | **Required on panel.** Even if you paste Render keys, sync stays off. |
| `PORT` | your allocation port | Must match the Ptero port. |
| `MAX_USERS` | `10` | Or whatever you want. |
| `TELEGRAM_TOKEN` | optional | Skip if you only pair from the website. |
| `DEV_NUMBERS` | `234…` | Your WhatsApp, no `+`. |
| `GEMINI_API_KEY` | optional | `.roast` / help AI. |
| `ALLOWED_ORIGINS` | `https://your.vercel.app` | Only if the site is on Vercel. |

Do **not** set `SUPABASE_URL` / `SUPABASE_KEY` on this server.

## Disk

Point the server home at the persistent volume. These must survive restart:

- `sessions/` — WhatsApp logins
- `web_users.json` — site accounts
- `web_id_sessions.json`
- `user_map.json`

## Boot log you want

```
[SUPABASE] USE_SUPABASE=false — local disk only (panel mode). Cloud sync will not start.
[HTTP] Server listening on port …
```

If you see `Service initialized successfully`, a Render key leaked into this box. Set `USE_SUPABASE=false` and remove the two Supabase vars.

## Website

- **Panel only:** open `http://NODE-IP:PORT/` (pair / login) if the allocation is public.
- **Vercel + panel:** Vercel serves `public/`. Pairing still hits this Node process. The panel must be reachable from the internet (public IP:port or a domain). HTTPS on the panel (or a Vercel `/api` rewrite) if the site is `https://`.

## Do not share one Supabase with Render

Two bots + one number = WhatsApp kicks a session.  
Render = its Supabase. Panel = its disk. Separate users, separate pairs.
