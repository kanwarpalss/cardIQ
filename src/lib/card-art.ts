// Issuer artwork is kept locally; crop coordinates isolate the card face from public product images.
export type CardArt = {
  face?: { src: string; ratio: number; size: string; position: string };
  gradient: string; // CSS background for the card face
  accent: string;   // highlight color for name/numbers on that face
};

const ART: Record<string, CardArt> = {
  axis_magnus_burgundy: {
    face: { src: "/cards/axis-magnus.jpg", ratio: 0.64, size: "184% 102%", position: "100% 50%" },
    gradient: "linear-gradient(135deg, #4a1120 0%, #24080f 55%, #38101a 100%)",
    accent: "#e6bd57",
  },
  hdfc_infinia: {
    face: { src: "/cards/hdfc-infinia.webp", ratio: 1.574, size: "100% 100%", position: "center" },
    gradient: "linear-gradient(135deg, #0f2f24 0%, #08160f 55%, #0d2a1e 100%)",
    accent: "#d9e8dd",
  },
  hdfc_swiggy: {
    face: { src: "/cards/hdfc-swiggy.webp", ratio: 1.587, size: "100% 100%", position: "center" },
    gradient: "linear-gradient(135deg, #3c1a0a 0%, #200d05 55%, #2f1508 100%)",
    accent: "#f7a266",
  },
  icici_emeralde_private_metal: {
    face: { src: "/cards/icici-emeralde.webp", ratio: 1.556, size: "100% 142.4%", position: "50% 48%" },
    gradient: "linear-gradient(135deg, #272b34 0%, #121419 55%, #1f232c 100%)",
    accent: "#d6dae2",
  },
  hsbc_premier: {
    face: { src: "/cards/hsbc-premier.jpg", ratio: 0.631, size: "354% 125.5%", position: "50% 50%" },
    gradient: "linear-gradient(135deg, #14213b 0%, #0a101f 55%, #111c33 100%)",
    accent: "#dfe4ee",
  },
  hsbc_travelone: {
    face: { src: "/cards/hsbc-travelone.jpg", ratio: 0.631, size: "350% 124.1%", position: "50% 50%" },
    gradient: "linear-gradient(135deg, #5f1420 0%, #2b0a10 55%, #481019 100%)",
    accent: "#f1dfe2",
  },
};

const DEFAULT_ART: CardArt = {
  gradient: "linear-gradient(135deg, #2c2415 0%, #191308 100%)",
  accent: "#e6bd57",
};

export function getCardArt(product_key: string): CardArt {
  return ART[product_key] ?? DEFAULT_ART;
}
