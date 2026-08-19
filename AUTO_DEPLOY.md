# 🛰 DEPLOYING — .gitpull from WhatsApp

**Auto-deploy (polling) has been removed.** Deploying is now fully manual and
instant, straight from WhatsApp:

## .gitpull (dev only)

```
You:  .gitpull
Bot:  ⏳ GIT SYNC :: checking git...
Bot:  🚀 GIT SYNC :: found a new commit!
         "feat: something awesome"
         deploying...
Bot:  ✅ COMMIT DEPLOYED SUCCESSFULLY
         "feat: something awesome"
         (781beb9)
         ⚡ restarting with the new build...
```

- **Dev only** — anyone else gets `❌ Dev only.`
- Shows the **commit name** at every stage.
- If there's nothing new: `✅ already on the latest commit` (no restart).
- If the folder has no `.git` (files copied without history), it **clones in
  place** (init + attach origin + fetch + checkout).
- If `package.json` changed, it runs `npm install` automatically before
  restarting.
- Restart: supervised (`node boot.js`) = clean exit + respawn; direct
  `node index.js` = self-relaunch with a port-handoff delay (no EADDRINUSE).
- Works even before the persona is picked (bypasses the persona gate).

## Deploy flow

```
push to GitHub → type .gitpull in WhatsApp → bot updates itself in seconds
```

No panel, no restart button, no waiting. The owner still gets the
`🔄 DEPLOY COMPLETE` DM in WhatsApp when the new build is online.

## Panel restart = boot sync + WhatsApp status

Every panel restart, `boot.js` checks GitHub main on boot (panel default; on
Render it's off — the platform redeploys itself):

- **New commit found** → pulls it (npm-install if package.json changed),
  starts the bot with it, and the bot DMs the owner on WhatsApp:
  ```
  🔄 PANEL RESTART — NEW COMMIT DEPLOYED
     "B: version two - the glow up"
     (ba96e10)
  ✅ eventide omega is online
  ⚡ ready — type .ping to test.
  ```
- **Already latest** → the bot DMs:
  ```
  ✅ PANEL RESTART — ALREADY LATEST
     "B: version two - the glow up"
     (ba96e10)
  ⚡ online — type .ping to test.
  ```
- **Offline / fetch failed** → keeps the current build, no DM.

These status messages go to **WhatsApp** (not just the console logs) via a
one-shot `BOOT_STATUS.txt` file that boot.js writes and the bot consumes.
Restart the panel, watch the DM come in.

## Env knobs

| Key | Notes |
|---|---|
| `GIT_REMOTE_URL` | defaults to `https://github.com/Phantom-Dev-X/eventide-original.git` — point at a fork if you ever need to |
| `AUTO_UPDATE` | panel default **on**: check git + deploy at every panel restart · Render default **off** |

## Reading the logs — when is the bot ready to answer?

After every deploy/restart, watch the panel console for these lines in order:

```
[BUILD] 📦 running commit: 781beb9 feat: ...        ← what's running
[BUILD] ✅ BUILD DONE in 3.2s — HTTP is up.          ← code fully loaded
[BUILD] ⏳ sockets connecting...                    ← WhatsApp connecting
[READY] 234…: ⚡ SESSION READY — the bot is          ← ✅ THIS is when .ping will respond
        responding now. Type .ping in WhatsApp
        to confirm.
```

**Rule of thumb:** wait for the `SESSION READY` line, then type `.ping`.

## ⚡ Fast shutdown (panel Stop button)

Pterodactyl sends **SIGTERM** when you press Stop. Both `boot.js` (supervisor)
and `index.js` (bot) catch SIGTERM/SIGINT and exit **immediately with code 0**
so the panel registers the stop right away — no "Server marked as offline..."
hang, no power action lock errors.

⚠️ Set the panel **startup command to `node boot.js`** — if you use `npm start`,
npm becomes the main process and doesn't reliably forward SIGTERM to its
child, which reproduces the exact hang you saw.
