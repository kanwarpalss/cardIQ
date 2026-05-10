// Axis Bank credit-card transaction email parser.
//
// Confirmed format (debit, INR):
//   Subject: "INR 1042 spent on credit card no. XX4455"
//
// Confirmed format (debit, foreign currency w/ INR equivalent):
//   Subject: "USD 224.28 spent on credit card no. XX4455"
//   Body:    "...Transaction Amount: USD 224.28 ... Indian Rupee Equivalent: INR 18923.45..."
//
// Confirmed format (debit, foreign currency WITHOUT INR equivalent):
//   Subject: "IDR 12272062 spent on credit card no. XX4455"
//   Body:    "...Transaction Amount: IDR 12272062 ... Available Limit: INR 112060.04 ..."
//   The body's "Available Limit" / "Total Credit Limit" lines also contain INR
//   amounts — we MUST NOT pick those up as the transaction amount.
//
// Rules:
//   • amount_inr is set ONLY when the txn currency is INR or when an
//     "Indian Rupee Equivalent" line is present. Otherwise amount_inr=0
//     (sentinel) and original_currency + original_amount carry the truth.
//     This prevents IDR/USD/etc. amounts from being summed as INR in the
//     dashboard.
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

  // Foreign-currency txn:
  //   • If "Indian Rupee Equivalent: INR X" is present → amount_inr = X
  //   • Otherwise → amount_inr = 0 (sentinel). The dashboard sums only
  //     amount_inr where original_currency = 'INR', so a 0 here keeps the
  //     row visible (under the foreign-currency breakdown) without
  //     polluting INR totals. This is critical: pre-fix we put the
  //     foreign amount in amount_inr which inflated totals catastrophically
  //     (e.g. 1 IDR ≈ 0.005 INR → IDR 12,272,062 looked like ₹1.2 crore).
  let amount_inr = bodyAmount;
  let currency: string | undefined;
  let amount_original: number | undefined;

  if (bodyCurrency !== "INR") {
    const inrEquiv = BODY_INR_EQUIV_RE.exec(combined);
    amount_inr      = inrEquiv ? parseAmount(inrEquiv[1]) : 0;
    currency        = bodyCurrency;
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
