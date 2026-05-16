#!/usr/bin/env -S npx tsx
/**
 * dining-verify-session.ts — quickly check that a captured session
 * decrypts cleanly and looks structurally sane.
 *
 * Does NOT hit the platform's API (that's what the real scrapers will
 * do, with proper politeness). This is just a "did the login CLI
 * actually save something useful?" check.
 *
 * Usage:
 *   npx tsx scripts/dining-verify-session.ts              → check all 3
 *   npx tsx scripts/dining-verify-session.ts zomato       → check one
 */

import { config as loadEnv } from "dotenv";
import { loadSession, PLATFORMS, Platform } from "../src/lib/dining/sessions";

loadEnv({ path: ".env.local" });

async function checkOne(userId: string, platform: Platform) {
  console.log(`\n🔎  ${platform}`);
  console.log("─".repeat(40));
  let row;
  try {
    row = await loadSession(userId, platform);
  } catch (e) {
    console.log(`   ❌ load failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (!row) {
    console.log("   ⚠️  no session row — run scripts/dining-login.ts " + platform);
    return false;
  }

  const cookieCount = row.payload.cookieHeader.split(";").filter(Boolean).length;
  const hasBearer = !!row.payload.bearerToken;
  const expiry = row.expiresAt ? new Date(row.expiresAt) : null;
  const expiresIn = expiry ? Math.round((expiry.getTime() - Date.now()) / 86_400_000) : null;

  console.log(`   ✅ captured at:   ${row.payload.capturedAt}`);
  console.log(`   🍪 cookies:       ${cookieCount}`);
  console.log(`   🔑 bearer token:  ${hasBearer ? "yes" : "no"}`);
  console.log(`   ⏰ expires:       ${expiry ? expiry.toISOString() : "unknown"}`);
  if (expiresIn != null) {
    if (expiresIn < 0) console.log(`   ⚠️  expired ${-expiresIn} days ago — re-login recommended`);
    else console.log(`   📅 ${expiresIn} days remaining (heuristic)`);
  }
  return true;
}

async function main() {
  const userId = process.env.CARDIQ_USER_ID;
  if (!userId) {
    console.error("CARDIQ_USER_ID not set in .env.local");
    process.exit(1);
  }

  const arg = process.argv[2] as Platform | undefined;
  const targets = arg ? [arg] : PLATFORMS;
  for (const t of targets) {
    if (!PLATFORMS.includes(t)) {
      console.error(`Unknown platform: ${t}. Use one of: ${PLATFORMS.join(", ")}`);
      process.exit(1);
    }
  }

  console.log("Dining sessions — sanity check");
  console.log("═".repeat(40));

  let allOk = true;
  for (const t of targets) {
    const ok = await checkOne(userId, t);
    if (!ok) allOk = false;
  }

  console.log("");
  console.log(allOk ? "✨ All sessions look good." : "⚠️  One or more sessions need attention.");
  process.exit(allOk ? 0 : 2);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
