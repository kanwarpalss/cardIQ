# Dining — Mac mini runbook

**Where this runs**: KP's personal Mac mini at home, on personal
Supabase / GitHub / Vercel. **Not** on the Walmart laptop.

**Status as of 2026-05-16**: chunks 1–5a built + tested on the
Walmart laptop. Login CLI ready. Scrapers (5b–d), dedupe, UI,
scheduler not yet built — those come after first successful login
captures, so we know what each platform's API actually returns.

---

## 0. One-time prereqs (run once, ever)

```bash
cd ~/Code/cardIQ
git pull                                    # grab the latest from origin
npm install                                 # picks up playwright + tsx + dotenv
npx playwright install chromium             # ~150MB, the actual browser binary
```

Confirm `.env.local` has these (copy from `.env.local.example` if not):

```
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...           ← service-role; never goes to browser
ENCRYPTION_KEY=<32-byte hex>            ← same one already used for Gmail token
CARDIQ_USER_ID=<your auth.users.id>     ← find via Supabase dashboard
```

Find `CARDIQ_USER_ID`: Supabase dashboard → Authentication → Users →
your row → copy the UUID.

---

## 1. Apply the schema migration

```bash
./scripts/db.sh push
```

If the wrapper complains (Walmart proxy is hardcoded in there for the
laptop case), comment out the two `export HTTP_PROXY` lines in
`scripts/db.sh` while running from home. The new tables are:
`dining_restaurants`, `dining_listings`, `dining_offers`,
`dining_runs`, `dining_scrape_pages`, `dining_sessions`,
`dining_manual_links`.

Verify in the dashboard SQL editor:

```sql
select table_name from information_schema.tables
 where table_name like 'dining_%' order by 1;
-- should return 7 rows.
```

---

## 2. Capture one session per platform (~3 × 2 min)

```bash
npx tsx scripts/dining-login.ts zomato
```

A Chromium window opens. **Log in with your real number + OTP** the
way you normally would. Stay on the post-login page until the
terminal prints `✅ Saved encrypted session for zomato`.

Repeat for the other two:

```bash
npx tsx scripts/dining-login.ts swiggy
npx tsx scripts/dining-login.ts eazydiner
```

Verify in Supabase SQL editor:

```sql
select platform, expires_at, last_validated_at
  from dining_sessions
 where user_id = '<your CARDIQ_USER_ID>';
-- should return 3 rows.
```

Alternatively, just run the sanity-check CLI:

```bash
npx tsx scripts/dining-verify-session.ts
```

It decrypts each session and prints cookie count, bearer presence,
and days remaining. Exit code 0 means all three look good.

---

## 3. Verify the UI works (empty state)

With all three sessions captured, the Dining tab is functional but
shows an empty state (no scraped data yet):

```bash
npm run dev
```

Open http://localhost:3000, click the **Dining** tab. You should see:
- Three green dots in the header (one per platform, all 'active')
- An empty state: "No restaurants scraped yet"
- No error banners

If any dot is red, run `dining-login.ts <platform>` again for that one.

---

## 4. What to do next (next coding session)

Once all three sessions are captured, the next session can build the
actual scrapers (chunks 5b–d). The plan is:

1. Use the captured sessions to make ~5 real read-only API calls per
   platform from the Mac mini, capturing the actual JSON responses
   as fixtures in `src/lib/dining/scrapers/__fixtures__/`.
2. Write a parser per platform against those captured fixtures
   (TDD-style, parser code never runs without a fixture test green
   first).
3. Wire the list-endpoint walker + detail-endpoint fetcher into the
   shared HTTP client (`lib/dining/http.ts`) and the dedupe layer
   (`lib/dining/dedupe.ts`).
4. Run a one-shot discovery sweep, watch `dining_runs` populate, see
   the DiningTab fill with real data.
5. launchd plist for the weekly schedule.

To kick off the next session, paste this:

> "CardIQ Dining — sessions captured on Mac mini, all three
> dining-verify-session.ts checks pass. Ready for chunks 5b–d (the
> per-platform scrapers + orchestrator). Read HANDOFF.md +
> docs/DINING_BUILD_PLAN.md + docs/DINING_SCRAPE_STRATEGY.md +
> docs/DINING_RUNBOOK.md first."

Each step is independently revertable. Nothing in chunks 5b+ has
been written yet — we hold off until we have real API shapes to
design against (otherwise we'd be coding to assumed schemas, which
always ends in tears).

Each step is independently revertable. Nothing in chunks 6+ has been
written yet — we hold off until we have real API shapes to design
against (otherwise we'd be coding to assumed schemas, which always
ends in tears).

---

## 5. Troubleshooting

**"ENCRYPTION_KEY not set"** — the script needs the same key as the
main CardIQ app. If you've already been running CardIQ locally, it's
in your `.env.local`. If not, generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep this same value forever — rotating it orphans all encrypted
data (Gmail refresh tokens, dining sessions).

**"Timed out waiting for login"** — increase TIMEOUT_MS in the
script, or just re-run. Sometimes Cloudflare adds a one-time
verification step on first visit; let it complete, then log in.

**"Decryption failed"** — your `ENCRYPTION_KEY` doesn't match what
encrypted the row. Either restore the old key or wipe the affected
session row and re-run the login CLI.

**Chromium window opens but doesn't go anywhere** — the platform
might be doing a regional check. Confirm you're on Indian internet
(any normal residential connection is fine — VPNs sometimes route
through other countries and break things).

**"npx playwright install" hangs** — the binary download server can
be slow. Let it run; usually 2–5 min on residential broadband.

---

## 6. Safety notes

- Sessions are encrypted at rest in Supabase (`aes-256-gcm` via
  `lib/crypto.ts`). The encryption key never leaves your laptop /
  Mac mini.
- The login script does NOT reuse your real Chrome profile. It uses
  a clean Playwright context, so your personal browsing stays
  separate from anything the scraper does.
- The scraper (once built) will run at 0.5–2.0 req/sec per platform
  with jittered delays — slow enough to look exactly like a human
  using the app.
- If any platform returns a 403 or captcha, the scraper aborts and
  shows a banner. We **never** try to bypass a challenge. If that
  happens, message the next Code Puppy session with the details and
  we'll figure out whether to slow further, pause, or abandon that
  platform.
