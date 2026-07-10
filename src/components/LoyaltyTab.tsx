"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isMissingTableError } from "@/lib/supabase/errors";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtNum, fmtDate } from "@/lib/format";
import { expiryState, type LoyaltyRow } from "@/lib/perks";
import MissingTableNotice from "./MissingTableNotice";

type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };
const cardLabel = (c: CardRow) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

const GROUPS: { type: LoyaltyRow["program_type"]; label: string; icon: string }[] = [
  { type: "airline", label: "Airlines", icon: "✈" },
  { type: "hotel", label: "Hotels", icon: "⌂" },
  { type: "other", label: "Other programs", icon: "◆" },
];

type FormState = {
  id: string | null; // null = adding new
  program_name: string;
  program_type: LoyaltyRow["program_type"];
  tier: string;
  member_id: string;
  points_balance: string;
  tier_expires_on: string;
  points_expire_on: string;
  linked_card: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  id: null, program_name: "", program_type: "airline", tier: "", member_id: "",
  points_balance: "", tier_expires_on: "", points_expire_on: "", linked_card: "", notes: "",
};

export default function LoyaltyTab() {
  const supabase = createClient();
  const [rows, setRows] = useState<LoyaltyRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [loyaltyRes, cardsRes] = await Promise.all([
      supabase.from("loyalty_accounts").select("*").order("program_name"),
      supabase.from("cards").select("id,last4,nickname,product_key").order("created_at"),
    ]);
    if (loyaltyRes.error) {
      if (isMissingTableError(loyaltyRes.error)) setMigrationNeeded(true);
      else setError(loyaltyRes.error.message);
    }
    setRows((loyaltyRes.data as LoyaltyRow[]) ?? []);
    setCards((cardsRes.data as CardRow[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Card-granted travel perks — pure reference data straight from the card
  // registry (lounge access), not user-entered. Only cards that actually
  // document a lounge entitlement show up here; nothing fabricated.
  const cardPerks = useMemo(() => {
    return cards
      .map((c) => ({ card: c, spec: CARD_REGISTRY[c.product_key] }))
      .filter(({ spec }) => spec?.lounge?.domestic || spec?.lounge?.international);
  }, [cards]);

  const grouped = useMemo(() => {
    const m = new Map<string, LoyaltyRow[]>();
    for (const g of GROUPS) m.set(g.type, []);
    for (const r of rows) (m.get(r.program_type) ?? m.get("other")!).push(r);
    return m;
  }, [rows]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function startEdit(row: LoyaltyRow) {
    setError(null);
    setForm({
      id: row.id,
      program_name: row.program_name,
      program_type: row.program_type,
      tier: row.tier ?? "",
      member_id: row.member_id ?? "",
      points_balance: row.points_balance !== null ? String(row.points_balance) : "",
      tier_expires_on: row.tier_expires_on ?? "",
      points_expire_on: row.points_expire_on ?? "",
      linked_card: row.linked_card ?? "",
      notes: row.notes ?? "",
    });
  }

  async function save() {
    if (!form) return;
    if (!form.program_name.trim()) { setError("Program name is required."); return; }
    const points = form.points_balance.trim()
      ? Number(form.points_balance.replace(/[,\s]/g, ""))
      : null;
    if (points !== null && !isFinite(points)) { setError("Points balance must be a number."); return; }

    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const payload = {
      program_name: form.program_name.trim(),
      program_type: form.program_type,
      tier: form.tier.trim() || null,
      member_id: form.member_id.trim() || null,
      points_balance: points,
      tier_expires_on: form.tier_expires_on || null,
      points_expire_on: form.points_expire_on || null,
      linked_card: form.linked_card.trim() || null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const { error: err } = form.id
      ? await supabase.from("loyalty_accounts").update(payload).eq("id", form.id)
      : await supabase.from("loyalty_accounts").insert({ ...payload, user_id: user.id });

    setSaving(false);
    if (err) { setError(err.message); return; }
    setForm(null);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Remove this loyalty program?")) return;
    await supabase.from("loyalty_accounts").delete().eq("id", id);
    load();
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-mist/60 text-sm">Loading loyalty programs…</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6 pb-20">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-mist">Loyalty</h1>
          <p className="text-sm text-mist/60 mt-1">
            Airline and hotel statuses in one place — tiers, member numbers, points, and when they lapse.
          </p>
        </div>
        <button onClick={() => { setForm(form ? null : { ...EMPTY_FORM }); setError(null); }} disabled={migrationNeeded}
          className="bg-gold-shimmer text-ink px-4 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-40 transition-all">
          {form ? "Close" : "+ Add program"}
        </button>
      </header>

      {migrationNeeded && <MissingTableNotice feature="Loyalty" />}
      {error && <div className="rounded-xl border border-ruby/30 bg-ruby/5 text-ruby text-sm px-4 py-3">{error}</div>}

      {/* ── Card-granted travel perks — read-only reference from the card
           registry (lounge access), never user-entered. Distinct visual
           treatment (dashed border, no edit/delete) so it's clearly not the
           same kind of data as the manual accounts below. ─────────────────── */}
      {cardPerks.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-xs uppercase tracking-widest text-mist/60">Granted by your cards</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {cardPerks.map(({ card, spec }) => (
              <div key={card.id} className="rounded-2xl border border-dashed border-rim bg-surface/60 p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-mist/85">{cardLabel(card)}</span>
                  {spec.benefits_verified_at && (
                    <span className="text-2xs text-mist/40 shrink-0">
                      verified {fmtDate(spec.benefits_verified_at)}
                    </span>
                  )}
                </div>
                <div className="mt-2 space-y-1 text-xs text-mist/60">
                  {spec.lounge.domestic && (
                    <div>
                      <span className="text-mist/40">Domestic:</span>{" "}
                      {spec.lounge.domestic.provider} — {String(spec.lounge.domestic.visits_per_year)}
                      {typeof spec.lounge.domestic.visits_per_year === "number" ? " visits/yr" : ""}
                    </div>
                  )}
                  {spec.lounge.international && (
                    <div>
                      <span className="text-mist/40">International:</span>{" "}
                      {spec.lounge.international.provider} — {String(spec.lounge.international.visits_per_year)}
                      {typeof spec.lounge.international.visits_per_year === "number" ? " visits/yr" : ""}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Add / edit form */}
      {form && (
        <section className="rounded-2xl border border-gold/25 bg-surface p-5 shadow-card space-y-3">
          <div className="text-sm font-medium text-mist/85">{form.id ? "Edit program" : "New program"}</div>
          <div className="grid sm:grid-cols-2 gap-2">
            <input autoFocus value={form.program_name} onChange={(e) => set("program_name", e.target.value)}
              placeholder="Program — e.g. Air India Maharaja Club *"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
            <select value={form.program_type} onChange={(e) => set("program_type", e.target.value as LoyaltyRow["program_type"])}
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none">
              <option value="airline">Airline</option>
              <option value="hotel">Hotel</option>
              <option value="other">Other</option>
            </select>
            <input value={form.tier} onChange={(e) => set("tier", e.target.value)} placeholder="Tier / status — e.g. Gold"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
            <input value={form.member_id} onChange={(e) => set("member_id", e.target.value)} placeholder="Membership number"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none font-mono" />
            <input value={form.points_balance} onChange={(e) => set("points_balance", e.target.value)}
              placeholder="Points / miles balance" inputMode="numeric"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none tabular-nums" />
            <input value={form.linked_card} onChange={(e) => set("linked_card", e.target.value)}
              placeholder="Granted by card (optional) — e.g. HSBC Premier"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
            <label className="flex items-center gap-2 bg-ink border border-rim rounded-xl px-3 py-2">
              <span className="text-xs text-mist/50 shrink-0">Tier valid till</span>
              <input type="date" value={form.tier_expires_on} onChange={(e) => set("tier_expires_on", e.target.value)}
                className="flex-1 bg-transparent text-sm text-mist/85 outline-none" />
            </label>
            <label className="flex items-center gap-2 bg-ink border border-rim rounded-xl px-3 py-2">
              <span className="text-xs text-mist/50 shrink-0">Points expire</span>
              <input type="date" value={form.points_expire_on} onChange={(e) => set("points_expire_on", e.target.value)}
                className="flex-1 bg-transparent text-sm text-mist/85 outline-none" />
            </label>
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2}
              placeholder="Notes — e.g. status match till Dec, need 2 more stays…"
              className="sm:col-span-2 bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none resize-none" />
          </div>
          <button onClick={save} disabled={saving}
            className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all">
            {saving ? "Saving…" : form.id ? "Save changes" : "Add program"}
          </button>
        </section>
      )}

      {/* Groups */}
      {rows.length === 0 && !migrationNeeded && !form ? (
        cardPerks.length === 0 && (
          <div className="rounded-2xl border border-rim bg-surface p-10 shadow-card text-center">
            <div className="font-serif text-lg font-semibold text-mist mb-1">Nothing here yet</div>
            <p className="text-sm text-mist/60">
              Add your airline and hotel programs to see every status, tier and points balance next to your cards.
            </p>
          </div>
        )
      ) : (
        <>
        {cardPerks.length > 0 && rows.length > 0 && (
          <h2 className="text-xs uppercase tracking-widest text-mist/60 pt-1">Your personal accounts</h2>
        )}
        {GROUPS.map(({ type, label, icon }) => {
          const list = grouped.get(type) ?? [];
          if (list.length === 0) return null;
          return (
            <section key={type} className="space-y-2.5">
              <h2 className="text-xs uppercase tracking-widest text-mist/60">{icon} {label}</h2>
              {list.map((l) => {
                const tierExp = expiryState(l.tier_expires_on);
                const ptsExp = expiryState(l.points_expire_on, 60);
                return (
                  <div key={l.id} className="rounded-2xl border border-rim bg-surface p-4 shadow-card">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className="text-sm font-medium text-mist/90">{l.program_name}</span>
                          {l.tier && (
                            <span className={`text-2xs px-2 py-0.5 rounded-full border font-medium ${
                              tierExp.kind === "expired"
                                ? "border-ruby/40 text-ruby bg-ruby/10"
                                : "border-gold/40 text-gold bg-gold/10"
                            }`}>
                              {l.tier}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-mist/55 mt-1 space-x-2">
                          {l.member_id && <span className="font-mono">{l.member_id}</span>}
                          {l.linked_card && <span>· via {l.linked_card}</span>}
                        </div>
                        {(l.tier_expires_on || l.notes) && (
                          <div className="text-xs mt-1.5 space-y-0.5">
                            {l.tier_expires_on && (
                              <div className={
                                tierExp.kind === "expired" ? "text-ruby"
                                : tierExp.kind === "soon" ? "text-amber" : "text-mist/50"
                              }>
                                {tierExp.kind === "expired"
                                  ? `Tier expired ${fmtDate(l.tier_expires_on)}`
                                  : tierExp.kind === "soon"
                                  ? `Tier expires in ${tierExp.days} days — ${fmtDate(l.tier_expires_on)}`
                                  : `Tier valid till ${fmtDate(l.tier_expires_on)}`}
                              </div>
                            )}
                            {l.notes && <div className="text-mist/55">{l.notes}</div>}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {l.points_balance !== null && (
                          <>
                            <div className="font-serif text-xl font-semibold text-gold tabular-nums">
                              {fmtNum(Number(l.points_balance))}
                            </div>
                            <div className={`text-2xs ${
                              ptsExp.kind === "expired" ? "text-ruby" : ptsExp.kind === "soon" ? "text-amber" : "text-mist/45"
                            }`}>
                              {ptsExp.kind === "none" ? "points"
                                : ptsExp.kind === "expired" ? `expired ${fmtDate(l.points_expire_on!)}`
                                : ptsExp.kind === "soon" ? `expire in ${ptsExp.days}d`
                                : `valid till ${fmtDate(l.points_expire_on!)}`}
                            </div>
                          </>
                        )}
                        <div className="flex gap-2 justify-end mt-2 text-2xs">
                          <button onClick={() => startEdit(l)} className="text-mist/50 hover:text-gold transition-colors">edit</button>
                          <button onClick={() => remove(l.id)} className="text-mist/50 hover:text-ruby transition-colors">remove</button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
        </>
      )}
    </div>
  );
}
