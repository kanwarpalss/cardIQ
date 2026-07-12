-- 013: Any-merchant orders (V2 feature C — generic rewrite).
--
-- Migration 011 constrained orders.source to five marketplaces:
--   check (source in ('amazon','swiggy','zomato','bigbasket','blinkit'))
-- But order emails come from ANY merchant (D2C brands on Shopify bill direct
-- via Razorpay), so source now also takes 'shopify' and 'generic' — and, in
-- principle, anything. Rather than re-list values every time a new parser is
-- added, we DROP the CHECK entirely: the platform is descriptive metadata, and
-- the real brand lives in merchant_name. A bad value can never corrupt money.
--
-- Idempotent: finds and drops any CHECK constraint on `orders` that references
-- the source column, so re-running is a no-op.

do $$
declare c text;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%source%'
  loop
    execute format('alter table orders drop constraint %I', c);
  end loop;
end $$;
