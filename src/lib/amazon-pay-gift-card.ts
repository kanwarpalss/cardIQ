import { normalizeBrand } from "./voucher-bridge";

export type AmazonPayGiftCardEmail = {
  gmailMessageId: string;
  brand: string;
  brandKey: string;
  receivedAt: string;
  /** Amazon Pay's delivery mail often does not state the balance. Never guess it. */
  faceValue: number | null;
};

type EmailInput = {
  gmailMessageId: string;
  from: string;
  subject: string;
  text: string;
  receivedAt: string;
};

const AMAZON_PAY_SENDER = /(?:^|<)no-reply@amazonpay\.in(?:>|$)/i;
const SUBJECT = /^Your\s+(.+?)\s+Gift Card is here!$/i;
const VALUE = /(?:gift\s*card\s*)?(?:value|worth)\s*(?:is|:)?\s*(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i;

function money(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Recognize only Amazon Pay's exact delivery receipt. Marketing, reminders,
 * replies and similarly named merchants must not create voucher candidates.
 */
export function parseAmazonPayGiftCardEmail(input: EmailInput): AmazonPayGiftCardEmail | null {
  if (!AMAZON_PAY_SENDER.test(input.from.trim())) return null;
  const subjectMatch = SUBJECT.exec(input.subject.trim());
  if (!subjectMatch) return null;
  const brand = subjectMatch[1].trim().replace(/\s+/g, " ");
  if (!brand) return null;
  return {
    gmailMessageId: input.gmailMessageId,
    brand,
    brandKey: normalizeBrand(brand),
    receivedAt: input.receivedAt,
    faceValue: money(VALUE.exec(input.text)?.[1]),
  };
}

export type ConfirmedAmazonPayGiftCard = {
  email: AmazonPayGiftCardEmail;
  voucherId: string;
  confirmedFaceValue: number;
  order: { id: string; brand: string; total: number; orderedAt: string };
  directCardDebit: { id: string; amount: number; txnAt: string; txnType: string };
};

export type AmazonPayGiftCardMatch = {
  voucherId: string;
  voucherAmount: number;
  cardAmount: number;
  orderId: string;
  cardTxnId: string;
};

const MAX_EMAIL_TO_ORDER_MS = 15 * 60_000;

/**
 * Turn a human-confirmed Amazon Pay delivery email into one exact split.
 * This deliberately refuses to derive a balance from the order remainder: the
 * email must name the brand and the caller must provide the gift-card value.
 */
export function matchConfirmedAmazonPayGiftCard(
  input: ConfirmedAmazonPayGiftCard
): AmazonPayGiftCardMatch | null {
  const { email, confirmedFaceValue: gift, order, directCardDebit: debit } = input;
  if (!(gift > 0) || !Number.isFinite(gift)) return null;
  if (email.faceValue != null && email.faceValue !== gift) return null;
  if (normalizeBrand(order.brand) !== email.brandKey) return null;
  if (debit.txnType !== "debit" || !(debit.amount > 0)) return null;
  if (Math.abs(new Date(order.orderedAt).getTime() - new Date(email.receivedAt).getTime()) > MAX_EMAIL_TO_ORDER_MS) return null;
  if (Math.abs(order.total - (gift + debit.amount)) > 0.000_001) return null;

  return {
    voucherId: input.voucherId,
    voucherAmount: gift,
    cardAmount: debit.amount,
    orderId: order.id,
    cardTxnId: debit.id,
  };
}
