import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── V2 re-theme (2026-07-11): warm cream editorial, coral accent ──
        // Token NAMES are kept from the espresso era so no component changes:
        // they're semantic slots now — ink = page background, surface = card,
        // mist = foreground text, gold = brand accent. Only VALUES changed.

        // ── Depth layers (warm cream paper, deepest first) ────────────────
        ink:     "#faf6ee",   // page background — warm cream paper
        surface: "#fffcf6",   // card / panel — near-white cream
        raised:  "#f4ede0",   // elevated elements, dropdowns
        hover:   "#ede4d3",   // interactive hover state

        // ── Borders (warm-brown alpha so they read on any cream layer) ────
        wire: "rgba(59,45,26,0.10)",   // hairline — section dividers
        rim:  "rgba(59,45,26,0.18)",   // visible border

        // ── Text (deep warm brown-charcoal — editorial, not cold black) ───
        mist: "#33291b",

        // ── Brand accent (persimmon coral — the "color pop") ──────────────
        gold:    "#d94e26",

        // ── Status (tuned for contrast on cream) ──────────────────────────
        emerald:  "#178a5c",
        ruby:     "#d13f38",
        sapphire: "#2f6fd0",
        amber:    "#c97a06",

        // ── Legacy aliases (so old classes don't break mid-refactor) ─────
        panel: "#fffcf6",
        line:  "rgba(59,45,26,0.10)",
      },
      fontFamily: {
        sans:  ["'Inter'", "ui-sans-serif", "system-ui"],
        serif: ["'Playfair Display'", "ui-serif", "Georgia"],
      },
      fontSize: {
        "2xs": ["0.65rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        "glow-gold": "0 0 24px rgba(217,78,38,0.16)",
        "card":      "0 4px 20px rgba(80,60,30,0.08), 0 1px 3px rgba(80,60,30,0.05)",
        "dropdown":  "0 8px 32px rgba(80,60,30,0.16), 0 2px 8px rgba(80,60,30,0.08)",
      },
      backgroundImage: {
        "gold-shimmer": "linear-gradient(135deg, #e0572e 0%, #c74320 50%, #f0764a 100%)",
        "surface-gradient": "linear-gradient(160deg, #fffcf6 0%, #faf4e8 100%)",
      },
      animation: {
        "spin-slow": "spin 2s linear infinite",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
