/**
 * category-regroup.ts — move data saved under the pre-2026-11-10 default
 * categories into the new 14 groups (REGROUP_MOVES in src/lib/categories.ts,
 * the single source of truth the keyword rules and tests also use).
 *
 * DRY RUN by default: prints exactly which rows would move, from where to
 * where, and writes nothing.
 *
 *   npx tsx scripts/category-regroup.ts            # dry run
 *   npx tsx scripts/category-regroup.ts --apply    # back up, move, verify
 *
 * --apply:
 *   1. backs up every affected row to ~/.cardiq-backups/ (never the repo)
 *   2. updates transactions + merchant_mappings (category/subcategory only)
 *   3. records the moves as aliases in user_category_taxonomy (migration 025)
 *      so any old name still emitted anywhere resolves to its new home
 *   4. re-reads and fails loudly if any retired name is left
 * Safe to re-run: a second run finds nothing to move.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { REGROUP_MOVES, regroupPair } from "../src/lib/categories";
import { aliasKey, pairLabel, type CategoryAliases } from "../src/lib/category-taxonomy";
import { loadTaxonomyRow, saveTaxonomyRow } from "../src/lib/category-taxonomy-store";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;
const CHUNK = 200;

type Row = { key: string; merchant: string | null; category: string | null; subcategory: string | null };
type Planned = Row & { to: { category: string | null; subcategory: string | null } };

const label = (c: string | null, s: string | null) => pairLabel(c || "Uncategorized", s);

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s, error: sErr } = await sb.from("user_settings").select("user_id").limit(1).single();
  if (sErr || !s) throw new Error(`Couldn't find the user: ${sErr?.message ?? "no user_settings row"}`);
  const uid = s.user_id as string;

  async function loadAll(table: "transactions" | "merchant_mappings", cols: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(table).select(cols).eq("user_id", uid).order(table === "transactions" ? "id" : "raw_name").range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  const txns: Row[] = (await loadAll("transactions", "id, merchant, category, subcategory")).map((r) => ({
    key: r.id as string, merchant: r.merchant as string | null, category: r.category as string | null, subcategory: (r.subcategory as string | null) ?? null,
  }));
  const rules: Row[] = (await loadAll("merchant_mappings", "raw_name, normalized_name, category, subcategory")).map((r) => ({
    key: r.raw_name as string, merchant: (r.normalized_name as string | null) ?? (r.raw_name as string), category: r.category as string | null, subcategory: (r.subcategory as string | null) ?? null,
  }));

  const plan = (rows: Row[]): Planned[] =>
    rows.flatMap((r) => {
      const to = regroupPair(r);
      return to.category === r.category && to.subcategory === r.subcategory ? [] : [{ ...r, to }];
    });
  const txnMoves = plan(txns);
  const ruleMoves = plan(rules);

  console.log(`CardIQ category regroup — ${APPLY ? "APPLY" : "DRY RUN (nothing will be written)"}`);
  console.log(`Scanned ${txns.length} transactions and ${rules.length} merchant rules.\n`);

  const summarize = (title: string, moves: Planned[]) => {
    const groups = new Map<string, { n: number; examples: Set<string> }>();
    for (const m of moves) {
      const k = `${label(m.category, m.subcategory)}  →  ${label(m.to.category, m.to.subcategory)}`;
      const g = groups.get(k) ?? { n: 0, examples: new Set<string>() };
      g.n++;
      if (g.examples.size < 3 && m.merchant) g.examples.add(m.merchant);
      groups.set(k, g);
    }
    console.log(`${title}: ${moves.length} to move`);
    for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${String(g.n).padStart(5)}  ${k}${g.examples.size ? `   (e.g. ${[...g.examples].join(", ")})` : ""}`);
    }
    console.log("");
  };
  summarize("Transactions", txnMoves);
  summarize("Merchant rules", ruleMoves);

  const before = new Map<string, number>();
  for (const t of txns) before.set(t.category || "Uncategorized", (before.get(t.category || "Uncategorized") ?? 0) + 1);
  const after = new Map<string, number>();
  for (const t of txns) {
    const c = regroupPair(t).category || "Uncategorized";
    after.set(c, (after.get(c) ?? 0) + 1);
  }
  console.log(`Categories in use: ${before.size} now → ${after.size} after.`);
  console.log([...after].sort((a, b) => b[1] - a[1]).map(([c, n]) => `  ${String(n).padStart(5)}  ${c}`).join("\n"));
  console.log("");

  const row = await loadTaxonomyRow(sb, uid);
  if (row.taxonomy) {
    console.log("⚠ A saved category list exists — the regroup only moves data; rename list entries in Manage categories if needed.");
  }

  if (!APPLY) {
    console.log("Dry run: nothing written. Re-run with --apply to back up, move and verify.");
    return;
  }

  // 1. Backup (outside the repo).
  const dir = join(homedir(), ".cardiq-backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `category-regroup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ user_id: uid, transactions: txnMoves, merchant_mappings: ruleMoves }, null, 2));
  console.log(`Backed up ${txnMoves.length + ruleMoves.length} rows to ${file}`);

  // 2. Move, grouped by destination so each update is one IN-list per chunk.
  async function apply(table: "transactions" | "merchant_mappings", keyCol: "id" | "raw_name", moves: Planned[]) {
    const byTarget = new Map<string, Planned[]>();
    for (const m of moves) {
      const k = JSON.stringify(m.to);
      byTarget.set(k, [...(byTarget.get(k) ?? []), m]);
    }
    let done = 0;
    for (const [k, list] of byTarget) {
      const to = JSON.parse(k) as Planned["to"];
      for (let i = 0; i < list.length; i += CHUNK) {
        const keys = list.slice(i, i + CHUNK).map((m) => m.key);
        const { data, error } = await sb.from(table).update({ category: to.category, subcategory: to.subcategory })
          .eq("user_id", uid).in(keyCol, keys).select(keyCol);
        if (error) throw new Error(`${table} update failed after ${done} rows: ${error.message}. Backup: ${file}`);
        done += data?.length ?? 0;
      }
    }
    return done;
  }
  const movedTxns = await apply("transactions", "id", txnMoves);
  const movedRules = await apply("merchant_mappings", "raw_name", ruleMoves);
  console.log(`Moved ${movedTxns} transactions and ${movedRules} merchant rules.`);

  // 3. Aliases (category/subcategory-level moves only; merchant-specific
  //    moves can't be expressed as an alias and the new rules handle them).
  if (row.tableMissing) {
    console.log("⚠ Migration 025 isn't run yet, so the old→new aliases weren't recorded. Run it, then re-run --apply (data is already moved; it only adds aliases).");
  } else if (row.error) {
    throw new Error(`Couldn't read the category list to record aliases: ${row.error}`);
  } else {
    const aliases: CategoryAliases = { ...row.aliases };
    let added = 0;
    for (const m of REGROUP_MOVES) {
      if (m.from.merchantContains) continue;
      const key = aliasKey(m.from.category, m.from.subcategory);
      if (aliases[key]) continue; // the user's own alias wins
      aliases[key] = m.to.subcategory === undefined ? { category: m.to.category } : { category: m.to.category, subcategory: m.to.subcategory };
      added++;
    }
    const err = await saveTaxonomyRow(sb, uid, { aliases });
    if (err) throw new Error(`Data moved, but couldn't record aliases: ${err}`);
    console.log(`Recorded ${added} new alias${added === 1 ? "" : "es"} (${Object.keys(aliases).length} total).`);
  }

  // 4. Verify against the database, not our own bookkeeping.
  const recheck = plan((await loadAll("transactions", "id, merchant, category, subcategory")).map((r) => ({
    key: r.id as string, merchant: r.merchant as string | null, category: r.category as string | null, subcategory: (r.subcategory as string | null) ?? null,
  })));
  const recheckRules = plan((await loadAll("merchant_mappings", "raw_name, normalized_name, category, subcategory")).map((r) => ({
    key: r.raw_name as string, merchant: (r.normalized_name as string | null) ?? (r.raw_name as string), category: r.category as string | null, subcategory: (r.subcategory as string | null) ?? null,
  })));
  if (recheck.length || recheckRules.length) {
    throw new Error(`Verification failed: ${recheck.length} transactions and ${recheckRules.length} rules still under retired names. Backup: ${file}`);
  }
  console.log("Verified: no transaction or merchant rule is left under a retired category name.");
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
