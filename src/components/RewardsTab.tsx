"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isMissingTableError } from "@/lib/supabase/errors";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtNum, fmtDate, ymd, daysUntil } from "@/lib/format";
import { latestBalanceByCard, type RewardBalanceRow } from "@/lib/perks";
import MissingTableNotice from "./MissingTableNotice";

type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };

const cardLabel = (c: CardRow) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

export default function RewardsTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const supabase = createClient();
  const [cards, setCards] = useState<CardRow[]>([]);
  const [rows, setRows] = useState<RewardBalanceRow[]>([]);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-card add-snapshot form state
  const [formCard, setFormCard] = useState<string | null>(null); // card_id with open form
  const [balance, setBalance] = useState("");
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [cardsRes, balRes] = await Promise.all([
      supabase.from("cards").select("id,last4,nickname,product_key").order("created_at"),
      supabase.from("reward_balances").select("*").order("as_of", { ascending: false }).order("created_at", { ascending: false }),
    ]);
    setCards((cardsRes.data as CardRow[]) ?? []);
    if (balRes.error) {
      if (isMissingTableError(balRes.error)) setMigrationNeeded(true);
      else setError(balRes.error.message);
    }
    setRows((balRes.data as RewardBalanceRow[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useMemo(() => latestBalanceByCard(rows), [rows]);
  const byCard = useMemo(() => {
    const m = new Map<string, RewardBalanceRow[]>();
    for (const r of rows) {
      if (!m.has(r.card_id)) m.set(r.card_id, []);
      m.get(r.card_id)!.push(r);
    }
    return m;
  }, [rows]);

  function openForm(cardId: string) {
    setFormCard(cardId);
    setBalance("");
    setAsOf(ymd(new Date()));
    setNotes("");
    setError(null);
  }

  async function saveSnapshot(card: CardRow) {
    const value = Number(balance.replace(/[,\s]/g, ""));
    if (!balance.trim() || !isFinite(value)) { setError("Balance must be a number."); return; }
    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }
    const spec = CARD_REGISTRY[card.product_key];
    const { error: err } = await supabase.from("reward_balances").insert({
      user_id: user.id,
      card_id: card.id,
      program: spec?.rewards?.program ?? "Reward points",
      balance: value,
      as_of: asOf,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setFormCard(null);
    load();
  }

  async function deleteSnapshot(id: string) {
    if (!confirm("Delete this balance entry?")) return;
    await supabase.from("reward_balances").delete().eq("id", id);
    load();
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-mist/60 text-sm">Loading rewards…</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6 pb-20">
      <header>
        <h1 className="font-serif text-2xl font-semibold text-mist">Rewards</h1>
        <p className="text-sm text-mist/60 mt-1">
          Point balances per card. Enter what your bank app shows — CardIQ keeps the history and flags stale numbers.
        </p>
      </header>

      {migrationNeeded && <MissingTableNotice feature="Rewards" />}
      {error && <div className="rounded-xl border border-ruby/30 bg-ruby/5 text-ruby text-sm px-4 py-3">{error}</div>}

      {cards.length === 0 && !migrationNeeded && (
        <div className="rounded-2xl border border-rim bg-surface p-8 shadow-card text-center">
          <div className="font-serif text-lg font-semibold text-mist mb-1">No cards yet</div>
          <p className="text-sm text-mist/60 mb-4">Add a card first — reward balances live on your cards.</p>
          <button onClick={() => onNavigate("Cards")}
            className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 transition-all">
            Add a card →
          </button>
        </div>
      )}

      {cards.map((card) => {
        const spec = CARD_REGISTRY[card.product_key];
        const current = latest.get(card.id);
        const history = byCard.get(card.id) ?? [];
        const staleDays = current ? Math.max(0, -daysUntil(current.as_of)) : 0;
        const formOpen = formCard === card.id;

        return (
          <section key={card.id} className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="font-serif text-lg font-semibold text-mist">{cardLabel(card)}</h2>
                <div className="text-xs text-mist/55 mt-0.5">
                  {spec?.rewards
                    ? <>{spec.rewards.program} · earns {spec.rewards.earn_summary}</>
                    : "No reward program on file for this card"}
                </div>
              </div>
              <div className="text-right">
                {current ? (
                  <>
                    <div className="font-serif text-3xl font-semibold text-gold tabular-nums">
                      {fmtNum(Number(current.balance))}
                    </div>
                    <div className={`text-xs mt-0.5 ${staleDays > 45 ? "text-amber" : "text-mist/50"}`}>
                      as of {fmtDate(current.as_of)}{staleDays > 45 ? ` · ${staleDays} days old` : ""}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-mist/50">No balance yet</div>
                )}
              </div>
            </div>

            {/* History */}
            {history.length > 1 && (
              <div className="border-t border-wire pt-3 space-y-1.5">
                <div className="text-xs text-mist/55 mb-1">History</div>
                {history.slice(0, 6).map((h, i) => {
                  const next = history[i + 1];
                  const delta = next ? Number(h.balance) - Number(next.balance) : null;
                  return (
                    <div key={h.id} className="flex items-center justify-between text-sm group">
                      <span className="text-mist/60">{fmtDate(h.as_of)}{h.notes ? <span className="text-mist/40"> · {h.notes}</span> : ""}</span>
                      <span className="flex items-center gap-3">
                        {delta !== null && delta !== 0 && (
                          <span className={`text-xs tabular-nums ${delta > 0 ? "text-emerald" : "text-ruby"}`}>
                            {delta > 0 ? "+" : ""}{fmtNum(delta)}
                          </span>
                        )}
                        <span className="text-mist/85 tabular-nums">{fmtNum(Number(h.balance))}</span>
                        <button onClick={() => deleteSnapshot(h.id)}
                          className="text-mist/30 hover:text-ruby text-xs opacity-0 group-hover:opacity-100 transition-opacity" title="Delete entry">
                          ✕
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add snapshot */}
            {formOpen ? (
              <div className="border-t border-wire pt-4 grid sm:grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
                <input autoFocus value={balance} onChange={(e) => setBalance(e.target.value)}
                  placeholder="Current balance" inputMode="numeric"
                  className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none tabular-nums" />
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
                  className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none" />
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)"
                  className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
                <div className="flex gap-2">
                  <button onClick={() => saveSnapshot(card)} disabled={saving || migrationNeeded}
                    className="bg-gold-shimmer text-ink px-4 py-2 rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all">
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button onClick={() => setFormCard(null)}
                    className="px-3 py-2 rounded-xl border border-rim text-sm text-mist/70 hover:bg-hover transition-all">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => openForm(card.id)} disabled={migrationNeeded}
                className="text-sm text-gold hover:text-gold/80 font-medium disabled:opacity-40 transition-colors">
                {current ? "Update balance →" : "Add first balance →"}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
