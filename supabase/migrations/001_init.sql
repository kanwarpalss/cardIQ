-- CardIQ initial schema
-- Run this in Supabase SQL editor after creating your project.

-- ============================================================
-- USER SETTINGS (per-user secrets, encrypted at app layer)
-- ============================================================
create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  anthropic_key_encrypted text,        -- AES-256-GCM ciphertext, hex
  google_refresh_token_encrypted text, -- for Gmail offline access
  profile_text text default '',        -- free-text spending profile
  last_gmail_sync_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table user_settings enable row level security;
create policy "own settings" on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- CARDS — one row per physical card (a user can have two of the same product)
-- ============================================================
create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null,           -- e.g. 'axis_magnus_burgundy'
  nickname text,                       -- user-facing label
  last4 text not null,
  color text default '#c9a84c',
  anniversary_date date,               -- nullable; monthly milestones don't need it
  created_at timestamptz default now(),
  unique (user_id, last4)
);

alter table cards enable row level security;
create policy "own cards" on cards
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- TRANSACTIONS — parsed from Gmail txn alerts
-- ============================================================
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid references cards(id) on delete set null,
  card_last4 text not null,
  amount_inr numeric(12,2) not null,
  merchant text,
  category text,
  txn_at timestamptz not null,
  gmail_message_id text not null,      -- dedupe key
  raw_subject text,
  created_at timestamptz default now(),
  unique (user_id, gmail_message_id)
);

create index if not exists transactions_user_txn_at_idx
  on transactions (user_id, txn_at desc);

alter table transactions enable row level security;
create policy "own transactions" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- KNOWLEDGE BASE — per-card-per-topic cached summaries
-- ============================================================
create table if not exists kb_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references cards(id) on delete cascade,
  topic text not null,                 -- 'deals' | 'points' | 'vouchers' | 'lounge' | ...
  content text not null,
  source_url text,
  fetched_at timestamptz not null default now(),
  unique (card_id, topic)
);

alter table kb_entries enable row level security;
create policy "own kb" on kb_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- CHAT MESSAGES + SESSION SUMMARIES
-- ============================================================
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz default now()
);

create index if not exists chat_messages_user_created_idx
  on chat_messages (user_id, created_at);

alter table chat_messages enable row level security;
create policy "own messages" on chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists session_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  summary text not null,
  turns_covered int not null,
  created_at timestamptz default now()
);

alter table session_summaries enable row level security;
create policy "own summaries" on session_summaries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
