/**
 * Build a credential-bearing collector for the authenticated blinkit.com tab.
 * Blinkit rejects the same valid request outside the browser, so the collector
 * runs in DevTools Console and downloads one import-ready JSON file.
 *
 * Usage:
 *   BLINKIT_CURL_FILE=/private/tmp/blinkit-order-history.curl \
 *     npx tsx scripts/blinkit-browser-collector.ts
 *
 * The generated code is copied directly to the macOS clipboard. Credential
 * values are never printed and no additional credential file is created.
 */
import { readFileSync } from "fs";
import { spawnSync } from "child_process";

const curlFile = process.env.BLINKIT_CURL_FILE;
if (!curlFile) {
  console.error("Set BLINKIT_CURL_FILE to the locally saved Copy-as-cURL file.");
  process.exit(1);
}

const raw = readFileSync(curlFile, "utf8");
const curlUrl = /\bcurl\s+(['"])(https?:\/\/[^'"]+)\1/.exec(raw)?.[2];
if (!curlUrl) {
  console.error("Could not find the request URL in BLINKIT_CURL_FILE.");
  process.exit(1);
}

const headers: Record<string, string> = {};
const headerRe = /(?:^|\s)-H\s+(['"])(.*?)\1/gs;
for (const match of raw.matchAll(headerRe)) {
  const colon = match[2].indexOf(":");
  if (colon <= 0) continue;
  const name = match[2].slice(0, colon).trim().toLowerCase();
  const value = match[2].slice(colon + 1).trim();
  // The browser owns these headers and refuses/rewrites them for fetch().
  if (["content-length", "host", "connection", "origin", "referer", "user-agent", "accept-encoding", "priority", "cookie"].includes(name)) continue;
  if (name.startsWith("sec-")) continue;
  headers[name] = value;
}
const method = /(?:^|\s)(?:-X|--request)\s+['"]?([A-Z]+)['"]?/i.exec(raw)?.[1]?.toUpperCase() ?? "GET";
const bodyMatch = /(?:^|\s)(?:--data-raw|--data-binary|--data|-d)\s+\$?(['"])(.*?)\1/s.exec(raw);
const body = bodyMatch?.[2];

const config = JSON.stringify({ historyUrl: curlUrl, headers, method, body });
const script = `void (async () => {
  const config = ${config};
  if (location.hostname !== "blinkit.com") throw new Error("Open blinkit.com before running this collector.");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 429 = rate limited, 5xx = Blinkit's gateway hiccuping. Both are worth
  // waiting out; a 4xx like 401/404 is not and must fail fast.
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  // Adaptive gap between detail requests. Every 429 nudges it up so the run
  // self-tunes below Blinkit's unknown rate limit instead of hammering it.
  let throttleMs = 350;
  const request = async (url, init = {}, maxAttempts = 6) => {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response;
      try {
        response = await fetch(url, { credentials: "include", headers: config.headers, ...init });
      } catch (networkError) {
        lastError = networkError;
        await sleep(Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 400);
        continue;
      }
      if (response.ok) return await response.json();
      lastError = new Error(url + " → " + response.status + " " + response.statusText);
      if (!RETRYABLE.has(response.status)) throw lastError;
      if (response.status === 429) throttleMs = Math.min(throttleMs + 400, 3000);
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 400;
      console.log("Blinkit backoff:", response.status, "waiting " + Math.round(backoff) + "ms (attempt " + (attempt + 1) + "/" + maxAttempts + ")");
      await sleep(backoff);
    }
    throw lastError;
  };

  const history = [];
  const targets = new Map();
  const details = [];
  const failures = [];

  try {
    const visited = new Set();
    let nextUrl = config.historyUrl;
    while (nextUrl && !visited.has(nextUrl) && history.length < 100) {
      visited.add(nextUrl);
      let page;
      try {
        page = await request(nextUrl, {
          method: config.method,
          ...(config.body != null ? { body: config.body } : {}),
        });
      } catch (error) {
        console.warn("Blinkit history page failed after retries, stopping pagination early with what we have:", error);
        break;
      }
      history.push(page);
      const next = page?.response?.pagination?.next_url ?? page?.pagination?.next_url;
      nextUrl = typeof next === "string" && next ? new URL(next, nextUrl).toString() : null;
      console.log("Blinkit history pages:", history.length);
    }

    const seen = new Set();
    const add = (orderId, cartId) => {
      if (orderId != null && cartId != null) targets.set(String(orderId) + ":" + String(cartId), { orderId: String(orderId), cartId: String(cartId) });
    };
    const visit = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(visit); return; }
      add(node.order_id, node.cart_id);
      for (const value of Object.values(node)) {
        if (typeof value === "string" && value.includes("v1/layout/order_details/")) {
          try {
            const url = new URL(value, "https://blinkit.com");
            const match = /\\/v1\\/layout\\/order_details\\/([^/?#]+)/.exec(url.pathname);
            if (match) add(decodeURIComponent(match[1]), url.searchParams.get("cart_id"));
          } catch {}
        }
        if (typeof value === "string" && value.includes("order_id=") && value.includes("cart_id=")) {
          try {
            const url = new URL(value);
            add(url.searchParams.get("order_id"), url.searchParams.get("cart_id"));
          } catch {}
        }
        visit(value);
      }
    };
    visit(history);

    // One request at a time with an adaptive gap between them. Blinkit
    // rate-limits bursts (429) hard; a single serial worker that pauses
    // ~throttleMs between calls is what actually gets through. Any order that
    // still fails after all retries is left to the importer, which falls back
    // to its history-card items — a failure here loses richness, not the order.
    const queue = [...targets.values()];
    const total = queue.length;
    let processed = 0;
    for (const target of queue) {
      const url = "https://blinkit.com/v1/layout/order_details/" + encodeURIComponent(target.orderId) + "?cart_id=" + encodeURIComponent(target.cartId);
      try { details.push(await request(url, { method: "POST" })); }
      catch (error) { failures.push({ orderId: target.orderId, error: String(error) }); }
      processed++;
      if (processed % 10 === 0 || processed === total) {
        console.log("Blinkit order details:", processed + "/" + total, "— " + failures.length + " failed, gap now " + throttleMs + "ms");
      }
      await sleep(throttleMs);
    }
  } catch (error) {
    console.error("Blinkit collection hit an unexpected error, downloading whatever was collected so far:", error);
  } finally {
    const payload = { history, details, collection: { targets: targets.size, completed: details.length, failures } };
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = "blinkit-orders.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    console.log("Blinkit collection finished:", payload.collection, "Downloaded blinkit-orders.json");
  }
})();`;

// Parse-check before touching the clipboard.
new Function(script);
if (process.env.BLINKIT_VALIDATE_ONLY === "1") {
  console.log("Blinkit browser collector generated successfully.");
  process.exit(0);
}
const copied = spawnSync("pbcopy", [], { input: script, encoding: "utf8" });
if (copied.status !== 0) {
  console.error("Could not copy the collector to the macOS clipboard.");
  process.exit(1);
}
console.log("Collector copied to clipboard. Paste it into the DevTools Console on blinkit.com and press Return.");
