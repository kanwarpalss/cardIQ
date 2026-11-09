/**
 * statements-inventory.ts — list every card-statement email in the mailbox.
 *
 * Read-only: the mailbox is opened read-only and only headers and attachment
 * names are fetched, so nothing is downloaded or marked as read.
 * Writes one JSON file per run to --out, outside the repo.
 *
 * Run:  npx tsx scripts/statements-inventory.ts --out <file.json>
 */
import { writeFileSync } from "fs";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import { decrypt } from "../src/lib/crypto";

type Part = { type?: string; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: Part[] };

// Deliberately wider than the bank list: an unknown issuer should show up here.
const QUERIES = [
  "subject:statement has:attachment filename:pdf",
  "subject:(statement) (credit card) -has:attachment",
  'from:(americanexpress OR aexp) subject:statement',
];

function attachmentNames(part: Part | undefined): string[] {
  if (!part) return [];
  const own = part.dispositionParameters?.filename ?? part.parameters?.name;
  return [...(own ? [own] : []), ...(part.childNodes ?? []).flatMap(attachmentNames)];
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  if (outIdx < 0) throw new Error("Pass --out <file.json>");
  // Same credential the live sync and import-hsbc-alerts.ts use.
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: s, error } = await sb
    .from("user_settings")
    .select("gmail_user, gmail_app_password_encrypted")
    .not("gmail_app_password_encrypted", "is", null)
    .limit(1)
    .single();
  if (error || !s) throw new Error(`No stored IMAP credential: ${error?.message ?? "no row"}`);
  const user = s.gmail_user as string;
  const pass = decrypt(s.gmail_app_password_encrypted as string).replace(/\s+/g, "");

  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock("[Gmail]/All Mail", { readOnly: true });
  const rows = new Map<string, Record<string, unknown>>();
  try {
    for (const q of QUERIES) {
      const uids = (await client.search({ gmailraw: q }, { uid: true })) || [];
      console.log(`${q}: ${uids.length}`);
      if (!uids.length) continue;
      for await (const m of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true })) {
        rows.set(String(m.uid), {
          uid: m.uid,
          gmail_id: m.emailId ? BigInt(m.emailId).toString(16) : null,
          from: m.envelope?.from?.[0]?.address ?? null,
          subject: m.envelope?.subject ?? null,
          date: m.internalDate ? new Date(m.internalDate).toISOString() : null,
          attachments: attachmentNames(m.bodyStructure as Part),
        });
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  const list = [...rows.values()];
  writeFileSync(process.argv[outIdx + 1], JSON.stringify(list, null, 1));
  console.log(`Unique messages: ${list.length}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
