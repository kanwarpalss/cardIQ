-- 012: Add booking_type to dining_offers.
-- Taxonomy defined in docs/DINING_OFFER_TAXONOMY.md (2026-05-17).
-- offer_type already exists as TEXT from migration 010 — just add booking_type.

alter table dining_offers
  add column if not exists booking_type text check (booking_type in ('prebook', 'walkin', 'either'));
