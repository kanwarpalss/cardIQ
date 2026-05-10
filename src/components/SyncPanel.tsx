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

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface SyncState {
  lastSyncedAt: string | null;
  messageCount: number;
}

interface Props {
  onSyncComplete: () => void;
}

export default function SyncPanel({ onSyncComplete }: Props) {
  const supabase = createClient();

  const [syncState, setSyncState] = useState<SyncState>({ lastSyncedAt: null, messageCount: 0 });
  const [syncing,   setSyncing]   = useState(false);
  const [progress,  setProgress]  = useState<string | null>(null);
  const [result,    setResult]    = useState<string | null>(null);
  const [resultOk,  setResultOk]  = useState(true);

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

  // ── Run sync ────────────────────────────────────────────────────────────
  // Fires the streaming endpoint. First-ever sync uses the server's
  // FIRST_SYNC_LOOKBACK_DAYS (8 years). Subsequent runs are incremental
  // because the server respects the stored cursor.
  async function runSync() {
    setSyncing(true);
    setResult(null);
    setProgress("Connecting to Gmail…");

    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        throw new Error(errBody.message || errBody.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("Sync returned no response body");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // NDJSON can split mid-line across chunks → buffer the tail.
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.status === "listing") {
              setProgress("Scanning Gmail for bank emails…");
            } else if (msg.status === "syncing") {
              const pct = msg.total ? Math.round((msg.fetched / msg.total) * 100) : 0;
              setProgress(`${pct}% · ${msg.fetched}/${msg.total ?? "?"} emails · ${msg.new_txns ?? 0} new transactions`);
            } else if (msg.status === "done") {
              const n    = msg.new_txns ?? 0;
              const errs = (msg.errors as string[] | undefined)?.length ?? 0;
              const errNote = errs > 0 ? ` · ⚠ ${errs} error${errs > 1 ? "s" : ""}` : "";
              setResult(
                n > 0
                  ? `✓ ${n} new transaction${n > 1 ? "s" : ""} added${errNote}`
                  : `✓ Already up to date — ${msg.fetched ?? 0} emails checked${errNote}`
              );
              setResultOk(errs === 0);
              setProgress(null);
              await loadSyncState();
              onSyncComplete();
            } else if (msg.status === "error") {
              throw new Error(msg.message);
            }
          } catch { /* partial chunk parse errors are fine */ }
        }
      }
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

        {/* The one button. */}
        <button
          onClick={runSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gold-shimmer text-ink text-xs font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-50 transition-all"
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
            </>
          )}
        </button>
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
