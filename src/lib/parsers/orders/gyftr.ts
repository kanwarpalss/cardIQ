// Gyftr voucher-issuance email parser (V2 feature C — the voucher bridge).
//
// Gyftr (via HDFC SmartBuy / PayZapp) sells brand e-gift vouchers. Buying one
// generates TWO emails at the SAME instant:
//   1. the bank alert  — "Rs. 2000.00 … towards GYFTR VIA SMARTBUY" (a normal
//      card transaction the bank sync already captures);
//   2. this Gyftr email — the voucher details (brand, face value, code).
//
// A Gyftr email is NOT an order — it's the issuance of spendable balance. So we
// don't route it through the order pipeline; we extract voucher records and
// (elsewhere) match each to its funding card charge, then draw later brand
// orders down against it (voucher-bridge.ts).
//
// Verified against KP's real email (2026-06-22), sender gifts@gyftr.com:
//   Subject: "Confidential - Your Gift Voucher details from GyFTR via HDFC
//             Bank PayZapp Shop e-Vouchers"
//   Body (HTML → whitespace-collapsed by extractBody):
//     "… Please find your instant voucher details. Amazon Fresh Amazon Fresh
//      E-Gift Card Code FVM4B44E36338 Value 2000 PIN 6014867399473193
//      Valid Till 21 Jun 2027 …"
//
// The brand is repeated (logo alt + heading); "Value" is the FACE value (the
// spendable balance, not the — often discounted — price paid to Gyftr). The PIN
// is a live secret with no analytical value, so we deliberately do NOT capture
// it. The layout repeats per voucher, so a single email can carry several
// vouchers (bulk buys); we anchor on each "E-Gift Card Code" and loop.
//
// NOTE: built against ONE real single-voucher sample. The loop handles the
// multi-voucher case structurally, but that path is unverified against a real
// bulk email — revisit if a real one surfaces.

import { parseInrAmount } from "./types";

export type ParsedVoucher = {
  /** Brand the voucher spends at, e.g. "Amazon Fresh". Free text; the DB stores
   *  both this and a normalized key (voucher-bridge.normalizeBrand). */
  brand: string;
  /** Face value in INR — the spendable balance, NOT the price paid to Gyftr. */
  faceValue: number;
  /** The e-gift card code — a stable per-voucher id. Sensitive (redeemable),
   *  but KP's own private data; the PIN is never captured. */
  code?: string;
  /** Expiry as ISO 'YYYY-MM-DD' when the "Valid Till" date parses, else absent. */
  validTill?: string;
};

/** Domain-anchored sender check — Gyftr issues from gifts@gyftr.com. */
export function isGyftrSender(from: string): boolean {
  const addr = (/<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  return addr.endsWith("@gyftr.com") || addr.endsWith(".gyftr.com");
}

// Each voucher is anchored by its gift-card code. Codes are alphanumeric, ≥6
// chars (real sample "FVM4B44E36338"); allow internal hyphens some brands use.
const CODE_RE = /E-?\s*Gift\s+Card\s+Code\s+([A-Z0-9][A-Z0-9-]{5,})/gi;
// Face value: "Value 2000" (no ₹, no decimals in the sample) — but tolerate a
// currency prefix and paise for other brands' formats.
const VALUE_RE = /\bValue\s+(?:Rs\.?\s*|₹\s*|INR\s*)?([\d,]+(?:\.\d{1,2})?)/i;
const VALID_TILL_RE = /Valid\s+Till\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i;

/** "Amazon Fresh Amazon Fresh" → "Amazon Fresh" (Gyftr repeats the brand). */
function dedupeDoubled(s: string): string {
  const words = s.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length >= 2 && words.length % 2 === 0) {
    const h = words.length / 2;
    const a = words.slice(0, h).join(" ");
    const b = words.slice(h).join(" ");
    if (a.toLowerCase() === b.toLowerCase()) return a;
  }
  return words.join(" ");
}

/**
 * Brand sits immediately before "E-Gift Card Code" in the body. Take the text
 * after the last sentence break ("… voucher details. Amazon Fresh Amazon
 * Fresh"), de-double it, and cap length so a run-on preamble can't leak in.
 */
function brandFromRegion(region: string): string {
  let flat = region.replace(/\s+/g, " ").trim();
  // In a multi-voucher email this region begins with the PREVIOUS voucher's
  // trailing fields ("… Value 500 PIN 222 Valid Till 30 Dec 2026 Swiggy"). Cut
  // everything up to and including the last such field so only the brand is left.
  const fields = [
    ...flat.matchAll(/Valid\s+Till\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|PIN\s+\d+|\bValue\s+[\d,]+/gi),
  ];
  const last = fields.at(-1);
  if (last) flat = flat.slice(last.index! + last[0].length);
  const afterBreak = flat.split(/[.:!?]/).pop()!.trim();
  const capped = afterBreak.split(" ").filter(Boolean).slice(-6).join(" ");
  return dedupeDoubled(capped);
}

// Month abbreviations → 0-based index, for TZ-safe date assembly.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "21 Jun 2027" → "2027-06-21"; unparseable → undefined. Assembled by hand
 *  (not Date.parse) so a local timezone never shifts the calendar day. */
function toIsoDate(raw: string): string | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/.exec(raw);
  if (!m) return undefined;
  const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (mi < 0) return undefined;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/**
 * Extract every voucher in a Gyftr email. Returns [] when the body carries no
 * recognizable voucher block (a Gyftr marketing/expiry-reminder mail), so the
 * sync records it as seen and moves on — same contract as a null order parse.
 */
export function parseGyftrVouchers(_subject: string, text: string, html: string): ParsedVoucher[] {
  // Prefer the stripped text; some emails only populate the HTML part, so fall
  // back to a whitespace-collapsed HTML if the text has no code anchor.
  const body = CODE_RE.test(text) ? text : html.replace(/<[^>]+>/g, " ");
  CODE_RE.lastIndex = 0;

  const anchors: Array<{ code: string; start: number; end: number }> = [];
  for (let m = CODE_RE.exec(body); m; m = CODE_RE.exec(body)) {
    anchors.push({ code: m[1], start: m.index, end: m.index + m[0].length });
  }
  if (anchors.length === 0) return [];

  const vouchers: ParsedVoucher[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    // Value/Valid-Till live between this code and the next voucher's code.
    const after = body.slice(a.end, i + 1 < anchors.length ? anchors[i + 1].start : undefined);
    // Brand lives between the previous voucher's fields and this code.
    const before = body.slice(i === 0 ? 0 : anchors[i - 1].end, a.start);

    const valueM = VALUE_RE.exec(after);
    if (!valueM) continue; // no face value → not a real voucher block; skip it
    const faceValue = parseInrAmount(valueM[1]);
    if (!(faceValue > 0)) continue;

    const brand = brandFromRegion(before);
    if (!brand) continue; // no brand → can't reconcile it; don't store a blank

    const validTill = VALID_TILL_RE.exec(after)?.[1];
    vouchers.push({
      brand,
      faceValue,
      code: a.code,
      ...(validTill ? { validTill: toIsoDate(validTill) } : {}),
    });
  }
  return vouchers;
}
