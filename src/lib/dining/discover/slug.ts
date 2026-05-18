/**
 * Slug parsing helpers, shared across District and EazyDiner.
 *
 * Both platforms use URL slugs of the form:
 *   {brand-words}-{maybe-outlet-number}-{area}-{maybe-city}
 *
 * Examples:
 *   the-fatty-bao-indiranagar-bangalore        → name="The Fatty Bao",   area="Indiranagar"
 *   byg-brewski-brewing-company-hennur-bangalore → name="Byg Brewski Brewing Company", area="Hennur"
 *   blue-tokai-coffee-roasters-1-hsr-bangalore → name="Blue Tokai Coffee Roasters", area="HSR"
 *   meghana-foods-koramangala-5th-block        → name="Meghana Foods", area="Koramangala 5th Block"
 *
 * Heuristic, not perfect — but the downstream dedupe layer uses trigram
 * similarity on names + geo radius, so noise here gets cleaned later.
 */

// Known Bangalore areas. Order matters: longest-prefix first so
// "koramangala-5th-block" matches before "koramangala".
const BANGALORE_AREAS = [
  "koramangala-1st-block", "koramangala-4th-block", "koramangala-5th-block",
  "koramangala-6th-block", "koramangala-7th-block", "koramangala-8th-block",
  "itpl-main-road-whitefield", "varthur-main-road-whitefield",
  "kanakapura-road", "sarjapur-road", "old-airport-road", "bannerghatta-road",
  "richmond-road", "residency-road", "lavelle-road", "infantry-road",
  "brigade-road", "church-street", "mg-road", "st-marks-road",
  "race-course-road", "cunningham-road", "new-bel-road",
  "ascendas-park-square-whitefield",
  "indiranagar", "koramangala", "whitefield", "hsr", "btm", "jp-nagar",
  "jayanagar", "marathahalli", "bellandur", "kammanahalli", "kalyan-nagar",
  "hennur", "yelahanka", "electronic-city", "yeshwantpur", "rajajinagar",
  "majestic", "malleshwaram", "basavanagudi", "banashankari", "domlur",
  "frazer-town", "sadashiv-nagar", "sanjay-nagar", "sahakara-nagar",
  "kr-puram", "mahadevapura", "bommanahalli", "anekal", "arekere",
  "bommanahalli", "choodasandra", "devanahalli", "hebbal", "jakkur",
  "kadubeesanahalli", "nagawara", "rajarajeshwari-nagar", "vijay-nagar",
  "ub-city", "basaveshwara-nagar",
];

// Suffix tokens that mean "city, not area" — strip these.
const CITY_SUFFIXES = ["bangalore", "bengaluru"];

/**
 * Parse a District/EazyDiner slug into a best-guess name + area.
 *
 * Algorithm (longest-match first):
 *   1. Strip city suffix.
 *   2. Strip outlet-disambiguator suffix (e.g. trailing `-1`, `-2`).
 *   3. Find the longest known-area suffix and split there.
 *   4. Whatever remains on the left is the name. Title-case it.
 *   5. If no known area matches, the LAST token is treated as area (best guess).
 *
 * Returns `{ name, area }`. Both are user-readable (title-cased, spaces).
 */
export function parseSlug(slug: string): { name: string; area: string | null } {
  let tokens = slug.toLowerCase().split("-").filter(Boolean);
  if (tokens.length === 0) return { name: slug, area: null };

  // Strip trailing city.
  while (tokens.length > 0 && CITY_SUFFIXES.includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  if (tokens.length === 0) return { name: slug, area: null };

  // Try longest-matching known area as suffix.
  for (const area of BANGALORE_AREAS) {
    const areaTokens = area.split("-");
    if (tokens.length <= areaTokens.length) continue;
    const tail = tokens.slice(-areaTokens.length).join("-");
    if (tail === area) {
      let nameTokens = tokens.slice(0, -areaTokens.length);
      // Drop a trailing single-digit "outlet number" that some chains use.
      if (
        nameTokens.length > 1 &&
        /^[0-9]{1,2}$/.test(nameTokens[nameTokens.length - 1])
      ) {
        nameTokens = nameTokens.slice(0, -1);
      }
      return {
        name: titleCase(nameTokens.join(" ")),
        area: titleCase(area.replace(/-/g, " ")),
      };
    }
  }

  // Fallback: last token = area (works for "{name}-{singleword-area}").
  if (tokens.length >= 2) {
    const area = tokens[tokens.length - 1];
    let nameTokens = tokens.slice(0, -1);
    if (
      nameTokens.length > 1 &&
      /^[0-9]{1,2}$/.test(nameTokens[nameTokens.length - 1])
    ) {
      nameTokens = nameTokens.slice(0, -1);
    }
    return {
      name: titleCase(nameTokens.join(" ")),
      area: titleCase(area),
    };
  }

  return { name: titleCase(tokens.join(" ")), area: null };
}

// Bangalore-area acronyms that should stay uppercase after title-casing.
const ACRONYMS = new Set([
  "hsr", "btm", "jp", "mg", "ub", "itpl", "kr", "abs",
]);

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .trim();
}
