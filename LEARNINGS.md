# LEARNINGS.md — what we burned hands on, so we don't again

A living document of bugs surfaced, root causes, and the principles
extracted. Two halves:

1. **Generic principles** — apply to every project, not just CardIQ.
2. **CardIQ-specific knowledge** — architecture, conventions, gotchas.

Read this before touching the code. Add to it when you fix something
non-obvious.

---

## Part 1: Generic principles (use everywhere)

### G1. Supabase `.select()` defaults to a 1000-row cap

**The trap**: `supabase.from("X").select("*").eq("user_id", uid)` silently
returns at most 1000 rows. No error. No warning. Looks correct in dev.
Breaks in prod the moment a power user crosses the threshold.

**Symptoms**: cache-style logic ("did we already process this?") starts
returning false negatives → dedupe stops working → infinite-loop-like
behavior ("syncs the same email every time").

**Rule**: For any "fetch ALL of X for this user" query, **always
paginate** with `.range(from, from+999)` until you get a short page:

```ts
const PAGE = 1000;
async function loadAll<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(cols)
      .eq("user_id", uid).range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    out.push(...data as T[]);
    if (data.length < PAGE) break;
  }
  return out;
}
```

If you only need a count, use `.select("*", { count: "exact", head: true })`
— way faster.

---

### G2. External APIs have date / coverage limits — design for fallback

**The trap**: pick one "free historical FX API", hard-code it, ship.
Three months later: turns out it has data only since 2024-03-06, or it's
missing your customer's regional currency, or its CDN flakes 5% of the
time. Silent data loss.

**Rule**: every external data source is **a layer in a fallback chain**,
never the only source. Cascade:

```
1. Local cache (DB)                                  ← instant, offline-safe
2. Primary provider (best coverage for common case)
3. Secondary provider (different scope/age)
4. Fuzzy fallback (e.g. ±N days for time-series)
```

Make the chain pluggable so swapping providers is one function. Always
log which step succeeded if you care about audit.

---

### G3. DRY chokepoints for write paths

**The trap**: 4 endpoints all insert into `transactions`. They each
duplicate `original_amount: parsed.amount_original ?? parsed.amount_inr`.
You fix the bug in one. Three remain. Two refactors later, only one
codepath runs the FX conversion. Mystery rows appear.

**Rule**: when ≥2 places write to the same table with derived values,
**extract a single `enrichX(...)` function** and route every write
through it. The signature *is* the contract — no caller can
accidentally skip a step.

In CardIQ this is `src/lib/txn-enrich.ts` — required reading before
adding a 5th write path.

---

### G4. Sentinel values need refresh paths

**The trap**: "if the rate fetch fails, store 0 and we'll get it next
sync." Next sync only fetches NEW emails. The 0 is permanent.

**Rule**: whenever you store a sentinel meaning "incomplete, retry
later", ship the **explicit retry mechanism** in the same PR:
- A button in the UI ("Refresh missing rates")
- An idempotent endpoint that sweeps the sentinels
- Concurrency caps so it can't DDOS upstream

If you can't ship the retry, don't store the sentinel — surface the
failure loudly instead.

---

### G5. Test the bug, not just the fix

**The trap**: bug report says "X breaks for SOFITEL email". You patch
the parser. Six months later a refactor reintroduces the bug. No test
flagged it because the test was abstract ("parser handles foreign
currency").

**Rule**: copy the **exact failing input** into a test verbatim. The
SOFITEL email body is in `src/lib/currency.test.ts` as a regression
test — that input now lives forever as a tripwire.

---

### G6. Defaults are opinions; document them

**The trap**: code says `currency = "INR"` if no signal. Six months
later someone wonders why USD txns from a sloppy email parser end up
as INR. They flip the default. Now thousands of legacy Indian-bank
emails (which never said "INR" because it was implicit) start being
flagged as USD.

**Rule**: state the default and the reasoning in a comment AT the
default site. Never just write `?? "INR"` without context.

See `lib/currency.ts` `detectCurrency()` for the gold-standard comment.

---

### G7. Walmart network ≠ open internet

**The trap**: tools that work on your home wifi (`supabase login`,
`gcloud auth`, `npm install some-package-from-cdn`) silently fail on
Walmart corporate network because:
- Walmart DNS returns **NXDOMAIN** for many SaaS hostnames
- Outbound DNS to public resolvers (1.1.1.1) is blocked
- Outbound HTTPS requires the **authenticated** sysproxy
  (`sysproxy.wal-mart.com:8080` returns HTTP 407 if you don't auth)

The browser works because it has Walmart's PAC file + auto-auth
extension. The CLI doesn't.

**Rule for CLI tooling**:
1. Bake `HTTP_PROXY=http://sysproxy.wal-mart.com:8080` into your
   wrapper scripts (assume Walmart network).
2. For tools needing auth, set up `cntlm` once, point env at
   `localhost:3128`.
3. Have a documented escape hatch: "do this in browser if CLI fails"
   (paste SQL into Supabase dashboard, etc.).
4. **Eagle WiFi** or **phone hotspot** unblocks most SaaS — call this
   out in onboarding docs.

---

### G8. Idempotent migrations always

**The trap**: a migration that fails halfway through can't be re-run.
Your DB is now in a half-migrated state with no clean recovery.

**Rule**:
- `create table if not exists`
- `alter table … add column if not exists`
- `create index if not exists`
- `drop policy if exists "X" on Y;` before every `create policy`
- For data repairs: wrap in `do $$ … end $$` with `raise notice` so
  the migration log shows what changed.

A migration should be safe to re-run unlimited times. If it's not,
it's broken.

---

### G9. Browser-account confusion is a real bug class

**The trap**: CLI opens "default browser" for OAuth, default browser
is signed into wrong account (Walmart vs personal), user authorizes
the wrong tenant, project gets created in the wrong workspace.

**Rule**: never auto-open the browser for OAuth in tooling YOU
control. Print the URL. Tell the user **which browser/profile to
paste it into**. Better: print the verification code separately so
they can confirm it matches what their browser shows.

---

### G10. Regex flags have second-order effects

**The trap**: `/[A-Z]{3}/i` looks like "match any 3-letter ISO currency
code". With the `i` flag it matches `ing` in "ending 5906" → captures
"5906" as the amount.

**Rule**: case-sensitivity on character classes is opt-IN, not opt-OUT.
If you mean uppercase, don't add `i`. If you need case insensitivity
for *part* of a regex, use inline `(?i:…)` or build the class
explicitly: `[A-Za-z]{3}`.

---

### G11. Money is never a single number

**The trap**: store `amount_inr` for everything. Foreign-currency txns
become inseparable from INR ones. Aggregations are silently wrong.
Display lies about "what did I spend".

**Rule**: for any cross-currency system, **always store**:
- `original_currency` (ISO 4217)
- `original_amount` (in that currency)
- `amount_inr` (or whatever your reporting currency is) — converted at
  the **transaction date**, not today

And in the UI, **show both** "value at the time" and "value today" so
the user can reconcile / understand drift. One number lies; two
numbers tell a story.

---

### G12. Pagination is a UX requirement, not a nice-to-have

**The trap**: ship a list view that looks fine in dev with 20 items.
A power user has 600. Page becomes infinite scroll of doom; can't
find anything.

**Rule**: for any list rendering arbitrary user data, ship with:
- Filter input (free-text)
- Sort (≥2 options)
- "Top N" default + "Show all" toggle
- Pager (Prev / 3-of-12 / Next)

In CardIQ this is the merchant + category panel pattern — copy it for
any new list.

---

### G13. The Zen of Python applies to every language

When in doubt:
- Beautiful is better than ugly.
- **Explicit is better than implicit** (re: defaults, sentinels).
- **Errors should never pass silently** (re: external API failures).
- **There should be one obvious way to do it** (re: DRY chokepoints).
- **If the implementation is hard to explain, it's a bad idea**.

---

## Part 2: CardIQ-specific knowledge

### Architecture at a glance

```
Gmail OAuth ──► /api/gmail/sync ──► parsers ──► enrichAmount ──► transactions
                       │                              │
                       ├── /api/gmail/reprocess       └── txn-enrich.ts
                       ├── /api/gmail/wipe-and-reingest      ↑
                       ├── /api/cards/backfill               │
                       │                              ┌──────┴──────┐
                       └── gmail_seen_messages        │ historical-fx│
                           (every msgId, even           │ +fx_rates    │
                            non-txn, never re-fetch)   └──────────────┘
```

### Key files & their responsibilities

| Path | What it does |
|---|---|
| `src/lib/currency.ts` | **Single source of truth** for "what currency is this?" — used by sniffer + enrich. Defaults to INR. |
| `src/lib/txn-enrich.ts` | **DRY chokepoint** for `(amount_inr, original_currency, original_amount)`. Every write path uses it. |
| `src/lib/historical-fx.ts` | Cache → fawazahmed0 → Frankfurter → ±7 day fuzzy. **Pluggable provider chain.** |
| `src/lib/parsers/{axis,hdfc,icici,hsbc}.ts` | Bank-specific parsers. **All have foreign-currency guards** that early-return null so the sniffer takes over. |
| `src/lib/parsers/generic-sniffer.ts` | Catch-all for unknown banks / new email formats. Marked `low_confidence: true` for review. |
| `src/lib/forex.ts` | Static **today's rate** table. Used only for the secondary "what's it worth now?" display. |
| `src/components/ForeignCurrencyPanel.tsx` | Foreign txns quarantined here, never summed into INR totals. Dual-INR display. |
| `src/components/SpendTab.tsx` | Main dashboard. INR-only aggregates. Foreign panel renders separately. |
| `supabase/migrations/` | Numbered SQL files. Always idempotent. |
| `scripts/db.sh` | Wrapper for Supabase CLI with Walmart proxy baked in. |

### The four write paths (must stay in sync)

All four insert into `transactions` and **must** call `enrichAmount()`:

1. `src/app/api/gmail/sync/route.ts` — incremental sync
2. `src/app/api/gmail/reprocess/route.ts` — retry failed parses
3. `src/app/api/gmail/wipe-and-reingest/route.ts` — nuclear reset
4. `src/app/api/cards/backfill/route.ts` — link orphans on new card

**If you add a 5th, you MUST use `enrichAmount()`. There is no other
correct way.**

### Migrations & DB workflow

- Migration files: `supabase/migrations/NNN_<name>.sql` (zero-padded).
- Apply via: `./scripts/db.sh push` (when off Walmart network) OR
  paste into the Supabase dashboard SQL editor (when on Walmart).
- Project ref: `dmmhtzwxqkduxvxipfqs` (in `db.sh` and `.env.local`).
- Always idempotent — see G8.

### Foreign currency rules (CardIQ-specific embodiment of G11)

1. **Detect** with `lib/currency.ts` — never write your own currency
   regex. Default-to-INR is intentional.
2. **Store** original_currency + original_amount + amount_inr (at
   txn-date rate). amount_inr=0 is a sentinel meaning "couldn't fetch".
3. **Display** both at-txn-date and today's INR for transparency.
4. **Aggregate** INR txns separately from foreign — never sum across
   currencies into one ₹ figure.
5. **Refresh** sentinel rows via `/api/transactions/refresh-fx`
   (button in the foreign panel).

### Tests

- `npx vitest run` from project root. **74/74 must pass before any commit.**
- Currency detection tests live in `src/lib/currency.test.ts` — 33 cases
  including the actual SOFITEL email body.
- Parser tests in `src/lib/parsers/parsers.test.ts` — 28 cases including
  the foreign-currency guards on HDFC/ICICI/HSBC.
- Generic sniffer tests in `src/lib/parsers/generic-sniffer.test.ts` —
  13 cases including IDR/THB/MYR/HKD coverage.

### Walmart-network gotchas (CardIQ-specific)

- `npm run dev` needs to reach `dmmhtzwxqkduxvxipfqs.supabase.co` →
  must be on **Eagle WiFi or phone hotspot or off-Walmart-VPN**.
- `./scripts/db.sh` has the proxy baked in but Supabase CLI itself
  often still fails 407 — fall back to dashboard SQL editor.
- Historical FX needs `cdn.jsdelivr.net` and `frankfurter.app` — also
  require non-Walmart network.
- `supabase login` browser flow: **paste URL in Safari**, NOT default
  Chrome (Chrome is signed into Walmart Supabase tenant via GitHub).

### Bugs we already squashed (don't reintroduce)

| # | Bug | Root cause | Fix location |
|---|---|---|---|
| 1 | First sync capped at 365 days | Hardcoded 1y window | sync route, now 8y |
| 2 | New cards didn't backfill | Missing endpoint | `/api/cards/backfill` |
| 3 | Date picker monthly grid broken | UX disaster | `PeriodPicker.tsx` rewrite |
| 4 | IDR ₹1.2cr inflation (SOFITEL) | Foreign amount stored as INR | `txn-enrich.ts` + parser guards |
| 5 | HDFC/ICICI/HSBC silently dropped foreign txns | INR-only regexes with no fallback | foreign-currency guards + sniffer takeover |
| 6 | Today's FX rate used for years-old txns | Static table only | `historical-fx.ts` with cache+API |
| 7 | "1 new txn" every sync | Supabase 1000-row .select() limit | paginate `loadAllIds()` |
| 8 | Missing FX rates for older USD txns | fawazahmed0 only goes back to 2024-03-06 | Frankfurter fallback (1999+) |
| 9 | Same-date FX flakes | CDN intermittent failures | ±7 day window fallback |
| 10 | "By category" panel infinite scroll | No pagination | filter+sort+pager (mirrors merchant panel) |

### Conventions

- **Comments**: explain WHY, not WHAT. Reference the bug or principle
  if non-obvious. See currency.ts and txn-enrich.ts for tone.
- **Files ≤600 lines** — split if growing past that, but only if it
  improves cohesion (per Code Puppy rules).
- **Commit messages**: imperative subject, body explains the user-facing
  bug + root cause + the principle/learning extracted.
- **Never force-push** to git.
- Walmart colors palette only when adding new UI components (per Code
  Puppy rules) — but CardIQ has its own dark theme already, follow
  existing tokens (`gold`, `mist`, `ink`, `rim`, `gold/X`, etc.).

---

## How to add to this file

When you fix a non-obvious bug:
1. Add a row to "Bugs we already squashed".
2. If the root cause maps to a NEW principle, add it to Part 1 with
   a `### G<N>.` heading.
3. If it's CardIQ-specific only, expand Part 2.
4. Commit with a message that references the principle:
   `fix(X): … (see LEARNINGS.md G7)`.

The goal: every sharp edge gets dulled exactly once.
