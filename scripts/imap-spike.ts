/**
 * IMAP migration spike — READ-ONLY. Writes nothing, mutates nothing.
 *
 * Answers the two questions that decide whether replacing the Gmail API with
 * IMAP + an app password is viable at all. If either fails, we stop and keep
 * OAuth — no production code has been touched at that point.
 *
 *   Q1 (auth + search): can we authenticate with an app password, and can we
 *       still run the SENDER-SCOPED, DATE-SCOPED queries the sync depends on?
 *       Gmail's IMAP exposes X-GM-RAW, which accepts native Gmail search
 *       syntax ("from:… after:…") — if that works, the existing queries port
 *       across unchanged instead of being rewritten as weaker IMAP SEARCH.
 *
 *   Q2 (identity — THE critical one): does IMAP give us the SAME message ID
 *       already stored in transactions.gmail_message_id for 10,000+ rows?
 *       Gmail's X-GM-MSGID is the same 64-bit ID the REST API exposes, but the
 *       API renders it in HEX while IMAP may report decimal. Get this mapping
 *       wrong and the first sync either re-downloads years of mail or silently
 *       skips everything (Invariant #3 — dedupe by gmail_message_id).
 *
 * Usage:  npx tsx scripts/imap-spike.ts
 * Needs in .env.local (add them yourself — never paste the password in chat):
 *   GMAIL_USER=kanwarpalss@gmail.com
 *   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx   (16 chars, spaces stripped)
 */

import { ImapFlow } from "imapflow";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");

function bail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** Gmail API message ids are the hex form of X-GM-MSGID. */
const toHex = (v: string | number | bigint) => BigInt(v).toString(16);

async function main() {
  if (!USER || !PASS) {
    bail(
      "GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env.local.\n" +
      "  1. Enable 2-Step Verification on the Google account\n" +
      "  2. Create an app password at myaccount.google.com/apppasswords\n" +
      "  3. Add both lines to .env.local (do NOT share the password)"
    );
  }

  console.log("=".repeat(64));
  console.log("PHASE 1 — auth + search capability");
  console.log("=".repeat(64));

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: USER, pass: PASS },
    logger: false,
  });

  try {
    await client.connect();
  } catch (e) {
    bail(
      `IMAP login failed: ${(e as Error).message}\n` +
      "Common causes: app password wrong/expired, 2FA not enabled, or IMAP " +
      "disabled in Gmail → Settings → Forwarding and POP/IMAP."
    );
  }
  console.log("✓ Authenticated over IMAP with an app password (no OAuth involved)");

  const caps = client.capabilities;
  const hasGmailExt = caps.has("X-GM-EXT-1");
  console.log(`${hasGmailExt ? "✓" : "✗"} X-GM-EXT-1 capability (X-GM-RAW search + X-GM-MSGID ids)`);
  if (!hasGmailExt) {
    bail("Without X-GM-EXT-1 we lose Gmail search syntax AND the shared message id. Stop here.");
  }

  const lock = await client.getMailboxLock("[Gmail]/All Mail");
  try {
    // The exact shape of query the sync issues: sender-scoped + date-scoped.
    const gmailQuery = "from:alerts@axisbank.com newer_than:2y";
    console.log(`\nRunning Gmail-syntax search via X-GM-RAW:  ${gmailQuery}`);

    const uids = await client.search({ gmailraw: gmailQuery }, { uid: true });
    console.log(`✓ Search returned ${uids ? uids.length : 0} message(s)`);
    if (!uids || uids.length === 0) {
      console.log("  (no Axis mail in 2y — try another sender before concluding anything)");
    }

    // Pull the Gmail message id for a sample.
    const take = (uids || []).slice(-5);
    for await (const msg of client.fetch(
      take.length ? take : "1:1",
      { uid: true, envelope: true },
      { uid: take.length > 0 }
    )) {
      // emailId arrives free with X-GM-EXT-1 — it is never requested.
      const raw = msg.emailId;
      console.log(
        `  uid=${msg.uid}  emailId=${raw ?? "(none)"}  ` +
        `hex=${raw ? toHex(raw) : "-"}  subject="${(msg.envelope?.subject ?? "").slice(0, 40)}"`
      );
    }
  } finally {
    lock.release();
  }

  console.log("\n" + "=".repeat(64));
  console.log("PHASE 2 — identity mapping against ALREADY-SYNCED rows");
  console.log("=".repeat(64));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("⚠ Supabase env missing — cannot run the identity check. Phase 2 UNPROVEN.");
    await client.logout();
    return;
  }

  const db = createClient(url, key);

  // Collect ids from IMAP first, then ask the DATABASE about those exact ids.
  //
  // The obvious approach — pull a slab of gmail_seen_messages and intersect in
  // memory — is WRONG here and produced a false negative on the first run:
  // Supabase silently caps .select() at 1000 rows regardless of .limit()
  // (EDGE-09), and with ~10k seen messages the arbitrary 1000 returned held
  // none of the recent mail being tested. It reported "0 overlap" and would
  // have killed a perfectly viable migration. A targeted .in() lookup asks the
  // question directly, is not row-capped for our sample size, and is cheaper.
  const lock2 = await client.getMailboxLock("[Gmail]/All Mail");
  const imapHexIds: string[] = [];
  try {
    const uids = await client.search(
      { gmailraw: "from:alerts@axisbank.com newer_than:1y" }, { uid: true }
    );
    const sample = (uids || []).slice(-40);
    if (sample.length === 0) {
      console.log("⚠ No recent Axis mail found — cannot intersect. Try another sender.");
    }
    for await (const msg of client.fetch(sample, { uid: true }, { uid: true })) {
      const raw = msg.emailId; // free with X-GM-EXT-1
      if (!raw) continue;
      // Gmail's REST API renders X-GM-MSGID in hex; IMAP reports it DECIMAL.
      //
      // Do not try to detect which form you were handed by inspecting the
      // characters: a decimal integer is made entirely of 0-9, and 0-9 are all
      // valid hex digits, so /^[0-9a-f]+$/ matches BOTH forms. An earlier cut
      // of this script used exactly that test, always took the "already hex"
      // branch, never converted, and reported a false 0/40 — nearly killing a
      // migration that in fact works. Offer both candidates and let the
      // database say which one exists.
      imapHexIds.push(raw.toLowerCase());
      try { imapHexIds.push(toHex(raw)); } catch { /* not numeric — hex form only */ }
    }
  } finally {
    lock2.release();
  }

  const { data: rows, error } = await db
    .from("gmail_seen_messages")
    .select("gmail_message_id")
    .in("gmail_message_id", imapHexIds);

  if (error) {
    console.log(`⚠ Could not read gmail_seen_messages: ${error.message}`);
    await client.logout();
    return;
  }

  // Two candidate forms were pushed per message, so the message count is half.
  const seen = Math.round(imapHexIds.length / 2);
  const hits = new Set((rows ?? []).map((r) => String(r.gmail_message_id))).size;

  console.log(`\nFetched ${seen} recent Axis message ids over IMAP.`);
  console.log(`${hits} of them are ALREADY recorded in gmail_seen_messages.`);
  console.log(
    hits > 0
      ? "✓ PHASE 2 PASS — IMAP's emailId shares the REST API's id space.\n" +
        "  The existing dedupe key survives; no re-download, no silent skips."
      : "✗ PHASE 2 FAIL — zero overlap. The ids are NOT the same space, so a\n" +
        "  migration would re-download everything or skip it all (Invariant #3).\n" +
        "  Do not proceed to Phase 3. Options: store a second id column, or stay on OAuth."
  );

  await client.logout();
}

main().catch((e) => bail((e as Error).stack || String(e)));
