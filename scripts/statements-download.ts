/**
 * statements-download.ts — save credit-card statement PDFs to a private folder.
 *
 * Reads the list from statements-inventory.ts and keeps only known card-statement
 * senders, so bank, broker and mutual-fund statements are never downloaded.
 * The mailbox is opened read-only; nothing is marked as read. Files already on
 * disk are skipped, so re-running is harmless. Writes manifest.json beside them.
 *
 * Run:  npx tsx scripts/statements-download.ts --dir ~/.cardiq-statements
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decrypt } from "../src/lib/crypto";

type Row = { uid: number; gmail_id: string | null; from: string | null; subject: string | null; date: string | null; attachments: string[] };

const CARD_SUBJECT = /credit card|card statement|statement online/i;
const FAMILIES: [string, RegExp][] = [
  ["citi", /@citicorp\.com$/],
  ["hdfc", /^emailstatements\.(cards|cc)@hdfcbank/],
  ["axis", /^cc\.statements@axis/],
  ["icici", /^credit_cards@icici/],
  ["indusind", /^creditcard\.?estatements@indusind/],
  ["idfc", /^statement@idfcfirst/],
  ["hsbc", /^creditcardstatement@mail\.hsbc/],
  ["au", /^estatements@aubank/],
  ["kotak", /^cardstatement@kotak/],
  ["bob", /^ebill@bobfinancial/],
  // Hand-forwarded copies. Only these two addresses, and only card subjects.
  ["forwarded", /^(kanwarpalss|birsimrat1)@gmail\.com$/],
];

export function familyOf(r: Row): string | null {
  const from = (r.from ?? "").toLowerCase();
  const subject = r.subject ?? "";
  if (!r.attachments.some((a) => a.toLowerCase().endsWith(".pdf"))) return null;
  if (!CARD_SUBJECT.test(subject)) return null;
  if (/(^|\b)re:/i.test(subject)) return null;
  return FAMILIES.find(([, re]) => re.test(from))?.[0] ?? null;
}

async function main() {
  const dirIdx = process.argv.indexOf("--dir");
  if (dirIdx < 0) throw new Error("Pass --dir <folder>");
  const dir = process.argv[dirIdx + 1];
  const inventory: Row[] = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf8"));
  const wanted = inventory.flatMap((r) => {
    const family = familyOf(r);
    return family ? [{ ...r, family }] : [];
  });
  const counts: Record<string, number> = {};
  for (const w of wanted) counts[w.family] = (counts[w.family] ?? 0) + 1;
  console.log("Messages to fetch:", wanted.length, JSON.stringify(counts));

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s, error } = await sb
    .from("user_settings")
    .select("gmail_user, gmail_app_password_encrypted")
    .not("gmail_app_password_encrypted", "is", null)
    .limit(1)
    .single();
  if (error || !s) throw new Error(`No stored IMAP credential: ${error?.message ?? "no row"}`);

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: s.gmail_user as string, pass: decrypt(s.gmail_app_password_encrypted as string).replace(/\s+/g, "") },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("[Gmail]/All Mail", { readOnly: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest: Record<string, unknown>[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  const done = new Set(manifest.map((m) => m.uid));
  const failures: { uid: number; error: string }[] = [];
  try {
    for (const w of wanted) {
      if (done.has(w.uid)) continue;
      try {
        const raw = await client.fetchOne(String(w.uid), { uid: true, source: true }, { uid: true });
        if (!raw || !raw.source) throw new Error("no source");
        const mail = await simpleParser(raw.source);
        const folder = join(dir, "raw", w.family);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        for (const a of mail.attachments) {
          const name = a.filename ?? "";
          if (!name.toLowerCase().endsWith(".pdf")) continue;
          if (/most important terms|mitc|terms/i.test(name)) continue;
          const sha = createHash("sha256").update(a.content).digest("hex");
          const file = join(folder, `${w.uid}-${sha.slice(0, 12)}.pdf`);
          writeFileSync(file, a.content, { mode: 0o600 });
          manifest.push({ uid: w.uid, gmail_id: w.gmail_id, family: w.family, from: w.from, subject: w.subject, date: w.date, name, sha256: sha, file });
        }
      } catch (e) {
        failures.push({ uid: w.uid, error: e instanceof Error ? e.message : String(e) });
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 1), { mode: 0o600 });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  console.log(`PDFs saved: ${manifest.length}; failed messages: ${failures.length}`);
  for (const f of failures) console.log(`  uid ${f.uid}: ${f.error}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
