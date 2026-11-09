// The AI reader: turn one email or blog post that passed the free filter into
// a structured deal — or "not a deal" — using Claude Haiku, then check its
// answer against the source text before anything is stored.
//
// Cost: Haiku 5.5 is $0.10 per million input tokens. A trimmed email is
// ~3,000 tokens, so each read costs about $0.0003; a busy day of five reads
// is well under a rupee.
//
// Trust: the model's answer is only kept where the source backs it up. The
// bonus figure must appear in the text as written ("55%"), the program must
// be one in our catalog, and dates must be plausible for when the item
// arrived. A figure the text doesn't contain is dropped, not guessed at.

import type Anthropic from "@anthropic-ai/sdk";
import { PROGRAMS, type ProgramKey } from "@/lib/transfer-partners/programs";
import type { BankKey, DealKind, ExtractedDeal } from "./types";

export const DEAL_MODEL = "claude-haiku-5-5";

/** Source text sent to the model is cut at this many characters. Marketing
 *  emails put the offer at the top; the tail is footers and legal text. */
export const MAX_SOURCE_CHARS = 12000;

export type ReadItem = {
  kind: "email" | "blog";
  origin: string;
  title: string;
  /** ISO timestamp the item arrived or was published. */
  seen_at: string;
  text: string;
};

const PROGRAM_KEYS = Object.keys(PROGRAMS) as ProgramKey[];
const BANK_KEYS: BankKey[] = ["axis", "hdfc", "hsbc", "icici", "amex"];
const KINDS: DealKind[] = ["buy_points", "transfer_bonus", "ratio_change"];

// Kept byte-for-byte stable so the prefix caches across a run's calls.
export const SYSTEM_PROMPT = `You read one marketing email or blog post about airline/hotel loyalty points and say whether it announces a deal of one of these kinds:
- buy_points: buy or gift a program's points/miles/Avios at a bonus (e.g. "up to 55% bonus points") or a discount (e.g. "50% off").
- transfer_bonus: extra points/miles when transferring or converting INTO a program (e.g. "50% bonus when you convert KrisFlyer miles to ALL Accor points", "Axis EDGE Miles to Accor: 30% bonus").
- ratio_change: a lasting change to a credit card's transfer partners or transfer ratio (new partner, removed partner, improved or worse ratio).

NOT deals (answer is_deal=false): bonus points per hotel stay or per night, earning miles on shopping or spend, card sign-up bonuses, award-ticket discounts, fare sales, status offers, articles that only explain how transfers work.

Program keys (use exactly one of these, or null): ${PROGRAM_KEYS.join(", ")}.
Bank keys (the credit card issuer the points come from, or null): ${BANK_KEYS.join(", ")}.

Rules:
- buy_points means paying money. Converting or transferring miles/points from another program is transfer_bonus, even when the subject only says "bonus points".
- program = the program you buy into or transfer INTO.
- For transfer_bonus, fill exactly one source: from_bank (one of the bank keys), from_program (a program key, e.g. krisflyer for KrisFlyer → Accor), or from_other (any other currency, e.g. "Flipkart SuperCoins", "HeyMax"). If the text gives no source, leave all three null.
- bonus_pct / discount_pct: the headline "up to" number as written, without the % sign. Null if no number is stated.
- Dates as YYYY-MM-DD. Resolve partial dates ("Ends 9/9", "until 22 November") using the item's date given below. Null if not stated.
- targeted: true when the offer is personalised ("your exclusive offer", "reveal your offer", "selected members").
- evidence: copy ONE sentence or phrase verbatim from the text that states the offer.
- headline: under 90 characters, plain English, e.g. "Marriott Bonvoy: up to 55% bonus on bought points".

Reply with only a JSON object with these fields: is_deal, kind, program, from_bank, from_program, from_other, bonus_pct, discount_pct, starts_on, ends_on, targeted, evidence, headline.`;

// Zero-width and "invisible" characters marketing emails stuff into their
// preheaders (U+034F combining grapheme joiner, soft hyphens, ZWSP…).
const INVISIBLE = /[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** Readable body text for the model. Some senders' plain-text part is a
 *  stub — Singapore Airlines' is literally "undefined" — so the HTML is used
 *  whenever the plain text is short and the HTML says more. */
export function bestBodyText(text: string | null | undefined, html: string | null | undefined, strip: (h: string) => string): string {
  const t = (text ?? "").replace(INVISIBLE, "").trim();
  const h = html ? strip(html).replace(INVISIBLE, "").trim() : "";
  return t.length >= 200 || h.length <= t.length ? t : h;
}

export function userMessage(item: ReadItem): string {
  const text = item.text.length > MAX_SOURCE_CHARS ? item.text.slice(0, MAX_SOURCE_CHARS) : item.text;
  return [
    `Source: ${item.kind === "email" ? "email from" : "blog post on"} ${item.origin}`,
    `Item date: ${item.seen_at.slice(0, 10)}`,
    `Title: ${item.title}`,
    "",
    text,
  ].join("\n");
}

/** Pull the first JSON object out of a reply, tolerating ```json fences. */
export function parseReply(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

const norm = (s: string) =>
  s.replace(INVISIBLE, "").normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

const isoDate = (v: unknown): string | null => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  // Reject impossible dates (2026-02-30 parses, but back to a different day).
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
};

/** A percentage the source text actually states, e.g. 55 only if "55%" or
 *  "55 per cent" appears. Anything else → null. */
function statedPct(v: unknown, source: string, max: number): number | null {
  const n = typeof v === "string" ? Number(v.replace(/%/g, "").trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > max) return null;
  const s = String(n).replace(".", "\\.");
  const re = new RegExp(`(?<![\\d.])${s}\\s?(?:%|per ?cent|percent)`, "i");
  return re.test(source) ? n : null;
}

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

const DAY = 86400000;

export type Validation = { deal: ExtractedDeal } | { deal: null; reason: string };

/** The reply wasn't JSON (cut off, or chatter). A retryable failure, not a
 *  verdict — the job records it as an error so the next run asks again. */
export const UNREADABLE = "unreadable reply";

/**
 * Check the model's answer against the source and the catalog. Returns a
 * deal only when it is concrete enough to show: a known kind, a catalog
 * program, and — for transfers — at most one source.
 */
export function validateExtraction(raw: unknown, item: ReadItem): Validation {
  if (!raw || typeof raw !== "object") return { deal: null, reason: UNREADABLE };
  const r = raw as Record<string, unknown>;
  if (r.is_deal !== true) return { deal: null, reason: "not a deal" };

  const kind = pick(r.kind, KINDS);
  if (!kind) return { deal: null, reason: `unknown kind ${String(r.kind)}` };
  const program = pick(r.program, PROGRAM_KEYS);
  if (!program) return { deal: null, reason: `program not in catalog (${String(r.program)})` };

  const source = norm(`${item.title}\n${item.text}`);
  // "Buying" needs the source to talk about buying. KrisFlyer's "Enjoy 10%
  // bonus Marriott Bonvoy points this September" (a miles conversion) was
  // read as a points sale; refusing beats mislabelling it.
  if (kind === "buy_points" && !/\b(?:buy|buying|bought|purchase\w*|gift(?:ing)?|top[- ]?up)\b/.test(source)) {
    return { deal: null, reason: "called a points sale, but the text never mentions buying" };
  }

  let from_bank = pick(r.from_bank, BANK_KEYS);
  let from_program = pick(r.from_program, PROGRAM_KEYS);
  let from_other = typeof r.from_other === "string" && r.from_other.trim() ? r.from_other.trim().slice(0, 60) : null;
  if (from_program === program) from_program = null;
  if (kind === "buy_points") { from_bank = null; from_program = null; from_other = null; }
  // Two sources means the model couldn't tell which one the bonus is on;
  // claiming either would be a guess.
  if ([from_bank, from_program, from_other].filter(Boolean).length > 1) {
    return { deal: null, reason: "more than one transfer source" };
  }

  const bonus_pct = statedPct(r.bonus_pct, source, 300);
  const discount_pct = kind === "buy_points" ? statedPct(r.discount_pct, source, 90) : null;

  // Dates must sit near when the item arrived: an end date before it (the
  // model resolved "9/9" to the wrong year) or years out is discarded.
  const seen = Date.parse(item.seen_at);
  const near = (d: string | null, before: number, after: number) => {
    if (!d || !Number.isFinite(seen)) return d;
    const t = Date.parse(`${d}T00:00:00Z`);
    return t >= seen - before * DAY && t <= seen + after * DAY ? d : null;
  };
  const starts_on = near(isoDate(r.starts_on), 120, 400);
  let ends_on = near(isoDate(r.ends_on), 1, 400);
  if (starts_on && ends_on && ends_on < starts_on) ends_on = null;

  const evidence = typeof r.evidence === "string" ? r.evidence.trim().slice(0, 300) : "";
  const evidence_verified = evidence.length >= 8 && source.includes(norm(evidence));

  const headlineRaw = typeof r.headline === "string" ? r.headline.trim() : "";
  const headline = (headlineRaw || item.title).slice(0, 120);

  return {
    deal: {
      kind, program, from_bank, from_program, from_other,
      bonus_pct, discount_pct, starts_on, ends_on,
      targeted: r.targeted === true,
      headline, evidence, evidence_verified,
    },
  };
}

export type Usage = { input: number; output: number };

/** Ask Haiku about one item. Throws on API failure so the job can record
 *  the item as an error and retry it on a later run. */
export async function extractDeal(client: Anthropic, item: ReadItem): Promise<{ result: Validation; usage: Usage }> {
  // output_config (effort) post-dates the pinned SDK's types; the SDK sends
  // body fields through unchanged, so it is added with a cast.
  const params = {
    model: DEAL_MODEL,
    // Room for adaptive thinking plus a ~300-token JSON answer.
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: userMessage(item) }],
    output_config: { effort: "low" },
  };
  const res = await client.messages.create(params as Parameters<Anthropic["messages"]["create"]>[0] & { stream?: false });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  return {
    result: validateExtraction(parseReply(text), item),
    usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
  };
}

/** Dollars for a run's token usage at Haiku 5.5 list price ($0.10 / $0.50 per million). */
export const usageCostUsd = (u: Usage) => (u.input * 0.1 + u.output * 0.5) / 1e6;
