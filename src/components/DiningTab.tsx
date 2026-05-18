"use client";

import { useEffect, useRef, useState } from "react";
import { getOffersByPlatform } from "../data/platform-payment-offers";
import type { PlatformPaymentOffer } from "../data/platform-payment-offers";

// ────────────────────────────────────────────────────────────────────
// Types — mirror what /api/dining/search returns
// ────────────────────────────────────────────────────────────────────

type Platform = "zomato" | "swiggy" | "eazydiner";

interface Offer {
  listing_id: string;
  headline: string;
  discount_pct: number | null;
  min_bill: number | null;
  max_discount: number | null;
  terms: string | null;
  offer_type: string | null;
  booking_type: "prebook" | "walkin" | "either" | null;
  snapshot_run_id: string;
  observed_at: string;
}

interface Listing {
  id: string;
  restaurant_id: string;
  platform: Platform;
  external_id: string;
  url: string;
  headline_offer: string | null;
  last_scraped_at: string | null;
  offers: Offer[];
}

interface Restaurant {
  id: string;
  canonical_name: string;
  area: string | null;
  city: string;
  cuisines: string[];
  price_for_two: number | null;
  lat: number | null;
  lng: number | null;
  last_seen_at: string | null;
  listings: Listing[];
  best_discount_pct: number;
}

// ────────────────────────────────────────────────────────────────────
// Platform display config
// ────────────────────────────────────────────────────────────────────

const PLATFORM_META: Record<Platform, { label: string; color: string; bg: string }> = {
  zomato:    { label: "District",   color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  swiggy:    { label: "Swiggy",     color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  eazydiner: { label: "EazyDiner",  color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
};

const PLATFORMS: Platform[] = ["zomato", "swiggy", "eazydiner"];

// Payment offer participation types, keyed by offer_type value
const PAYMENT_OFFER_TYPES: Record<Platform, string[]> = {
  zomato:    ["bank_card"],
  swiggy:    ["addon_coupon", "addon_cashback"],
  eazydiner: ["payeazy"],
};

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// Review queue types
// ────────────────────────────────────────────────────────────────────

interface ReviewPair {
  id: string;
  platform_a: string;
  external_id_a: string;
  name_a: string | null;
  platform_b: string;
  external_id_b: string;
  name_b: string | null;
  reason: string | null;
  dining_restaurants: { canonical_name: string; area: string | null } | null;
}

export default function DiningTab() {
  const [query, setQuery] = useState("");
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [reviewPairs, setReviewPairs] = useState<ReviewPair[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewLoaded, setReviewLoaded] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      void searchRestaurants(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Load review count on mount (lightweight — just the total).
  useEffect(() => {
    void fetchReviewQueue();
  }, []);

  async function searchRestaurants(q: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dining/search?q=${encodeURIComponent(q)}&limit=30`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setRestaurants(data.restaurants ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function fetchReviewQueue() {
    try {
      const res = await fetch("/api/dining/review?limit=50");
      if (!res.ok) return;
      const data = await res.json();
      setReviewPairs(data.pairs ?? []);
      setReviewTotal(data.total ?? 0);
      setReviewLoaded(true);
    } catch {
      // silently ignore — review queue is non-critical
    }
  }

  async function handleReviewDecision(queueId: string, decision: "same" | "different") {
    try {
      await fetch("/api/dining/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queueId, decision }),
      });
      setReviewPairs((prev) => prev.filter((p) => p.id !== queueId));
      setReviewTotal((prev) => Math.max(0, prev - 1));
    } catch {
      // silently ignore
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-mist">Dining</h1>
          <p className="text-sm text-mist/50 mt-1">
            Find restaurants across District (Zomato), Swiggy Dineout, and EazyDiner — best offer wins.
          </p>
        </div>
        {reviewLoaded && reviewTotal > 0 && (
          <button
            onClick={() => setShowReview((v) => !v)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gold/30
                       bg-gold/5 hover:bg-gold/10 transition-colors text-xs text-gold"
          >
            <span>🔗</span>
            <span>Link review</span>
            <span className="bg-gold/20 text-gold rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              {reviewTotal}
            </span>
          </button>
        )}
      </div>

      {/* ── Payment Offers Catalog ──────────────────────────────────── */}
      <PaymentOffersCatalog />

      {/* ── Search box ─────────────────────────────────────────────── */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mist/30"
          fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.8}
          aria-hidden
        >
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3 3" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Toit, Truffles, Glen's Bakehouse…"
          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-surface border border-wire focus:border-gold/40
                     focus:outline-none text-mist placeholder:text-mist/30 text-sm"
          aria-label="Search restaurants"
        />
      </div>

      {/* ── Results ────────────────────────────────────────────────── */}
      {loading && <div className="text-center text-mist/40 text-sm py-8">Searching…</div>}

      {error && (
        <div className="rounded-xl border border-ruby/40 bg-ruby/5 px-4 py-3 text-sm text-ruby">
          {error}
        </div>
      )}

      {!loading && !error && restaurants && restaurants.length === 0 && (
        <EmptyState query={query} />
      )}

      {!loading && !error && restaurants && restaurants.length > 0 && (
        <div className="space-y-3">
          {restaurants.map((r) => (
            <RestaurantCard key={r.id} restaurant={r} />
          ))}
        </div>
      )}

      {/* ── Link review panel ──────────────────────────────────────── */}
      {showReview && (
        <ReviewPanel
          pairs={reviewPairs}
          total={reviewTotal}
          onDecision={handleReviewDecision}
          onClose={() => setShowReview(false)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Payment Offers Catalog
// ────────────────────────────────────────────────────────────────────

function PaymentOffersCatalog() {
  const [openPlatform, setOpenPlatform] = useState<Platform | null>(null);

  return (
    <div className="rounded-xl border border-wire bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-wire flex items-center gap-2">
        <span className="text-xs font-medium text-gold uppercase tracking-wide">Payment Offers</span>
        <span className="text-xs text-mist/40">— apply at checkout, independent of restaurant deals</span>
      </div>
      <div className="divide-y divide-wire">
        {PLATFORMS.map((p) => (
          <PlatformOfferAccordion
            key={p}
            platform={p}
            isOpen={openPlatform === p}
            onToggle={() => setOpenPlatform(openPlatform === p ? null : p)}
          />
        ))}
      </div>
    </div>
  );
}

function PlatformOfferAccordion({
  platform,
  isOpen,
  onToggle,
}: {
  platform: Platform;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const meta = PLATFORM_META[platform];
  const offers = getOffersByPlatform(platform);
  const noteByPlatform: Record<Platform, string> = {
    zomato:    "Available at participating restaurants — subset varies per restaurant",
    swiggy:    "All 9 offers available at every participating restaurant",
    eazydiner: "Pay via PayEazy in the EazyDiner app — bank offers apply on top of or instead of the base 25% off",
  };

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-hover/20 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: meta.color }}>{meta.label}</span>
          <span className="text-xs text-mist/40">{offers.length} payment offers</span>
        </div>
        <svg
          className="w-4 h-4 text-mist/40 transition-transform"
          style={{ transform: isOpen ? "rotate(180deg)" : undefined }}
          fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-xs text-mist/40 mb-3">{noteByPlatform[platform]}</p>
          {offers.map((offer) => (
            <OfferRow key={offer.id} offer={offer} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfferRow({ offer }: { offer: PlatformPaymentOffer }) {
  const [expanded, setExpanded] = useState(false);
  const hasTerms = offer.terms.length > 0;

  return (
    <div className="rounded-lg border border-wire/60 bg-ink/20 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-medium text-mist">{offer.headline}</span>
            {offer.coupon_code && (
              <span className="text-2xs font-mono bg-gold/10 text-gold px-1.5 py-0.5 rounded">
                {offer.coupon_code}
              </span>
            )}
          </div>
          <div className="text-xs text-mist/50 mt-0.5 truncate">{offer.card_name}</div>
          <div className="flex flex-wrap gap-3 mt-1 text-2xs text-mist/40">
            {offer.min_bill != null && <span>Min ₹{offer.min_bill.toLocaleString("en-IN")}</span>}
            {offer.max_discount != null && offer.discount_type !== "flat" && (
              <span>Max ₹{offer.max_discount.toLocaleString("en-IN")} off</span>
            )}
            {offer.usage_limit && <span>{offer.usage_limit}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-semibold text-mist">
            {offer.discount_type === "flat"
              ? `₹${offer.discount_value} off`
              : offer.discount_type === "cashback"
              ? `${offer.discount_value}% cashback`
              : `${offer.discount_value}% off`}
          </div>
          {hasTerms && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-2xs text-mist/40 hover:text-mist/70 mt-0.5"
            >
              {expanded ? "Less" : "T&Cs"}
            </button>
          )}
        </div>
      </div>

      {expanded && hasTerms && (
        <ul className="mt-2 space-y-0.5 border-t border-wire/40 pt-2">
          {offer.terms.map((t, i) => (
            <li key={i} className="text-2xs text-mist/50 flex gap-1.5">
              <span className="shrink-0 text-mist/30">•</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Restaurant cards
// ────────────────────────────────────────────────────────────────────

function RestaurantCard({ restaurant: r }: { restaurant: Restaurant }) {
  const bestPct = r.best_discount_pct;

  // Determine which platforms this restaurant accepts payment offers on
  const paymentBadges: Platform[] = PLATFORMS.filter((p) => {
    const listing = r.listings.find((x) => x.platform === p);
    if (!listing) return false;
    const paymentTypes = PAYMENT_OFFER_TYPES[p];
    return listing.offers.some((o) => o.offer_type && paymentTypes.includes(o.offer_type));
  });

  return (
    <div className="rounded-xl border border-wire bg-surface hover:bg-hover/30 transition-colors p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-mist font-medium truncate">{r.canonical_name}</h3>
            {r.area && <span className="text-xs text-mist/40">· {r.area}</span>}
            {r.cuisines.length > 0 && (
              <span className="text-xs text-mist/40 truncate">· {r.cuisines.slice(0, 3).join(", ")}</span>
            )}
            {r.price_for_two != null && (
              <span className="text-xs text-mist/40">· ₹{r.price_for_two.toLocaleString("en-IN")} for two</span>
            )}
          </div>
        </div>
        {bestPct > 0 && (
          <div
            className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium"
            style={{ background: "rgba(224,180,74,0.12)", color: "#e0b44a" }}
          >
            up to {bestPct}% off
          </div>
        )}
      </div>

      {r.listings.length > 0 && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
          {PLATFORMS.map((p) => {
            const l = r.listings.find((x) => x.platform === p);
            return <PlatformOfferCell key={p} platform={p} listing={l} />;
          })}
        </div>
      )}

      {/* Payment offer participation badges */}
      {paymentBadges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
          <span className="text-2xs text-mist/30">Payment offers:</span>
          {paymentBadges.map((p) => {
            const meta = PLATFORM_META[p];
            return (
              <span
                key={p}
                className="text-2xs px-2 py-0.5 rounded-full border"
                style={{ color: meta.color, borderColor: `${meta.color}40`, background: meta.bg }}
              >
                {meta.label} ✓
              </span>
            );
          })}
        </div>
      )}

      {r.listings.length === 0 && (
        <div className="mt-3 text-xs text-mist/30">No listings yet — scrape hasn't run.</div>
      )}
    </div>
  );
}

function PlatformOfferCell({ platform, listing }: { platform: Platform; listing?: Listing }) {
  const meta = PLATFORM_META[platform];

  if (!listing) {
    return (
      <div className="rounded-lg border border-wire bg-ink/30 px-3 py-2 text-xs text-mist/30">
        Not listed on {meta.label}
      </div>
    );
  }

  // Show only restaurant-specific offers (prebook deals, buffets, restaurant discounts)
  // Platform-wide payment offers are shown in the catalog above, not repeated here
  const paymentTypes = PAYMENT_OFFER_TYPES[platform];
  const restaurantOffers = listing.offers.filter(
    (o) => !o.offer_type || !paymentTypes.includes(o.offer_type),
  );
  const prebookOffers = restaurantOffers.filter((o) => o.booking_type === "prebook");
  const walkinOffers = restaurantOffers.filter((o) => o.booking_type === "walkin");
  const otherOffers = restaurantOffers.filter((o) => !o.booking_type || o.booking_type === "either");

  const sections: { label: string; offer: Offer }[] = [
    ...prebookOffers.slice(0, 1).map((o) => ({ label: "Prebook", offer: o })),
    ...walkinOffers.slice(0, 1).map((o) => ({ label: "Walk-in", offer: o })),
    ...(prebookOffers.length === 0 && walkinOffers.length === 0
      ? otherOffers.slice(0, 1).map((o) => ({ label: "", offer: o }))
      : []),
  ];

  const topHeadline = sections.length === 0
    ? listing.headline_offer ?? "—"
    : null;

  return (
    <a
      href={listing.url}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-lg border border-wire hover:border-rim transition-colors px-3 py-2 block group"
      style={{ background: meta.bg }}
    >
      <div className="text-xs font-medium mb-1.5" style={{ color: meta.color }}>
        {meta.label}
      </div>

      {sections.length > 0 ? (
        <div className="space-y-1.5">
          {sections.map(({ label, offer }) => (
            <div key={offer.listing_id + label}>
              {label && (
                <div className="text-2xs text-mist/40 uppercase tracking-wide leading-none mb-0.5">
                  {label}
                </div>
              )}
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-xs text-mist/70 truncate" title={offer.headline}>
                  {offer.headline}
                </span>
                {offer.discount_pct != null && (
                  <span className="text-xs font-medium text-mist shrink-0">
                    {offer.discount_pct}%
                  </span>
                )}
              </div>
              {offer.terms && (
                <div className="text-2xs text-mist/40 truncate mt-0.5" title={offer.terms}>
                  {offer.terms}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-mist/70">
          {topHeadline ?? "Listed — no deals scraped yet"}
        </div>
      )}
    </a>
  );
}

// ────────────────────────────────────────────────────────────────────
// Link Review Panel
// ────────────────────────────────────────────────────────────────────

function ReviewPanel({
  pairs,
  total,
  onDecision,
  onClose,
}: {
  pairs: ReviewPair[];
  total: number;
  onDecision: (id: string, decision: "same" | "different") => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-gold/30 bg-gold/5 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gold/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gold uppercase tracking-wide">Link Review</span>
          <span className="text-xs text-mist/40">
            — {total} pair{total !== 1 ? "s" : ""} where the auto-matcher wasn&apos;t sure
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-mist/30 hover:text-mist/60 transition-colors text-xs"
        >
          Close
        </button>
      </div>

      {pairs.length === 0 ? (
        <div className="px-4 py-8 text-center text-mist/40 text-sm">
          All caught up — no pending reviews.
        </div>
      ) : (
        <div className="divide-y divide-gold/10">
          {pairs.map((pair) => (
            <ReviewPairRow key={pair.id} pair={pair} onDecision={onDecision} />
          ))}
          {total > pairs.length && (
            <div className="px-4 py-3 text-center text-xs text-mist/30">
              Showing {pairs.length} of {total} — resolve these to see more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewPairRow({
  pair,
  onDecision,
}: {
  pair: ReviewPair;
  onDecision: (id: string, decision: "same" | "different") => void;
}) {
  const [deciding, setDeciding] = useState<"same" | "different" | null>(null);
  const canonical = pair.dining_restaurants;

  async function decide(d: "same" | "different") {
    setDeciding(d);
    onDecision(pair.id, d);
  }

  return (
    <div className="px-4 py-4">
      {/* Canonical context */}
      {canonical && (
        <p className="text-[11px] text-mist/30 mb-2">
          Provisional canonical: <span className="text-mist/50">{canonical.canonical_name}</span>
          {canonical.area && <span className="text-mist/30"> · {canonical.area}</span>}
        </p>
      )}

      {/* Pair cards */}
      <div className="flex items-start gap-3">
        <ListingChip platform={pair.platform_a} name={pair.name_a} id={pair.external_id_a} />
        <span className="text-mist/30 text-xs mt-1.5 shrink-0">vs</span>
        <ListingChip platform={pair.platform_b} name={pair.name_b} id={pair.external_id_b} />
      </div>

      {/* Reason */}
      {pair.reason && (
        <p className="text-[10px] text-mist/25 mt-1.5 font-mono">{pair.reason}</p>
      )}

      {/* Decision buttons */}
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => decide("same")}
          disabled={deciding !== null}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                     bg-emerald-500/10 text-emerald-400 border border-emerald-500/20
                     hover:bg-emerald-500/20 disabled:opacity-40"
        >
          {deciding === "same" ? "Saved ✓" : "Same restaurant"}
        </button>
        <button
          onClick={() => decide("different")}
          disabled={deciding !== null}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                     bg-ruby/10 text-ruby border border-ruby/20
                     hover:bg-ruby/20 disabled:opacity-40"
        >
          {deciding === "different" ? "Saved ✓" : "Different restaurant"}
        </button>
      </div>
    </div>
  );
}

function ListingChip({
  platform,
  name,
  id,
}: {
  platform: string;
  name: string | null;
  id: string;
}) {
  const meta = PLATFORM_META[platform as Platform] ?? { label: platform, color: "#888", bg: "rgba(128,128,128,0.1)" };
  return (
    <div
      className="flex-1 rounded-lg px-3 py-2 border border-wire text-sm min-w-0"
      style={{ background: meta.bg }}
    >
      <div className="text-xs font-medium truncate" style={{ color: meta.color }}>
        {meta.label}
      </div>
      <div className="text-mist text-xs truncate mt-0.5">{name ?? id}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Empty state
// ────────────────────────────────────────────────────────────────────

function EmptyState({ query }: { query: string }) {
  if (query.length > 0) {
    return (
      <div className="text-center py-12 text-mist/40 text-sm">
        <div>No restaurants match &ldquo;{query}&rdquo;.</div>
        <div className="mt-1 text-xs">Try a shorter query — or the scraper may not have run yet.</div>
      </div>
    );
  }
  return (
    <div className="text-center py-12 text-mist/40 text-sm">
      <div>No restaurants scraped yet.</div>
      <div className="mt-1 text-xs">Run the scraper on the Mac, or wait for the weekly cron.</div>
    </div>
  );
}
