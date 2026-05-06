-- Migration 002: store full email body + merchant normalization table

-- Add raw_body and category to transactions
alter table transactions add column if not exists raw_body text;
alter table transactions add column if not exists category text;

-- Merchant mappings: raw merchant name → normalized name + category
create table if not exists merchant_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_name text not null,                -- exactly as it appears in transaction alerts
  normalized_name text not null,         -- human-readable (e.g. "Third Wave Coffee")
  category text,                         -- optional (e.g. "Dining", "Groceries", "Travel")
  created_at timestamptz default now(),
  unique (user_id, raw_name)
);

alter table merchant_mappings enable row level security;
create policy "own mappings" on merchant_mappings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Index to speed up merchant lookups during sync
create index if not exists merchant_mappings_raw_name_idx
  on merchant_mappings (user_id, lower(raw_name));
