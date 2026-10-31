import type { ParsedTxn } from "./axis";

// Citi's old masked PAN includes a four-digit PREFIX before the Xs. Always
// capture the suffix: 4304XXXXXXXX6589 is card 6589, not card 4304.
const CARD = "(?:\\d{4}[X*]{4,}|[X*]{2,})?(\\d{4})(?!\\d)";
const MONEY = "(?:\\d[\\d,]*(?:\\.\\d{1,2})?|\\.\\d{1,2})";
const DATE = "(\\d{2}[-/](?:[A-Z]{3}|\\d{2})[-/]\\d{2,4})";
const SPEND = new RegExp(`(?:Rs\\.?\\s*(${MONEY})|(${MONEY})\\s*([A-Z]{3}))\\s+(?:was\\s+)?spent\\s+on\\s+(?:your\\s+)?(?:Citi(?:bank)?\\s+)?(?:Credit\\s+)?Card\\s+(?:ending\\s+)?${CARD}\\s+on\\s+${DATE}\\s+at\\s+(.+?)(?=\\.(?:\\s|Final)|\\s+Limit\\s+available|$)`, "i");
const REFUND = new RegExp(`Credit\\s+of\\s+Rs\\.?\\s*(${MONEY})\\s+received\\s+from\\s+(.+?)\\s+has\\s+been\\s+processed\\s+on\\s+your\\s+Credit\\s+Card\\s+${CARD}\\s+on\\s+${DATE}`, "i");
const CANCEL = new RegExp(`(?:Transaction|Trnx)\\s+of\\s+(?:Rs\\.?\\s*(${MONEY})|(${MONEY})\\s*([A-Z]{3}))\\s+on\\s+(?:your\\s+)?(?:Citi\\s+)?(?:Credit\\s+)?Card\\s+(?:ending\\s+)?${CARD}\\s+on\\s+${DATE}\\s+at\\s+(.+?)\\s+(?:has\\s+been|is)\\s+cancelled`, "i");
const PROVISIONAL = new RegExp(`Rs\\.?\\s*(${MONEY})\\s+has\\s+been\\s+provisionally\\s+credited\\s+to\\s+Credit\\s+Card\\s+no\\.?\\s*${CARD}\\s+on\\s+${DATE}\\s+for\\s+disputed\\s+transaction\\s+at\\s+(.+?)(?:\\.|$)`, "i");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function date(raw: string): Date | null {
  const [dd, month, year] = raw.toUpperCase().split(/[-/]/);
  const mm = /^\d+$/.test(month) ? Number(month) : MONTHS.indexOf(month) + 1;
  const yyyy = year.length === 2 ? 2000 + Number(year) : Number(year);
  const result = new Date(`${yyyy}-${String(mm).padStart(2, "0")}-${dd}T12:00:00+05:30`);
  return Number.isFinite(result.getTime()) && result.getUTCDate() === Number(dd) && result.getUTCMonth() + 1 === mm ? result : null;
}

function txn(last4: string, amountText: string, currency: string, merchant: string, rawDate: string, type: "debit" | "credit"): ParsedTxn | null {
  const amount = Number(amountText.replace(/,/g, ""));
  const at = date(rawDate);
  if (!Number.isFinite(amount) || amount <= 0 || !at || /,,|,$/.test(amountText)) return null;
  return {
    card_last4: last4, amount_inr: currency === "INR" ? amount : 0,
    ...(currency === "INR" ? {} : { currency, amount_original: amount }),
    merchant_raw: merchant.trim(), txn_at: at, txn_type: type,
  };
}

export function parseCitiTxn(subject: string, body: string, snippet = ""): ParsedTxn | null {
  const text = `${body} ${snippet}`.replace(/\s+/g, " ").trim();
  if (/\b(?:this|your) transaction (?:was|has been) declined\b/i.test(text)) return null;
  if (/^Transaction confirmation on your Citibank credit card$/i.test(subject.trim())) {
    const m = SPEND.exec(text);
    return m ? txn(m[4], m[1] ?? m[2], m[1] ? "INR" : m[3].toUpperCase(), m[6], m[5], "debit") : null;
  }
  if (/^Credit Transaction on your Citibank credit card$/i.test(subject.trim())) {
    const m = REFUND.exec(text);
    return m ? txn(m[3], m[1], "INR", m[2], m[4], "credit") : null;
  }
  if (/^Cancellation of transaction on your Citibank credit card$/i.test(subject.trim())) {
    const m = CANCEL.exec(text);
    return m ? txn(m[4], m[1] ?? m[2], m[1] ? "INR" : m[3].toUpperCase(), m[6], m[5], "credit") : null;
  }
  if (/^Provisional credit to your Citibank credit card$/i.test(subject.trim())) {
    const m = PROVISIONAL.exec(text);
    return m ? txn(m[2], m[1], "INR", m[4], m[3], "credit") : null;
  }
  return null;
}
