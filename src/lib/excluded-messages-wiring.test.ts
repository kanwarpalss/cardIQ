import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// Every path that turns an email into a transaction must skip the emails a
// statement proved were never charged, or a deleted hold comes back on the next
// reprocess, backfill or wipe (migration 023).
const root = join(__dirname, "..", "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : files(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });

describe("excluded emails are skipped everywhere", () => {
  const callers = [...files(join(root, "src")), ...files(join(root, "scripts"))]
    .map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n") }))
    .filter(({ path, lines }) => !path.endsWith("registry.ts") && lines.some((l) => l.includes("parseTxnEmailWithFallback(")));

  it("finds the known email-to-transaction paths", () => {
    expect(callers.length).toBeGreaterThanOrEqual(6);
  });

  it("checks excludedIds right before every parse", () => {
    const unguarded = callers.flatMap(({ path, lines }) =>
      lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.includes("parseTxnEmailWithFallback("))
        .filter(({ i }) => !lines.slice(Math.max(0, i - 2), i + 1).some((x) => x.includes("excludedIds.has(")))
        .map(({ i }) => `${path.slice(root.length + 1)}:${i + 1}`),
    );
    expect(unguarded).toEqual([]);
  });
});
