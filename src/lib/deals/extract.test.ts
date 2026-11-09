import { describe, it, expect } from "vitest";
import { validateExtraction, parseReply, userMessage, bestBodyText, MAX_SOURCE_CHARS, type ReadItem } from "./extract";
import { stripHtml } from "@/lib/gmail/strip";
import { parseRss, decodeEntities } from "./feeds";

const item = (text: string, over: Partial<ReadItem> = {}): ReadItem => ({
  kind: "email",
  origin: "Marriott-Bonvoy@points-mail.com",
  title: "Your 55% Bonus Points Offer Is Going Fast",
  seen_at: "2026-10-14T15:08:55.000Z",
  text,
  ...over,
});

const MARRIOTT = "Buy or gift points before the bonus is reduced. Get up to 55% bonus points when you buy 2,000 or more points by 22 October 2026.";

const reply = (over: Record<string, unknown> = {}) => ({
  is_deal: true, kind: "buy_points", program: "marriott",
  from_bank: null, from_program: null, from_other: null,
  bonus_pct: 55, discount_pct: null, starts_on: null, ends_on: "2026-10-22",
  targeted: false, evidence: "Get up to 55% bonus points when you buy 2,000 or more points",
  headline: "Marriott Bonvoy: up to 55% bonus on bought points",
  ...over,
});

describe("validateExtraction — the model's answer is checked against the source", () => {
  it("keeps a well-supported buy-points deal", () => {
    const v = validateExtraction(reply(), item(MARRIOTT));
    expect(v.deal).toMatchObject({ kind: "buy_points", program: "marriott", bonus_pct: 55, ends_on: "2026-10-22", evidence_verified: true });
  });

  it("drops a bonus figure the text never states (no hallucinated 60%)", () => {
    const v = validateExtraction(reply({ bonus_pct: 60 }), item(MARRIOTT));
    expect(v.deal?.bonus_pct).toBeNull();
  });

  it("does not read 155% as a 55% bonus, or 5% inside 55%", () => {
    expect(validateExtraction(reply({ bonus_pct: 55 }), item("buy now: 155% more points", { title: "x" })).deal?.bonus_pct).toBeNull();
    expect(validateExtraction(reply({ bonus_pct: 5 }), item(MARRIOTT)).deal?.bonus_pct).toBeNull();
  });

  it("accepts '55 per cent' and a string '55%'", () => {
    expect(validateExtraction(reply({ bonus_pct: "55%" }), item("buy with a 55 per cent bonus", { title: "x" })).deal?.bonus_pct).toBe(55);
  });

  it("rejects programs outside the catalog and unknown kinds", () => {
    expect(validateExtraction(reply({ program: "hyatt" }), item(MARRIOTT)).deal).toBeNull();
    expect(validateExtraction(reply({ kind: "status_match" }), item(MARRIOTT)).deal).toBeNull();
  });

  it("returns no deal when the model says it isn't one, or the reply is junk", () => {
    expect(validateExtraction(reply({ is_deal: false }), item(MARRIOTT)).deal).toBeNull();
    expect(validateExtraction(null, item(MARRIOTT)).deal).toBeNull();
    expect(validateExtraction("yes", item(MARRIOTT)).deal).toBeNull();
    expect(validateExtraction(reply({ is_deal: "true" }), item(MARRIOTT)).deal).toBeNull();
  });

  it("refuses a transfer bonus with two sources (which one is it on?)", () => {
    const v = validateExtraction(
      reply({ kind: "transfer_bonus", program: "accor", from_bank: "axis", from_program: "krisflyer", bonus_pct: 50 }),
      item("Convert KrisFlyer miles to Accor with a 50% bonus"));
    expect(v.deal).toBeNull();
  });

  it("clears transfer sources on a buy-points deal and a self-referencing source", () => {
    const buy = validateExtraction(reply({ from_bank: "hdfc" }), item(MARRIOTT));
    expect(buy.deal?.from_bank).toBeNull();
    const self = validateExtraction(
      reply({ kind: "transfer_bonus", program: "accor", from_program: "accor", bonus_pct: 50 }),
      item("Convert to Accor with a 50% bonus"));
    expect(self.deal?.from_program).toBeNull();
  });

  it("discards an end date before the email arrived (wrong year for '9/9') and impossible dates", () => {
    expect(validateExtraction(reply({ ends_on: "2025-10-22" }), item(MARRIOTT)).deal?.ends_on).toBeNull();
    expect(validateExtraction(reply({ ends_on: "2026-02-30" }), item(MARRIOTT)).deal?.ends_on).toBeNull();
    expect(validateExtraction(reply({ ends_on: "22/10/2026" }), item(MARRIOTT)).deal?.ends_on).toBeNull();
    expect(validateExtraction(reply({ ends_on: "2029-01-01" }), item(MARRIOTT)).deal?.ends_on).toBeNull();
  });

  it("flags evidence the source doesn't contain, but keeps the deal", () => {
    const v = validateExtraction(reply({ evidence: "Buy now and get double points forever" }), item(MARRIOTT));
    expect(v.deal?.evidence_verified).toBe(false);
  });

  it("matches evidence across curly quotes and spacing", () => {
    const v = validateExtraction(reply({ evidence: "Don't   miss: 55% bonus" }), item("Don’t miss: 55% bonus when you buy", { title: "t" }));
    expect(v.deal?.evidence_verified).toBe(true);
  });

  it("only keeps a discount on buy-points deals", () => {
    const v = validateExtraction(reply({ bonus_pct: null, discount_pct: 50 }), item("Buy Finnair Plus Avios with a 50% Discount", { title: "t" }));
    expect(v.deal?.discount_pct).toBe(50);
    const t = validateExtraction(reply({ kind: "transfer_bonus", program: "accor", bonus_pct: null, discount_pct: 50 }), item("50% off transfers to accor", { title: "t" }));
    expect(t.deal?.discount_pct).toBeNull();
  });
});

describe("validateExtraction — guards found on real mail (9 Nov 2026 dry run)", () => {
  it("refuses a 'points sale' whose text never mentions buying (a KrisFlyer conversion email)", () => {
    const v = validateExtraction(
      reply({ bonus_pct: 10, evidence: "Enjoy 10% bonus Marriott Bonvoy® points this September" }),
      item("Convert your KrisFlyer miles to unlock your next hotel stay", { title: "Enjoy 10% bonus Marriott Bonvoy® points this September" }));
    expect(v).toEqual({ deal: null, reason: "called a points sale, but the text never mentions buying" });
  });

  it("verifies evidence through the invisible padding marketing emails use", () => {
    const text = "Get up to 50% bonus points when you buy or gift points, now through\u034f 9\u200b September.";
    const v = validateExtraction(reply({ bonus_pct: 50, evidence: "now through 9 September." }), item(text, { title: "t" }));
    expect(v.deal?.evidence_verified).toBe(true);
  });
});

describe("bestBodyText", () => {
  const html = `<html><style>p{color:red}</style><p>Enjoy 50% bonus rewards when you convert KrisFlyer miles to ALL Accor points.</p><p>Offer ends 30 September 2026.</p>${"<p>More detail about the conversion.</p>".repeat(5)}</html>`;
  it("uses the HTML when the plain-text part is a stub ('undefined', Singapore Airlines)", () => {
    const t = bestBodyText("undefined ", html, stripHtml);
    expect(t).toContain("Offer ends 30 September 2026");
    expect(t).not.toContain("color:red");
  });
  it("keeps a real plain-text body", () => {
    const real = "Buy points now. ".repeat(20);
    expect(bestBodyText(real, html, stripHtml)).toBe(real.trim());
  });
  it("copes with missing parts", () => {
    expect(bestBodyText(undefined, undefined, stripHtml)).toBe("");
    expect(bestBodyText(null, html, stripHtml)).toContain("Offer ends");
    expect(bestBodyText("short but real", "", stripHtml)).toBe("short but real");
  });
});

describe("parseReply", () => {
  it("reads JSON inside a code fence and ignores chatter", () => {
    expect(parseReply('Sure!\n```json\n{"is_deal": false}\n```')).toEqual({ is_deal: false });
  });
  it("returns null for no JSON or broken JSON", () => {
    expect(parseReply("no")).toBeNull();
    expect(parseReply("{is_deal: true")).toBeNull();
  });
});

describe("userMessage", () => {
  it("caps the source text sent to the model", () => {
    const msg = userMessage(item("x".repeat(MAX_SOURCE_CHARS + 5000)));
    expect(msg.length).toBeLessThan(MAX_SOURCE_CHARS + 500);
    expect(msg).toContain("Item date: 2026-10-14");
  });
});

describe("parseRss", () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Blog</title>
    <item><title>Amex Membership Rewards Just Got Better: Improved Transfers to Virgin Atlantic &#038; Hilton</title>
      <link>https://www.cardexpert.in/amex-mr/</link><pubDate>Thu, 20 Aug 2026 17:34:05 +0000</pubDate>
      <description><![CDATA[<p>Amex improved its ratio to Hilton&#8217;s program&hellip;</p>]]></description></item>
    <item><title>No link here</title></item>
    <item><title><![CDATA[Deal: Buy Finnair Plus Avios with a 50% Discount]]></title>
      <link>https://www.livefromalounge.com/finnair</link><pubDate>not a date</pubDate>
      <description>&lt;p&gt;Encoded &amp;amp; HTML&lt;/p&gt;</description></item>
  </channel></rss>`;

  it("reads titles, links, dates and summaries, decoding entities", () => {
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Amex Membership Rewards Just Got Better: Improved Transfers to Virgin Atlantic & Hilton",
      link: "https://www.cardexpert.in/amex-mr/",
      published: "2026-08-20T17:34:05.000Z",
    });
    expect(items[0].summary).toBe("Amex improved its ratio to Hilton’s program…");
    expect(items[1]).toMatchObject({ title: "Deal: Buy Finnair Plus Avios with a 50% Discount", published: null, summary: "Encoded &amp; HTML" });
  });

  it("returns [] for HTML error pages and non-strings", () => {
    expect(parseRss("<html><body>403 Forbidden</body></html>")).toEqual([]);
    expect(parseRss(undefined as unknown as string)).toEqual([]);
  });

  it("leaves malformed numeric entities alone instead of throwing", () => {
    expect(decodeEntities("a &#99999999; b &#x0; c")).toBe("a &#99999999; b &#x0; c");
  });
});
