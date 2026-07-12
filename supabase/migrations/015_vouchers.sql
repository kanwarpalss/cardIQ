-- 015: Gyftr voucher bridge (V2 feature C).
--
-- Buying a brand e-voucher via Gyftr/HDFC SmartBuy produces two same-instant
-- emails: the bank alert ("GYFTR VIA SMARTBUY", a normal card txn the bank sync
-- already stores) and a Gyftr email listing the voucher(s). A voucher is NOT an
-- order — it's spendable balance — so it gets its own table rather than living
-- in `orders`. The chain we're rebuilding:
--
--     card charge (GYFTR VIA SMARTBUY)  →  voucher (face value)  →  many brand
--                                            orders drawn against it
--
-- * `face_value` is the SPENDABLE balance, not the (often discounted) price
--   paid to Gyftr — the price is the linked card charge's amount. That gap is
--   exactly why a voucher can't be matched by exact amount (voucher-match.ts).
-- * `brand` is as printed ("Amazon Fresh"); `brand_key` is the normalized
--   reconcile key (voucher-bridge.normalizeBrand) — stored so the drawdown
--   query groups by it without re-normalizing in SQL.
-- * `txn_id` is the funding card charge (voucher-match). NULL until matched.
-- * We deliberately never store the voucher PIN — a live secret with no
--   analytical value.
--
-- `orders.voucher_draws` records the bridge's attribution of a (card-unmatched)
-- brand order to one or more vouchers: [{voucher_id, amount, txn_id}]. Empty
-- for card-paid orders. Populated by the drawdown step (next chunk).
--
-- All DDL idempotent. Safe to re-run.

create table if not exists vouchers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  gmail_message_id text not null,
  code             text,                 -- e-gift card code; per-voucher id within one email
  brand            text not null,        -- as printed on the voucher ("Amazon Fresh")
  brand_key        text not null,        -- normalized reconcile key ("amazon")
  face_value       numeric(12,2) not null check (face_value > 0),
  purchased_at     timestamptz not null, -- Gyftr email internalDate (= charge instant)
  valid_till       date,
  txn_id           uuid references transactions(id) on delete set null, -- funding GYFTR charge
  match_confidence text check (match_confidence in ('high','medium','low')),
  matched_at       timestamptz,
  raw_subject      text,
  created_at       timestamptz default now(),
  -- One email can carry several vouchers, each a distinct code → dedupe on the
  -- triple. (The parser always captures a code, so nulls never collide here.)
  unique (user_id, gmail_message_id, code)
);

alter table vouchers enable row level security;
drop policy if exists "own vouchers" on vouchers;
create policy "own vouchers" on vouchers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Drawdown FIFO groups by brand, oldest-first.
create index if not exists vouchers_user_brand_idx
  on vouchers (user_id, brand_key, purchased_at);
-- Charge-matching sweep: "which vouchers still need their funding charge?"
create index if not exists vouchers_user_unmatched_idx
  on vouchers (user_id, purchased_at desc) where txn_id is null;

-- The bridge's attribution of a card-unmatched order to voucher(s).
alter table orders
  add column if not exists voucher_draws jsonb not null default '[]'::jsonb;
