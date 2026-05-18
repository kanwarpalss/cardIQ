import { describe, it, expect } from "vitest";
import { extractNextDataItems } from "./eazydiner";

describe("extractNextDataItems", () => {
  it("returns empty array when no NEXT_DATA tag present", () => {
    expect(extractNextDataItems("<html><body>nothing</body></html>")).toEqual([]);
  });

  it("returns empty array when NEXT_DATA is malformed JSON", () => {
    expect(
      extractNextDataItems(`<script id="__NEXT_DATA__" type="application/json">not json</script>`),
    ).toEqual([]);
  });

  it("returns empty array when listing path is missing", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: {} },
    })}</script>`;
    expect(extractNextDataItems(html)).toEqual([]);
  });

  it("extracts a single restaurant entry shaped like real EazyDiner data", () => {
    const item = {
      res_id: 683629,
      name: "Romeo Cafe",
      code: "bengaluru/romeo-cafe-shivajinagar-central-bengaluru-683629",
      restaurant_area: "shivajinagar",
      lat: 12.98522902,
      lng: 77.60348791,
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { listing: { data: { data: [item] } } } },
    })}</script>`;
    const out = extractNextDataItems(html);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Romeo Cafe");
    expect(out[0].lat).toBe(12.98522902);
    expect(out[0].code).toContain("romeo-cafe");
  });

  it("returns empty array for a real-shaped 'past last page' response", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { listing: { data: { data: [] } } } },
    })}</script>`;
    expect(extractNextDataItems(html)).toEqual([]);
  });
});
