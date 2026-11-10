/**
 * statements-balances.ts — save each card's reward-point balance from its
 * latest statement into reward_balances, so Transfer partners can show
 * "7,65,241 points · statement 15 Oct" instead of asking KP to type it.
 *
 * Reads the text the statements pipeline already extracted
 * (~/.cardiq-statements/text, see statements-download/-unlock/-parse); it
 * never opens a PDF or a password. Readers live in
 * src/lib/balances/statement-points.ts: Axis EDGE balances and HDFC balances
 * (HDFC's only when its own opening/earned/lapsed/closing figures add up).
 * ICICI, HSBC and Swiggy statements carry no usable balance.
 *
 * Run after refreshing statements. READ-ONLY by default:
 *   npx tsx scripts/statements-balances.ts            # show what it would save
 *   npx tsx scripts/statements-balances.ts --apply    # save new balances
 * A balance already saved for the same card and date is never added twice.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { CARD_REGISTRY } from "../src/lib/cards/registry";
import { readAxisPoints, readHdfcPoints } from "../src/lib/balances/statement-points";

const APPLY = process.argv.includes("--apply");
const DIR = join(homedir(), ".cardiq-statements");

type Manifest = { uid: number; family: string; subject: string; date: string };
type Text = { pages: { cells: { s: string }[] }[][] };
type Card = { id: string; product_key: string; last4: string };

async function main() {
  if (!existsSync(join(DIR, "manifest.json"))) throw new Error(`no statements at ${DIR} — run the statements scripts first`);
  const raw = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
  const manifest: Manifest[] = Array.isArray(raw) ? raw : Object.values(raw);
  const byUid = new Map(manifest.map((m) => [m.uid, m]));

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s } = await sb.from("user_settings").select("user_id").limit(1).single();
  const uid = s!.user_id as string;
  const { data: cards, error } = await sb.from("cards").select("id, product_key, last4").eq("user_id", uid);
  if (error) throw new Error(error.message);

  // Newest reading per card.
  const best = new Map<string, { card: Card; balance: number; as_of: string; from: string }>();
  for (const f of readdirSync(join(DIR, "text"))) {
    const m = byUid.get(Number(f.split("-")[0]));
    if (!m || (m.family !== "axis" && m.family !== "hdfc")) continue;
    const text: Text = JSON.parse(readFileSync(join(DIR, "text", f), "utf8"));
    const rows = text.pages.flat().map((r) => r.cells.map((c) => c.s).join(" | "));

    let card: Card | undefined;
    let reading: { balance: number; as_of: string } | null = null;
    if (m.family === "axis") {
      // Axis names only two digits ("ending XX55"); accept a single match.
      const tail = /ending XX(\d{2})\b/i.exec(m.subject)?.[1];
      const hits = (cards as Card[]).filter((c) => c.product_key.startsWith("axis_") && tail && c.last4.endsWith(tail));
      if (hits.length === 1) { card = hits[0]; reading = readAxisPoints(rows); }
    } else {
      const r = readHdfcPoints(rows);
      if (r) { card = (cards as Card[]).find((c) => c.product_key.startsWith("hdfc_") && c.last4 === r.last4); reading = r; }
    }
    if (!card || !reading) continue;
    const prev = best.get(card.id);
    if (!prev || prev.as_of < reading.as_of) best.set(card.id, { card, ...reading, from: m.subject });
  }

  const { data: saved } = await sb.from("reward_balances").select("card_id, as_of, balance").eq("user_id", uid);
  let added = 0;
  for (const b of best.values()) {
    const name = CARD_REGISTRY[b.card.product_key]?.display_name ?? b.card.product_key;
    const dup = (saved ?? []).some((r) => r.card_id === b.card.id && r.as_of === b.as_of && Number(r.balance) === b.balance);
    console.log(`${name} ••${b.card.last4}: ${b.balance.toLocaleString("en-IN")} points as of ${b.as_of}${dup ? " (already saved)" : ""}`);
    if (dup || !APPLY) continue;
    const { error: e } = await sb.from("reward_balances").insert({
      user_id: uid, card_id: b.card.id,
      program: CARD_REGISTRY[b.card.product_key]?.rewards?.program ?? "Reward points",
      balance: b.balance, as_of: b.as_of, source: "parsed",
      notes: `From statement: ${b.from.slice(0, 120)}`,
    });
    if (e) throw new Error(`reward_balances insert: ${e.message}`);
    added++;
  }
  console.log(APPLY ? `Saved ${added} new balance${added === 1 ? "" : "s"}.` : "Dry run — nothing saved. Add --apply to save.");
}

main().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(1); });
