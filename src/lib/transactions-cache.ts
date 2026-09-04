"use client";

import { useEffect, useSyncExternalStore } from "react";

const DB_NAME = "cardiq-cache";
const STORE_NAME = "kv";
const CACHE_KEY = "transactions-all";
const MIN_REFRESH_INTERVAL_MS = 10_000;

export type TransactionsAllPayload = {
  transactions: unknown[];
  orders?: unknown[];
  vouchers?: unknown[];
  cards: unknown[];
  last_sync: string | null;
};

let memoryData: TransactionsAllPayload | null = null;
let inFlight: Promise<void> | null = null;
let lastFetchedAt = 0;
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<TransactionsAllPayload | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as TransactionsAllPayload) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // private browsing / unsupported — fail open, just no cache
  }
}

async function idbSet(key: string, value: TransactionsAllPayload): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort — a failed cache write should never break the app
  }
}

function hydrateFromCache(): Promise<void> {
  if (!hydrating) {
    hydrating = (async () => {
      const cached = await idbGet(CACHE_KEY);
      if (cached && !memoryData) {
        memoryData = cached;
        notify();
      }
    })();
  }
  return hydrating;
}

/**
 * Force a fresh fetch, bypassing the throttle, and update every mounted
 * consumer immediately. Callers that just changed the underlying data
 * (Gmail sync, recategorize) should call this so Overview/Spend/Insights
 * all reflect the change right away, not on their next individual mount.
 */
export function refreshTransactionsAll(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/transactions/all");
      if (!res.ok) return;
      const json = (await res.json()) as TransactionsAllPayload;
      memoryData = json;
      lastFetchedAt = Date.now();
      notify();
      await idbSet(CACHE_KEY, json);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Optimistically patch the cached payload in place — e.g. after a successful
 * PATCH to a single transaction's category/notes, or a merchant rename —
 * so every mounted consumer (Overview/Spend/Insights) reflects the edit
 * immediately instead of waiting for the next full re-fetch. This is UI
 * responsiveness only: the next refresh (throttled, or a caller's forced
 * `refreshTransactionsAll()`) reconciles against the real database regardless,
 * so a patch is never the source of truth, only a head start on showing it.
 * No-ops if nothing is cached yet — there's nothing to patch.
 */
export function patchTransactionsAll(
  updater: (prev: TransactionsAllPayload) => TransactionsAllPayload
): void {
  if (!memoryData) return;
  memoryData = updater(memoryData);
  notify();
  void idbSet(CACHE_KEY, memoryData);
}

function refreshIfStale(): void {
  if (inFlight) return;
  if (Date.now() - lastFetchedAt < MIN_REFRESH_INTERVAL_MS) return;
  refreshTransactionsAll();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot(): TransactionsAllPayload | null {
  return memoryData;
}

function getServerSnapshot(): TransactionsAllPayload | null {
  return null;
}

/**
 * Shared, cross-tab cache for /api/transactions/all. Overview, Spend, and
 * Insights all show the same transaction/order/voucher history — previously
 * each independently re-fetched and re-downloaded the entire thing from
 * scratch on every single mount, so switching Overview -> Spend -> Overview
 * re-did the same expensive full-history fetch three times.
 *
 * Now: render whatever's cached (in-memory this session, or IndexedDB from
 * last time) INSTANTLY with no network wait, then quietly refresh in the
 * background and update every mounted consumer at once when fresh data
 * lands. Fixed 2026-09-04 after KP reported Overview taking too long to
 * load, which only gets worse as more history accumulates.
 */
export function useTransactionsAll(): { data: TransactionsAllPayload | null; loading: boolean } {
  const data = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    hydrateFromCache();
    refreshIfStale();
  }, []);

  return { data, loading: data === null };
}
