import { describe, it, expect } from "vitest";
import { parseSlug } from "./slug";

describe("parseSlug", () => {
  it("strips trailing -bangalore", () => {
    expect(parseSlug("the-fatty-bao-indiranagar-bangalore")).toEqual({
      name: "The Fatty Bao",
      area: "Indiranagar",
    });
  });

  it("strips trailing -bengaluru", () => {
    expect(parseSlug("toit-indiranagar-bengaluru")).toEqual({
      name: "Toit",
      area: "Indiranagar",
    });
  });

  it("handles multi-word area suffix (longest match wins)", () => {
    expect(parseSlug("meghana-foods-koramangala-5th-block")).toEqual({
      name: "Meghana Foods",
      area: "Koramangala 5th Block",
    });
  });

  it("strips outlet-number digit between name and area", () => {
    expect(parseSlug("blue-tokai-coffee-roasters-1-hsr-bangalore")).toEqual({
      name: "Blue Tokai Coffee Roasters",
      area: "HSR",
    });
  });

  it("falls back to last token when no known area matches", () => {
    expect(parseSlug("some-random-place-unknownarea")).toEqual({
      name: "Some Random Place",
      area: "Unknownarea",
    });
  });

  it("handles multi-word brand names", () => {
    expect(parseSlug("byg-brewski-brewing-company-hennur-bangalore")).toEqual({
      name: "Byg Brewski Brewing Company",
      area: "Hennur",
    });
  });

  it("returns null area for single-token slugs", () => {
    expect(parseSlug("toit")).toEqual({ name: "Toit", area: null });
  });

  it("handles common areas like indiranagar, koramangala, whitefield", () => {
    expect(parseSlug("truffles-koramangala-5th-block").area).toBe("Koramangala 5th Block");
    expect(parseSlug("third-wave-coffee-whitefield-bangalore").area).toBe("Whitefield");
    expect(parseSlug("foxtrot-marathahalli-bangalore").area).toBe("Marathahalli");
  });

  it("does not strip outlet-number when it's the only token before area", () => {
    // "x-1-y" — must keep "X" as name, not produce empty.
    expect(parseSlug("x-1-hsr")).toEqual({ name: "X", area: "HSR" });
  });
});
