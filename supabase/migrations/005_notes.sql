-- Migration 005: per-transaction notes
-- Lets the user attach an optional free-form note to any transaction.
-- The UI provides autofill suggestions sourced from the user's existing notes.

alter table transactions add column if not exists notes text;
