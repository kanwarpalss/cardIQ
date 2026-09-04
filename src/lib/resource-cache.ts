"use client";

import { useEffect, useSyncExternalStore } from "react";

const DB_NAME = "cardiq-cache";
const STORE_NAME = "kv";
const MIN_REFRESH_INTERVAL_MS = 10_000;

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

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // private browsing / unsupported — fail open, just no cache
  }
}

async function idbSet<T>(key: string, value: T): Promise<void> {
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

export type CachedResource<T> = {
  useResource: () => { data: T | null; loading: boolean; error: string | null };
  refresh: () => Promise<void>;
  patch: (updater: (prev: T) => T) => void;
};

/**
 * A shared, cross-tab, stale-while-revalidate cache for one GET endpoint:
 * render whatever's cached (in-memory this session, or IndexedDB from last
 * time) INSTANTLY with no network wait, then quietly refresh in the
 * background and update every mounted consumer at once when fresh data
 * lands. Any component calling `useResource()` for the same `cacheKey`
 * shares one fetch — opening several such tabs back to back re-fetches once,
 * not once per tab.
 *
 * The response body is cached whether or not the HTTP status was ok: these
 * endpoints return a meaningful structured payload even on a "soft" error
 * (e.g. `{ error: "missing_orders_table", orders: [] }` at 400 for a
 * not-yet-run migration), and callers rely on seeing that shape to render
 * the right notice — only a genuine network failure (fetch/parse throwing)
 * leaves the cache untouched.
 *
 * Extracted 2026-09-04 from the transactions/all-specific version of this
 * (fixed Overview/Spend/Insights each independently re-fetching the full
 * history on every mount) so Orders and Vouchers — which had the identical
 * problem — could reuse it instead of a third copy-paste (ARCH-04).
 */
export function createCachedResource<T>(endpoint: string, cacheKey: string): CachedResource<T> {
  let memoryData: T | null = null;
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;
  let lastFetchedAt = 0;
  let hydrating: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function hydrateFromCache(): Promise<void> {
    if (!hydrating) {
      hydrating = (async () => {
        const cached = await idbGet<T>(cacheKey);
        if (cached && !memoryData) {
          memoryData = cached;
          notify();
        }
      })();
    }
    return hydrating;
  }

  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const res = await fetch(endpoint);
        const json = (await res.json()) as T;
        memoryData = json;
        lastError = null;
        lastFetchedAt = Date.now();
        notify();
        await idbSet(cacheKey, json);
      } catch (e) {
        // Network failure / non-JSON response. Leave whatever's already
        // cached in place (stale data beats an error banner) — but if there's
        // nothing cached yet (first-ever visit, backend genuinely down), a
        // silently-forever "loading" state would hide a real failure (EDGE-03),
        // so surface it only in that case.
        if (!memoryData) {
          lastError = e instanceof Error ? e.message : "Couldn't reach the server. Try again.";
          notify();
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function refreshIfStale(): void {
    if (inFlight) return;
    if (Date.now() - lastFetchedAt < MIN_REFRESH_INTERVAL_MS) return;
    refresh();
  }

  function patch(updater: (prev: T) => T): void {
    if (!memoryData) return;
    memoryData = updater(memoryData);
    notify();
    void idbSet(cacheKey, memoryData);
  }

  function subscribe(onStoreChange: () => void): () => void {
    listeners.add(onStoreChange);
    return () => listeners.delete(onStoreChange);
  }

  function getDataSnapshot(): T | null {
    return memoryData;
  }

  function getErrorSnapshot(): string | null {
    return lastError;
  }

  function getServerSnapshot(): null {
    return null;
  }

  function useResource(): { data: T | null; loading: boolean; error: string | null } {
    const data = useSyncExternalStore(subscribe, getDataSnapshot, getServerSnapshot);
    const error = useSyncExternalStore(subscribe, getErrorSnapshot, getServerSnapshot);

    useEffect(() => {
      hydrateFromCache();
      refreshIfStale();
    }, []);

    return { data, loading: data === null && error === null, error };
  }

  return { useResource, refresh, patch };
}
