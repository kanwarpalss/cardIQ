import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseTxnEmailWithFallback } from "@/lib/parsers/registry";
import { categorize } from "@/lib/categorize";
import { cleanMerchant } from "@/lib/merchant-clean";

/**
 * Card-added backfill. Run this immediately after a user adds a new card —
 * it makes sure the new card retroactively shows ALL transactions that
 * belong to it, without forcing a re-sync from Gmail.
 *
 * Two phases:
 *
 *   PHASE A — link orphans:
 *     UPDATE transactions
 *        SET card_id = <new>
 *      WHERE user_id = <user>
 *        AND card_last4 = <new last4>
 *        AND card_id IS NULL
 *
 *     This catches any historic txns whose last4 already matched but had no
 *     card_id because the card hadn't been added yet.
 *
 *   PHASE B — re-sniff stored emails:
 *     For every gmail_seen_messages row with txn_id IS NULL and a stored
 *     raw_body, re-run the parser stack. With the new card's last4 added
 *     to the known-last4s set, the generic sniffer can now match emails
 *     that previously fell through (e.g. emails from a bank we don't have
 *     a dedicated parser for).
 *
 * Both phases are 100% offline — no Gmail API calls. Fast, safe to run
 * synchronously from the UI.
 *
 * Body: { card_id: string }   — the freshly-inserted card's id
 */

const REPROCESS_LIMIT = 5000;

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const cardId = body?.card_id;
  if (!cardId || typeof cardId !== "string") {
    return NextResponse.json({ error: "card_id is required" }, { status: 400 });
  }

  // ── Load the new card ────────────────────────────────────────────────────
  const { data: newCard, error: cardErr } = await supabase
    .from("cards")
    .select("id, last4")
    .eq("id", cardId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (cardErr || !newCard) {
    return NextResponse.json({ error: "card not found" }, { status: 404 });
  }

  // ── Load ALL user cards (for the knownLast4s set) ────────────────────────
  const { data: allCards } = await supabase
    .from("cards")
    .select("id, last4")
    .eq("user_id", user.id);

  const cardByLast4 = new Map((allCards || []).map((c) => [c.last4, c.id]));
  const knownLast4s = new Set((allCards || []).map((c) => c.last4));

  // ── PHASE A: link orphan transactions to the new card ───────────────────
  const { count: linkedCount, error: linkErr } = await supabase
    .from("transactions")
    .update({ card_id: newCard.id }, { count: "exact" })
    .eq("user_id", user.id)
    .eq("card_last4", newCard.last4)
    .is("card_id", null);

  if (linkErr) {
    return NextResponse.json({ error: `link phase: ${linkErr.message}` }, { status: 500 });
  }

  // ── PHASE B: re-sniff stored unparsed emails ─────────────────────────────
  // Only consider rows with raw_body available (instant offline retry).
  const { data: orphanRows } = await supabase
    .from("gmail_seen_messages")
    .select("gmail_message_id, raw_subject, raw_body, raw_from, internal_date")
    .eq("user_id", user.id)
    .is("txn_id", null)
    .not("raw_body", "is", null)
    .limit(REPROCESS_LIMIT);

  // Load merchant mappings once (mirrors sync route).
  const { data: mappingsRaw } = await supabase
    .from("merchant_mappings")
    .select("raw_name, normalized_name, category")
    .eq("user_id", user.id);
  const merchantMap = new Map((mappingsRaw || []).map((m) => [m.raw_name.toLowerCase(), m]));

  let recoveredCount = 0;
  const errors: string[] = [];

  for (const row of orphanRows || []) {
    const parsed = parseTxnEmailWithFallback(
      row.raw_from || "",
      row.raw_subject || "",
      row.raw_body || "",
      "",
      knownLast4s,
    );
    // Only act on parses that mention the NEW card. Other parses would have
    // matched at first sync; if they're still orphans, the parser still can't
    // handle them and re-running for an unrelated card won't change anything.
    if (!parsed || parsed.card_last4 !== newCard.last4) continue;

    const matchedCardId = cardByLast4.get(parsed.card_last4) ?? null;
    const rawKey   = parsed.merchant_raw?.toLowerCase() ?? "";
    const cleaned  = cleanMerchant(parsed.merchant_raw);
    const cleanedK = cleaned?.toLowerCase() ?? "";
    const mapping  = (rawKey && merchantMap.get(rawKey)) || (cleanedK && merchantMap.get(cleanedK)) || null;
    const merchant = mapping?.normalized_name ?? cleaned ?? null;
    const category = mapping?.category ?? categorize(merchant);
    const txnAt    = row.internal_date ? new Date(row.internal_date) : parsed.txn_at;

    const { data: upserted, error: upsertErr } = await supabase
      .from("transactions")
      .upsert(
        {
          user_id: user.id,
          card_id: matchedCardId,
          card_last4: parsed.card_last4,
          amount_inr: parsed.amount_inr,
          original_currency: parsed.currency ?? "INR",
          original_amount: parsed.amount_original ?? parsed.amount_inr,
          low_confidence: parsed.low_confidence ?? false,
          merchant,
          category,
          txn_type: parsed.txn_type,
          txn_at: txnAt.toISOString(),
          gmail_message_id: row.gmail_message_id,
          raw_subject: row.raw_subject,
          raw_body: row.raw_body,
        },
        { onConflict: "user_id,gmail_message_id" }
      )
      .select("id")
      .maybeSingle();

    if (upsertErr) {
      errors.push(`txn ${row.gmail_message_id}: ${upsertErr.message}`);
      continue;
    }

    if (upserted?.id) {
      await supabase
        .from("gmail_seen_messages")
        .update({ txn_id: upserted.id })
        .eq("user_id", user.id)
        .eq("gmail_message_id", row.gmail_message_id);
      recoveredCount++;
    }
  }

  return NextResponse.json({
    card_id: newCard.id,
    last4: newCard.last4,
    linked_orphans: linkedCount ?? 0,
    recovered_from_unparsed: recoveredCount,
    examined_unparsed: orphanRows?.length ?? 0,
    errors,
  });
}
