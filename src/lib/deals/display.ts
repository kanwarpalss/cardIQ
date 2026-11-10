// How a deal is worded on screen — shared by Rewards → Live deals and the
// Home panel, so the two can never describe the same deal differently.

import { fmtDate } from "@/lib/format";
import { PROGRAMS } from "@/lib/transfer-partners/programs";
import { BANK_NAMES } from "./manual";
import type { Assessment } from "./score";
import type { StoredDeal } from "./types";

/** "55%" + "bonus", or "50%" + "off". Null when the source gave no number. */
export function figureOf(d: Pick<StoredDeal, "bonus_pct" | "discount_pct">): { big: string; small: string } | null {
  if (d.discount_pct != null) return { big: `${d.discount_pct}%`, small: "off" };
  if (d.bonus_pct != null) return { big: `${d.bonus_pct}%`, small: "bonus" };
  return null;
}

/** The short time label on a row; `urgent` = ends within ENDING_SOON_DAYS. */
export function timeLeft(a: Pick<Assessment, "status" | "daysLeft">, d: Pick<StoredDeal, "ends_on">): { text: string; urgent: boolean } {
  if (a.status === "ended") return { text: d.ends_on ? `Ended ${fmtDate(d.ends_on)}` : "Probably over", urgent: false };
  if (a.status === "no_end_date") return { text: "No end date", urgent: false };
  if (a.daysLeft === 0) return { text: "Ends today", urgent: true };
  if (a.daysLeft === 1) return { text: "Ends tomorrow", urgent: true };
  return { text: `${a.daysLeft} days left`, urgent: a.status === "ending_soon" };
}

export function kindLine(d: Pick<StoredDeal, "kind" | "from_bank" | "from_program" | "from_other">): string {
  if (d.kind === "buy_points") return "Points sale";
  if (d.kind === "ratio_change") return "Partner change";
  const from = d.from_bank ? BANK_NAMES[d.from_bank] : d.from_program ? PROGRAMS[d.from_program].name : d.from_other;
  return from ? `Transfer bonus from ${from}` : "Transfer bonus";
}
