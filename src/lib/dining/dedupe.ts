// Cross-platform restaurant dedupe.
//
// Two distinct jobs:
//
//   1. INCREMENTAL (during a scrape run): for each incoming listing,
//      decide which existing canonical restaurant it maps to (or whether
//      to mint a new canonical).
//
//   2. POST-RUN MERGE: after all three platforms have scraped, find
//      pairs of canonicals that are actually the same place and should
//      be merged (e.g. Zomato created canonical A with crap geo before
//      Swiggy showed up with better geo — they're the same place).
//
// Both jobs are deterministic, pure-data — no I/O. The caller (scrape
// orchestrator) loads candidates from Supabase, calls these helpers,
// writes the resolutions back. Per L17: testable as a tested primitive,
// the orchestrator then becomes a thin integration test.
//
// User-managed overrides
// ──────────────────────
// `dining_manual_links` rows force the matcher's hand:
//   decision='same'      → the two listings MUST resolve to the same canonical
//   decision='different' → the two listings MUST NOT resolve to the same canonical
// Explicit > implicit (L14). We never silently merge against a 'different'
// declaration, nor silently split a 'same' declaration.

import {
  normalizeName,
  normalizeArea,
  haversineMeters,
  matchConfidence,
  Confidence,
} from "./normalize";
import type { Platform } from "./sessions";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface IncomingListing {
  platform: Platform;
  externalId: string;
  name: string;
  area?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface CanonicalCandidate {
  id: string;
  canonicalName: string;
  area?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Listings already linked to this canonical. Lets us honour 'different' overrides. */
  linkedListings: Array<{ platform: Platform; externalId: string }>;
}

export interface ManualLink {
  platformA: Platform;
  externalIdA: string;
  platformB: Platform;
  externalIdB: string;
  decision: "same" | "different";
}

export type DedupeAction =
  /** Attach incoming listing to an existing canonical (high confidence). */
  | { kind: "attach"; canonicalId: string; confidence: Confidence; reason: string }
  /** Provisionally attach + queue for human review (confidence 'maybe'). */
  | { kind: "attach_for_review"; canonicalId: string; reason: string;
      candidatePair: { aPlatform: Platform; aExternalId: string;
                       bPlatform: Platform; bExternalId: string } }
  /** No match found — caller should mint a fresh canonical row. */
  | { kind: "create"; reason: string }
  /** Override forced this resolution; matcher had no say. */
  | { kind: "attach_by_override"; canonicalId: string; reason: string };

export interface MergeCandidate {
  aId: string;
  bId: string;
  confidence: Confidence;
  reason: string;
}

// ────────────────────────────────────────────────────────────────────
// Candidate pre-filter — area / geo bucketing
// ────────────────────────────────────────────────────────────────────

/**
 * Drop obviously-far-away canonicals before pair-wise scoring.
 *
 * Two cheap filters, in OR (a candidate passes if EITHER signal places
 * it near the incoming listing):
 *
 *   1. Geo bucket: incoming has lat/lng + candidate has lat/lng + within ~2km.
 *   2. Area name match: both have an `area` string and they normalise equal.
 *
 * Candidates with neither lat/lng nor area are kept (no info to filter on).
 * Worst case: O(n) over all canonicals, but cheap per-iteration. The
 * scoring step (matchConfidence) is the expensive one.
 *
 * Default radius is generous (2km) because Indian addresses are noisy
 * and geo on these platforms is often off by 300–500m.
 */
export function preFilterCandidates(
  incoming: IncomingListing,
  all: CanonicalCandidate[],
  radiusMeters = 2000,
): CanonicalCandidate[] {
  const inArea = normalizeArea(incoming.area ?? "");
  const inGeo = incoming.lat != null && incoming.lng != null
    ? { lat: incoming.lat, lng: incoming.lng }
    : null;

  return all.filter((c) => {
    // Same platform's existing listing for the same external_id is
    // pointless to re-compare against; the orchestrator handles that
    // via upsert, not dedupe. But we don't enforce here — orchestrator
    // is responsible for excluding self-listings.
    let pass = false;

    if (inGeo && c.lat != null && c.lng != null) {
      const d = haversineMeters(inGeo, { lat: c.lat, lng: c.lng });
      if (d <= radiusMeters) pass = true;
    }
    if (!pass && inArea) {
      const cArea = normalizeArea(c.area ?? "");
      if (cArea && cArea === inArea) pass = true;
    }
    // If neither side has geo OR area, we can't pre-filter — keep it.
    if (!pass && !inGeo && !inArea) pass = true;
    if (!pass && (!c.lat || !c.lng) && !c.area) pass = true;

    return pass;
  });
}

// ────────────────────────────────────────────────────────────────────
// Manual-link lookups
// ────────────────────────────────────────────────────────────────────

function linkKey(p: Platform, id: string): string {
  return `${p}::${id}`;
}

/**
 * Build a quick-lookup map: for each listing, the set of OTHER listings
 * KP has explicitly decided are 'different' from it. The set is
 * symmetric — we insert both directions.
 */
function buildDifferentMap(links: ManualLink[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.decision !== "different") continue;
    const a = linkKey(l.platformA, l.externalIdA);
    const b = linkKey(l.platformB, l.externalIdB);
    if (!m.has(a)) m.set(a, new Set());
    if (!m.has(b)) m.set(b, new Set());
    m.get(a)!.add(b);
    m.get(b)!.add(a);
  }
  return m;
}

/**
 * Build a quick-lookup map: for each listing, the OTHER listings KP
 * has explicitly decided are 'same'. Symmetric.
 */
function buildSameMap(links: ManualLink[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.decision !== "same") continue;
    const a = linkKey(l.platformA, l.externalIdA);
    const b = linkKey(l.platformB, l.externalIdB);
    if (!m.has(a)) m.set(a, new Set());
    if (!m.has(b)) m.set(b, new Set());
    m.get(a)!.add(b);
    m.get(b)!.add(a);
  }
  return m;
}

// ────────────────────────────────────────────────────────────────────
// THE main entry point: resolve one incoming listing
// ────────────────────────────────────────────────────────────────────

/**
 * Decide what to do with an incoming listing.
 *
 * Decision tree (first match wins):
 *
 *   1. Override 'same' present → attach_by_override to the canonical
 *      that holds the other listing. (If neither side is in any
 *      canonical yet, this case falls through to normal matching.)
 *
 *   2. Best matcher confidence is 'definite' or 'likely', AND that
 *      candidate is NOT excluded by a 'different' override → attach.
 *
 *   3. Best matcher confidence is 'maybe', AND not excluded → attach
 *      for review (queue the candidate pair, attach provisionally).
 *
 *   4. Otherwise → create a new canonical.
 *
 * `candidates` should already be pre-filtered (call preFilterCandidates
 * first) — we don't re-filter here.
 */
export function resolveListing(
  incoming: IncomingListing,
  candidates: CanonicalCandidate[],
  manualLinks: ManualLink[] = [],
): DedupeAction {
  const sameMap = buildSameMap(manualLinks);
  const diffMap = buildDifferentMap(manualLinks);
  const incomingKey = linkKey(incoming.platform, incoming.externalId);

  // ── (1) Override 'same' — search candidates for one holding a peer link
  const sameTargets = sameMap.get(incomingKey);
  if (sameTargets && sameTargets.size > 0) {
    for (const c of candidates) {
      for (const ll of c.linkedListings) {
        if (sameTargets.has(linkKey(ll.platform, ll.externalId))) {
          return {
            kind: "attach_by_override",
            canonicalId: c.id,
            reason: `manual link 'same' with ${ll.platform}::${ll.externalId}`,
          };
        }
      }
    }
    // 'same' override exists but its target isn't in the candidate
    // pool yet (e.g. that listing hasn't been ingested). Fall through
    // to normal matching — orchestrator can stitch later.
  }

  const diffExcluded = diffMap.get(incomingKey) ?? new Set<string>();

  // ── (2)+(3) Score every candidate, pick best
  let best: { c: CanonicalCandidate; conf: Confidence; reason: string } | null = null;
  const confOrder: Record<Confidence, number> = { no: 0, maybe: 1, likely: 2, definite: 3 };

  for (const c of candidates) {
    // Skip if KP has explicitly declared incoming != any listing on this canonical.
    const blocked = c.linkedListings.some((ll) =>
      diffExcluded.has(linkKey(ll.platform, ll.externalId))
    );
    if (blocked) continue;

    const conf = matchConfidence(
      { name: incoming.name, area: incoming.area, lat: incoming.lat, lng: incoming.lng },
      { name: c.canonicalName, area: c.area, lat: c.lat, lng: c.lng },
    );
    if (conf === "no") continue;

    if (!best || confOrder[conf] > confOrder[best.conf]) {
      best = { c, conf, reason: describeMatch(incoming, c, conf) };
    }
  }

  if (!best) {
    return { kind: "create", reason: "no candidate scored above 'no'" };
  }

  if (best.conf === "definite" || best.conf === "likely") {
    return {
      kind: "attach",
      canonicalId: best.c.id,
      confidence: best.conf,
      reason: best.reason,
    };
  }

  // best.conf === 'maybe'
  // Pick any listing on the matched canonical to form the review pair —
  // the one most likely to have been the source of the canonical's
  // identity. Prefer same-platform if possible.
  const peer = best.c.linkedListings.find((l) => l.platform !== incoming.platform)
    ?? best.c.linkedListings[0];
  if (!peer) {
    // Canonical has no listings yet (shouldn't happen in practice).
    return { kind: "create", reason: "candidate canonical has no listings to review against" };
  }
  return {
    kind: "attach_for_review",
    canonicalId: best.c.id,
    reason: best.reason,
    candidatePair: {
      aPlatform: incoming.platform,
      aExternalId: incoming.externalId,
      bPlatform: peer.platform,
      bExternalId: peer.externalId,
    },
  };
}

function describeMatch(incoming: IncomingListing, c: CanonicalCandidate, conf: Confidence): string {
  const n1 = normalizeName(incoming.name);
  const n2 = normalizeName(c.canonicalName);
  const geo = incoming.lat != null && incoming.lng != null && c.lat != null && c.lng != null
    ? `~${Math.round(haversineMeters({ lat: incoming.lat, lng: incoming.lng }, { lat: c.lat, lng: c.lng }))}m`
    : "no-geo";
  return `${conf}: '${n1}' vs '${n2}' (${geo})`;
}

// ────────────────────────────────────────────────────────────────────
// Post-run merge candidates
// ────────────────────────────────────────────────────────────────────

/**
 * Find all canonical-canonical pairs that should probably be merged.
 *
 * Use case: incremental dedupe created two canonicals for the same
 * place because the second ingest had better/different geo. Run after
 * a full scrape to clean up.
 *
 * Returns pairs at 'definite' or 'likely' (auto-mergeable) and 'maybe'
 * (needs review). Callers decide what to do per band.
 *
 * O(n²) in canonicals; for ~15k that's ~225M comparisons which is too
 * many. We pre-bucket by area+geo via preFilterCandidates internally
 * so realistic cost is O(n × ~50).
 */
export function findMergeCandidates(canonicals: CanonicalCandidate[]): MergeCandidate[] {
  const out: MergeCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < canonicals.length; i++) {
    const a = canonicals[i];
    // Pretend `a` is an "incoming" listing for pre-filter purposes.
    const candidates = preFilterCandidates(
      { platform: "zomato", externalId: a.id, name: a.canonicalName, area: a.area, lat: a.lat, lng: a.lng },
      canonicals.slice(i + 1),
    );

    for (const b of candidates) {
      const key = a.id < b.id ? `${a.id}::${b.id}` : `${b.id}::${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const conf = matchConfidence(
        { name: a.canonicalName, area: a.area, lat: a.lat, lng: a.lng },
        { name: b.canonicalName, area: b.area, lat: b.lat, lng: b.lng },
      );
      if (conf === "no") continue;

      out.push({
        aId: a.id,
        bId: b.id,
        confidence: conf,
        reason: describeMatch(
          { platform: "zomato", externalId: a.id, name: a.canonicalName,
            area: a.area, lat: a.lat, lng: a.lng },
          b,
          conf,
        ),
      });
    }
  }

  return out;
}
