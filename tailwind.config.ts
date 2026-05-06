import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        gold: "#c9a84c",
        ink: "#0b0b0d",
        panel: "#141418",
        line: "#26262d",
      },
      fontFamily: {
        sans: ["Sora", "ui-sans-serif", "system-ui"],
        serif: ["'Libre Baskerville'", "ui-serif", "Georgia"],
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
