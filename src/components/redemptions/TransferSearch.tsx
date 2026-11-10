"use client";

// "Find a transfer" — the search box at the top of Rewards → Transfer
// partners. Type a card, a partner, or both; every card × partner pair comes
// back as one row: your card balance (and where it came from), the ratio,
// what that balance becomes, your balance in the partner program, and any
// live deal for it. Modelled on point.me's from/to search and AwardWallet's
// balance list. All maths is in src/lib/transfer-partners/search.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtNum, fmtDate } from "@/lib/format";
import { latestBalanceByCard } from "@/lib/perks";
import type { RedemptionsData } from "@/lib/redemptions-data";
import { PROGRAMS, type ProgramKey } from "@/lib/transfer-partners/programs";
import { matchProgram, RANK_AT } from "@/lib/transfer-partners/math";
import {
  searchCombos, suggest, EMPTY_SELECTION, GROUP_LABEL,
  type ComboRow, type Group, type Holding, type SearchCard, type Selection, type Suggestion,
} from "@/lib/transfer-partners/search";
import { loadDeals, type DealsData } from "@/lib/deals/load";
import { assessDeal } from "@/lib/deals/score";
import { bankOfIssuer } from "@/lib/deals/prefilter";
import type { StoredDeal } from "@/lib/deals/types";
import { Monogram, RatioPill, CardSwatch, type WalletCard } from "./transfer-ui";

// ── Data shaping ────────────────────────────────────────────────────────────

export function buildSearchCards(data: RedemptionsData, wallet: WalletCard[]): SearchCard[] {
  const latest = latestBalanceByCard(data.rewards);
  const byProduct = new Map(wallet.map((w) => [w.product_key, w]));
  return data.cards.flatMap((c) => {
    const w = byProduct.get(c.product_key);
    if (!w) return [];
    const b = latest.get(c.id);
    return [{
      id: c.id, product_key: c.product_key, short: w.short,
      name: CARD_REGISTRY[c.product_key]?.display_name ?? w.name, issuer: w.issuer, last4: c.last4, spec: w.spec,
      balance: b ? { amount: Number(b.balance), as_of: b.as_of, fromStatement: (b.notes ?? "").startsWith("From statement") } : null,
    }];
  });
}

export function buildHoldings(data: RedemptionsData): Map<ProgramKey, Holding> {
  const m = new Map<ProgramKey, Holding>();
  for (const row of data.loyalty) {
    const k = matchProgram(row.program_name);
    const bal = Number(row.points_balance);
    if (!k || row.points_balance == null || !Number.isFinite(bal)) continue;
    const prev = m.get(k);
    const as_of = row.updated_at.slice(0, 10);
    if (!prev || prev.as_of < as_of) m.set(k, { balance: bal, as_of, auto: row.source === "parsed" });
  }
  return m;
}

/** Live deals for one program, as of `today` (YYYY-MM-DD). */
function liveDeals(deals: StoredDeal[], program: ProgramKey, today: string): StoredDeal[] {
  return deals.filter((d) => d.program === program && assessDeal(d, [], deals, today).status !== "ended");
}

/** A live transfer bonus that applies to this exact row, if any. */
function bonusFor(row: ComboRow, live: StoredDeal[]): StoredDeal | null {
  const bank = bankOfIssuer(row.card.issuer);
  return live.find((d) => d.kind === "transfer_bonus" && d.bonus_pct != null && (
    d.from_bank ? d.from_bank === bank
      : d.from_program ? row.path.hops.length > 1 && row.path.hops[0].program === d.from_program
        : !d.from_other && row.path.hops.length === 1)) ?? null;
}

// ── Small pieces ────────────────────────────────────────────────────────────

const chip = "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium";
const when = (iso: string) => fmtDate(iso.slice(0, 10));

function CardBalance({ c }: { c: SearchCard }) {
  if (!c.balance) return <span className="text-mist/45">Balance not saved yet</span>;
  return (
    <span>
      <span className="font-semibold text-mist tabular-nums">{fmtNum(c.balance.amount)}</span> points
      <span className="text-mist/45"> · {c.balance.fromStatement ? "statement" : "saved"} {when(c.balance.as_of)}</span>
    </span>
  );
}

function HoldingLine({ program, h }: { program: ProgramKey; h?: Holding }) {
  const p = PROGRAMS[program];
  if (!h) return <span className="text-mist/45">No {p.name} balance saved — add it under Miles &amp; status</span>;
  return (
    <span>
      You hold <span className="font-semibold text-mist tabular-nums">{fmtNum(h.balance)}</span> {p.unit}
      <span className="text-mist/45"> · {h.auto ? "read from email" : "you entered it"}, {when(h.as_of)}</span>
    </span>
  );
}

function DealBanner({ d }: { d: StoredDeal }) {
  const figure = d.discount_pct != null ? `${d.discount_pct}% off` : d.bonus_pct != null ? `${d.kind === "buy_points" ? "up to " : ""}${d.bonus_pct}% bonus` : "";
  const what = d.kind === "buy_points" ? "Points sale" : d.kind === "transfer_bonus" ? "Transfer bonus" : "Partner change";
  return (
    <div className="rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-xs text-amber">
      <span className="font-semibold">Live deal · {what}{figure ? `: ${figure}` : ""}</span>
      {d.ends_on && <> · ends {fmtDate(d.ends_on)}</>}
      <span className="block text-mist/60 mt-0.5 break-words">{d.headline}</span>
    </div>
  );
}

function Row({ row, holding, live }: { row: ComboRow; holding?: Holding; live: StoredDeal[] }) {
  const p = PROGRAMS[row.program];
  const bonus = bonusFor(row, live);
  const boosted = bonus && row.units != null ? Math.floor(row.units * (1 + bonus.bonus_pct! / 100)) : null;
  const trimmed = row.card.balance && row.usable != null && row.usable < row.card.balance.amount;
  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)] sm:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-medium text-mist text-sm">
          <CardSwatch card={{ product_key: row.card.product_key }} />
          <span className="truncate">{row.card.short} ••{row.card.last4}</span>
        </div>
        <div className="text-xs text-mist/65 mt-0.5"><CardBalance c={row.card} /></div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap text-xs text-mist/70" aria-label="Transfer route">
        {row.path.hops.map((h, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span className="text-mist/40">then</span>}
            <RatioPill ratio={h.ratio} title={h.note} />
            {i < row.path.hops.length - 1 && <span>{PROGRAMS[h.program].name}</span>}
          </span>
        ))}
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <Monogram program={row.program} size="sm" />
          {row.units != null ? (
            <span><span className="font-semibold text-emerald tabular-nums">{fmtNum(row.units)}</span> {p.unit} <span className="text-mist/55">in {p.name}</span></span>
          ) : (
            <span className="text-mist/70">{fmtNum(RANK_AT)} points → <span className="font-semibold tabular-nums">{fmtNum(row.sample)}</span> {p.unit} <span className="text-mist/55">in {p.name}</span></span>
          )}
        </div>
        <div className="text-2xs text-mist/55 mt-1 space-y-0.5">
          {boosted != null && (
            <div className="text-amber font-semibold">{fmtNum(boosted)} with the live {bonus!.bonus_pct}% transfer bonus</div>
          )}
          {trimmed && <div>{fmtNum(row.usable!)} of your points can move (the bank transfers in fixed blocks)</div>}
          <div>
            {[row.first.time, row.first.group, row.path.hops.length > 1 ? "two steps" : null].filter(Boolean).join(" · ")}
            {row.first.disputed && <span title={row.first.disputed}> · ratio disputed ?</span>}
          </div>
          <div><HoldingLine program={row.program} h={holding} /></div>
        </div>
      </div>
    </li>
  );
}

// ── The search ──────────────────────────────────────────────────────────────

export default function TransferSearch({ data, wallet, initial = EMPTY_SELECTION, initialDeals, now }: {
  data: RedemptionsData;
  wallet: WalletCard[];
  /** For tests and deep links; the box starts empty otherwise. */
  initial?: Selection;
  /** For tests; loaded from the database otherwise. */
  initialDeals?: DealsData;
  now?: number;
}) {
  const cards = useMemo(() => buildSearchCards(data, wallet), [data, wallet]);
  const holdings = useMemo(() => buildHoldings(data), [data]);
  const [sel, setSel] = useState<Selection>(initial);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState<{ deals: DealsData; now: number } | null>(
    initialDeals ? { deals: initialDeals, now: now ?? 0 } : null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialDeals) return;
    loadDeals().then((deals) => setLoaded({ deals, now: Date.now() })).catch(() => {});
  }, [initialDeals]);

  const suggestions = useMemo(() => suggest(query, cards, sel), [query, cards, sel]);
  const result = useMemo(() => searchCombos(sel, cards), [sel, cards]);
  const today = loaded ? new Date(loaded.now).toLocaleDateString("en-CA") : "";
  const deals = loaded?.deals.deals ?? [];

  function pick(s: Suggestion) {
    setSel((cur) => s.kind === "card" ? { ...cur, products: [...cur.products, s.product_key] }
      : s.kind === "program" ? { ...cur, programs: [...cur.programs, s.program] }
        : { ...cur, groups: [...cur.groups, s.group] });
    setQuery(""); setActive(0); input.current?.focus();
  }
  function removeLast() {
    setSel((cur) => cur.groups.length ? { ...cur, groups: cur.groups.slice(0, -1) }
      : cur.programs.length ? { ...cur, programs: cur.programs.slice(0, -1) }
        : { ...cur, products: cur.products.slice(0, -1) });
  }
  const anything = sel.products.length + sel.programs.length + sel.groups.length > 0;
  const cardName = (pk: string) => cards.find((c) => c.product_key === pk)?.short ?? pk;
  const showList = open && query.trim() !== "" && suggestions.length > 0;

  // Partners the selection is about, for the header panels.
  const focusPrograms = sel.programs.length ? sel.programs : [];

  return (
    <section aria-label="Find a transfer" className="rounded-2xl border border-rim bg-surface p-4 sm:p-5 shadow-card space-y-4">
      <div>
        <h3 className="font-serif text-lg font-semibold text-mist">Find a transfer</h3>
        <p className="text-xs text-mist/60">Search a card, a partner, or both — see the ratio, what your points become, and what you already hold.</p>
      </div>

      <div className="relative">
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-rim bg-ink px-3 py-2 focus-within:border-gold/50"
          onClick={() => input.current?.focus()}>
          <svg aria-hidden className="w-4 h-4 text-mist/45 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" strokeLinecap="round" />
          </svg>
          {sel.products.map((pk) => (
            <button key={pk} type="button" className={`${chip} border-sapphire/30 bg-sapphire/10 text-sapphire`}
              aria-label={`Remove ${cardName(pk)}`} onClick={() => setSel({ ...sel, products: sel.products.filter((x) => x !== pk) })}>
              {cardName(pk)} <span aria-hidden>✕</span>
            </button>
          ))}
          {sel.programs.map((k) => (
            <button key={k} type="button" className={`${chip} border-emerald/30 bg-emerald/10 text-emerald`}
              aria-label={`Remove ${PROGRAMS[k].name}`} onClick={() => setSel({ ...sel, programs: sel.programs.filter((x) => x !== k) })}>
              {PROGRAMS[k].name} <span aria-hidden>✕</span>
            </button>
          ))}
          {sel.groups.map((g) => (
            <button key={g} type="button" className={`${chip} border-plum/30 bg-plum/10 text-plum`}
              aria-label={`Remove ${GROUP_LABEL[g]}`} onClick={() => setSel({ ...sel, groups: sel.groups.filter((x) => x !== g) })}>
              {GROUP_LABEL[g]} <span aria-hidden>✕</span>
            </button>
          ))}
          <input ref={input} value={query} role="combobox" aria-expanded={showList} aria-controls="transfer-suggestions"
            aria-autocomplete="list" aria-label="Search a card or partner"
            placeholder={anything ? "Add a card or partner…" : "Infinia, Marriott, Avios, 4455…"}
            className="flex-1 min-w-[9rem] bg-transparent text-sm text-mist placeholder:text-mist/35 outline-none py-1"
            onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, suggestions.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter" && suggestions[active]) { e.preventDefault(); pick(suggestions[active]); }
              else if (e.key === "Backspace" && !query) removeLast();
              else if (e.key === "Escape") setOpen(false);
            }} />
          {anything && (
            <button type="button" className="text-2xs text-mist/50 hover:text-gold" onClick={() => setSel(EMPTY_SELECTION)}>Clear</button>
          )}
        </div>
        {showList && (
          <ul id="transfer-suggestions" role="listbox"
            className="absolute z-20 left-0 right-0 mt-1 rounded-xl border border-rim bg-surface shadow-card overflow-hidden">
            {suggestions.map((s, i) => (
              <li key={`${s.kind}-${s.label}`} role="option" aria-selected={i === active}>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm ${i === active ? "bg-hover" : ""}`}>
                  {s.kind === "program" ? <Monogram program={s.program} size="sm" />
                    : s.kind === "card" ? <CardSwatch card={{ product_key: s.product_key }} />
                      : <span aria-hidden className="w-7 text-center text-plum">◆</span>}
                  <span className="min-w-0">
                    <span className="block text-mist truncate">{s.label}</span>
                    <span className="block text-2xs text-mist/50">{s.sub}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!anything && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="text-mist/50 py-1">Try:</span>
          {[...new Map(cards.filter((c) => c.spec.partners.length).map((c) => [c.product_key, c])).values()].map((c) => (
            <button key={c.product_key} type="button" className={`${chip} border-rim text-mist/70 hover:bg-hover`}
              onClick={() => setSel({ ...sel, products: [c.product_key] })}>{c.short}</button>
          ))}
          {(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
            <button key={g} type="button" className={`${chip} border-rim text-mist/70 hover:bg-hover`}
              onClick={() => setSel({ ...sel, groups: [g] })}>{GROUP_LABEL[g]}</button>
          ))}
        </div>
      )}

      {!anything ? (
        <Balances cards={cards} holdings={holdings}
          onCard={(pk) => setSel({ ...EMPTY_SELECTION, products: [pk] })}
          onProgram={(k) => setSel({ ...EMPTY_SELECTION, programs: [k] })} />
      ) : (
        <div className="space-y-3">
          {focusPrograms.map((k) => {
            const live = today ? liveDeals(deals, k, today) : [];
            return (
              <div key={k} className="rounded-xl border border-wire bg-ink p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Monogram program={k} /> <span className="font-semibold text-mist">{PROGRAMS[k].name}</span>
                </div>
                <div className="text-xs text-mist/70"><HoldingLine program={k} h={holdings.get(k)} /></div>
                {live.map((d) => <DealBanner key={d.id} d={d} />)}
              </div>
            );
          })}

          {result.rows.length > 0 ? (
            <ul className="rounded-xl border border-rim divide-y divide-wire bg-surface" aria-label="Transfer options">
              {result.rows.map((r) => (
                <Row key={`${r.card.id}-${r.program}`} row={r} holding={holdings.get(r.program)}
                  live={today ? liveDeals(deals, r.program, today) : []} />
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed border-rim p-4 text-sm text-mist/60 text-center">
              No transfers match. Try another card or partner.
            </div>
          )}

          {result.unreachable.length > 0 && (
            <p className="text-xs text-mist/55">
              <span className="font-semibold text-mist/70">Can&apos;t transfer: </span>
              {result.unreachable.map((u) => `${u.card.short} ••${u.card.last4} → ${PROGRAMS[u.program].name}`).join(" · ")}
            </p>
          )}
          <p className="text-2xs text-mist/45">
            Ratios are from public guides (checked {fmtDate([...new Set(cards.map((c) => c.spec.checked_on))].sort()[0] ?? "")}); transfers are final, so confirm in your bank app first.
          </p>
        </div>
      )}
    </section>
  );
}

function Balances({ cards, holdings, onCard, onProgram }: {
  cards: SearchCard[]; holdings: Map<ProgramKey, Holding>;
  onCard: (pk: string) => void; onProgram: (k: ProgramKey) => void;
}) {
  const programs = [...holdings.entries()].sort((a, b) => PROGRAMS[a[0]].name.localeCompare(PROGRAMS[b[0]].name));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="text-2xs uppercase tracking-widest text-gold font-semibold mb-1.5">Your card points</div>
        <ul className="rounded-xl border border-rim divide-y divide-wire" aria-label="Your card points">
          {cards.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onCard(c.product_key)} className="w-full text-left px-3 py-2 hover:bg-hover">
                <div className="flex items-center gap-2 text-sm text-mist">
                  <CardSwatch card={{ product_key: c.product_key }} />
                  <span className="truncate">{c.short} ••{c.last4}</span>
                </div>
                <div className="text-xs text-mist/65 mt-0.5">
                  {c.spec.partners.length ? <CardBalance c={c} /> : <span className="text-mist/45">Cashback card — no transfers</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-2xs uppercase tracking-widest text-gold font-semibold mb-1.5">Your partner balances</div>
        {programs.length ? (
          <ul className="rounded-xl border border-rim divide-y divide-wire" aria-label="Your partner balances">
            {programs.map(([k, h]) => (
              <li key={k}>
                <button type="button" onClick={() => onProgram(k)} className="w-full text-left px-3 py-2 hover:bg-hover">
                  <div className="flex items-center gap-2 text-sm text-mist">
                    <Monogram program={k} size="sm" /><span className="truncate">{PROGRAMS[k].name}</span>
                  </div>
                  <div className="text-xs text-mist/65 mt-0.5">
                    <span className="font-semibold text-mist tabular-nums">{fmtNum(h.balance)}</span> {PROGRAMS[k].unit}
                    <span className="text-mist/45"> · {h.auto ? "from email" : "you entered it"}, {when(h.as_of)}</span>
                    {h.auto && <span className={`${chip} ml-1.5 py-0 border-emerald/30 bg-emerald/10 text-emerald text-2xs`}>Auto</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-rim p-3 text-xs text-mist/55">No partner balances saved yet.</div>
        )}
        <p className="text-2xs text-mist/45 mt-1.5">Hilton, KrisFlyer, Qatar and Club ITC update daily from their emails. Marriott and Accor don&apos;t email a readable balance — update those under Miles &amp; status.</p>
      </div>
    </div>
  );
}
