"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { getCardArt } from "@/lib/card-art";
import { fmtDate, fmtINR } from "@/lib/format";
import {
  CALENDAR_YEAR_START,
  currentCalendarMonth,
  currentMilestoneYear,
  inclusiveWindowEnd,
  localDateKey,
  spendInWindow,
  type MilestoneTxn,
} from "@/lib/milestones";

type CardRow = {
  id: string;
  product_key: string;
  nickname: string | null;
  last4: string;
  anniversary_date: string | null;
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
  const [milestoneTxns, setMilestoneTxns] = useState<MilestoneTxn[]>([]);
  const [milestoneError, setMilestoneError] = useState<string | null>(null);
  const [editingPeriod, setEditingPeriod] = useState<string | null>(null);
  const [periodDraft, setPeriodDraft] = useState("");
  const [savingPeriod, setSavingPeriod] = useState(false);
  const [periodMessage, setPeriodMessage] = useState<Record<string, string>>({});

  async function load() {
    const [{ data: cardsData }, { data: settings }] = await Promise.all([
      supabase.from("cards").select("*").order("created_at"),
      supabase.from("user_settings").select("anthropic_key_encrypted, profile_text").single(),
    ]);
    setCards((cardsData as CardRow[]) || []);
    setSavedKey(!!settings?.anthropic_key_encrypted);
    setProfile(settings?.profile_text || "");

    // Milestones need complete history; Supabase pages are capped, so fetch all
    // rows explicitly rather than silently stopping at the first 1,000.
    const all: MilestoneTxn[] = [];
    setMilestoneError(null);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("transactions")
        .select("id, card_last4, amount_inr, original_currency, txn_at, txn_type")
        .order("txn_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) {
        setMilestoneError("Milestone spend couldn't be loaded. Try refreshing Cards.");
        break;
      }
      const page = (data ?? []) as MilestoneTxn[];
      all.push(...page);
      if (page.length < 1000) break;
    }
    setMilestoneTxns(all);
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

  function beginPeriodEdit(card: CardRow) {
    const spec = CARD_REGISTRY[card.product_key];
    const window = currentMilestoneYear(card.anniversary_date, spec?.milestone_year_start);
    setEditingPeriod(card.id);
    setPeriodDraft(localDateKey(window.start));
    setPeriodMessage((prev) => ({ ...prev, [card.id]: "" }));
  }

  async function saveMilestoneYear(card: CardRow, value: string | null) {
    setSavingPeriod(true);
    setPeriodMessage((prev) => ({ ...prev, [card.id]: "" }));
    if (value) {
      const parsed = new Date(value + "T00:00:00");
      if (Number.isNaN(parsed.getTime()) || localDateKey(parsed) !== value) {
        setPeriodMessage((prev) => ({ ...prev, [card.id]: "Choose a valid spending-year start date." }));
        setSavingPeriod(false);
        return;
      }
    }
    const { error } = await supabase.from("cards")
      .update({ anniversary_date: value })
      .eq("id", card.id);
    if (error) {
      setPeriodMessage((prev) => ({ ...prev, [card.id]: error.message }));
    } else {
      setEditingPeriod(null);
      setPeriodMessage((prev) => ({ ...prev, [card.id]: value ? "Spending year updated." : "Card default restored." }));
      await load();
    }
    setSavingPeriod(false);
  }

  const [now] = useState(() => new Date());
  const monthWindow = useMemo(() => currentCalendarMonth(now), [now]);
  const calendarWindow = useMemo(
    () => currentMilestoneYear(null, CALENDAR_YEAR_START, now),
    [now]
  );

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

      {/* ── Milestone tracker ────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-5">
        <div>
          <h2 className="font-serif text-lg font-semibold text-gold">Milestone tracker</h2>
          <p className="text-xs text-mist/55 mt-1 leading-relaxed">
            Each card follows its own spending year. Infinia defaults to 1 Apr–31 Mar; you can change any card or switch it to the calendar year.
          </p>
        </div>

        {milestoneError && (
          <div className="rounded-xl border border-ruby/30 bg-ruby/5 px-4 py-3 text-xs text-ruby">
            {milestoneError}
          </div>
        )}

        {cards.length === 0 ? (
          <p className="text-sm text-mist/50">Add a card above to start tracking milestones.</p>
        ) : (
          <div className="space-y-4">
            {cards.map((card) => {
              const spec = CARD_REGISTRY[card.product_key];
              const name = card.nickname || spec?.display_name || card.product_key;
              const annualWindow = currentMilestoneYear(card.anniversary_date, spec?.milestone_year_start, now);
              const annualSpend = spendInWindow(milestoneTxns, card.last4, annualWindow, now);
              const calendarSpend = spendInWindow(milestoneTxns, card.last4, calendarWindow, now);
              const monthlySpend = spendInWindow(milestoneTxns, card.last4, monthWindow, now);
              const monthly = [...(spec?.milestones_monthly ?? [])].sort((a, b) => a.spend_inr - b.spend_inr);
              const annual = [...(spec?.milestones_anniversary ?? [])].sort((a, b) => a.spend_inr - b.spend_inr);
              const hasMilestones = monthly.length > 0 || annual.length > 0;
              const isEditing = editingPeriod === card.id;

              return (
                <div key={card.id} className="rounded-xl border border-rim bg-raised p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-sm font-medium text-mist/90">{name}</div>
                      <div className="text-2xs text-mist/45 tracking-wider">••{card.last4}</div>
                    </div>
                    <button onClick={() => isEditing ? setEditingPeriod(null) : beginPeriodEdit(card)}
                      className="text-xs text-mist/55 hover:text-gold transition-colors">
                      {isEditing ? "Cancel" : "Edit spending year"}
                    </button>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-2.5">
                    <PeriodStat
                      label="Milestone spending year"
                      range={windowLabel(annualWindow)}
                      value={fmtINR(annualSpend)}
                      note={card.anniversary_date ? "Your custom start" : spec?.milestone_year_start ? "Card default" : "Calendar-year default"}
                    />
                    <PeriodStat
                      label={`Calendar year ${calendarWindow.start.getFullYear()}`}
                      range={windowLabel(calendarWindow)}
                      value={fmtINR(calendarSpend)}
                      note="For comparison"
                    />
                  </div>

                  {isEditing && (
                    <div className="rounded-lg border border-gold/20 bg-ink/50 p-3 space-y-3">
                      <label className="block">
                        <span className="text-2xs uppercase tracking-widest text-mist/50">Spending year starts</span>
                        <input type="date" value={periodDraft} onChange={(e) => setPeriodDraft(e.target.value)}
                          className="mt-1.5 w-full bg-ink border border-rim rounded-lg px-3 py-2 text-sm text-mist focus:border-gold/40 outline-none" />
                      </label>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={() => void saveMilestoneYear(card, periodDraft)} disabled={savingPeriod || !periodDraft}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gold/15 text-gold border border-gold/30 hover:bg-gold/25 disabled:opacity-40">
                          {savingPeriod ? "Saving…" : "Save"}
                        </button>
                        <button onClick={() => setPeriodDraft(`${now.getFullYear()}-01-01`)} disabled={savingPeriod}
                          className="px-3 py-1.5 rounded-lg text-xs text-mist/65 border border-rim hover:text-mist">
                          Use calendar year
                        </button>
                        <button onClick={() => void saveMilestoneYear(card, null)} disabled={savingPeriod}
                          className="px-3 py-1.5 rounded-lg text-xs text-mist/45 hover:text-mist/70">
                          Restore card default
                        </button>
                      </div>
                    </div>
                  )}

                  {periodMessage[card.id] && (
                    <div className={`text-xs ${periodMessage[card.id].includes("updated") || periodMessage[card.id].includes("restored") ? "text-emerald" : "text-ruby"}`}>
                      {periodMessage[card.id]}
                    </div>
                  )}

                  {!hasMilestones ? (
                    <div className="text-xs text-mist/45 border-t border-wire pt-3">
                      No documented spend milestone for this card.
                    </div>
                  ) : (
                    <div className="space-y-4 border-t border-wire pt-4">
                      {monthly.map((milestone) => (
                        <MilestoneProgress key={`monthly-${milestone.spend_inr}`}
                          cadence={`Monthly · ${fmtDate(localDateKey(monthWindow.start))}–${fmtDate(localDateKey(inclusiveWindowEnd(monthWindow)))}`}
                          spent={monthlySpend} target={milestone.spend_inr} reward={milestone.reward} />
                      ))}
                      {annual.map((milestone) => (
                        <MilestoneProgress key={`annual-${milestone.spend_inr}`}
                          cadence={`Spending year · ${windowLabel(annualWindow)}`}
                          spent={annualSpend} target={milestone.spend_inr} reward={milestone.reward} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function windowLabel(window: { start: Date; endExclusive: Date }): string {
  return `${fmtDate(localDateKey(window.start))} – ${fmtDate(localDateKey(inclusiveWindowEnd(window)))}`;
}

function PeriodStat({ label, range, value, note }: {
  label: string;
  range: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-wire bg-ink/35 px-3 py-2.5">
      <div className="text-2xs uppercase tracking-widest text-mist/45">{label}</div>
      <div className="text-xs text-mist/55 mt-1">{range}</div>
      <div className="font-serif text-xl font-semibold text-mist/90 tabular-nums mt-1">{value}</div>
      <div className="text-2xs text-mist/35">{note}</div>
    </div>
  );
}

function MilestoneProgress({ cadence, spent, target, reward }: {
  cadence: string;
  spent: number;
  target: number;
  reward: string;
}) {
  const reached = spent >= target;
  const pct = target > 0 ? Math.min((spent / target) * 100, 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-2xs text-mist/45">{cadence}</div>
          <div className="text-xs text-mist/75 mt-0.5">{fmtINR(target)} · {reward}</div>
        </div>
        <span className={`text-xs font-medium shrink-0 ${reached ? "text-emerald" : "text-gold"}`}>
          {reached ? "Reached ✓" : `${fmtINR(target - spent)} to go`}
        </span>
      </div>
      <div className="h-1.5 bg-ink rounded-full overflow-hidden">
        <div className="h-full bg-gold-shimmer rounded-full transition-all duration-700"
          style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-2xs text-mist/45">
        <span>{Math.round(pct)}%</span>
        <span>{fmtINR(spent)} spent</span>
      </div>
    </div>
  );
}
