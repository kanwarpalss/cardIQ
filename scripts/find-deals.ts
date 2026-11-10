/**
 * find-deals.ts — the daily deal finder. Looks through KP's Gmail (IMAP,
 * read-only) and four points blogs for points sales and transfer bonuses,
 * and stores what it finds in the `deals` table for Rewards → Deals.
 *
 * Cheap by construction, in three layers:
 *   1. Gmail search + blog RSS return subject lines only; a free rule-based
 *      filter (src/lib/deals/prefilter.ts) drops per-stay promos, shopping
 *      offers and anything naming no program or bank.
 *   2. Only survivors are downloaded and read by Claude Haiku
 *      (src/lib/deals/extract.ts), whose answer is checked against the text.
 *   3. Every item looked at is recorded in deal_seen_items, so nothing is
 *      downloaded or read twice (ARCH-12).
 *
 * Runs under PM2 on the Mac mini (ecosystem.config.cjs, app "cardiq-deals"):
 * daily at 08:30, and once whenever PM2 starts — so a mini that was off
 * catches up when it's back. A run within 20 hours of the last good one
 * exits straight away unless --force is given.
 *
 * The first run looks back a year to build the history "is this a good
 * Marriott sale?" is judged against; later runs look back to a day before
 * the last good run.
 *
 * READ-ONLY by default (prints what it would store). Run:
 *   npx tsx scripts/find-deals.ts                 # dry run
 *   npx tsx scripts/find-deals.ts --apply         # write to the database
 *   flags: --force  --days N  --limit N  --no-email  --no-blogs  --verbose
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";
import { ImapSource } from "../src/lib/gmail/mail-source";
import { stripHtml } from "../src/lib/gmail/strip";
import { screen, dealSearchQuery } from "../src/lib/deals/prefilter";
import { FEEDS, parseRss } from "../src/lib/deals/feeds";
import { extractDeal, bestBodyText, usageCostUsd, UNREADABLE, type ReadItem, type Usage } from "../src/lib/deals/extract";
import { planUpsert } from "../src/lib/deals/store";
import { syncLoyaltyBalances } from "../src/lib/balances/sync-loyalty";
import { ranRecently, MIN_GAP_HOURS } from "../src/lib/deals/health";
import type { DealSource, StoredDeal } from "../src/lib/deals/types";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const NO_EMAIL = args.includes("--no-email");
const NO_BLOGS = args.includes("--no-blogs");
const VERBOSE = args.includes("--verbose");
const numArg = (flag: string) => {
  const i = args.indexOf(flag);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
/** Most AI reads in one run — a cost ceiling; the rest wait for the next run. */
const LIMIT = numArg("--limit") ?? 80;
const FIRST_RUN_DAYS = 365;
/** An item whose AI read failed this many times is given up on. */
const MAX_ATTEMPTS = 3;
const PAGE = 1000;
const DAY = 86400000;

type Seen = { outcome: string; attempts: number };
type Pending = { source: DealSource; item: ReadItem };

const log = (...m: unknown[]) => console.log(`[deals ${new Date().toISOString()}]`, ...m);

async function loadAll<T>(sb: SupabaseClient, table: string, cols: string, uid: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).eq("user_id", uid).range(from, from + PAGE - 1);
    // A dry run before migration 024 has nothing to compare against — say so
    // and carry on; a real run must stop rather than re-read everything.
    if (error && !APPLY) { log(`${table}: ${error.message} (dry run treats it as empty)`); return out; }
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (CardIQ deal finder; personal use)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: settings, error: sErr } = await sb
    .from("user_settings")
    .select("user_id, anthropic_key_encrypted, gmail_user, gmail_app_password_encrypted")
    .limit(1)
    .single();
  if (sErr || !settings) throw new Error(`no user_settings row: ${sErr?.message}`);
  const uid = settings.user_id as string;

  // ── Guard: one good run per day is enough ────────────────────────────────
  const { data: lastRuns, error: rErr } = await sb
    .from("deal_runs").select("started_at, ok").eq("user_id", uid).eq("ok", true)
    .order("started_at", { ascending: false }).limit(1);
  if (rErr) {
    const msg = `deal_runs: ${rErr.message} — has migration 024_deals.sql been run?`;
    if (APPLY) throw new Error(msg);
    log(`${msg} (dry run continues with no history)`);
  }
  const lastGood = lastRuns?.[0]?.started_at as string | undefined;
  if (APPLY && !FORCE && ranRecently(lastGood, Date.now())) {
    log(`last good run ${lastGood} is under ${MIN_GAP_HOURS}h old — nothing to do (use --force to run anyway)`);
    return;
  }

  const days = numArg("--days")
    ?? (lastGood ? Math.min(FIRST_RUN_DAYS, Math.ceil((Date.now() - Date.parse(lastGood)) / DAY) + 1) : FIRST_RUN_DAYS);
  const after = new Date(Date.now() - days * DAY);
  log(`${APPLY ? "APPLY" : "DRY RUN"} — looking back ${days} day(s), to ${after.toISOString().slice(0, 10)}`);

  let runId: number | null = null;
  if (APPLY) {
    const { data, error } = await sb.from("deal_runs").insert({ user_id: uid }).select("id").single();
    if (error) throw new Error(`deal_runs insert: ${error.message}`);
    runId = data.id as number;
  }

  const notes: string[] = [];
  try {
    const seen = new Map<string, Seen>();
    for (const r of await loadAll<{ source: string; item_id: string; outcome: string; attempts: number }>(
      sb, "deal_seen_items", "source, item_id, outcome, attempts", uid)) {
      seen.set(`${r.source}|${r.item_id}`, { outcome: r.outcome, attempts: r.attempts });
    }
    const done = (source: string, id: string) => {
      const s = seen.get(`${source}|${id}`);
      return !!s && (s.outcome !== "error" || s.attempts >= MAX_ATTEMPTS);
    };
    const records: { source: string; item_id: string; outcome: string; reason: string | null; attempts: number }[] = [];
    const record = (source: string, item_id: string, outcome: string, reason: string | null) => {
      const prev = seen.get(`${source}|${item_id}`);
      records.push({ source, item_id, outcome, reason, attempts: (prev?.attempts ?? 0) + (outcome === "error" ? 1 : 0) || 1 });
    };

    const pending: Pending[] = [];
    let emailCount = 0, blogCount = 0, skipped = 0;

    // ── Email ──────────────────────────────────────────────────────────────
    let imap: ImapSource | null = null;
    if (!NO_EMAIL) {
      const user = (settings.gmail_user as string | null) ?? process.env.GMAIL_USER;
      const pass = settings.gmail_app_password_encrypted
        ? decrypt(settings.gmail_app_password_encrypted as string)
        : process.env.GMAIL_APP_PASSWORD;
      if (!user || !pass) throw new Error("no Gmail app password — save one in Cards → Settings");
      imap = new ImapSource(user, pass);
      const headers = await imap.searchHeaders(dealSearchQuery(after.getTime() / 1000));
      emailCount = headers.length;
      const passing: { id: string; from: string; subject: string; date: string | null }[] = [];
      for (const h of headers) {
        if (done("email", h.id)) continue;
        const s = screen({ from: h.from, subject: h.subject });
        if (!s.pass) { record("email", h.id, "skipped", s.reason); skipped++; continue; }
        passing.push(h);
      }
      log(`email: ${headers.length} matched the search, ${passing.length} new and worth reading`);
      for (const h of passing) {
        try {
          const msg = await imap.fetchMessage(h.id);
          const seenAt = h.date ?? new Date(msg.internalDate).toISOString();
          pending.push({
            source: { kind: "email", item_id: h.id, origin: h.from, title: h.subject, url: null, seen_at: seenAt },
            item: { kind: "email", origin: h.from, title: h.subject, seen_at: seenAt,
              text: bestBodyText(msg.textBody, msg.htmlBody, stripHtml) },
          });
        } catch (e) {
          record("email", h.id, "error", `fetch: ${(e as Error).message}`);
          notes.push(`couldn't download one email (${h.subject.slice(0, 40)})`);
        }
      }
    }

    // ── Blogs ──────────────────────────────────────────────────────────────
    if (!NO_BLOGS) {
      for (const feed of FEEDS) {
        let items;
        try {
          items = parseRss(await fetchFeed(feed.url));
        } catch (e) {
          notes.push(`${feed.name} feed unreachable (${(e as Error).message})`);
          continue;
        }
        if (!items.length) { notes.push(`${feed.name} feed had no readable posts`); continue; }
        blogCount += items.length;
        for (const it of items) {
          if (it.published && Date.parse(it.published) < after.getTime()) continue;
          if (done("blog", it.link)) continue;
          const s = screen({ from: feed.name, subject: it.title, snippet: it.summary });
          if (!s.pass) { record("blog", it.link, "skipped", s.reason); skipped++; continue; }
          const seenAt = it.published ?? new Date().toISOString();
          pending.push({
            source: { kind: "blog", item_id: it.link, origin: feed.name, title: it.title, url: it.link, seen_at: seenAt },
            item: { kind: "blog", origin: feed.name, title: it.title, seen_at: seenAt, text: it.summary },
          });
        }
      }
    }

    // ── AI read, oldest first so history builds in order ───────────────────
    pending.sort((a, b) => Date.parse(a.source.seen_at) - Date.parse(b.source.seen_at));
    const toRead = pending.slice(0, LIMIT);
    if (pending.length > LIMIT) notes.push(`${pending.length - LIMIT} items left for the next run (limit ${LIMIT})`);

    const apiKey = settings.anthropic_key_encrypted
      ? decrypt(settings.anthropic_key_encrypted as string) : process.env.ANTHROPIC_API_KEY;
    if (toRead.length && !apiKey) throw new Error("no Anthropic API key — save one in Settings");
    const client = new Anthropic({ apiKey });

    const deals = await loadAll<StoredDeal>(sb, "deals", "*", uid);
    const usage: Usage = { input: 0, output: 0 };
    let found = 0, added = 0, updated = 0, errors = 0;

    for (const p of toRead) {
      const { kind, item_id } = p.source;
      try {
        const { result, usage: u } = await extractDeal(client, p.item);
        usage.input += u.input; usage.output += u.output;
        if (!result.deal) {
          if (result.reason === UNREADABLE) errors++;
          record(kind, item_id, result.reason === UNREADABLE ? "error" : "not_deal", result.reason);
          log(`  · ${p.source.title.slice(0, 70)} — ${result.reason}`);
          continue;
        }
        found++;
        const plan = planUpsert(result.deal, p.source, deals);
        const d = result.deal;
        if (VERBOSE) log(`    ${JSON.stringify({ ...d, evidence: d.evidence.slice(0, 120) })}`);
        log(`  ★ ${d.headline} [${d.kind} ${d.program}${d.bonus_pct ? ` ${d.bonus_pct}%` : ""}${d.discount_pct ? ` ${d.discount_pct}% off` : ""}${d.ends_on ? ` until ${d.ends_on}` : ""}] → ${plan.action}`);
        if (plan.action === "insert") {
          if (APPLY) {
            const { data, error } = await sb.from("deals").insert({ ...plan.row, user_id: uid }).select("*").single();
            if (error) throw new Error(`deals insert: ${error.message}`);
            deals.push(data as StoredDeal);
          } else {
            deals.push({ ...plan.row, id: `dry-${deals.length}` });
          }
          added++;
        } else if (plan.action === "update") {
          if (APPLY) {
            const { id, ...row } = plan.row;
            const { error } = await sb.from("deals").update(row).eq("id", id);
            if (error) throw new Error(`deals update: ${error.message}`);
          }
          deals[deals.findIndex((x) => x.id === plan.id)] = plan.row;
          updated++;
        }
        record(kind, item_id, "deal", null);
      } catch (e) {
        errors++;
        record(kind, item_id, "error", (e as Error).message.slice(0, 300));
        log(`  ! ${p.source.title.slice(0, 70)} — ${(e as Error).message}`);
      }
    }
    // Partner balances from the programs' own emails (src/lib/balances).
    // Its own failure is a note on the run, never a failed deal check.
    if (imap) {
      try {
        notes.push(await syncLoyaltyBalances({ imap, sb, uid, apply: APPLY, log }));
      } catch (e) {
        notes.push(`balance check failed (${(e as Error).message})`);
      }
    }
    await imap?.close();

    if (APPLY && records.length) {
      for (let i = 0; i < records.length; i += 500) {
        const { error } = await sb.from("deal_seen_items").upsert(
          records.slice(i, i + 500).map((r) => ({ ...r, user_id: uid, seen_at: new Date().toISOString() })),
          { onConflict: "user_id,source,item_id" });
        if (error) throw new Error(`deal_seen_items: ${error.message}`);
      }
    }

    const cost = usageCostUsd(usage);
    const summary = [
      `Checked ${emailCount} emails and ${blogCount} blog posts; ${skipped} filtered out free, ${toRead.length} read by AI`,
      `${found} deal${found === 1 ? "" : "s"} (${added} new, ${updated} updated)`,
      `AI cost $${cost.toFixed(4)}`,
      ...(errors ? [`${errors} read error${errors === 1 ? "" : "s"} (retried next run)`] : []),
      ...notes,
    ].join(" · ");
    log(summary);
    if (APPLY && runId != null) {
      const { error } = await sb.from("deal_runs")
        .update({ finished_at: new Date().toISOString(), ok: true, summary }).eq("id", runId);
      if (error) throw new Error(`deal_runs update: ${error.message}`);
    }
  } catch (e) {
    if (APPLY && runId != null) {
      await sb.from("deal_runs").update({
        finished_at: new Date().toISOString(), ok: false, summary: `Failed: ${(e as Error).message}`,
      }).eq("id", runId);
    }
    throw e;
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`[deals] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
