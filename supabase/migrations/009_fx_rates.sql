-- 009: FX rates cache for historical currency conversion.
--
-- We need to convert foreign-currency txns (USD/IDR/EUR/etc.) to INR using
-- the rate that was in effect ON THE TXN DATE — not today's rate. Today's
-- rate is fine for "what's it worth now?" tooltips but wrong for spend
-- analytics ("how much did that hotel cost me?").
--
-- The cache is keyed by (currency, date) and stores rate_to_inr (i.e.
-- 1 unit of `currency` = N INR on that date). Global, not per-user — FX
-- rates are public market data, no RLS needed.
--
-- We populate this lazily: when a foreign-currency txn comes in, the
-- enrich helper looks up the rate, falling back to a free historical-FX
-- API (fawazahmed0/currency-api on jsdelivr) and writing the result back
-- so future reads are instant.

create table if not exists fx_rates (
  currency     text not null,
  rate_date    date not null,
  rate_to_inr  numeric(20,8) not null,
  fetched_at   timestamptz not null default now(),
  primary key (currency, rate_date)
);

-- Index for "give me all rates for this currency in a date range" lookups
-- (useful if we later batch-refresh).
create index if not exists fx_rates_currency_idx on fx_rates (currency);

-- Anyone can read (rates are public).
alter table fx_rates enable row level security;
drop policy if exists "fx_rates read" on fx_rates;
create policy "fx_rates read" on fx_rates for select using (true);
-- Writes happen from server routes (service-role/anon-no-rls bypass) only.
drop policy if exists "fx_rates write" on fx_rates;
create policy "fx_rates write" on fx_rates for insert with check (true);
