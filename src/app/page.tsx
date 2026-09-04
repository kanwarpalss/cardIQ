"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { refreshTransactionsAll } from "@/lib/transactions-cache";
import { loadRedemptions } from "@/lib/redemptions-data";
import { countExpiringSoon } from "@/lib/redemptions";
import type { Sub as RedemptionSub } from "@/components/RedemptionsTab";
import OverviewTab from "@/components/OverviewTab";
import AutoSync from "@/components/AutoSync";

// Only one tab is ever mounted at a time (see the `tab === "X" &&` gates
// below), so eagerly importing all eleven pulled every tab's full component
// tree into the initial page load's JS bundle regardless of which one was
// actually visible — confirmed via `.next/static/chunks/app/page-*.js`
// (208KB) before this change. Overview is the default tab and stays eager;
// everything else loads on demand the first time it's opened (2026-09-03).
const TAB_LOADING = () => (
  <div className="flex items-center justify-center py-24 text-sm text-mist/50">Loading…</div>
);
const SpendTab       = dynamic(() => import("@/components/SpendTab"), { loading: TAB_LOADING });
const OrdersTab      = dynamic(() => import("@/components/OrdersTab"), { loading: TAB_LOADING });
const VouchersTab    = dynamic(() => import("@/components/VouchersTab"), { loading: TAB_LOADING });
const ReviewTab      = dynamic(() => import("@/components/ReviewTab"), { loading: TAB_LOADING });
const InsightsTab    = dynamic(() => import("@/components/InsightsTab"), { loading: TAB_LOADING });
const RedemptionsTab = dynamic(() => import("@/components/RedemptionsTab"), { loading: TAB_LOADING });
const OffersTab      = dynamic(() => import("@/components/OffersTab"), { loading: TAB_LOADING });
const DiningTab      = dynamic(() => import("@/components/DiningTab"), { loading: TAB_LOADING });
const ChatTab        = dynamic(() => import("@/components/ChatTab"), { loading: TAB_LOADING });
const CardsTab       = dynamic(() => import("@/components/CardsTab"), { loading: TAB_LOADING });

const TABS = ["Overview", "Spend", "Orders", "Vouchers", "Insights", "Redemptions", "Offers", "Dining", "Chat", "Review", "Cards"] as const;
type Tab = (typeof TABS)[number];

// Sidebar groups — "Review" and "Cards" live at the bottom rail (Review is a
// tucked-away validation inbox; Cards doubles as settings).
//
// "Redemptions" replaced the old separate Rewards + Loyalty tabs (2026-08-14).
// Those were two doors onto the same question — "what am I holding?" — which is
// precisely why holdings kept being forgotten. Same tables, one view.
const NAV_GROUPS: { label: string | null; tabs: Tab[] }[] = [
  { label: null,      tabs: ["Overview"] },
  { label: "Money",   tabs: ["Spend", "Orders", "Vouchers", "Insights"] },
  { label: "Perks",   tabs: ["Redemptions", "Offers"] },
  { label: "Explore", tabs: ["Dining", "Chat"] },
];

const ICON_PROPS = {
  className: "w-4 h-4 shrink-0", fill: "none",
  viewBox: "0 0 16 16", stroke: "currentColor", strokeWidth: 1.6,
} as const;

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  Overview: (
    <svg {...ICON_PROPS}><path d="M2 8.5 8 3l6 5.5M4 7.5V13h8V7.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Spend: (
    <svg {...ICON_PROPS}><path d="M2 13V9m4 4V6m4 7V8m4 5V3" strokeLinecap="round"/></svg>
  ),
  Orders: (
    <svg {...ICON_PROPS}><path d="M3 5.5h10l-.9 7.2a1 1 0 0 1-1 .8H4.9a1 1 0 0 1-1-.8L3 5.5zM5.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Vouchers: (
    <svg {...ICON_PROPS}><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h9A1.5 1.5 0 0 1 14 5.5V7a1 1 0 0 0 0 2v1.5A1.5 1.5 0 0 1 12.5 12h-9A1.5 1.5 0 0 1 2 10.5V9a1 1 0 0 0 0-2V5.5z" strokeLinejoin="round"/><path d="M9.7 4.5v7" strokeDasharray="1.4 1.4"/></svg>
  ),
  Review: (
    <svg {...ICON_PROPS}><circle cx="8" cy="8" r="6"/><path d="M5.4 8.1 7.1 9.8 10.6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Insights: (
    <svg {...ICON_PROPS}><circle cx="8" cy="8" r="6"/><path d="M8 2v6l4.2 2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Redemptions: (
    <svg {...ICON_PROPS}><path d="M8 1.5 9.8 5.6l4.2.4-3.2 2.9.9 4.3L8 11l-3.7 2.2.9-4.3L2 6l4.2-.4L8 1.5z" strokeLinejoin="round"/></svg>
  ),
  Offers: (
    <svg {...ICON_PROPS}><path d="M8.6 1.8 14 7.2a1.5 1.5 0 0 1 0 2.1l-4.7 4.7a1.5 1.5 0 0 1-2.1 0L1.8 8.6A1 1 0 0 1 1.5 8V2.5a1 1 0 0 1 1-1H8a1 1 0 0 1 .6.3z" strokeLinejoin="round"/><circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/></svg>
  ),
  Dining: (
    <svg {...ICON_PROPS}><path d="M5 2v5a1 1 0 0 1-2 0V2M4 7v7" strokeLinecap="round"/><path d="M11 2v12M9 2c0 2 0 4 2 5" strokeLinecap="round"/></svg>
  ),
  Chat: (
    <svg {...ICON_PROPS}><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3 2v-2H3a1 1 0 0 1-1-1V3z" strokeLinejoin="round"/></svg>
  ),
  Cards: (
    <svg {...ICON_PROPS}><rect x="1" y="4" width="14" height="10" rx="2"/><path d="M1 7h14" strokeLinecap="square"/></svg>
  ),
};

function LogoMark() {
  return (
    <div className="w-8 h-8 rounded-lg bg-gold-shimmer flex items-center justify-center shadow-glow-gold shrink-0">
      <svg className="w-4 h-4 text-ink" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2.2}>
        <rect x="1" y="4" width="14" height="10" rx="2"/>
        <path d="M1 7h14" strokeLinecap="square"/>
        <circle cx="4.5" cy="11" r="1" fill="currentColor" stroke="none"/>
      </svg>
    </div>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("Overview");
  // New object identity per click so re-clicking the same card re-applies the filter.
  const [spendFocus, setSpendFocus] = useState<{ last4: string } | null>(null);
  // Same pattern for deep-linking into a Redemptions sub-section.
  const [redemptionFocus, setRedemptionFocus] = useState<{ sub: RedemptionSub } | null>(null);
  // Count of order matches awaiting review — drives the "Review" nav badge.
  const [reviewCount, setReviewCount] = useState(0);
  // Holdings expiring within 30 days — drives the "Redemptions" nav badge.
  // Loaded here (not inside the tab) so the warning is visible WITHOUT opening
  // the section, which is the entire point of the feature.
  const [expiringCount, setExpiringCount] = useState(0);
  const supabase = createClient();

  const refreshReviewCount = useCallback(async () => {
    try {
      const res = await fetch("/api/orders/review?status=pending");
      if (!res.ok) return; // migration not run / offline — just leave the badge off
      const json = await res.json();
      setReviewCount((json.orders ?? []).length);
    } catch { /* silent — badge is a nicety, never blocks the app */ }
  }, []);
  useEffect(() => { refreshReviewCount(); }, [refreshReviewCount]);

  const refreshExpiringCount = useCallback(async () => {
    try {
      const { expiring } = await loadRedemptions();
      setExpiringCount(countExpiringSoon(expiring));
    } catch { /* silent — badge is a nicety, never blocks the app */ }
  }, []);
  useEffect(() => { refreshExpiringCount(); }, [refreshExpiringCount]);

  async function signOut() {
    await supabase.auth.signOut();
    location.reload();
  }

  // `sub` deep-links into a tab's inner section — currently only Redemptions
  // has them. Without it, Overview's "Add a balance →" landed on Redemptions'
  // default Miles sub-section instead of Card points (fixed 2026-08-17).
  function navigate(t: string, sub?: string) {
    if (!(TABS as readonly string[]).includes(t)) return;
    if (t === "Redemptions" && sub) setRedemptionFocus({ sub: sub as RedemptionSub });
    setTab(t as Tab);
  }

  function openSpendForCard(last4: string) {
    setSpendFocus({ last4 });
    setTab("Spend");
  }

  const navItem = (t: Tab, compact = false) => {
    const active = tab === t;
    // Review's badge is neutral (a queue); Redemptions' is amber (a deadline).
    const badge = t === "Review" ? reviewCount : t === "Redemptions" ? expiringCount : 0;
    const urgent = t === "Redemptions";
    return (
      <button key={t} onClick={() => setTab(t)}
        className={compact
          ? `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              active ? "bg-surface text-gold border border-gold/25" : "text-mist/60 hover:text-mist hover:bg-surface/60"
            }`
          : `w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-left transition-all ${
              active
                ? "bg-surface text-gold border border-gold/20 shadow-card"
                : "text-mist/65 hover:text-mist hover:bg-surface/60 border border-transparent"
            }`}>
        <span className={active ? "text-gold" : "text-mist/50"}>{TAB_ICONS[t]}</span>
        {t}
        {badge > 0 && (
          <span
            title={urgent ? `${badge} expiring in the next 30 days` : undefined}
            className={`${compact ? "" : "ml-auto"} text-2xs px-1.5 py-0.5 rounded-full border tabular-nums leading-none ${
              urgent
                ? "bg-amber/15 text-amber border-amber/30"
                : "bg-gold/15 text-gold border-gold/25"
            }`}>
            {badge}
          </span>
        )}
      </button>
    );
  };

  // Background Gmail sync — runs on open, on refocus, and periodically while
  // the tab is open, so the app stays current without anyone pressing Sync.
  // A successful sync refreshes the nav badges so they reflect the new data.
  const afterAutoSync = useCallback(() => {
    refreshReviewCount();
    refreshExpiringCount();
    refreshTransactionsAll();
  }, [refreshReviewCount, refreshExpiringCount]);

  return (
    <div className="min-h-screen bg-ink">
      <AutoSync onSynced={afterAutoSync} />

      {/* ── Desktop sidebar ────────────────────────────────────────────── */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-60 flex-col border-r border-wire bg-ink z-40">
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-wire">
          <LogoMark />
          <div>
            <div className="font-serif font-semibold text-lg text-gold leading-tight tracking-tight">CardIQ</div>
            <div className="text-2xs text-mist/45 -mt-0.5">credit card intelligence</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {NAV_GROUPS.map((g, i) => (
            <div key={i} className="space-y-1">
              {g.label && (
                <div className="px-3 text-2xs uppercase tracking-widest text-mist/40">{g.label}</div>
              )}
              {g.tabs.map((t) => navItem(t))}
            </div>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-wire space-y-1">
          {navItem("Review")}
          {navItem("Cards")}
          <button onClick={signOut}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-mist/55 hover:text-mist hover:bg-surface/60 transition-all">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.6}>
              <path d="M6 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3M10.5 11 14 8l-3.5-3M14 8H6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      {/* ── Mobile header + nav ────────────────────────────────────────── */}
      <header className="lg:hidden sticky top-0 z-40 border-b border-wire bg-ink/95 backdrop-blur-md">
        <div className="px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LogoMark />
            <span className="font-serif font-semibold text-lg text-gold tracking-tight">CardIQ</span>
          </div>
          <button onClick={signOut}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rim text-xs font-medium text-mist/75 hover:text-mist hover:bg-hover transition-all">
            Sign out
          </button>
        </div>
        <nav className="flex gap-1 px-3 pb-2.5 overflow-x-auto">
          {TABS.map((t) => navItem(t, true))}
        </nav>
      </header>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <main className="lg:pl-60 min-h-screen">
        {tab === "Overview" && <OverviewTab onOpenSpend={openSpendForCard} onNavigate={navigate} />}
        {tab === "Spend"    && <SpendTab focusCard={spendFocus} />}
        {tab === "Orders"   && <OrdersTab />}
        {tab === "Vouchers" && <VouchersTab />}
        {tab === "Review"   && <ReviewTab onChanged={refreshReviewCount} />}
        {tab === "Insights" && <InsightsTab />}
        {tab === "Redemptions" && (
          <RedemptionsTab onNavigate={navigate} onExpiringChange={refreshExpiringCount}
            focusSub={redemptionFocus} />
        )}
        {tab === "Offers"   && <OffersTab />}
        {tab === "Dining"   && <DiningTab />}
        {tab === "Chat"     && <ChatTab />}
        {tab === "Cards"    && <CardsTab />}
      </main>
    </div>
  );
}
