-- Migration 007: Make gmail_seen_messages self-sufficient for re-parsing.
--
-- BEFORE: when an email was fetched and parsed → row in transactions (with raw_body).
--         when an email was fetched and DIDN'T parse → row in gmail_seen_messages
--         with no body. Forever invisible to future parser improvements unless
--         we re-hit the Gmail API.
--
-- AFTER:  we store raw_subject + raw_body on gmail_seen_messages too. A simple
--         /api/recategorize-style sweep can now retry parsing all "seen but
--         not transaction" emails locally — no Gmail round-trips.

alter table gmail_seen_messages
  add column if not exists raw_subject text;
alter table gmail_seen_messages
  add column if not exists raw_body text;
alter table gmail_seen_messages
  add column if not exists raw_from text;          -- so we know which parser to try
alter table gmail_seen_messages
  add column if not exists internal_date bigint;   -- ms epoch — for accurate txn_at
