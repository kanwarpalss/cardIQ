"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Review tab (V2 feature C) — the living validation inbox. The matcher proposes
// order↔transaction links; high-confidence ones auto-confirm, but medium/low
// wait HERE for KP's thumbs-up. Approve → the link becomes truth in Spend.
// Reject → permanent unlink (the order lives on in the Orders ledger only).
//
// The queue grows with every sync, so this is a standing surface, not a
// one-shot widget.

type Item = { name: string; qty?: number | null; price?: number | null };
type Txn = {
  id: string; card_last4: string; amount_inr: number | string;
  txn_at: string; merchant: string | null; category: string | null;
};
type ReviewOrder = {
  id: string;
  source: string;
  kind: "order" | "refund";
  order_ref: string | null;
  merchant_name: string | null;
  total_amount: number | string | null;
  order_at: string;
  items: Item[];
  match_confidence: "high" | "medium" | "low" | null;
  review_status: "unmatched" | "pending" | "confirmed" | "rejected";
  txn: Txn | null;
};

type Status = "pending" | "confirmed" | "rejected";

const SOURCE_LABELS: Record<string, string> = {
  swiggy: "Swiggy", zomato: "Zomato", bigbasket: "BigBasket", amazon: "Amazon",
  blinkit: "Blinkit", shopify: "Shopify", generic: "Online", razorpay: "Razorpay",
};

const fmt = (n: number | string | null | undefined) =>
  n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN");
const day = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Human gap between the order email and the charge — the matcher's key signal. */
function gapLabel(a: string, b: string): string {
  const min = Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
  if (min < 90) return `${Math.round(min)} min apart`;
  const days = min / 1440;
  return `${days < 1.5 ? "same day" : `${days.toFixed(days < 10 ? 1 : 0)} days apart`}`;
}

function ConfidenceChip({ level }: { level: ReviewOrder["match_confidence"] }) {
  if (!level) return null;
  const map = {
    high:   { label: "high confidence",   cls: "text-emerald border-emerald/30 bg-emerald/5" },
    medium: { label: "medium confidence", cls: "text-gold border-gold/30 bg-gold/5" },
    low:    { label: "low confidence",    cls: "text-mist/70 border-rim bg-raised" },
  } as const;
  const { label, cls } = map[level];
  return <span className={`text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap ${cls}`}>{label}</span>;
}

const STATUS_TABS: { key: Status; label: string }[] = [
  { key: "pending",   label: "Needs review" },
  { key: "confirmed", label: "Confirmed" },
  { key: "rejected",  label: "Rejected" },
];

export default function ReviewTab({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<Status>("pending");
  const [orders, setOrders] = useState<ReviewOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (s: Status) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/review?status=${s}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error === "missing_review_status_column" ? "migration" : json?.error || "Failed to load");
        setOrders([]);
        return;
      }
      setOrders(json.orders ?? []);
    } catch {
      setError("Couldn't reach the server. Try again.");
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(status); }, [status, load]);

  async function act(order: ReviewOrder, action: "approve" | "reject") {
    setBusyId(order.id);
    // Optimistic: drop the row from the current list (it changes status).
    const prev = orders;
    setOrders((os) => os.filter((o) => o.id !== order.id));
    try {
      const res = await fetch("/api/orders/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: order.id, action }),
      });
      if (!res.ok) { setOrders(prev); return; } // roll back on failure
      onChanged?.();
    } catch {
      setOrders(prev);
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => orders.length, [orders]);

  return (
    <div className="max-w-4xl mx-auto px-4 lg:px-8 py-6 space-y-5">
      <header className="space-y-1">
        <h1 className="font-serif text-2xl text-gold tracking-tight">Review matches</h1>
        <p className="text-sm text-mist/60 leading-relaxed">
          The matcher links your order emails to card charges. High-confidence links are auto-confirmed;
          the ones below need your eye. <span className="text-mist/80">Approve</span> makes it truth in Spend,
          <span className="text-mist/80"> Reject</span> unlinks it for good (e.g. you paid with a voucher).
        </p>
      </header>

      {/* Status filter */}
      <div className="flex items-center gap-1.5">
        {STATUS_TABS.map((t) => (
          <button key={t.key} onClick={() => setStatus(t.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              status === t.key
                ? "bg-surface text-gold border border-gold/25"
                : "text-mist/55 hover:text-mist hover:bg-surface/60 border border-transparent"
            }`}>
            {t.label}{status === t.key && !loading ? ` · ${counts}` : ""}
          </button>
        ))}
      </div>

      {error === "migration" ? (
        <div className="rounded-2xl border border-amber/40 bg-amber/5 p-5 text-sm leading-relaxed">
          <div className="font-semibold text-amber mb-1.5">One-time setup needed for the review queue</div>
          <p className="text-mist/75">
            Open your Supabase project → <span className="text-mist font-medium">SQL Editor</span>, run{" "}
            <code className="text-amber/90 bg-ink px-1.5 py-0.5 rounded text-xs">supabase/migrations/014_order_review_status.sql</code>,
            then run an order sync. This page works immediately after — no redeploy.
          </p>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-ruby/30 bg-ruby/5 p-4 text-sm text-ruby">{error}</div>
      ) : loading ? (
        <div className="flex items-center justify-center py-20 text-mist/55 text-sm">Loading…</div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-rim bg-surface p-10 text-center">
          <div className="text-3xl mb-2">{status === "pending" ? "🎉" : "—"}</div>
          <div className="text-sm text-mist/70">
            {status === "pending"
              ? "Nothing to review. Every proposed match is either auto-confirmed or already decided."
              : status === "confirmed"
                ? "No confirmed matches yet. Approve some from “Needs review”, or run a sync."
                : "No rejected matches."}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => (
            <div key={o.id} className="rounded-2xl border border-rim bg-surface shadow-card overflow-hidden">
              {/* meta row */}
              <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 border-b border-wire bg-raised/40">
                <span className="text-2xs uppercase tracking-widest text-gold/70">
                  {SOURCE_LABELS[o.source] ?? o.source}{o.kind === "refund" ? " refund" : ""}
                </span>
                <ConfidenceChip level={o.match_confidence} />
                {o.txn && <span className="text-2xs text-mist/50">{gapLabel(o.order_at, o.txn.txn_at)}</span>}
                {o.order_ref && <span className="text-2xs text-mist/40 ml-auto tabular-nums">#{o.order_ref}</span>}
              </div>

              {/* order ⇄ txn compare */}
              <div className="grid sm:grid-cols-2 gap-px bg-wire">
                {/* Order side — what you bought */}
                <div className="bg-surface p-4 space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-2xs uppercase tracking-widest text-mist/45">Order email</span>
                    <span className="text-sm font-semibold text-mist tabular-nums">{fmt(o.total_amount)}</span>
                  </div>
                  <div className="text-sm text-mist/85">{o.merchant_name || SOURCE_LABELS[o.source] || o.source}</div>
                  <div className="text-2xs text-mist/45">{day(o.order_at)}</div>
                  {o.items.length > 0 && (
                    <ul className="pt-1 space-y-0.5">
                      {o.items.slice(0, 6).map((it, i) => (
                        <li key={i} className="text-xs text-mist/70 flex justify-between gap-3">
                          <span className="truncate">{it.qty && it.qty > 1 ? `${it.qty}× ` : ""}{it.name}</span>
                          {it.price != null && <span className="tabular-nums text-mist/45 shrink-0">{fmt(it.price)}</span>}
                        </li>
                      ))}
                      {o.items.length > 6 && <li className="text-2xs text-mist/40">+{o.items.length - 6} more…</li>}
                    </ul>
                  )}
                </div>

                {/* Txn side — what you paid */}
                <div className="bg-surface p-4 space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-2xs uppercase tracking-widest text-mist/45">Card charge</span>
                    <span className="text-sm font-semibold text-mist tabular-nums">{o.txn ? fmt(o.txn.amount_inr) : "—"}</span>
                  </div>
                  {o.txn ? (
                    <>
                      <div className="text-sm text-mist/85">{o.txn.merchant || "(no merchant)"}</div>
                      <div className="text-2xs text-mist/45">{day(o.txn.txn_at)} · card ••{o.txn.card_last4}</div>
                      {o.txn.category && <div className="text-2xs text-mist/40">{o.txn.category}</div>}
                    </>
                  ) : (
                    <div className="text-xs text-mist/40 italic">Transaction no longer linked.</div>
                  )}
                </div>
              </div>

              {/* actions */}
              <div className="flex items-center gap-2 px-4 py-3 border-t border-wire">
                {status !== "rejected" && (
                  <button
                    disabled={busyId === o.id}
                    onClick={() => act(o, "reject")}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-ruby/30 text-ruby/90 hover:bg-ruby/10 disabled:opacity-40 transition-all">
                    ✗ Reject
                  </button>
                )}
                {status !== "confirmed" && (
                  <button
                    disabled={busyId === o.id || !o.txn}
                    onClick={() => act(o, "approve")}
                    className="ml-auto px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald/15 border border-emerald/40 text-emerald hover:bg-emerald/25 disabled:opacity-40 transition-all">
                    ✓ Approve
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
