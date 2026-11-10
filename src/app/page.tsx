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
import AppNavigation, { TABS, type Tab } from "@/components/AppNavigation";

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
const RedemptionsTab = dynamic(() => import("@/components/RedemptionsTab"), { loading: TAB_LOADING });
const DiningTab      = dynamic(() => import("@/components/DiningTab"), { loading: TAB_LOADING });
const ChatTab        = dynamic(() => import("@/components/ChatTab"), { loading: TAB_LOADING });
const CardsTab       = dynamic(() => import("@/components/CardsTab"), { loading: TAB_LOADING });

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
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function openSpendForCard(last4: string) {
    setSpendFocus({ last4 });
    navigate("Spend");
  }

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

      <AppNavigation tab={tab} onNavigate={navigate} onSignOut={signOut}
        reviewCount={reviewCount} expiringCount={expiringCount} />
      <main id="main-content" tabIndex={-1} className="workspace lg:ml-64 min-h-screen" data-section={tab}>
        {tab === "Overview" && <OverviewTab onOpenSpend={openSpendForCard} onNavigate={navigate} />}
        {tab === "Spend"    && <SpendTab focusCard={spendFocus} />}
        {tab === "Orders"   && <OrdersTab />}
        {tab === "Vouchers" && <VouchersTab />}
        {tab === "Review"   && <ReviewTab onChanged={refreshReviewCount} />}
        {tab === "Redemptions" && (
          <RedemptionsTab onNavigate={navigate} onExpiringChange={refreshExpiringCount}
            focusSub={redemptionFocus} />
        )}
        {tab === "Dining"   && <DiningTab />}
        {tab === "Chat"     && <ChatTab />}
        {tab === "Cards"    && <CardsTab />}
      </main>
    </div>
  );
}
