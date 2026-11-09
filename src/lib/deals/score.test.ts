import { describe, it, expect } from "vitest";
import { TRANSFER_SPECS } from "@/lib/transfer-partners/cards";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import {
  assessDeal, rankDeals, multiplierOf, dedupKey, findMergeTarget, type ScoreCard,
} from "./score";
import type { StoredDeal } from "./types";

// KP's actual wallet (cards table, 9 Nov 2026) — no Amex.
const WALLET: ScoreCard[] = [
  "axis_magnus_burgundy", "hdfc_infinia", "icici_emeralde_private_metal",
  "hdfc_swiggy", "hsbc_premier", "hsbc_travelone",
].map((k) => ({ product_key: k, short: k, issuer: CARD_REGISTRY[k].issuer, spec: TRANSFER_SPECS[k] }));

let n = 0;
const deal = (over: Partial<StoredDeal> = {}): StoredDeal => {
  const d: StoredDeal = {
    id: `d${++n}`, dedup_key: "", kind: "transfer_bonus", program: "accor",
    from_bank: null, from_program: null, from_other: null,
    bonus_pct: 30, discount_pct: null, starts_on: null, ends_on: "2026-11-30",
    targeted: false, headline: "h", evidence: "e", evidence_verified: true,
    sources: [{ kind: "email", item_id: "x", origin: "o", title: "t", url: null, seen_at: "2026-11-01T00:00:00Z" }],
    first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z",
    ...over,
  };
  return { ...d, dedup_key: dedupKey(d) };
};

const TODAY = "2026-11-09";
const assess = (d: StoredDeal, history: StoredDeal[] = []) => assessDeal(d, WALLET, history, TODAY);

describe("reach — can KP use it with his cards?", () => {
  it("a bank bonus to a partner his card has: shows the miles with and without the bonus", () => {
    // HDFC Infinia → Accor is 2:1, so 1,00,000 points → 50,000; +30% → 65,000.
    const a = assess(deal({ from_bank: "hdfc", program: "accor", bonus_pct: 30 }));
    expect(a.reach).toBe("yours");
    const infinia = a.routes.find((r) => r.card === "hdfc_infinia");
    expect(infinia).toMatchObject({ via: "accor", normal: 50000, boosted: 65000 });
    // Swiggy is a cashback card: no Accor route, must not appear.
    expect(a.routes.some((r) => r.card === "hdfc_swiggy")).toBe(false);
  });

  it("a bank bonus from a bank he doesn't hold is not his", () => {
    expect(assess(deal({ from_bank: "amex", program: "marriott" })).reach).toBe("not_yours");
  });

  it("his bank, but a partner that bank doesn't offer, is not his", () => {
    // ICICI Emeralde only transfers to Air India.
    const a = assess(deal({ from_bank: "icici", program: "accor" }));
    expect(a.reach).toBe("not_yours");
    expect(a.reachNote).toMatch(/don't transfer to Accor/);
  });

  it("KrisFlyer → Accor 50%: reachable in two steps, without inventing the second leg's total", () => {
    const a = assess(deal({ from_program: "krisflyer", program: "accor", bonus_pct: 50 }));
    expect(a.reach).toBe("yours");
    expect(a.reachNote).toMatch(/KrisFlyer → Accor/);
    const axis = a.routes.find((r) => r.card === "axis_magnus_burgundy");
    expect(axis).toMatchObject({ via: "krisflyer", normal: null, boosted: null });
    expect(a.routes.map((r) => r.card)).toContain("hdfc_infinia");
  });

  it("a bonus on someone else's currency (Flipkart SuperCoins) is never his", () => {
    expect(assess(deal({ from_other: "Flipkart SuperCoins", program: "accor" })).reach).toBe("not_yours");
  });

  it("buying points is always open — with cash", () => {
    expect(assess(deal({ kind: "buy_points", program: "marriott", bonus_pct: 55 })).reach).toBe("buy");
  });

  it("a source-less transfer bonus counts if any card reaches the program", () => {
    expect(assess(deal({ program: "accor" })).reach).toBe("yours");
    expect(assess(deal({ program: "hainan" })).reach).toBe("yours");     // HSBC → Hainan
    expect(assess(deal({ program: "virgin" })).reach).toBe("not_yours"); // Amex-only partner
  });

  it("a ratio change at his bank is flagged even without a matching partner", () => {
    const a = assess(deal({ kind: "ratio_change", from_bank: "axis", program: "marriott", bonus_pct: null }));
    expect(a.reach).toBe("yours");
    expect(a.reachNote).toMatch(/partner data may need updating/);
  });
});

describe("status — is it still running?", () => {
  it("ended yesterday is ended; ending today is ending soon", () => {
    expect(assess(deal({ ends_on: "2026-11-08" })).status).toBe("ended");
    expect(assess(deal({ ends_on: "2026-11-09" }))).toMatchObject({ status: "ending_soon", daysLeft: 0 });
    expect(assess(deal({ ends_on: "2026-11-12" })).status).toBe("ending_soon");
    expect(assess(deal({ ends_on: "2026-11-13" })).status).toBe("active");
  });

  it("no end date: live while recently seen, then retired", () => {
    expect(assess(deal({ ends_on: null, last_seen_at: "2026-11-01T00:00:00Z" })).status).toBe("no_end_date");
    expect(assess(deal({ ends_on: null, last_seen_at: "2026-10-01T00:00:00Z" })).status).toBe("ended");
  });
});

describe("grade — is it actually good, against his own history?", () => {
  const marriott = (pct: number, seen: string) =>
    deal({ kind: "buy_points", program: "marriott", bonus_pct: pct, first_seen_at: seen, last_seen_at: seen, ends_on: null });

  it("first of its kind has no comparison", () => {
    const d = marriott(45, "2026-11-04T00:00:00Z");
    expect(assess(d, [d]).grade).toBe("first_seen");
  });

  it("45% after a 50% and two 55% offers is weaker than usual; 60% is a new high", () => {
    const hist = [marriott(50, "2026-08-05T00:00:00Z"), marriott(55, "2026-09-30T00:00:00Z"), marriott(55, "2026-10-14T00:00:00Z")];
    const now45 = marriott(45, "2026-11-04T00:00:00Z");
    const a = assess(now45, [...hist, now45]);
    expect(a.grade).toBe("below_usual");
    expect(a.gradeNote).toMatch(/best of 3 earlier offers since Aug 2026 was 55%/);
    const now60 = marriott(60, "2026-11-04T00:00:00Z");
    expect(assess(now60, [...hist, now60]).grade).toBe("new_high");
    const now55 = marriott(55, "2026-11-04T00:00:00Z");
    expect(assess(now55, [...hist, now55]).grade).toBe("matches_best");
  });

  it("only compares like with like, and ignores later or very old offers", () => {
    const hilton = deal({ kind: "buy_points", program: "hilton", bonus_pct: 100, first_seen_at: "2026-07-20T00:00:00Z" });
    const later = deal({ kind: "buy_points", program: "marriott", bonus_pct: 70, first_seen_at: "2026-12-01T00:00:00Z" });
    const ancient = deal({ kind: "buy_points", program: "marriott", bonus_pct: 80, first_seen_at: "2025-01-01T00:00:00Z" });
    const d = marriott(45, "2026-11-04T00:00:00Z");
    expect(assess(d, [hilton, later, ancient, d]).grade).toBe("first_seen");
  });

  it("a 50% discount ranks above a 55% bonus (twice the points for the money)", () => {
    expect(multiplierOf({ bonus_pct: null, discount_pct: 50 })).toBe(2);
    expect(multiplierOf({ bonus_pct: 55, discount_pct: null })).toBe(1.55);
    expect(multiplierOf({ bonus_pct: null, discount_pct: null })).toBeNull();
    expect(multiplierOf({ bonus_pct: null, discount_pct: 100 })).toBeNull();
  });

  it("no figure → no grade, rather than a made-up one", () => {
    expect(assess(deal({ bonus_pct: null })).grade).toBeNull();
  });
});

describe("verified", () => {
  it("is true only for an email whose quote was found in it", () => {
    expect(assess(deal()).verified).toBe(true);
    expect(assess(deal({ evidence_verified: false })).verified).toBe(false);
    expect(assess(deal({ sources: [{ kind: "blog", item_id: "u", origin: "CardExpert", title: "t", url: "u", seen_at: "2026-11-01T00:00:00Z" }] })).verified).toBe(false);
  });
});

describe("findMergeTarget — one offer seen twice stays one row", () => {
  const email = deal({ from_program: "krisflyer", bonus_pct: 50, ends_on: "2026-09-30", first_seen_at: "2026-09-09T00:00:00Z" });

  it("folds a blog post without an end date into the email that had one", () => {
    const blog = { ...email, ends_on: null };
    expect(findMergeTarget(blog, "2026-09-12T00:00:00Z", [email])?.id).toBe(email.id);
  });

  it("keeps different figures, different sources and far-apart repeats separate", () => {
    expect(findMergeTarget({ ...email, bonus_pct: 30 }, "2026-09-12T00:00:00Z", [email])).toBeNull();
    expect(findMergeTarget({ ...email, from_program: null, from_bank: "axis" }, "2026-09-12T00:00:00Z", [email])).toBeNull();
    expect(findMergeTarget({ ...email, ends_on: "2026-10-31" }, "2026-09-12T00:00:00Z", [email])).toBeNull();
    expect(findMergeTarget(email, "2027-03-01T00:00:00Z", [email])).toBeNull();
  });

  it("folds a mention that didn't name the source into one that did (Bonvoy → Aeroplan 15%)", () => {
    const named = deal({ program: "aeroplan", from_program: "marriott", bonus_pct: 15, ends_on: "2026-10-31", first_seen_at: "2026-10-01T00:00:00Z" });
    const unnamed = { ...named, from_program: null };
    expect(findMergeTarget(unnamed, "2026-10-03T00:00:00Z", [named])?.id).toBe(named.id);
    expect(findMergeTarget(named, "2026-10-03T00:00:00Z", [{ ...unnamed, id: "u" }])?.id).toBe("u");
  });

  it("never lets a figure-less mention absorb into a deal with a figure", () => {
    expect(findMergeTarget({ ...email, bonus_pct: null }, "2026-09-12T00:00:00Z", [email])).toBeNull();
  });
});

describe("rankDeals", () => {
  it("live and usable first, then cash buys, then not-yours, ended last", () => {
    const rows = [
      { id: "ended", assessment: assess(deal({ from_bank: "hdfc", ends_on: "2026-10-01" })) },
      { id: "other", assessment: assess(deal({ from_other: "HeyMax" })) },
      { id: "buy", assessment: assess(deal({ kind: "buy_points", program: "marriott" })) },
      { id: "mine-later", assessment: assess(deal({ from_bank: "hdfc", ends_on: "2026-11-30" })) },
      { id: "mine-soon", assessment: assess(deal({ from_bank: "hdfc", ends_on: "2026-11-15" })) },
    ];
    expect(rankDeals(rows).map((r) => r.id)).toEqual(["mine-soon", "mine-later", "buy", "other", "ended"]);
  });
});
