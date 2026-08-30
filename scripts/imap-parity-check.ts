/**
 * IMAP migration Phase 4 — parity check. READ-ONLY, writes nothing.
 *
 * Runs the SAME queries the two production sync routes issue through BOTH
 * GmailApiSource and ImapSource over a bounded recent window, then diffs the
 * resulting id sets and a few normalized fields per message. This is the
 * safety net for Invariant #3 (never re-download, never silently miss an
 * email) before Phase 5 cuts real sync traffic over to IMAP.
 *
 * Usage:  npx tsx scripts/imap-parity-check.ts
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

import { GmailApiSource, ImapSource, type MailSource, type NormalizedMessage } from "../src/lib/gmail/mail-source";
import { decrypt } from "../src/lib/crypto";
import { CARD_REGISTRY } from "../src/lib/cards/registry";
import { ORDER_DISCOVERY_CLAUSES } from "../src/lib/parsers/orders/registry";

const WINDOW_DAYS = 90;

function bail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function summarize(source: MailSource, query: string, label: string) {
  console.log(`\n[${label}] searching…`);
  const ids = await source.search(query);
  console.log(`[${label}] ${ids.length} message id(s)`);

  const byId = new Map<string, NormalizedMessage>();
  // Bound the per-message fetch cost — enough to be a meaningful sample
  // without a 90-day full-body pull on every run.
  const sample = ids.slice(0, 60);
  for (const id of sample) {
    try {
      byId.set(id, await source.fetchMessage(id));
    } catch (e) {
      console.error(`[${label}] fetchMessage(${id}) failed: ${(e as Error).message}`);
    }
  }
  return { ids: new Set(ids), byId };
}

function diffIdSets(label: string, a: Set<string>, b: Set<string>) {
  const onlyA = [...a].filter((id) => !b.has(id));
  const onlyB = [...b].filter((id) => !a.has(id));
  console.log(`\n[${label}] Gmail-API-only ids: ${onlyA.length}${onlyA.length ? " → " + onlyA.slice(0, 5).join(", ") + (onlyA.length > 5 ? " …" : "") : ""}`);
  console.log(`[${label}] IMAP-only ids:      ${onlyB.length}${onlyB.length ? " → " + onlyB.slice(0, 5).join(", ") + (onlyB.length > 5 ? " …" : "") : ""}`);
  return { onlyA, onlyB };
}

function diffFields(label: string, a: Map<string, NormalizedMessage>, b: Map<string, NormalizedMessage>) {
  let mismatches = 0;
  for (const [id, msgA] of a) {
    const msgB = b.get(id);
    if (!msgB) continue; // only in the id-set diff, already reported
    const issues: string[] = [];
    if (msgA.subject !== msgB.subject) issues.push(`subject differs: "${msgA.subject}" vs "${msgB.subject}"`);
    const lenDiff = Math.abs(msgA.textBody.length - msgB.textBody.length);
    if (lenDiff > Math.max(20, msgA.textBody.length * 0.05)) {
      issues.push(`textBody length differs: ${msgA.textBody.length} vs ${msgB.textBody.length}`);
    }
    if (msgA.attachments.length !== msgB.attachments.length) {
      issues.push(`attachment count differs: ${msgA.attachments.length} vs ${msgB.attachments.length}`);
    }
    if (Math.abs(msgA.internalDate - msgB.internalDate) > 2000) {
      issues.push(`internalDate differs by ${Math.abs(msgA.internalDate - msgB.internalDate)}ms`);
    }
    if (issues.length) {
      mismatches++;
      console.log(`[${label}] MISMATCH ${id}: ${issues.join("; ")}`);
    }
  }
  console.log(`[${label}] field parity: ${a.size - mismatches}/${a.size} sampled messages match`);
  return mismatches;
}

async function main() {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!gmailUser || !gmailPass) bail("GMAIL_USER / GMAIL_APP_PASSWORD missing from .env.local.");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) bail("Supabase env missing — cannot look up the OAuth refresh token.");

  const db = createClient(url, serviceKey);
  const { data: settingsRows, error } = await db
    .from("user_settings")
    .select("google_refresh_token_encrypted")
    .not("google_refresh_token_encrypted", "is", null)
    .limit(1);
  if (error || !settingsRows?.length) {
    bail(`Could not find a stored OAuth refresh token to compare against: ${error?.message ?? "no rows"}`);
  }
  const refreshToken = decrypt(settingsRows[0].google_refresh_token_encrypted as string);

  const afterSeconds = Math.floor((Date.now() - WINDOW_DAYS * 86400 * 1000) / 1000);

  const allSenders = new Set<string>();
  for (const spec of Object.values(CARD_REGISTRY)) spec.gmail.senders.forEach((s) => allSenders.add(s));
  const bankQuery = `(${[...allSenders].map((s) => `from:${s}`).join(" OR ")}) after:${afterSeconds}`;
  const ordersQuery = `(${ORDER_DISCOVERY_CLAUSES.join(" OR ")}) after:${afterSeconds}`;

  console.log("=".repeat(64));
  console.log(`PHASE 4 — parity check, last ${WINDOW_DAYS} days`);
  console.log("=".repeat(64));

  const gmailSrc = new GmailApiSource(refreshToken);
  const imapSrc = new ImapSource(gmailUser!, gmailPass!);

  try {
    for (const [label, query] of [["bank", bankQuery], ["orders", ordersQuery]] as const) {
      console.log(`\n${"-".repeat(64)}\nQuery (${label}): ${query}\n${"-".repeat(64)}`);
      const [a, b] = await Promise.all([
        summarize(gmailSrc, query, `${label}/gmail-api`),
        summarize(imapSrc, query, `${label}/imap`),
      ]);
      const { onlyA, onlyB } = diffIdSets(label, a.ids, b.ids);
      const mismatches = diffFields(label, a.byId, b.byId);

      if (onlyA.length === 0 && onlyB.length === 0 && mismatches === 0) {
        console.log(`\n✓ PHASE 4 PASS (${label}) — identical message sets, sampled fields match.`);
      } else {
        console.log(`\n✗ PHASE 4 issues found (${label}) — investigate before Phase 5 cutover.`);
      }
    }
  } finally {
    await gmailSrc.close();
    await imapSrc.close();
  }
}

main().catch((e) => bail((e as Error).stack || String(e)));
