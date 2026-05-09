"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const THIS_YEAR = new Date().getFullYear();
const THIS_MONTH = new Date().getMonth();

interface SyncState {
  lastSyncedAt: string | null;
  messageCount: number;
  /** ms epoch of newest email seen — used to display "coverage from X" */
  lastInternalDate: number | null;
}

interface Props {
  onSyncComplete: () => void;
}

/**
 * A self-contained Gmail sync panel.
 *
 * Default mode: "New emails only" — sends a bare POST and the API uses the
 *   stored cursor, so only emails newer than last sync are fetched.
 *
 * Backfill mode: user picks a month via the inline picker. The panel
 *   calculates lookback_days and sends it to the API. The seen-messages
 *   table guarantees already-fetched emails are never re-downloaded.
 */
export default function SyncPanel({ onSyncComplete }: Props) {
  const supabase = createClient();

  const [syncState, setSyncState] = useState<SyncState>({
    lastSyncedAt: null,
    messageCount: 0,
    lastInternalDate: null,
  });

  // Backfill picker state
  const [showPicker, setShowPicker] = useState(false);
  const [pickerYear, setPickerYear] = useState(THIS_YEAR);
  // null = "new emails only"; a date string = "backfill from this month"
  const [backfillFrom, setBackfillFrom] = useState<string | null>(null);

  // Sync progress state
  const [syncing, setSyncing]       = useState(false);
  const [progress, setProgress]     = useState<string | null>(null);
  const [result, setResult]         = useState<string | null>(null);
  const [resultOk, setResultOk]     = useState(true);

  // Reprocess (recover failed-parse emails) state — separate so the two
  // operations can run independently and have distinct progress messages.
  const [reprocessing, setReprocessing] = useState(false);

  // Wipe & reingest — nuclear option, separate state to disable other actions
  // while it runs (it's a multi-minute streaming operation).
  const [wiping, setWiping] = useState(false);

  const pickerRef = useRef<HTMLDivElement>(null);

  // ── Load sync state ──────────────────────────────────────────────────────
  const loadSyncState = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("gmail_sync_state")
      .select("last_synced_at, message_count, last_internal_date")
      .eq("user_id", user.id)
      .eq("sender", "_all")
      .maybeSingle();
    if (data) {
      setSyncState({
        lastSyncedAt:     data.last_synced_at ?? null,
        messageCount:     data.message_count  ?? 0,
        lastInternalDate: data.last_internal_date ?? null,
      });
    }
  }, [supabase]);

  useEffect(() => { loadSyncState(); }, [loadSyncState]);

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    function handle(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showPicker]);

  // ── Sync ─────────────────────────────────────────────────────────────────
  async function runSync() {
    setSyncing(true);
    setResult(null);
    setProgress("Connecting to Gmail…");

    try {
      let body: BodyInit | undefined;
      if (backfillFrom) {
        // Calculate days from picked month to today (inclusive)
        const from = new Date(backfillFrom + "-01");
        const days = Math.ceil((Date.now() - from.getTime()) / 86400000) + 1;
        body = JSON.stringify({ lookback_days: days });
      }

      const res = await fetch("/api/gmail/sync", {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body,
      });

      // Non-streaming error response (e.g. 400 / 500 with JSON body).
      // Without this the UI would spin forever waiting for stream chunks.
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        throw new Error(errBody.message || errBody.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("Sync request returned no response body");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.status === "listing") {
              setProgress("Scanning Gmail…");
            } else if (msg.status === "syncing") {
              const pct = msg.total ? Math.round((msg.fetched / msg.total) * 100) : 0;
              setProgress(`${pct}% · ${msg.fetched}/${msg.total ?? "?"} emails · ${msg.new_txns ?? 0} new transactions`);
            } else if (msg.status === "done") {
              const n    = msg.new_txns ?? 0;
              const errs = (msg.errors as string[] | undefined)?.length ?? 0;
              const errNote = errs > 0 ? ` · ⚠ ${errs} error${errs > 1 ? "s" : ""} — check logs` : "";
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
          } catch (e) {
            if ((e as Error).message === "Sync request failed") throw e;
          }
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

  // ── Reprocess (retry failed-parse emails) ───────────────────────────
  // Walks gmail_seen_messages where txn_id IS NULL and re-runs the parsers.
  // Phase A is offline (uses stored raw_body). Phase B (online) re-fetches
  // from Gmail for legacy rows saved before raw_body was stored. We pass
  // online:true so legacy rows get recovered too — limited to 1500/call.
  async function runReprocess() {
    setReprocessing(true);
    setResult(null);
    setProgress("Re-parsing emails that previously didn't match\u2026");
    try {
      const res = await fetch("/api/gmail/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ online: true, limit: 1500 }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        throw new Error(err.message || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("Reprocess returned no body");
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let final: any = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.status === "offline_progress" || msg.status === "offline_start") {
              setProgress(`Offline retry: ${msg.offline_retried ?? 0} checked \u00b7 ${msg.new_txns ?? 0} recovered`);
            } else if (msg.status === "online_progress" || msg.status === "online_start") {
              setProgress(`Re-fetch from Gmail: ${msg.online_refetched ?? 0}/${msg.total ?? "?"} \u00b7 ${msg.new_txns ?? 0} recovered`);
            } else if (msg.status === "done") {
              final = msg;
            } else if (msg.status === "error") {
              throw new Error(msg.message);
            }
          } catch { /* ignore parse errors on partial chunks */ }
        }
      }
      if (final) {
        const recovered = final.new_txns ?? 0;
        const errs = final.errors?.length ?? 0;
        setResult(
          recovered > 0
            ? `\u2728 Recovered ${recovered} transaction${recovered === 1 ? "" : "s"} from previously-failed emails` +
              (errs > 0 ? ` \u00b7 \u26a0 ${errs} error${errs === 1 ? "" : "s"}` : "")
            : `No new transactions found in ${(final.offline_retried ?? 0) + (final.online_refetched ?? 0)} reprocessed emails` +
              (errs > 0 ? ` \u00b7 \u26a0 ${errs} error${errs === 1 ? "" : "s"}` : "")
        );
        setResultOk(errs === 0);
        await loadSyncState();
        onSyncComplete();
      }
    } catch (e) {
      setResult(`Error: ${(e as Error).message}`);
      setResultOk(false);
    } finally {
      setProgress(null);
      setReprocessing(false);
    }
  }

  // ── Wipe & Reingest ──────────────────────────────────────────
  // The nuclear option: deletes ALL transactions + seen-message records +
  // sync cursor for this user, then re-fetches the last N years from Gmail
  // through the *current* parsers. Use this when:
  //   - a parser was broken for a stretch (à la HDFC V3) and you want to
  //     recover the missing window without surgical patching
  //   - the cursor got poisoned (e.g. last_internal_date jumped past a real
  //     range due to a buggy email)
  // Confirmation prompt prevents the obvious "oh no I clicked it" disaster.
  async function runWipeAndReingest() {
    const confirmed = window.confirm(
      "\u26a0 WIPE & REINGEST will:\n\n" +
      "  • DELETE all your transactions\n" +
      "  • DELETE all email-sync state\n" +
      "  • RE-FETCH 8 years of bank emails from Gmail\n" +
      "  • RE-PARSE everything with the latest parsers\n\n" +
      "This takes a few minutes. Tag/category overrides on transactions will be lost.\n\n" +
      "Continue?"
    );
    if (!confirmed) return;

    setWiping(true);
    setResult(null);
    setProgress("Starting wipe-and-reingest\u2026");
    try {
      const res = await fetch("/api/gmail/wipe-and-reingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "WIPE-AND-REINGEST", years: 8 }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        throw new Error(err.message || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("Wipe returned no body");
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let final: any = null;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Buffer partial lines across chunks — NDJSON can split mid-line.
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          try {
            const msg = JSON.parse(line);
            if (msg.status === "wiping")     setProgress("Wiping old data\u2026");
            else if (msg.status === "wiped") setProgress(`Wiped ${msg.deleted_transactions} txns. Listing emails\u2026`);
            else if (msg.status === "listing")   setProgress(`Listing emails: ${msg.listed} found so far\u2026`);
            else if (msg.status === "listed")    setProgress(`Found ${msg.total} emails. Fetching & parsing\u2026`);
            else if (msg.status === "ingesting") setProgress(`Ingesting ${msg.fetched}/${msg.total} \u00b7 ${msg.new_txns} txns recovered`);
            else if (msg.status === "done")      final = msg;
            else if (msg.status === "error")     throw new Error(msg.message);
          } catch { /* partial chunk parse errors are fine */ }
        }
      }

      if (final) {
        const errs = final.errors?.length ?? 0;
        setResult(
          `\u2728 Wipe complete: ${final.new_txns} transactions from ${final.fetched} emails (${final.years}-year window)` +
          (errs > 0 ? ` \u00b7 \u26a0 ${errs} error${errs === 1 ? "" : "s"}` : "")
        );
        setResultOk(errs === 0);
        await loadSyncState();
        onSyncComplete();
      }
    } catch (e) {
      setResult(`Wipe failed: ${(e as Error).message}`);
      setResultOk(false);
    } finally {
      setProgress(null);
      setWiping(false);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function pickBackfillMonth(year: number, month: number) {
    // Format as YYYY-MM (no day — firstDay added when calculating lookback)
    const mm = String(month + 1).padStart(2, "0");
    setBackfillFrom(`${year}-${mm}`);
    setShowPicker(false);
  }

  function isFuture(y: number, m: number) {
    return y > THIS_YEAR || (y === THIS_YEAR && m > THIS_MONTH);
  }

  function formatSyncTime(iso: string | null): string {
    if (!iso) return "Never";
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function coverageFromLabel(): string {
    if (!syncState.lastInternalDate) return "";
    const d = new Date(syncState.lastInternalDate);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  const backfillLabel = backfillFrom
    ? (() => {
        const [y, m] = backfillFrom.split("-").map(Number);
        return `${MONTHS[m - 1]} ${y}`;
      })()
    : null;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Status row */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-mist/50">
          <span className={`w-1.5 h-1.5 rounded-full ${syncState.lastSyncedAt ? "bg-emerald" : "bg-mist/20"}`} />
          <span>Last sync: <span className="text-mist/70">{formatSyncTime(syncState.lastSyncedAt)}</span></span>
        </div>
        {syncState.messageCount > 0 && (
          <div className="text-xs text-mist/50">
            <span className="text-mist/70">{syncState.messageCount.toLocaleString()}</span> emails archived
          </div>
        )}
        {syncState.lastInternalDate && (
          <div className="text-xs text-mist/50">
            Coverage through <span className="text-mist/70">{coverageFromLabel()}</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">

        {/* Sync-from picker */}
        <div className="relative" ref={pickerRef}>
          <button
            disabled={syncing}
            onClick={() => setShowPicker((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all disabled:opacity-40 ${
              backfillFrom
                ? "border-gold/40 bg-gold/8 text-gold"
                : "border-rim bg-surface hover:bg-hover text-mist/60 hover:text-mist"
            }`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
              <rect x="2" y="3" width="12" height="11" rx="2"/>
              <path d="M5 1v4M11 1v4M2 7h12"/>
            </svg>
            {backfillFrom ? `From ${backfillLabel}` : "New emails only"}
            {backfillFrom && (
              <span onClick={(e) => { e.stopPropagation(); setBackfillFrom(null); }}
                className="ml-1 opacity-60 hover:opacity-100">×</span>
            )}
          </button>

          {showPicker && (
            <div className="absolute top-full left-0 mt-2 z-50 shadow-dropdown rounded-xl border border-rim bg-raised overflow-hidden"
              style={{ minWidth: 260 }}>
              <div className="px-3 pt-3 pb-1 text-2xs uppercase tracking-widest text-mist/40">
                Fetch emails starting from…
              </div>
              <div className="p-3">
                <div className="flex items-center justify-between mb-3">
                  <button onClick={() => setPickerYear((y) => y - 1)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-hover text-mist/60 hover:text-mist">‹</button>
                  <span className="font-semibold text-sm text-mist tabular-nums">{pickerYear}</span>
                  <button onClick={() => setPickerYear((y) => Math.min(y + 1, THIS_YEAR))}
                    disabled={pickerYear >= THIS_YEAR}
                    className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-hover text-mist/60 hover:text-mist disabled:opacity-20">›</button>
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {MONTHS.map((name, idx) => {
                    const future  = isFuture(pickerYear, idx);
                    const mm      = String(idx + 1).padStart(2, "0");
                    const sel     = backfillFrom === `${pickerYear}-${mm}`;
                    return (
                      <button key={name} disabled={future}
                        onClick={() => pickBackfillMonth(pickerYear, idx)}
                        className={`py-1.5 rounded-lg text-xs font-medium transition-all ${
                          future ? "opacity-20 cursor-not-allowed"
                          : sel   ? "bg-gold text-ink"
                                  : "hover:bg-hover text-mist/70 hover:text-mist"
                        }`}>
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="px-3 pb-3 text-2xs text-mist/40 border-t border-wire pt-2 mt-1">
                Already-fetched emails are skipped automatically.
              </div>
            </div>
          )}
        </div>

        {/* Sync button */}
        <button
          onClick={runSync}
          disabled={syncing || reprocessing || wiping}
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gold-shimmer text-ink text-xs font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-50 transition-all"
        >
          {syncing ? (
            <>
              <svg className="w-3 h-3 animate-spin-slow" fill="none" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12"/>
              </svg>
              Syncing…
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
                <path d="M2 8a6 6 0 1 1 1.5 4M2 12V8h4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Sync Gmail
            </>
          )}
        </button>

        {/* Reprocess button — retries emails that previously failed to parse.
            Useful after parser improvements or to recover from broken syncs. */}
        <button
          onClick={runReprocess}
          disabled={syncing || reprocessing || wiping}
          title="Retry emails that were marked seen but didn't produce a transaction. Safe to run anytime."
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-rim bg-surface hover:bg-hover text-mist/60 hover:text-mist text-xs font-medium transition-all disabled:opacity-40"
        >
          {reprocessing ? (
            <svg className="w-3 h-3 animate-spin-slow" fill="none" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12"/>
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
              <path d="M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3M11 5h2V3M5 11H3v2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          {reprocessing ? "Reprocessing\u2026" : "Reprocess failed"}
        </button>

        {/* Wipe & Reingest — destructive, last in the row, red-tinted to
            signal danger. Use when a parser bug or domain change left a
            blind spot in your history. Requires explicit confirmation. */}
        <button
          onClick={runWipeAndReingest}
          disabled={syncing || reprocessing || wiping}
          title="Wipe all transactions and re-ingest 8 years of bank emails from Gmail. Use after parser fixes that need to backfill missing data."
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-900/40 bg-red-950/20 hover:bg-red-900/30 text-red-300/70 hover:text-red-200 text-xs font-medium transition-all disabled:opacity-40"
        >
          {wiping ? (
            <svg className="w-3 h-3 animate-spin-slow" fill="none" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12"/>
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
              <path d="M3 4h10M5 4V2h6v2M4 4l1 10h6l1-10" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          {wiping ? "Wiping\u2026" : "Wipe & Reingest"}
        </button>

      </div>

      {/* Progress bar */}
      {progress && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-0.5 bg-surface rounded-full overflow-hidden">
            <div className="h-full bg-gold/60 rounded-full animate-pulse" style={{ width: "60%" }} />
          </div>
          <span className="text-xs font-mono text-mist/60">{progress}</span>
        </div>
      )}

      {/* Result banner */}
      {result && !progress && (
        <div className={`text-xs px-3 py-2 rounded-lg border ${
          resultOk
            ? "border-emerald/30 bg-emerald/5 text-emerald"
            : "border-ruby/30 bg-ruby/5 text-ruby"
        }`}>
          {result}
        </div>
      )}
    </div>
  );
}
