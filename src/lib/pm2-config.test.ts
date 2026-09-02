import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ecosystem = require("../../ecosystem.config.cjs") as {
  apps: Array<Record<string, unknown>>;
};

describe("Mac mini PM2 configuration", () => {
  it("runs Next directly instead of leaving npm or a shell as its process owner", () => {
    expect(ecosystem.apps).toHaveLength(1);
    expect(ecosystem.apps[0]).toMatchObject({
      name: "cardiq",
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3128",
      interpreter: "/opt/homebrew/bin/node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      env: { NODE_ENV: "production" },
    });

    expect(String(ecosystem.apps[0].script)).not.toMatch(/(?:^|\/)npm$/);
  });
});
