"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ChatTab     from "@/components/ChatTab";
import SpendTab    from "@/components/SpendTab";
import CardsTab    from "@/components/CardsTab";

const TABS = ["Spend", "Chat", "Cards"] as const;
type Tab = (typeof TABS)[number];

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  Spend: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.8}>
      <path d="M2 5h12M2 5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/>
      <circle cx="8" cy="10" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  ),
  Chat: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.8}>
      <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3 2v-2H3a1 1 0 0 1-1-1V3z" strokeLinejoin="round"/>
    </svg>
  ),
  Cards: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.8}>
      <rect x="1" y="4" width="14" height="10" rx="2"/>
      <path d="M1 7h14" strokeLinecap="square"/>
    </svg>
  ),
};

export default function Home() {
  const [tab, setTab] = useState<Tab>("Spend");
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    location.reload();
  }

  return (
    <div className="min-h-screen flex flex-col bg-ink">
      {/* ── Top navigation ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-wire bg-ink/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-6">

          {/* Wordmark */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gold-shimmer flex items-center justify-center shadow-glow-gold">
              <svg className="w-3.5 h-3.5 text-ink" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2.2}>
                <rect x="1" y="4" width="14" height="10" rx="2"/>
                <path d="M1 7h14" strokeLinecap="square"/>
                <circle cx="4.5" cy="11" r="1" fill="#070b14" stroke="none"/>
              </svg>
            </div>
            <span className="font-serif font-semibold text-lg text-gold tracking-tight">CardIQ</span>
          </div>

          {/* Tab pills */}
          <nav className="flex gap-1 flex-1">
            {TABS.map((t) => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    active
                      ? "bg-surface text-gold border border-gold/20 shadow-card"
                      : "text-mist/50 hover:text-mist hover:bg-surface/50"
                  }`}
                >
                  <span className={active ? "text-gold" : "text-mist/40"}>{TAB_ICONS[t]}</span>
                  {t}
                </button>
              );
            })}
          </nav>

          {/* Sign out */}
          <button
            onClick={signOut}
            className="text-xs text-mist/30 hover:text-mist/70 transition-colors shrink-0"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        {tab === "Spend" && <SpendTab />}
        {tab === "Chat"  && <ChatTab />}
        {tab === "Cards" && <CardsTab />}
      </main>
    </div>
  );
}
