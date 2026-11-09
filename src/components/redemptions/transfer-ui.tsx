"use client";

// Shared pieces for the Transfer partners screen: the wallet model (KP's cards
// collapsed to one entry per product, since two cards of the same product
// reach the same partners) and the small visual atoms reused by the snapshot,
// the routes and the grid.

import { CARD_REGISTRY } from "@/lib/cards/registry";
import { getCardArt } from "@/lib/card-art";
import { latestBalanceByCard } from "@/lib/perks";
import type { RedemptionsData } from "@/lib/redemptions-data";
import { PROGRAMS, groupOf, type Alliance, type ProgramKey, type Ratio } from "@/lib/transfer-partners/programs";
import { TRANSFER_SPECS, type TransferSpec } from "@/lib/transfer-partners/cards";
import { fmtRatio, matchProgram, strength, type Strength } from "@/lib/transfer-partners/math";

export type WalletCard = {
  product_key: string;
  name: string;
  /** Short label for tight spaces (grid headers, route chips). */
  short: string;
  issuer: string;
  last4s: string[];
  currency: string;
  spec: TransferSpec;
  /** Latest saved point balance on any card of this product, if one exists. */
  balance: { amount: number; as_of: string; last4: string } | null;
  gradient: string;
};

const SHORT: Record<string, string> = {
  axis_magnus_burgundy: "Magnus Burgundy",
  hdfc_infinia: "Infinia",
  hdfc_swiggy: "Swiggy",
  icici_emeralde_private_metal: "Emeralde PM",
  hsbc_premier: "HSBC Premier",
  hsbc_travelone: "TravelOne",
  amex_platinum_travel: "Plat Travel",
};

export function buildWallet(data: RedemptionsData): WalletCard[] {
  const latest = latestBalanceByCard(data.rewards);
  const byProduct = new Map<string, WalletCard>();
  for (const c of data.cards) {
    const spec = TRANSFER_SPECS[c.product_key];
    const reg = CARD_REGISTRY[c.product_key];
    if (!spec || !reg) continue;
    let w = byProduct.get(c.product_key);
    if (!w) {
      w = {
        product_key: c.product_key,
        name: reg.display_name,
        short: SHORT[c.product_key] ?? reg.display_name,
        issuer: reg.issuer,
        last4s: [],
        currency: reg.rewards?.program ?? "Reward points",
        spec,
        balance: null,
        gradient: getCardArt(c.product_key).gradient,
      };
      byProduct.set(c.product_key, w);
    }
    w.last4s.push(c.last4);
    const b = latest.get(c.id);
    if (b && (!w.balance || b.as_of > w.balance.as_of)) {
      w.balance = { amount: Number(b.balance), as_of: b.as_of, last4: c.last4 };
    }
  }
  return [...byProduct.values()];
}

/** Airline/hotel balances already logged under Miles & status, by program. */
export function holdingsByProgram(data: RedemptionsData): Map<ProgramKey, number> {
  const m = new Map<ProgramKey, number>();
  for (const row of data.loyalty) {
    const key = matchProgram(row.program_name);
    const bal = Number(row.points_balance);
    if (key && Number.isFinite(bal) && bal > 0) m.set(key, (m.get(key) ?? 0) + bal);
  }
  return m;
}

// ── Visual atoms ────────────────────────────────────────────────────────────

/** Colours per group. Labels live in PROGRAM_GROUPS, not here. */
export const GROUP_STYLE: Record<Alliance | "hotel", { bg: string; fg: string; ring: string }> = {
  star:     { bg: "#2a2d33", fg: "#f5f1e8", ring: "rgba(42,45,51,0.25)" },
  oneworld: { bg: "#3d3a8c", fg: "#f1efff", ring: "rgba(61,58,140,0.25)" },
  skyteam:  { bg: "#1f6aa8", fg: "#eef6ff", ring: "rgba(31,106,168,0.25)" },
  none:     { bg: "#8a6a3a", fg: "#fff8ec", ring: "rgba(138,106,58,0.25)" },
  hotel:    { bg: "#178a5c", fg: "#effcf5", ring: "rgba(23,138,92,0.25)" },
};

export function Monogram({ program, size = "md" }: { program: ProgramKey; size?: "sm" | "md" | "lg" }) {
  const p = PROGRAMS[program];
  const g = GROUP_STYLE[groupOf(p)];
  const dims = size === "sm" ? "w-7 h-7 text-[9px]" : size === "lg" ? "w-12 h-12 text-xs" : "w-9 h-9 text-[10px]";
  return (
    <span aria-hidden
      className={`${dims} shrink-0 rounded-full inline-flex items-center justify-center font-bold tracking-wide`}
      style={{ background: g.bg, color: g.fg, boxShadow: `0 0 0 3px ${g.ring}` }}>
      {p.code}
    </span>
  );
}

const STRENGTH_STYLE: Record<Strength, string> = {
  strong: "bg-emerald/10 text-emerald border-emerald/30",
  good:   "bg-sapphire/10 text-sapphire border-sapphire/30",
  fair:   "bg-amber/10 text-amber border-amber/30",
  weak:   "bg-mist/5 text-mist/55 border-rim",
};

export const STRENGTH_LABEL: Record<Strength, string> = {
  strong: "1:1 or better", good: "Good", fair: "Fair", weak: "Weak",
};

/** Ratio badge. The ratio text itself carries the meaning; colour only
 *  reinforces it, so it still reads in black and white. */
export function RatioPill({ ratio, best, title }: { ratio: Ratio; best?: boolean; title?: string }) {
  return (
    <span title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${STRENGTH_STYLE[strength(ratio)]} ${
        best ? "ring-2 ring-gold/50 ring-offset-1 ring-offset-surface" : ""}`}>
      {fmtRatio(ratio)}
      {best && <span className="text-gold" aria-label="best in your wallet">★</span>}
    </span>
  );
}

export function CardSwatch({ card, className = "" }: { card: WalletCard; className?: string }) {
  return (
    <span aria-hidden className={`inline-block w-6 h-4 rounded-[4px] border border-black/10 shrink-0 ${className}`}
      style={{ background: card.gradient }} />
  );
}
