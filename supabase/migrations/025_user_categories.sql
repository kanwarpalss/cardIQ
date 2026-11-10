-- Migration 025: user-editable categories + "I set this one myself" flag
--
-- 1. user_category_taxonomy — one row per user holding their own category
--    tree (add / rename / delete / reorder) and the aliases that renames and
--    deletes leave behind ("Dining" → "Food"), so keyword rules that still
--    emit default names follow the user's rename on every future sync.
--    `categories` NULL = "use the defaults in src/lib/categories.ts".
--    Shapes are validated in src/lib/category-taxonomy.ts (sanitizeTaxonomy /
--    sanitizeAliases); a malformed row degrades to defaults, never a crash.
--
-- 2. transactions.category_manual — true when the user picked this
--    transaction's category themselves (single edit or the same-merchant
--    review popup). "Re-categorize" leaves these rows alone, so a transaction
--    deliberately left out of a bulk change stays the way the user left it.
--
-- Safe to re-run.

create table if not exists user_category_taxonomy (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  categories jsonb,
  aliases    jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table user_category_taxonomy enable row level security;
drop policy if exists "own category taxonomy" on user_category_taxonomy;
create policy "own category taxonomy" on user_category_taxonomy
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table transactions
  add column if not exists category_manual boolean not null default false;
