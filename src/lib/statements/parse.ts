// Reads card-statement text (lines of positioned cells, from scripts/statements-unlock.ts)
// into individual statement lines, and proves the read is complete.
//
// The proof is the statement's own arithmetic: previous balance − credits + debits
// must equal the printed total due. If one line is missed, misread or read twice,
// the equation fails and the statement is marked unreconciled — nothing from an
// unreconciled statement should be trusted to add or change transactions.

export type Cell = { x: number; s: string };
export type Line = { y: number; cells: Cell[] };
export type StatementDoc = {
  uid: number;
  gmail_id: string | null;
  family: string;
  subject: string | null;
  /** When the statement email arrived (ISO). */
  date: string | null;
  pages: Line[][];
};

export type LineKind = "purchase" | "refund" | "payment" | "fee" | "fee_reversal" | "cashback" | "emi" | "other_credit";

export type StatementLine = {
  /** YYYY-MM-DD as printed. */
  date: string;
  description: string;
  /** First descriptive cell: the merchant as the bank wrote it. */
  merchant: string;
  /** Rupees billed, always positive. */
  amount: number;
  direction: "debit" | "credit";
  kind: LineKind;
  foreign: { currency: string; amount: number } | null;
  /** Last 4 of the card this line is printed under, when the statement says. */
  cardLast4: string | null;
  page: number;
};

export type TieOut = {
  ok: boolean;
  debits: number;
  credits: number;
  previous: number | null;
  totalDue: number | null;
  /**
   * "exact" (to the paisa), "rounded" (bank printed a rounded total, ±₹1), or
   * "empty" (no lines read, so nothing to prove: harmless, as nothing gets added).
   */
  how: "exact" | "rounded" | "empty" | null;
};

export type ParsedStatement = { lines: StatementLine[]; tie: TieOut; cardLast4s: string[] };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CURRENCIES = "USD|EUR|GBP|CHF|SGD|AED|THB|JPY|AUD|CAD|HKD|MYR|NZD|SAR|QAR|OMR|MUR|LKR|IDR|VND|KRW|CNY|SEK|NOK|DKK|ZAR|TRY|PHP";
const FOREIGN_RE = new RegExp(`\\b(${CURRENCIES})\\s*([\\d,]+(?:\\.\\d{1,2})?)\\b`);
// ICICI's PDF font renders the rupee sign as a backtick.
const MONEY_RE = /^(?:Rs\.?|₹|INR|`)?\s*(-)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)\s*(Cr|CR|Dr|DR)?$/;
const CARD_RE = /\b(?:\d{4}\s?[\dXx*]{2}[Xx*]{2}\s?[Xx*]{4}\s?|\d{1,6}[Xx*]{6,12}|[Xx*]{4}[\s-]?[Xx*]{4}[\s-]?[Xx*]{4}[\s-]?|[Xx]{2}\s[Xx]{4}\s|[Xx]{2,})(\d{4})\b/;

/** Rupees from a printed amount ("1,23,456.70", "Rs.-2957.90", "450.00 Cr"); null if not money. */
export function parseMoney(raw: string): { value: number; sign: 1 | -1; marker: "cr" | "dr" | null } | null {
  const m = raw.trim().match(MONEY_RE);
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const marker = m[3] ? (m[3].toLowerCase() as "cr" | "dr") : null;
  return { value, sign: m[1] ? -1 : 1, marker };
}

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Pulls the transaction date off the start of a line. Citi prints DD/MM with no
 * year, so the year comes from the statement date: a month later than the
 * statement's month belongs to the previous year.
 */
export function leadingDate(text: string, family: string, statementDate: string | null): { date: string; rest: string } | null {
  let m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?:\s*\|?\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*\|?\s*/);
  if (m && family !== "citi") {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const date = isoDate(year, Number(m[2]), Number(m[1]));
    return date ? { date, rest: text.slice(m[0].length) } : null;
  }
  m = text.match(/^(\d{1,2})[ -](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ ,-]+(\d{4}|\d{2})\b\s*\|?\s*/i);
  if (m && family !== "citi") {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const date = isoDate(year, MONTHS[m[2].toLowerCase()], Number(m[1]));
    return date ? { date, rest: text.slice(m[0].length) } : null;
  }
  if (family === "citi" && statementDate) {
    m = text.match(/^(\d{2})\/(\d{2})\s*\|\s*/);
    if (!m) return null;
    const sy = Number(statementDate.slice(0, 4));
    const sm = Number(statementDate.slice(5, 7));
    const month = Number(m[2]);
    const date = isoDate(month > sm ? sy - 1 : sy, month, Number(m[1]));
    return date ? { date, rest: text.slice(m[0].length) } : null;
  }
  return null;
}

// Bank payment lines say "PAYMENT"; "FLIPKART PAYMENTS" or "Razorpay PaymentsBENGALURU"
// is a merchant's legal name, and a credit from it is a refund.
const PAYMENT_RE = /\bpayment\b|pymt|pymnt|\bbbps\b|\bneft\b|\bimps\b|autopay|auto debit|transfer - ca|tele transfer credit|\be ?pay [a-z]*\d|visa direct|\bcc pay|bill ?desk|cred club/i;
// Converting a purchase to EMI credits it back and then bills monthly instalments.
// The original purchase is the real spend, so both sides are bookkeeping.
const EMI_RE = /offus emi|prin nb:|aggregator\W?emi|emi conversion|emi principal|emi interest|emi\W+prin|,\s?P:\d{2},/i;
// Whole words only: "KOFFEES" and "PINTEREST" are merchants. A fee a merchant bills
// (baggage, visa application, convenience) is a purchase from that merchant.
const FEE_RE = /\bfees?\b|\b[ics]?gst\b|\btax\b|\binterest|finance charge|surcharge|late charge|markup|mark-up|\bcharges?\b/i;
const MERCHANT_FEE_RE = /baggage|visa fee|\bvfs\b|convenience fee|application fee/i;
const CASHBACK_RE = /cash ?back|reward|waiver|reversal|cashback|refund of fee/i;

export function classify(description: string, direction: "debit" | "credit"): LineKind {
  if (EMI_RE.test(description)) return "emi";
  if (direction === "debit") {
    // A bounced bill payment comes back as a debit.
    if (/reversal\W+.*payment|payment.*reversal|payment.*return/i.test(description)) return "payment";
    return FEE_RE.test(description) && !MERCHANT_FEE_RE.test(description) && !/fuel station|petrol/i.test(description) ? "fee" : "purchase";
  }
  if (PAYMENT_RE.test(description)) return "payment";
  if (/surcharge waiver|fee reversal|gst reversal|fee.*rev|reversal.*fee|annual fee/i.test(description)) return "fee_reversal";
  if (CASHBACK_RE.test(description) && !/merchant|refund/i.test(description)) return "cashback";
  return "refund";
}

const NOISE = /^(l|C|EMI|INR|IN|\+|-|\(\*Convert to EMI\)|IN \(\*Convert to EMI\))$/i;

type Raw = { date: string; tokens: string[]; page: number; lineIndex: number; x: number };

/** One candidate line → a statement line, or null when it isn't a transaction. */
function readTokens(tokens: string[], family: string): Omit<StatementLine, "date" | "kind" | "cardLast4" | "page"> | null {
  let t = tokens.map((s) => s.trim()).filter(Boolean);
  // A side panel ("Statement Date", "Total Outstanding") can share the row: keep
  // only up to the last amount and its Dr/Cr marker.
  let lastMoney = -1;
  t.forEach((tok, i) => {
    if (parseMoney(tok) && /\d\.\d/.test(tok)) lastMoney = i;
  });
  if (lastMoney >= 0) t = t.slice(0, lastMoney + (/^(cr|dr)$/i.test(t[lastMoney + 1] ?? "") ? 2 : 1));
  while (t.length && /^l$/i.test(t[t.length - 1])) t.pop();
  let marker: "cr" | "dr" | null = null;
  if (t.length && /^(cr|dr)$/i.test(t[t.length - 1])) marker = t.pop()!.toLowerCase() as "cr" | "dr";
  const last = t.length ? parseMoney(t[t.length - 1]) : null;
  if (!last || !t[t.length - 1].includes(".")) return null;
  t.pop();
  marker = marker ?? last.marker;
  let credit = marker === "cr" || last.sign === -1;
  // HDFC prints the rupee sign as a lone "C" and marks credits with a "+" just before it.
  if (t.length && t[t.length - 1] === "C") {
    t.pop();
    if (t.length && t[t.length - 1] === "+") {
      t.pop();
      credit = true;
    }
  }

  let foreign: StatementLine["foreign"] = null;
  const text: string[] = [];
  for (const tok of t) {
    const f = tok.match(FOREIGN_RE);
    if (f && !foreign) {
      foreign = { currency: f[1], amount: Number(f[2].replace(/,/g, "")) };
      const remainder = tok.replace(FOREIGN_RE, "").replace(/[()]/g, "").trim();
      if (/[a-z]{3}/i.test(remainder)) text.push(remainder);
      continue;
    }
    if (NOISE.test(tok)) continue;
    if (/^[+-]?\s?\d+$/.test(tok)) continue; // reward points, reference numbers
    if (parseMoney(tok) && /\d\.\d/.test(tok)) continue; // BoB repeats the amount in its own currency
    if (!/[a-z]/i.test(tok)) continue;
    text.push(tok.replace(/\s*\(\*Convert to EMI\)/i, ""));
  }
  if (family === "bob" && foreign === null) {
    const cur = t.find((tok) => /^[A-Z]{3}$/.test(tok) && tok !== "INR" && new RegExp(`^(${CURRENCIES})$`).test(tok));
    if (cur) foreign = { currency: cur, amount: NaN };
  }
  const description = text.join(" ").replace(/\s+/g, " ").trim();
  return {
    description,
    merchant: (text[0] ?? "").replace(/\s+/g, " ").trim(),
    amount: Math.round(last.value * 100) / 100,
    direction: credit ? "credit" : "debit",
    foreign,
  };
}

function lineText(line: Line): string {
  return line.cells.map((c) => c.s.trim()).filter(Boolean).join(" | ");
}

/** Pages that only explain how interest works carry made-up sample transactions. */
function isIllustrationPage(page: Line[]): boolean {
  return page.some((l) => /illustration|the following illustration|interest charges calculation/i.test(lineText(l)));
}

/** All money values printed outside transaction lines, for the tie-out search. */
function summaryNumbers(doc: StatementDoc, txnKeys: Set<string>): number[] {
  const out: number[] = [];
  doc.pages.slice(0, 2).forEach((page, p) =>
    page.forEach((line, i) => {
      if (txnKeys.has(`${p}:${i}`)) return;
      const cells = line.cells.map((c) => c.s.trim()).filter(Boolean);
      for (let k = 0; k < cells.length; k++) {
        const money = parseMoney(cells[k]);
        if (!money || !/\d\.\d|,/.test(cells[k])) continue;
        const nextMarker = /^(cr|dr)$/i.test(cells[k + 1] ?? "") ? cells[k + 1].toLowerCase() : null;
        const marker = money.marker ?? nextMarker;
        const v = money.value * money.sign * (marker === "cr" ? -1 : 1);
        out.push(v, -v);
      }
    }),
  );
  return [...new Set(out.map((v) => Math.round(v * 100)))].map((c) => c / 100);
}

export function tieOut(debits: number, credits: number, numbers: number[]): TieOut {
  const dr = Math.round(debits * 100);
  const cr = Math.round(credits * 100);
  const cents = new Set(numbers.map((n) => Math.round(n * 100)));
  const base = { ok: false, debits: dr / 100, credits: cr / 100, previous: null, totalDue: null, how: null } as TieOut;
  // Exact: previous − credits + debits = total, to the paisa.
  for (const p of cents) {
    const t = p - cr + dr;
    if (cents.has(t) && !(dr === 0 && cr === 0)) return { ...base, ok: true, previous: p / 100, totalDue: t / 100, how: "exact" };
  }
  // Rounded totals (HDFC prints whole rupees) only count when the debit or credit
  // sum itself is printed too, so a near-miss can't pass by coincidence.
  const sumsPrinted = (dr > 0 && cents.has(dr)) || (cr > 0 && cents.has(cr));
  if (sumsPrinted) {
    for (const p of cents) {
      for (const t of cents) {
        if (t % 100 === 0 && Math.abs(p - cr + dr - t) <= 100 && t !== p) {
          return { ...base, ok: true, previous: p / 100, totalDue: t / 100, how: "rounded" };
        }
      }
    }
  }
  if (dr === 0 && cr === 0) return { ...base, ok: true, how: "empty" };
  return base;
}

/**
 * AU prints each transaction over three rows — merchant, then "15 | +₹177.00",
 * then "Sep 26 | Cr" — so join them into one row the shared reader understands.
 * Rows that don't fit the pattern are left untouched.
 */
export function stitchAuRows(page: Line[]): Line[] {
  const out = [...page];
  for (let i = 1; i + 1 < out.length; i++) {
    const day = lineText(out[i]).match(/^(\d{1,2}) \| ([+-])?\s*₹\s*([\d,]+\.\d{2})$/);
    const month = lineText(out[i + 1]).match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) \| (Cr|Dr)$/i);
    if (!day || !month) continue;
    const description = lineText(out[i - 1]);
    const cell = (s: string) => ({ x: out[i].cells[0].x, s });
    out[i] = { y: out[i].y, cells: [cell(`${day[1]} ${month[1]} ${month[2]}`), cell(description), cell(day[3]), cell(month[3])] };
    out[i - 1] = { y: out[i - 1].y, cells: [] };
    out[i + 1] = { y: out[i + 1].y, cells: [] };
  }
  return out.filter((l) => l.cells.length > 0);
}

export function parseStatement(doc: StatementDoc): ParsedStatement {
  const statementDate = doc.date ? doc.date.slice(0, 10) : null;
  const raws: Raw[] = [];
  const cardLast4s: string[] = [];
  const cardAt: { page: number; line: number; last4: string }[] = [];

  doc.pages.forEach((page, p) => {
    if (isIllustrationPage(page)) return;
    if (doc.family === "au") page = stitchAuRows(page);
    page.forEach((line, i) => {
      const text = lineText(line);
      const card = text.match(CARD_RE);
      if (card) {
        cardAt.push({ page: p, line: i, last4: card[1] });
        if (!cardLast4s.includes(card[1])) cardLast4s.push(card[1]);
      }
      // A chart label or side note on the left ("66%", "For exclusive") can share the
      // row, so the date may be the second or third cell. Only number-free labels and
      // percentages may be skipped: a leading number means another table (an EMI
      // schedule), not a transaction. Some HDFC PDFs also print a stray "null".
      for (let start = 0; start < Math.min(3, line.cells.length); start++) {
        if (start > 0 && !/^(\d{1,3}(\.\d+)?%|null|[^\d]+)$/i.test(line.cells[start - 1].s.trim())) break;
        const cells = line.cells.slice(start).map((c, k) => (k === 0 ? { ...c, s: c.s.replace(/^null\s+/i, "") } : c));
        const lead = leadingDate(lineText({ ...line, cells }), doc.family, statementDate);
        if (!lead) continue;
        raws.push({ date: lead.date, tokens: lead.rest.split("|"), page: p, lineIndex: i, x: line.cells[start].x });
        break;
      }
    });
  });

  const lines: StatementLine[] = [];
  const txnKeys = new Set<string>();
  for (const r of raws) {
    const read = readTokens(r.tokens, doc.family);
    // A ₹0.00 row is a "pay now" box or a placeholder, never a transaction.
    if (!read || read.amount === 0) continue;
    let { description, merchant } = read;
    if (!description) {
      // HDFC wraps a long merchant name onto the lines just above and below the date line.
      const page = doc.pages[r.page];
      const around = [page[r.lineIndex - 1], page[r.lineIndex + 1]]
        .filter((l): l is Line => !!l && !leadingDate(lineText(l), doc.family, statementDate) && l.cells[0].x > r.x + 20)
        .map(lineText);
      description = around.join(" ").replace(/\s*\|\s*/g, " ").trim();
      merchant = description.replace(/\s*\(Ref#.*$/i, "").trim();
      if (!description) continue;
    }
    txnKeys.add(`${r.page}:${r.lineIndex}`);
    const before = cardAt.filter((c) => c.page < r.page || (c.page === r.page && c.line < r.lineIndex)).pop();
    lines.push({
      ...read,
      description,
      merchant,
      date: r.date,
      kind: classify(description, read.direction),
      cardLast4: before?.last4 ?? cardLast4s[0] ?? null,
      page: r.page + 1,
    });
  }

  const debits = lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amount, 0);
  return { lines, tie: tieOut(debits, credits, summaryNumbers(doc, txnKeys)), cardLast4s };
}
