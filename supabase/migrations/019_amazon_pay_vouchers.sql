-- 019: Gift vouchers delivered through Amazon Pay can fund an order without a
-- card charge. Keep that distinct from an unmatched card-funded Gyftr voucher.
-- The actual delivery email remains the existing gmail_message_id evidence.

alter table vouchers
  add column if not exists funding_source text not null default 'card';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'vouchers'::regclass and conname = 'vouchers_funding_source_check'
  ) then
    alter table vouchers add constraint vouchers_funding_source_check
      check (funding_source in ('card', 'amazon_pay'));
  end if;
end $$;

comment on column vouchers.funding_source is
  'card = linked to a bank charge; amazon_pay = delivery email plus human-confirmed split, funded from Amazon Pay balance.';
