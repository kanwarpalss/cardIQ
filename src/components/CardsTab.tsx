"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { CardFace } from "./CardVisual";
import { fmtDate } from "@/lib/format";
import CardRetentionNote from "./CardRetentionNote";

type CardRow = {
  id: string;
  product_key: string;
  nickname: string | null;
  last4: string;
  anniversary_date: string | null;
};


type GmailScopeStatus = {
  status: "ok" | "no_token" | "insufficient_scope" | "expired_token" | "error";
  message: string;
  fix?: string;
  email?: string;
};

export default function CardsTab() {
  const [section, setSection] = useState<"wallet" | "benefits" | "settings">("wallet");
  const supabase = createClient();
  const [cards,      setCards]      = useState<CardRow[]>([]);
  const [productKey, setProductKey] = useState(Object.keys(CARD_REGISTRY)[0]);
  const [last4,      setLast4]      = useState("");
  const [nickname,   setNickname]   = useState("");
  const [apiKey,     setApiKey]     = useState("");
  const [profile,    setProfile]    = useState("");
  const [savedKey,   setSavedKey]   = useState(false);
  const [gmailUser,       setGmailUser]       = useState("");
  const [gmailAppPassword, setGmailAppPassword] = useState("");
  const [savedAppPassword, setSavedAppPassword] = useState(false);
  const [formError,  setFormError]  = useState<string | null>(null);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [gmailStatus, setGmailStatus] = useState<GmailScopeStatus | null>(null);
  const [checkingGmail, setCheckingGmail] = useState(false);

  async function load() {
    const [{ data: cardsData }, { data: settings }] = await Promise.all([
      supabase.from("cards").select("*").order("created_at"),
      supabase.from("user_settings")
        .select("anthropic_key_encrypted, profile_text, gmail_user, gmail_app_password_encrypted")
        .single(),
    ]);
    setCards((cardsData as CardRow[]) || []);
    setSavedKey(!!settings?.anthropic_key_encrypted);
    setProfile(settings?.profile_text || "");
    setGmailUser(settings?.gmail_user || "");
    setSavedAppPassword(!!settings?.gmail_app_password_encrypted);
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
      body: JSON.stringify({
        anthropic_key: apiKey || undefined,
        profile_text: profile,
        gmail_user: gmailUser || undefined,
        gmail_app_password: gmailAppPassword || undefined,
      }),
    });
    setSaving(false);
    if (!res.ok) return;
    setApiKey("");
    setGmailAppPassword("");
    load();
    checkGmail();
  }

  const selectedSpec = CARD_REGISTRY[productKey];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-4">

      <div><p className="eyebrow mb-2">YOUR COLLECTION</p><h1 className="font-serif text-3xl font-semibold">Cards with possibilities.</h1></div>
      <div className="view-switch" role="group" aria-label="Cards view">
        {([['wallet', 'My cards'], ['benefits', 'Benefits'], ['settings', 'Settings']] as const).map(([key,label]) => <button type="button" key={key} aria-pressed={section === key} onClick={() => setSection(key)}>{label}</button>)}
      </div>
      <div hidden={section !== "wallet"} className="space-y-4">
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
            return (
              <div key={c.id}
                className="px-4 py-3 rounded-xl border border-rim bg-raised hover:bg-hover transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="card-thumb"><CardFace productKey={c.product_key} /></span>
                    <div className="min-w-0 break-words">
                      <div className="text-sm font-medium text-mist/90">{name}</div>
                      <div className="text-2xs text-mist/55">
                        <span className="tracking-widest">●●●● ●●●● ●●●● {c.last4}</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => removeCard(c.id)}
                    className="shrink-0 text-2xs text-mist/60 hover:text-ruby transition-colors px-2 py-1">
                    Remove
                  </button>
                </div>
                {spec?.benefits_verified_at && (
                  <div className="mt-2.5 pt-2.5 border-t border-wire text-right text-2xs text-mist/35">
                    Benefits verified {fmtDate(spec.benefits_verified_at)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add card form */}
        <details className="disclosure-panel" open={cards.length === 0 || !!formError || undefined}>
          <summary>Add a card <span>Product &amp; account details</span></summary>
          <div className="space-y-3 mt-3">

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
        </details>
      </section>

      {cards.some(card => card.product_key === "hdfc_infinia") && <CardRetentionNote />}
      </div>
      <div hidden={section !== "benefits"}>
      {/* ── Bills by card ────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-3">
        <div>
          <h2 className="font-serif text-lg font-semibold text-gold">Utility and rent bills</h2>
          <p className="text-xs text-mist/55 mt-1 leading-relaxed">
            Banks decide by how the payment is coded, so try a small payment first when a biller is new.
          </p>
        </div>
        <div className="space-y-2">
          {Object.values(CARD_REGISTRY).map((spec) => (
            <details key={spec.product_key} className="rounded-xl border border-rim bg-raised px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-mist/90">{spec.display_name}</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {([["Utilities", spec.bill_rules?.utilities], ["Rent", spec.bill_rules?.rent]] as const).map(([label, rule]) => (
                  <div key={label} className="space-y-1 text-xs text-mist/70 leading-relaxed">
                    <div className="text-2xs uppercase tracking-widest text-mist/55">{label}</div>
                    <p>{rule?.earns ?? "Not checked yet"}</p>
                    {rule?.limit && <p>Limit: {rule.limit}</p>}
                    {rule?.fee && <p>Fee: {rule.fee}</p>}
                    {rule?.milestones && <p>Milestones: {rule.milestones}</p>}
                  </div>
                ))}
              </div>
              {spec.benefits_verified_at && (
                <div className="mt-3 text-right text-2xs text-mist/35">Checked {fmtDate(spec.benefits_verified_at)}</div>
              )}
            </details>
          ))}
        </div>
      </section>

      </div>
      <div hidden={section !== "settings"} className="space-y-4">
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
            Gmail address
          </label>
          <input type="email" value={gmailUser} onChange={(e) => setGmailUser(e.target.value)}
            placeholder="you@gmail.com"
            className="w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
        </div>

        <div className="space-y-1.5">
          <label className="text-2xs uppercase tracking-widest text-mist/55 block">
            Gmail app password {savedAppPassword && <span className="text-emerald normal-case ml-1">● saved</span>}
          </label>
          <input type="password" value={gmailAppPassword} onChange={(e) => setGmailAppPassword(e.target.value)}
            placeholder={savedAppPassword ? "•••• •••• •••• •••• (enter new to replace)" : "xxxx xxxx xxxx xxxx"}
            className="w-full bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/25 focus:border-gold/40 outline-none" />
          <p className="text-2xs text-mist/25">
            Replaces signing in with Google — this never expires, unlike the 7-day OAuth
            connection. Create one at myaccount.google.com/apppasswords (needs 2-Step
            Verification turned on first).
          </p>
        </div>

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
    </div>
  );
}
