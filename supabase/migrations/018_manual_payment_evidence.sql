-- 018: Allow the "manual" payment-evidence tier.
--
-- When a merchant email doesn't state how an order was paid (Pure Home's receipt
-- shows no payment method), KP can verify it by hand — which Gyftr vouchers
-- funded it + the card remainder. That human confirmation is the TOP evidence
-- tier: the reconcile never overwrites it and draws its vouchers first
-- (Invariant #7). This widens the 017 CHECK to accept 'manual'.
--
-- NOTE: 'inferred_fifo' is deliberately NOT here — it lives inside the
-- voucher_draws JSON (per-draw evidence), never in this order-level column.
--
-- Additive + idempotent; safe to run more than once.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_payment_evidence_check'
  ) then
    alter table orders drop constraint orders_payment_evidence_check;
  end if;
  alter table orders add constraint orders_payment_evidence_check
    check (payment_evidence is null or payment_evidence in ('email','inferred_split','manual'));
end $$;
