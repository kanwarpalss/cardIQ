"use client";

import { createCachedResource } from "./resource-cache";

export type TransactionsAllPayload = {
  transactions: unknown[];
  orders?: unknown[];
  vouchers?: unknown[];
  cards: unknown[];
  last_sync: string | null;
};

/**
 * Shared, cross-tab cache for /api/transactions/all. Overview, Spend, and
 * Insights all show the same transaction/order/voucher history — previously
 * each independently re-fetched and re-downloaded the entire thing from
 * scratch on every single mount, so switching Overview -> Spend -> Overview
 * re-did the same expensive full-history fetch three times. Fixed 2026-09-04
 * after KP reported Overview taking too long to load, which only gets worse
 * as more history accumulates. See resource-cache.ts for how the cache itself
 * works (in-memory + IndexedDB, stale-while-revalidate).
 */
const transactionsAll = createCachedResource<TransactionsAllPayload>(
  "/api/transactions/all",
  "transactions-all"
);

/** Render whatever's cached instantly; refreshes in the background. */
export const useTransactionsAll = transactionsAll.useResource;

/**
 * Force a fresh fetch, bypassing the throttle, and update every mounted
 * consumer immediately. Callers that just changed the underlying data
 * (Gmail sync, recategorize) should call this so Overview/Spend/Insights
 * all reflect the change right away, not on their next individual mount.
 */
export const refreshTransactionsAll = transactionsAll.refresh;

/**
 * Optimistically patch the cached payload in place — e.g. after a successful
 * PATCH to a single transaction's category/notes, or a merchant rename —
 * so every mounted consumer reflects the edit immediately instead of waiting
 * for the next full re-fetch. UI responsiveness only: the next refresh
 * reconciles against the real database regardless, so a patch is never the
 * source of truth. No-ops if nothing is cached yet.
 */
export const patchTransactionsAll = transactionsAll.patch;
