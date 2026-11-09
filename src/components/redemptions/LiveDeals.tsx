"use client";

// Rewards → Live deals: points sales and transfer bonuses the daily job found
// in KP's mail and on points blogs, scored against his own cards.
//
// The job (scripts/find-deals.ts) stores only what each source said; every
// judgement on this screen — can his cards use it, is it better than usual,
// how many points it turns into — comes from src/lib/deals/score.ts, run here
// against the current wallet. Nothing on this screen does its own maths.

import { useEffect, useMemo, useState } from "react";
import MissingTableNotice from "@/components/MissingTableNotice";
import { fmtNum, fmtDate } from "@/lib/format";
import type { RedemptionsData } from "@/lib/redemptions-data";
import { PROGRAMS } from "@/lib/transfer-partners/programs";
import { RANK_AT } from "@/lib/transfer-partners/math";
import { loadDeals, type DealsData } from "@/lib/deals/load";
import { assessDeal, rankDeals, type Assessment, type DealGrade } from "@/lib/deals/score";
import { runHealth, type HealthLevel } from "@/lib/deals/health";
import type { DealKind, DealSource, StoredDeal } from "@/lib/deals/types";
import { buildWallet, holdingsByProgram, Monogram } from "./transfer-ui";

/** Ended deals stay listed (collapsed) this long, for reference. */
const ENDED_SHOWN_DAYS = 60;

const KIND_LABEL: Record<DealKind, string> = {
  buy_points: "Points sale",
  transfer_bonus: "Transfer bonus",
  ratio_change: "Partner change",
};

const GRADE: Record<DealGrade, { label: string; cls: string }> = {
  new_high:     { label: "Best yet",          cls: "bg-emerald/10 text-emerald border-emerald/30" },
  matches_best: { label: "Matches best",      cls: "bg-emerald/10 text-emerald border-emerald/30" },
  above_usual:  { label: "Better than usual", cls: "bg-sapphire/10 text-sapphire border-sapphire/30" },
  first_seen:   { label: "First on record",   cls: "bg-mist/5 text-mist/60 border-rim" },
  below_usual:  { label: "Weaker than usual", cls: "bg-amber/10 text-amber border-amber/30" },
};

const HEALTH_CLS: Record<HealthLevel, string> = {
  ok: "border-wire bg-surface text-mist/60",
  never: "border-amber/40 bg-amber/5 text-amber",
  stale: "border-amber/40 bg-amber/5 text-amber",
  failed: "border-ruby/30 bg-ruby/5 text-ruby",
};

const chip = "inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-semibold";

function offerFigure(d: StoredDeal): string | null {
  if (d.discount_pct != null) return `${d.discount_pct}% off`;
  if (d.bonus_pct != null) return `${d.kind === "buy_points" ? "up to " : ""}${d.bonus_pct}% bonus`;
  return null;
}

function statusText(a: Assessment, d: StoredDeal): string {
  if (a.status === "ended") return d.ends_on ? `Ended ${fmtDate(d.ends_on)}` : "Probably over (no end date given)";
  if (a.status === "no_end_date") return "No end date given";
  if (a.daysLeft === 0) return "Ends today";
  if (a.daysLeft === 1) return "Ends tomorrow";
  return `Ends ${fmtDate(d.ends_on!)} · ${a.daysLeft} days left`;
}

function sourceLink(s: DealSource): { href: string; label: string } {
  const when = fmtDate(s.seen_at.slice(0, 10));
  if (s.kind === "blog") return { href: s.url ?? "#", label: `${s.origin}, ${when}` };
  const sender = s.origin.replace(/\s*<?[^\s<>]+@[^\s<>]+>?\s*$/, "").trim() || s.origin;
  return { href: `https://mail.google.com/mail/u/0/#all/${s.item_id}`, label: `Email from ${sender}, ${when}` };
}

function DealCard({ d, a, holding }: { d: StoredDeal; a: Assessment; holding?: number }) {
  const p = PROGRAMS[d.program];
  const figure = offerFigure(d);
  const ended = a.status === "ended";
  const fromBlogOnly = d.sources.every((s) => s.kind === "blog");
  return (
    <article className={`rounded-2xl border bg-surface p-4 sm:p-5 shadow-card space-y-3 min-w-0 ${ended ? "border-dashed border-rim opacity-70" : "border-rim"}`}>
      <div className="flex items-start gap-3 min-w-0">
        <Monogram program={d.program} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="text-2xs uppercase tracking-widest text-gold font-semibold">
            {KIND_LABEL[d.kind]} · {p.name}
          </div>
          <h4 className="font-serif text-base font-semibold text-mist leading-snug break-words">{d.headline}</h4>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {figure && <span className={`${chip} bg-gold/10 text-gold border-gold/30`}>{figure}</span>}
            {a.grade && <span className={`${chip} ${GRADE[a.grade].cls}`}>{GRADE[a.grade].label}</span>}
            <span className={`${chip} ${a.status === "ending_soon" ? "bg-ruby/10 text-ruby border-ruby/30" : "bg-mist/5 text-mist/65 border-rim"}`}>
              {statusText(a, d)}
            </span>
            {d.targeted && (
              <span className={`${chip} bg-plum/10 text-plum border-plum/30`} title="Personalised offer — check the figure in your own account">
                Targeted to you
              </span>
            )}
            {fromBlogOnly && (
              <span className={`${chip} bg-amber/10 text-amber border-amber/30`} title="Seen on a blog, not in your inbox — confirm on the program's site">
                From a blog, unconfirmed
              </span>
            )}
            {holding !== undefined && (
              <span className={`${chip} bg-emerald/10 text-emerald border-emerald/30`} title="Logged under Miles & status">
                You hold {fmtNum(holding)} {p.unit}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-ink border border-wire p-3 space-y-1.5 text-xs text-mist/75">
        <div className="font-medium text-mist">{a.reachNote}</div>
        {a.routes.map((r) => (
          <div key={r.card} className="tabular-nums break-words">
            <span className="font-semibold text-mist">{r.card}</span>:{" "}
            {r.normal != null ? (
              <>
                {fmtNum(RANK_AT)} points → {fmtNum(r.normal)} {p.unit}
                {r.boosted != null && (
                  <> normally, <span className="font-semibold text-emerald">{fmtNum(r.boosted)}</span> with the {d.bonus_pct}% bonus</>
                )}
              </>
            ) : (
              <>
                transfer to {PROGRAMS[r.via].name} first, then convert to {p.name}
                {d.bonus_pct != null && <> with the {d.bonus_pct}% bonus</>}
              </>
            )}
          </div>
        ))}
        {a.gradeNote && <div className="text-mist/55">{a.gradeNote}</div>}
      </div>

      {d.evidence && (
        <blockquote className={`text-xs leading-relaxed border-l-2 pl-3 ${d.evidence_verified ? "border-gold/40 text-mist/70" : "border-amber/40 text-mist/55"}`}>
          “{d.evidence}”
          {!d.evidence_verified && <span className="block text-2xs text-amber mt-0.5">Couldn&apos;t match this quote to the source word for word — check the original.</span>}
        </blockquote>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-mist/45">
        {d.sources.slice(-3).map((s) => {
          const l = sourceLink(s);
          return (
            <a key={`${s.kind}${s.item_id}`} href={l.href} target="_blank" rel="noopener noreferrer"
              className="hover:text-gold underline underline-offset-2 break-all">
              {l.label}
            </a>
          );
        })}
        {d.sources.length > 3 && <span>+{d.sources.length - 3} earlier mentions</span>}
      </div>
    </article>
  );
}

function Section({ title, hint, rows, holdings, collapsed }: {
  title: string; hint: string; rows: { d: StoredDeal; assessment: Assessment }[];
  holdings: Map<string, number>; collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  if (!rows.length) return null;
  return (
    <section className="space-y-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left flex items-baseline justify-between gap-3">
        <span>
          <span className="font-serif text-lg font-semibold text-mist">{title}</span>{" "}
          <span className="text-sm text-mist/45 tabular-nums">({rows.length})</span>
          <span className="block text-xs text-mist/55">{hint}</span>
        </span>
        <span className="text-xs text-mist/45 shrink-0">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map(({ d, assessment }) => (
            <DealCard key={d.id} d={d} a={assessment} holding={holdings.get(d.program)} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function LiveDeals({ data }: { data: RedemptionsData }) {
  // `now` is captured when the data arrives, so every date judgement on the
  // screen uses one clock reading (and rendering stays pure).
  const [loaded, setLoaded] = useState<{ deals: DealsData; now: number } | null>(null);
  useEffect(() => { loadDeals().then((deals) => setLoaded({ deals, now: Date.now() })); }, []);
  if (!loaded) return <div className="py-16 text-center text-sm text-mist/60">Loading deals…</div>;
  return <DealsView data={data} deals={loaded.deals} now={loaded.now} />;
}

/** The screen itself, given loaded deals and a clock reading. Exported so a
 *  test can render it with fixed data and read every row. */
export function DealsView({ data, deals, now }: { data: RedemptionsData; deals: DealsData; now: number }) {
  const wallet = useMemo(() => buildWallet(data), [data]);
  const holdings = useMemo(() => holdingsByProgram(data), [data]);

  const sections = useMemo(() => {
    const today = new Date(now).toLocaleDateString("en-CA"); // local YYYY-MM-DD
    const ranked = rankDeals(deals.deals.map((d) => ({ d, assessment: assessDeal(d, wallet, deals.deals, today) })));
    const live = ranked.filter((r) => r.assessment.status !== "ended");
    const cutoff = now - ENDED_SHOWN_DAYS * 86400000;
    return {
      yours: live.filter((r) => r.assessment.reach === "yours"),
      buy: live.filter((r) => r.assessment.reach === "buy"),
      other: live.filter((r) => r.assessment.reach === "not_yours"),
      ended: ranked.filter((r) => r.assessment.status === "ended" && Date.parse(r.d.last_seen_at) >= cutoff)
        .sort((x, y) => Date.parse(y.d.last_seen_at) - Date.parse(x.d.last_seen_at)),
    };
  }, [deals, now, wallet]);

  if (deals.tableMissing) {
    return <MissingTableNotice feature="Live deals" migration="024_deals.sql" />;
  }

  const health = runHealth(deals.runs, now);
  const latestSummary = deals.runs.find((r) => r.ok)?.summary;
  const nothingLive = !sections.yours.length && !sections.buy.length && !sections.other.length;

  return (
    <div className="space-y-8">
      <div className={`rounded-xl border px-4 py-3 text-xs ${HEALTH_CLS[health.level]}`}>
        <div className="font-semibold">{health.text}</div>
        {health.level === "ok" && latestSummary && <div className="text-mist/50 mt-0.5 break-words">{latestSummary}</div>}
        <div className="text-mist/45 mt-0.5">
          Checks your Gmail and four points blogs once a day from the Mac mini. Figures are &quot;up to&quot; headline numbers — confirm on the program&apos;s site before buying or transferring.
        </div>
      </div>

      {deals.error && (
        <div className="rounded-xl border border-ruby/30 bg-ruby/5 text-ruby text-sm px-4 py-3">{deals.error}</div>
      )}

      {nothingLive && health.level !== "never" && (
        <div className="rounded-2xl border border-rim bg-surface p-8 text-center text-sm text-mist/60 shadow-card">
          No live deals right now. New ones will show up here after the next daily check.
        </div>
      )}

      <Section title="For your cards" hint="Transfer bonuses your cards' points can reach right now"
        rows={sections.yours} holdings={holdings} />
      <Section title="Points sales" hint="Buy points or miles with cash at a bonus or discount"
        rows={sections.buy} holdings={holdings} />
      <Section title="Not for your cards" hint="Bonuses on currencies or banks you don't hold"
        rows={sections.other} holdings={holdings} collapsed />
      <Section title="Recently ended" hint={`Finished in the last ${ENDED_SHOWN_DAYS} days — kept for comparison`}
        rows={sections.ended} holdings={holdings} collapsed />
    </div>
  );
}
