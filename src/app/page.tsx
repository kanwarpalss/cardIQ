"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import OverviewTab from "@/components/OverviewTab";
import SpendTab    from "@/components/SpendTab";
import InsightsTab from "@/components/InsightsTab";
import RewardsTab  from "@/components/RewardsTab";
import OffersTab   from "@/components/OffersTab";
import LoyaltyTab  from "@/components/LoyaltyTab";
import DiningTab   from "@/components/DiningTab";
import ChatTab     from "@/components/ChatTab";
import CardsTab    from "@/components/CardsTab";

const TABS = ["Overview", "Spend", "Insights", "Rewards", "Offers", "Loyalty", "Dining", "Chat", "Cards"] as const;
type Tab = (typeof TABS)[number];

// Sidebar groups — "Cards" lives at the bottom rail (it doubles as settings).
const NAV_GROUPS: { label: string | null; tabs: Tab[] }[] = [
  { label: null,      tabs: ["Overview"] },
  { label: "Money",   tabs: ["Spend", "Insights"] },
  { label: "Perks",   tabs: ["Rewards", "Offers", "Loyalty"] },
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
  Insights: (
    <svg {...ICON_PROPS}><circle cx="8" cy="8" r="6"/><path d="M8 2v6l4.2 2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Rewards: (
    <svg {...ICON_PROPS}><path d="M8 1.5 9.8 5.6l4.2.4-3.2 2.9.9 4.3L8 11l-3.7 2.2.9-4.3L2 6l4.2-.4L8 1.5z" strokeLinejoin="round"/></svg>
  ),
  Offers: (
    <svg {...ICON_PROPS}><path d="M8.6 1.8 14 7.2a1.5 1.5 0 0 1 0 2.1l-4.7 4.7a1.5 1.5 0 0 1-2.1 0L1.8 8.6A1 1 0 0 1 1.5 8V2.5a1 1 0 0 1 1-1H8a1 1 0 0 1 .6.3z" strokeLinejoin="round"/><circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/></svg>
  ),
  Loyalty: (
    <svg {...ICON_PROPS}><path d="M14 2 7.5 8.5M14 2l-3.5 12-2.7-5.8L2 5.5 14 2z" strokeLinecap="round" strokeLinejoin="round"/></svg>
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
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    location.reload();
  }

  function navigate(t: string) {
    if ((TABS as readonly string[]).includes(t)) setTab(t as Tab);
  }

  function openSpendForCard(last4: string) {
    setSpendFocus({ last4 });
    setTab("Spend");
  }

  const navItem = (t: Tab, compact = false) => {
    const active = tab === t;
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
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-ink">

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
        {tab === "Insights" && <InsightsTab />}
        {tab === "Rewards"  && <RewardsTab onNavigate={navigate} />}
        {tab === "Offers"   && <OffersTab />}
        {tab === "Loyalty"  && <LoyaltyTab />}
        {tab === "Dining"   && <DiningTab />}
        {tab === "Chat"     && <ChatTab />}
        {tab === "Cards"    && <CardsTab />}
      </main>
    </div>
  );
}
