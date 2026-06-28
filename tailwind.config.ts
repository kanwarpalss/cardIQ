import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Depth layers (warm espresso-charcoal, lightest last) ──────────
        // Warm, chic darks — NOT cold pure-black. Each layer is lifted enough
        // to keep text legible (readability is the first tenet here).
        ink:     "#14110c",   // deepest background — warm near-black
        surface: "#1e1a13",   // card / panel
        raised:  "#29231a",   // elevated elements, dropdowns
        hover:   "#352d22",   // interactive hover state

        // ── Borders (warm-white alpha so they read on any warm layer) ──────
        wire: "rgba(237,233,224,0.10)",   // hairline — section dividers
        rim:  "rgba(237,233,224,0.18)",   // visible border

        // ── Text (warm white) ───────────────────────────────────────────
        mist: "#f1ede4",

        // ── Brand accent ────────────────────────────────────────────────
        gold:    "#e6bd57",   // champagne gold, slightly brighter for contrast

        // ── Status ──────────────────────────────────────────────────────
        emerald:  "#34d27b",
        ruby:     "#f4675f",
        sapphire: "#5b9bf8",
        amber:    "#f5b042",

        // ── Legacy aliases (so old classes don't break mid-refactor) ─────
        panel: "#1e1a13",
        line:  "rgba(237,233,224,0.10)",
      },
      fontFamily: {
        sans:  ["'Inter'", "ui-sans-serif", "system-ui"],
        serif: ["'Playfair Display'", "ui-serif", "Georgia"],
      },
      fontSize: {
        "2xs": ["0.65rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        "glow-gold": "0 0 24px rgba(224,180,74,0.12)",
        "card":      "0 4px 24px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3)",
        "dropdown":  "0 8px 40px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
      },
      backgroundImage: {
        "gold-shimmer": "linear-gradient(135deg, #e6bd57 0%, #cf9f3e 50%, #f0cb6b 100%)",
        "surface-gradient": "linear-gradient(160deg, #1e1a13 0%, #221d15 100%)",
      },
      animation: {
        "spin-slow": "spin 2s linear infinite",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
