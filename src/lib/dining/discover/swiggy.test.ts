import { describe, it, expect } from "vitest";
import { extractSearchCandidates, pickBestCandidate } from "./swiggy";

describe("extractSearchCandidates", () => {
  it("returns empty array for empty/null body", () => {
    expect(extractSearchCandidates(null)).toEqual([]);
    expect(extractSearchCandidates({})).toEqual([]);
    expect(extractSearchCandidates([])).toEqual([]);
  });

  it("extracts a single top-result card (real shape from confirmed probe)", () => {
    const body = {
      data: {
        cards: [
          {
            groupedCard: {
              cardGroupMap: {
                RESTAURANT: {
                  cards: [
                    {
                      card: {
                        card: {
                          info: {
                            id: "263261",
                            name: "Toit",
                            locality: "Indiranagar",
                            latLong: "12.9792,77.6408",
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };
    const out = extractSearchCandidates(body);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("263261");
    expect(out[0].name).toBe("Toit");
    expect(out[0].lat).toBeCloseTo(12.9792, 3);
  });

  it("extracts multiple results from grouped restaurants card", () => {
    const makeInfo = (id: string, name: string) => ({
      card: { card: { restaurants: [{ info: { id, name, locality: "Test" } }] } },
    });
    const body = {
      data: {
        cards: [
          {
            groupedCard: {
              cardGroupMap: {
                RESTAURANT: {
                  cards: [makeInfo("1", "A"), makeInfo("2", "B"), makeInfo("3", "C")],
                },
              },
            },
          },
        ],
      },
    };
    const out = extractSearchCandidates(body);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty when RESTAURANT group is missing", () => {
    const body = { data: { cards: [] } };
    expect(extractSearchCandidates(body)).toEqual([]);
  });
});

describe("pickBestCandidate", () => {
  const toit = { name: "Toit", lat: 12.9792, lng: 77.6408 };

  it("picks exact name match at same location", () => {
    const candidates = [
      { id: "1", name: "Toit", locality: "Indiranagar", lat: 12.9792, lng: 77.6408 },
      { id: "2", name: "Completely Different Place", locality: "Whitefield", lat: 13.0, lng: 77.7 },
    ];
    const result = pickBestCandidate(toit, candidates);
    expect(result?.id).toBe("1");
  });

  it("returns null when no candidate is similar enough", () => {
    const candidates = [
      { id: "1", name: "Absolutely Nothing Like Target", lat: 13.1, lng: 78.0 },
    ];
    expect(pickBestCandidate(toit, candidates)).toBeNull();
  });

  it("returns null for empty candidates list", () => {
    expect(pickBestCandidate(toit, [])).toBeNull();
  });

  it("prefers name similarity over geo when far but exact name", () => {
    const candidates = [
      { id: "far", name: "Toit Brewpub", lat: 13.1, lng: 78.0 },           // exact name, 20km away
      { id: "near", name: "Random Place", lat: 12.9792, lng: 77.6408 },    // bad name, same geo
    ];
    const result = pickBestCandidate(toit, candidates);
    // name weight=0.7 should still favour the named match
    expect(result?.id).toBe("far");
  });
});
