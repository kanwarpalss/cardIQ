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
// Confirmed format (debit, "generic alert" template — seen starting 2026-10-21):
//   Subject: "Transaction alert on Axis Bank Credit Card"  (NO amount/card/verb at all)
//   Body:    "...Transaction amount (INR):  INR  52250 Merchant name: Aurikitchen
//             Axis Bank Credit Card No.: XX4455 Date and time: 24-10-2026 12:53:54 IST
//             Available limit (INR): 462486.21..."
//   Axis dropped the per-txn subject line entirely for this template, and the
//   body has no transactional verb (debited/spent/etc.) either — before this
//   was handled, every one of these emails silently vanished: SUBJECT_DEBIT_RE
//   doesn't match the generic subject, and the generic-sniffer fallback's verb
//   requirement (TXN_VERB_RE) also has nothing to match on. Do NOT confuse this
//   with "Transaction declined for Transaction alert on Axis Bank Credit Card
//   no. XX4455" — that's a decline notice (no money moved) and must stay
//   unparsed; SUBJECT_GENERIC_ALERT_RE is anchored with ^...$ so it can't.
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
//
// Confirmed format (legacy template, 2022-07 through 2025-08):
//   Subject: "Transaction alert on Axis Bank Credit Card no. XX4455" (same
//            subject reused for TWO different body shapes — see below)
//   Debit body:  "...Thank you for using your [Axis Bank] [credit] card
//                 no. XX4455 for INR 633 at PayU*Swiggy on 31-08-2025
//                 19:58:40 IST. The total credit limit..."
//   Reversal body: "...Thank you for banking with us. We wish to inform you
//                 that the transaction of INR 1082 on Axis Bank Credit Card
//                 no. XX4455 on 31-08-25 00:13:08 IST at EXPLOREX TE has
//                 been reversed..."
//   1444 "using" (debit) emails + 38 "banking with us...has been reversed"
//   (credit) emails found in one real inbox, 1488 of them never captured by
//   any parser: "using" isn't in the generic sniffer's verb list, so even
//   the fallback stayed silent. The reversal body is NOT a duplicate of its
//   debit sibling — it's a separate, real credit event (sometimes for a
//   debit that has no "using" email of its own at all, e.g. a declined
//   mandate charge) — so BOTH shapes are parsed, as two independent rows,
//   exactly like the dashboard already treats any other debit+reversal pair.
//   Whitespace before "on"/"INR" is inconsistent in real samples (e.g.
//   "XX1722on", "ofINR") — regexes below use \s* rather than \s+ at those
//   joints for that reason, confirmed against all 1491 real stored emails.

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
// Axis sometimes omits the leading zero for a sub-unit foreign transaction
// (e.g. "SGD .1"). Accept it here so the strict Axis parser owns the email;
// otherwise it falls through to the generic parser, which can mistake the
// later "Available Limit: INR …" line for the purchase amount.
const MONEY_RE = "(?:\\d[\\d,]*(?:\\.\\d{1,2})?|\\.\\d{1,2})";
const SUBJECT_DEBIT_RE  = new RegExp(`([A-Z]{3})\\s+(${MONEY_RE})\\s+spent\\s+on\\s+credit\\s+card\\s+no\\.\\s+XX(\\d{4})`, "i");
const SUBJECT_CREDIT_RE = new RegExp(`([A-Z]{3})\\s+(${MONEY_RE})\\s+(?:refund\\s+)?credited\\s+(?:to\\s+)?(?:your\\s+)?credit\\s+card\\s+(?:no\\.\\s+)?XX(\\d{4})`, "i");
// The 2026-10 "generic alert" template carries no amount/card info in the
// subject at all — anchored so it never matches the longer "Transaction
// declined for Transaction alert on Axis Bank Credit Card no. XX4455" subject.
const SUBJECT_GENERIC_ALERT_RE = /^Transaction\s+alert\s+on\s+Axis\s+Bank\s+Credit\s+Card\s*$/i;
// Optional "(INR)"/"(USD)" annotation the generic-alert template inserts
// between "Amount" and the colon: "Transaction amount (INR):  INR  52250".
const BODY_AMOUNT_RE    = new RegExp(`Transaction\\s+Amount\\s*(?:\\([A-Z]{3}\\))?\\s*[:\\s]+([A-Z]{3})\\s+(${MONEY_RE})`, "i");
// For foreign-currency txns Axis usually includes "Indian Rupee Equivalent: INR XXX"
const BODY_INR_EQUIV_RE = /Indian\s+Rupee\s+Equivalent[:\s]+INR\s+([\d,]+(?:\.\d{1,2})?)/i;
// Generic-alert template has no card number in the subject — pull it from the
// body's "Credit Card No.: XX4455" / "Credit Card No. XX4455" field instead.
const BODY_CARD_LAST4_RE = /Credit\s+Card\s+No\.?\s*[:\s]*XX(\d{4})/i;
// The legacy (2022-2025) template's subject always ends in "no. XXnnnn" —
// anchored at both ends so it can't match the longer decline subject
// ("Transaction declined for Transaction alert on Axis Bank Credit Card
// no. XXnnnn") or the newer no-card-number generic-alert subject above.
const SUBJECT_LEGACY_ALERT_RE = /^Transaction\s+alert\s+on\s+Axis\s+Bank\s+Credit\s+Card\s+no\.\s+XX\d{4}\s*$/i;
const BODY_LEGACY_USING_RE = new RegExp(
  `using\\s+your\\s+(?:axis\\s+bank\\s+)?(?:credit\\s+)?card\\s+no\\.?\\s*XX(\\d{4})\\s+for\\s+([A-Z]{3})\\s+(${MONEY_RE})\\s+at\\s+([^\\n\\r]+?)\\s+on\\s+\\d{2}-\\d{2}-\\d{2,4}`,
  "i"
);
const BODY_LEGACY_REVERSED_RE = new RegExp(
  `transaction\\s+of\\s*([A-Z]{3})\\s+(${MONEY_RE})\\s+on\\s+(?:axis\\s+bank\\s+)?(?:your\\s+)?credit\\s+card\\s+no\\.?\\s*XX(\\d{4})\\s*on\\s+[\\d-]+\\s+[\\d:]+(?:\\s*IST)?\\s*at\\s+([^\\n\\r]+?)\\s+has\\s+been\\s+reversed`,
  "i"
);
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

// Shared by every body shape: Axis's "Indian Rupee Equivalent: INR X" line
// (when present) is the bank-booked rate and always wins; otherwise a
// foreign-currency row gets the amount_inr=0 sentinel (see file header).
function resolveForeignAmount(
  bodyCurrency: string,
  bodyAmount: number,
  combined: string,
): { amount_inr: number; currency?: string; amount_original?: number } {
  if (bodyCurrency === "INR") return { amount_inr: bodyAmount };
  const inrEquiv = BODY_INR_EQUIV_RE.exec(combined);
  return {
    amount_inr: inrEquiv ? parseAmount(inrEquiv[1]) : 0,
    currency: bodyCurrency,
    amount_original: bodyAmount,
  };
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
  const isGenericAlert = !sm && SUBJECT_GENERIC_ALERT_RE.test(subject);
  const isLegacyAlert = !sm && !isGenericAlert && SUBJECT_LEGACY_ALERT_RE.test(subject);
  if (!sm && !isGenericAlert && !isLegacyAlert) return null;

  const combined = `${body} ${snippet}`.replace(/\s+/g, " ").trim();

  // The legacy subject is shared by two unrelated body shapes (see file
  // header) — each is tried in turn; neither matching means this is some
  // other body under the same subject, which stays unparsed rather than
  // guessed at.
  if (isLegacyAlert) {
    const using = BODY_LEGACY_USING_RE.exec(combined);
    if (using) {
      const bodyCurrency = using[2].toUpperCase();
      const bodyAmount = parseAmount(using[3]);
      if (!(bodyAmount > 0)) return null;
      return {
        card_last4: using[1],
        merchant_raw: using[4].trim(),
        txn_at: parseBodyDate(combined) ?? new Date(),
        txn_type: "debit",
        ...resolveForeignAmount(bodyCurrency, bodyAmount, combined),
      };
    }
    const reversed = BODY_LEGACY_REVERSED_RE.exec(combined);
    if (reversed) {
      const bodyCurrency = reversed[1].toUpperCase();
      const bodyAmount = parseAmount(reversed[2]);
      if (!(bodyAmount > 0)) return null;
      return {
        card_last4: reversed[3],
        merchant_raw: reversed[4].trim(),
        txn_at: parseBodyDate(combined) ?? new Date(),
        txn_type: "credit",
        ...resolveForeignAmount(bodyCurrency, bodyAmount, combined),
      };
    }
    return null;
  }

  const card_last4 = sm ? sm[3] : BODY_CARD_LAST4_RE.exec(combined)?.[1];
  if (!card_last4) return null;

  // No generic-alert refund/reversal sample has ever been observed (only
  // debits, confirmed against every real one on file) — always "debit"
  // rather than scanning the whole body for the word "refund", which risks
  // a false flip if it ever shows up in ordinary footer boilerplate (e.g.
  // "for refund queries, contact...") on a genuine debit.
  const txn_type: "debit" | "credit" = sm ? (creditMatch ? "credit" : "debit") : "debit";

  const subjectCurrency = sm?.[1]?.toUpperCase();

  // Body usually carries the cleanest figures — prefer it.
  const bodyAmt = BODY_AMOUNT_RE.exec(combined);
  const bodyCurrency = bodyAmt?.[1]?.toUpperCase() ?? subjectCurrency;
  const bodyAmount   = bodyAmt ? parseAmount(bodyAmt[2]) : (sm ? parseAmount(sm[2]) : NaN);
  if (!(bodyAmount > 0)) return null;
  if (!bodyCurrency) return null;

  // Foreign-currency handling (and why amount_inr=0 is the correct sentinel,
  // not the raw foreign figure) — see resolveForeignAmount's comment above.
  return {
    card_last4,
    merchant_raw: extractMerchant(combined),
    txn_at: parseBodyDate(combined) ?? new Date(),
    txn_type,
    ...resolveForeignAmount(bodyCurrency, bodyAmount, combined),
  };
}
