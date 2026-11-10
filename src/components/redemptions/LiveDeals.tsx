"use client";

// Rewards → Live deals: points sales and transfer bonuses the daily job found
// in KP's mail and on points blogs, plus the ones he adds himself, scored
// against his own cards.
//
// The job (scripts/find-deals.ts) stores only what each source said; every
// judgement on this screen — can his cards use it, is it better than usual,
// how many points it turns into — comes from src/lib/deals/score.ts, run here
// against the current wallet. Nothing on this screen does its own maths.
//
// Layout (2026-11-10, "too much info" fix): one quiet line of status, then a
// short list of rows that each say just program · figure · time left. Tap a
// row for the rest (how your cards reach it, how it compares, the source).
// Rows are native <details>, so they open without JS and a static render
// still contains every detail for the tests to read.

import { useCallback, useEffect, useMemo, useState } from "react";
import MissingTableNotice from "@/components/MissingTableNotice";
import { createClient } from "@/lib/supabase/client";
import { fmtNum, fmtDate } from "@/lib/format";
import type { RedemptionsData } from "@/lib/redemptions-data";
import { PROGRAMS, PROGRAM_GROUPS, groupOf, type ProgramKey } from "@/lib/transfer-partners/programs";
import { RANK_AT } from "@/lib/transfer-partners/math";
import { loadDeals, type DealsData } from "@/lib/deals/load";
import { assessDeal, rankDeals, type Assessment, type DealGrade } from "@/lib/deals/score";
import { runHealth, type HealthLevel } from "@/lib/deals/health";
import { figureOf, kindLine, timeLeft } from "@/lib/deals/display";
import { bankOfIssuer } from "@/lib/deals/prefilter";
import { BANK_NAMES, buildManualDeal, EMPTY_MANUAL_DEAL, isManualOnly, type ManualDealInput, type ManualDealRow } from "@/lib/deals/manual";
import type { BankKey, DealSource, StoredDeal } from "@/lib/deals/types";
import { buildWallet, holdingsByProgram, Monogram } from "./transfer-ui";

/** Ended deals stay listed (folded away) this long, for reference. */
const ENDED_SHOWN_DAYS = 60;

type Row = { d: StoredDeal; assessment: Assessment };

/** Only grades worth a word on the row itself; the rest live in the details. */
const GRADE_TAG: Partial<Record<DealGrade, { label: string; cls: string }>> = {
  new_high:     { label: "Best yet",          cls: "text-emerald" },
  matches_best: { label: "Matches best",      cls: "text-emerald" },
  above_usual:  { label: "Better than usual", cls: "text-sapphire" },
  below_usual:  { label: "Weaker than usual", cls: "text-amber" },
};

const DOT: Record<HealthLevel, string> = { ok: "bg-emerald", never: "bg-amber", stale: "bg-amber", failed: "bg-ruby" };

const inputCls =
  "w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none";
const btnPrimary =
  "bg-gold-shimmer text-ink px-4 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-40 transition-all";
const btnQuiet = "px-3 py-2 rounded-xl text-sm text-mist/60 hover:text-mist transition-colors";

function endsLine(a: Assessment, d: StoredDeal): string {
  if (a.status === "ended") return d.ends_on ? `Ended ${fmtDate(d.ends_on)}` : "Probably over (no end date was given)";
  if (a.status === "no_end_date") return "No end date given — check before you buy";
  return `${fmtDate(d.ends_on!)} · ${timeLeft(a, d).text.toLowerCase()}`;
}

function sourceLink(s: DealSource): { href: string | null; label: string } {
  const when = fmtDate(s.seen_at.slice(0, 10));
  if (s.kind === "manual") return { href: s.url, label: `Added by you, ${when}` };
  if (s.kind === "blog") return { href: s.url ?? "#", label: `${s.origin}, ${when}` };
  const sender = s.origin.replace(/\s*<?[^\s<>]+@[^\s<>]+>?\s*$/, "").trim() || s.origin;
  return { href: `https://mail.google.com/mail/u/0/#all/${s.item_id}`, label: `Email from ${sender}, ${when}` };
}

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="hidden sm:block w-4 h-4 shrink-0 text-mist/35 transition-transform group-open:rotate-180">
      <path d="m5 8 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 py-2 border-t border-wire first:border-t-0">
      <dt className="text-xs text-mist/45">{label}</dt>
      <dd className="text-sm text-mist/85 min-w-0 break-words">{children}</dd>
    </div>
  );
}

function DealRow({ row: { d, assessment: a }, holding, onDelete }: {
  row: Row; holding?: number; onDelete?: (d: StoredDeal) => void;
}) {
  const p = PROGRAMS[d.program];
  const fig = figureOf(d);
  const time = timeLeft(a, d);
  const ended = a.status === "ended";
  const grade = a.grade ? GRADE_TAG[a.grade] : undefined;
  const mine = isManualOnly(d);
  const fromBlogOnly = d.sources.length > 0 && d.sources.every((s) => s.kind === "blog");
  const cautions = [
    d.targeted && "Targeted to you — the figure may differ in another account.",
    fromBlogOnly && "From a blog, unconfirmed — not in your inbox, so check the program's site.",
    d.evidence && !d.evidence_verified && "Couldn't match this quote to the source word for word — check the original.",
  ].filter(Boolean) as string[];
  // A live points sale already sits under "Points sales", so its row skips
  // the type and spends the space on what matters: grade and his balance.
  const subline: React.ReactNode[] = [
    !(d.kind === "buy_points" && !ended) && kindLine(d),
    grade && <span className={grade.cls}>{grade.label}</span>,
    mine && <span className="text-gold/80">Added by you</span>,
    holding !== undefined && `You hold ${fmtNum(holding)}`,
  ].filter(Boolean);
  if (!subline.length) subline.push(kindLine(d));

  return (
    <details className={`group rounded-2xl border bg-surface shadow-card min-w-0 ${ended ? "border-dashed border-rim opacity-70" : "border-rim"}`}>
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center gap-3 px-4 py-3.5 rounded-2xl hover:bg-mist/[0.03] transition-colors">
        <Monogram program={d.program} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-mist leading-snug break-words">{p.name}</div>
          <div className="text-xs text-mist/50 leading-snug">
            {subline.map((part, i) => <span key={i} className="whitespace-nowrap">{i > 0 && " · "}{part}</span>)}
          </div>
        </div>
        <div className="text-right shrink-0">
          {fig ? (
            <div className="font-serif text-lg font-semibold text-gold tabular-nums leading-tight">
              {fig.big}<span className="ml-1 font-sans text-xs font-normal text-mist/50">{fig.small}</span>
            </div>
          ) : (
            <div className="text-xs text-mist/50">See details</div>
          )}
          <div className={`text-2xs tabular-nums ${time.urgent ? "text-ruby font-semibold" : "text-mist/45"}`}>{time.text}</div>
        </div>
        <Chevron />
      </summary>

      <div className="px-4 pb-4">
        <p className="text-sm text-mist pb-2">{d.headline}</p>
        <dl className="rounded-xl bg-ink border border-wire px-3">
          <Fact label="Ends">{endsLine(a, d)}</Fact>
          {a.reach !== "buy" && <Fact label="For you">
            <div>{a.reachNote}</div>
            {a.routes.map((r) => (
              <div key={r.card} className="text-mist/70 tabular-nums">
                {r.card}:{" "}
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
          </Fact>}
          {a.gradeNote && <Fact label="Compared">{a.gradeNote}</Fact>}
          {holding !== undefined && <Fact label="You hold">{fmtNum(holding)} {p.unit}</Fact>}
          {d.evidence && (
            <Fact label={mine ? "Your note" : "It says"}>
              <span className="text-mist/70">{mine ? d.evidence : `“${d.evidence}”`}</span>
            </Fact>
          )}
        </dl>

        {cautions.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-amber">
            {cautions.map((c) => <li key={c}>{c}</li>)}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-mist/45">
          {d.sources.slice(-1).map((s) => {
            const l = sourceLink(s);
            return l.href ? (
              <a key={`${s.kind}${s.item_id}`} href={l.href} target="_blank" rel="noopener noreferrer"
                className="hover:text-gold underline underline-offset-2 break-all">{l.label}</a>
            ) : <span key={`${s.kind}${s.item_id}`}>{l.label}</span>;
          })}
          {d.sources.length > 1 && <span>+{d.sources.length - 1} earlier</span>}
          {mine && onDelete && (
            <button type="button" onClick={() => onDelete(d)} className="ml-auto text-ruby/80 hover:text-ruby font-medium">
              Delete
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

function Group({ title, rows, holdings, onDelete, empty }: {
  title: string; rows: Row[]; holdings: Map<string, number>; onDelete?: (d: StoredDeal) => void; empty?: string;
}) {
  if (!rows.length && !empty) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-2xs uppercase tracking-widest font-semibold text-mist/45 px-1">
        {title}{rows.length > 0 && <span className="tabular-nums"> · {rows.length}</span>}
      </h3>
      {rows.length ? (
        <div className="space-y-2">
          {rows.map((r) => <DealRow key={r.d.id} row={r} holding={holdings.get(r.d.program)} onDelete={onDelete} />)}
        </div>
      ) : (
        <p className="text-xs text-mist/45 px-1">{empty}</p>
      )}
    </section>
  );
}

/** A folded-away group: one quiet line until opened. */
function Folded({ title, rows, holdings, onDelete }: {
  title: string; rows: Row[]; holdings: Map<string, number>; onDelete?: (d: StoredDeal) => void;
}) {
  if (!rows.length) return null;
  return (
    <details className="group/f">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none px-1 py-1 text-xs text-mist/50 hover:text-mist">
        {title} · <span className="tabular-nums">{rows.length}</span>
        <span className="ml-1 inline-block transition-transform group-open/f:rotate-90">›</span>
      </summary>
      <div className="space-y-2 mt-2">
        {rows.map((r) => <DealRow key={r.d.id} row={r} holding={holdings.get(r.d.program)} onDelete={onDelete} />)}
      </div>
    </details>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-rim bg-ink p-0.5">
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 rounded-[10px] text-sm transition-colors ${
            value === o.key ? "bg-surface text-gold font-semibold shadow-card" : "text-mist/55 hover:text-mist"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PROGRAM_OPTIONS = PROGRAM_GROUPS.map((g) => ({
  label: g.label,
  programs: (Object.values(PROGRAMS) as (typeof PROGRAMS)[ProgramKey][])
    .filter((p) => groupOf(p) === g.key)
    .sort((a, b) => a.name.localeCompare(b.name)),
})).filter((g) => g.programs.length);

/** The "Add a deal" panel. Pure form; saving is the caller's. */
export function AddDealForm({ onSave, onCancel, banks }: {
  onSave: (row: ManualDealRow) => Promise<string | null>; onCancel: () => void; banks: BankKey[];
}) {
  const [f, setF] = useState<ManualDealInput>(EMPTY_MANUAL_DEAL);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ManualDealInput>(k: K, v: ManualDealInput[K]) => { setF((cur) => ({ ...cur, [k]: v })); setError(null); };
  const transfer = f.kind === "transfer_bonus";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Checked here, before anything is sent, so a mistake is caught instantly.
    const now = new Date();
    const built = buildManualDeal(f, now.toISOString(), now.toLocaleDateString("en-CA"), crypto.randomUUID());
    if (!built.ok) { setError(built.error); return; }
    setSaving(true);
    const err = await onSave(built.row);
    setSaving(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-gold/25 bg-surface shadow-card p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-base font-semibold text-mist">Add a deal</h3>
        <Segmented label="Deal type" value={f.kind} onChange={(v) => set("kind", v)}
          options={[{ key: "buy_points", label: "Points sale" }, { key: "transfer_bonus", label: "Transfer bonus" }]} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs text-mist/55 block">{transfer ? "Transfer into" : "Program"}</span>
          <select className={inputCls} value={f.program} onChange={(e) => set("program", e.target.value as ProgramKey)}>
            <option value="">Choose…</option>
            {PROGRAM_OPTIONS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.programs.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>

        {transfer ? (
          <label className="block space-y-1">
            <span className="text-xs text-mist/55 block">From your card&apos;s points</span>
            <select className={inputCls} value={f.fromBank} onChange={(e) => set("fromBank", e.target.value as BankKey)}>
              <option value="">Choose…</option>
              {banks.map((b) => <option key={b} value={b}>{BANK_NAMES[b]}</option>)}
            </select>
          </label>
        ) : (
          <div className="space-y-1">
            <span className="text-xs text-mist/55 block">Offer</span>
            <Segmented label="Bonus or discount" value={f.measure} onChange={(v) => set("measure", v)}
              options={[{ key: "bonus", label: "Bonus points" }, { key: "discount", label: "% off" }]} />
          </div>
        )}

        <label className="block space-y-1">
          <span className="text-xs text-mist/55 block">{!transfer && f.measure === "discount" ? "Discount" : "Bonus"}</span>
          <div className="relative">
            <input className={`${inputCls} pr-8`} inputMode="decimal" placeholder="45" value={f.pct}
              onChange={(e) => set("pct", e.target.value)} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-mist/40">%</span>
          </div>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-mist/55 block">Ends on <span className="text-mist/35">(optional)</span></span>
          <input type="date" className={inputCls} value={f.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
        </label>

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs text-mist/55 block">Link <span className="text-mist/35">(optional)</span></span>
          <input className={inputCls} type="url" placeholder="https://" value={f.link} onChange={(e) => set("link", e.target.value)} />
        </label>

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs text-mist/55 block">Note <span className="text-mist/35">(optional)</span></span>
          <input className={inputCls} placeholder="e.g. App-only, minimum 5,000 points" value={f.note}
            onChange={(e) => set("note", e.target.value)} />
        </label>
      </div>

      {error && <p role="alert" className="text-sm text-ruby">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" className={btnQuiet} onClick={onCancel}>Cancel</button>
        <button type="submit" className={btnPrimary} disabled={saving}>{saving ? "Saving…" : "Save deal"}</button>
      </div>
    </form>
  );
}

export default function LiveDeals({ data }: { data: RedemptionsData }) {
  // `now` is captured when the data arrives, so every date judgement on the
  // screen uses one clock reading (and rendering stays pure).
  const [loaded, setLoaded] = useState<{ deals: DealsData; now: number } | null>(null);
  const reload = useCallback(() => loadDeals().then((deals) => setLoaded({ deals, now: Date.now() })), []);
  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async (row: ManualDealRow): Promise<string | null> => {
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return "You've been signed out — sign in again, then save.";
    const { error } = await sb.from("deals").insert({ ...row, user_id: user.id });
    if (error) return error.code === "23505" ? "That deal is already on your list." : `Couldn't save: ${error.message}`;
    await reload();
    return null;
  }, [reload]);

  const remove = useCallback(async (d: StoredDeal): Promise<string | null> => {
    const { error } = await createClient().from("deals").delete().eq("id", d.id);
    if (error) return `Couldn't delete: ${error.message}`;
    await reload();
    return null;
  }, [reload]);

  if (!loaded) return <div className="py-16 text-center text-sm text-mist/60">Loading deals…</div>;
  return <DealsView data={data} deals={loaded.deals} now={loaded.now} onSave={save} onDelete={remove} />;
}

/** The screen itself, given loaded deals and a clock reading. Exported so a
 *  test can render it with fixed data and read every row. */
export function DealsView({ data, deals, now, onSave, onDelete, initialAdding = false }: {
  data: RedemptionsData; deals: DealsData; now: number;
  onSave?: (row: ManualDealRow) => Promise<string | null>;
  onDelete?: (d: StoredDeal) => Promise<string | null>;
  /** Tests: render with the form open. */
  initialAdding?: boolean;
}) {
  const wallet = useMemo(() => buildWallet(data), [data]);
  const holdings = useMemo(() => holdingsByProgram(data), [data]);
  const [adding, setAdding] = useState(initialAdding);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);

  const banks = useMemo(() => {
    const held = new Set(wallet.map((c) => bankOfIssuer(c.issuer)));
    const all = Object.keys(BANK_NAMES) as BankKey[];
    return [...all.filter((b) => held.has(b)), ...all.filter((b) => !held.has(b))];
  }, [wallet]);

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
  const liveCount = sections.yours.length + sections.buy.length;

  const save = async (row: ManualDealRow) => {
    const err = onSave ? await onSave(row) : "Saving isn't available here.";
    if (!err) { setAdding(false); setNotice({ text: "Deal added.", bad: false }); }
    return err;
  };
  const del = onDelete && (async (d: StoredDeal) => {
    if (!window.confirm(`Delete “${d.headline}”? This only removes the deal you added.`)) return;
    const err = await onDelete(d);
    setNotice(err ? { text: err, bad: true } : { text: "Deal deleted.", bad: false });
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm text-mist">
            <span className="font-semibold tabular-nums">{liveCount}</span> live deal{liveCount === 1 ? "" : "s"} you can use
          </div>
          <div className="flex items-center gap-1.5 text-xs text-mist/50" title={latestSummary}>
            <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${DOT[health.level]}`} />
            <span className={health.level === "ok" ? "" : health.level === "failed" ? "text-ruby" : "text-amber"}>{health.text}</span>
          </div>
        </div>
        {!adding && (
          <button type="button" className={btnPrimary} onClick={() => { setAdding(true); setNotice(null); }}>+ Add a deal</button>
        )}
      </div>

      {notice && (
        <div role="status" className={`rounded-xl border px-4 py-2 text-sm ${notice.bad ? "border-ruby/30 bg-ruby/5 text-ruby" : "border-emerald/30 bg-emerald/5 text-emerald"}`}>
          {notice.text}
        </div>
      )}
      {deals.error && (
        <div className="rounded-xl border border-ruby/30 bg-ruby/5 text-ruby text-sm px-4 py-3">{deals.error}</div>
      )}

      {adding && <AddDealForm banks={banks} onSave={save} onCancel={() => setAdding(false)} />}

      {liveCount === 0 && !sections.other.length && !adding ? (
        <div className="rounded-2xl border border-rim bg-surface p-8 text-center shadow-card space-y-1">
          <div className="text-sm text-mist">No live deals right now</div>
          <div className="text-xs text-mist/50">New ones appear after the daily check, or add one you&apos;ve spotted.</div>
        </div>
      ) : (
        <>
          <Group title="Transfer bonuses for your cards" rows={sections.yours} holdings={holdings} onDelete={del}
            empty="None running for your cards right now." />
          <Group title="Points sales" rows={sections.buy} holdings={holdings} onDelete={del} />
        </>
      )}

      <div className="space-y-1">
        <Folded title="Not for your cards" rows={sections.other} holdings={holdings} onDelete={del} />
        <Folded title={`Ended in the last ${ENDED_SHOWN_DAYS} days`} rows={sections.ended} holdings={holdings} onDelete={del} />
      </div>

      <p className="text-2xs text-mist/40 leading-relaxed px-1">
        Checked every morning from your Gmail and four points blogs. Figures are &quot;up to&quot; headlines — confirm on the program&apos;s site first.
      </p>
    </div>
  );
}
