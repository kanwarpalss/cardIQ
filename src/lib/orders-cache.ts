"use client";

import { createCachedResource } from "./resource-cache";

export type OrdersAllPayload = {
  orders: unknown[];
  error?: string;
};

/**
 * Shared cache for /api/orders (the standalone Orders ledger) — same
 * stale-while-revalidate pattern as transactions-cache.ts, extended here
 * 2026-09-04 since OrdersTab had the identical problem: a full, unbounded
 * re-fetch of every order on every mount, no caching at all.
 */
const ordersAll = createCachedResource<OrdersAllPayload>("/api/orders", "orders-all");

/** Render whatever's cached instantly; refreshes in the background. */
export const useOrdersAll = ordersAll.useResource;

/** Force a fresh fetch after a mutation (payment link saved, backfill/import
 *  finished) so the tab reflects the change right away. */
export const refreshOrdersAll = ordersAll.refresh;
