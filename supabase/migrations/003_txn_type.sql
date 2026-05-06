-- Migration 003: add transaction type (debit vs credit/refund)
alter table transactions add column if not exists txn_type text not null default 'debit'
  check (txn_type in ('debit', 'credit'));
