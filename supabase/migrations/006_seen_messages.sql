-- Migration 006: Gmail seen-messages deduplication table
--
-- Every Gmail message ID we ever download gets recorded here, whether it
-- produced a transaction or was skipped (marketing, statement, etc.).
--
-- This is the single source of truth for "have we already fetched this email?"
-- It lets incremental syncs skip re-downloading messages we already processed,
-- regardless of how the lookback window or time filter changes in the UI.
--
-- Design intent:
--   • A row is written once (insert-on-conflict-do-nothing).
--   • It is NEVER deleted (rows are immutable — the whole point is "seen forever").
--   • `txn_id` is nullable: NULL means the email was fetched but not transactional.
--     When a future card is added and the same email qualifies as a transaction,
--     the application layer handles that via the transactions table independently.

create table if not exists gmail_seen_messages (
  user_id          uuid    not null references auth.users(id) on delete cascade,
  gmail_message_id text    not null,
  seen_at          timestamptz not null default now(),
  -- nullable: links to the transaction row if this email produced one
  txn_id           uuid    references transactions(id) on delete set null,
  primary key (user_id, gmail_message_id)
);

alter table gmail_seen_messages enable row level security;
drop policy if exists "own seen messages" on gmail_seen_messages;
create policy "own seen messages" on gmail_seen_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Fast lookup during sync: "have I already downloaded this message ID?"
create index if not exists gmail_seen_messages_user_msg_idx
  on gmail_seen_messages (user_id, gmail_message_id);
