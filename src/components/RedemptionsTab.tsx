"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isMissingColumnError } from "@/lib/supabase/errors";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtNum, fmtINR, fmtDate, ymd, daysUntil } from "@/lib/format";
import {
  expiryState, latestBalanceByCard,
  type LoyaltyRow, type RewardBalanceRow,
} from "@/lib/perks";
import {
  sortVouchersForDisplay, effectiveVoucherStatus, VOUCHER_TYPE_LABELS,
  type PerkVoucherRow, type ExpiringItem,
} from "@/lib/redemptions";
import {
  loadRedemptions, cardLabel, EXPIRY_WINDOW_DAYS,
  type RedemptionsData, type RedemptionCard,
} from "@/lib/redemptions-data";
import MissingTableNotice from "./MissingTableNotice";

// ── Sub-section chrome ──────────────────────────────────────────────────────

const SUBS = [
  { key: "miles",    label: "Miles & status", hint: "Airline and hotel programs" },
  { key: "points",   label: "Card points",    hint: "Point balances per card" },
  { key: "vouchers", label: "Vouchers",       hint: "Certificates you've been granted" },
] as const;
type Sub = (typeof SUBS)[number]["key"];

const inputCls =
  "bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none";
const btnPrimary =
  "bg-gold-shimmer text-ink px-4 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-40 transition-all";

/** Date field with a persistent label — a bare date input reads as gibberish. */
function DateField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 bg-ink border border-rim rounded-xl px-3 py-2">
      <span className="text-xs text-mist/50 shrink-0">{label}</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-transparent text-sm text-mist/85 outline-none" />
    </label>
  );
}

function SectionEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-rim bg-surface p-10 shadow-card text-center">
      <div className="font-serif text-lg font-semibold text-mist mb-1">{title}</div>
      <p className="text-sm text-mist/60 max-w-md mx-auto">{body}</p>
    </div>
  );
}

// ── Expiring-soon strip ─────────────────────────────────────────────────────

const KIND_LABEL: Record<ExpiringItem["kind"], string> = {
  miles: "Miles", points: "Card points", voucher: "Voucher",
};

function ExpiringStrip({ items, onJump }: {
  items: ExpiringItem[]; onJump: (sub: Sub) => void;
}) {
  if (items.length === 0) return null;
  const jumpFor = (k: ExpiringItem["kind"]): Sub =>
    k === "miles" ? "miles" : k === "points" ? "points" : "vouchers";

  return (
    <section className="rounded-2xl border border-amber/40 bg-amber/5 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0 text-amber" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h2 className="text-sm font-semibold text-amber">
          Expiring soon — next {EXPIRY_WINDOW_DAYS} days
        </h2>
      </div>
      <div className="space-y-1.5">
        {items.map((i) => {
          const gone = i.days < 0;
          return (
            <button key={i.id} onClick={() => onJump(jumpFor(i.kind))}
              className="w-full flex items-center justify-between gap-3 text-left rounded-xl px-3 py-2 hover:bg-amber/10 transition-colors">
              <span className="min-w-0">
                <span className="text-sm text-mist/90">{i.label}</span>
                <span className="text-2xs text-mist/45 ml-2">
                  {KIND_LABEL[i.kind]}{i.detail ? ` · ${i.detail}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                {i.amount !== null && (
                  <span className="text-sm tabular-nums text-mist/70">
                    {fmtNum(i.amount)}{i.unit ? ` ${i.unit}` : ""}
                  </span>
                )}
                <span className={`text-xs font-medium tabular-nums ${gone ? "text-ruby" : "text-amber"}`}>
                  {gone
                    ? `expired ${fmtDate(i.expires_on)}`
                    : i.days === 0
                    ? "expires today"
                    : `${i.days}d left`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MILES & STATUS — airline/hotel programs (loyalty_accounts)
// ═══════════════════════════════════════════════════════════════════════════

const GROUPS: { type: LoyaltyRow["program_type"]; label: string; icon: string }[] = [
  { type: "airline", label: "Airlines", icon: "✈" },
  { type: "hotel", label: "Hotels", icon: "⌂" },
  { type: "other", label: "Other programs", icon: "◆" },
];

type LoyaltyForm = {
  id: string | null;
  program_name: string; program_type: LoyaltyRow["program_type"];
  tier: string; member_id: string; points_balance: string;
  tier_expires_on: string; points_expire_on: string; linked_card: string; notes: string;
};
const EMPTY_LOYALTY: LoyaltyForm = {
  id: null, program_name: "", program_type: "airline", tier: "", member_id: "",
  points_balance: "", tier_expires_on: "", points_expire_on: "", linked_card: "", notes: "",
};

function MilesSection({ data, reload, setError }: {
  data: RedemptionsData; reload: () => void; setError: (m: string | null) => void;
}) {
  const supabase = createClient();
  const [form, setForm] = useState<LoyaltyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const rows = data.loyalty;

  // Card-granted travel perks — read-only reference straight from the card
  // registry (lounge access), not user-entered. Kept from the old Loyalty tab.
  const cardPerks = useMemo(
    () => data.cards
      .map((c) => ({ card: c, spec: CARD_REGISTRY[c.product_key] }))
      .filter(({ spec }) => spec?.lounge?.domestic || spec?.lounge?.international),
    [data.cards]
  );

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const src = q
      ? rows.filter((r) =>
          `${r.program_name} ${r.tier ?? ""} ${r.member_id ?? ""} ${r.notes ?? ""}`
            .toLowerCase().includes(q))
      : rows;
    const m = new Map<string, LoyaltyRow[]>();
    for (const g of GROUPS) m.set(g.type, []);
    for (const r of src) (m.get(r.program_type) ?? m.get("other")!).push(r);
    return m;
  }, [rows, search]);

  const set = <K extends keyof LoyaltyForm>(k: K, v: LoyaltyForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  function startEdit(row: LoyaltyRow) {
    setError(null);
    setForm({
      id: row.id, program_name: row.program_name, program_type: row.program_type,
      tier: row.tier ?? "", member_id: row.member_id ?? "",
      points_balance: row.points_balance !== null ? String(row.points_balance) : "",
      tier_expires_on: row.tier_expires_on ?? "", points_expire_on: row.points_expire_on ?? "",
      linked_card: row.linked_card ?? "", notes: row.notes ?? "",
    });
  }

  async function save() {
    if (!form) return;
    if (!form.program_name.trim()) { setError("Program name is required."); return; }
    const points = form.points_balance.trim()
      ? Number(form.points_balance.replace(/[,\s]/g, "")) : null;
    if (points !== null && !isFinite(points)) { setError("Points balance must be a number."); return; }

    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const payload = {
      program_name: form.program_name.trim(), program_type: form.program_type,
      tier: form.tier.trim() || null, member_id: form.member_id.trim() || null,
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
    setForm(null); reload();
  }

  async function remove(id: string) {
    if (!confirm("Remove this program? This can't be undone.")) return;
    const { error: err } = await supabase.from("loyalty_accounts").delete().eq("id", id);
    if (err) { setError(err.message); return; }
    reload();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-mist/60">
          Airline and hotel programs — tiers, member numbers, balances, and when they lapse.
        </p>
        <button onClick={() => { setForm(form ? null : { ...EMPTY_LOYALTY }); setError(null); }}
          disabled={data.perksTableMissing} className={btnPrimary}>
          {form ? "Close" : "+ Add program"}
        </button>
      </div>

      {cardPerks.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="text-xs uppercase tracking-widest text-mist/60">Granted by your cards</h3>
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
                    <div><span className="text-mist/40">Domestic:</span>{" "}
                      {spec.lounge.domestic.provider} — {String(spec.lounge.domestic.visits_per_year)}
                      {typeof spec.lounge.domestic.visits_per_year === "number" ? " visits/yr" : ""}
                    </div>
                  )}
                  {spec.lounge.international && (
                    <div><span className="text-mist/40">International:</span>{" "}
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

      {form && (
        <section className="rounded-2xl border border-gold/25 bg-surface p-5 shadow-card space-y-3">
          <div className="text-sm font-medium text-mist/85">{form.id ? "Edit program" : "New program"}</div>
          <div className="grid sm:grid-cols-2 gap-2">
            <input autoFocus value={form.program_name} onChange={(e) => set("program_name", e.target.value)}
              placeholder="Program — e.g. Marriott Bonvoy *" className={inputCls} />
            <select value={form.program_type}
              onChange={(e) => set("program_type", e.target.value as LoyaltyRow["program_type"])}
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none">
              <option value="airline">Airline</option>
              <option value="hotel">Hotel</option>
              <option value="other">Other</option>
            </select>
            <input value={form.tier} onChange={(e) => set("tier", e.target.value)}
              placeholder="Tier / status — e.g. Titanium" className={inputCls} />
            <input value={form.member_id} onChange={(e) => set("member_id", e.target.value)}
              placeholder="Membership number" className={`${inputCls} font-mono`} />
            <input value={form.points_balance} onChange={(e) => set("points_balance", e.target.value)}
              placeholder="Points / miles balance" inputMode="numeric" className={`${inputCls} tabular-nums`} />
            <input value={form.linked_card} onChange={(e) => set("linked_card", e.target.value)}
              placeholder="Granted by card (optional)" className={inputCls} />
            <DateField label="Tier valid till" value={form.tier_expires_on}
              onChange={(v) => set("tier_expires_on", v)} />
            <DateField label="Points expire" value={form.points_expire_on}
              onChange={(v) => set("points_expire_on", v)} />
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2}
              placeholder="Notes — e.g. status match till Dec, need 2 more stays…"
              className={`sm:col-span-2 ${inputCls} resize-none`} />
          </div>
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? "Saving…" : form.id ? "Save changes" : "Add program"}
          </button>
        </section>
      )}

      {rows.length === 0 && !data.perksTableMissing && !form && cardPerks.length === 0 ? (
        <SectionEmpty title="No programs yet"
          body="Add your airline and hotel programs to see every status, balance and expiry date in one place." />
      ) : (
        <>
          {rows.length > 1 && (
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search programs — name, tier, member #…"
              className={`w-full sm:max-w-sm ${inputCls}`} />
          )}
          {search.trim() && [...grouped.values()].every((l) => l.length === 0) && (
            <div className="text-sm text-mist/55 py-4">No programs match your search.</div>
          )}
          {GROUPS.map(({ type, label, icon }) => {
            const list = grouped.get(type) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={type} className="space-y-2.5">
                <h3 className="text-xs uppercase tracking-widest text-mist/60">{icon} {label}</h3>
                {list.map((l) => {
                  const tierExp = expiryState(l.tier_expires_on);
                  const ptsExp = expiryState(l.points_expire_on, EXPIRY_WINDOW_DAYS);
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
                                  : "border-gold/40 text-gold bg-gold/10"}`}>
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
                                  : tierExp.kind === "soon" ? "text-amber" : "text-mist/50"}>
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
                                ptsExp.kind === "expired" ? "text-ruby"
                                : ptsExp.kind === "soon" ? "text-amber" : "text-mist/45"}`}>
                                {ptsExp.kind === "none" ? (l.program_type === "airline" ? "miles" : "points")
                                  : ptsExp.kind === "expired" ? `expired ${fmtDate(l.points_expire_on!)}`
                                  : ptsExp.kind === "soon" ? `expire in ${ptsExp.days}d`
                                  : `valid till ${fmtDate(l.points_expire_on!)}`}
                              </div>
                            </>
                          )}
                          <div className="flex gap-2 justify-end mt-2 text-2xs">
                            <button onClick={() => startEdit(l)}
                              className="text-mist/50 hover:text-gold transition-colors">edit</button>
                            <button onClick={() => remove(l.id)}
                              className="text-mist/50 hover:text-ruby transition-colors">remove</button>
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

// ═══════════════════════════════════════════════════════════════════════════
// CARD POINTS — per-card balance snapshots (reward_balances)
// ═══════════════════════════════════════════════════════════════════════════

function PointsSection({ data, reload, setError, onNavigate }: {
  data: RedemptionsData; reload: () => void;
  setError: (m: string | null) => void; onNavigate: (tab: string) => void;
}) {
  const supabase = createClient();
  const [search, setSearch] = useState("");
  const [formCard, setFormCard] = useState<string | null>(null);
  const [balance, setBalance] = useState("");
  const [asOf, setAsOf] = useState(ymd(new Date()));
  const [expiresOn, setExpiresOn] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const latest = useMemo(() => latestBalanceByCard(data.rewards), [data.rewards]);
  const byCard = useMemo(() => {
    const m = new Map<string, RewardBalanceRow[]>();
    for (const r of data.rewards) {
      if (!m.has(r.card_id)) m.set(r.card_id, []);
      m.get(r.card_id)!.push(r);
    }
    return m;
  }, [data.rewards]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.cards;
    return data.cards.filter((c) =>
      `${cardLabel(c)} ${CARD_REGISTRY[c.product_key]?.rewards?.program ?? ""}`
        .toLowerCase().includes(q));
  }, [data.cards, search]);

  function openForm(card: RedemptionCard) {
    const current = latest.get(card.id);
    setFormCard(card.id);
    setBalance("");
    setAsOf(ymd(new Date()));
    // Carry the previous expiry forward — it usually hasn't changed, and
    // re-typing it every update is exactly the friction that leaves it blank.
    setExpiresOn(current?.points_expire_on ?? "");
    setNotes("");
    setError(null);
  }

  async function saveSnapshot(card: RedemptionCard) {
    const value = Number(balance.replace(/[,\s]/g, ""));
    if (!balance.trim() || !isFinite(value)) { setError("Balance must be a number."); return; }
    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const spec = CARD_REGISTRY[card.product_key];
    const base = {
      user_id: user.id, card_id: card.id,
      program: spec?.rewards?.program ?? "Reward points",
      balance: value, as_of: asOf, notes: notes.trim() || null,
    };

    let { error: err } = await supabase
      .from("reward_balances")
      .insert({ ...base, points_expire_on: expiresOn || null });

    // Pre-021 database: the column doesn't exist yet. Save the balance anyway
    // rather than losing the user's entry — the expiry notice above tells them
    // why the date didn't stick (EDGE-03: never silently drop).
    if (isMissingColumnError(err, "points_expire_on")) {
      ({ error: err } = await supabase.from("reward_balances").insert(base));
      if (!err && expiresOn) {
        setError("Balance saved, but the expiry date needs migration 021 — run it and re-enter the date.");
      }
    }

    setSaving(false);
    if (err) { setError(err.message); return; }
    setFormCard(null); reload();
  }

  async function deleteSnapshot(id: string) {
    if (!confirm("Delete this balance entry?")) return;
    const { error: err } = await supabase.from("reward_balances").delete().eq("id", id);
    if (err) { setError(err.message); return; }
    reload();
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-mist/60">
        Point balances per card. Enter what your bank app shows — CardIQ keeps the history
        and warns you before the points expire.
      </p>

      {data.expiryColumnMissing && (
        <MissingTableNotice feature="points expiry"
          migration="021_redemptions.sql"
          what="Balances work, but the expiry-date column doesn't exist yet." />
      )}

      {data.cards.length > 1 && (
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search cards…" className={`w-full sm:max-w-xs ${inputCls}`} />
      )}

      {data.cards.length === 0 && !data.perksTableMissing && (
        <div className="rounded-2xl border border-rim bg-surface p-8 shadow-card text-center">
          <div className="font-serif text-lg font-semibold text-mist mb-1">No cards yet</div>
          <p className="text-sm text-mist/60 mb-4">Add a card first — point balances live on your cards.</p>
          <button onClick={() => onNavigate("Cards")} className={btnPrimary}>Add a card →</button>
        </div>
      )}

      {shown.map((card) => {
        const spec = CARD_REGISTRY[card.product_key];
        const current = latest.get(card.id);
        const history = byCard.get(card.id) ?? [];
        const staleDays = current ? Math.max(0, -daysUntil(current.as_of)) : 0;
        const exp = expiryState(current?.points_expire_on ?? null, EXPIRY_WINDOW_DAYS);
        const formOpen = formCard === card.id;

        return (
          <section key={card.id} className="rounded-2xl border border-rim bg-surface p-6 shadow-card space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="font-serif text-lg font-semibold text-mist">{cardLabel(card)}</h3>
                <div className="text-xs text-mist/55 mt-0.5">
                  {spec?.rewards
                    ? <>{spec.rewards.program} · earns {spec.rewards.earn_summary}</>
                    : "No reward program on file for this card"}
                </div>
              </div>
              <div className="text-right">
                {current ? (
                  <>
                    <div className="font-serif text-3xl font-semibold text-gold tabular-nums">
                      {fmtNum(Number(current.balance))}
                    </div>
                    <div className={`text-xs mt-0.5 ${staleDays > 45 ? "text-amber" : "text-mist/50"}`}>
                      as of {fmtDate(current.as_of)}{staleDays > 45 ? ` · ${staleDays} days old` : ""}
                    </div>
                    {exp.kind !== "none" && (
                      <div className={`text-xs mt-0.5 font-medium ${
                        exp.kind === "expired" ? "text-ruby"
                        : exp.kind === "soon" ? "text-amber" : "text-mist/45"}`}>
                        {exp.kind === "expired"
                          ? `expired ${fmtDate(current.points_expire_on!)}`
                          : exp.kind === "soon"
                          ? `expires in ${exp.days}d — ${fmtDate(current.points_expire_on!)}`
                          : `valid till ${fmtDate(current.points_expire_on!)}`}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-mist/50">No balance yet</div>
                )}
              </div>
            </div>

            {history.length > 1 && (
              <div className="border-t border-wire pt-3 space-y-1.5">
                <div className="text-xs text-mist/55 mb-1">History</div>
                {history.slice(0, 6).map((h, i) => {
                  const next = history[i + 1];
                  const delta = next ? Number(h.balance) - Number(next.balance) : null;
                  return (
                    <div key={h.id} className="flex items-center justify-between text-sm group">
                      <span className="text-mist/60">
                        {fmtDate(h.as_of)}{h.notes ? <span className="text-mist/40"> · {h.notes}</span> : ""}
                      </span>
                      <span className="flex items-center gap-3">
                        {delta !== null && delta !== 0 && (
                          <span className={`text-xs tabular-nums ${delta > 0 ? "text-emerald" : "text-ruby"}`}>
                            {delta > 0 ? "+" : ""}{fmtNum(delta)}
                          </span>
                        )}
                        <span className="text-mist/85 tabular-nums">{fmtNum(Number(h.balance))}</span>
                        <button onClick={() => deleteSnapshot(h.id)} title="Delete entry"
                          className="text-mist/30 hover:text-ruby text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                          ✕
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {formOpen ? (
              <div className="border-t border-wire pt-4 space-y-2">
                <div className="grid sm:grid-cols-2 gap-2">
                  <input autoFocus value={balance} onChange={(e) => setBalance(e.target.value)}
                    placeholder="Current balance" inputMode="numeric" className={`${inputCls} tabular-nums`} />
                  <DateField label="Balance as of" value={asOf} onChange={setAsOf} />
                  <DateField label="Points expire" value={expiresOn} onChange={setExpiresOn} />
                  <input value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="Note (optional)" className={inputCls} />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => saveSnapshot(card)} disabled={saving || data.perksTableMissing}
                    className={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
                  <button onClick={() => setFormCard(null)}
                    className="px-3 py-2 rounded-xl border border-rim text-sm text-mist/70 hover:bg-hover transition-all">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => openForm(card)} disabled={data.perksTableMissing}
                className="text-sm text-gold hover:text-gold/80 font-medium disabled:opacity-40 transition-colors">
                {current ? "Update balance →" : "Add first balance →"}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// VOUCHERS — granted certificates (perk_vouchers)
// ═══════════════════════════════════════════════════════════════════════════

type VoucherForm = {
  id: string | null;
  brand: string; title: string; voucher_type: PerkVoucherRow["voucher_type"];
  quantity: string; value_inr: string; expires_on: string;
  card_id: string; granted_by: string; code: string;
  status: PerkVoucherRow["status"]; notes: string;
};
const EMPTY_VOUCHER: VoucherForm = {
  id: null, brand: "", title: "", voucher_type: "hotel_night", quantity: "1",
  value_inr: "", expires_on: "", card_id: "", granted_by: "", code: "",
  status: "unused", notes: "",
};

const STATUS_STYLE: Record<PerkVoucherRow["status"], string> = {
  unused: "border-emerald/40 text-emerald bg-emerald/10",
  used: "border-rim text-mist/50 bg-hover",
  expired: "border-ruby/40 text-ruby bg-ruby/10",
  archived: "border-rim text-mist/40 bg-hover",
};

function VouchersSection({ data, reload, setError }: {
  data: RedemptionsData; reload: () => void; setError: (m: string | null) => void;
}) {
  const supabase = createClient();
  const [form, setForm] = useState<VoucherForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showDone, setShowDone] = useState(false);

  const cardsById = useMemo(
    () => new Map(data.cards.map((c) => [c.id, c])), [data.cards]
  );

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const src = q
      ? data.vouchers.filter((v) =>
          `${v.brand} ${v.title ?? ""} ${v.granted_by ?? ""} ${v.notes ?? ""}`
            .toLowerCase().includes(q))
      : data.vouchers;
    return sortVouchersForDisplay(src);
  }, [data.vouchers, search]);

  // Used/expired/archived hide behind a toggle — the point of this section is
  // what's still redeemable, not a graveyard.
  const live = sorted.filter((v) => effectiveVoucherStatus(v) === "unused");
  const done = sorted.filter((v) => effectiveVoucherStatus(v) !== "unused");
  const visible = showDone ? sorted : live;

  const set = <K extends keyof VoucherForm>(k: K, v: VoucherForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  function startEdit(v: PerkVoucherRow) {
    setError(null);
    setForm({
      id: v.id, brand: v.brand, title: v.title ?? "", voucher_type: v.voucher_type,
      quantity: String(v.quantity), value_inr: v.value_inr !== null ? String(v.value_inr) : "",
      expires_on: v.expires_on ?? "", card_id: v.card_id ?? "",
      granted_by: v.granted_by ?? "", code: v.code ?? "", status: v.status, notes: v.notes ?? "",
    });
  }

  async function save() {
    if (!form) return;
    if (!form.brand.trim()) { setError("Brand is required — e.g. Taj, Marriott."); return; }
    const qty = Number(form.quantity.replace(/[,\s]/g, "") || "1");
    if (!Number.isInteger(qty) || qty < 1) { setError("Quantity must be a whole number of 1 or more."); return; }
    const value = form.value_inr.trim() ? Number(form.value_inr.replace(/[,\s]/g, "")) : null;
    if (value !== null && !isFinite(value)) { setError("Value must be a number."); return; }

    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const payload = {
      brand: form.brand.trim(), title: form.title.trim() || null,
      voucher_type: form.voucher_type, quantity: qty, value_inr: value,
      expires_on: form.expires_on || null, card_id: form.card_id || null,
      granted_by: form.granted_by.trim() || null, code: form.code.trim() || null,
      status: form.status, notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { error: err } = form.id
      ? await supabase.from("perk_vouchers").update(payload).eq("id", form.id)
      : await supabase.from("perk_vouchers").insert({ ...payload, user_id: user.id });

    setSaving(false);
    if (err) { setError(err.message); return; }
    setForm(null); reload();
  }

  async function setStatus(v: PerkVoucherRow, status: PerkVoucherRow["status"]) {
    const { error: err } = await supabase.from("perk_vouchers")
      .update({ status, updated_at: new Date().toISOString() }).eq("id", v.id);
    if (err) { setError(err.message); return; }
    reload();
  }

  async function remove(id: string) {
    if (!confirm("Remove this voucher? This can't be undone.")) return;
    const { error: err } = await supabase.from("perk_vouchers").delete().eq("id", id);
    if (err) { setError(err.message); return; }
    reload();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-mist/60 max-w-xl">
          Certificates and vouchers you&apos;ve been <em>granted</em> — free hotel nights,
          flight vouchers, milestone gift cards. Vouchers you <em>bought</em> live in the
          Vouchers tab under Money.
        </p>
        <button onClick={() => { setForm(form ? null : { ...EMPTY_VOUCHER }); setError(null); }}
          disabled={data.vouchersTableMissing} className={btnPrimary}>
          {form ? "Close" : "+ Add voucher"}
        </button>
      </div>

      {data.vouchersTableMissing && (
        <MissingTableNotice feature="Vouchers" migration="021_redemptions.sql" />
      )}

      {form && (
        <section className="rounded-2xl border border-gold/25 bg-surface p-5 shadow-card space-y-3">
          <div className="text-sm font-medium text-mist/85">
            {form.id ? "Edit voucher" : "New voucher"}
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            <input autoFocus value={form.brand} onChange={(e) => set("brand", e.target.value)}
              placeholder="Brand — e.g. Taj, Marriott, Vistara *" className={inputCls} />
            <select value={form.voucher_type}
              onChange={(e) => set("voucher_type", e.target.value as PerkVoucherRow["voucher_type"])}
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none">
              {(Object.keys(VOUCHER_TYPE_LABELS) as PerkVoucherRow["voucher_type"][]).map((t) => (
                <option key={t} value={t}>{VOUCHER_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <input value={form.title} onChange={(e) => set("title", e.target.value)}
              placeholder="What it is — e.g. 1 free night, category 1-4"
              className={`sm:col-span-2 ${inputCls}`} />
            <input value={form.quantity} onChange={(e) => set("quantity", e.target.value)}
              placeholder="How many you hold" inputMode="numeric" className={`${inputCls} tabular-nums`} />
            <input value={form.value_inr} onChange={(e) => set("value_inr", e.target.value)}
              placeholder="Approx value ₹ (optional)" inputMode="numeric" className={`${inputCls} tabular-nums`} />
            <DateField label="Expires on" value={form.expires_on} onChange={(v) => set("expires_on", v)} />
            <select value={form.card_id} onChange={(e) => set("card_id", e.target.value)}
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none">
              <option value="">Not tied to a card</option>
              {data.cards.map((c) => (
                <option key={c.id} value={c.id}>{cardLabel(c)} ••{c.last4}</option>
              ))}
            </select>
            <input value={form.granted_by} onChange={(e) => set("granted_by", e.target.value)}
              placeholder="How you got it — e.g. Magnus milestone" className={inputCls} />
            <input value={form.code} onChange={(e) => set("code", e.target.value)}
              placeholder="Voucher code (optional)" className={`${inputCls} font-mono`} />
            <select value={form.status}
              onChange={(e) => set("status", e.target.value as PerkVoucherRow["status"])}
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none">
              <option value="unused">Unused</option>
              <option value="used">Used</option>
              <option value="archived">Archived</option>
            </select>
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2}
              placeholder="Notes — e.g. blackout dates over Diwali, must book 21d ahead…"
              className={`sm:col-span-2 ${inputCls} resize-none`} />
          </div>
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? "Saving…" : form.id ? "Save changes" : "Add voucher"}
          </button>
        </section>
      )}

      {data.vouchers.length === 0 && !data.vouchersTableMissing && !form ? (
        <SectionEmpty title="No vouchers yet"
          body="Add the free-night certificates, flight vouchers and milestone perks you're holding, so they stop quietly expiring in your inbox." />
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            {data.vouchers.length > 1 && (
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search vouchers — brand, type, source…"
                className={`w-full sm:max-w-sm ${inputCls}`} />
            )}
            {done.length > 0 && (
              <button onClick={() => setShowDone((s) => !s)}
                className="text-xs text-mist/55 hover:text-gold transition-colors shrink-0">
                {showDone ? "Hide" : "Show"} used &amp; expired ({done.length})
              </button>
            )}
          </div>

          {visible.length === 0 && (
            <div className="text-sm text-mist/55 py-4">
              {search.trim() ? "No vouchers match your search." : "Nothing unused right now."}
            </div>
          )}

          <div className="space-y-2.5">
            {visible.map((v) => {
              const status = effectiveVoucherStatus(v);
              const exp = expiryState(v.expires_on, EXPIRY_WINDOW_DAYS);
              const card = v.card_id ? cardsById.get(v.card_id) : null;
              return (
                <div key={v.id} className="rounded-2xl border border-rim bg-surface p-4 shadow-card">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-sm font-medium text-mist/90">{v.brand}</span>
                        {v.quantity > 1 && (
                          <span className="text-2xs px-1.5 py-0.5 rounded-full border border-gold/30 text-gold bg-gold/10 tabular-nums">
                            ×{v.quantity}
                          </span>
                        )}
                        <span className={`text-2xs px-2 py-0.5 rounded-full border font-medium ${STATUS_STYLE[status]}`}>
                          {status}
                        </span>
                        <span className="text-2xs text-mist/40">
                          {VOUCHER_TYPE_LABELS[v.voucher_type]}
                        </span>
                      </div>
                      {v.title && <div className="text-sm text-mist/70 mt-1">{v.title}</div>}
                      <div className="text-xs text-mist/50 mt-1 space-x-2">
                        {v.granted_by && <span>via {v.granted_by}</span>}
                        {card && <span>· {cardLabel(card)} ••{card.last4}</span>}
                        {v.code && <span className="font-mono text-mist/60">· {v.code}</span>}
                      </div>
                      {v.notes && <div className="text-xs text-mist/55 mt-1">{v.notes}</div>}
                    </div>

                    <div className="text-right shrink-0">
                      {v.value_inr !== null && (
                        <div className="font-serif text-lg font-semibold text-gold tabular-nums">
                          {fmtINR(Number(v.value_inr))}
                        </div>
                      )}
                      <div className={`text-2xs ${
                        exp.kind === "expired" ? "text-ruby"
                        : exp.kind === "soon" ? "text-amber" : "text-mist/45"}`}>
                        {exp.kind === "none" ? "no expiry"
                          : exp.kind === "expired" ? `expired ${fmtDate(v.expires_on!)}`
                          : exp.kind === "soon" ? `expires in ${exp.days}d`
                          : `valid till ${fmtDate(v.expires_on!)}`}
                      </div>
                      <div className="flex gap-2 justify-end mt-2 text-2xs">
                        {status === "unused" && (
                          <button onClick={() => setStatus(v, "used")}
                            className="text-mist/50 hover:text-emerald transition-colors">mark used</button>
                        )}
                        {v.status === "used" && (
                          <button onClick={() => setStatus(v, "unused")}
                            className="text-mist/50 hover:text-gold transition-colors">unmark</button>
                        )}
                        <button onClick={() => startEdit(v)}
                          className="text-mist/50 hover:text-gold transition-colors">edit</button>
                        <button onClick={() => remove(v.id)}
                          className="text-mist/50 hover:text-ruby transition-colors">remove</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SHELL
// ═══════════════════════════════════════════════════════════════════════════

export default function RedemptionsTab({
  onNavigate, onExpiringChange,
}: {
  onNavigate: (tab: string) => void;
  /** Keeps the sidebar badge in step after an edit on this page. */
  onExpiringChange?: () => void;
}) {
  const [sub, setSub] = useState<Sub>("miles");
  const [data, setData] = useState<RedemptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const d = await loadRedemptions();
    setData(d);
    setLoading(false);
    onExpiringChange?.();
  }, [onExpiringChange]);

  useEffect(() => { reload(); }, [reload]);

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-24 text-mist/60 text-sm">
        Loading redemptions…
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6 pb-20">
      <header>
        <h1 className="font-serif text-2xl font-semibold text-mist">Redemptions</h1>
        <p className="text-sm text-mist/60 mt-1">
          Everything you&apos;re holding that&apos;s worth redeeming — and when it runs out.
        </p>
      </header>

      <ExpiringStrip items={data.expiring} onJump={setSub} />

      {data.perksTableMissing && <MissingTableNotice feature="Redemptions" />}
      {error && (
        <div className="rounded-xl border border-ruby/30 bg-ruby/5 text-ruby text-sm px-4 py-3">
          {error}
        </div>
      )}

      <nav className="flex gap-1 border-b border-wire">
        {SUBS.map((s) => (
          <button key={s.key} onClick={() => { setSub(s.key); setError(null); }} title={s.hint}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
              sub === s.key
                ? "border-gold text-gold"
                : "border-transparent text-mist/55 hover:text-mist"}`}>
            {s.label}
          </button>
        ))}
      </nav>

      {sub === "miles" && <MilesSection data={data} reload={reload} setError={setError} />}
      {sub === "points" && (
        <PointsSection data={data} reload={reload} setError={setError} onNavigate={onNavigate} />
      )}
      {sub === "vouchers" && <VouchersSection data={data} reload={reload} setError={setError} />}
    </div>
  );
}
