-- 017: Evidence-backed voucher/card split payments.
--
-- `total_amount` remains the full merchant order value. The two portion fields
-- explain how that value was funded and allow one order to carry BOTH its
-- direct merchant card transaction (`txn_id`) and its Gyftr voucher draws.
-- NULL means "not stated/inferred", not zero.
--
-- `payment_evidence` is intentionally small and auditable:
--   email          — the merchant email explicitly itemised the portions.
--   inferred_split — unique same-merchant card charge + an eligible voucher
--                    balance exactly cover the order total.
--
-- Existing RLS on `orders` continues to protect these columns. Additive and
-- idempotent; safe to run more than once.

alter table orders
  add column if not exists card_paid_amount numeric(12,2),
  add column if not exists voucher_paid_amount numeric(12,2),
  add column if not exists voucher_brand_key text,
  add column if not exists payment_evidence text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_card_paid_nonnegative'
  ) then
    alter table orders add constraint orders_card_paid_nonnegative
      check (card_paid_amount is null or card_paid_amount >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_voucher_paid_nonnegative'
  ) then
    alter table orders add constraint orders_voucher_paid_nonnegative
      check (voucher_paid_amount is null or voucher_paid_amount >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_payment_evidence_check'
  ) then
    alter table orders add constraint orders_payment_evidence_check
      check (payment_evidence is null or payment_evidence in ('email','inferred_split'));
  end if;
end $$;

