import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  {
    rules: {
      // CardIQ intentionally loads remote data when client screens mount.
      // The React 19 rule treats those async loaders as synchronous state
      // writes even though their updates happen after fetch promises settle.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".claude/worktrees/**",
    ".vercel/**",
    "coverage/**",
    "node_modules/**",
  ]),
]);

export default eslintConfig;
