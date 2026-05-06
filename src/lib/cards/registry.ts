import { AXIS_MAGNUS_BURGUNDY } from "./axis-magnus-burgundy";
import { HDFC_INFINIA } from "./hdfc-infinia";
import { HDFC_SWIGGY } from "./hdfc-swiggy";
import { ICICI_EMERALDE_PRIVATE_METAL } from "./icici-emeralde-private-metal";
import { HSBC_PREMIER } from "./hsbc-premier";
import type { CardSpec } from "./types";

const ALL_CARDS: CardSpec[] = [
  AXIS_MAGNUS_BURGUNDY,
  HDFC_INFINIA,
  HDFC_SWIGGY,
  ICICI_EMERALDE_PRIVATE_METAL,
  HSBC_PREMIER,
];

export const CARD_REGISTRY: Record<string, CardSpec> = Object.fromEntries(
  ALL_CARDS.map((c) => [c.product_key, c])
);

export function getCardSpec(product_key: string): CardSpec | undefined {
  return CARD_REGISTRY[product_key];
}
