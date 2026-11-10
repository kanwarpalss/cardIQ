/**
 * deals-status.ts — READ-ONLY health check for the daily deal finder.
 * Use this instead of writing a throwaway probe.
 *
 *   npm run deals:status                 # counts + health + recent runs + live list
 *   npm run deals:status -- --runs 10    # just the last 10 runs
 *   npm run deals:status -- --live --ended
 *   npm run deals:status -- --mini       # PM2 settings on the Mac mini (ssh macmini)
 *   npm run deals:status -- --help
 *
 * Reads the `deals`, `deal_runs`, `deal_seen_items` and `cards` tables with
 * the service-role key from .env.local and prints a compact, labelled
 * read-out. Health and ranking use the same functions as Rewards → Live deals
 * (runHealth, assessDeal, rankDeals). Never writes, never prints a secret.
 * Formatting lives in src/lib/deals/status.ts (tested).
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runHealth } from "../src/lib/deals/health";
import {
  OUTCOMES, USAGE, formatCounts, formatLiveRow, formatRun, parseStatusArgs, rankLive, scoreWallet,
  toStoredDeal, type OutcomeCounts,
} from "../src/lib/deals/status";
import type { DealRun, StoredDeal } from "../src/lib/deals/types";

const PAGE = 1000;
/** Same number of runs the Deals screen judges health from (load.ts). */
const HEALTH_RUNS = 10;

function fail(what: string, message: string): never {
  console.error(`✗ ${what}: ${message}`);
  process.exit(1);
}

async function count(sb: SupabaseClient, table: string, uid: string, outcome?: string): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true }).eq("user_id", uid);
  if (outcome) q = q.eq("outcome", outcome);
  const { count: n, error } = await q;
  if (error) fail(`count ${table}${outcome ? ` (${outcome})` : ""}`, error.message);
  return n ?? 0;
}

async function recentRuns(sb: SupabaseClient, uid: string, n: number): Promise<DealRun[]> {
  const { data, error } = await sb.from("deal_runs").select("started_at, finished_at, ok, summary")
    .eq("user_id", uid).order("started_at", { ascending: false }).limit(n);
  if (error) fail("read deal_runs", error.message);
  return (data ?? []) as DealRun[];
}

async function allDeals(sb: SupabaseClient, uid: string): Promise<StoredDeal[]> {
  const out: StoredDeal[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("deals").select("*").eq("user_id", uid)
      .order("last_seen_at", { ascending: false }).range(from, from + PAGE - 1);
    if (error) fail("read deals", error.message);
    out.push(...(data ?? []).map(toStoredDeal));
    if (!data || data.length < PAGE) return out;
  }
}

function heading(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(3, 60 - title.length))}`);
}

function mini() {
  const script = readFileSync(join(process.cwd(), "scripts", "deals-pm2-status.mjs"));
  // The script travels on stdin, so the mini's checkout needn't be current.
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "macmini",
    "PATH=/opt/homebrew/bin:$PATH node --input-type=module -"], { input: script, encoding: "utf8", timeout: 60000 });
  if (r.error) return console.log(`ssh macmini failed: ${r.error.message}`);
  const out = `${r.stdout ?? ""}${r.status === 0 ? "" : r.stderr ?? ""}`.trim();
  console.log(out || `(no output; ssh exit ${r.status})`);
  if (r.status !== 0) process.exitCode = 1;
}

async function main() {
  let args;
  try { args = parseStatusArgs(process.argv.slice(2)); } catch (e) { fail("arguments", (e as Error).message); }
  if (args.help) return console.log(USAGE);

  const dbSections = args.sections.filter((s) => s !== "mini");
  if (dbSections.length) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) fail("config", "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: settings, error } = await sb.from("user_settings").select("user_id").limit(1).single();
    if (error || !settings) fail("find user", error?.message ?? "no user_settings row");
    const uid = settings.user_id as string;
    const now = Date.now();

    if (args.sections.includes("counts")) {
      heading("Counts");
      const seen = {} as OutcomeCounts;
      for (const o of OUTCOMES) seen[o] = await count(sb, "deal_seen_items", uid, o);
      console.log(formatCounts(await count(sb, "deals", uid), await count(sb, "deal_runs", uid), seen));
    }

    if (args.sections.includes("health")) {
      heading("Health (as shown on Rewards → Live deals)");
      const h = runHealth(await recentRuns(sb, uid, HEALTH_RUNS), now);
      console.log(`${h.level.toUpperCase()}: ${h.text}`);
    }

    if (args.sections.includes("runs")) {
      heading(`Last ${args.runs} runs (newest first)`);
      const runs = await recentRuns(sb, uid, args.runs);
      console.log(runs.length ? runs.map(formatRun).join("\n") : "(no runs yet)");
    }

    if (args.sections.includes("live")) {
      const { data: cards, error: cErr } = await sb.from("cards").select("product_key").eq("user_id", uid);
      if (cErr) fail("read cards", cErr.message);
      const wallet = scoreWallet((cards ?? []).map((c) => c.product_key as string));
      const today = new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const rows = rankLive(await allDeals(sb, uid), wallet.cards, today, args.ended);
      heading(`${args.ended ? "All" : "Live"} deals, ranked (${rows.length}) — wallet: ${wallet.cards.map((c) => c.short).join(", ") || "none"}`);
      if (wallet.skipped.length) console.log(`(not scored — no transfer spec: ${wallet.skipped.join(", ")})`);
      console.log("reach     grade        status               headline | grade note");
      console.log(rows.length ? rows.map(formatLiveRow).join("\n") : "(none)");
    }
  }

  if (args.sections.includes("mini")) {
    heading("Mac mini PM2");
    mini();
  }
}

main().catch((e) => fail("deals-status", (e as Error).message));
