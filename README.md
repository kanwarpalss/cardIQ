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
2. SQL Editor → paste `supabase/migrations/001_init.sql` → run.
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
