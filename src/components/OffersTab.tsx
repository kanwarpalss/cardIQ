"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isMissingTableError } from "@/lib/supabase/errors";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { fmtDate } from "@/lib/format";
import {
  sortOffersForDisplay, effectiveOfferStatus, expiryState, type OfferRow,
} from "@/lib/perks";
import MissingTableNotice from "./MissingTableNotice";

type CardRow = { id: string; last4: string; nickname: string | null; product_key: string };

const cardLabel = (c: CardRow) =>
  c.nickname || CARD_REGISTRY[c.product_key]?.display_name || c.product_key;

const FILTERS = ["Active", "Used", "Expired", "Archived", "All"] as const;
type Filter = (typeof FILTERS)[number];

export default function OffersTab() {
  const supabase = createClient();
  const [cards, setCards] = useState<CardRow[]>([]);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("Active");

  // Add form
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [cardId, setCardId] = useState<string>("");   // "" = all cards
  const [merchant, setMerchant] = useState("");
  const [validUntil, setValidUntil] = useState("");   // "" = no expiry
  const [sourceUrl, setSourceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [cardsRes, offersRes] = await Promise.all([
      supabase.from("cards").select("id,last4,nickname,product_key").order("created_at"),
      supabase.from("offers").select("*"),
    ]);
    setCards((cardsRes.data as CardRow[]) ?? []);
    if (offersRes.error) {
      if (isMissingTableError(offersRes.error)) setMigrationNeeded(true);
      else setError(offersRes.error.message);
    }
    setOffers((offersRes.data as OfferRow[]) ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const sorted = sortOffersForDisplay(offers);
    if (filter === "All") return sorted;
    return sorted.filter((o) => effectiveOfferStatus(o) === filter.toLowerCase());
  }, [offers, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { Active: 0, Used: 0, Expired: 0, Archived: 0 };
    for (const o of offers) {
      const s = effectiveOfferStatus(o);
      c[s.charAt(0).toUpperCase() + s.slice(1)] = (c[s.charAt(0).toUpperCase() + s.slice(1)] || 0) + 1;
    }
    return c;
  }, [offers]);

  async function addOffer() {
    if (!title.trim()) { setError("Give the offer a title."); return; }
    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }
    const { error: err } = await supabase.from("offers").insert({
      user_id: user.id,
      card_id: cardId || null,
      title: title.trim(),
      merchant: merchant.trim() || null,
      description: description.trim() || null,
      valid_until: validUntil || null,
      source_url: sourceUrl.trim() || null,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setTitle(""); setCardId(""); setMerchant(""); setValidUntil(""); setSourceUrl(""); setDescription("");
    setFormOpen(false);
    load();
  }

  async function setStatus(id: string, status: OfferRow["status"]) {
    await supabase.from("offers").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    load();
  }

  async function deleteOffer(id: string) {
    if (!confirm("Delete this offer permanently?")) return;
    await supabase.from("offers").delete().eq("id", id);
    load();
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-mist/60 text-sm">Loading offers…</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6 pb-20">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-mist">Offers</h1>
          <p className="text-sm text-mist/60 mt-1">
            Card offers you want to remember — with expiry chips so none slip past.
          </p>
        </div>
        <button onClick={() => { setFormOpen((v) => !v); setError(null); }} disabled={migrationNeeded}
          className="bg-gold-shimmer text-ink px-4 py-2 rounded-xl text-sm font-semibold shadow-glow-gold hover:opacity-90 disabled:opacity-40 transition-all">
          {formOpen ? "Close" : "+ Add offer"}
        </button>
      </header>

      {migrationNeeded && <MissingTableNotice feature="Offers" />}
      {error && <div className="rounded-xl border border-ruby/30 bg-ruby/5 text-ruby text-sm px-4 py-3">{error}</div>}

      {/* Add form */}
      {formOpen && (
        <section className="rounded-2xl border border-gold/25 bg-surface p-5 shadow-card space-y-3">
          <div className="grid sm:grid-cols-2 gap-2">
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Offer title — e.g. 10% off Amazon with Infinia *"
              className="sm:col-span-2 bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
            <select value={cardId} onChange={(e) => setCardId(e.target.value)}
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist/85 focus:border-gold/40 outline-none">
              <option value="">All cards / not card-specific</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{cardLabel(c)} ··{c.last4}</option>)}
            </select>
            <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Merchant (optional)"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
            <label className="flex items-center gap-2 bg-ink border border-rim rounded-xl px-3 py-2">
              <span className="text-xs text-mist/50 shrink-0">Valid till</span>
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)}
                className="flex-1 bg-transparent text-sm text-mist/85 outline-none" />
            </label>
            <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="Link (optional)"
              className="bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none" />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              placeholder="Details — minimum spend, promo code, T&Cs worth remembering…"
              className="sm:col-span-2 bg-ink border border-rim rounded-xl px-3 py-2 text-sm text-mist placeholder:text-mist/30 focus:border-gold/40 outline-none resize-none" />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={addOffer} disabled={saving}
              className="bg-gold-shimmer text-ink px-5 py-2 rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all">
              {saving ? "Saving…" : "Save offer"}
            </button>
            <span className="text-xs text-mist/45">Leave the date empty for offers with no expiry.</span>
          </div>
        </section>
      )}

      {/* Status filter */}
      <div className="flex gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === f
                ? "bg-gold text-ink shadow-glow-gold"
                : "bg-raised border border-rim text-mist/60 hover:text-mist hover:border-gold/30"
            }`}>
            {f}{f !== "All" && counts[f] ? ` · ${counts[f]}` : ""}
          </button>
        ))}
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-rim bg-surface p-10 shadow-card text-center">
          <p className="text-sm text-mist/60">
            {offers.length === 0
              ? "Nothing tracked yet. Spot a good card offer? Save it before you forget it exists."
              : `No ${filter.toLowerCase()} offers.`}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((o) => {
            const status = effectiveOfferStatus(o);
            const exp = expiryState(o.valid_until, 14);
            const card = cards.find((c) => c.id === o.card_id);
            return (
              <li key={o.id} className={`rounded-2xl border bg-surface p-4 shadow-card ${
                status === "active" ? "border-rim" : "border-wire opacity-70"
              }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-mist/90">{o.title}</div>
                    <div className="text-xs text-mist/55 mt-0.5">
                      {card ? cardLabel(card) : "All cards"}
                      {o.merchant ? ` · ${o.merchant}` : ""}
                      {o.source_url && (
                        <> · <a href={o.source_url} target="_blank" rel="noreferrer" className="text-gold/80 hover:text-gold underline decoration-gold/30">link</a></>
                      )}
                    </div>
                    {o.description && <p className="text-xs text-mist/60 mt-1.5 leading-relaxed">{o.description}</p>}
                  </div>
                  <div className="shrink-0 text-right space-y-2">
                    <span className={`inline-block text-2xs px-2 py-0.5 rounded-full border font-medium ${
                      status === "expired" ? "border-ruby/40 text-ruby bg-ruby/10"
                      : status === "used" ? "border-emerald/40 text-emerald bg-emerald/10"
                      : status === "archived" ? "border-rim text-mist/50"
                      : exp.kind === "soon" ? "border-amber/40 text-amber bg-amber/10"
                      : "border-rim text-mist/60"
                    }`}>
                      {status === "active"
                        ? exp.kind === "none" ? "No expiry"
                          : exp.kind === "soon" ? (exp.days === 0 ? "Expires today!" : `${exp.days}d left`)
                          : `till ${fmtDate(o.valid_until!)}`
                        : status}
                    </span>
                    <div className="flex gap-2 justify-end text-2xs">
                      {status === "active" && (
                        <button onClick={() => setStatus(o.id, "used")} className="text-mist/50 hover:text-emerald transition-colors">mark used</button>
                      )}
                      {status !== "archived" ? (
                        <button onClick={() => setStatus(o.id, "archived")} className="text-mist/50 hover:text-mist transition-colors">archive</button>
                      ) : (
                        <button onClick={() => setStatus(o.id, "active")} className="text-mist/50 hover:text-gold transition-colors">restore</button>
                      )}
                      <button onClick={() => deleteOffer(o.id)} className="text-mist/50 hover:text-ruby transition-colors">delete</button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
