# 🚨 Chrome "Deceptive Site" Warning — what happened & how it's fixed

## What happened

Chrome (Safe Browsing) flagged your Render URL with the red
**"Deceptive site ahead — attackers on this site might trick you into
revealing passwords, phones, or credit cards"** warning.

**Why:** the web panel was fully public. Anyone (including Google's scanners)
could open `/login.html`, `/signup.html`, `/pair.html` — pages with password
fields and "enter your WhatsApp number to link" flows. A public login + phone
pairing page looks EXACTLY like a credential-harvesting scam, so the domain
got classified as "social engineering / deceptive".

## What changed in the code

The panel is now locked by default. The public URL serves only a harmless
branded landing page (no forms at all). Everything else is invisible.

| Without `PANEL_PIN` (default) | With `PANEL_PIN=yourpin` |
|---|---|
| `/` → safe landing page only | `/` → landing page with a single PIN field |
| all panel pages & APIs → 403 | PIN (cookie or `x-panel-pin` header) unlocks the full panel |

- PIN cookie is HttpOnly, lasts 7 days.
- `/ping`, `/health` and images stay public (Render health checks keep working).
- WhatsApp/Telegram pairing still works 100% — the panel is optional.

## What YOU must do

1. **Deploy the new code** (this commit) to Render.
2. **Decide the PIN:**
   - Full lockdown (recommended): leave `PANEL_PIN` unset.
   - Keep the panel: add env `PANEL_PIN=something-strong` on Render, redeploy,
     then visit your URL and enter the PIN.
3. **Get the red warning lifted** — Google doesn't lift it automatically:
   - **Fastest:** rename your Render service → you get a brand-new URL
     (the flag is on the OLD url). Update anything that referenced it.
   - **Proper fix:** Google Search Console → add your URL as a property →
     **Security Issues → Request review**. Also report the false positive at:
     `https://safebrowsing.google.com/safebrowsing/report_error/`
   - Reviews can take hours to a few days; the renamed URL works immediately.

## Why this won't happen again

Scanners will never see login/signup/pair forms again — the panel surface is
behind the PIN, and the landing page has zero credential fields.
