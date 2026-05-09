import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Per-card sync health check. Surfaces:
 *
 *   • Per-card monthly txn counts for the last 12 months
 *   • Anomaly flags: months with 0 txns sandwiched between months that had
 *     activity → likely parser break or sender domain change
 *   • Days-since-last-txn per card (stale-card detector)
 *   • Counts of low-confidence (sniffer-matched) and unparsed-but-suspected
 *     emails awaiting review
 *
 * Designed to be hit periodically (e.g. dashboard widget, cron alert).
 */

const MONTHS_BACK = 12;
const STALE_THRESHOLD_DAYS = 35; // ~5 weeks — beyond a normal monthly gap

type MonthBucket = { ym: string; count: number; total_inr: number };

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // ── Cards owned by this user ──────────────────────────────────────────────
  const { data: cards } = await supabase
    .from("cards")
    .select("id, last4, nickname, product_key, issuer")
    .eq("user_id", user.id)
    .order("nickname");

  if (!cards || cards.length === 0) {
    return NextResponse.json({ cards: [], summary: { total_cards: 0 } });
  }

  // ── Pull last N months of transactions in one query ───────────────────────
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
  cutoff.setDate(1);
  cutoff.setHours(0, 0, 0, 0);

  const { data: txns } = await supabase
    .from("transactions")
    .select("card_id, card_last4, amount_inr, txn_at, txn_type, low_confidence")
    .eq("user_id", user.id)
    .gte("txn_at", cutoff.toISOString());

  // ── Build monthly buckets keyed by card_id ────────────────────────────────
  const cardMonthly = new Map<string, Map<string, MonthBucket>>();
  const cardLowConf = new Map<string, number>();
  const cardLastTxn = new Map<string, string>();

  // Pre-seed each card with all 12 month keys = 0 so missing months are
  // explicitly visible (otherwise they'd just be absent and easy to miss).
  const allMonths: string[] = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    allMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  for (const card of cards) {
    const m = new Map<string, MonthBucket>();
    for (const ym of allMonths) m.set(ym, { ym, count: 0, total_inr: 0 });
    cardMonthly.set(card.id, m);
  }

  for (const t of txns || []) {
    if (!t.card_id) continue;
    const buckets = cardMonthly.get(t.card_id);
    if (!buckets) continue;
    const d = new Date(t.txn_at);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const bucket = buckets.get(ym);
    if (bucket) {
      bucket.count++;
      // Refunds reduce net spend — track signed total so users can sanity-check.
      const signed = t.txn_type === "credit" ? -t.amount_inr : t.amount_inr;
      bucket.total_inr += signed;
    }

    if (t.low_confidence) cardLowConf.set(t.card_id, (cardLowConf.get(t.card_id) ?? 0) + 1);

    const prev = cardLastTxn.get(t.card_id);
    if (!prev || new Date(t.txn_at) > new Date(prev)) cardLastTxn.set(t.card_id, t.txn_at);
  }

  // ── Suspected unparsed emails (per user, not per card) ────────────────────
  // These are gmail_seen_messages with no linked transaction — could indicate
  // marketing (fine), or a parser miss (problem). We surface the count so the
  // user knows whether it's worth running the discovery sweep.
  const { count: unparsedCount } = await supabase
    .from("gmail_seen_messages")
    .select("gmail_message_id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("txn_id", null);

  // ── Per-card analysis with anomaly detection ──────────────────────────────
  const now = Date.now();
  const cardsOut = cards.map((card) => {
    const buckets = Array.from(cardMonthly.get(card.id)!.values());
    const lastTxn = cardLastTxn.get(card.id) ?? null;
    const daysSinceLastTxn = lastTxn
      ? Math.floor((now - new Date(lastTxn).getTime()) / 86400000)
      : null;

    // Anomaly: a zero-count month that has non-zero months on BOTH sides.
    // Single-sided gaps (e.g. last month is zero) get flagged separately as
    // "stale" via daysSinceLastTxn — not here, to avoid double-flagging brand
    // new cards or temporarily inactive ones.
    const gapMonths: string[] = [];
    for (let i = 1; i < buckets.length - 1; i++) {
      if (buckets[i].count === 0 && buckets[i - 1].count > 0 && buckets[i + 1].count > 0) {
        gapMonths.push(buckets[i].ym);
      }
    }

    const isStale = daysSinceLastTxn !== null && daysSinceLastTxn > STALE_THRESHOLD_DAYS;

    return {
      card_id: card.id,
      last4: card.last4,
      nickname: card.nickname,
      product_key: card.product_key,
      issuer: card.issuer,
      monthly: buckets,
      last_txn_at: lastTxn,
      days_since_last_txn: daysSinceLastTxn,
      low_confidence_count: cardLowConf.get(card.id) ?? 0,
      anomalies: {
        gap_months: gapMonths,
        stale: isStale,
        // Highest-priority flag: if both stale AND has historical data, the
        // parser definitely broke for this card.
        likely_parser_break: isStale && (txns || []).some((t) => t.card_id === card.id),
      },
    };
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    months_back: MONTHS_BACK,
    summary: {
      total_cards: cards.length,
      cards_with_anomalies: cardsOut.filter((c) => c.anomalies.gap_months.length > 0 || c.anomalies.stale).length,
      cards_likely_broken: cardsOut.filter((c) => c.anomalies.likely_parser_break).length,
      unparsed_seen_messages: unparsedCount ?? 0,
      total_low_confidence_txns: cardsOut.reduce((s, c) => s + c.low_confidence_count, 0),
    },
    cards: cardsOut,
  });
}
