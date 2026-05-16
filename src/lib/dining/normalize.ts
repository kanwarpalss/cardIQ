// Pure helpers for dining restaurant matching / dedupe.
//
// All functions here are deterministic, side-effect-free, no I/O.
// Per L17: tested exhaustively at the unit level so the scraper +
// dedupe layers can be thin integration tests on top.
//
// Public surface:
//   normalizeName(raw)               → cleaned canonical name
//   normalizeArea(raw)               → cleaned area string
//   haversineMeters(a, b)            → great-circle distance, metres
//   levenshtein(a, b)                → edit distance, cheap
//   areLikelySameRestaurant(a, b)    → boolean, the "cheap pass" matcher
//   matchConfidence(a, b)            → 'definite' | 'likely' | 'maybe' | 'no'
//
// The expensive pass (embedding similarity) lives elsewhere; this file
// stays free of any network / model calls.

// ────────────────────────────────────────────────────────────────────
// Name normalisation
// ────────────────────────────────────────────────────────────────────

// Suffixes platforms tack on to the same restaurant. Stripped before
// comparison. Order matters: longer phrases first so we don't leave
// dangling tokens. All matched case-insensitively at the END of the
// cleaned string.
const TRAILING_NOISE: RegExp[] = [
  /\s*[-–—,|]\s*[a-z0-9\s.&']+$/i,                  // "Toit - Indiranagar"
  /\s*\([^)]*\)\s*$/,                               // "Toit (Indiranagar)"
  /\s+(pvt\.?\s*ltd\.?|private\s+limited|llp|inc\.?|co\.?)\s*$/i,
  /\s+(restaurant|restro\s*bar|restro|bar|cafe|brewery|brewpub|kitchen|bistro|grill|lounge|dining|eatery|food\s*court|by\s+\w+)\s*$/i,
  /\s+(the\s+)?(\d+(st|nd|rd|th)?\s+(outlet|branch|floor))\s*$/i,
];

const PUNCT_RE = /[^\p{L}\p{N}\s]+/gu;     // keep letters/digits/space across all scripts
const MULTI_SPACE_RE = /\s+/g;

/**
 * Normalise a raw restaurant name for matching.
 *
 *   "Toit Brewpub Pvt. Ltd."        → "toit"
 *   "Toit - Indiranagar"            → "toit"
 *   "The Permit Room (Koramangala)" → "the permit room"
 *
 * The output is lowercase, punctuation-free, single-spaced. Suitable as
 * a Levenshtein input. NOT suitable for display — see `prettyName`.
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.normalize("NFKC").trim();
  if (!s) return "";

  // Strip trailing noise iteratively — a single restaurant can have
  // multiple suffixes ("Toit Brewpub - Indiranagar (1st floor)").
  let prev = "";
  while (prev !== s) {
    prev = s;
    for (const re of TRAILING_NOISE) {
      s = s.replace(re, "").trim();
    }
  }

  s = s.replace(PUNCT_RE, " ").toLowerCase().replace(MULTI_SPACE_RE, " ").trim();
  return s;
}

/**
 * Normalise area / locality strings ("Indiranagar 1st Stage" →
 * "indiranagar"). Used for soft tie-breaking only.
 */
export function normalizeArea(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.normalize("NFKC").toLowerCase().trim();
  s = s.replace(/\b\d+(st|nd|rd|th)?\s+(stage|phase|cross|main|block|sector)\b/g, "");
  s = s.replace(PUNCT_RE, " ").replace(MULTI_SPACE_RE, " ").trim();
  // Drop trailing city repetition: "indiranagar bangalore" → "indiranagar"
  s = s.replace(/\s+(bangalore|bengaluru|mumbai|delhi|gurgaon|hyderabad|chennai|pune|noida)$/i, "");
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Geo
// ────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Haversine distance in METRES between two lat/lng points.
 * Returns Infinity if either point is missing — callers can treat "no
 * geo" as "definitely not same place".
 */
export function haversineMeters(a: LatLng | null | undefined, b: LatLng | null | undefined): number {
  if (!a || !b) return Infinity;
  if (!isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return Infinity;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ────────────────────────────────────────────────────────────────────
// Edit distance (Wagner–Fischer, O(n·m) space-optimised to two rows)
// ────────────────────────────────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings.
 * Used on already-normalised names (so inputs are short — typical
 * restaurant name is <30 chars after normalisation).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const m = a.length;
  const n = b.length;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ────────────────────────────────────────────────────────────────────
// Matching
// ────────────────────────────────────────────────────────────────────

export interface MatchCandidate {
  name: string;            // already normalised? doesn't matter, we re-normalise
  area?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Confidence band for a candidate match. The matcher in lib/dining/
 * dedupe.ts uses these:
 *   - 'definite' → auto-merge.
 *   - 'likely'   → auto-merge (still safe).
 *   - 'maybe'    → push to dining_manual_links for KP to confirm.
 *   - 'no'       → do not merge.
 *
 * Thresholds are deliberately conservative — false-merges are much
 * worse UX than false-splits.
 */
export type Confidence = "definite" | "likely" | "maybe" | "no";

export function matchConfidence(a: MatchCandidate, b: MatchCandidate): Confidence {
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (!na || !nb) return "no";

  const dist = haversineMeters(
    a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null,
    b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null,
  );

  // Different city / wildly different geographic point → never merge,
  // regardless of name match. Catches chains like "Theobroma" with
  // 50+ outlets. Only applies when geo is actually known on both sides;
  // `dist === Infinity` means "unknown", which is a different case
  // handled below by falling back to area / name agreement.
  if (isFinite(dist) && dist > 5000) return "no";

  // Exact normalised name match.
  if (na === nb) {
    if (dist <= 150) return "definite";
    if (dist <= 500) return "likely";
    if (dist === Infinity) {
      // No geo on at least one side. Use area as a soft signal.
      const aa = normalizeArea(a.area ?? "");
      const ab = normalizeArea(b.area ?? "");
      if (aa && aa === ab) return "likely";
      return "maybe";
    }
    return "maybe";
  }

  const editDist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  const ratio = 1 - editDist / maxLen;

  // Near-exact (typos, plural-s, ampersand-vs-and).
  if (editDist <= 2 && ratio >= 0.85) {
    if (dist <= 150) return "definite";
    if (dist <= 500) return "likely";
    return "maybe";
  }

  // Loose name match (e.g. "Toit" vs "Toit Brewpub" after one side fails to strip suffix).
  if (ratio >= 0.7 && dist <= 100) return "likely";
  if (ratio >= 0.7 && dist <= 300) return "maybe";

  // One name is a strict prefix of the other AND geo agrees → likely
  // ("permit room" vs "permit room ec"). Cheap last-mile.
  if ((na.startsWith(nb) || nb.startsWith(na)) && dist <= 200) return "likely";

  return "no";
}

/**
 * Convenience wrapper for the cheap path: "should I treat these as the
 * same restaurant without paying for an embedding call?". Returns true
 * for 'definite' and 'likely'.
 */
export function areLikelySameRestaurant(a: MatchCandidate, b: MatchCandidate): boolean {
  const c = matchConfidence(a, b);
  return c === "definite" || c === "likely";
}
