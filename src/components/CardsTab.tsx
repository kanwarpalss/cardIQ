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

const NETWORK_ICON: Record<string, string> = {
  Visa:       "V",
  Mastercard: "M",
  RuPay:      "R",
  Amex:       "A",
};

export default function CardsTab() {
  const supabase = createClient();
  const [cards,      setCards]      = useState<CardRow[]>([]);
  const [productKey, setProductKey] = useState(Object.keys(CARD_REGISTRY)[0]);
  const [last4,      setLast4]      = useState("");
  const [nickname,   setNickname]   = useState("");
  const [apiKey,     setApiKey]     = useState("");
  const [profile,    setProfile]    = useState("");
  const [savedKey,   setSavedKey]   = useState(false);
  const [formError,  setFormError]  = useState<string | null>(null);
  const [saving,     setSaving]     = useState(false);

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

  useEffect(() => { load(); }, []);

  async function addCard() {
    setFormError(null);
    if (!last4.match(/^\d{4}$/)) { setFormError("Last 4 must be exactly 4 digits."); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from("cards").insert({
      user_id: user.id, product_key: productKey, nickname: nickname || null, last4,
    });
    if (error) { setFormError(error.message); return; }
    setLast4(""); setNickname("");
    load();
  }

  async function removeCard(id: string) {
    if (!confirm("Remove this card? Its transactions will stay in your history.")) return;
    await supabase.from("cards").delete().eq("id", id);
    load();
  }

  async function saveSettings() {
    setSaving(true);
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropic_key: apiKey || undefined, profile_text: profile }),
    });
    setSaving(false);
    if (!res.ok) return;
    setApiKey("");
    load();
  }

  const selectedSpec = CARD_REGISTRY[productKey];

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">

      {/* ── My Cards ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-5">
        <h2 className="font-serif text-lg font-semibold text-gold">My Cards</h2>

        {cards.length === 0 && (
          <p className="text-mist/40 text-sm">No cards added yet. Add your first card below.</p>
        )}

        <div className="space-y-2.5">
          {cards.map((c) => {
            const spec = CARD_REGISTRY[c.product_key];
            const name = c.nickname || spec?.display_name || c.product_key;
            const net  = spec?.network ?? "";
            return (
              <div key={c.id}
                className="flex items-center justify-between px-4 py-3 rounded-xl border border-rim bg-raised hover:bg-hover transition-colors">
                <div className="flex items-center gap-3">
                  {/* Card chip icon */}
                  <div className="w-9 h-6 rounded bg-gold-shimmer flex items-center justify-center shadow-glow-gold shrink-0">
                    <span className="text-ink font-bold text-xs">{NETWORK_ICON[net] ?? "★"}</span>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-mist/90">{name}</div>
                    <div className="text-2xs text-mist/30">
                      <span className="tracking-widest">●●●● ●●●● ●●●● {c.last4}</span>
                    </div>
                  </div>
                </div>
              <button onClick={() => removeCard(c.id)}
                  className="text-2xs text-mist/25 hover:text-ruby transition-colors px-2 py-1">
                  Remove
                </button>
              </div>
            );
          })}
        </div>

        {/* Add card form */}
        <div className="border-t border-wire pt-5 space-y-3">
          <div className="text-2xs uppercase tracking-widest text-mist/30 mb-1">Add card</div>

          <select value={productKey} onChange={(e) => setProductKey(e.target.value)}
            className="w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist focus:border-gold/40 outline-none">
            {Object.values(CARD_REGISTRY).map((s) => (
              <option key={s.product_key} value={s.product_key}>{s.display_name}</option>
            ))}
          </select>

          {selectedSpec && (
            <div className="text-2xs text-mist/35 px-1">
              {selectedSpec.issuer} · {selectedSpec.network}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <input value={nickname} onChange={(e) => setNickname(e.target.value)}
              placeholder="Nickname (optional)"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
            <input value={last4} onChange={(e) => setLast4(e.target.value)} maxLength={4}
              placeholder="Last 4 digits"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none font-mono tracking-widest" />
          </div>

          {formError && (
            <div className="text-xs text-ruby px-1">{formError}</div>
          )}

          <button onClick={addCard}
            className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 transition-all">
            Add card
          </button>
        </div>
      </section>

      {/* ── Settings ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-5">
        <h2 className="font-serif text-lg font-semibold text-gold">Settings</h2>

        <div className="space-y-1.5">
          <label className="text-2xs uppercase tracking-widest text-mist/30 block">
            Anthropic API Key {savedKey && <span className="text-emerald normal-case ml-1">● saved</span>}
          </label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={savedKey ? "•••••• (enter new to replace)" : "sk-ant-…"}
            className="w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
          <p className="text-2xs text-mist/25">Used for the Chat tab — Claude-powered spending insights.</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-2xs uppercase tracking-widest text-mist/30 block">Profile</label>
          <textarea value={profile} onChange={(e) => setProfile(e.target.value)} rows={4}
            placeholder="Describe your spending habits, goals, and what matters to you (e.g. 'I travel frequently, care about lounge access, and spend heavily on dining')…"
            className="w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none resize-none leading-relaxed" />
          <p className="text-2xs text-mist/25">Helps the AI give you more relevant advice.</p>
        </div>

        <button onClick={saveSettings} disabled={saving}
          className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-50 transition-all">
          {saving ? "Saving…" : "Save settings"}
        </button>
      </section>
    </div>
  );
}
