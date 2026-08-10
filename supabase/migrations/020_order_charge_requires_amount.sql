-- 020: An order can claim a card transaction only when it contains positive
-- payment evidence.
--
-- Historic Amazon "Your package has been delivered" emails had no amount but
-- the old matcher could attach one to a nearby Amazon charge. Revalidate every
-- existing association against the canonical amount/date/type/owner rules,
-- then prevent amount-less links from being written again at the database
-- boundary. Order and transaction rows remain available; nothing is deleted.

update orders o
set txn_id = null,
    match_confidence = null,
    matched_at = null,
    review_status = case when review_status = 'rejected' then 'rejected' else 'unmatched' end
from transactions t
where o.txn_id = t.id
  and (
    o.user_id <> t.user_id
    or
    case
      when o.kind = 'refund' then o.total_amount
      else coalesce(o.card_paid_amount, o.total_amount)
    end is null
    or
    case
      when o.kind = 'refund' then o.total_amount
      else coalesce(o.card_paid_amount, o.total_amount)
    end <= 0
    or t.amount_inr <= 0
    or abs(
      t.amount_inr -
      case
        when o.kind = 'refund' then o.total_amount
        else coalesce(o.card_paid_amount, o.total_amount)
      end
    ) > 0.75
    or (o.kind = 'refund' and t.txn_type <> 'credit')
    or (o.kind = 'order' and t.txn_type <> 'debit')
    or abs(extract(epoch from (o.order_at - t.txn_at))) > 432000
  );

-- A transaction claimed by more than one order is ambiguous even when each
-- pair looks plausible in isolation. Release every side for later rematching
-- rather than choosing a winner by row order.
with duplicate_claims as (
  select user_id, txn_id
  from orders
  where txn_id is not null
  group by user_id, txn_id
  having count(*) > 1
)
update orders o
set txn_id = null,
    match_confidence = null,
    matched_at = null,
    review_status = case when review_status = 'rejected' then 'rejected' else 'unmatched' end
from duplicate_claims d
where o.user_id = d.user_id
  and o.txn_id = d.txn_id;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'orders'::regclass
      and conname = 'orders_link_requires_positive_amount'
  ) then
    alter table orders add constraint orders_link_requires_positive_amount
      check (
        txn_id is null
        or (
          case
            when kind = 'refund' then total_amount
            else coalesce(card_paid_amount, total_amount)
          end is not null
          and
          case
            when kind = 'refund' then total_amount
            else coalesce(card_paid_amount, total_amount)
          end > 0
        )
      );
  end if;
end $$;
