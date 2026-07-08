"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isMissingTableError } from "@/lib/supabase/errors";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtINR, fmtNum, fmtDate } from "@/lib/format";
import {
  latestBalanceByCard, estimatePoints, sortOffersForDisplay,
  effectiveOfferStatus, expiryState,
  type RewardBalanceRow, type OfferRow, type LoyaltyRow,
} from "@/lib/perks";
import CardVisual from "./CardVisual";
import MissingTableNotice from "./MissingTableNotice";

type Txn = {
  id: string; card_last4: string; amount_inr: number;
  original_currency: string | null;
  merchant: string | null; category: string | null;
  txn_at: string; txn_type: "debit" | "credit";
};
type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };
type AllData = { transactions: Txn[]; cards: CardRow[]; last_sync: string | null };

const cardLabel = (c: CardRow) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function OverviewTab({
  onOpenSpend, onNavigate,
}: {
  onOpenSpend: (last4: string) => void;
  onNavigate: (tab: string) => void;
}) {
  const supabase = createClient();
  const [allData, setAllData] = useState<AllData | null>(null);
  const [rewards, setRewards] = useState<RewardBalanceRow[]>([]);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loyalty, setLoyalty] = useState<LoyaltyRow[]>([]);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [txnRes, rewardRes, offerRes, loyaltyRes] = await Promise.all([
        fetch("/api/transactions/all"),
        supabase.from("reward_balances").select("*"),
        supabase.from("offers").select("*"),
        supabase.from("loyalty_accounts").select("*"),
      ]);
      if (txnRes.ok) setAllData(await txnRes.json());
      if (rewardRes.error || offerRes.error || loyaltyRes.error) {
        const missing = [rewardRes.error, offerRes.error, loyaltyRes.error]
          .some((e) => isMissingTableError(e));
        setMigrationNeeded(missing);
      }
      setRewards((rewardRes.data as RewardBalanceRow[]) ?? []);
      setOffers((offerRes.data as OfferRow[]) ?? []);
      setLoyalty((loyaltyRes.data as LoyaltyRow[]) ?? []);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── This-month aggregates (INR only, mirrors SpendTab's convention) ────────
  const month = useMemo(() => {
    const txns = allData?.transactions ?? [];
    const now = new Date();
    const startMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const inr = txns.filter(
      (t) => new Date(t.txn_at).getTime() >= startMs &&
             (!t.original_currency || t.original_currency.toUpperCase() === "INR")
    );
    const debits = inr.filter((t) => t.txn_type === "debit");
    const credits = inr.filter((t) => t.txn_type === "credit");
    const perCard: Record<string, number> = {};
    for (const t of debits) perCard[t.card_last4] = (perCard[t.card_last4] || 0) + Number(t.amount_inr);
    return {
      spend: debits.reduce((s, t) => s + Number(t.amount_inr), 0),
      refunds: credits.reduce((s, t) => s + Number(t.amount_inr), 0),
      count: inr.length,
      perCard,
    };
  }, [allData]);

  const latestBalances = useMemo(() => latestBalanceByCard(rewards), [rewards]);
  const activeOffers = useMemo(
    () => sortOffersForDisplay(offers).filter((o) => effectiveOfferStatus(o) === "active"),
    [offers]
  );
  const sortedLoyalty = useMemo(() => {
    const order = { airline: 0, hotel: 1, other: 2 } as const;
    return [...loyalty].sort((a, b) => order[a.program_type] - order[b.program_type]);
  }, [loyalty]);

  const cards = allData?.cards ?? [];
  const monthName = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-mist/60 text-sm">Loading your overview…</div>;
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8 pb-20">

      {/* ── Greeting + hero ─────────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-mist">{greeting()}, KP</h1>
          <p className="text-sm text-mist/60 mt-1">
            Your cards at a glance — {monthName}
            {allData?.last_sync && (
              <span className="text-mist/45"> · synced {new Date(allData.last_sync).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
            )}
          </p>
        </div>
        <button onClick={() => onNavigate("Spend")}
          className="text-sm text-gold hover:text-gold/80 font-medium transition-colors">
          Full spend view →
        </button>
      </div>

      {/* ── Hero stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HeroStat label="Spent this month" value={fmtINR(month.spend)} tone="gold" />
        <HeroStat label="Refunded" value={fmtINR(month.refunds)} tone="emerald" />
        <HeroStat label="Transactions" value={fmtNum(month.count)} tone="plain" />
        <HeroStat label="Active cards" value={fmtNum(cards.length)} tone="plain" />
      </div>

      {/* ── Card tiles ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-lg font-semibold text-mist">Your cards</h2>
          <button onClick={() => onNavigate("Cards")}
            className="text-xs text-mist/60 hover:text-gold transition-colors">Manage cards →</button>
        </div>

        {cards.length === 0 ? (
          <EmptyPanel
            title="No cards yet"
            body="Add your first card to start tracking spend, milestones and rewards."
            cta="Add a card →" onClick={() => onNavigate("Cards")} />
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {cards.map((c) => {
              const spec = CARD_REGISTRY[c.product_key];
              const spent = month.perCard[c.last4] || 0;
              const milestone = spec?.milestones_monthly?.[0]?.spend_inr;
              const pct = milestone ? Math.min((spent / milestone) * 100, 100) : null;
              const est = spec?.rewards ? estimatePoints(spent, spec.rewards) : null;
              return (
                <CardVisual key={c.id} productKey={c.product_key}
                  name={cardLabel(c)} issuer={spec?.issuer ?? ""} network={spec?.network ?? ""}
                  last4={c.last4} onClick={() => onOpenSpend(c.last4)}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-white/55">This month</span>
                    <span className="font-serif text-xl font-semibold text-white tabular-nums">{fmtINR(spent)}</span>
                  </div>
                  {pct !== null && milestone && (
                    <>
                      <div className="mt-2.5 h-1 bg-black/40 rounded-full overflow-hidden">
                        <div className="h-full bg-gold-shimmer rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-1.5 flex justify-between text-2xs text-white/50">
                        <span>{Math.round(pct)}% of {fmtINR(milestone)}</span>
                        {pct >= 100
                          ? <span className="text-emerald">Milestone reached ✓</span>
                          : <span>{fmtINR(milestone - spent)} to go</span>}
                      </div>
                    </>
                  )}
                  {est !== null && spec?.rewards && (
                    <div className="mt-2 text-2xs text-white/50">
                      ≈ {fmtNum(est)} {spec.rewards.program} this month <span className="text-white/35">(base-rate estimate)</span>
                    </div>
                  )}
                </CardVisual>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Holistic panels: rewards / offers / loyalty ─────────────────── */}
      {migrationNeeded && <MissingTableNotice feature="Rewards, Offers & Loyalty" />}

      <div className="grid lg:grid-cols-3 gap-4 items-start">

        {/* Rewards */}
        <Panel title="Reward balances" onOpen={() => onNavigate("Rewards")}>
          {latestBalances.size === 0 ? (
            <PanelEmpty body="Track your point balances per card — enter them once, update whenever." cta="Add a balance →" onClick={() => onNavigate("Rewards")} />
          ) : (
            <ul className="space-y-3">
              {cards.filter((c) => latestBalances.has(c.id)).map((c) => {
                const b = latestBalances.get(c.id)!;
                const stale = expiryState(b.as_of, 0); // reuse: 'expired' = in the past
                const days = stale.kind === "expired" ? stale.days : 0;
                return (
                  <li key={c.id} className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-mist/85 truncate">{cardLabel(c)}</div>
                      <div className="text-xs text-mist/50">{b.program}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-serif text-lg font-semibold text-gold tabular-nums">{fmtNum(Number(b.balance))}</div>
                      <div className={`text-2xs ${days > 45 ? "text-amber" : "text-mist/45"}`}>
                        as of {fmtDate(b.as_of)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* Offers */}
        <Panel title="Active offers" onOpen={() => onNavigate("Offers")}>
          {activeOffers.length === 0 ? (
            <PanelEmpty body="Save card offers you spot — with expiry reminders so none slip past." cta="Add an offer →" onClick={() => onNavigate("Offers")} />
          ) : (
            <ul className="space-y-3">
              {activeOffers.slice(0, 5).map((o) => {
                const card = cards.find((c) => c.id === o.card_id);
                const exp = expiryState(o.valid_until, 14);
                return (
                  <li key={o.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-mist/85 truncate">{o.title}</div>
                      <div className="text-xs text-mist/50 truncate">
                        {card ? cardLabel(card) : "All cards"}{o.merchant ? ` · ${o.merchant}` : ""}
                      </div>
                    </div>
                    <span className={`shrink-0 text-2xs px-2 py-0.5 rounded-full border ${
                      exp.kind === "soon"
                        ? "border-amber/40 text-amber bg-amber/10"
                        : "border-rim text-mist/55"
                    }`}>
                      {exp.kind === "none" ? "No expiry"
                        : exp.kind === "soon" ? (exp.days === 0 ? "Today!" : `${exp.days}d left`)
                        : `till ${fmtDate(o.valid_until!)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* Loyalty */}
        <Panel title="Loyalty status" onOpen={() => onNavigate("Loyalty")}>
          {sortedLoyalty.length === 0 ? (
            <PanelEmpty body="Airline and hotel statuses in one place — tiers, points, expiry dates." cta="Add a program →" onClick={() => onNavigate("Loyalty")} />
          ) : (
            <ul className="space-y-3">
              {sortedLoyalty.slice(0, 5).map((l) => {
                const tierExp = expiryState(l.tier_expires_on);
                return (
                  <li key={l.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-mist/85 truncate">
                        <span className="mr-1.5">{l.program_type === "airline" ? "✈" : l.program_type === "hotel" ? "⌂" : "◆"}</span>
                        {l.program_name}
                      </div>
                      {l.points_balance !== null && (
                        <div className="text-xs text-mist/50 tabular-nums">{fmtNum(Number(l.points_balance))} pts</div>
                      )}
                    </div>
                    {l.tier && (
                      <span className={`shrink-0 text-2xs px-2 py-0.5 rounded-full border font-medium ${
                        tierExp.kind === "expired"
                          ? "border-ruby/40 text-ruby bg-ruby/10"
                          : "border-gold/40 text-gold bg-gold/10"
                      }`}>
                        {l.tier}{tierExp.kind === "expired" ? " · expired" : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── Local pieces ──────────────────────────────────────────────────────────────

function HeroStat({ label, value, tone }: { label: string; value: string; tone: "gold" | "emerald" | "plain" }) {
  const cls = tone === "gold" ? "text-gold" : tone === "emerald" ? "text-emerald" : "text-mist/90";
  return (
    <div className="rounded-2xl border border-rim bg-surface p-5 shadow-card">
      <div className="text-xs text-mist/60 mb-1.5">{label}</div>
      <div className={`font-serif text-3xl font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function Panel({ title, onOpen, children }: { title: string; onOpen: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-rim bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-serif text-base font-semibold text-mist">{title}</h3>
        <button onClick={onOpen} className="text-xs text-mist/60 hover:text-gold transition-colors">Open →</button>
      </div>
      {children}
    </section>
  );
}

function PanelEmpty({ body, cta, onClick }: { body: string; cta: string; onClick: () => void }) {
  return (
    <div className="text-sm text-mist/60 leading-relaxed">
      {body}
      <button onClick={onClick} className="block mt-3 text-gold hover:text-gold/80 font-medium transition-colors">{cta}</button>
    </div>
  );
}

function EmptyPanel({ title, body, cta, onClick }: { title: string; body: string; cta: string; onClick: () => void }) {
  return (
    <div className="rounded-2xl border border-rim bg-surface p-8 shadow-card text-center">
      <div className="font-serif text-lg font-semibold text-mist mb-1">{title}</div>
      <p className="text-sm text-mist/60 mb-4">{body}</p>
      <button onClick={onClick}
        className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 transition-all">
        {cta}
      </button>
    </div>
  );
}
