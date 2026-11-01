import { AMEX_PLATINUM_TRAVEL } from "./amex-platinum-travel";
import { AXIS_MAGNUS_BURGUNDY } from "./axis-magnus-burgundy";
import { HDFC_INFINIA } from "./hdfc-infinia";
import { HDFC_SWIGGY } from "./hdfc-swiggy";
import { ICICI_EMERALDE_PRIVATE_METAL } from "./icici-emeralde-private-metal";
import { HSBC_PREMIER } from "./hsbc-premier";
import { HSBC_TRAVELONE } from "./hsbc-travelone";
import type { CardSpec } from "./types";

const ALL_CARDS: CardSpec[] = [
  AXIS_MAGNUS_BURGUNDY,
  HDFC_INFINIA,
  HDFC_SWIGGY,
  ICICI_EMERALDE_PRIVATE_METAL,
  HSBC_PREMIER,
  HSBC_TRAVELONE,
  AMEX_PLATINUM_TRAVEL,
];

export const CARD_REGISTRY: Record<string, CardSpec> = Object.fromEntries(
  ALL_CARDS.map((c) => [c.product_key, c])
);

// Citi's retired cards still have real charge/refund history. They have a
// parser and must remain discoverable without inventing an active card spec.
export const BANK_EMAIL_SENDERS = [...new Set([
  ...ALL_CARDS.flatMap((card) => card.gmail.senders), "citicorp.com",
])];

export function getCardSpec(product_key: string): CardSpec | undefined {
  return CARD_REGISTRY[product_key];
}
