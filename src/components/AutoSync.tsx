"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decideAutoSync, mayAttemptAfterFailure, isReauthRequired,
  STALE_AFTER_MINUTES, type SyncStatus, type AutoSyncDecision,
} from "@/lib/gmail/auto-sync";
import { runFullSync } from "@/lib/gmail/stream-sync";

/**
 * Keeps CardIQ current without the user ever pressing Sync.
 *
 * Fires on three triggers, all funnelled through the same decision rules:
 *   1. app open (mount)
 *   2. window refocus — the tab is often left open for days
 *   3. a periodic re-check, so a permanently-open tab keeps ingesting
 *
 * Two things it deliberately does NOT do:
 *   • never starts the 8-year FIRST sync automatically (20–30 min) — that
 *     gets a one-click prompt instead
 *   • never fails silently — a dead Google grant becomes a persistent banner,
 *     because the failure mode of quiet auto-sync is a user who thinks their
 *     data is current when it stopped updating weeks ago (EDGE-03)
 */

/** Re-check cadence for a tab that stays open. */
const RECHECK_MS = STALE_AFTER_MINUTES * 60_000;

/** localStorage key: epoch ms of the last FAILED attempt (drives backoff). */
const FAIL_KEY = "cardiq:autosync:lastFailedAt";

/**
 * Cross-tab / React-StrictMode concurrency guard. Module scope, not state:
 * two mounts of this component in the same page must not both start a sync.
 * Lifetime: the page session — reset on reload, which is correct, since an
 * interrupted sync leaves the cursor unadvanced and is safe to re-run.
 */
let syncInFlight = false;

type Phase =
  | { kind: "idle" }
  | { kind: "syncing"; text: string }
  | { kind: "done"; text: string }
  | { kind: "needs_first_sync" }
  | { kind: "error"; text: string; reauth: boolean };

function readFailedAt(): number | null {
  try {
    const raw = localStorage.getItem(FAIL_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null; // storage blocked (private mode) — never let this stop a sync
  }
}
function writeFailedAt(v: number | null) {
  try {
    if (v === null) localStorage.removeItem(FAIL_KEY);
    else localStorage.setItem(FAIL_KEY, String(v));
  } catch { /* storage blocked — backoff degrades to per-session only */ }
}

export default function AutoSync({ onSynced }: { onSynced?: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  /** Runs the real sync. `force` skips the failure backoff (user clicked). */
  const doSync = useCallback(async (lookbackDays: number | undefined, force: boolean) => {
    if (syncInFlight) return;
    if (!force && !mayAttemptAfterFailure(readFailedAt())) return;

    syncInFlight = true;
    abortRef.current = new AbortController();
    setPhase({ kind: "syncing", text: "Checking Gmail…" });

    try {
      const r = await runFullSync(
        lookbackDays,
        (text) => setPhase({ kind: "syncing", text }),
        abortRef.current.signal
      );
      writeFailedAt(null); // success clears the backoff

      const bits: string[] = [];
      if (r.newTxns) bits.push(`${r.newTxns} new transaction${r.newTxns > 1 ? "s" : ""}`);
      if (r.newOrders) bits.push(`${r.newOrders} order${r.newOrders > 1 ? "s" : ""}`);
      if (r.matched) bits.push(`${r.matched} linked`);

      // Only announce when something actually arrived. A pill that says
      // "up to date" after every navigation is noise, not information.
      if (bits.length) {
        setPhase({ kind: "done", text: bits.join(" · ") });
        onSynced?.();
        setTimeout(() => setPhase({ kind: "idle" }), 8000);
      } else {
        setPhase({ kind: "idle" });
      }
    } catch (e) {
      const msg = (e as Error).message || "Sync failed";
      if ((e as Error).name === "AbortError") {
        setPhase({ kind: "idle" });
      } else {
        writeFailedAt(Date.now());
        setPhase({ kind: "error", text: msg, reauth: isReauthRequired(msg) });
      }
    } finally {
      syncInFlight = false;
      abortRef.current = null;
    }
  }, [onSynced]);

  /** Asks the server what state we're in, then acts on the shared rules. */
  const check = useCallback(async () => {
    if (syncInFlight) return;
    try {
      const res = await fetch("/api/gmail/sync-status");
      if (!res.ok) return; // not signed in / transient — stay quiet, retry next trigger
      const json = (await res.json()) as SyncStatus & { decision?: AutoSyncDecision };

      // Re-derive locally rather than trusting the server's copy blindly —
      // same function, so they agree, and the client stays correct if the
      // response shape ever lags behind.
      const decision = decideAutoSync({
        hasRefreshToken: json.hasRefreshToken,
        hasCursor: json.hasCursor,
        lastSyncedAt: json.lastSyncedAt,
      });

      if (decision.action === "sync") {
        await doSync(undefined, false); // undefined = incremental, never a backfill
      } else if (decision.action === "prompt") {
        setPhase({ kind: "needs_first_sync" });
      }
      // "skip" / "blocked" → show nothing. Blocked is surfaced by Cards →
      // Gmail connection, which already explains how to reconnect.
    } catch {
      // Network blip on a background probe is not worth alarming about; the
      // next focus/interval trigger retries.
    }
  }, [doSync]);

  // Trigger 1: app open.
  useEffect(() => { check(); }, [check]);

  // Trigger 2 + 3: refocus and periodic re-check while the tab stays open.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const id = setInterval(check, RECHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [check]);

  if (phase.kind === "idle") return null;

  const base =
    "fixed z-50 bottom-4 right-4 max-w-sm rounded-xl border px-4 py-2.5 text-sm shadow-card backdrop-blur-md";

  if (phase.kind === "syncing") {
    return (
      <div className={`${base} border-rim bg-surface/95 text-mist/75`} role="status" aria-live="polite">
        <span className="inline-block w-2 h-2 rounded-full bg-gold animate-pulse mr-2 align-middle" />
        {phase.text}
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className={`${base} border-emerald/40 bg-emerald/10 text-emerald`} role="status" aria-live="polite">
        ✓ Synced — {phase.text}
      </div>
    );
  }

  if (phase.kind === "needs_first_sync") {
    return (
      <div className={`${base} border-gold/40 bg-surface/95 text-mist/85`}>
        <div className="font-medium text-gold mb-1">One-time setup: import your history</div>
        <p className="text-xs text-mist/65 mb-2.5">
          CardIQ hasn&apos;t imported your bank emails yet. The first import covers several
          years and takes 20–30 minutes — after that it keeps itself up to date automatically.
        </p>
        <div className="flex gap-2">
          <button onClick={() => doSync(undefined, true)}
            className="bg-gold-shimmer text-ink px-3 py-1.5 rounded-lg text-xs font-semibold hover:opacity-90 transition-all">
            Import now
          </button>
          <button onClick={() => setPhase({ kind: "idle" })}
            className="px-3 py-1.5 rounded-lg border border-rim text-xs text-mist/70 hover:bg-hover transition-all">
            Later
          </button>
        </div>
      </div>
    );
  }

  // error — persistent (no auto-dismiss) when the grant is dead, because that
  // state never fixes itself.
  return (
    <div className={`${base} border-ruby/40 bg-ruby/10 text-ruby`} role="alert">
      <div className="font-medium mb-0.5">
        {phase.reauth ? "Gmail needs reconnecting" : "Auto-sync failed"}
      </div>
      <p className="text-xs opacity-90">{phase.text}</p>
      <div className="flex gap-2 mt-2">
        <button onClick={() => doSync(undefined, true)}
          className="px-3 py-1.5 rounded-lg border border-ruby/40 text-xs hover:bg-ruby/15 transition-all">
          Retry
        </button>
        <button onClick={() => setPhase({ kind: "idle" })}
          className="px-3 py-1.5 rounded-lg border border-rim text-xs text-mist/70 hover:bg-hover transition-all">
          Dismiss
        </button>
      </div>
    </div>
  );
}
