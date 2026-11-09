"use client";

// Every program any of KP's cards reaches, against every card, in one table.
// Rows group by alliance; the best ratio in each row gets a star. Hovering a
// row or column highlights it so a single program or card is easy to follow.

import { useMemo, useState } from "react";
import { PROGRAMS, PROGRAM_GROUPS, groupOf, type ProgramKey } from "@/lib/transfer-partners/programs";
import { rate } from "@/lib/transfer-partners/math";
import { Monogram, RatioPill, CardSwatch, GROUP_STYLE, STRENGTH_LABEL, type WalletCard } from "./transfer-ui";

export default function PartnerGrid({ wallet, onPick }: {
  wallet: WalletCard[];
  onPick: (product_key: string, program: ProgramKey) => void;
}) {
  const [hoverRow, setHoverRow] = useState<ProgramKey | null>(null);
  const [hoverCol, setHoverCol] = useState<string | null>(null);

  const groups = useMemo(() => {
    const reached = new Set<ProgramKey>();
    for (const c of wallet) for (const t of c.spec.partners) reached.add(t.program);
    return PROGRAM_GROUPS.map((g) => ({
      ...g,
      rows: [...reached]
        .filter((k) => groupOf(PROGRAMS[k]) === g.key)
        .sort((a, b) => PROGRAMS[a].name.localeCompare(PROGRAMS[b].name)),
    })).filter((g) => g.rows.length);
  }, [wallet]);

  if (!wallet.length) return null;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-serif text-xl font-semibold text-mist">All partners at a glance</h3>
        <p className="text-sm text-mist/60 mt-0.5">
          Card points on the left of each ratio, partner miles or points on the right. ★ marks your best card for
          that program. Click any ratio to open it in the card view above.
        </p>
      </div>

      <div className="flex gap-3 flex-wrap text-2xs text-mist/60">
        {(["strong", "good", "fair", "weak"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <RatioPill ratio={s === "strong" ? { from: 1, to: 1 } : s === "good" ? { from: 5, to: 4 } : s === "fair" ? { from: 2, to: 1 } : { from: 5, to: 2 }} />
            {STRENGTH_LABEL[s]}
          </span>
        ))}
      </div>

      <div className="rounded-2xl border border-rim bg-surface shadow-card overflow-x-auto">
        <table className="w-full text-sm border-collapse" onMouseLeave={() => { setHoverRow(null); setHoverCol(null); }}>
          <thead>
            <tr className="border-b border-wire">
              <th className="sticky left-0 z-10 bg-surface text-left font-medium text-2xs uppercase tracking-widest text-mist/45 px-4 py-3 min-w-[200px]">
                Program
              </th>
              {wallet.map((c) => (
                <th key={c.product_key} onMouseEnter={() => setHoverCol(c.product_key)}
                  className={`px-3 py-3 text-center font-medium min-w-[104px] transition-colors ${
                    hoverCol === c.product_key ? "bg-gold/5" : ""}`}>
                  <span className="inline-flex flex-col items-center gap-1">
                    <CardSwatch card={c} className="w-8 h-5" />
                    <span className="text-xs text-mist/80 leading-tight">{c.short}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupRows key={g.key} label={g.label}
                color={GROUP_STYLE[g.key].bg} rows={g.rows} wallet={wallet}
                hoverRow={hoverRow} hoverCol={hoverCol}
                onHover={(r, c) => { setHoverRow(r); setHoverCol(c); }} onPick={onPick} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GroupRows({ label, color, rows, wallet, hoverRow, hoverCol, onHover, onPick }: {
  label: string; color: string; rows: ProgramKey[]; wallet: WalletCard[];
  hoverRow: ProgramKey | null; hoverCol: string | null;
  onHover: (row: ProgramKey, col: string | null) => void;
  onPick: (product_key: string, program: ProgramKey) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={wallet.length + 1} className="sticky left-0 bg-raised/60 px-4 py-1.5">
          <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-widest text-mist/60">
            <span className="w-2 h-2 rounded-full" style={{ background: color }} />{label}
          </span>
        </td>
      </tr>
      {rows.map((k) => {
        const cells = wallet.map((c) => c.spec.partners.find((t) => t.program === k));
        const bestRate = Math.max(...cells.map((t) => (t ? rate(t.ratio) : 0)));
        return (
          <tr key={k} className={`border-t border-wire transition-colors ${hoverRow === k ? "bg-gold/5" : ""}`}>
            <td className="sticky left-0 z-10 bg-surface px-4 py-2" onMouseEnter={() => onHover(k, null)}>
              <span className="inline-flex items-center gap-2.5">
                <Monogram program={k} size="sm" />
                <span className="text-sm text-mist/85">{PROGRAMS[k].name}</span>
              </span>
            </td>
            {cells.map((t, i) => {
              const c = wallet[i];
              return (
                <td key={c.product_key} onMouseEnter={() => onHover(k, c.product_key)}
                  className={`px-3 py-2 text-center ${hoverCol === c.product_key ? "bg-gold/5" : ""}`}>
                  {t ? (
                    <button onClick={() => onPick(c.product_key, k)}
                      aria-label={`${c.short} to ${PROGRAMS[k].name}`}
                      className="inline-flex items-center gap-1 hover:scale-105 transition-transform">
                      <RatioPill ratio={t.ratio}
                        best={rate(t.ratio) === bestRate && wallet.length > 1}
                        title={t.disputed ? `Sources disagree: ${t.disputed}` : undefined} />
                      {t.disputed && <span className="text-amber text-xs" title={t.disputed}>?</span>}
                    </button>
                  ) : (
                    <span className="text-mist/20" aria-label="not a partner">—</span>
                  )}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
