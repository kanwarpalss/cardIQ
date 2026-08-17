-- 021: Redemptions — the "what do I hold, and when does it die" layer.
-- Run manually in Supabase SQL Editor AFTER 020.
-- Safe to re-run: all DDL uses IF NOT EXISTS / DROP IF EXISTS guards.
--
-- Context: the Redemptions section unifies THREE kinds of holding. Two already
-- had tables from migration 009 and are reused as-is (ARCH-04, one source of
-- truth — Redemptions is a new VIEW, not a new copy of the data):
--   * loyalty_accounts — airline/hotel miles. Already carries points_balance +
--     points_expire_on. No change needed here.
--   * reward_balances  — card-program points. Carried a balance but NO expiry,
--     which is the whole point of this section. One column added below.
-- The third kind had no home at all and is created here:
--   * perk_vouchers    — vouchers/certificates GRANTED to the user (free hotel
--     nights, flight vouchers, milestone gift cards).
--
-- Why perk_vouchers is NOT the existing `vouchers` table (migration 015):
--   `vouchers` is the Gyftr ledger — vouchers the user BOUGHT, with a funding
--   charge, a running balance, and evidence-based drawdowns against orders.
--   A comped free-night certificate has no funding charge, no balance to draw
--   down, and no order to reconcile against. Forcing it into that table would
--   mean a voucher row whose funding charge is permanently NULL, silently
--   corrupting the ledger's card-spend attribution (Invariant #7). Separate
--   table, separate concern.

-- ============================================================
-- REWARD BALANCES — add the missing expiry date
-- Nullable: most card programs never expire points, and NULL must read as
-- "no expiry", never as "expires today".
-- The expiry lives on the SNAPSHOT (not the card) because it changes over
-- time; the latest snapshot per card carries the current expiry date.
-- ============================================================
alter table reward_balances
  add column if not exists points_expire_on date;

-- ============================================================
-- PERK VOUCHERS — certificates and vouchers granted to the user
-- ============================================================
create table if not exists perk_vouchers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- What it is
  brand text not null,                       -- "Taj", "Marriott", "Vistara"
  title text,                                -- "1 free night, category 1-4"
  voucher_type text not null default 'other'
    check (voucher_type in ('hotel_night','flight','lounge','gift_card','upgrade','other')),

  -- How many you hold. A milestone can grant 2 identical certificates; storing
  -- a quantity beats forcing duplicate rows the user has to edit in lockstep.
  quantity integer not null default 1 check (quantity >= 1),

  -- What it's worth (optional — many certs have no stated cash value)
  value_inr numeric(12,2),

  -- When it dies. NULL = no stated expiry.
  expires_on date,

  -- Where it came from. card_id when it's a specific card's milestone perk;
  -- set null (not cascade) so removing a card keeps the voucher visible.
  card_id uuid references cards(id) on delete set null,
  granted_by text,                           -- free text, e.g. "Magnus milestone"
  code text,                                 -- voucher/certificate code

  status text not null default 'unused'
    check (status in ('unused','used','expired','archived')),
  notes text,

  -- 'manual' today; 'parsed' when the Gmail pipeline learns to read these.
  -- Same convention as migration 009 so future ingestion writes the SAME table.
  source text not null default 'manual' check (source in ('manual','parsed')),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Drives the "expiring soon" query: own rows, still-live ones, soonest first.
create index if not exists perk_vouchers_user_status_expiry_idx
  on perk_vouchers (user_id, status, expires_on);

alter table perk_vouchers enable row level security;
drop policy if exists "own perk vouchers" on perk_vouchers;
create policy "own perk vouchers" on perk_vouchers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
