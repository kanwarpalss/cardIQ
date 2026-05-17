-- Migration 011: drop dining_sessions table (no longer needed).
-- All three platforms (Zomato, Swiggy, EazyDiner) expose their
-- offers to guest requests — no stored auth tokens required.

drop table if exists dining_sessions;
