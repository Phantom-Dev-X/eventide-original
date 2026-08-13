# Netlify (pretty URL) → panel bot

Panel site (always works, ugly): http://95.111.228.231:20006/

Netlify just puts a nicer `https://….netlify.app` in front. `/api` is already pointed at that panel IP in `netlify.toml`.

## Click path

1. https://app.netlify.com → **Add new site** → **Import an existing project**
2. GitHub → **Phantom-Dev-X/eventide-original**
3. Settings (don’t invent a build):
   - **Branch:** `main`
   - **Base directory:** empty
   - **Build command:** empty (or leave whatever `netlify.toml` has)
   - **Publish directory:** `public`
4. **Deploy site**
5. Open the `https://something.netlify.app` URL it gives you

Login / pair / dashboard go through Netlify → `http://95.111.228.231:20006/api/…`

The **panel bot must be running** or pair will fail.

## If deploy settings look wrong

Site → **Site configuration** → **Build & deploy** → **Build settings**:

- Publish directory = `public`
- Build command = (blank)

Then **Deploys** → **Trigger deploy** → **Deploy site**.
