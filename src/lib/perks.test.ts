import { describe, it, expect } from "vitest";
import {
  latestBalanceByCard,
  estimatePoints,
  effectiveOfferStatus,
  sortOffersForDisplay,
  expiryState,
  type RewardBalanceRow,
  type OfferRow,
} from "./perks";

// Local (not UTC) YYYY-MM-DD, offset by n days from today — expiry logic is
// local-midnight based, so tests must generate dates the same way.
function localYmd(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const bal = (over: Partial<RewardBalanceRow>): RewardBalanceRow => ({
  id: "x", card_id: "c1", program: "P", balance: 0, as_of: "2026-01-01",
  notes: null, created_at: "2026-01-01T00:00:00Z", ...over,
});

const offer = (over: Partial<OfferRow>): OfferRow => ({
  id: "x", card_id: null, title: "T", merchant: null, description: null,
  valid_from: null, valid_until: null, source_url: null, status: "active",
  created_at: "2026-01-01T00:00:00Z", ...over,
});

describe("latestBalanceByCard", () => {
  it("returns empty map for no rows", () => {
    expect(latestBalanceByCard([]).size).toBe(0);
  });

  it("picks the newest as_of per card", () => {
    const rows = [
      bal({ id: "old", card_id: "c1", as_of: "2026-01-01", balance: 100 }),
      bal({ id: "new", card_id: "c1", as_of: "2026-06-01", balance: 250 }),
      bal({ id: "other", card_id: "c2", as_of: "2026-03-01", balance: 999 }),
    ];
    const latest = latestBalanceByCard(rows);
    expect(latest.get("c1")?.id).toBe("new");
    expect(latest.get("c2")?.id).toBe("other");
  });

  it("breaks same-day ties by created_at (two entries entered the same day)", () => {
    const rows = [
      bal({ id: "morning", as_of: "2026-06-01", created_at: "2026-06-01T08:00:00Z" }),
      bal({ id: "evening", as_of: "2026-06-01", created_at: "2026-06-01T20:00:00Z" }),
    ];
    expect(latestBalanceByCard(rows).get("c1")?.id).toBe("evening");
  });
});

describe("estimatePoints", () => {
  const edge = { program: "EDGE", earn_summary: "", points_per_unit: 12, unit_inr: 200 };

  it("floors partial units: ₹399 at 12/₹200 = 12 pts, not 23.94", () => {
    expect(estimatePoints(399, edge)).toBe(12);
  });

  it("handles exact multiples", () => {
    expect(estimatePoints(150_000, edge)).toBe(9000);
  });

  it("returns 0 for zero, negative spend, and zero-unit guard", () => {
    expect(estimatePoints(0, edge)).toBe(0);
    expect(estimatePoints(-500, edge)).toBe(0);
    expect(estimatePoints(1000, { ...edge, unit_inr: 0 })).toBe(0);
  });
});

describe("effectiveOfferStatus", () => {
  it("null valid_until stays active forever — never reads as expiring", () => {
    expect(effectiveOfferStatus(offer({ valid_until: null }))).toBe("active");
  });

  it("expiring TODAY is still active (boundary)", () => {
    expect(effectiveOfferStatus(offer({ valid_until: localYmd(0) }))).toBe("active");
  });

  it("past valid_until displays as expired even if stored status is active", () => {
    expect(effectiveOfferStatus(offer({ valid_until: localYmd(-1) }))).toBe("expired");
  });

  it("used/archived are never overridden by dates", () => {
    expect(effectiveOfferStatus(offer({ status: "used", valid_until: localYmd(-10) }))).toBe("used");
    expect(effectiveOfferStatus(offer({ status: "archived", valid_until: localYmd(-10) }))).toBe("archived");
  });
});

describe("sortOffersForDisplay", () => {
  it("active first (soonest expiry first, no-expiry last), then used, expired, archived", () => {
    const list = [
      offer({ id: "noexp", title: "No expiry", valid_until: null }),
      offer({ id: "arch", title: "Archived", status: "archived" }),
      offer({ id: "gone", title: "Lapsed", valid_until: localYmd(-5) }), // active but lapsed
      offer({ id: "soon", title: "Soon", valid_until: localYmd(3) }),
      offer({ id: "later", title: "Later", valid_until: localYmd(60) }),
      offer({ id: "used", title: "Used", status: "used" }),
    ];
    expect(sortOffersForDisplay(list).map((o) => o.id)).toEqual([
      "soon", "later", "noexp", "used", "gone", "arch",
    ]);
  });

  it("does not mutate the input array", () => {
    const list = [offer({ id: "b", title: "B" }), offer({ id: "a", title: "A" })];
    const before = list.map((o) => o.id);
    sortOffersForDisplay(list);
    expect(list.map((o) => o.id)).toEqual(before);
  });
});

describe("expiryState", () => {
  it("no date → none (not expired, not soon)", () => {
    expect(expiryState(null)).toEqual({ kind: "none" });
  });

  it("past date → expired with positive day count, never a negative countdown", () => {
    const s = expiryState(localYmd(-45));
    expect(s.kind).toBe("expired");
    expect(s.kind === "expired" && s.days).toBe(45);
  });

  it("today and within-window → soon; boundary day 30 is soon, 31 is ok", () => {
    expect(expiryState(localYmd(0)).kind).toBe("soon");
    expect(expiryState(localYmd(30)).kind).toBe("soon");
    expect(expiryState(localYmd(31)).kind).toBe("ok");
  });
});
