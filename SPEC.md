# CardIQ — SPEC

> Project brain. Updated every session.
> Static architecture doc lives in ARCHITECTURE.md — don't duplicate it here.
> Last updated: 2026-07-14

---

## §1 What This Is

A one-stop credit-card destination: syncs bank transaction emails from Gmail (Axis, HDFC, ICICI, HSBC), parses + categorizes them into a spend dashboard, and marries that with reward balances, card offers, and airline/hotel loyalty statuses — plus AI chat. Hosted on Vercel (Next.js), database on Supabase (Postgres + Auth), Gmail access via Google OAuth. Built for KP today; RLS keeps it multi-user-ready for the future.

## §2 Stack

| Layer | Tech |
|---|---|
| Frontend + API routes | Next.js 14, React, Tailwind |
| Database + Auth | Supabase (Postgres + RLS + Google OAuth) |
| AI chat | Anthropic Claude API |
| Hosting | Vercel |
| Gmail | Google API (messages.list + messages.get, read-only) |

## §3 Key Files

| File | Purpose |
|---|---|
| `src/app/api/gmail/sync/route.ts` | Gmail sync — fetch + parse + upsert |
| `src/app/api/merchant-mappings/route.ts` | Rename merchant / change category (bulk) |
| `src/app/api/transactions/[id]/route.ts` | PATCH single transaction category |
| `src/app/api/transactions/all/route.ts` | Fetch all transactions for client-side filtering |
| `src/app/api/recategorize/route.ts` | Re-run categorization on all stored transactions |
| `src/components/OverviewTab.tsx` | Home: hero stats, card-art tiles, rewards/offers/loyalty panels |
| `src/components/SpendTab.tsx` | Main spend dashboard UI |
| `src/components/RewardsTab.tsx` | Per-card point balance snapshots + history |
| `src/components/OffersTab.tsx` | Card offers CRUD with expiry chips + status filters |
| `src/components/LoyaltyTab.tsx` | Airline/hotel program tiers, member ids, expiry warnings |
| `src/components/MerchantPanel.tsx` | By-merchant panel with inline name + category editing |
| `src/lib/perks.ts` | Pure logic for rewards/offers/loyalty (unit-tested in perks.test.ts) |
| `src/lib/card-art.ts` | Issuer-true gradients per card product |
| `src/lib/format.ts` | Single home for ₹/number/date formatting (ARCH-04) |
| `src/lib/categorize.ts` | Keyword-based category rules |
| `src/lib/categories.ts` | Canonical category list (shared by UI and backend) |
| `src/lib/merchant-clean.ts` | Raw merchant name → cleaned display name |
| `src/lib/parsers/axis.ts` | Regex parser for Axis Bank email alerts |
| `src/lib/parsers/orders/` | Order-email parsers (Swiggy/Zomato/BigBasket/Amazon) + sender registry — grounded in real emails sampled from KP's Gmail 2026-07-11 |
| `src/lib/order-match.ts` | Pure order→transaction matcher: amount + date + merchant affinity, confidence tiers high/medium/low |
| `src/app/api/gmail/orders/sync/route.ts` | Orders sync — second Gmail pass; own cursor `_orders`, shares the gmail_seen_messages ledger |
| `src/components/InsightsTab.tsx` | Insights: MoM bars, two-tier category breakdown, top merchants, top items (from orders.items) |
| `src/app/api/transactions/bulk-notes/route.ts` | Feature B: same note across all txns of a merchant (no mapping created — notes aren't merchant metadata) |
| `tailwind.config.ts` + `src/app/globals.css` | THE theme — all colors are semantic tokens (ink/surface/mist/gold); re-theme = edit values here only |
| `src/lib/cards/registry.ts` | Hardcoded card specs (milestones, lounge access, senders) |
| `supabase/migrations/` | SQL migration files (run in order) |

## §4 Database Tables

- `user_settings` — encrypted Anthropic key, Google refresh token, last_gmail_sync_at
- `cards` — one row per physical card (product_key, last4, nickname)
- `transactions` — parsed transactions (merchant, category, amount, txn_at, gmail_message_id)
- `merchant_mappings` — user overrides: raw_name → normalized_name + category
- `kb_entries` — cached LLM card-topic summaries
- `chat_messages` — chat history
- `gmail_sync_state` — per-user incremental sync cursor (last_internal_date)
- `gmail_seen_messages` — every fetched email ID (success/skip/error) so nothing re-downloads
- `reward_balances` — card-point balance snapshots (migration 009; latest as_of = current)
- `offers` — user-tracked card offers with validity windows (migration 009)
- `loyalty_accounts` — airline/hotel program tiers + points, card-independent (migration 009)
- `orders` — parsed order emails: source, kind (order|refund), items jsonb, total, txn_id match + match_confidence (migration 011); `review_status` state machine unmatched→pending→confirmed/rejected (migration 014); `voucher_draws` jsonb (migration 015); `duplicate_of` self-FK (migration 016)
- `transactions` + `merchant_mappings` each gained a nullable `subcategory` column (migration 012)
- `vouchers` — parsed Gyftr voucher-issuance emails: brand, brand_key, face_value, code, valid_till, txn_id FK to the GYFTR card charge, match_confidence (migration 015)

## §5 Decisions Log

| Date | Decision | Rejected alternative | Why |
| 2026-07-14b | 5-min same-purchase window: unique exact-amount match within ≤5 min → HIGH confidence even without brand affinity | Keep at medium for all no-affinity matches | An order email and its charge fire within seconds of each other (e.g. Ellementry via "Dileep Esse" / Shopflo). A unique exact amount within 5 min is one event — the unrecognisable descriptor is incidental, not a signal of ambiguity. Mirrors the same-purchase dedup rule already trusted for duplicate detection |
| 2026-07-14b | Shopify ITEM_BLOCK_RE covers 4 header variants + 3 footer variants in a single regex | Per-theme branching logic | A single regex is the canonical definition; per-theme branches require knowing the theme up-front and rot as new themes appear. The regex boundary approach (stop at first totals line) is theme-agnostic |
|---|---|---|---|
| 2026-05-07 | Merchant lookup uses two-pass: raw_name first, then cleanMerchant(raw) | Single-pass raw only | Display overrides saved via UI use cleaned name as key; raw fallback ensures future syncs still respect them |
| 2026-05-07 | Inline merchant edit updates ALL transactions with that name | Prompt "apply to all?" | Less friction; bulk rename is always the right UX for merchant overrides |
| 2026-05-07 | Extracted MerchantPanel to separate component | Keep in SpendTab | SpendTab was approaching 600-line limit; edit state belongs close to the panel it controls |
| 2026-07-08 | Rewards/offers/loyalty are manual-entry in V1, with a `source` column (manual\|parsed) | Auto-compute balances from txns × earn rate | Computed balances drift into fiction (exclusions, bonuses, redemptions); a wrong number shown confidently is worse than a dated manual one. `source` column lets V2 email-parsing write into the same tables |
| 2026-07-08 | Three separate tables (reward_balances / offers / loyalty_accounts) | One generic "points" table | Card points die with the card (FK cascade); loyalty statuses outlive cards (no FK); offers are time-boxed and optionally card-linked (set-null) — different lifecycles, different shapes |
| 2026-07-08 | Sidebar shell (desktop) + pill nav (mobile), 8 sections | Keep flat top tabs | 8+ tabs overflow a top bar; sidebar scales as sections grow — "keep adding sections" is an explicit requirement |
| 2026-07-08 | New tabs do CRUD via Supabase client directly (CardsTab pattern) | Dedicated API routes | RLS already enforces per-user access; routes added no security, only boilerplate. Secrets stay in server routes as before |
| 2026-07-10 | Cardholder statements outrank blog sources for KP's own cards; encode with attribution | Trust aggregator blogs over KP | KP sees his actual T&Cs in bank apps; blogs conflict with each other (Infinia quarterly: ₹4L vs ₹9L). Every card spec now carries source comments + benefits_verified_at |
| 2026-07-10 | Milestone bars only render for documented reward milestones; earn-rate kinks stay text-only | Show M4B's ₹1.5L acceleration as a milestone bar | Nothing is GRANTED at M4B's ₹1.5L — a progress bar implies a payout that doesn't exist. KP: "show it honestly even for M4B" |
| 2026-07-10 | Loyalty tab shows card-granted lounge perks as read-only registry data (dashed border) above personal accounts | Insert card perks as loyalty_accounts DB rows | Registry data auto-updates with card spec changes and can't drift; DB copies would go stale and blur the manual-vs-reference boundary |
| 2026-07-11 | Order→txn match lives ON the orders row (txn_id FK + confidence) | order_id column on transactions | Orders can unlink without touching txns; feature C needed zero transactions schema change |
| 2026-07-11 | Amazon = refund amounts + Delivered item-names only; Blinkit has NO parser | Full parsers for all 5 SPEC sources | Verified against KP's Gmail: Amazon India stopped emailing order totals (~2023); Blinkit sends zero emails. Parsers for data that doesn't exist would be untestable fiction |
| 2026-07-11 | Matcher refuses ambiguity: round amounts require merchant affinity; multiple candidates cap at 'low' or refuse outright | Greedy amount+date matching | A wrong match shown confidently is worse than no match — same principle as the 2026-07-08 manual-first rewards decision |
| 2026-07-11 | "Auto-rename" is display-level: order's real merchant leads, bank name becomes "via …" subtext; DB merchant untouched | Overwriting transactions.merchant | An overwrite would fight merchant_mappings bulk renames and be irreversible; display enrichment is free to improve |
| 2026-07-11 | A merchant mapping wins wholesale, including its subcategory (or deliberate lack of one); keyword rules fill only unmapped merchants | Rules backfill subcategory under mappings | The user's explicit choice must never be second-guessed by heuristics |
| 2026-07-11 | Every route probes for migrations 011/012 and degrades gracefully when missing | Hard-fail until migrations run | Bank sync must NEVER break because an enrichment migration is pending; orders sync alone fails with a run-the-migration message |
| 2026-07-11 | Scope-choice "all N from merchant" on category edits routes through the merchant-mapping path | A bulk-update-only endpoint | Mapping upsert means future syncs agree with the bulk choice — bulk-without-mapping would silently revert on next sync |
| 2026-07-11 | Bulk notes get their own endpoint and do NOT create a mapping | Reuse merchant-mappings | Notes are per-transaction data, not merchant metadata; new syncs should arrive note-less |
| 2026-07-11 | Re-theme = token VALUES only; token names (gold/mist/ink) kept as semantic slots | Rename tokens app-wide | Zero component churn; next re-theme is again a 2-file edit. White-on-card-art text intentionally untouched (sits on issuer gradients) |
| 2026-07-11 | Insights aggregates client-side from /api/transactions/all | New aggregate endpoints | Same payload SpendTab already fetches; no new API surface, no drift between tabs |
| 2026-07-12 | Order matching is **merchant-first**: a D2C brand's email (with items) claims a transaction before Razorpay (signal-only) | Razorpay-first as "universal key" | Razorpay's strength is legal-entity name (matches bank descriptor); merchant emails have the real items and brand. The link shown to KP must be the richest detail available — a merchant email with a Spark Case item beats "Hourglass Design Pvt Ltd" every time |
| 2026-07-12 | Shipping/delivery status pings (shipped, out for delivery, etc.) are excluded from order parsing | Treat status pings as orders | A status ping lands days after the order and has zero item detail; the charge matches the correctly-dated order confirmation instead (KP's rule: "if you have shipped, you have order too") |
| 2026-07-12 | Exact-amount same-day matches bumped from low → medium confidence | Keep at low for all no-affinity matches | KP's data shows 99% accuracy on exact amounts; a unique same-/next-day hit is a strong signal and justifies "medium" ("likely"). Wider gaps stay low for review |
| 2026-07-14 | Gyftr voucher bridge: card charge (GYFTR VIA SMARTBUY) → voucher (face value) → many brand orders drawn FIFO | Model as order-to-txn like everything else | GYFTR is not a merchant — it's a voucher wallet. One card charge funds many orders at different brands over weeks. The ledger must show the chain: GYFTR charge → Amazon Fresh/Swiggy voucher → those brand orders drawn against it. Vouchers are their own table |
| 2026-07-14 | Voucher match tolerates charge < face value | Require exact face-value match | GYFTR offers discounts (₹1,900 for ₹2,000 voucher). Using `charge ≤ faceValue + ₹0.75` catches the discount case; ±₹0.75 exact match would miss it |
| 2026-07-14 | Same-purchase dedup: exact-amount ±₹0.75 within 5 minutes = duplicate | Only de-dup identical sender | A ₹4,181 charge can appear as "Bath and Body Works" (merchant email) AND "Apparel Group" (Razorpay gateway) within seconds. Both are the same purchase — the gateway row must be hidden, not shown twice. Window is time-of-send not txn_at, since emails can arrive in different orders |
| 2026-07-14 | Dedup primary selection: card-matched > itemsCount > orderMatchRank > id | Keep whichever came first | The richest representation stays visible; the signal-only gateway email becomes the "duplicate of" row |
| 2026-07-14 | PIN NOT captured from Gyftr voucher emails | Capture for display | A PIN is a live security secret. Reading and storing it — even encrypted — widens the blast radius if the DB is ever compromised. KP can retrieve the PIN from the original email if needed |
| 2026-07-14 | SmartBuy "Paid by card Rs X" is the total, not "Amount Paid" | Use Amount Paid | "Amount Paid" includes points and vouchers, not just card spend. KP's card statement shows only the "Paid by card" amount — using the other field would create a mismatch |

## §6 Current State (as of 2026-07-14b)

**New 2026-07-14b (item-detail coverage + same-purchase auto-confirm):**
- **Bug 1 — Ellementry not tagged:** Unique exact-amount matches within ≤5 min now auto-confirm at HIGH confidence even without brand-name affinity. `WINDOW_TIGHT_DAYS = 5 / (24*60)` in `src/lib/order-match.ts`. Backfill: `scripts/confirm-tight-matches.ts --apply` promoted **41 pending orders** to confirmed/high.
- **Bug 2 — Shopify items=0:** `ITEM_BLOCK_RE` in `src/lib/parsers/orders/shopify.ts` now covers all Shopify theme variants — `Order summary` (Gokwik), `Product Qty. Price` (Shopflo/Ellementry), `Bag Total` + `Order discount` as footer stops. `withMultSign` regex consumes THROUGH the price (skips the repeated qty column in Shopflo tables: `× 1 1 ₹1,182`).
- **Re-heal run:** `scripts/reparse-orders.ts --apply` recovered **159 orders (+294 item rows)**, 0 deletions, 0 errors.
- **Final dashboard state: 239 confirmed orders show item detail** (up from 183 at session start). Shopify contribution: 63 (up from 7). By source: Swiggy 141/141, BigBasket 87/87, Apple 171/171, SmartBuy 110/110, Shopify 63/200, Generic ~30.
- **Tests: 332 passing** (5 new: 3 matcher + 2 parser). Typecheck + lint clean. Committed + pushed sha `8011d9d`.

**Honest ceiling note:** 649 item-bearing orders remain unmatched — verified that 545+ have NO card charge candidate at all (paid by UPI/Swiggy wallet/other card not synced). Not a code bug. Items for those orders are visible in the Orders tab. The Spends dashboard (transaction-centric) can only show items for matched orders.

**New 2026-07-13–14 (orders layer — full parser build + voucher bridge):**
- **Item-detail coverage:** 1,877 orders stored; **153 flagged as same-purchase duplicates** (hidden by default); **1,724 visible orders; 739 with item detail (43%)**. All dedicated parsers at 100%: Apple 171/171, SmartBuy 110/110, Swiggy 141/141, BigBasket 87/87, Amazon 50/50, Zomato 13/13. Generic/Razorpay/Shopify tails remain partial (intermediary emails + remaining format variants).
- **Gyftr voucher bridge** (3 chunks, code-complete + live):
  - Chunk 1: `src/lib/parsers/orders/gyftr.ts` parses voucher-issuance emails (gifts@gyftr.com) → `vouchers` table. `matchVoucherToCharge()` in `src/lib/voucher-match.ts` links each voucher to the "GYFTR VIA SMARTBUY" card charge using `charge ≤ faceValue + ₹0.75` (handles discounts). Migration 015 applied.
  - Chunk 2: `src/lib/voucher-bridge.ts` — FIFO `reconcileVouchers()` draws brand orders down against vouchers by brand key (brand aliases: "amazon fresh" → "amazon"). `orders.voucher_draws` jsonb column carries the draw amounts.
  - Chunk 3: `OrdersTab.tsx` shows "◈ voucher ••<card>" badge (amber) on voucher-funded orders; voucher-detail row shows the chain (GYFTR charge → voucher → brand orders). Voucher-funded orders excluded from the Total value tile (already counted via the GYFTR charge).
- **SmartBuy travel parsers** (`src/lib/parsers/orders/smartbuy.ts`): flights show full itinerary ("Chandigarh (IXC) → Bangalore (BLR) · 19 Oct 2023 · IndiGo 6E-6634 · Mr. Amarjit Anand · PNR V3YIXX"); hotels show "Goa Marriott Resort & Spa · 29 Sep 2023–1 Oct 2023 · Guest room, 1 King, Garden view · Kanwar". Uses "Paid by card Rs X" as total.
- **Apple parser** (`src/lib/parsers/orders/apple.ts`): handles 3 formats — Format A ("Apple Account:"), Format B (DOCUMENT NO. anchor with BILLED-TO header), Receipt (both text+HTML tried, item-winner preferred). 171/171 real emails parse correctly; 30/30 manual test cases pass.
- **Swiggy Format B:** text-table "Item Name Quantity Price" extraction added; previously 91 orders had 0 items.
- **Shopify HTML-first:** reads stripped HTML before text/plain (which can be leaked CSS); `looksLikeShopify()` scans both.
- **Generic table parser** (`itemsFromTable`): TABLE_HEADER_RE + TABLE_FOOTER_RE detects line-item tables in any merchant email; catches Dominos, Printo, Supertails, etc.
- **Merchant item overrides** (`src/lib/parsers/orders/merchant-items.ts`): GoRally/Hudle/Hsquare → "Pickleball Game" (applied post-parse when items=0).
- **Same-purchase dedup** (`src/lib/order-dedup.ts` + migration 016 + `scripts/dedup-orders.ts`): exact amount ±₹0.75 within 5-min window = same purchase. Primary = card-matched > itemsCount > orderMatchRank > id. 153 rows flagged with `duplicate_of` FK; shown hidden in Orders with "⧉ duplicate" toggle.
- **Re-heal script** (`scripts/reparse-orders.ts`): re-fetches existing orders by gmail_message_id, re-parses with current code, updates items/total/merchant. Run 3× this session to back-fill Apple (170 rows), Swiggy, Shopify improvements.
- **`stripHtml` extracted** to `src/lib/gmail/strip.ts` (googleapis-free); parsers import from there; extract.ts re-exports for backwards compat (ARCH-04).
- **Tests: 327 passing** (up from 239 at session start). Typecheck + lint clean. Pushed to Vercel.
- **All 4 migrations applied:** 013 (orders_any_source), 014 (review_status), 015 (vouchers), 016 (duplicate_of).

## §6b Current State (as of 2026-07-12)

**New 2026-07-12 (C order-matching redesign — merchant-first ranking):**
- **Merchant-first ranking** via `orderMatchRank()`: D2C brand's own email (with items) → rank 3, merchant no-items → 2, generic → 1, Razorpay → 0. Sync sorts unmatched orders by rank before matching, so a ₹1,499 Postbox order with "Spark Case" items claims the ₹1,499 charge instead of losing to a Razorpay confirmation with zero detail.
- **Shipping/status email exclusion:** "on its way", "shipped", "out for delivery", "delivered" subject lines rejected in Shopify + generic parsers (marketplace parsers already sender-gated). Charge now matches the correctly-dated order confirmation (KP's rule enforced).
- **Confidence retuning:** unique exact-amount matches within ±2 days bumped to `medium` ("likely"), reflecting KP's 99% accuracy data on exact amounts; wider gaps stay `low` for review.
- **2-year Gmail audit** (`scripts/order-match-audit.ts`): scanned 3,152 candidate emails, applied merchant-first ranking, captured actual item lists, emitted `audit-review.json` (JSON review data for HTML widget). **Results:** 1,185 INR debits (2y) → 197 matched orders (16.5% coverage); 129 high-confidence, 44 medium, 24 low. Only 16 matches carried real item detail (Postbox, Swiggy, etc.). Baseline is dominated by Razorpay (no items). Target is 90%+ for true online-purchases (denominator ~250–300, not 1,185 which includes offline rent/insurance/medical).
- **Tests:** 257 total (4 confidence-score expectations updated + new rank + shipping-guard tests); typecheck + lint clean.
- Gates: suite + typecheck + lint — all green. Audit complete.

**New 2026-07-11 (V2 build part 2 — B scope-choice, D chip filters, E Insights, F re-theme):**
- B: category and note edits in the transactions table now carry an "All N from <merchant>" checkbox — category-scope goes through the mapping path (future syncs agree), note-scope through the new bulk-notes endpoint
- D: category chips (busiest-first, multi-select) under the table's filter bar; selecting exactly one category reveals its subcategory chips (↳ second tier)
- E: Insights tab (Money group) — 12-month MoM bar chart (click a bar to focus a month), two-tier category breakdown, top-10 merchants, top items straight from matched order emails
- F: re-theme shipped as a token-value swap — warm cream paper (#faf6ee), deep warm-brown text, persimmon coral accent (#d94e26); issuer card-art untouched; ChatTab prose de-inverted; verified live via computed styles + screenshot (login page)
- KP's 8-hour-old dev server 500'd on the tailwind-config change (stale dev cache — prod build was already green); restarted clean, everything renders
- Gates after part 2: 239 tests, typecheck, lint, prod build — all green

**New 2026-07-11 (V2 build part 1 — C order enrichment + A two-tier categories):**
- Orders layer: `/api/gmail/orders/sync` (cursor `_orders`, ARCH-12 trio, auto-chained after bank sync by SyncPanel — one click runs both passes); parsers for Swiggy/Zomato/BigBasket/Amazon built from real sampled emails; order→txn matcher with high/medium/low confidence
- TransactionsTable: expand arrow (▶) on matched rows shows items, order ref, total + confidence chip (✓ matched / ≈ likely / ? possible); confident matches show the restaurant/store as the primary merchant name with "via <bank name>" subtext; table search also covers order item names
- Two-tier categories: canonical `SUBCATEGORIES` map in categories.ts, two-tier keyword rules (Coffee, Food Delivery, Quick Commerce, Pickleball…), `subcategory` threaded through sync/recategorize/PATCH/merchant-mappings; edit UI in table + merchant panel; renders as "Dining · Coffee"
- Boundary-prover pass found 4 real silent-wrong-answer parser bugs (split-payment Swiggy totals, ₹0 BigBasket orders dropped, Amazon refunds dying on short order refs, cancelled orders parsing as paid) — all fixed, 17 regression tests locked in
- Verified: 239 tests green, typecheck clean, lint clean, production build passes. NOT yet verified live: order sync end-to-end against real Gmail (blocked on Gmail re-grant + migration 011) — TEST-02 pending KP click-through

**New 2026-07-10 (accuracy + Gmail-permission session):**
- Gmail insufficient-permission properly diagnosed: scope errors (403) now distinguished from expired tokens (invalid_grant) with the real fix path in the error message; new `GET /api/gmail/scope-check` makes a live Gmail call; Cards tab shows a Gmail-connection status card with "Check now"
- Milestone honesty: fake ₹1.5L fallback removed everywhere; M4B's ₹1.5L is earn-rate text only (per KP it's not a reward milestone); EPM carries the ₹1.5L MONTHLY milestone (per cardholder; not on ICICI's public page — reward wording pending from iMobile)
- All 5 card specs re-verified against web sources with `benefits_verified_at` dates + source comments; corrections: EPM anniversary tiers (₹8L vouchers + ₹10L fee waiver, was unsourced ₹12L), HSBC lounge (unlimited via LoungeKey, was wrongly capped 4/6), M4B ₹30L fee-waiver milestone added, Infinia ₹10L renewal-waiver added (quarterly bonus left unmodeled — sources conflict)
- SpendTab renders BOTH monthly + anniversary bars when a card has both (EPM); CardsTab lists all documented milestones per card + verified date; LoyaltyTab gained "Granted by your cards" read-only lounge-perk section

**New 2026-07-08 (holistic redesign):**
- Overview home tab: greeting + hero stats, issuer-true card-art tiles (milestone progress + base-rate point estimates), rewards/offers/loyalty summary panels; card tiles deep-link into Spend filtered to that card
- Rewards tab: per-card balance snapshots with history, deltas, staleness flags (>45 days → amber)
- Offers tab: CRUD with expiry chips ("3d left" / "No expiry" / expired), status filters (active/used/expired/archived)
- Loyalty tab: airline/hotel/other programs — tier chips, member ids, tier + points expiry warnings
- New shell: grouped sidebar nav (desktop) + horizontal pill nav (mobile); ambient gold aura backdrop
- CardSpec now carries reward program + base earn rate for all 5 cards
- Migration 009 (reward_balances, offers, loyalty_accounts — all RLS own-rows, all with source manual|parsed) — ⚠ NOT YET RUN in Supabase; new tabs show a run-migration notice until it is
- perks.ts pure logic + 15 boundary tests; .eslintrc.json added (lint now actually runs)

**Working (carried forward):**
- Gmail sync (multi-bank: Axis, HDFC, ICICI, HSBC): parse → categorize → upsert (dedup by gmail_message_id)
- Incremental cursor-based sync (`gmail_sync_state.last_internal_date`)
- Domain-level sender matching (Axis: axisbank.com, axis.bank.in; HDFC: hdfcbank.net, hdfcbank.com; ICICI: icicibank.com; HSBC: hsbc.co.in, mail.hsbc.co.in) — catches all historical sender formats
- Spend tab: filters, date presets, by-merchant, by-category, milestone bars
- Inline merchant renaming + category editing (from merchant panel and transactions table)
- 5-year historical backfill via "Load full history" button (passes `lookback_days: 1825`)
- Sortable transactions table with sort indicators on all columns
- Amount-range filter (Min ₹ / Max ₹) + merchant search in transactions table
- Card NICKNAME (not last4) shown in table; falls back to last4 if no nickname
- Custom categories from "Other" inputs are persisted and re-surfaced in the dropdown next time
- Per-transaction NOTES with autofill suggestions (3+ chars; matches startsWith / word-start / contains)
- Accurate `new_txns` counter in sync results
- Re-categorize button: re-runs category rules on all stored transactions
- Chat tab: Claude API with card + profile context
- `gmail_seen_messages` table: tracks ALL fetched email IDs (success, skip, error) so no email is ever re-downloaded twice (ARCH-12 / PROC-13 compliance)

**Pending / In Flight:**
- Migration 009 must be run manually in Supabase SQL Editor before Rewards/Offers/Loyalty can save data (tabs show a plain-English notice until then).
- Migrations 011–016 **all applied** as of 2026-07-14. No migration backlog.
- Authed dashboard visuals verified by build + tests + login-page DOM only — KP click-through pending (Google OAuth can't be done headlessly). Applies to the 2026-07-08 redesign AND the 2026-07-11 expand-row/subcategory UI, AND the 2026-07-14 voucher bridge + duplicate toggle UI.

## §7 Known Issues

| Issue | Status | Notes |
|---|---|---|
| gmail_seen_messages population | 🟡 VERIFY | The May-09 "Load full history" blocker predates two months of sync work (gap-detector, sync dropdown, ICICI domain fix) — likely resolved, but confirm with `SELECT COUNT(*) FROM gmail_seen_messages` when next in Supabase. |
| Model routing hook missing | ✅ RESOLVED | The model-routing gate fired via UserPromptSubmit hook on 2026-07-08 — the hook exists and works. |
| Recategorize re-cooks ALL transactions | Pending fix | Should only re-cook transactions affected by changed mappings/rules. |
| No `raw_merchant` stored in transactions | Accepted for now | merchant_mappings uses cleaned name as raw_name key; two-pass lookup compensates. |
| Point estimates are base-rate only | Accepted (by design) | Card tiles show "≈ N pts (base-rate estimate)" — accelerated/bonus earn not modeled; real balances come from the Rewards tab. |
| EPM ₹1.5L monthly milestone reward wording | 🟡 PENDING KP | Milestone encoded per KP (cardholder) but ICICI's public page doesn't list it — KP to supply the exact reward text from iMobile; update `icici-emeralde-private-metal.ts`. |
| Infinia quarterly bonus milestone | 🟡 PENDING KP | Widely reported (10K bonus points) but sources conflict on threshold (₹4L vs ₹9L); intentionally unmodeled. KP to confirm from HDFC app and add the tier. |
| Gmail re-grant needs KP's hands | 🟡 ACTION KP | Insufficient-scope can only be fixed by revoking CardIQ at myaccount.google.com/permissions, then re-login AND ticking the Gmail checkbox on Google's consent screen. App now detects + explains this, but can't do it for him. |
| Order sync unverified against live Gmail | 🟡 BLOCKED on the row above | Code-complete + 57 parser/matcher tests, but TEST-02 (real synced counts) needs Gmail re-grant + migrations 011/012. Then: Sync Gmail → expect "N orders parsed, M linked" in the result line. |
| Swiggy split-payment total picks the card-labeled row | Accepted (best available) | No real split-payment sample existed in Gmail; heuristic = prefer "card" row, else last row. A wrong pick fails safe (no match) — revisit if a real sample surfaces. |
| Re-theme taste review | 🟡 PENDING KP | Coral (#d94e26) on warm cream chosen per "playful-chic, color pops, fintech-editorial". Only /login was visually verifiable without OAuth. If the coral reads wrong, it's a 2-file value edit (tailwind.config.ts + globals.css). |

## §8 Environment Variables

| Variable | Where needed |
|---|---|
| `SUPABASE_URL` | Server + client |
| `NEXT_PUBLIC_SUPABASE_URL` | Client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only |
| `GOOGLE_CLIENT_ID` | Server |
| `GOOGLE_CLIENT_SECRET` | Server |
| `ENCRYPTION_KEY` | Server (AES-256 for stored secrets) |

## §9 Session Handoff Notes (2026-07-14)

### Accomplished This Session (2026-07-13–14, orders layer — full build)
1. **Gyftr voucher bridge, end-to-end.** Migration 015 (vouchers table) applied. Parser, voucher→charge matcher, FIFO reconciler, Orders UI (amber badge, chain detail, excluded from Total). Scripts: `drawdown-vouchers.ts` for backfill.
2. **Same-purchase dedup.** Migration 016 (duplicate_of FK) applied. `order-dedup.ts`, sync dedup phase, backfill script. 153 rows flagged; hidden in UI with toggle.
3. **Item-detail parsers: Apple (3 formats), SmartBuy (flights + hotels), Swiggy Format B, Shopify HTML-first, generic table.** Re-heal run 3×. Coverage: 1,724 visible orders, 739 with items (43%).
4. **Merchant item overrides** — GoRally/Hudle/Hsquare → "Pickleball Game".
5. **`stripHtml` extracted** to `src/lib/gmail/strip.ts` (ARCH-04 compliance).
6. **327 tests passing.** Pushed to Vercel (rebased against remote changes, `audit-review.json` moved aside to `/tmp`).

### Accomplished This Session (2026-07-14b — item-detail coverage bugfix)
1. **Bug 1 fixed — same-purchase auto-confirm.** 5-min window in `order-match.ts`; backfill via `scripts/confirm-tight-matches.ts`. 41 orders promoted to confirmed/high, including Ellementry (the root-cause example KP provided).
2. **Bug 2 fixed — Shopify item extraction.** `ITEM_BLOCK_RE` covers all theme variants; `withMultSign` handles Shopflo's repeated qty column. 2 new real-email parser tests (PRDGY Gokwik + Ellementry Shopflo).
3. **Re-heal applied.** 159 orders gained items (+294 rows). Final: 239 confirmed orders with item detail in Spend (from 183).
4. **All 332 tests pass.** Committed: sha `8011d9d`. Pushed to Vercel.

### ▶ Next Steps (for next agent or KP)

**KP actions first:**
1. **Sync Gmail orders** — in the app: click "Sync Gmail" or trigger `/api/gmail/orders/sync`. This will pick up any new order emails since the last sync, apply all the improved parsers, and run the voucher+dedup phases automatically. Check the sync result line for counts.
2. **Visual review in Orders tab** — look for:
   - SmartBuy flights/hotels showing passenger/route/date/PNR detail
   - Apple subscriptions with plan names (Apple One, iCloud+, etc.)
   - Voucher-funded Swiggy/Amazon orders showing the amber "◈ voucher" badge
   - The "⧉ duplicate" toggle (bottom of Orders) — flip it to see/hide the 153 duplicate rows; review the flagged pairs and confirm/reject if any look wrong
3. **Supply Amazon order history** — go to amazon.in → Account → "Request Your Information" → "Your Orders" → download `Retail.OrderHistory.1.csv`. Drop the file and the next agent can build an importer.
4. **EPM + Infinia milestone data** — EPM monthly reward text from iMobile; Infinia quarterly threshold from HDFC app (§7 Known Issues).

**Next agent — code work:**
1. **Amazon CSV importer** — once KP provides `Retail.OrderHistory.1.csv`: parse it, upsert into `orders` table (source='amazon_csv'), match to txns by amount+date. Fields: Order Date, Order ID, Title, Category, ASIN, Quantity, Purchase Price Per Unit.
2. **Shopify remaining gap (203 itemless)** — investigate the top unmatched senders among the 226 shopify-sourced orders; most are likely theme variants or shipping-status emails that slipped through `isShippingStatusEmail`. Run `scripts/reparse-orders.ts` (dry-run) to see what category they fall into.
3. **Razorpay remaining gap (186 itemless)** — these are mostly legit gateway-only emails (no items to find). But 57 DO have items — investigate whether those 57 match the "same-purchase duplicate" pattern (i.e., a richer merchant email exists alongside them). If yes, the dedup already handles it; if not, check what merchant they're for.
4. **KP visual click-through feedback** — after KP reviews the Orders tab live, implement any UX polish he requests (e.g., badge styling, sort order, filter presets).
5. **`/upgrade-brain`** — 8 days overdue (cadence 7d); run at start of next session.

**Migrations — all applied (001–016). No backlog.**

### Accomplished This Session (2026-07-12, C redesign — merchant-first ranking)

### Accomplished This Session (2026-07-12, C redesign — merchant-first ranking)
1. **Feature C — order-matching v2, code-complete.** Merchant-first ranking so D2C brand emails claim txns before payment gateways; shipping/status pings excluded (KP's "not shipped" rule); exact-amount same-day confidence bumped from low → medium (99% accuracy). All 257 tests green; typecheck + lint clean.
2. **Audit infrastructure** — `/scripts/order-match-audit.ts` reads real 3,152 Gmail emails, applies merchant-first matching, captures item detail, writes `audit-review.json` for HTML review widget. Coverage report TBD (audit in-flight, ~70% through parsing).
3. **Project CLAUDE.md updated** — merchant-first ranking (orderMatchRank) locked as an invariant for future order-enrichment work.
4. **Memory + reflection captured** — order-matching redesign summary in `cardiq-order-matching.md`, session reflection at `~/.claude-state/reflections/2026-07-12-cardIQ.md`.

### Accomplished This Session (2026-07-11, V2 build part 1)
1. **Feature C — order-item enrichment, code-complete.** Migration 011 (orders table); parsers for Swiggy/Zomato/BigBasket/Amazon built from REAL emails sampled via Gmail MCP (Blinkit skipped: sends no emails; Amazon: refunds + item names only — no totals in their emails anymore); pure matcher with refuse-to-guess confidence tiers; `/api/gmail/orders/sync` (own `_orders` cursor, shared seen-ledger); SyncPanel chains it after bank sync; expand-row UI with items + confidence chips; display-level auto-rename.
2. **Feature A — two-tier categories, code-complete.** Migration 012 (subcategory on transactions + merchant_mappings); canonical SUBCATEGORIES + two-tier keyword rules; threaded through all four write paths with probe-and-degrade migration tolerance; edit UI in TransactionsTable + MerchantPanel.
3. **Boundary-prover pass** — 4 real parser bugs found and fixed pre-ship; 17 regression tests added (239 total, all green; typecheck + lint + prod build clean).
4. **Features B, D, E, F — code-complete.** Scope-choice edits ("all N from merchant"), category+subcategory chip filters, Insights tab (MoM / category tiers / top merchants / top items), and the warm-cream + coral re-theme (token-value swap, theme verified live on /login).
5. *(Earlier today: iCloud shell aliases + Vercel deploy initiated — see §10.)*

### Accomplished 2026-07-10
1. **Gmail insufficient-permission root-caused + instrumented** — scope errors (403) vs expired tokens (invalid_grant) now distinguished; live scope-check endpoint + Gmail-connection status card in Cards tab. Actual re-grant requires KP's hands (see §7).
2. **Milestone honesty per KP's correction** — ₹1.5L monthly milestone moved to EPM (cardholder-attested); M4B's ₹1.5L demoted to earn-rate text; fee-waiver milestones added where sourced (M4B ₹30L, EPM ₹10L, Infinia ₹10L).
3. **All 5 card specs re-verified with sources + dates** — HSBC lounge corrected to unlimited; EPM anniversary tiers corrected against ICICI's official page; Infinia quarterly bonus flagged unverifiable.
4. **Loyalty enriched** — card-granted lounge perks (read-only, from registry) now show above personal airline/hotel accounts.

### Accomplished 2026-07-08
1. Holistic architecture layer — migration 009 (reward_balances, offers, loyalty_accounts; RLS own-rows; `source` column future-proofs V2 email-parsing). CardSpec gained reward program + earn rates.
2. Full UX redesign — sidebar shell, Overview home (card-art tiles, hero stats, holistic panels), Rewards/Offers/Loyalty tabs, Spend deep-links.
3. Quality — perks.ts + boundary tests, .eslintrc.json, devil's-advocate pass (5 CRIT citations).

### ▶ Next Steps (2026-07-12 → 2026-07-13+)
**Immediate (C redesign QoL):**
1. **Build HTML review widget** — render `audit-review.json` locally as an interactive widget: uncertain matches (medium/low) first, each row shows order email (merchant/items/date) ↔ transaction (amount/merchant/date) + confidence + reasoning. Embeds data directly (never leaves machine). Use for manual validation of low/medium matches.
2. **Run live audit once migrations 011/012 are live** — the above 16.5% figure uses the app's real code but fresh Gmail scan; once the sync is deployed, metrics will show live sync coverage (should be close, as audit runs the exact same matchers).
3. **Identify parser gaps** — audit's 786 unmatched parsed orders are likely merchant emails the parsers missed (new D2C email formats, Razorpay-exclusive merchants). Inspect audit output to find the top senders among unmatched.

**KP actions — C + A go live the moment these are done (existing from 2026-07-11):**
1. **Run migrations 011 + 012** in Supabase SQL Editor (`011_orders.sql`, then `012_subcategories.sql`; also 009 if still pending).
2. **Fix Gmail access** — myaccount.google.com/permissions → remove CardIQ → back in app: sign out, sign in, and **tick the Gmail checkbox on Google's consent screen** → Cards tab → Gmail connection → Check now → expect 🟢.
3. **Click Sync Gmail once** — expect the result line to end with "N orders parsed, M linked to transactions", then click a ▶ arrow on a Swiggy/Zomato txn (TEST-02 live verification).
4. **Supply two numbers** — EPM's ₹1.5L monthly reward text (from iMobile) and Infinia's quarterly milestone threshold (₹4L or ₹9L?) from HDFC app.
5. **Finish Vercel deploy** if not done, then commit + `git push origin main` when satisfied (working tree currently holds the uncommitted C+A build — consider /lead-review first).

**V2 feature build: ALL SIX DONE (A–F ✅ 2026-07-11).** Nothing remains from the V2 list.
Next session candidates: KP's visual click-through feedback (theme taste, expand-row polish), /lead-review findings, the recategorize re-cook fix (§7), and live TEST-02 verification of order sync once Gmail is re-granted.

## §10 Deployment

- **Local dev:** Type `cardiq` in any terminal (alias in `~/Library/Mobile Documents/com~apple~CloudDocs/shared-aliases.sh`) → opens browser + starts server on http://localhost:3000
- **New machine setup:** `echo '[ -f ~/Library/Mobile\ Documents/com~apple~CloudDocs/shared-aliases.sh ] && source ~/Library/Mobile\ Documents/com~apple~CloudDocs/shared-aliases.sh' >> ~/.zshrc`
- **Production:** Vercel — auto-deploys on `git push origin main`; project imported from kanwarpalss/cardIQ
- **Vercel env vars:** Loaded via "Import .env" from `~/Code/cardIQ/.env.local` (show hidden files with `Cmd+Shift+.`)
- **Supabase:** Migrations run manually in Supabase SQL Editor, in numeric order (001 → … → 016); all applied as of 2026-07-14
