-- 008: Foreign-currency columns + corruption repair.
--
-- The parsers have been writing original_currency / original_amount /
-- low_confidence to the transactions table for a while, but these columns
-- were never formally declared in a migration (they got added manually to
-- live Supabase). This migration:
--
--   1. Formally adds the three columns (idempotent — IF NOT EXISTS).
--   2. Backfills original_currency='INR' for rows where it's NULL
--      (legacy rows from before multi-currency support).
--   3. REPAIRS the corruption from the Axis/sniffer parser bug:
--      For any row where the txn was foreign-currency but amount_inr was
--      set to the foreign amount (because no INR conversion was found in
--      the email), zero out amount_inr so the dashboard stops summing
--      IDR/USD/EUR amounts as if they were INR.
--
-- Detection heuristic for corrupted rows:
--   original_currency <> 'INR'
--   AND original_amount IS NOT NULL
--   AND amount_inr = original_amount   -- the parser copied foreign → INR
--
-- This is conservative: a foreign txn whose INR equivalent happened to
-- equal the foreign amount won't be touched (ambiguous, but vanishingly
-- unlikely — would require e.g. exactly 1.00 USD = 1.00 INR).

alter table transactions add column if not exists original_currency text;
alter table transactions add column if not exists original_amount   numeric(14,2);
alter table transactions add column if not exists low_confidence    boolean default false;

-- Backfill legacy rows.
update transactions
   set original_currency = 'INR'
 where original_currency is null;

-- Index for the dashboard's currency-split query.
create index if not exists transactions_user_currency_idx
  on transactions (user_id, original_currency);

-- ── Repair corrupted INR totals ─────────────────────────────────────────
-- Capture how many rows we're about to fix so it shows up in psql output.
do $$
declare
  fixed_count int;
begin
  update transactions
     set amount_inr = 0
   where original_currency is not null
     and upper(original_currency) <> 'INR'
     and original_amount is not null
     and amount_inr = original_amount;
  get diagnostics fixed_count = row_count;
  raise notice 'Repaired % foreign-currency rows where amount_inr was incorrectly set to the foreign amount.', fixed_count;
end $$;
