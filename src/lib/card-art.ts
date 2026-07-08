// Visual identity per card product — gradients tuned to each card's real
// physical design language (Magnus Burgundy is burgundy, Infinia is dark
// green, Emeralde Private Metal is gunmetal…). Unknown products fall back
// to the house espresso+gold.

export type CardArt = {
  gradient: string; // CSS background for the card face
  accent: string;   // highlight color for name/numbers on that face
};

const ART: Record<string, CardArt> = {
  axis_magnus_burgundy: {
    gradient: "linear-gradient(135deg, #4a1120 0%, #24080f 55%, #38101a 100%)",
    accent: "#e6bd57",
  },
  hdfc_infinia: {
    gradient: "linear-gradient(135deg, #0f2f24 0%, #08160f 55%, #0d2a1e 100%)",
    accent: "#d9e8dd",
  },
  hdfc_swiggy: {
    gradient: "linear-gradient(135deg, #3c1a0a 0%, #200d05 55%, #2f1508 100%)",
    accent: "#f7a266",
  },
  icici_emeralde_private_metal: {
    gradient: "linear-gradient(135deg, #272b34 0%, #121419 55%, #1f232c 100%)",
    accent: "#d6dae2",
  },
  hsbc_premier: {
    gradient: "linear-gradient(135deg, #14213b 0%, #0a101f 55%, #111c33 100%)",
    accent: "#dfe4ee",
  },
};

const DEFAULT_ART: CardArt = {
  gradient: "linear-gradient(135deg, #2c2415 0%, #191308 100%)",
  accent: "#e6bd57",
};

export function getCardArt(product_key: string): CardArt {
  return ART[product_key] ?? DEFAULT_ART;
}
