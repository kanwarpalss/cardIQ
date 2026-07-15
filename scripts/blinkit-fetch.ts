/**
 * blinkit-fetch.ts — page through your OWN Blinkit order history and dump it to
 * blinkit-orders.json, for import-blinkit.ts. Blinkit has no official export, so
 * this calls the same internal endpoint the website uses, with YOUR session.
 *
 * ⚠️  This uses your logged-in cookie. Keep it private — never share it, and
 *     never commit it. The script reads it from the env, it is never printed.
 *
 * Setup (one time, ~2 min in your browser):
 *   1. Log in at https://blinkit.com and open "My Orders".
 *   2. Open DevTools (F12) → Network tab → click an order / scroll the list.
 *   3. Find the request that returns your orders (look for "order" in the name).
 *      • Copy its full URL              → BLINKIT_ORDERS_URL
 *      • Right-click → Copy → Copy as cURL, grab the `cookie:` header value
 *                                        → BLINKIT_COOKIE
 *   4. Run:
 *        BLINKIT_ORDERS_URL='<url>' BLINKIT_COOKIE='<cookie>' \
 *          npx tsx scripts/blinkit-fetch.ts
 *
 * If the endpoint paginates, set BLINKIT_PAGE_PARAM (e.g. "page" or "offset").
 * If anything 401s, the cookie expired — repeat step 3.
 */
import { writeFileSync } from "fs";

const URL_BASE = process.env.BLINKIT_ORDERS_URL;
const COOKIE = process.env.BLINKIT_COOKIE;
const PAGE_PARAM = process.env.BLINKIT_PAGE_PARAM; // optional
const OUT = "blinkit-orders.json";

async function main() {
  if (!URL_BASE || !COOKIE) {
    console.error("Set BLINKIT_ORDERS_URL and BLINKIT_COOKIE (see the header of this file).");
    process.exit(1);
  }
  const headers: Record<string, string> = {
    cookie: COOKIE,
    accept: "application/json",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  };

  const pages: unknown[] = [];
  const maxPages = PAGE_PARAM ? 50 : 1;
  for (let p = 0; p < maxPages; p++) {
    const url = PAGE_PARAM
      ? `${URL_BASE}${URL_BASE.includes("?") ? "&" : "?"}${PAGE_PARAM}=${p}`
      : URL_BASE;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (p === 0) { console.error(`Request failed: ${res.status} ${res.statusText}. Cookie may have expired.`); process.exit(1); }
      break; // ran past the last page
    }
    const json = await res.json();
    pages.push(json);
    const text = JSON.stringify(json);
    process.stdout.write(`  page ${p}: ${text.length} bytes\n`);
    if (!PAGE_PARAM || text.length < 50) break; // single page, or empty → stop
  }

  writeFileSync(OUT, JSON.stringify(pages.length === 1 ? pages[0] : pages, null, 2));
  console.log(`\nSaved ${pages.length} page(s) → ${OUT}`);
  console.log(`Next:  npx tsx scripts/import-blinkit.ts --file ${OUT}   (add --apply to write)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
