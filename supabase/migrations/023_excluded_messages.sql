-- Migration 023: emails that must never become transactions again
--
-- A card statement proved some stored alerts were never charged (holds released,
-- second copies of one alert, merchant receipts or adverts misread as charges).
-- Their rows are deleted, but the reprocess, backfill and wipe-and-reingest paths
-- re-parse every stored email that has no transaction, so a plain delete would
-- come back on the next run. Every email-to-transaction path skips these IDs.
--
-- A separate table (not a column on gmail_seen_messages) because
-- wipe-and-reingest deletes gmail_seen_messages, and an exclusion must outlive it.
-- Written by scripts/statements-remove-unbilled.ts; a row is removed only by hand.

create table if not exists excluded_messages (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  gmail_message_id text        not null,
  reason           text        not null,
  detail           text,
  created_at       timestamptz not null default now(),
  primary key (user_id, gmail_message_id)
);

alter table excluded_messages enable row level security;
drop policy if exists "own excluded messages" on excluded_messages;
create policy "own excluded messages" on excluded_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
