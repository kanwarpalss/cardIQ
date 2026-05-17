"use client";

import { useEffect, useState } from "react";

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
  booking_type: "prebooking" | "walkin" | "either" | null;
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
// Platform display config — one source of truth for color + label
// ────────────────────────────────────────────────────────────────────

const PLATFORM_META: Record<Platform, { label: string; color: string; bg: string }> = {
  zomato:    { label: "Zomato",    color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  swiggy:    { label: "Swiggy",    color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  eazydiner: { label: "EazyDiner", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
};

const PLATFORMS: Platform[] = ["zomato", "swiggy", "eazydiner"];

const BOOKING_TYPE_LABEL: Record<string, string> = {
  prebooking: "Prebook",
  walkin: "Walk-in",
  either: "",
};

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

export default function DiningTab() {
  const [query, setQuery] = useState("");
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      void searchRestaurants(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

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

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div>
        <h1 className="font-serif text-2xl text-mist">Dining</h1>
        <p className="text-sm text-mist/50 mt-1">
          Find restaurants across Zomato Dining Out, Swiggy Dineout, and EazyDiner — best offer wins.
        </p>
      </div>

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
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────

function RestaurantCard({ restaurant: r }: { restaurant: Restaurant }) {
  const bestPct = r.best_discount_pct;
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

  // Split offers into prebook vs walk-in; fall back to showing top offer if unclassified.
  const prebookOffers = listing.offers.filter((o) => o.booking_type === "prebooking");
  const walkinOffers = listing.offers.filter((o) => o.booking_type === "walkin");
  const otherOffers = listing.offers.filter((o) => !o.booking_type || o.booking_type === "either");

  const sections: { label: string; offer: Offer }[] = [
    ...prebookOffers.slice(0, 1).map((o) => ({ label: "Prebook", offer: o })),
    ...walkinOffers.slice(0, 1).map((o) => ({ label: "Walk-in", offer: o })),
    ...(prebookOffers.length === 0 && walkinOffers.length === 0
      ? otherOffers.slice(0, 1).map((o) => ({ label: BOOKING_TYPE_LABEL[o.booking_type ?? ""] ?? "", offer: o }))
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
        <div className="text-xs text-mist/70 truncate" title={topHeadline ?? undefined}>
          {topHeadline}
        </div>
      )}
    </a>
  );
}

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
