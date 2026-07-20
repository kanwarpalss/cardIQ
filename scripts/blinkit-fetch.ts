/**
 * blinkit-fetch.ts — page through your OWN Blinkit order history and dump it to
 * blinkit-orders.json, for import-blinkit.ts. Blinkit has no official export, so
 * this calls the same internal endpoints the website uses, with YOUR session.
 *
 * ⚠️  This uses your logged-in session credential(s). Blinkit's web app may use
 *     a cookie OR `access_token` + `auth_key` request headers. Keep all of them
 *     private — never share or commit them. The script reads env vars only and
 *     never prints their values.
 *
 * Setup (one time, ~2 min in your browser):
 *   1. Log in at https://blinkit.com and open "My Orders".
 *   2. Open DevTools (F12) → Network tab → click an order / scroll the list.
 *   3. Find the request that returns your orders (look for "order" in the name).
 *      • Copy its full URL              → BLINKIT_ORDERS_URL
 *      • In Request Headers, use either `cookie` → BLINKIT_COOKIE, OR
 *        `access_token` + `auth_key` → BLINKIT_ACCESS_TOKEN + BLINKIT_AUTH_KEY
 *   4. Run:
 *        BLINKIT_ORDERS_URL='<url>' BLINKIT_ACCESS_TOKEN='<token>' BLINKIT_AUTH_KEY='<key>' \
 *          npx tsx scripts/blinkit-fetch.ts
 *
 * Pagination is followed automatically from response.pagination.next_url. For
 * older endpoint shapes, BLINKIT_PAGE_PARAM (e.g. "page" or "offset") remains
 * a fallback. Each discovered order/cart pair is then fetched through Blinkit's
 * full-detail endpoint, so the import includes every grocery item rather than
 * the 4–5 product names visible in a history tile.
 * If anything 401s, the session credential expired — repeat step 3.
 */
import { readFileSync, writeFileSync } from "fs";
import { findBlinkitOrderTargets, type BlinkitOrderTarget } from "../src/lib/imports/blinkit-json";

const URL_BASE = process.env.BLINKIT_ORDERS_URL;
const COOKIE = process.env.BLINKIT_COOKIE;
const ACCESS_TOKEN = process.env.BLINKIT_ACCESS_TOKEN;
const AUTH_KEY = process.env.BLINKIT_AUTH_KEY;
const CURL_FILE = process.env.BLINKIT_CURL_FILE;
const DEBUG = process.env.BLINKIT_DEBUG === "1";
const PAGE_PARAM = process.env.BLINKIT_PAGE_PARAM; // optional
const OUT = "blinkit-orders.json";
const DETAIL_BASE = "https://blinkit.com/v1/layout/order_details";

/** Read request headers from a locally saved DevTools "Copy as cURL" command.
 * The command is NEVER executed; this only reuses its current browser headers.
 */
type CurlRequestParts = { headers: Record<string, string>; method: string; body?: string };

function requestPartsFromCurlFile(file: string | undefined): CurlRequestParts {
  if (!file) return { headers: {}, method: "GET" };
  const raw = readFileSync(file, "utf8");
  const headers: Record<string, string> = {};
  const headerRe = /(?:^|\s)-H\s+(['"])(.*?)\1/gs;
  for (const match of raw.matchAll(headerRe)) {
    const colon = match[2].indexOf(":");
    if (colon <= 0) continue;
    headers[match[2].slice(0, colon).trim().toLowerCase()] = match[2].slice(colon + 1).trim();
  }
  if (Object.keys(headers).length === 0) throw new Error("No -H request headers found in BLINKIT_CURL_FILE. Use DevTools → Copy → Copy as cURL (bash).");
  const methodMatch = /(?:^|\s)(?:-X|--request)\s+['"]?([A-Z]+)['"]?/i.exec(raw);
  const bodyMatch = /(?:^|\s)(?:--data-raw|--data-binary|--data|-d)\s+(['"])(.*?)\1/s.exec(raw);
  const body = bodyMatch?.[2];
  // cURL makes any --data form a POST unless an explicit -X overrides it.
  return { headers, method: methodMatch?.[1].toUpperCase() ?? (body != null ? "POST" : "GET"), ...(body != null ? { body } : {}) };
}

async function main() {
  if (!URL_BASE || (!CURL_FILE && !COOKIE && !(ACCESS_TOKEN && AUTH_KEY))) {
    console.error("Set BLINKIT_ORDERS_URL plus BLINKIT_CURL_FILE, BLINKIT_COOKIE, or both BLINKIT_ACCESS_TOKEN and BLINKIT_AUTH_KEY (see the header of this file).");
    process.exit(1);
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  };
  if (COOKIE) headers.cookie = COOKIE;
  if (ACCESS_TOKEN) headers.access_token = ACCESS_TOKEN;
  if (AUTH_KEY) headers.auth_key = AUTH_KEY;
  let curlRequest: CurlRequestParts;
  try { curlRequest = requestPartsFromCurlFile(CURL_FILE); Object.assign(headers, curlRequest.headers); }
  catch (error) { console.error((error as Error).message); process.exit(1); }
  if (DEBUG) console.log(`Replaying ${curlRequest.method} with header names: ${Object.keys(headers).sort().join(", ")}`);

  const pages: unknown[] = [];
  const visited = new Set<string>();
  let url: string | null = URL_BASE;
  for (let p = 0; p < 50 && url && !visited.has(url); p++) {
    visited.add(url);
    const res: Response = await fetch(url, { headers, method: curlRequest!.method, ...(curlRequest!.body != null ? { body: curlRequest!.body } : {}) });
    if (!res.ok) {
      if (p === 0) { console.error(`Request failed: ${res.status} ${res.statusText}. Your Blinkit session headers were rejected or expired; recopy the current order-history request as cURL and retry.`); process.exit(1); }
      break; // ran past the last page
    }
    const json: unknown = await res.json();
    pages.push(json);
    const text = JSON.stringify(json);
    process.stdout.write(`  page ${p}: ${text.length} bytes\n`);
    const pagination: { response?: { pagination?: { next_url?: unknown } }; pagination?: { next_url?: unknown } } | null = json && typeof json === "object" && !Array.isArray(json)
      ? (json as { response?: { pagination?: { next_url?: unknown } }; pagination?: { next_url?: unknown } })
      : null;
    const nextUrl: unknown = pagination?.response?.pagination?.next_url ?? pagination?.pagination?.next_url;
    if (typeof nextUrl === "string" && nextUrl) {
      url = new URL(nextUrl, url).toString();
    } else if (PAGE_PARAM && text.length >= 50) {
      const fallback = new URL(URL_BASE);
      fallback.searchParams.set(PAGE_PARAM, String(p + 1));
      url = fallback.toString();
    } else {
      url = null;
    }
  }

  const targets = findBlinkitOrderTargets(pages);
  console.log(`Found ${targets.length} order/cart pair${targets.length === 1 ? "" : "s"} for full item detail.`);
  if (targets.length === 0) {
    console.warn("No order/cart pairs found in the history response. Save one history response and share its body so the extractor can be adjusted before importing.");
  }

  const details: unknown[] = [];
  let complete = 0;
  const queue = [...targets];
  // A small worker pool keeps a long history practical without overwhelming
  // Blinkit's endpoint. Individual failures are reported, never hidden.
  const worker = async () => {
    let target: BlinkitOrderTarget | undefined;
    while ((target = queue.shift())) {
      const detailUrl = `${DETAIL_BASE}/${encodeURIComponent(target.orderId)}?cart_id=${encodeURIComponent(target.cartId)}`;
      const response = await fetch(detailUrl, { headers });
      if (response.ok) { details.push(await response.json()); complete++; }
      else console.warn(`  detail ${target.orderId}: ${response.status} ${response.statusText}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
  if (targets.length) console.log(`Fetched full detail for ${complete}/${targets.length} orders.`);

  writeFileSync(OUT, JSON.stringify({ history: pages, details }, null, 2));
  console.log(`\nSaved ${pages.length} history page(s) + ${details.length} full baskets → ${OUT}`);
  console.log(`Next:  npx tsx scripts/import-blinkit.ts --file ${OUT}   (add --apply to write)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
