-- 016: Same-purchase order de-duplication (V2 feature C).
--
-- One purchase yields several order emails — the merchant's own, the payment
-- gateway's ("Payment successful for <legal entity>"), sometimes a shipper's.
-- Each is parsed as a separate `orders` row. KP's rule: same amount at
-- (essentially) the same time = the same purchase, reported by different
-- entities. We keep one PRIMARY per cluster and flag the rest.
--
-- `duplicate_of` points a duplicate row at its primary. A duplicate is also set
-- review_status = 'pending' so it surfaces in the Review queue, where rejecting
-- it removes it from the ledger (reject = permanent unlink, migration 014).
-- NULL = not a duplicate (a primary or a unique order).
--
-- Idempotent. Safe to re-run.

alter table orders
  add column if not exists duplicate_of uuid references orders(id) on delete set null;

-- The ledger/UI filter "show me the real orders, hide duplicates".
create index if not exists orders_user_primary_idx
  on orders (user_id, order_at desc) where duplicate_of is null;
