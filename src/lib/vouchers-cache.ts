"use client";

import { createCachedResource } from "./resource-cache";

export type VouchersAllPayload = {
  vouchers: unknown[];
  error?: string;
};

/**
 * Shared cache for /api/vouchers (the Gyftr voucher ledger) — same
 * stale-while-revalidate pattern as transactions-cache.ts, extended here
 * 2026-09-04 since VouchersTab had the identical problem: a full re-fetch of
 * every voucher (plus a second full re-fetch of every order, for drawdown
 * math) on every mount, no caching at all.
 */
const vouchersAll = createCachedResource<VouchersAllPayload>("/api/vouchers", "vouchers-all");

/** Render whatever's cached instantly; refreshes in the background. */
export const useVouchersAll = vouchersAll.useResource;

/** Force a fresh fetch — VouchersTab is currently read-only, so nothing
 *  calls this yet, but it's here for parity/future use. */
export const refreshVouchersAll = vouchersAll.refresh;
