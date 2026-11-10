// Card reward-point balances read from KP's own statement PDFs (the text the
// statements pipeline already extracted into ~/.cardiq-statements/text).
//
// Checked against the October 2026 statements:
//   Axis Magnus  — "eDGE REWARD POINTS | BALANCE AS ON DATE | CUSTOMER ID",
//                  then a row "765241 | 15-10-2026 | <customer id> | …"
//   HDFC Infinia — "Opening Balance | Feature + Bonus Reward | Disbursed |
//                  Adjusted/Lapsed", a row of those four figures, then the
//                  closing balance on its own row. Opening + earned −
//                  disbursed − lapsed must equal the closing figure, or the
//                  reading is refused.
// ICICI prints only points earned that cycle (no balance), Swiggy is
// cashback, and HSBC's statements haven't been unlocked — so those cards
// have no statement balance, and the screen says so rather than guessing.

import { parsePoints } from "./loyalty-emails";

export type StatementRow = string; // cells joined with " | "

export type StatementBalance = {
  /** Last 4 digits of the card the statement is for. */
  last4: string;
  balance: number;
  /** YYYY-MM-DD the statement states the balance as of. */
  as_of: string;
};

const cells = (r: string) => r.split("|").map((c) => c.trim());

/** "15-10-2026" → "2026-10-15". */
function dmy(s: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
}

/** "15 Oct, 2026" → "2026-10-15". */
function dMonY(s: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})/.exec(s);
  if (!m) return null;
  const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase()) + 1;
  if (!mon) return null;
  const iso = `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
}

/** Axis: last4 comes from the subject ("…Statement ending XX55 - Oct…") —
 *  only two digits, so the caller matches it against KP's Axis cards. */
export function readAxisPoints(rows: StatementRow[]): { balance: number; as_of: string } | null {
  const head = rows.findIndex((r) => /eDGE REWARD\s*\|\s*BALANCE AS/i.test(r));
  if (head < 0) return null;
  for (const r of rows.slice(head + 1, head + 6)) {
    const c = cells(r);
    if (c.length >= 2 && /^\d+$/.test(c[0])) {
      const as_of = dmy(c[1]);
      const balance = parsePoints(c[0]);
      if (as_of && balance != null) return { balance, as_of };
    }
  }
  return null;
}

/** HDFC: the summary table plus its own arithmetic check. */
export function readHdfcPoints(rows: StatementRow[]): StatementBalance | null {
  const card = rows.map((r) => /\b\d{6}X{6}(\d{4})\b/.exec(r)).find(Boolean);
  const dateRow = rows.find((r) => /^Statement Date\s*\|/i.test(r));
  const as_of = dateRow ? dMonY(cells(dateRow)[1] ?? "") : null;
  const head = rows.findIndex((r) => /^Opening Balance\s*\|\s*Feature \+ Bonus Reward/i.test(r));
  if (!card || !as_of || head < 0) return null;
  for (let i = head + 1; i < Math.min(rows.length - 1, head + 6); i++) {
    const four = cells(rows[i]).map(parsePoints);
    if (four.length !== 4 || four.some((n) => n == null)) continue;
    const closing = cells(rows[i + 1]);
    if (closing.length !== 1) return null;
    const total = parsePoints(closing[0]);
    const [open, earned, disbursed, lapsed] = four as number[];
    if (total == null || open + earned - disbursed - lapsed !== total) return null;
    return { last4: card[1], balance: total, as_of };
  }
  return null;
}
