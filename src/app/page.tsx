"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ChatTab from "@/components/ChatTab";
import SpendTab from "@/components/SpendTab";
import CardsTab from "@/components/CardsTab";
import SessionsTab from "@/components/SessionsTab";

const TABS = ["Chat", "Spend", "Cards", "Sessions"] as const;
type Tab = (typeof TABS)[number];

export default function Home() {
  const [tab, setTab] = useState<Tab>("Chat");
  const supabase = createClient();

  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-line px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h1 className="font-serif text-xl text-gold">CardIQ</h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-sm rounded ${
                  tab === t ? "bg-gold text-ink" : "opacity-70 hover:opacity-100"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
        <button
          onClick={() => supabase.auth.signOut().then(() => location.reload())}
          className="text-xs opacity-50 hover:opacity-100"
        >
          Sign out
        </button>
      </header>

      <section className="flex-1 overflow-hidden">
        {tab === "Chat" && <ChatTab />}
        {tab === "Spend" && <SpendTab />}
        {tab === "Cards" && <CardsTab />}
        {tab === "Sessions" && <SessionsTab />}
      </section>
    </main>
  );
}
