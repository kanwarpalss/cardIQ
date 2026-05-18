import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Depth layers — light editorial palette ──────────────────
        ink:     "#FAFAF8",   // page background — warm cream paper
        surface: "#FFFFFF",   // card / panel — pure white
        raised:  "#F3F2EE",   // elevated elements — warm off-white
        hover:   "#ECEAE5",   // interactive hover state

        // ── Borders (dark-alpha so they sit cleanly on any light layer) ─
        wire: "rgba(0,0,0,0.07)",    // hairline — section dividers
        rim:  "rgba(0,0,0,0.13)",    // visible border

        // ── Text — warm near-black on cream ─────────────────────────
        mist: "#1C1917",   // primary text

        // ── Brand accent — deeper amber for excellent contrast on white
        gold: "#B45309",   // Tailwind amber-700: punchy, readable, unmistakably gold

        // ── Status ──────────────────────────────────────────────────
        emerald:  "#059669",   // darker green — AA contrast on white
        ruby:     "#DC2626",   // red — AA contrast on white
        sapphire: "#2563EB",   // blue
        amber:    "#D97706",   // amber (distinct from gold)

        // ── Legacy aliases ──────────────────────────────────────────
        panel: "#FFFFFF",
        line:  "rgba(0,0,0,0.07)",
      },
      fontFamily: {
        sans:  ["'Inter'", "ui-sans-serif", "system-ui"],
        serif: ["'Playfair Display'", "ui-serif", "Georgia"],
      },
      fontSize: {
        "2xs": ["0.65rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        "glow-gold": "0 0 20px rgba(180,83,9,0.12)",
        "card":      "0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.05)",
        "card-hover":"0 2px 8px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.08)",
        "dropdown":  "0 4px 24px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.06)",
        "focus":     "0 0 0 3px rgba(180,83,9,0.15)",
      },
      backgroundImage: {
        "gold-shimmer":     "linear-gradient(135deg, #D97706 0%, #B45309 50%, #F59E0B 100%)",
        "surface-gradient": "linear-gradient(160deg, #FFFFFF 0%, #FAFAF8 100%)",
        "ink-gradient":     "linear-gradient(180deg, #FAFAF8 0%, #F5F4F0 100%)",
      },
      animation: {
        "spin-slow": "spin 2s linear infinite",
        "fade-in":   "fadeIn 0.2s ease-out",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0", transform: "translateY(4px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
