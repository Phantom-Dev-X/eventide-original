# Deploy the website on Netlify

Netlify hosts **only the site** (`public/`).  
It cannot run WhatsApp. Pairing still happens on **panel.na**.

## What to deploy

| Deploy this | Don’t deploy this |
|---|---|
| Folder **`public/`** | `index.js`, `games.js`, `node_modules` |
| Repo: `Phantom-Dev-X/eventide-original` | The whole bot as a Node app |

Publish directory = **`public`**

## Steps

1. Push/pull `main` on GitHub (`eventide-original`).
2. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import from Git** → that repo.
3. Build settings:
   - **Base directory:** (leave empty)
   - **Build command:** leave default / empty (or the echo in `netlify.toml`)
   - **Publish directory:** `public`
4. Deploy.
5. Edit `netlify.toml` — replace `REPLACE_ME_PANEL_HOST` with your **panel public host** (no trailing slash):

```toml
to = "http://YOUR-PANEL-IP:PORT/api/:splat"
```

or if you have a domain on the panel:

```toml
to = "https://bot.yourdomain.com/api/:splat"
```

6. Commit + push (or edit the file in Netlify if you forked). Redeploy.
7. Site URL will be `https://something.netlify.app`  
   Pair page: `https://something.netlify.app/pair.html`

## Order of operations

1. Panel bot running (`USE_SUPABASE=false`, you can open `http://PANEL:PORT/` and see the site).
2. Then Netlify, with the redirect pointed at that same `PANEL:PORT`.

If `/api` still 404s, the `to =` line is still `REPLACE_ME_PANEL_HOST`.

## Render

Leave Render alone. This Netlify site talks to **panel**, not Render.
