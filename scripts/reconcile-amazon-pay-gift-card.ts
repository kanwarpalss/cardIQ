/**
 * Record one HUMAN-CONFIRMED Amazon Pay gift-card split.
 *
 * Amazon Pay's delivery email proves the brand and timing but (in the real
 * layout) omits the balance. Therefore this script always requires the value
 * KP confirmed; it never derives that value from a card-charge remainder.
 *
 * Dry run:
 *   npx tsx scripts/reconcile-amazon-pay-gift-card.ts \
 *     --message-id <gmail-id> --gift-value 5000 --order-ref 525889 \
 *     --card-txn-id <transaction-id>
 * Add --apply only after the printed evidence is right.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  matchConfirmedAmazonPayGiftCard,
  parseAmazonPayGiftCardEmail,
} from "../src/lib/amazon-pay-gift-card";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const args = new Map(
  process.argv.slice(2).flatMap((arg, i, all) => arg.startsWith("--") && all[i + 1] && !all[i + 1].startsWith("--")
    ? [[arg.slice(2), all[i + 1]]]
    : [])
);
const apply = process.argv.includes("--apply");
const required = (key: string) => {
  const value = args.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
};

async function main() {
  const messageId = required("message-id");
  const orderRef = required("order-ref");
  const cardTxnId = required("card-txn-id");
  const giftValue = Number(required("gift-value"));
  if (!Number.isFinite(giftValue) || giftValue <= 0) throw new Error("--gift-value must be a positive amount");

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: order, error: orderError } = await db.from("orders")
    .select("id, user_id, merchant_name, total_amount, order_at, txn_id")
    .eq("order_ref", orderRef).maybeSingle();
  if (orderError) throw orderError;
  if (!order) throw new Error(`No order found with reference ${orderRef}`);

  const [{ data: message, error: messageError }, { data: debit, error: debitError }] = await Promise.all([
    db.from("gmail_seen_messages").select("gmail_message_id, raw_from, raw_subject, raw_body, internal_date")
      .eq("user_id", order.user_id).eq("gmail_message_id", messageId).maybeSingle(),
    db.from("transactions").select("id, amount_inr, txn_at, txn_type")
      .eq("user_id", order.user_id).eq("id", cardTxnId).maybeSingle(),
  ]);
  if (messageError) throw messageError;
  if (debitError) throw debitError;
  if (!message) throw new Error("Amazon Pay delivery email was not found in the stored Gmail evidence");
  if (!debit) throw new Error("Direct card debit was not found");

  const email = parseAmazonPayGiftCardEmail({
    gmailMessageId: message.gmail_message_id,
    from: message.raw_from ?? "",
    subject: message.raw_subject ?? "",
    text: message.raw_body ?? "",
    receivedAt: new Date(Number(message.internal_date)).toISOString(),
  });
  if (!email) throw new Error("Stored email is not an exact Amazon Pay gift-card delivery receipt");

  const { data: existingVoucher, error: existingError } = await db.from("vouchers")
    .select("id").eq("user_id", order.user_id).eq("gmail_message_id", messageId)
    .eq("code", `amazon-pay:${messageId}`).maybeSingle();
  if (existingError) throw existingError;

  const match = matchConfirmedAmazonPayGiftCard({
    email,
    voucherId: existingVoucher?.id ?? randomUUID(),
    confirmedFaceValue: giftValue,
    order: {
      id: order.id,
      brand: order.merchant_name ?? "",
      total: Number(order.total_amount),
      orderedAt: order.order_at,
    },
    directCardDebit: {
      id: debit.id,
      amount: Number(debit.amount_inr),
      txnAt: debit.txn_at,
      txnType: debit.txn_type,
    },
  });
  if (!match) throw new Error("Evidence does not form an exact Amazon Pay split; no data was changed");

  const plan = {
    orderRef,
    brand: email.brand,
    giftValue: match.voucherAmount,
    directCardValue: match.cardAmount,
    total: Number(order.total_amount),
    email: messageId,
    directCardTxn: cardTxnId,
  };
  console.log(JSON.stringify({ apply, plan }, null, 2));
  if (!apply) return;

  const voucherId = match.voucherId;
  const { error: voucherError } = await db.from("vouchers").upsert({
    id: voucherId,
    user_id: order.user_id,
    gmail_message_id: messageId,
    // Source marker, not the redeemable gift-card code (Amazon never exposes it
    // in this delivery email). It makes reruns idempotent without storing a secret.
    code: `amazon-pay:${messageId}`,
    brand: email.brand,
    brand_key: email.brandKey,
    face_value: match.voucherAmount,
    purchased_at: email.receivedAt,
    txn_id: null,
    funding_source: "amazon_pay",
    raw_subject: message.raw_subject,
  }, { onConflict: "user_id,gmail_message_id,code" });
  if (voucherError) throw new Error(`Amazon Pay voucher save failed: ${voucherError.message}`);

  const { error: updateError } = await db.from("orders").update({
    txn_id: match.cardTxnId,
    match_confidence: "high",
    matched_at: new Date().toISOString(),
    card_paid_amount: match.cardAmount,
    voucher_paid_amount: match.voucherAmount,
    voucher_brand_key: email.brandKey,
    payment_evidence: "manual",
    voucher_draws: [{ voucherId, amount: match.voucherAmount, cardTxnId: null, evidence: "manual" }],
    review_status: "confirmed",
  }).eq("id", order.id).eq("user_id", order.user_id);
  if (updateError) throw new Error(`Order update failed: ${updateError.message}`);
  console.log(`Recorded Amazon Pay gift card ${voucherId} against order ${orderRef}.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
