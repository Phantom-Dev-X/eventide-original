# 🛰 AUTO-DEPLOY — Eventide Omega

Push to GitHub → the panel pulls + restarts the bot automatically. **No restart
button needed.** And the bot DMs your WhatsApp when the new build is live.

## How it works

### Panel (recommended: run `npm start`, i.e. `node boot.js`)

`boot.js` is now a **supervisor**:

1. On boot it pulls the latest commit from GitHub main (auto-installs deps if
   `package.json` changed, or if `node_modules` is missing).
2. It runs the bot (`index.js`) as a child process — the supervisor PID stays
   alive, so the panel console keeps showing all logs.
3. Every few minutes it polls GitHub (`git fetch`, no API keys needed). When a
   **new commit** appears:
   ```
   [AUTO-DEPLOY] 🚀 new commit detected (82a8cc3) — deploying...
   [UPDATE] auto-deploy — new commit 82a8cc3
   [SUPERVISOR] bot exited (code=0)
   [SUPERVISOR] restarting in 5s...
   [SUPERVISOR] starting bot process (node index.js)...
   ```
4. The bot restarts with the new code. Sessions (`sessions/`) are untouched —
   nobody re-pairs.

### Panel (if you run `node index.js` directly)

`index.js` has the same poller built in: on a new commit it pulls, installs deps
if needed, spawns a fresh copy of itself and exits (the new process waits ~3.5s
before binding the port so there's no EADDRINUSE clash).

### Render

Auto-deploy is **off by default** (the platform redeploys from GitHub itself).
If you want Render to poll too, set `AUTO_DEPLOY=true`.

## Env knobs

| Key | Default | Notes |
|---|---|---|
| `AUTO_DEPLOY` | panel: **on** · Render: **off** | `on`/`off` |
| `AUTO_DEPLOY_POLL_MINUTES` | `3` | how often to check GitHub (fractional allowed, e.g. `1` = every minute) |
| `AUTO_UPDATE` | panel: **on** · Render: **off** | pull latest once at boot |
| `GIT_REMOTE_URL` | `https://github.com/Phantom-Dev-X/eventide-original.git` | point at a fork if you ever need to |
| `DEPLOY_SECRET` | *(unset)* | if set, the webhook requires header `x-deploy-secret: <secret>` |

## Instant deploy webhook (optional)

`POST /api/deploy` → pulls latest + restarts immediately.

- No `DEPLOY_SECRET` set → anyone who can reach the URL can trigger it
  (panel IPs are usually fine, but set the secret if the panel is exposed).
- With `DEPLOY_SECRET=xyz`:
  ```
  curl -X POST -H "x-deploy-secret: xyz" http://<panel-ip>:<port>/api/deploy
  ```

## 📣 Deploy DM on WhatsApp

Every time the running commit changes (auto or manual deploy), the bot DMs its
own WhatsApp:

```
🔄 DEPLOY COMPLETE

✅ eventide omega is online
📦 commit: 82a8cc3

⚡ ready — type .ping to test.
```

Gated by the commit hash (stored per session in `bot_config.json`), so
reconnects/redeploys of the **same** commit never re-spam.

## 📊 Reading the logs — when is the bot ready to answer?

After every deploy/restart, watch the panel console for these lines in order:

```
[BUILD] 📦 running commit: 82a8cc3 B: v2          ← what's running
[BUILD] ✅ BUILD DONE in 3.2s — HTTP is up.        ← code fully loaded
[BUILD] ⏳ sockets connecting...                  ← WhatsApp connecting
[READY] 234…: ⚡ SESSION READY — the bot is        ← ✅ THIS is when .ping will respond
        responding now. Type .ping in WhatsApp
        to confirm.
```

**Rule of thumb:** wait for the `SESSION READY` line (usually a few seconds
after `BUILD DONE`), then type `.ping`. If the connection is slow it can take
up to ~30s — the READY line removes the guesswork.

## ⚡ Fast shutdown (panel Stop button)

Pterodactyl sends **SIGTERM** when you press Stop. Both `boot.js` (supervisor)
and `index.js` (bot) now catch SIGTERM/SIGINT and exit **immediately with code 0**
so the panel registers the stop right away — no more "Server marked as
offline..." hang, no power action lock errors.

What happens on Stop:

1. **Background work stops instantly** — the auto-deploy poll timer is cleared,
   so no new git/npm syncs can start during shutdown.
2. **Connections closed** (best-effort, never blocking): Telegram polling,
   WhatsApp sockets, HTTP server.
3. **`process.exit(0)` immediately.**
4. Supervisor mode also **waits for the bot child to actually die** (SIGKILL
   after 2.5s if it's stuck, e.g. inside a git/npm sync op) — no orphan
   processes keep the container alive.

Every blocking git/npm call now also has a hard `timeout`, so a hung network
can never freeze the event loop and delay the shutdown handler.

Measured: bot exits in ~10ms, supervisor with a healthy child ~50ms, worst
case (stuck child) ~2.5s. All with exit code 0 and no orphan processes.

⚠️ Set the panel **startup command to `node boot.js`** — if you use `npm start`,
npm becomes the main process and doesn't reliably forward SIGTERM to its
child, which reproduces the exact hang you saw.
