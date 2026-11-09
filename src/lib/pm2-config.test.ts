import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ecosystem = require("../../ecosystem.config.cjs") as {
  apps: Array<Record<string, unknown>>;
};

const app = (name: string) => ecosystem.apps.find((a) => a.name === name);

describe("Mac mini PM2 configuration", () => {
  it("has exactly the web app and the daily deal finder", () => {
    expect(ecosystem.apps.map((a) => a.name).sort()).toEqual(["cardiq", "cardiq-deals"]);
  });

  it("runs Next directly instead of leaving npm or a shell as its process owner", () => {
    expect(app("cardiq")).toMatchObject({
      name: "cardiq",
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3901",
      interpreter: "/opt/homebrew/bin/node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      env: { NODE_ENV: "production" },
    });

    expect(String(app("cardiq")!.script)).not.toMatch(/(?:^|\/)npm$/);
  });

  it("runs the deal finder once a day for real, without relaunching it after it exits", () => {
    const deals = app("cardiq-deals")!;
    expect(deals).toMatchObject({
      script: "scripts/find-deals.ts",
      interpreter: "/opt/homebrew/bin/node",
      interpreter_args: "--import tsx",
      autorestart: false,
      cron_restart: "30 8 * * *",
    });
    // Without --apply the script is a dry run and the screen would go stale.
    expect(String(deals.args).split(/\s+/)).toContain("--apply");
    expect(existsSync(join(String(deals.cwd), String(deals.script)))).toBe(true);
  });
});
