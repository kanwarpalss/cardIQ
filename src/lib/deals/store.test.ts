import { describe, it, expect } from "vitest";
import { planUpsert } from "./store";
import { dedupKey } from "./score";
import type { DealSource, ExtractedDeal, StoredDeal } from "./types";

const base: ExtractedDeal = {
  kind: "transfer_bonus", program: "aeroplan", from_bank: null, from_program: null, from_other: null,
  bonus_pct: 15, discount_pct: null, starts_on: null, ends_on: "2026-10-31", targeted: false,
  headline: "Aeroplan 15%", evidence: "get 15% more", evidence_verified: false,
};
const src = (id: string, seen: string, kind: DealSource["kind"] = "email"): DealSource =>
  ({ kind, item_id: id, origin: "o", title: "t", url: null, seen_at: seen });
const stored = (d: ExtractedDeal, s: DealSource): StoredDeal =>
  ({ ...d, id: "row1", dedup_key: dedupKey(d), sources: [s], first_seen_at: s.seen_at, last_seen_at: s.seen_at });

describe("planUpsert", () => {
  it("inserts a new offer with its first sighting", () => {
    const p = planUpsert(base, src("a", "2026-10-01T00:00:00Z"), []);
    expect(p.action).toBe("insert");
    if (p.action === "insert") expect(p.row).toMatchObject({ dedup_key: dedupKey(base), first_seen_at: "2026-10-01T00:00:00Z" });
  });

  it("re-reading the same email changes nothing", () => {
    const row = stored(base, src("a", "2026-10-01T00:00:00Z"));
    expect(planUpsert(base, src("a", "2026-10-01T00:00:00Z"), [row])).toEqual({ action: "unchanged", id: "row1" });
  });

  it("a second sighting adds its source, fills the missing source program, widens the dates, and re-keys", () => {
    const row = stored(base, src("a", "2026-10-05T00:00:00Z"));
    const named = { ...base, from_program: "marriott" as const, evidence_verified: true, evidence: "Convert your Marriott Bonvoy points to Aeroplan points and get 15% more." };
    const p = planUpsert(named, src("b", "2026-10-01T00:00:00Z"), [row]);
    expect(p.action).toBe("update");
    if (p.action !== "update") return;
    expect(p.row.sources.map((s) => s.item_id)).toEqual(["a", "b"]);
    expect(p.row.from_program).toBe("marriott");
    expect(p.row.first_seen_at).toBe("2026-10-01T00:00:00Z");
    expect(p.row.last_seen_at).toBe("2026-10-05T00:00:00Z");
    expect(p.row.evidence_verified).toBe(true);
    expect(p.row.evidence).toMatch(/Marriott Bonvoy/);
    expect(p.row.dedup_key).toBe(dedupKey(named));
  });

  it("never overwrites a fact the stored row already has", () => {
    const row = stored({ ...base, from_program: "marriott", evidence_verified: true, evidence: "kept" }, src("a", "2026-10-01T00:00:00Z"));
    const p = planUpsert({ ...base, ends_on: null, evidence: "other", evidence_verified: true }, src("b", "2026-10-02T00:00:00Z", "blog"), [row]);
    expect(p.action).toBe("update");
    if (p.action !== "update") return;
    expect(p.row).toMatchObject({ from_program: "marriott", ends_on: "2026-10-31", evidence: "kept" });
  });
});
