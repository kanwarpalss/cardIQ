// Tests for lib/dining/dedupe.ts.
//
// Synthetic restaurants + scenarios — no Supabase, no network.

import { describe, it, expect } from "vitest";
import {
  preFilterCandidates,
  resolveListing,
  findMergeCandidates,
  IncomingListing,
  CanonicalCandidate,
  ManualLink,
} from "./dedupe";

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

const toitCanon: CanonicalCandidate = {
  id: "canon-toit",
  canonicalName: "Toit Brewpub",
  area: "Indiranagar",
  lat: 12.9784,
  lng: 77.6408,
  linkedListings: [{ platform: "zomato", externalId: "z-toit-1" }],
};

const smokeHouseCanon: CanonicalCandidate = {
  id: "canon-smoke",
  canonicalName: "Smoke House Deli",
  area: "Indiranagar",
  lat: 12.9787,
  lng: 77.6411,
  linkedListings: [{ platform: "zomato", externalId: "z-smoke-1" }],
};

const farAwayCanon: CanonicalCandidate = {
  id: "canon-far",
  canonicalName: "Toit Brewpub",
  area: "Whitefield",
  lat: 12.9698,
  lng: 77.7500,
  linkedListings: [{ platform: "zomato", externalId: "z-toit-wf" }],
};

const incomingSwiggyToit: IncomingListing = {
  platform: "swiggy",
  externalId: "s-toit-7",
  name: "Toit - Indiranagar",
  area: "Indiranagar",
  lat: 12.9785,
  lng: 77.6409,
};

// ────────────────────────────────────────────────────────────────────
describe("preFilterCandidates", () => {
  it("keeps a candidate within geo radius", () => {
    const out = preFilterCandidates(incomingSwiggyToit, [toitCanon, farAwayCanon]);
    const ids = out.map((c) => c.id);
    expect(ids).toContain("canon-toit");
    expect(ids).not.toContain("canon-far"); // ~12km away
  });

  it("keeps a candidate that matches by area even without geo", () => {
    const noGeo: CanonicalCandidate = {
      id: "no-geo", canonicalName: "Toit", area: "Indiranagar",
      lat: null, lng: null, linkedListings: [],
    };
    const out = preFilterCandidates(incomingSwiggyToit, [noGeo]);
    expect(out.map((c) => c.id)).toContain("no-geo");
  });

  it("keeps a candidate when both sides are geo-less + area-less (no info to filter on)", () => {
    const incoming: IncomingListing = {
      platform: "eazydiner", externalId: "e-x", name: "Whatever",
    };
    const candidate: CanonicalCandidate = {
      id: "x", canonicalName: "Whatever", linkedListings: [],
    };
    const out = preFilterCandidates(incoming, [candidate]);
    expect(out.map((c) => c.id)).toContain("x");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("resolveListing — basic matching", () => {
  it("attaches a Swiggy listing to an existing Zomato Toit canonical (definite)", () => {
    const action = resolveListing(incomingSwiggyToit, [toitCanon, smokeHouseCanon]);
    expect(action.kind).toBe("attach");
    if (action.kind === "attach") {
      expect(action.canonicalId).toBe("canon-toit");
      expect(action.confidence).toBe("definite");
    }
  });

  it("creates a new canonical when no candidate matches", () => {
    const incoming: IncomingListing = {
      platform: "swiggy", externalId: "s-new-1", name: "Unknown Place",
      area: "Indiranagar", lat: 12.978, lng: 77.640,
    };
    const action = resolveListing(incoming, [toitCanon, smokeHouseCanon]);
    expect(action.kind).toBe("create");
  });

  it("returns attach_for_review when confidence is only 'maybe'", () => {
    // Same name, no geo on either side → 'maybe' per normalize.ts policy
    const incoming: IncomingListing = {
      platform: "swiggy", externalId: "s-toit-x", name: "Toit Brewpub",
    };
    const candidate: CanonicalCandidate = {
      id: "c-toit", canonicalName: "Toit Brewpub",
      area: null, lat: null, lng: null,
      linkedListings: [{ platform: "zomato", externalId: "z-toit-9" }],
    };
    const action = resolveListing(incoming, [candidate]);
    expect(action.kind).toBe("attach_for_review");
    if (action.kind === "attach_for_review") {
      expect(action.canonicalId).toBe("c-toit");
      expect(action.candidatePair.aPlatform).toBe("swiggy");
      expect(action.candidatePair.bPlatform).toBe("zomato");
    }
  });

  it("picks the highest-confidence candidate when multiple match", () => {
    const closeCanon: CanonicalCandidate = {
      ...toitCanon, id: "canon-close", lat: 12.9785, lng: 77.6409, // 0m
    };
    const farishCanon: CanonicalCandidate = {
      ...toitCanon, id: "canon-farish", lat: 12.9810, lng: 77.6420, // ~300m
      linkedListings: [{ platform: "zomato", externalId: "z-toit-other" }],
    };
    const action = resolveListing(incomingSwiggyToit, [farishCanon, closeCanon]);
    expect(action.kind).toBe("attach");
    if (action.kind === "attach") expect(action.canonicalId).toBe("canon-close");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("resolveListing — manual overrides", () => {
  it("honours a 'same' override even when matcher disagrees", () => {
    // Names look totally different. Matcher would say 'no'.
    const incoming: IncomingListing = {
      platform: "eazydiner", externalId: "e-xyz", name: "Totally Different Name",
      lat: 50.0, lng: 50.0, // also wildly different geo
    };
    const candidate: CanonicalCandidate = {
      id: "c-1", canonicalName: "Some Other Place",
      lat: 12.9, lng: 77.6,
      linkedListings: [{ platform: "swiggy", externalId: "s-target" }],
    };
    const links: ManualLink[] = [
      { platformA: "eazydiner", externalIdA: "e-xyz",
        platformB: "swiggy", externalIdB: "s-target",
        decision: "same" },
    ];
    const action = resolveListing(incoming, [candidate], links);
    expect(action.kind).toBe("attach_by_override");
    if (action.kind === "attach_by_override") expect(action.canonicalId).toBe("c-1");
  });

  it("honours a 'different' override even when matcher says 'definite'", () => {
    const links: ManualLink[] = [
      { platformA: "swiggy", externalIdA: "s-toit-7",
        platformB: "zomato", externalIdB: "z-toit-1",
        decision: "different" },
    ];
    const action = resolveListing(incomingSwiggyToit, [toitCanon], links);
    // Best candidate excluded → no candidates left → create new
    expect(action.kind).toBe("create");
  });

  it("'same' override falls through to matcher when target not yet ingested", () => {
    const links: ManualLink[] = [
      { platformA: "swiggy", externalIdA: "s-toit-7",
        platformB: "eazydiner", externalIdB: "e-toit-future",
        decision: "same" },
    ];
    // eazydiner peer isn't in any candidate yet → fall back to normal matching
    const action = resolveListing(incomingSwiggyToit, [toitCanon], links);
    expect(action.kind).toBe("attach");
    if (action.kind === "attach") expect(action.canonicalId).toBe("canon-toit");
  });

  it("symmetric: 'different' works in either direction in the link table", () => {
    // Same fixture as the second test, but reversed order in the link.
    const links: ManualLink[] = [
      { platformA: "zomato", externalIdA: "z-toit-1",
        platformB: "swiggy", externalIdB: "s-toit-7",
        decision: "different" },
    ];
    const action = resolveListing(incomingSwiggyToit, [toitCanon], links);
    expect(action.kind).toBe("create");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("resolveListing — edge cases", () => {
  it("handles an empty candidate pool", () => {
    const action = resolveListing(incomingSwiggyToit, []);
    expect(action.kind).toBe("create");
  });

  it("never auto-attaches across cities (chain guardrail)", () => {
    // farAwayCanon is "Toit Brewpub" in Whitefield, ~12km from Indiranagar.
    const action = resolveListing(incomingSwiggyToit, [farAwayCanon]);
    expect(action.kind).toBe("create");
  });

  it("attach_for_review reason mentions confidence", () => {
    const incoming: IncomingListing = {
      platform: "swiggy", externalId: "s-toit-y", name: "Toit Brewpub",
    };
    const cand: CanonicalCandidate = {
      id: "c", canonicalName: "Toit Brewpub",
      linkedListings: [{ platform: "zomato", externalId: "z-1" }],
    };
    const action = resolveListing(incoming, [cand]);
    if (action.kind === "attach_for_review") {
      expect(action.reason).toMatch(/maybe/);
    } else {
      throw new Error(`expected attach_for_review, got ${action.kind}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
describe("findMergeCandidates", () => {
  it("returns empty array for a single canonical", () => {
    const out = findMergeCandidates([toitCanon]);
    expect(out).toEqual([]);
  });

  it("returns empty array when no two canonicals match", () => {
    const out = findMergeCandidates([toitCanon, smokeHouseCanon]);
    expect(out).toEqual([]);
  });

  it("finds a definite/likely pair when two canonicals are the same place", () => {
    const dup1: CanonicalCandidate = {
      id: "dup-1", canonicalName: "Toit Brewpub", area: "Indiranagar",
      lat: 12.9784, lng: 77.6408, linkedListings: [],
    };
    const dup2: CanonicalCandidate = {
      id: "dup-2", canonicalName: "Toit - Indiranagar", area: "Indiranagar",
      lat: 12.9785, lng: 77.6409, linkedListings: [],
    };
    const out = findMergeCandidates([dup1, dup2]);
    expect(out).toHaveLength(1);
    expect(["definite", "likely"]).toContain(out[0].confidence);
    // ordering: aId < bId so the pair key is canonical
    expect([out[0].aId, out[0].bId].sort()).toEqual(["dup-1", "dup-2"]);
  });

  it("does NOT return chain-outlet pairs (Theobroma in different areas)", () => {
    const a: CanonicalCandidate = {
      id: "theo-1", canonicalName: "Theobroma", area: "Indiranagar",
      lat: 12.9784, lng: 77.6408, linkedListings: [],
    };
    const b: CanonicalCandidate = {
      id: "theo-2", canonicalName: "Theobroma", area: "Koramangala",
      lat: 12.9352, lng: 77.6245, linkedListings: [],
    };
    const out = findMergeCandidates([a, b]);
    // Either no entry or a 'maybe' — never definite/likely.
    if (out.length > 0) {
      expect(["maybe"]).toContain(out[0].confidence);
    }
  });

  it("de-duplicates pair reporting (A,B) vs (B,A)", () => {
    const dup1: CanonicalCandidate = {
      id: "aaa", canonicalName: "Toit Brewpub", area: "Indiranagar",
      lat: 12.9784, lng: 77.6408, linkedListings: [],
    };
    const dup2: CanonicalCandidate = {
      id: "bbb", canonicalName: "Toit Brewpub", area: "Indiranagar",
      lat: 12.9785, lng: 77.6409, linkedListings: [],
    };
    const out = findMergeCandidates([dup1, dup2]);
    expect(out).toHaveLength(1);
  });
});
