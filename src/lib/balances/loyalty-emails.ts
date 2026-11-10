// Read KP's current balance out of the loyalty programs' own emails.
//
// No airline or hotel program offers a personal-balance API (AwardWallet's
// is for businesses), and logging into program sites with KP's passwords is
// off the table. Four programs do state the balance in their email text,
// checked against real mail on 10 Nov 2026:
//   Hilton      — every email's header: "Silver Member #… 21,315 Points"
//   KrisFlyer   — monthly "Account Statement": "AS OF 01 Oct 2026 31485 CURRENT KRISFLYER MILES"
//   Qatar       — monthly statement: "Your Avios 3,514 … Balance as of 28 October 2026"
//   Club ITC    — monthly "Account Summary": opening / earned / redeemed / closing
// Marriott and Accor put the balance only in images, so they stay manual.
//
// Each reader is deliberately narrow: it returns nothing rather than a guess
// when the text doesn't match its known layout.

import type { ProgramKey } from "@/lib/transfer-partners/programs";

export type LoyaltyReading = {
  program: ProgramKey;
  balance: number;
  /** YYYY-MM-DD the email says the balance is as of (or the email's date). */
  as_of: string;
  tier: string | null;
};

export type LoyaltyReader = {
  program: ProgramKey;
  /** Gmail search for this program's balance-bearing emails. */
  query: string;
  read: (text: string, emailDate: string) => LoyaltyReading | null;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "01 Oct 2026", "28 October 2026", "31st OCTOBER'26" → "2026-10-31". */
export function parseDayMonthYear(s: string): string | null {
  // Four-digit year first: "(\d{2}|\d{4})" would read "2026" as "20".
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s*(?:'|’)?\s*(\d{4}|\d{2})(?!\d)/i.exec(s);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  const day = Number(m[1]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (!month || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
}

/** "21,315" / "3,514" / "31485" / "3580.00" → whole points, or null. */
export function parsePoints(s: string): number | null {
  const clean = s.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n) : null;
}

const squash = (t: string) => t.replace(/\s+/g, " ");
const day = (iso: string) => iso.slice(0, 10);

export const LOYALTY_READERS: LoyaltyReader[] = [
  {
    program: "hilton",
    query: "from:h5.hilton.com",
    read(text, emailDate) {
      const m = /(?:\b(Silver|Gold|Diamond|Lifetime Diamond)\s+)?\bMember\s+#\s*\d+[^\d]{0,12}([\d,]+)\s+Points\b/i.exec(squash(text));
      const balance = m ? parsePoints(m[2]) : null;
      if (balance == null) return null;
      const tier = m![1] ?? null;
      return { program: "hilton", balance, as_of: day(emailDate), tier };
    },
  },
  {
    program: "krisflyer",
    query: 'from:singaporeair.com subject:"KrisFlyer Account Statement"',
    read(text) {
      const m = /ACCOUNT SUMMARY\s*AS OF\s+(\d{1,2}\s+[a-z]{3,9}\s+\d{4})\s*([\d,]+)\s*CURRENT KRISFLYER MILES/i.exec(squash(text));
      const as_of = m ? parseDayMonthYear(m[1]) : null;
      const balance = m ? parsePoints(m[2]) : null;
      return as_of && balance != null ? { program: "krisflyer", balance, as_of, tier: null } : null;
    },
  },
  {
    program: "qatar_avios",
    query: 'from:qatarairways.com subject:"monthly statement"',
    read(text) {
      const t = squash(text);
      const m = /Your Avios\s+([\d,]+)\b/i.exec(t);
      const d = /Balance as of\s+(\d{1,2}\s+[a-z]{3,9}\s+\d{4})/i.exec(t);
      const balance = m ? parsePoints(m[1]) : null;
      const as_of = d ? parseDayMonthYear(d[1]) : null;
      const tier = /Privilege Club\s+(Burgundy|Silver|Gold|Platinum)\b/i.exec(t)?.[1] ?? null;
      return balance != null && as_of ? { program: "qatar_avios", balance, as_of, tier } : null;
    },
  },
  {
    program: "club_itc",
    query: 'from:itc-hotels.net subject:"Account Summary"',
    read(text) {
      const t = squash(text);
      const d = /ACCOUNT SUMMARY AS ON\s+([^()]{6,24}?)\s*\(/i.exec(t);
      const m = /CLOSING BALANCE\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/i.exec(t);
      if (!d || !m) return null;
      const [open, earned, used, closing] = m.slice(1, 5).map(parsePoints);
      const as_of = parseDayMonthYear(d[1]);
      // The four columns must add up, so a shifted table can't pass as a balance.
      if (open == null || earned == null || used == null || closing == null || !as_of) return null;
      if (open + earned - used !== closing) return null;
      const tier = /\bTIER\s+([A-Za-z]+)\b/.exec(t)?.[1] ?? null;
      return { program: "club_itc", balance: closing, as_of, tier };
    },
  },
];

// ── Updating loyalty_accounts ────────────────────────────────────────────────

export type LoyaltyRowLite = {
  id: string;
  program_key: ProgramKey | null;
  points_balance: number | null;
  /** When the saved balance was last set (manual edits or a previous read). */
  updated_at: string;
};

export type LoyaltyPlan =
  | { action: "insert"; reading: LoyaltyReading }
  | { action: "update"; id: string; reading: LoyaltyReading }
  | { action: "keep"; id: string; reason: string };

/**
 * Apply a reading only if it is newer than what's saved. A balance KP typed
 * in after the email arrived wins; so does a newer read. A program with no
 * row yet gets one, so a balance the emails state is never just dropped.
 */
export function planLoyaltyUpdate(r: LoyaltyReading, rows: LoyaltyRowLite[]): LoyaltyPlan {
  const row = rows.find((x) => x.program_key === r.program);
  if (!row) return { action: "insert", reading: r };
  const saved = Date.parse(row.updated_at);
  const read = Date.parse(`${r.as_of}T23:59:59Z`);
  if (Number.isFinite(saved) && saved >= read) {
    return { action: "keep", id: row.id, reason: `saved balance (${row.updated_at.slice(0, 10)}) is as new or newer` };
  }
  // Same figure or not, the newer date is worth saving: it is what tells the
  // screen how fresh the balance is.
  return { action: "update", id: row.id, reading: r };
}
