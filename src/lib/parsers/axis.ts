// Axis Bank credit-card transaction email parser.
//
// Confirmed format (debit, INR):
//   Subject: "INR 1042 spent on credit card no. XX4455"
//
// Confirmed format (debit, foreign currency):
//   Subject: "USD 224.28 spent on credit card no. XX4455"
//   Body:    "...Transaction Amount: USD 224.28 ... Indian Rupee Equivalent: INR 18923.45..."
//
// We match ANY 3-letter currency code in the subject. For foreign-currency
// transactions we prefer the INR equivalent from the body when present;
// otherwise we keep the original amount and currency code (caller can convert).
//
// Credit/refund:
//   Subject: "INR 1042 refund credited to credit card no. XX4455"

export type ParsedTxn = {
  card_last4: string;
  amount_inr: number;
  merchant_raw?: string;
  txn_at: Date;
  txn_type: "debit" | "credit";
  /** ISO 4217 code if non-INR. Defaults to INR. */
  currency?: string;
  /** Original amount in `currency` (only set if currency !== INR). */
  amount_original?: number;
};

// (currency code) (amount) spent on credit card no. XX(last4)
const SUBJECT_DEBIT_RE  = /([A-Z]{3})\s+([\d,]+(?:\.\d{1,2})?)\s+spent\s+on\s+credit\s+card\s+no\.\s+XX(\d{4})/i;
const SUBJECT_CREDIT_RE = /([A-Z]{3})\s+([\d,]+(?:\.\d{1,2})?)\s+(?:refund\s+)?credited\s+(?:to\s+)?(?:your\s+)?credit\s+card\s+(?:no\.\s+)?XX(\d{4})/i;
const BODY_AMOUNT_RE    = /Transaction\s+Amount[:\s]+([A-Z]{3})\s+([\d,]+(?:\.\d{1,2})?)/i;
// For foreign-currency txns Axis usually includes "Indian Rupee Equivalent: INR XXX"
const BODY_INR_EQUIV_RE = /Indian\s+Rupee\s+Equivalent[:\s]+INR\s+([\d,]+(?:\.\d{1,2})?)/i;
// Multiple merchant patterns to handle HTML-stripped vs. plain text
const MERCHANT_REGEXES = [
  // Stop at 4+ consecutive spaces (field separator in stripped HTML), not 2+,
  // so merchant names that happen to have a double space don't get truncated early.
  /Merchant\s+Name\s*[:\-]\s*([^\n\r]+?)(?=\s{4,}|\s+Axis\s+Bank|\s+Credit\s+Card\s+No|$)/i,
  /Merchant\s+Name\s*[:\-]\s*([A-Za-z0-9*&.,'\-\s]{2,80}?)(?=\s+Axis|\s+Credit|\s+No\.|\s+If\s+the|\s+CLICK|$)/i,
];
const DATE_RE = /(\d{2})-(\d{2})-(\d{2,4})/;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

function parseBodyDate(text: string): Date | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const yyyy = yy.length === 2 ? `20${yy}` : yy;
  const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

function extractMerchant(text: string): string | undefined {
  for (const re of MERCHANT_REGEXES) {
    const m = re.exec(text);
    if (m?.[1]) {
      const cleaned = m[1].trim();
      if (cleaned && cleaned.length > 1) return cleaned;
    }
  }
  return undefined;
}

export function parseAxisTxn(subject: string, body: string, snippet: string = ""): ParsedTxn | null {
  const debitMatch  = SUBJECT_DEBIT_RE.exec(subject);
  const creditMatch = SUBJECT_CREDIT_RE.exec(subject);
  const sm = debitMatch ?? creditMatch;
  if (!sm) return null;

  const txn_type: "debit" | "credit" = creditMatch ? "credit" : "debit";
  const subjectCurrency = sm[1].toUpperCase();
  const card_last4      = sm[3];

  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  // Body usually carries the cleanest figures — prefer it.
  const bodyAmt = BODY_AMOUNT_RE.exec(combined);
  const bodyCurrency = bodyAmt?.[1]?.toUpperCase() ?? subjectCurrency;
  const bodyAmount   = bodyAmt ? parseAmount(bodyAmt[2]) : parseAmount(sm[2]);

  // Foreign-currency txn: prefer the "Indian Rupee Equivalent" if present.
  let amount_inr = bodyAmount;
  let currency: string | undefined;
  let amount_original: number | undefined;

  if (bodyCurrency !== "INR") {
    const inrEquiv = BODY_INR_EQUIV_RE.exec(combined);
    if (inrEquiv) {
      amount_inr = parseAmount(inrEquiv[1]);
    }
    // We still record the original currency + amount even when INR equiv exists.
    currency = bodyCurrency;
    amount_original = bodyAmount;
  }

  return {
    card_last4,
    amount_inr,
    merchant_raw: extractMerchant(combined),
    txn_at: parseBodyDate(combined) ?? new Date(),
    txn_type,
    ...(currency ? { currency, amount_original } : {}),
  };
}
