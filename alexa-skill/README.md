# "AC Boost" Alexa Routine trigger

Lets the Ohm Sweet Ohm dashboard fire an Alexa Routine — e.g. one that sets
the (Alexa-exclusive, Amazon Smart Thermostat) AC to a specific temperature
— without the app ever talking to the thermostat directly, which Alexa's
architecture doesn't allow a third-party integration to do. See
`server/src/alexaSkill.js`'s header comment for the full explanation of why
this shape (a virtual switch + a user-configured Routine) is the real path,
and what three separate tokens are involved.

**Pieces, and where they live:**
- **This directory** — the Lambda function Alexa calls. Deploy as-is, no
  build step, no dependencies (Node 18+ runtime has `fetch` built in).
- **`server/src/alexaSkill.js` + routes in `server/src/index.js`** — already
  part of the main app, deploys with everything else.
- **`web/src/components/AlexaSettings.tsx`** — the dashboard's "Trigger AC
  Boost" button, under Settings.

## One-time setup (you'll need to do the console parts yourself — I can't
click through Amazon's or AWS's web consoles on your behalf, but I can run
the AWS CLI for you if you set it up, and every value below is exact)

### 1. Login with Amazon (LWA) security profile
This is what proves the skill's identity to Amazon, for both the
account-linking handshake and sending events.

1. Go to <https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html>,
   create a new Security Profile (any name, e.g. "Ohm Sweet Ohm Skill").
2. Under that profile's **Web Settings**, add this as an **Allowed Return URL**:
   `https://meter.langecornu.com/oauth/authorize` (you won't actually be
   redirected there by LWA itself, but Amazon requires *some* URL on file).
3. Note the **Client ID** and **Client Secret** — you'll need both twice
   below (once for the Lambda, once for the main server).

### 2. The Alexa Skill itself
1. Go to <https://developer.amazon.com/alexa/console/ask>, create a new
   skill: model = **Smart Home**, no other setup wizard needed.
2. **Skill endpoint**: you'll fill this in with the Lambda's ARN after step 3.
3. **Account Linking** (in the skill's build page, left sidebar):
   - Authorization URI: `https://meter.langecornu.com/oauth/authorize`
   - Access Token URI: `https://meter.langecornu.com/oauth/token`
   - Client ID / Client Secret: make up your own values here (these are
     *not* the LWA ones — they're a shared secret between the skill config
     and `/oauth/token`, which doesn't currently check them beyond
     presence, so any values work; put something in both fields).
   - Scope: add one, any name works (e.g. `smart_home`) — the manifest
     validator rejects an empty scope list for a Smart Home skill, but
     `/oauth/authorize` and `/oauth/token` below don't actually check its
     value, so it's just there to satisfy that requirement.
   - Domain list: not required for a personal/unpublished skill.
4. Note the **Skill ID** (top of the page, `amzn1.ask.skill....`) — needed
   for the Lambda's trigger permission in step 3.

### 3. The Lambda function
1. AWS Console → Lambda → **Create function** → Author from scratch.
   - Runtime: **Node.js 20.x** (or any 18+).
   - Architecture: either.
2. Upload `alexa-skill/index.js` as the function code (zip it, or paste
   directly into the inline editor — it's one file, no dependencies).
3. **Configuration → Environment variables**, add:
   - `ALEXA_LWA_CLIENT_ID` = (from step 1)
   - `ALEXA_LWA_CLIENT_SECRET` = (from step 1)
   - `TOKEN_STORE_URL` = `https://meter.langecornu.com/api/internal/alexa/store-grant`
   - `TOKEN_STORE_SECRET` = (a long random string — generate your own, or
     ask me to generate one; must match `ALEXA_INTERNAL_SECRET` in the main
     server's environment, step 4)
4. **Add trigger** → Alexa Smart Home → paste the Skill ID from step 2.
5. Copy the function's **ARN** (top right) → paste it as the Alexa skill's
   **Default endpoint** back in the Developer Console (step 2.2), then
   **Save** and **Build Model** there.

### 4. The main server's environment
Add to `/etc/sem-meter/env` on the VM (same file as `SMTP_*` etc.):
```
ALEXA_LWA_CLIENT_ID=<same as step 1>
ALEXA_LWA_CLIENT_SECRET=<same as step 1>
ALEXA_INTERNAL_SECRET=<same random string as TOKEN_STORE_SECRET above>
```
(`ALEXA_EVENT_GATEWAY` only needs setting if you're outside North
America — defaults to the NA endpoint.)

### 5. Link it and build the Routine
1. In the **Alexa app** → More → Skills & Games → **Your Skills** → Dev tab
   → find your skill (it's visible to your own account immediately for an
   unpublished skill in development) → **Enable** → sign in with this
   dashboard's admin email/password when prompted.
2. Alexa should discover one device: **"AC Boost."**
3. Alexa app → **Routines** → **+** → When this happens → **Smart Home** →
   **AC Boost** → *turns on*. → Add action → whatever you actually want
   (e.g. adjust the thermostat).
4. In the dashboard, Settings → **Trigger "AC Boost"** → confirm the
   Routine fires.

## Re-running this after any Lambda code change
Just re-upload `index.js` — no dependencies to reinstall, no build step.

## Testing without the Alexa app
`server/src/alexaSkill.js`'s `triggerRoutine()` needs both an account-link
token (from step 5.1) and a grant token (sent automatically by Alexa right
after linking, via the Lambda's `AcceptGrant` handler) on file before it
can send anything — there's no way to test the trigger meaningfully before
linking is complete.
