// Tests for lib/dining/normalize.ts.
//
// Covers:
//   - name normalisation (suffix stripping, punctuation, case)
//   - area normalisation
//   - haversine sanity + degenerate inputs
//   - levenshtein basics
//   - matchConfidence — the meaty one

import { describe, it, expect } from "vitest";
import {
  normalizeName,
  normalizeArea,
  haversineMeters,
  levenshtein,
  matchConfidence,
  areLikelySameRestaurant,
} from "./normalize";

// ────────────────────────────────────────────────────────────────────
describe("normalizeName", () => {
  it("strips trailing area in dash form", () => {
    expect(normalizeName("Toit - Indiranagar")).toBe("toit");
  });
  it("strips trailing area in parens form", () => {
    expect(normalizeName("The Permit Room (Koramangala)")).toBe("the permit room");
  });
  it("strips Pvt Ltd / LLP", () => {
    expect(normalizeName("Toit Brewpub Pvt. Ltd.")).toBe("toit");
    expect(normalizeName("Glen's Bakehouse LLP")).toBe("glen s bakehouse");
  });
  it("strips generic restaurant-type suffixes", () => {
    expect(normalizeName("Toit Brewpub")).toBe("toit");
    expect(normalizeName("Smoke House Deli Restaurant")).toBe("smoke house deli");
    expect(normalizeName("Truffles Cafe")).toBe("truffles");
  });
  it("iterates stripping multiple suffixes", () => {
    expect(normalizeName("Toit Brewpub - Indiranagar (1st floor)")).toBe("toit");
  });
  it("lowercases + collapses whitespace", () => {
    expect(normalizeName("  TOIT   BREWPUB  ")).toBe("toit");
  });
  it("preserves non-ASCII letters (e.g. café)", () => {
    // Normalised by NFKC then lowercased; "é" stays.
    expect(normalizeName("Café Noir")).toBe("café noir");
  });
  it("handles null / undefined / empty", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });
  it("does not over-strip — single-word names survive", () => {
    expect(normalizeName("Mainland")).toBe("mainland");
  });
  it("punctuation is stripped, not silently kept", () => {
    expect(normalizeName("Mc'Donald's & Co.")).toBe("mc donald s");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("normalizeArea", () => {
  it("strips stage/phase/cross/main markers", () => {
    expect(normalizeArea("Indiranagar 1st Stage")).toBe("indiranagar");
    expect(normalizeArea("HSR Layout 6th Sector")).toBe("hsr layout");
  });
  it("strips trailing city name", () => {
    expect(normalizeArea("Indiranagar, Bangalore")).toBe("indiranagar");
    expect(normalizeArea("Koramangala Bengaluru")).toBe("koramangala");
  });
  it("lowercases + de-punctuates", () => {
    expect(normalizeArea("M.G. Road")).toBe("m g road");
  });
  it("handles null / undefined", () => {
    expect(normalizeArea(null)).toBe("");
    expect(normalizeArea(undefined)).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    const p = { lat: 12.9716, lng: 77.5946 };
    expect(haversineMeters(p, p)).toBeCloseTo(0, 5);
  });
  it("returns ~111km for 1° of latitude on equator", () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 1, lng: 0 };
    const d = haversineMeters(a, b);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
  it("matches a known Bangalore pair to a sane distance", () => {
    // Indiranagar (≈12.9784, 77.6408) → Koramangala (≈12.9352, 77.6245)
    const a = { lat: 12.9784, lng: 77.6408 };
    const b = { lat: 12.9352, lng: 77.6245 };
    const d = haversineMeters(a, b);
    // Crow-flies is ~5km.
    expect(d).toBeGreaterThan(4_500);
    expect(d).toBeLessThan(5_500);
  });
  it("returns Infinity for missing inputs", () => {
    expect(haversineMeters(null, { lat: 0, lng: 0 })).toBe(Infinity);
    expect(haversineMeters({ lat: 0, lng: 0 }, undefined)).toBe(Infinity);
    expect(haversineMeters(null, null)).toBe(Infinity);
  });
  it("returns Infinity for NaN coordinates", () => {
    expect(haversineMeters({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 })).toBe(Infinity);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("levenshtein", () => {
  it("equal strings → 0", () => {
    expect(levenshtein("toit", "toit")).toBe(0);
  });
  it("one substitution", () => {
    expect(levenshtein("toit", "tort")).toBe(1);
  });
  it("one insertion", () => {
    expect(levenshtein("toit", "toits")).toBe(1);
  });
  it("empty against non-empty → length", () => {
    expect(levenshtein("", "toit")).toBe(4);
    expect(levenshtein("toit", "")).toBe(4);
    expect(levenshtein("", "")).toBe(0);
  });
  it("classic kitten/sitting → 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("matchConfidence", () => {
  const toitZom = { name: "Toit Brewpub", area: "Indiranagar", lat: 12.9784, lng: 77.6408 };
  const toitSwg = { name: "Toit - Indiranagar", area: "Indiranagar", lat: 12.9785, lng: 77.6409 };
  const toitFar = { name: "Toit Brewpub", area: "Whitefield", lat: 12.9698, lng: 77.7500 };

  it("exact name + co-located → definite", () => {
    expect(matchConfidence(toitZom, toitSwg)).toBe("definite");
  });

  it("exact name + ~5km apart (different outlet) → no", () => {
    // 12.97/77.64 → 12.97/77.75 is ~12km, well past the 5km guardrail
    expect(matchConfidence(toitZom, toitFar)).toBe("no");
  });

  it("typo'd name + co-located → definite or likely", () => {
    const a = { name: "Glen's Bakehouse", lat: 12.9784, lng: 77.6408 };
    const b = { name: "Glens Bakehouse", lat: 12.9785, lng: 77.6409 };
    const c = matchConfidence(a, b);
    expect(["definite", "likely"]).toContain(c);
  });

  it("name match + no geo on either side → maybe (we don't auto-merge)", () => {
    const a = { name: "Toit Brewpub" };
    const b = { name: "Toit Brewpub" };
    expect(matchConfidence(a, b)).toBe("maybe");
  });

  it("name match + no geo + same area string → likely", () => {
    const a = { name: "Toit Brewpub", area: "Indiranagar" };
    const b = { name: "Toit Brewpub", area: "Indiranagar 1st Stage" };
    expect(matchConfidence(a, b)).toBe("likely");
  });

  it("totally different names → no, even if co-located", () => {
    const a = { name: "Toit Brewpub", lat: 12.9784, lng: 77.6408 };
    const b = { name: "Smoke House Deli", lat: 12.9784, lng: 77.6408 };
    expect(matchConfidence(a, b)).toBe("no");
  });

  it("one name is prefix of the other + co-located → likely", () => {
    const a = { name: "The Permit Room", lat: 12.9352, lng: 77.6245 };
    const b = { name: "The Permit Room EC", lat: 12.9353, lng: 77.6246 };
    const c = matchConfidence(a, b);
    expect(["likely", "definite"]).toContain(c);
  });

  it("empty names → no", () => {
    expect(matchConfidence({ name: "" }, { name: "Toit" })).toBe("no");
    expect(matchConfidence({ name: "Toit" }, { name: "" })).toBe("no");
  });

  it("chain restaurants at different outlets do NOT merge", () => {
    // Theobroma — same brand, two outlets ~5km apart in Bangalore.
    // We DON'T want to merge them; either 'no' or 'maybe' satisfies that.
    const indiranagar = { name: "Theobroma", lat: 12.9784, lng: 77.6408 };
    const koramangala = { name: "Theobroma", lat: 12.9352, lng: 77.6245 };
    const c = matchConfidence(indiranagar, koramangala);
    expect(["no", "maybe"]).toContain(c);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("areLikelySameRestaurant", () => {
  it("returns true for definite + likely confidences", () => {
    const a = { name: "Toit Brewpub", lat: 12.9784, lng: 77.6408 };
    const b = { name: "Toit - Indiranagar", lat: 12.9785, lng: 77.6409 };
    expect(areLikelySameRestaurant(a, b)).toBe(true);
  });
  it("returns false for maybe + no confidences", () => {
    const a = { name: "Toit Brewpub" };
    const b = { name: "Toit Brewpub" };
    // No geo at all → maybe → not "likely"
    expect(areLikelySameRestaurant(a, b)).toBe(false);
  });
});
