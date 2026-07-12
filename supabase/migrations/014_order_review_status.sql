-- 014: Human review/approval layer for order↔transaction matches (V2 feature C).
--
-- The matcher (src/lib/order-match.ts) proposes a link between an order email
-- and a card transaction with a confidence (high/medium/low). Until now that
-- link went live immediately. KP wants a validation step: high-confidence
-- matches auto-confirm, but medium/low ones wait in a Review queue for a
-- thumbs-up before they count as truth in the Spend tab.
--
-- `review_status` is the state machine for that:
--
--   unmatched  → order is not linked to any txn (the default; also where a
--                still-unmatched order sits, waiting for its bank email).
--   pending    → matched at medium/low confidence, awaiting KP's approval.
--   confirmed  → matched at high confidence (auto) OR approved by KP.
--   rejected   → KP said "not this / paid another way (voucher)". PERMANENTLY
--                unlinked (txn_id cleared) and never re-proposed — the reject
--                = permanent-unlink decision (SPEC §5, 2026-07-12).
--
-- Only 'unmatched' rows are candidates for (re-)matching on the next sync, so a
-- 'rejected' order (txn_id null, status rejected) is skipped forever, and a
-- 'pending'/'confirmed' order keeps its txn claim so nothing double-books it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a backfill that only touches rows
-- still at the default, so re-running never overwrites a decision KP has made.

alter table orders
  add column if not exists review_status text not null default 'unmatched';

-- Constraint added separately (ADD COLUMN can't carry an IF-NOT-EXISTS check).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_review_status_check'
  ) then
    alter table orders
      add constraint orders_review_status_check
      check (review_status in ('unmatched','pending','confirmed','rejected'));
  end if;
end $$;

-- Backfill pre-014 matches. Only rows still at the default that already carry a
-- txn_id are reclassified, so a decision KP later makes (approve → confirmed,
-- reject → rejected) is never clobbered by a re-run.
update orders
set review_status = case
  when match_confidence = 'high' then 'confirmed'
  else 'pending'                       -- medium / low / (defensive) null
end
where review_status = 'unmatched' and txn_id is not null;

-- The Review tab's hot query: "what's still pending?" — a small, growing set.
create index if not exists orders_user_pending_idx
  on orders (user_id, order_at desc) where review_status = 'pending';
