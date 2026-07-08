-- 009: Rewards, Offers, Loyalty — the "holistic" layer.
-- Run manually in Supabase SQL Editor AFTER 008.
-- Safe to re-run: all DDL uses IF NOT EXISTS / DROP IF EXISTS guards.
--
-- Why THREE tables and not one "points" table:
--   * reward_balances — card-program points (EDGE, HDFC RP…). They belong to a
--     card and die with it → FK to cards WITH cascade.
--   * loyalty_accounts — airline/hotel programs (Maharaja Club, Marriott Bonvoy…).
--     Your status outlives any card → NO card FK, only a free-text linked_card note.
--   * offers — time-boxed card offers; may be card-specific or generic → nullable
--     card FK with set-null so deleting a card keeps the offer.
--
-- Every table carries `source` ('manual' today, 'parsed' when the Gmail pipeline
-- learns to read loyalty/offer emails) so V2 ingestion writes into the SAME tables.

-- ============================================================
-- REWARD BALANCES — point-balance snapshots per card
-- Latest snapshot (as_of DESC, created_at DESC) = current balance.
-- ============================================================
create table if not exists reward_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references cards(id) on delete cascade,
  program text not null,
  balance numeric(14,2) not null,
  as_of date not null default current_date,
  source text not null default 'manual' check (source in ('manual','parsed')),
  notes text,
  created_at timestamptz default now()
);

create index if not exists reward_balances_user_card_asof_idx
  on reward_balances (user_id, card_id, as_of desc, created_at desc);

alter table reward_balances enable row level security;
drop policy if exists "own reward balances" on reward_balances;
create policy "own reward balances" on reward_balances
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- OFFERS — user-tracked card offers with validity windows
-- valid_until NULL means "no expiry", never "expires today".
-- ============================================================
create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid references cards(id) on delete set null,
  title text not null,
  merchant text,
  description text,
  valid_from date,
  valid_until date,
  source_url text,
  status text not null default 'active' check (status in ('active','used','expired','archived')),
  source text not null default 'manual' check (source in ('manual','parsed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists offers_user_status_valid_idx
  on offers (user_id, status, valid_until);

alter table offers enable row level security;
drop policy if exists "own offers" on offers;
create policy "own offers" on offers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- LOYALTY ACCOUNTS — airline / hotel / other program statuses
-- ============================================================
create table if not exists loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  program_name text not null,
  program_type text not null default 'airline' check (program_type in ('airline','hotel','other')),
  member_id text,
  tier text,
  tier_expires_on date,
  points_balance numeric(14,2),
  points_expire_on date,
  linked_card text,
  notes text,
  source text not null default 'manual' check (source in ('manual','parsed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists loyalty_accounts_user_type_idx
  on loyalty_accounts (user_id, program_type);

alter table loyalty_accounts enable row level security;
drop policy if exists "own loyalty accounts" on loyalty_accounts;
create policy "own loyalty accounts" on loyalty_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
