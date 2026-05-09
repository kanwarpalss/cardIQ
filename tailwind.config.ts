import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Depth layers (lightest last) ────────────────────────────
        ink:     "#070b14",   // deepest background
        surface: "#0f1422",   // card / panel
        raised:  "#161d30",   // elevated elements, dropdowns
        hover:   "#1c2438",   // interactive hover state

        // ── Borders (white-alpha so they always sit cleanly on any layer) ──
        wire: "rgba(255,255,255,0.06)",   // hairline — section dividers
        rim:  "rgba(255,255,255,0.11)",   // visible border

        // ── Text (warm white — same warmth as wealth dashboard) ─────
        mist: "#ede9e0",

        // ── Brand accent ────────────────────────────────────────────
        gold:    "#e0b44a",   // richer, deeper champagne gold

        // ── Status ──────────────────────────────────────────────────
        emerald:  "#22c55e",
        ruby:     "#ef4444",
        sapphire: "#3b82f6",
        amber:    "#f59e0b",

        // ── Legacy aliases (so old classes don't break mid-refactor) ─
        panel: "#0f1422",
        line:  "rgba(255,255,255,0.06)",
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
        "gold-shimmer": "linear-gradient(135deg, #e0b44a 0%, #c9983a 50%, #e8c060 100%)",
        "surface-gradient": "linear-gradient(160deg, #0f1422 0%, #111828 100%)",
      },
      animation: {
        "spin-slow": "spin 2s linear infinite",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
