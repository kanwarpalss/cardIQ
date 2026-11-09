import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Shared semantic palette: ivory paper, deep teal ink, warm coral actions.
        ink: "#f7f8f2",
        surface: "#ffffff",
        raised: "#edf2ed",
        hover: "#e2ebe5",
        wire: "rgba(30, 66, 60, 0.09)",
        rim: "rgba(30, 66, 60, 0.17)",
        mist: "#203d39",
        gold: "#b74732",
        teal: "#174e4b",
        sage: "#e6f0e8",
        lilac: "#eee9f8",
        plum: "#665187",
        peach: "#fae8df",
        emerald: "#16714f",
        ruby: "#b93640",
        sapphire: "#355fac",
        amber: "#9a640b",
        panel: "#ffffff",
        line: "rgba(30, 66, 60, 0.09)",
      },
      fontFamily: {
        sans:  ["'Inter'", "ui-sans-serif", "system-ui"],
        serif: ["'Playfair Display'", "ui-serif", "Georgia"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        "glow-gold": "0 0 24px rgba(217,78,38,0.16)",
        "card":      "0 5px 24px rgba(27,65,54,0.045), 0 1px 3px rgba(27,65,54,0.03)",
        "dropdown":  "0 8px 32px rgba(80,60,30,0.16), 0 2px 8px rgba(80,60,30,0.08)",
      },
      backgroundImage: {
        "gold-shimmer": "linear-gradient(120deg, #b74732, #a63f36)",
        "surface-gradient": "linear-gradient(150deg, #ffffff, #f0f5ef)",
      },
      animation: {
        "spin-slow": "spin 2s linear infinite",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
