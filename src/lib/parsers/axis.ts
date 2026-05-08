// Axis Bank credit-card transaction email parser.
//
// Confirmed format (debit):
//   Subject: "INR 1042 spent on credit card no. XX4455"
//   Body:    "...Transaction Amount: INR 1042 Merchant Name: PYU*Swiggy Axis Bank Credit Card No. XX4455"
//
// Credit/refund:
//   Subject: "INR 1042 refund credited to credit card no. XX4455"

export type ParsedTxn = {
  card_last4: string;
  amount_inr: number;
  merchant_raw?: string;
  txn_at: Date;
  txn_type: "debit" | "credit";
};

const SUBJECT_DEBIT_RE  = /INR\s+([\d,]+(?:\.\d{1,2})?)\s+spent\s+on\s+credit\s+card\s+no\.\s+XX(\d{4})/i;
const SUBJECT_CREDIT_RE = /INR\s+([\d,]+(?:\.\d{1,2})?)\s+(?:refund\s+)?credited\s+(?:to\s+)?(?:your\s+)?credit\s+card\s+(?:no\.\s+)?XX(\d{4})/i;
const BODY_AMOUNT_RE    = /Transaction\s+Amount:\s+INR\s+([\d,]+(?:\.\d{1,2})?)/i;
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

  // Combine body + snippet for parsing — snippet often has data when HTML body fails to extract
  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  const bodyAmountMatch = BODY_AMOUNT_RE.exec(combined);
  const amount_inr = bodyAmountMatch ? parseAmount(bodyAmountMatch[1]) : parseAmount(sm[1]);

  const card_last4 = sm[2];
  const merchant_raw = extractMerchant(combined);
  const txn_at = parseBodyDate(combined) ?? new Date();

  return { card_last4, amount_inr, merchant_raw, txn_at, txn_type };
}
