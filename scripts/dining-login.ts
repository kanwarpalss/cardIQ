#!/usr/bin/env -S npx tsx
/**
 * dining-login.ts — one-time interactive session capture per platform.
 *
 * Usage (run on KP's Mac mini, where Playwright + a real GUI live):
 *   npx tsx scripts/dining-login.ts zomato
 *   npx tsx scripts/dining-login.ts swiggy
 *   npx tsx scripts/dining-login.ts eazydiner
 *
 * What it does
 * ────────────
 * 1. Opens a real Chromium window pointed at the platform's login page.
 * 2. KP logs in by hand (phone + OTP, the way he normally would).
 * 3. After the page navigates to the logged-in state, the script
 *    captures cookies + (where applicable) the bearer token + any
 *    relevant headers (csrf, etc.).
 * 4. Encrypts the payload via lib/crypto.ts and upserts into the
 *    dining_sessions Supabase table.
 *
 * Required env (read from .env.local automatically when running via npx tsx):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY       ← service-role; never goes to browser
 *   ENCRYPTION_KEY                   ← 32-byte hex, used by lib/crypto.ts
 *   CARDIQ_USER_ID                   ← KP's auth.users(id) — see scripts/db.sh on how to fetch
 *
 * Why this is a script, not a route
 * ─────────────────────────────────
 * Playwright on Vercel is a known pain (binary size + cold starts).
 * Logins happen ~once every 30–90 days per platform. Native CLI on the
 * Mac mini is the right tool. The output (encrypted session in
 * Supabase) is then consumed by the scraper which can run anywhere.
 */

import { config as loadEnv } from "dotenv";
import { chromium, BrowserContext, Cookie } from "playwright";
import { saveSession, SessionPayload, Platform, PLATFORMS } from "../src/lib/dining/sessions";

loadEnv({ path: ".env.local" });

interface PlatformConfig {
  loginUrl: string;
  /**
   * URL pattern that, once reached, signals "user is logged in".
   * Either a substring or a function evaluated against the current
   * page URL after each navigation.
   */
  loggedInWhen: (url: string) => boolean;
  /**
   * Cookie names worth keeping. Filters out third-party tracking
   * cookies that don't matter to the platform API.
   */
  cookieAllowlist: (name: string) => boolean;
  /**
   * Some platforms keep their auth token in localStorage (Swiggy
   * Dineout's `_swt`-style token is one). Extract it here if so.
   */
  extractBearer?: (ctx: BrowserContext) => Promise<string | undefined>;
}

const CONFIGS: Record<Platform, PlatformConfig> = {
  zomato: {
    // Dining Out tab (BLR). Zomato detects user state and redirects.
    loginUrl: "https://www.zomato.com/bangalore/dine-out",
    loggedInWhen: (url) =>
      // Once authed, the URL keeps `/dine-out` but the page renders a
      // profile menu. We detect login via cookie presence instead —
      // see the polling loop below.
      url.includes("zomato.com"),
    cookieAllowlist: (name) => /^(cid|csrf-token|userid|fbcity|PHPSESSID|access_token|locus|rd|et|zat)/i.test(name),
  },
  swiggy: {
    // Swiggy Dineout (post-acquisition) sits at the /dineout path.
    loginUrl: "https://www.swiggy.com/dineout",
    loggedInWhen: (url) => url.includes("swiggy.com"),
    cookieAllowlist: (name) => /^(_sid|tid|_session_tid|_gcl|userLocation|deviceId|_swuid|_guest_tid)/i.test(name),
    extractBearer: async (ctx) => {
      // Swiggy keeps a bearer in localStorage under a couple of keys.
      try {
        const page = ctx.pages()[0];
        if (!page) return undefined;
        const tok = await page.evaluate(() => {
          const keys = ["_swt", "userToken", "authToken", "accessToken"];
          for (const k of keys) {
            const v = window.localStorage.getItem(k);
            if (v) return v;
          }
          return undefined;
        });
        return typeof tok === "string" ? tok : undefined;
      } catch {
        return undefined;
      }
    },
  },
  eazydiner: {
    loginUrl: "https://www.eazydiner.com/bangalore/restaurants",
    loggedInWhen: (url) => url.includes("eazydiner.com"),
    cookieAllowlist: (name) => /^(ed_|session|token|user|csrf|laravel_session|XSRF-TOKEN)/i.test(name),
    extractBearer: async (ctx) => {
      try {
        const page = ctx.pages()[0];
        if (!page) return undefined;
        const tok = await page.evaluate(() => {
          const keys = ["ed_token", "accessToken", "authToken", "userToken"];
          for (const k of keys) {
            const v = window.localStorage.getItem(k);
            if (v) return v;
          }
          return undefined;
        });
        return typeof tok === "string" ? tok : undefined;
      } catch {
        return undefined;
      }
    },
  },
};

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

async function main() {
  const platform = process.argv[2] as Platform | undefined;
  if (!platform || !PLATFORMS.includes(platform)) {
    console.error(`Usage: npx tsx scripts/dining-login.ts <${PLATFORMS.join("|")}>`);
    process.exit(1);
  }

  const userId = process.env.CARDIQ_USER_ID;
  if (!userId) {
    console.error("CARDIQ_USER_ID not set. Find it via the Supabase dashboard: Authentication → Users → your row.");
    process.exit(1);
  }

  const cfg = CONFIGS[platform];

  console.log(`\n🍽  Dining session capture for ${platform.toUpperCase()}`);
  console.log("─".repeat(60));
  console.log("A Chromium window will open at:");
  console.log(`  ${cfg.loginUrl}`);
  console.log("\nLog in with your real phone + OTP. The script will detect");
  console.log("a successful login and save the session automatically.");
  console.log("\nWhen done, you can just close the browser — or press Ctrl-C.\n");

  const browser = await chromium.launch({ headless: false });
  // A persistent context (with its own cookie jar) so a single login
  // works. We DON'T reuse the user's real Chrome profile — that would
  // mix CardIQ scraping with KP's personal browsing in concerning ways.
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded" });

  // Poll for the "logged in" signal — a session cookie that wasn't there
  // before. We don't trust URL alone because some platforms keep you on
  // the same page after login.
  console.log("⏳ Waiting for login (polling every 3s; timeout 10 min)...");
  const start = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000;

  let captured = false;
  while (Date.now() - start < TIMEOUT_MS) {
    await page.waitForTimeout(3_000);
    const cookies = await ctx.cookies();
    const interesting = cookies.filter((c) => cfg.cookieAllowlist(c.name));
    // Heuristic: at least 2 allowlisted cookies usually means a real session.
    if (interesting.length >= 2) {
      captured = true;
      break;
    }
  }

  if (!captured) {
    console.error("❌ Timed out waiting for login. Try again.");
    await browser.close();
    process.exit(2);
  }

  const allCookies = await ctx.cookies();
  const interesting = allCookies.filter((c) => cfg.cookieAllowlist(c.name));
  const cookieHeader = interesting
    .map((c: Cookie) => `${c.name}=${c.value}`)
    .join("; ");

  const bearer = cfg.extractBearer ? await cfg.extractBearer(ctx) : undefined;

  // Heuristic expiry: take the soonest meaningful cookie expiry from
  // the captured set, fall back to 30 days from now.
  const cookieExpiries = interesting
    .map((c) => c.expires)
    .filter((e) => typeof e === "number" && e > 0) as number[];
  const earliest = cookieExpiries.length ? Math.min(...cookieExpiries) * 1000 : 0;
  const expiresAt = earliest > Date.now()
    ? new Date(earliest)
    : new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const payload: SessionPayload = {
    cookieHeader,
    bearerToken: bearer,
    capturedAt: new Date().toISOString(),
  };

  await saveSession(userId, platform, payload, expiresAt);

  console.log(`\n✅ Saved encrypted session for ${platform}`);
  console.log(`   Cookies captured: ${interesting.length} (${interesting.map((c) => c.name).join(", ")})`);
  console.log(`   Bearer token:     ${bearer ? "yes" : "no"}`);
  console.log(`   Expires:          ${expiresAt.toISOString()}`);
  console.log("");

  await browser.close();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
