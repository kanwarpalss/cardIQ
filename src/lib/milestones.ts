export type MonthDay = { month: number; day: number };

export type SpendWindow = {
  start: Date;
  endExclusive: Date;
};

export type MilestoneTxn = {
  card_last4: string;
  amount_inr: number | string | null;
  original_currency?: string | null;
  txn_at: string;
  txn_type: "debit" | "credit";
};

export const CALENDAR_YEAR_START: MonthDay = { month: 1, day: 1 };

function validMonthDay(value: MonthDay | undefined): MonthDay {
  if (!value || !Number.isInteger(value.month) || value.month < 1 || value.month > 12) {
    return CALENDAR_YEAR_START;
  }
  const max = new Date(2024, value.month, 0).getDate(); // leap-year validation
  if (!Number.isInteger(value.day) || value.day < 1 || value.day > max) {
    return CALENDAR_YEAR_START;
  }
  return value;
}

function monthDayFromDate(value: string | null | undefined): MonthDay | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year
    || candidate.getMonth() !== month - 1
    || candidate.getDate() !== day
  ) return null;
  return { month, day };
}

/** Build the card's current milestone spending year.
 *
 * The saved date contributes its month/day; its original year is deliberately
 * ignored so the same rule repeats every year. Invalid saved values fall back
 * to the card product's documented start, then to 1 January.
 */
export function currentMilestoneYear(
  savedStartDate: string | null | undefined,
  productDefault: MonthDay | undefined,
  now = new Date()
): SpendWindow {
  const startRule = monthDayFromDate(savedStartDate) ?? validMonthDay(productDefault);

  const inYear = (year: number): Date => {
    const maxDay = new Date(year, startRule.month, 0).getDate();
    return new Date(year, startRule.month - 1, Math.min(startRule.day, maxDay));
  };

  let start = inYear(now.getFullYear());
  if (now.getTime() < start.getTime()) start = inYear(now.getFullYear() - 1);
  return { start, endExclusive: inYear(start.getFullYear() + 1) };
}

export function currentCalendarMonth(now = new Date()): SpendWindow {
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    endExclusive: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  };
}

/** Sum milestone-eligible spend: positive INR debits for one card, with the
 * start included and the next period's first instant excluded. */
export function spendInWindow(
  transactions: MilestoneTxn[],
  cardLast4: string,
  window: SpendWindow,
  asOf = new Date()
): number {
  const periodEnd = window.endExclusive.getTime();
  const asOfTime = asOf.getTime();
  return transactions.reduce((sum, txn) => {
    if (txn.card_last4 !== cardLast4 || txn.txn_type !== "debit") return sum;
    if (txn.original_currency && txn.original_currency.trim().toUpperCase() !== "INR") return sum;
    const at = new Date(txn.txn_at).getTime();
    if (!Number.isFinite(at) || at < window.start.getTime() || at >= periodEnd || at > asOfTime) return sum;
    const amount = Number(txn.amount_inr);
    return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
}

/** YYYY-MM-DD in the user's local calendar, never shifted by UTC conversion. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function inclusiveWindowEnd(window: SpendWindow): Date {
  const end = new Date(window.endExclusive);
  end.setDate(end.getDate() - 1);
  return end;
}
