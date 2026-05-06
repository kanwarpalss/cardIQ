"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CARD_REGISTRY } from "@/lib/cards/registry";

type CardRow = {
  id: string;
  product_key: string;
  nickname: string | null;
  last4: string;
};

export default function CardsTab() {
  const supabase = createClient();
  const [cards, setCards] = useState<CardRow[]>([]);
  const [productKey, setProductKey] = useState(Object.keys(CARD_REGISTRY)[0]);
  const [last4, setLast4] = useState("");
  const [nickname, setNickname] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [profile, setProfile] = useState("");
  const [savedKey, setSavedKey] = useState(false);

  async function load() {
    const { data: cardsData } = await supabase.from("cards").select("*").order("created_at");
    setCards((cardsData as CardRow[]) || []);
    const { data: settings } = await supabase
      .from("user_settings")
      .select("anthropic_key_encrypted, profile_text")
      .single();
    setSavedKey(!!settings?.anthropic_key_encrypted);
    setProfile(settings?.profile_text || "");
  }

  useEffect(() => {
    load();
  }, []);

  async function addCard() {
    if (!last4.match(/^\d{4}$/)) return alert("last4 must be 4 digits");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from("cards").insert({
      user_id: user.id,
      product_key: productKey,
      nickname: nickname || null,
      last4,
    });
    if (error) return alert(error.message);
    setLast4("");
    setNickname("");
    load();
  }

  async function removeCard(id: string) {
    await supabase.from("cards").delete().eq("id", id);
    load();
  }

  async function saveSettings() {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropic_key: apiKey || undefined, profile_text: profile }),
    });
    if (!res.ok) return alert("save failed");
    setApiKey("");
    load();
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <section>
        <h2 className="font-serif text-2xl text-gold mb-3">Settings</h2>
        <label className="text-xs opacity-60">Anthropic API Key {savedKey && <span className="text-green-400">(saved)</span>}</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={savedKey ? "•••••• (replace)" : "sk-ant-..."}
          className="w-full bg-panel border border-line rounded px-3 py-2 mb-3"
        />
        <label className="text-xs opacity-60">Profile (spending habits, goals, preferences)</label>
        <textarea
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          rows={3}
          className="w-full bg-panel border border-line rounded px-3 py-2 mb-3"
        />
        <button onClick={saveSettings} className="bg-gold text-ink px-4 py-1.5 rounded text-sm">
          Save settings
        </button>
      </section>

      <section>
        <h2 className="font-serif text-2xl text-gold mb-3">My Cards</h2>
        <div className="space-y-2 mb-4">
          {cards.map((c) => (
            <div key={c.id} className="flex justify-between items-center border border-line rounded px-3 py-2">
              <div>
                <div>{c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key}</div>
                <div className="text-xs opacity-50">••{c.last4}</div>
              </div>
              <button onClick={() => removeCard(c.id)} className="text-xs opacity-50 hover:opacity-100">
                remove
              </button>
            </div>
          ))}
          {cards.length === 0 && <p className="opacity-50 text-sm">No cards yet.</p>}
        </div>

        <div className="border border-line rounded p-3 space-y-2">
          <div className="text-sm opacity-70">Add card</div>
          <select
            value={productKey}
            onChange={(e) => setProductKey(e.target.value)}
            className="w-full bg-panel border border-line rounded px-3 py-2"
          >
            {Object.values(CARD_REGISTRY).map((s) => (
              <option key={s.product_key} value={s.product_key}>
                {s.display_name}
              </option>
            ))}
          </select>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Nickname (optional)"
            className="w-full bg-panel border border-line rounded px-3 py-2"
          />
          <input
            value={last4}
            onChange={(e) => setLast4(e.target.value)}
            placeholder="Last 4 digits"
            className="w-full bg-panel border border-line rounded px-3 py-2"
          />
          <button onClick={addCard} className="bg-gold text-ink px-4 py-1.5 rounded text-sm">
            Add
          </button>
        </div>
      </section>
    </div>
  );
}
