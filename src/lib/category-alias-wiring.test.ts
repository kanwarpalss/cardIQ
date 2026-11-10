import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// Every path that assigns a category to a transaction must go through
// resolveTxnCategory(), which applies the user's renames/deletes (migration
// 025). A path that calls the keyword rules directly would quietly bring a
// renamed or deleted category back on the next sync/backfill/reprocess.
const root = join(__dirname, "..", "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });

const RULE_CALL = /\bcategorize(Full)?\(/;
const OWNERS = ["src/lib/categorize.ts", "src/lib/category-taxonomy.ts"];

describe("category renames apply on every ingest path", () => {
  const callers = [...files(join(root, "src")), ...files(join(root, "scripts"))]
    .map((path) => ({ rel: path.slice(root.length + 1), text: readFileSync(path, "utf8") }))
    .filter(({ rel, text }) => !OWNERS.includes(rel) && RULE_CALL.test(text));

  it("finds the known ingest paths", () => {
    expect(callers.length).toBeGreaterThanOrEqual(7);
  });

  it("each one resolves through resolveTxnCategory with the user's aliases", () => {
    const unguarded = callers
      .filter(({ text }) => !text.includes("resolveTxnCategory(") || !text.includes("loadCategoryAliases("))
      .map(({ rel }) => rel);
    expect(unguarded).toEqual([]);
  });

  it("no path still reads a mapping's category directly in front of the rules", () => {
    const stale = callers
      .filter(({ text }) => /mapping\??\.category[^;\n]*\?\?\s*(ruled\.category|categorize)/.test(text))
      .map(({ rel }) => rel);
    expect(stale).toEqual([]);
  });
});
