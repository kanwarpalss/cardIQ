"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { getCardArt } from "@/lib/card-art";
import { fmtDate, fmtINR } from "@/lib/format";
import type { CardSpec } from "@/lib/cards/types";

// Honest summary lines — only what the registry actually documents, ALL of
// it (a card can have both monthly and anniversary milestones, e.g. EPM).
// Cards with an unverified/unknown milestone (e.g. HDFC Infinia's quarterly
// bonus, see hdfc-infinia.ts) correctly show nothing rather than a guess.
function milestoneSummary(spec?: CardSpec): string[] {
  if (!spec) return [];
  return [
    ...spec.milestones_monthly.map(
      (m) => `Monthly: ${fmtINR(m.spend_inr)} → ${m.reward}`
    ),
    ...spec.milestones_anniversary.map(
      (m) => `Anniversary year: ${fmtINR(m.spend_inr)} → ${m.reward}`
    ),
  ];
}

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

type GmailScopeStatus = {
  status: "ok" | "no_token" | "insufficient_scope" | "expired_token" | "error";
  message: string;
  fix?: string;
  email?: string;
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
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [gmailStatus, setGmailStatus] = useState<GmailScopeStatus | null>(null);
  const [checkingGmail, setCheckingGmail] = useState(false);

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

  async function checkGmail() {
    setCheckingGmail(true);
    try {
      const res = await fetch("/api/gmail/scope-check");
      setGmailStatus(await res.json());
    } catch (e) {
      setGmailStatus({ status: "error", message: (e as Error).message });
    } finally {
      setCheckingGmail(false);
    }
  }

  useEffect(() => { load(); checkGmail(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addCard() {
    setFormError(null);
    setBackfillNote(null);
    if (!last4.match(/^\d{4}$/)) { setFormError("Last 4 must be exactly 4 digits."); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Insert the card and grab its id back so we can immediately backfill.
    const { data: inserted, error } = await supabase
      .from("cards")
      .insert({ user_id: user.id, product_key: productKey, nickname: nickname || null, last4 })
      .select("id")
      .maybeSingle();
    if (error) { setFormError(error.message); return; }
    if (!inserted?.id) { setFormError("Card inserted but id missing."); return; }

    setLast4(""); setNickname("");
    setBackfillNote("Linking historic transactions\u2026");

    // Auto-run the offline backfill: links orphan transactions with matching
    // last4 + re-runs the sniffer over previously-unparsed emails. No Gmail
    // round-trip, so this finishes in seconds.
    try {
      const res = await fetch("/api/cards/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_id: inserted.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBackfillNote(`\u26a0 Backfill issue: ${data.error || "unknown"}`);
      } else {
        const total = (data.linked_orphans ?? 0) + (data.recovered_from_unparsed ?? 0);
        setBackfillNote(
          total > 0
            ? `\u2728 Linked ${data.linked_orphans} existing txns + recovered ${data.recovered_from_unparsed} from previously-unparsed emails.`
            : `\u2713 No historic transactions found for this card (yet). New ones will appear after the next sync.`
        );
      }
    } catch (e) {
      setBackfillNote(`\u26a0 Backfill failed: ${(e as Error).message}`);
    }

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
          <p className="text-mist/60 text-sm">No cards added yet. Add your first card below.</p>
        )}

        <div className="space-y-2.5">
          {cards.map((c) => {
            const spec = CARD_REGISTRY[c.product_key];
            const name = c.nickname || spec?.display_name || c.product_key;
            const net  = spec?.network ?? "";
            const summary = milestoneSummary(spec);
            return (
              <div key={c.id}
                className="px-4 py-3 rounded-xl border border-rim bg-raised hover:bg-hover transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Mini card face in the product's real colors */}
                    <div className="w-10 h-7 rounded-md border border-white/15 flex items-center justify-center shrink-0"
                      style={{ background: getCardArt(c.product_key).gradient }}>
                      <span className="font-bold text-xs" style={{ color: getCardArt(c.product_key).accent }}>
                        {NETWORK_ICON[net.split(" ")[0]] ?? "★"}
                      </span>
                    </div>
                    <div>
                      <div className="text-sm font-medium text-mist/90">{name}</div>
                      <div className="text-2xs text-mist/55">
                        <span className="tracking-widest">●●●● ●●●● ●●●● {c.last4}</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => removeCard(c.id)}
                    className="text-2xs text-mist/25 hover:text-ruby transition-colors px-2 py-1">
                    Remove
                  </button>
                </div>
                {(summary.length > 0 || spec?.benefits_verified_at) && (
                  <div className="mt-2.5 pt-2.5 border-t border-wire flex items-baseline justify-between gap-3 text-2xs">
                    <span className="text-mist/55 space-y-0.5">
                      {summary.length > 0
                        ? summary.map((line) => <span key={line} className="block">{line}</span>)
                        : "No documented milestone on file"}
                    </span>
                    {spec?.benefits_verified_at && (
                      <span className="text-mist/35 shrink-0">verified {fmtDate(spec.benefits_verified_at)}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add card form */}
        <div className="border-t border-wire pt-5 space-y-3">
          <div className="text-2xs uppercase tracking-widest text-mist/55 mb-1">Add card</div>

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
          {backfillNote && (
            <div className="text-xs text-mist/60 px-1">{backfillNote}</div>
          )}

          <button onClick={addCard}
            className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 transition-all">
            Add card
          </button>
        </div>
      </section>

      {/* ── Gmail connection ─────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-gold">Gmail connection</h2>
          <button onClick={checkGmail} disabled={checkingGmail}
            className="text-xs text-mist/60 hover:text-gold disabled:opacity-40 transition-colors">
            {checkingGmail ? "Checking…" : "Check now"}
          </button>
        </div>
        {!gmailStatus ? (
          <p className="text-sm text-mist/50">Checking Gmail access…</p>
        ) : (
          <div className={`rounded-xl border px-4 py-3 text-sm space-y-1.5 ${
            gmailStatus.status === "ok"
              ? "border-emerald/30 bg-emerald/5"
              : gmailStatus.status === "no_token"
              ? "border-rim bg-raised"
              : "border-ruby/30 bg-ruby/5"
          }`}>
            <div className={`font-medium ${
              gmailStatus.status === "ok" ? "text-emerald" : gmailStatus.status === "no_token" ? "text-mist/70" : "text-ruby"
            }`}>
              {gmailStatus.status === "ok" && "🟢 Connected"}
              {gmailStatus.status === "no_token" && "⚪ Not connected"}
              {gmailStatus.status === "insufficient_scope" && "🔴 Insufficient permission"}
              {gmailStatus.status === "expired_token" && "🔴 Access expired"}
              {gmailStatus.status === "error" && "🔴 Check failed"}
            </div>
            <p className="text-mist/70">{gmailStatus.message}</p>
            {gmailStatus.fix && <p className="text-mist/55 text-xs leading-relaxed">{gmailStatus.fix}</p>}
          </div>
        )}
      </section>

      {/* ── Settings ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-5">
        <h2 className="font-serif text-lg font-semibold text-gold">Settings</h2>

        <div className="space-y-1.5">
          <label className="text-2xs uppercase tracking-widest text-mist/55 block">
            Anthropic API Key {savedKey && <span className="text-emerald normal-case ml-1">● saved</span>}
          </label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={savedKey ? "•••••• (enter new to replace)" : "sk-ant-…"}
            className="w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
          <p className="text-2xs text-mist/25">Used for the Chat tab — Claude-powered spending insights.</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-2xs uppercase tracking-widest text-mist/55 block">Profile</label>
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
