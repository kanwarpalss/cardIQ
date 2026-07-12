-- 011: Order-item enrichment (V2 feature C).
--
-- One row per parsed order-confirmation email (Swiggy / Zomato / BigBasket /
-- Amazon). Orders are matched to card transactions by amount + date proximity;
-- the match lives HERE (txn_id on the order), so the transactions table needs
-- no schema change and an order can be unlinked without touching the txn.
--
-- Design notes
-- ────────────
-- * `gmail_message_id` is unique per user — same never-twice dedupe contract
--   as transactions (Invariant 3). The email ID is ALSO recorded in
--   gmail_seen_messages by the orders sync route.
-- * `items` is jsonb [{name, qty, price}] — items are always fetched with
--   their order (expand-row UI, insights later); a separate table would add
--   joins for no query we actually run.
-- * `total_amount` is nullable: Amazon India "Delivered:" emails carry NO
--   amount (they stopped including totals in emails ~2023). Those orders can
--   still enrich a transaction with the item name, at low confidence only.
-- * `kind` distinguishes refund emails (matched against CREDIT txns) from
--   order emails (matched against DEBIT txns).
-- * `match_confidence`: high = exact amount + unique candidate + ≤2 days;
--   medium = exact amount + unique + ≤5 days; low = everything the matcher
--   accepts but can't be sure about (shown with a "possible" marker in UI).
-- * `source` check constraint intentionally includes 'blinkit' for the
--   future even though Blinkit sends no order emails today (verified against
--   KP's Gmail 2026-07-11: zero emails from blinkit.com/grofers.com).
--
-- All DDL is idempotent. Safe to re-run.

create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  source           text not null check (source in ('amazon','swiggy','zomato','bigbasket','blinkit')),
  kind             text not null default 'order' check (kind in ('order','refund')),
  gmail_message_id text not null,
  order_ref        text,                 -- platform's own order number (BNN-…, 8266257923, 404-…)
  merchant_name    text,                 -- restaurant/store when the platform is a marketplace (Swiggy/Zomato)
  total_amount     numeric(12,2),        -- NULL when the email carries no amount (Amazon Delivered)
  order_at         timestamptz not null, -- email internalDate — close enough to charge date for matching
  items            jsonb not null default '[]'::jsonb,
  txn_id           uuid references transactions(id) on delete set null,
  match_confidence text check (match_confidence in ('high','medium','low')),
  matched_at       timestamptz,
  raw_subject      text,
  created_at       timestamptz default now(),
  unique (user_id, gmail_message_id)
);

alter table orders enable row level security;
drop policy if exists "own orders" on orders;
create policy "own orders" on orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Sync-time lookups: "which orders are still unmatched?" and
-- "orders for this txn" (expand-row UI join).
create index if not exists orders_user_unmatched_idx
  on orders (user_id, order_at desc) where txn_id is null;
create index if not exists orders_user_txn_idx
  on orders (user_id, txn_id);
