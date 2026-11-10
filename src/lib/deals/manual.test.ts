import { describe, expect, it } from "vitest";
import { buildManualDeal, EMPTY_MANUAL_DEAL, isManualOnly, type ManualDealInput } from "./manual";
import { dedupKey, findMergeTarget } from "./score";
import type { StoredDeal } from "./types";

const NOW = "2026-11-10T11:00:00.000Z";
const TODAY = "2026-11-10";
const build = (over: Partial<ManualDealInput>) => buildManualDeal({ ...EMPTY_MANUAL_DEAL, ...over }, NOW, TODAY, "m1");

describe("buildManualDeal — a deal KP types in", () => {
  it("a points sale becomes a scored deals row with his note and link", () => {
    const r = build({ program: "marriott", pct: " 45% ", endsOn: "2026-11-23", link: "https://marriott.com/buy", note: "App-only" });
    if (!r.ok) throw new Error(r.error);
    expect(r.row).toMatchObject({
      kind: "buy_points", program: "marriott", from_bank: null, bonus_pct: 45, discount_pct: null,
      ends_on: "2026-11-23", headline: "Marriott Bonvoy: 45% bonus on bought points", evidence: "App-only",
      evidence_verified: true, first_seen_at: NOW, last_seen_at: NOW,
    });
    expect(r.row.sources).toEqual([{ kind: "manual", item_id: "m1", origin: "You",
      title: "Marriott Bonvoy: 45% bonus on bought points", url: "https://marriott.com/buy", seen_at: NOW }]);
    expect(r.row.dedup_key).toBe("buy_points|marriott|-|45|-|2026-11-23");
  });

  it("a discount is stored as discount, a transfer bonus names the bank", () => {
    const d = build({ program: "finnair", measure: "discount", pct: "50" });
    expect(d.ok && d.row).toMatchObject({ bonus_pct: null, discount_pct: 50, ends_on: null, headline: "Finnair Plus: 50% off buying Avios" });
    const t = build({ kind: "transfer_bonus", program: "accor", fromBank: "hdfc", pct: "30", measure: "discount" });
    // "measure" is ignored for transfers — they're always a bonus.
    expect(t.ok && t.row).toMatchObject({ kind: "transfer_bonus", from_bank: "hdfc", bonus_pct: 30, discount_pct: null,
      headline: "HDFC to Accor ALL: 30% transfer bonus" });
  });

  it("refuses what the database or common sense would reject, in plain words", () => {
    const err = (over: Partial<ManualDealInput>) => { const r = build(over); return r.ok ? null : r.error; };
    expect(err({ pct: "40" })).toBe("Pick the program.");
    expect(err({ program: "nope" as never, pct: "40" })).toBe("Pick the program.");
    expect(err({ kind: "transfer_bonus", program: "accor", pct: "30" })).toBe("Pick whose points get the bonus.");
    for (const pct of ["", "0", "-5", "abc", "4,5", "1e2"]) expect(err({ program: "hilton", pct })).toMatch(/as a number/);
    expect(err({ program: "hilton", pct: "300" })).toBeNull();
    expect(err({ program: "hilton", pct: "301" })).toMatch(/typo/);
    expect(err({ program: "hilton", measure: "discount", pct: "99.5" })).toBeNull();
    expect(err({ program: "hilton", measure: "discount", pct: "100" })).toMatch(/under 100%/);
    expect(err({ program: "hilton", pct: "40", endsOn: "2026-11-09" })).toMatch(/already passed/);
    expect(err({ program: "hilton", pct: "40", endsOn: TODAY })).toBeNull();
    expect(err({ program: "hilton", pct: "40", endsOn: "23/11/2026" })).toMatch(/valid date/);
    expect(err({ program: "hilton", pct: "40", link: "marriott.com" })).toMatch(/https/);
    expect(err({ program: "hilton", pct: "40", link: "javascript:alert(1)" })).toMatch(/https/);
  });

  it("the same offer found later in an email merges into his row, not a second card", () => {
    const r = build({ program: "marriott", pct: "55", endsOn: "2026-11-23" });
    if (!r.ok) throw new Error(r.error);
    const mine = { ...r.row, id: "x" } as StoredDeal;
    const found = { ...mine, sources: [], headline: "Marriott: up to 55%", evidence: "Get up to 55%", evidence_verified: true };
    expect(findMergeTarget(found, "2026-11-12T00:00:00Z", [mine])?.id).toBe("x");
    expect(dedupKey(found)).toBe(mine.dedup_key);
  });
});

describe("isManualOnly", () => {
  const s = (kind: "manual" | "email" | "blog") => ({ kind, item_id: kind, origin: "", title: "", url: null, seen_at: NOW });
  it("is true only when every source is KP's own", () => {
    expect(isManualOnly({ sources: [s("manual")] })).toBe(true);
    expect(isManualOnly({ sources: [s("manual"), s("email")] })).toBe(false);
    expect(isManualOnly({ sources: [s("blog")] })).toBe(false);
    expect(isManualOnly({ sources: [] })).toBe(false);
  });
});
