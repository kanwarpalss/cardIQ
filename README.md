# CardIQ

Personal credit-card research, deal tracking, and spend optimization. One URL, accessible from any device.

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind
- Supabase (Postgres + Auth, Google OAuth with Gmail scope)
- Anthropic API for the chat / routing brain
- Vercel for hosting (free tier)

## Repo layout

```
src/
  app/                   Next.js routes (UI + API)
    api/chat             Anthropic-backed chat endpoint
    api/settings         Save Anthropic key + profile
    auth/callback        Supabase OAuth callback
    login                Google sign-in
  components/            ChatTab, SpendTab, CardsTab, SessionsTab
  lib/
    supabase/            Browser + server clients
    cards/               CardSpec registry (start: Axis Magnus Burgundy)
    parsers/             Issuer-specific Gmail txn parsers (stubs)
    router.ts            buildSystemPrompt — KB freshness + routing rules
    crypto.ts            AES-GCM for per-user Anthropic key at rest
supabase/migrations/     SQL schema
```

## One-time setup

### 1. Supabase

1. Create a project at supabase.com (free tier).
2. SQL Editor → run **every** file in `supabase/migrations/` in order
   (`001_init.sql` → `010_dining_schema.sql`). All are idempotent, so
   re-running is safe.
3. Project Settings → API → copy:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Authentication → Providers → enable Google. (Configure with the OAuth client below.)

### 2. Google Cloud (for Gmail OAuth)

1. console.cloud.google.com → new project.
2. APIs & Services → Library → enable **Gmail API**.
3. APIs & Services → Credentials → Create OAuth client → Web application.
4. Authorized redirect URI: `https://YOUR-SUPABASE-URL.supabase.co/auth/v1/callback`
5. Copy client ID + secret into Supabase Auth → Google provider.
6. OAuth consent screen → External, Testing mode, add your Google account as a test user, add scope `https://www.googleapis.com/auth/gmail.readonly`.

### 3. Local

```bash
cd cardiq-app
npm install
cp .env.local.example .env.local
# fill in Supabase + Google + ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # use this for ENCRYPTION_KEY
npm run dev
```

Open http://localhost:3000, sign in with Google, paste your Anthropic API key in Cards → Settings, add your two Magnus Burgundy cards (last4 `2294` and `4455`).

### 4. Vercel

1. Push the repo to GitHub.
2. Import the repo on Vercel.
3. Settings → Environment Variables → paste everything from `.env.local`.
4. Deploy. Add the production URL to Google OAuth redirect URIs and Supabase Auth → URL Configuration.

## Running on a second machine (same data)

Your transactions live in **Supabase (the cloud), not in this repo**. To run
CardIQ on another laptop, you just clone the code and recreate the
`.env.local` file by fetching each value from the dashboards below. Nothing
secret is ever committed — `.env.local` is gitignored on purpose.

### Step 1 — Clone & install

```bash
git clone https://github.com/kanwarpalss/cardIQ.git
cd cardIQ
npm install
cp .env.local.example .env.local   # creates a blank template to fill in
```

### Step 2 — Fill in `.env.local` (where each value comes from)

Open `.env.local` in any editor and fill these in. **Use the SAME values as
your existing setup** so the new machine sees the same data and account.

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | [supabase.com/dashboard](https://supabase.com/dashboard) → your project → **Project Settings → API → Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → **Project API keys → `anon` `public`** |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → **Project API keys → `service_role` `secret`** (click “Reveal”) |
| `GOOGLE_CLIENT_ID` | [console.cloud.google.com](https://console.cloud.google.com) → your project → **APIs & Services → Credentials → OAuth 2.0 Client IDs** → open your client → **Client ID** |
| `GOOGLE_CLIENT_SECRET` | Same client page → **Client secret** |
| `ENCRYPTION_KEY` | ⚠️ **Reuse the exact value from your first machine's `.env.local`** (see note below). Only generate a new one if this is a brand-new install with no existing data. |
| `NEXT_PUBLIC_APP_URL` | Leave as `http://localhost:3000` for local use |
| `CARDIQ_USER_ID` | Optional (Dining tab only). Supabase dashboard → **Authentication → Users →** your row → copy the **UID** |

> ⚠️ **About `ENCRYPTION_KEY` — this is the one that bites people.**
> It's the AES key that decrypts your stored Gmail refresh token. To keep
> Gmail sync working across machines, **every machine must use the identical
> key.** It only exists in your first machine's `.env.local` (it's gitignored,
> so it's *not* on GitHub). Copy that exact line over by hand (AirDrop, a
> password manager, a secure note — never via git or email).
>
> If you truly can't retrieve the original key, you can generate a new one:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> …but then you must **sign out and sign in again on every machine** so the
> Gmail token gets re-encrypted with the new key.

### Step 3 — Run

```bash
npm run dev      # open http://localhost:3000 and sign in with Google
```

That's it — your cards and transactions load automatically from Supabase after
you sign in. The Google OAuth redirect already covers `localhost:3000`, so no
Google Cloud changes are needed for another *local* machine.

## What works in V1

- Google sign-in with Gmail scope granted (token stored by Supabase)
- Anthropic API key saved (encrypted) per user
- Add / remove cards (Axis Magnus Burgundy seeded; more cards = add specs in `src/lib/cards/`)
- Chat tab calls `/api/chat` with the routing system prompt + your KB state
- KB / routing logic ported from the original prototype

## What's next

- Gmail sync route + Axis transaction parser → fills `transactions`
- SpendTab: month-to-date totals + milestone progress bars
- KB fetch action: when the model emits a fetch signal, run a server-side fetch + summarize + write to `kb_entries`
- Auto-summarize every 20 turns → `session_summaries`
- Add HDFC / ICICI / Amex / HSBC card specs + parsers
