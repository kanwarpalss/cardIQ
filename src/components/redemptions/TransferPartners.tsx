"use client";

// Transfer partners: where each card's points can go, at what ratio, and
// which routes are worth it. Three layers, top to bottom:
//   1. Card snapshot — pick a card, type a balance, see every partner tile
//      with the miles it would become, plus two-step options via bridges.
//   2. Best routes — curated sweet spots, each resolved against KP's wallet.
//   3. Partner grid — all programs × all cards in one table.
// All numbers come from src/lib/transfer-partners (sourced + unit-tested);
// nothing here does its own ratio maths.

import { useEffect, useMemo, useRef, useState } from "react";
import CardVisual from "@/components/CardVisual";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtNum, fmtDate } from "@/lib/format";
import type { RedemptionsData } from "@/lib/redemptions-data";
import {
  PROGRAMS, PROGRAM_GROUPS, groupOf, type Alliance, type ProgramKey,
} from "@/lib/transfer-partners/programs";
import type { CardTransfer } from "@/lib/transfer-partners/cards";
import { ROUTES } from "@/lib/transfer-partners/routes";
import {
  convertAlong, pathsTo, parsePointsInput, usablePoints, convert, rate, betterIndirect, fmtRatio, twoStepOptions, type Path,
} from "@/lib/transfer-partners/math";
import {
  buildWallet, holdingsByProgram, Monogram, RatioPill, CardSwatch, GROUP_STYLE, type WalletCard,
} from "./transfer-ui";
import RouteCards from "./RouteCards";
import PartnerGrid from "./PartnerGrid";

type Filter = "all" | Alliance | "hotel";

const DEFAULT_POINTS = "1,00,000";

export default function TransferPartners({ data, onAddCard }: {
  data: RedemptionsData; onAddCard: () => void;
}) {
  const wallet = useMemo(() => buildWallet(data), [data]);
  const holdings = useMemo(() => holdingsByProgram(data), [data]);
  const transferable = useMemo(() => wallet.filter((c) => c.spec.partners.length), [wallet]);

  const [selected, setSelected] = useState<string | null>(null);
  const [pointsText, setPointsText] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [openProgram, setOpenProgram] = useState<ProgramKey | null>(null);

  if (!wallet.length) {
    return (
      <div className="rounded-2xl border border-rim bg-surface p-10 shadow-card text-center">
        <div className="font-serif text-lg font-semibold text-mist mb-1">No cards yet</div>
        <p className="text-sm text-mist/60 mb-4">Add a card to see where its points can go.</p>
        <button onClick={onAddCard}
          className="bg-gold-shimmer text-ink px-4 py-2 rounded-xl text-sm font-semibold shadow-glow-gold">
          Add a card →
        </button>
      </div>
    );
  }

  const card = wallet.find((c) => c.product_key === selected) ?? transferable[0] ?? wallet[0];

  // The calculator starts from the card's saved balance when there is one,
  // otherwise from a labelled example — never a number that looks like his.
  const usingBalance = pointsText === null && card.balance !== null;
  const shownText = pointsText ?? (card.balance ? fmtNum(card.balance.amount) : DEFAULT_POINTS);
  const points = parsePointsInput(shownText);

  function pickCard(pk: string) {
    setSelected(pk); setPointsText(null); setOpenProgram(null); setFilter("all");
  }

  function pickFromGrid(pk: string, program: ProgramKey) {
    pickCard(pk);
    setOpenProgram(program); // the detail panel scrolls itself into view
  }

  return (
    <div className="space-y-10">
      <WalletSummary wallet={transferable} />

      <FreshnessNote wallet={transferable} />

      {/* ── 1. Card snapshot ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex gap-2 flex-wrap">
          {wallet.map((c) => {
            const active = c.product_key === card.product_key;
            return (
              <button key={c.product_key} onClick={() => pickCard(c.product_key)}
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all ${
                  active ? "border-gold bg-gold/5 text-mist shadow-glow-gold" : "border-rim bg-surface text-mist/65 hover:text-mist hover:bg-hover"}`}>
                <CardSwatch card={c} />
                <span className="font-medium">{c.short}</span>
                <span className={`text-2xs tabular-nums rounded-full px-1.5 ${active ? "bg-gold text-white" : "bg-raised text-mist/50"}`}>
                  {c.spec.partners.length}
                </span>
              </button>
            );
          })}
        </div>

        <CardSnapshot card={card} points={points} shownText={shownText} usingBalance={usingBalance}
          onPoints={setPointsText} filter={filter} onFilter={setFilter}
          openProgram={openProgram} onOpen={setOpenProgram}
          wallet={transferable} holdings={holdings} />
      </section>

      {/* ── 2. Best routes ───────────────────────────────────────────────── */}
      <RouteCards wallet={transferable} holdings={holdings} />

      {/* ── 3. Grid ──────────────────────────────────────────────────────── */}
      <PartnerGrid wallet={transferable} onPick={pickFromGrid} />
    </div>
  );
}

// ── Wallet summary ──────────────────────────────────────────────────────────

function WalletSummary({ wallet }: { wallet: WalletCard[] }) {
  const reached = new Set<ProgramKey>();
  for (const c of wallet) for (const t of c.spec.partners) reached.add(t.program);
  const count = (g: Alliance | "hotel") => [...reached].filter((k) => groupOf(PROGRAMS[k]) === g).length;
  const airlines = [...reached].filter((k) => PROGRAMS[k].kind === "airline").length;
  const hotels = count("hotel");

  return (
    <section className="rounded-2xl border border-rim bg-surface shadow-card overflow-hidden">
      <div className="p-6 bg-gradient-to-br from-gold/10 via-transparent to-sapphire/5">
        <div className="text-2xs uppercase tracking-widest text-gold font-semibold">Your transfer reach</div>
        <div className="font-serif text-2xl font-semibold text-mist mt-1">
          Your cards reach {airlines} airline and {hotels} hotel programs
        </div>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
          {PROGRAM_GROUPS.map((g) => {
            const n = count(g.key);
            return (
              <div key={g.key} className="rounded-xl bg-surface/80 border border-wire px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-2xs text-mist/55">
                  <span className="w-2 h-2 rounded-full" style={{ background: GROUP_STYLE[g.key].bg }} />{g.label}
                </div>
                <div className="font-serif text-xl font-semibold text-mist tabular-nums">{n}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FreshnessNote({ wallet }: { wallet: WalletCard[] }) {
  // The oldest check among the cards shown: the banner must never claim a
  // fresher date than the stalest list on screen.
  const checked = wallet.map((c) => c.spec.checked_on).sort()[0];
  if (!checked) return null;
  return (
    <div className="rounded-xl border border-amber/30 bg-amber/5 px-4 py-3 text-xs text-mist/70 leading-relaxed">
      <span className="font-semibold text-amber">Check before you move points. </span>
      These lists were checked on {fmtDate(checked)} against public guides; the banks don&apos;t publish a
      current table, change partners without notice, and transfers can&apos;t be undone. A{" "}
      <span className="text-amber font-semibold">?</span> means sources disagree, and the less generous figure
      is shown. Confirm the ratio in your bank app first.
    </div>
  );
}

// ── Card snapshot ───────────────────────────────────────────────────────────

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  ...PROGRAM_GROUPS.map((g) => ({ key: g.key as Filter, label: g.label })),
];

function CardSnapshot({
  card, points, shownText, usingBalance, onPoints, filter, onFilter, openProgram, onOpen, wallet, holdings,
}: {
  card: WalletCard; points: number; shownText: string; usingBalance: boolean;
  onPoints: (s: string) => void; filter: Filter; onFilter: (f: Filter) => void;
  openProgram: ProgramKey | null; onOpen: (p: ProgramKey | null) => void;
  wallet: WalletCard[]; holdings: Map<ProgramKey, number>;
}) {
  const spec = card.spec;
  const reg = CARD_REGISTRY[card.product_key];
  const usable = usablePoints(points, spec);
  const partners = spec.partners;
  const airlines = partners.filter((t) => PROGRAMS[t.program].kind === "airline").length;
  const oneToOne = partners.filter((t) => rate(t.ratio) >= 1).length;

  // Best ratio first within each alliance group (groups are laid out below).
  const visible = partners
    .filter((t) => filter === "all" || groupOf(PROGRAMS[t.program]) === filter)
    .sort((a, b) =>
      rate(b.ratio) - rate(a.ratio) ||
      PROGRAMS[a.program].name.localeCompare(PROGRAMS[b.program].name));

  const twoStep = useMemo(() => twoStepOptions(card.spec, usable), [card.spec, usable]);
  const open = openProgram ? partners.find((t) => t.program === openProgram) : undefined;

  return (
    <div className="rounded-2xl border border-rim bg-surface shadow-card p-5 sm:p-6 space-y-5">
      <div className="grid gap-5 md:grid-cols-[minmax(0,280px)_1fr] items-start">
        <CardVisual productKey={card.product_key} name={card.name} issuer={card.issuer}
          network={reg?.network ?? ""} last4={card.last4s.join(" · ")}>
          <div className="flex justify-between text-xs text-white/70">
            <span>{card.currency}</span>
            <span className="tabular-nums">{partners.length} partners</span>
          </div>
        </CardVisual>

        <div className="space-y-4">
          {spec.none_reason ? (
            <p className="text-sm text-mist/70">{spec.none_reason}</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Airlines" value={airlines} />
                <Stat label="Hotels" value={partners.length - airlines} />
                <Stat label="At 1:1 or better" value={oneToOne} />
              </div>

              <label className="block">
                <span className="text-xs text-mist/55">
                  {usingBalance && card.balance
                    ? `Your balance on ••${card.balance.last4}, as of ${fmtDate(card.balance.as_of)}`
                    : "Points to transfer (an example — type your own)"}
                </span>
                <div className="mt-1 flex items-center gap-2 rounded-xl border border-rim bg-ink px-3 py-2 focus-within:border-gold/50">
                  <input inputMode="numeric" value={shownText} onChange={(e) => onPoints(e.target.value)}
                    className="flex-1 bg-transparent font-serif text-2xl font-semibold text-mist tabular-nums outline-none min-w-0"
                    aria-label="Points to transfer" />
                  <span className="text-xs text-mist/50 shrink-0">{card.currency}</span>
                </div>
                {usable !== points && points > 0 && (
                  <span className="text-2xs text-amber mt-1 block">
                    {usable === 0
                      ? `Below the ${fmtNum(spec.min ?? 0)}-point minimum`
                      : `Only ${fmtNum(usable)} can move (multiples of ${fmtNum(spec.increment ?? 1)})`}
                  </span>
                )}
              </label>
            </>
          )}
          {spec.caveat && <p className="text-xs text-amber">{spec.caveat}</p>}
        </div>
      </div>

      {partners.length > 0 && (
        <>
          <div className="flex gap-1 flex-wrap">
            {FILTERS.filter((f) => f.key === "all" || partners.some((t) => groupOf(PROGRAMS[t.program]) === f.key))
              .map((f) => (
                <button key={f.key} onClick={() => onFilter(f.key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                    filter === f.key ? "bg-mist text-ink border-mist" : "border-rim text-mist/60 hover:text-mist hover:bg-hover"}`}>
                  {f.label}
                </button>
              ))}
          </div>

          {PROGRAM_GROUPS.map((g) => {
            const tiles = visible.filter((t) => groupOf(PROGRAMS[t.program]) === g.key);
            if (!tiles.length) return null;
            return (
              <div key={g.key} className="space-y-2">
                {filter === "all" && (
                  <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-widest text-mist/50">
                    <span className="w-2 h-2 rounded-full" style={{ background: GROUP_STYLE[g.key].bg }} />
                    {g.label} <span className="text-mist/35 tabular-nums">{tiles.length}</span>
                  </div>
                )}
                <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {tiles.map((t) => (
                    <PartnerTile key={t.program} t={t} points={usable} open={openProgram === t.program}
                      holding={holdings.get(t.program)} better={betterIndirect(spec, t.program, usable)}
                      onClick={() => onOpen(openProgram === t.program ? null : t.program)} />
                  ))}
                </div>
                {open && groupOf(PROGRAMS[open.program]) === g.key && (
                  <PartnerDetail card={card} t={open} wallet={wallet} points={usable} onClose={() => onOpen(null)} />
                )}
              </div>
            );
          })}

          {twoStep.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs uppercase tracking-widest text-mist/50 font-semibold">Reachable in two steps</h4>
              <p className="text-xs text-mist/55">
                Programs this card reaches best through a real onward move (Avios between airlines, or Marriott
                into airline miles), either because there&apos;s no direct transfer or because two steps beat it.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {twoStep.map((p) => (
                  <TwoStepRow key={p.hops[1].program} path={p} points={usable}
                    direct={partners.find((t) => t.program === p.hops[1].program)} />
                ))}
              </div>
            </div>
          )}

          <details className="group rounded-xl border border-wire bg-ink px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-mist/75 list-none flex items-center justify-between">
              Caps, fees and sources
              <span className="text-mist/40 group-open:rotate-180 transition-transform">⌄</span>
            </summary>
            <ul className="mt-3 space-y-1.5 text-sm text-mist/70 list-disc pl-5">
              {spec.rules.map((r) => <li key={r}>{r}</li>)}
            </ul>
            <div className="mt-3 pt-3 border-t border-wire space-y-1 text-xs text-mist/55">
              {spec.sources.map((s) => (
                <div key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gold">
                    {s.label}
                  </a>
                  {s.date ? ` · ${fmtDate(s.date)}` : " · undated"}
                </div>
              ))}
              <div>Checked {fmtDate(spec.checked_on)}</div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-raised/60 px-3 py-2">
      <div className="text-2xs text-mist/55">{label}</div>
      <div className="font-serif text-xl font-semibold text-mist tabular-nums">{value}</div>
    </div>
  );
}

function PartnerTile({ t, points, open, holding, better, onClick }: {
  t: CardTransfer; points: number; open: boolean; holding?: number; better: Path | null; onClick: () => void;
}) {
  const p = PROGRAMS[t.program];
  return (
    <button onClick={onClick} aria-expanded={open}
      className={`text-left rounded-xl border p-3 flex items-center gap-3 transition-all ${
        open ? "border-gold bg-gold/5 shadow-glow-gold" : "border-wire bg-ink hover:border-rim hover:bg-hover/40"}`}>
      <Monogram program={t.program} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-mist truncate">{p.name}</span>
          {t.disputed && <span className="text-amber text-xs font-bold" title={t.disputed}>?</span>}
        </div>
        <div className="text-xs text-mist/55 tabular-nums truncate">
          → <span className="text-mist/85 font-medium">{fmtNum(convert(points, t.ratio))}</span> {p.unit}
        </div>
        {better && (
          <div className="text-2xs text-gold font-semibold">
            ↑ Better via {PROGRAMS[better.hops[0].program].name}
          </div>
        )}
        {holding !== undefined && (
          <div className="text-2xs text-emerald font-medium tabular-nums">You hold {fmtNum(holding)}</div>
        )}
      </div>
      <RatioPill ratio={t.ratio} />
    </button>
  );
}

function PartnerDetail({ card, t, wallet, points, onClose }: {
  card: WalletCard; t: CardTransfer; wallet: WalletCard[]; points: number; onClose: () => void;
}) {
  const p = PROGRAMS[t.program];
  const others = wallet
    .filter((c) => c.product_key !== card.product_key)
    .map((c) => ({ c, path: pathsTo(c.spec, t.program, 10000)[0] }))
    .filter((x): x is { c: WalletCard; path: Path } => !!x.path)
    .map((x) => ({ ...x, units: convertAlong(10000, x.path, x.c.spec) }))
    .sort((a, b) => b.units - a.units);
  const routes = ROUTES.filter((r) => r.target === t.program);
  const groupLabel = PROGRAM_GROUPS.find((x) => x.key === groupOf(p))?.label;
  const better = betterIndirect(card.spec, t.program, points);

  // Bring the panel into view when it opens — from the grid at the bottom of
  // the page it would otherwise open off-screen.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [t.program, card.product_key]);

  return (
    <div ref={ref} className="rounded-xl border border-gold/40 bg-gold/5 p-4 space-y-3 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Monogram program={t.program} size="lg" />
          <div>
            <div className="font-serif text-lg font-semibold text-mist">{p.name}</div>
            <div className="text-xs text-mist/55">{groupLabel}{t.group ? ` · Axis ${t.group}` : ""}{t.time ? ` · ${t.time}` : ""}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-mist/40 hover:text-mist text-lg leading-none" aria-label="Close">×</button>
      </div>

      <div className="text-sm text-mist/80">
        {fmtNum(points)} {card.short} points at <RatioPill ratio={t.ratio} /> →{" "}
        <span className="font-semibold text-emerald tabular-nums">{fmtNum(convert(points, t.ratio))}</span> {p.unit}
      </div>
      {better && (
        <div className="rounded-lg border border-gold/40 bg-surface px-3 py-2 text-sm text-mist/80">
          <span className="font-semibold text-gold">Better route: </span>
          move to {PROGRAMS[better.hops[0].program].name} at {fmtRatio(better.hops[0].ratio)}, then on to{" "}
          {p.name} at {fmtRatio(better.hops[1].ratio)} →{" "}
          <span className="font-semibold text-emerald tabular-nums">{fmtNum(convertAlong(points, better))}</span> {p.unit}.{" "}
          <span className="text-mist/55">{better.hops[1].note}.</span>
        </div>
      )}
      {t.note && <p className="text-sm text-mist/70">{t.note}</p>}
      {t.disputed && <p className="text-sm text-amber"><span className="font-semibold">Sources disagree: </span>{t.disputed}</p>}

      {others.length > 0 && (
        <div className="text-xs text-mist/65">
          <div className="font-semibold text-mist/75 mb-1">Your other cards, per 10,000 points</div>
          <div className="flex flex-wrap gap-1.5">
            {others.map(({ c, path, units }) => (
              <span key={c.product_key} className="inline-flex items-center gap-1.5 rounded-lg bg-surface border border-wire px-2 py-1">
                <CardSwatch card={c} />{c.short}
                <span className="font-semibold tabular-nums text-mist/85">{fmtNum(units)}</span>
                {path.hops.length > 1 && <span className="text-mist/45">via {PROGRAMS[path.hops[0].program].name}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {routes.map((r) => (
        <div key={r.id} className="text-xs text-mist/70">
          <span className="font-semibold text-gold">Best use: </span>{r.title}. {r.why}
        </div>
      ))}
    </div>
  );
}

function TwoStepRow({ path, points, direct }: { path: Path; points: number; direct?: CardTransfer }) {
  const [first, second] = path.hops;
  return (
    <div className="rounded-xl border border-dashed border-rim bg-ink p-3 flex items-center gap-2 flex-wrap" title={second.note}>
      <Monogram program={first.program} size="sm" />
      <RatioPill ratio={first.ratio} />
      <span className="text-mist/30" aria-hidden>→</span>
      <Monogram program={second.program} size="sm" />
      <RatioPill ratio={second.ratio} />
      <span className="text-sm text-mist/85 font-medium">{PROGRAMS[second.program].name}</span>
      <span className="ml-auto text-right text-xs text-mist/55 tabular-nums">
        → {fmtNum(convertAlong(points, path))} {PROGRAMS[second.program].unit}
        {direct && (
          <span className="block text-2xs text-gold font-semibold">
            beats direct {fmtRatio(direct.ratio)} ({fmtNum(convert(points, direct.ratio))})
          </span>
        )}
      </span>
    </div>
  );
}
