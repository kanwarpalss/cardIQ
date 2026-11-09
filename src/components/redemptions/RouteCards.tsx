"use client";

// "Best routes": curated places card points are worth the most. For each one
// the screen picks the best way from KP's own cards (direct or via a real
// bridge) and draws the chain, so the advice is about HIS wallet, not a blog's.

import { useMemo, useState } from "react";
import { fmtNum } from "@/lib/format";
import { PROGRAMS, type ProgramKey } from "@/lib/transfer-partners/programs";
import { ROUTES, type Route, type RouteTag } from "@/lib/transfer-partners/routes";
import { pathsTo, convertAlong, type Path } from "@/lib/transfer-partners/math";
import { Monogram, RatioPill, CardSwatch, type WalletCard } from "./transfer-ui";

const TAGS: ("All" | RouteTag)[] = ["All", "Premium cabins", "Cheap economy", "Hotel nights", "Bridge"];
const SAMPLE = 10000;

type Ranked = { card: WalletCard; path: Path; units: number };

function rankFor(route: Route, wallet: WalletCard[]): Ranked[] {
  const out: Ranked[] = [];
  for (const card of wallet) {
    const path = pathsTo(card.spec, route.target, SAMPLE)[0];
    if (path) out.push({ card, path, units: convertAlong(SAMPLE, path, card.spec) });
  }
  return out.sort((a, b) => b.units - a.units || a.path.hops.length - b.path.hops.length);
}

function Arrow() {
  return (
    <svg className="w-5 h-3 text-mist/30 shrink-0" viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path d="M1 6h16M13 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chain({ best }: { best: Ranked }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-2 py-1 text-xs font-medium text-mist/85">
        <CardSwatch card={best.card} />{best.card.short}
      </span>
      {best.path.hops.map((h, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-px w-3 bg-mist/30" />
          <RatioPill ratio={h.ratio} title={h.note} />
          <Arrow />
          <span className="inline-flex items-center gap-1.5">
            <Monogram program={h.program} size="sm" />
            <span className="text-xs font-medium text-mist/85">{PROGRAMS[h.program].name}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

function RouteCard({ route, ranked, holding }: { route: Route; ranked: Ranked[]; holding?: number }) {
  const best = ranked[0];
  const target = PROGRAMS[route.target];
  return (
    <article className={`rounded-2xl border bg-surface p-5 shadow-card flex flex-col gap-3 ${
      best ? "border-rim" : "border-dashed border-rim opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Monogram program={route.target} size="lg" />
          <div className="min-w-0">
            <div className="text-2xs uppercase tracking-widest text-gold font-semibold">{route.tag}</div>
            <h4 className="font-serif text-base font-semibold text-mist leading-snug">{route.title}</h4>
            <div className="text-xs text-mist/55 mt-0.5">{route.book}</div>
            {holding !== undefined && (
              <span className="inline-block mt-1.5 rounded-full bg-emerald/10 border border-emerald/30 text-emerald text-2xs font-semibold px-2 py-0.5"
                title="Logged under Miles & status">
                You hold {fmtNum(holding)} {target.unit}
              </span>
            )}
          </div>
        </div>
      </div>

      {best ? (
        <div className="rounded-xl bg-ink border border-wire p-3 space-y-2">
          <Chain best={best} />
          <div className="text-xs text-mist/70">
            <span className="font-semibold text-mist tabular-nums">{fmtNum(SAMPLE)}</span> {best.card.short} points →{" "}
            <span className="font-semibold text-emerald tabular-nums">{fmtNum(best.units)}</span> {target.unit}
            {best.path.hops.length > 1 && <span className="text-mist/45"> · two steps</span>}
          </div>
          {ranked.length > 1 && (
            <div className="text-2xs text-mist/50">
              Also:{" "}
              {ranked.slice(1).map((r, i) => (
                <span key={r.card.product_key}>
                  {i > 0 && " · "}{r.card.short} {fmtNum(r.units)}
                  {r.path.hops.length > 1 && ` via ${PROGRAMS[r.path.hops[0].program].name}`}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-ink border border-wire p-3 text-xs text-mist/55">
          None of your cards reach {target.name}.
        </div>
      )}

      <p className="text-sm text-mist/75 leading-relaxed"><span className="font-semibold text-mist">Why: </span>{route.why}</p>
      <p className="text-sm text-mist/75 leading-relaxed">
        <span className="font-semibold text-amber">Watch out: </span>{route.watch}
      </p>
      {route.source && (
        <a href={route.source.url} target="_blank" rel="noopener noreferrer"
          className="text-2xs text-mist/45 hover:text-gold underline underline-offset-2 mt-auto">
          Source: {route.source.label}
        </a>
      )}
    </article>
  );
}

export default function RouteCards({ wallet, holdings }: {
  wallet: WalletCard[]; holdings: Map<ProgramKey, number>;
}) {
  const [tag, setTag] = useState<(typeof TAGS)[number]>("All");

  const routes = useMemo(() => {
    const all = ROUTES.map((r) => ({ route: r, ranked: rankFor(r, wallet) }));
    // Routes your cards can reach come first; the curated order holds within each.
    return [...all.filter((x) => x.ranked.length), ...all.filter((x) => !x.ranked.length)];
  }, [wallet]);

  const shown = routes.filter((x) => tag === "All" || x.route.tag === tag);

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-serif text-xl font-semibold text-mist">Best routes for your cards</h3>
          <p className="text-sm text-mist/60 mt-0.5">
            Where points go furthest, and the best way to get there from the cards you hold.
          </p>
        </div>
        <div className="flex gap-1 flex-wrap">
          {TAGS.map((t) => (
            <button key={t} onClick={() => setTag(t)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                tag === t ? "bg-gold text-white border-gold" : "border-rim text-mist/60 hover:text-mist hover:bg-hover"}`}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {shown.map(({ route, ranked }) => (
          <RouteCard key={route.id} route={route} ranked={ranked} holding={holdings.get(route.target)} />
        ))}
      </div>
    </section>
  );
}
