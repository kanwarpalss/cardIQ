-- 012: Two-tier categories (V2 feature A).
--
-- Adds a nullable `subcategory` to transactions and merchant_mappings.
-- The canonical subcategory list lives in src/lib/categories.ts (ARCH-04 —
-- one source of truth shared by UI and backend); the DB stores free text so
-- user-defined subcategories work exactly like user-defined categories.
--
-- NULL subcategory = "no second tier" and renders as just the category.
--
-- All DDL is idempotent. Safe to re-run.

alter table transactions
  add column if not exists subcategory text;

alter table merchant_mappings
  add column if not exists subcategory text;
