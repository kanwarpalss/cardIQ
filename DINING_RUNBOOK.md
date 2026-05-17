# 🍽 CardIQ Dining — Mac mini setup runbook

**Where this runs**: KP's personal Mac mini at home, on personal
Supabase / GitHub / Vercel. **Not** on the Walmart laptop.

**Last updated**: 2026-05-16
**Total time**: ~20 min (most of it waiting for Chromium to download + your OTPs)
**What you get at the end**: Dining tab live, empty-state, ready for the scraper round next session.

---

## Phase 0 — Sanity check you're in the right place (30 sec)

```bash
cd ~/Code/cardIQ
pwd                          # should print /Users/<you>/Code/cardIQ
git remote -v                # should show kanwarpalss/cardIQ
node --version               # should be v20 or higher
```

If `node` < 20: `brew install node@20` first.

---

## Phase 1 — Pull the code (1 min)

```bash
git pull origin main
```

You should see ~11 new commits land. The latest one should be the
`docs(dining): record dedupe + API + UI + verify-session in HANDOFF`
commit (or this very runbook commit, even newer).

---

## Phase 2 — Install deps + Chromium binary (5–8 min)

```bash
npm install
```

This picks up `playwright`, `tsx`, `dotenv` (new this round) plus
anything else.

```bash
npx playwright install chromium
```

This downloads the actual ~150MB Chromium binary that the login script
drives. **This is the slow step** — go make tea.

---

## Phase 3 — Update `.env.local` with your user ID (2 min)

You need the UUID Supabase assigned to your account. Find it:

1. Go to https://supabase.com/dashboard
2. Open your CardIQ project
3. Sidebar → **Authentication** → **Users**
4. Click your row → copy the **User UID** (looks like `a1b2c3d4-...`)

Then:

```bash
# Open .env.local in your editor of choice
open -e .env.local                # opens in TextEdit
# OR: nano .env.local
# OR: code .env.local             # if you have VS Code
```

Add this line at the bottom (or update if already there):

```
CARDIQ_USER_ID=<paste-the-uuid-here>
```

Save the file.

> **⚠️ Check while you're in there**: confirm `ENCRYPTION_KEY` is set
> (32-byte hex). If you've been running CardIQ already, it should be.
> If it's blank, you'll need to set it — but **use the same value
> you've been using all along**, otherwise it'll orphan your existing
> Gmail tokens. If you've never set it, generate one:
>
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Phase 4 — Apply the schema migration (1 min)

```bash
./scripts/db.sh push
```

> The script has Walmart proxy hard-coded for the laptop case. From
> home it'll fail at the proxy step — if so, edit `scripts/db.sh`
> and comment out the two `export HTTP_PROXY` / `HTTPS_PROXY` lines
> near the top, then re-run.

Confirm the 7 new tables exist. In Supabase dashboard → SQL Editor:

```sql
select table_name from information_schema.tables
 where table_name like 'dining_%' order by 1;
```

Expected output: 7 rows — `dining_listings`, `dining_manual_links`,
`dining_offers`, `dining_restaurants`, `dining_runs`,
`dining_scrape_pages`, `dining_sessions`.

---

## Phase 5 — Capture the three logins (6 min total — 2 min each)

```bash
npx tsx scripts/dining-login.ts zomato
```

A Chromium window opens at `zomato.com/bangalore/dine-out`. **Log in
with your real phone + OTP, the same way you normally would.** Stay
on the post-login page; the script polls every 3 seconds.

When it detects you're logged in, the terminal prints:

```
✅ Saved encrypted session for zomato
   Cookies captured: 4 (cid, csrf-token, ...)
   Bearer token:     no
   Expires:          2026-06-...
```

The browser closes automatically. Repeat for the other two:

```bash
npx tsx scripts/dining-login.ts swiggy
npx tsx scripts/dining-login.ts eazydiner
```

> **If a window doesn't navigate after login**: just wait. Some
> platforms keep you on the same URL. The script polls cookies, not
> URL.
>
> **If it times out (10 min)**: try again. Sometimes Cloudflare adds
> a one-time verification on first visit; let that complete first.

---

## Phase 6 — Verify all three sessions decrypted cleanly (10 sec)

```bash
npx tsx scripts/dining-verify-session.ts
```

Expected output:

```
Dining sessions — sanity check
========================================

🔎  zomato
----------------------------------------
   ✅ captured at:   2026-05-...
   🍪 cookies:       4
   🔑 bearer token:  no
   ⏰ expires:       2026-06-...
   📅 30 days remaining (heuristic)

🔎  swiggy
... (similar)

🔎  eazydiner
... (similar)

✨ All sessions look good.
```

If any show `⚠️ no session row` or `❌ load failed`: re-run the login
CLI for just that one.

---

## Phase 7 — See the Dining tab live (2 min)

```bash
npm run dev
```

Open http://localhost:3000 → sign in → click the **Dining** tab
(between Spend and Chat — fork-and-knife icon).

**Expected**:

- ✅ Three green dots in the top-right of the tab header (zomato,
  swiggy, eazydiner — all "active")
- ✅ A search box you can type into
- ✅ An empty state: *"No restaurants scraped yet. Run the scraper on
  the Mac mini, or wait for the weekly cron."*
- ✅ **No** red error banner
- ✅ **No** amber re-auth banner

If any dot is red:

- Hovering should tell you which platform is missing/expired
- Re-run `npx tsx scripts/dining-login.ts <that-platform>`
- Refresh the browser tab

---

## Phase 8 — Ping Code Puppy back when ready

When you want to start the next session (capturing real API fixtures
+ building the actual scrapers), paste this prompt verbatim:

> **CardIQ Dining — sessions captured on Mac mini, all three
> `dining-verify-session.ts` checks pass, Dining tab shows empty
> state cleanly with 3 green session dots. Ready for chunks 5b–d
> (per-platform scrapers + orchestrator). Read `HANDOFF.md` +
> `docs/DINING_BUILD_PLAN.md` + `docs/DINING_SCRAPE_STRATEGY.md` +
> `docs/DINING_RUNBOOK.md` first.**

---

## 🆘 Troubleshooting — most likely failure modes

| Symptom | Fix |
|---|---|
| `npx playwright install` hangs | Just wait — it's downloading 150MB. If >10 min, check `~/Library/Logs/Playwright/` |
| `./scripts/db.sh push` proxy error | Comment out the two `export HTTP_PROXY` lines in `scripts/db.sh` |
| `ENCRYPTION_KEY not set` | Add it to `.env.local` (see Phase 3 note) |
| `CARDIQ_USER_ID not set` | Add it to `.env.local` (see Phase 3 main step) |
| Chromium login window blank | Refresh the page; if first visit, Cloudflare may want a one-time verify |
| `Decryption failed for X session` | Your `ENCRYPTION_KEY` doesn't match what encrypted the row. Delete the row in Supabase and re-run the login CLI |
| Dining tab shows 3 red dots after login | Browser cached old `/api/dining/sessions/status` response — hard refresh (Cmd+Shift+R) |
| `git pull` fails with merge conflict | The Mac mini has local commits that diverge from origin. `git status` to see, then ping Code Puppy with the conflict details |
| `npm install` fails on a specific package | You might be on a proxy that's blocking a registry. Try `npm config set registry https://registry.npmjs.org/` then re-run |

Anything else weird, screenshot it and share next session 📸

---

## 🛡 Safety notes

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

---

## 📚 For context (not required reading to run the runbook)

- `docs/DINING_FEASIBILITY.md` — why no public API exists, options
  considered, the card-first reframe.
- `docs/DINING_BUILD_PLAN.md` — 9-chunk plan, 7-table data model,
  locked decisions D1–D5, definition of done.
- `docs/DINING_SCRAPE_STRATEGY.md` — two endpoint tiers × three
  freshness tiers; bootstrap math; politeness policy.
- `HANDOFF.md` — current state of the whole CardIQ project, what's
  shipped, what's pending, conventions.

Good luck — see you on the other side 🚀
