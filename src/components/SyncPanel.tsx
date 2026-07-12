"use client";

// SyncPanel — drastically simplified.
//
// One button, one timestamp. That's it. Behavior:
//
//   • First-ever sync: server pulls 8 years of bank emails (uses
//     FIRST_SYNC_LOOKBACK_DAYS in /api/gmail/sync). Takes a few minutes.
//   • Every click after that: incremental. Server uses the stored cursor
//     and only fetches emails newer than the last sync.
//
// What was removed (vs. the old version) and why:
//   • Backfill-from-month picker  → redundant. Once you've synced once, all
//     history is already in the DB. The first click does the backfill.
//   • "Reprocess failed" button   → triggered automatically when a card is
//     added (see /api/cards/backfill). No reason to expose manually.
//   • "Wipe & Reingest" button    → endpoint kept for emergencies, but the
//     button was a footgun. If parsers ever break this badly again we can
//     re-add it as a hidden admin tool.

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface SyncState {
  lastSyncedAt: string | null;
  messageCount: number;
}

interface Props {
  onSyncComplete: () => void;
}

// Backfill presets (days). Re-scans that window so newly-supported senders
// or anything the incremental cursor skipped gets picked up. ~8y = "everything".
const BACKFILL_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last year", days: 365 },
  { label: "Everything (8 yrs)", days: 365 * 8 },
];

export default function SyncPanel({ onSyncComplete }: Props) {
  const supabase = createClient();

  const [syncState, setSyncState] = useState<SyncState>({ lastSyncedAt: null, messageCount: 0 });
  const [syncing,   setSyncing]   = useState(false);
  const [progress,  setProgress]  = useState<string | null>(null);
  const [result,    setResult]    = useState<string | null>(null);
  const [resultOk,  setResultOk]  = useState(true);
  const [menuOpen,  setMenuOpen]  = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // ── Load last-sync state ────────────────────────────────────────────────
  const loadSyncState = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("gmail_sync_state")
      .select("last_synced_at, message_count")
      .eq("user_id", user.id)
      .eq("sender", "_all")
      .maybeSingle();
    if (data) {
      setSyncState({
        lastSyncedAt: data.last_synced_at ?? null,
        messageCount: data.message_count ?? 0,
      });
    }
  }, [supabase]);

  useEffect(() => { loadSyncState(); }, [loadSyncState]);

  // ── NDJSON stream helper ────────────────────────────────────────────────
  // POSTs to a sync endpoint and hands each parsed NDJSON message to onMsg.
  // Resolves with the final {status:"done"} payload; throws on HTTP errors
  // or a server-sent {status:"error"}.
  async function streamNdjson(
    url: string,
    lookbackDays: number | undefined,
    onMsg: (msg: any) => void
  ): Promise<any> {
    const res = await fetch(url, {
      method: "POST",
      headers: lookbackDays ? { "Content-Type": "application/json" } : undefined,
      body: lookbackDays ? JSON.stringify({ lookback_days: lookbackDays }) : undefined,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      throw new Error(errBody.message || errBody.error || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("Sync returned no response body");

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneMsg: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // NDJSON can split mid-line across chunks → buffer the tail.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        // Parse defensively: a half-received line is normal NDJSON behaviour
        // and should be ignored. But a fully-parsed message must be handled
        // OUTSIDE this try — otherwise a server-sent {status:"error"} would
        // be swallowed by the parse-error catch and the UI hangs forever.
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // partial / non-JSON chunk — wait for the rest
        }
        if (msg.status === "error") throw new Error(msg.message || "Sync failed");
        if (msg.status === "done") doneMsg = msg;
        onMsg(msg);
      }
    }
    if (!doneMsg) throw new Error("Sync ended without a result");
    return doneMsg;
  }

  // ── Run sync ────────────────────────────────────────────────────────────
  // No arg → incremental (only emails newer than the saved cursor).
  // lookbackDays → backfill: re-scan that many days so newly-recognised
  // senders (or anything the cursor skipped) get picked up. Dedup via
  // gmail_seen_messages guarantees no duplicates either way.
  //
  // Two passes per click: bank transaction emails first, THEN order emails
  // (Swiggy/Zomato/BigBasket/Amazon) — orders match against transactions,
  // so the transactions must land first.
  async function runSync(lookbackDays?: number) {
    setMenuOpen(false);
    setSyncing(true);
    setResult(null);
    setProgress(
      lookbackDays ? `Starting backfill of the last ${lookbackDays} days…` : "Connecting to Gmail…"
    );

    try {
      // ── Pass 1: bank transaction emails ──
      const bank = await streamNdjson("/api/gmail/sync", lookbackDays, (msg) => {
        if (msg.status === "listing") {
          setProgress(msg.message || "Scanning Gmail for bank emails…");
        } else if (msg.status === "syncing") {
          if (typeof msg.fetched === "number" && msg.total) {
            const pct = Math.round((msg.fetched / msg.total) * 100);
            setProgress(`${pct}% · ${msg.fetched}/${msg.total} emails · ${msg.new_txns ?? 0} new transactions`);
          } else if (msg.message) {
            setProgress(msg.message);
          }
        }
      });

      // ── Pass 2: order emails. A failure here (e.g. migration 011 not run
      // yet) must not bury the successful bank sync — report it alongside. ──
      let orderNote = "";
      let ordersOk = true;
      try {
        const orders = await streamNdjson("/api/gmail/orders/sync", lookbackDays, (msg) => {
          if (msg.status === "syncing" && typeof msg.fetched === "number" && msg.total) {
            setProgress(`Order emails: ${msg.fetched}/${msg.total} · ${msg.new_orders ?? 0} parsed`);
          } else if (msg.message) {
            setProgress(msg.message);
          }
        });
        const parts: string[] = [];
        if (orders.new_orders) parts.push(`${orders.new_orders} order${orders.new_orders > 1 ? "s" : ""} parsed`);
        if (orders.matched)    parts.push(`${orders.matched} linked to transactions`);
        if (parts.length) orderNote = ` · ${parts.join(", ")}`;
      } catch (oe) {
        ordersOk = false;
        orderNote = ` · Orders: ${(oe as Error).message}`;
      }

      const n    = bank.new_txns ?? 0;
      const errs = (bank.errors as string[] | undefined)?.length ?? 0;
      const errNote = errs > 0 ? ` · ⚠ ${errs} error${errs > 1 ? "s" : ""}` : "";
      setResult(
        (n > 0
          ? `✓ ${n} new transaction${n > 1 ? "s" : ""} added${errNote}`
          : `✓ Already up to date — ${bank.fetched ?? 0} emails checked${errNote}`) + orderNote
      );
      setResultOk(errs === 0 && ordersOk);
      setProgress(null);
      await loadSyncState();
      onSyncComplete();
    } catch (e) {
      setResult(`Error: ${(e as Error).message}`);
      setResultOk(false);
      setProgress(null);
    } finally {
      setSyncing(false);
    }
  }

  // ── Display helpers ─────────────────────────────────────────────────────
  function formatSyncTime(iso: string | null): string {
    if (!iso) return "Never";
    const d   = new Date(iso);
    const now = new Date();
    const diffMs   = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1)  return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7)  return `${diffDays}d ago`;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {/* Last-sync indicator */}
        <div className="flex items-center gap-2 text-xs text-mist/50">
          <span className={`w-1.5 h-1.5 rounded-full ${syncState.lastSyncedAt ? "bg-emerald" : "bg-mist/20"}`} />
          <span>Last sync: <span className="text-mist/70">{formatSyncTime(syncState.lastSyncedAt)}</span></span>
        </div>

        <div className="flex-1" />

        {/* Sync dropdown: incremental "Sync now" + backfill windows. */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => (syncing ? undefined : setMenuOpen((o) => !o))}
            disabled={syncing}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gold-shimmer text-ink text-xs font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-60 transition-all"
          >
            {syncing ? (
              <>
                <svg className="w-3 h-3 animate-spin-slow" fill="none" viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12" />
                </svg>
                Syncing…
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
                  <path d="M2 8a6 6 0 1 1 1.5 4M2 12V8h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Sync Gmail
                <svg className="w-3 h-3 -mr-1" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
                  <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>
            )}
          </button>

          {menuOpen && !syncing && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-56 z-50 rounded-xl border border-rim bg-raised shadow-dropdown overflow-hidden"
            >
              <button
                role="menuitem"
                onClick={() => runSync()}
                className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-hover transition-colors"
              >
                <svg className="w-3.5 h-3.5 mt-0.5 text-gold shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
                  <path d="M2 8a6 6 0 1 1 1.5 4M2 12V8h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>
                  <span className="block text-xs font-medium text-mist">Sync now</span>
                  <span className="block text-2xs text-mist/60">Just fetch what&apos;s new</span>
                </span>
              </button>

              <div className="px-3 pt-2 pb-1 text-2xs uppercase tracking-widest text-mist/55 border-t border-wire">
                Backfill
              </div>
              {BACKFILL_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  role="menuitem"
                  onClick={() => runSync(opt.days)}
                  className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-hover transition-colors"
                >
                  <span className="text-xs text-mist/80">{opt.label}</span>
                  <span className="text-2xs text-mist/55 tabular-nums">{opt.days}d</span>
                </button>
              ))}
              <p className="px-3 py-2 text-2xs text-mist/55 border-t border-wire leading-relaxed">
                Backfill re-scans older emails (e.g. a newly-supported bank). No duplicates are ever created.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Progress / result area — shows under the button row, never above */}
      {progress && (
        <div className="text-xs text-mist/60 italic">{progress}</div>
      )}
      {result && (
        <div className={`text-xs ${resultOk ? "text-emerald" : "text-ruby"}`}>{result}</div>
      )}
    </div>
  );
}
