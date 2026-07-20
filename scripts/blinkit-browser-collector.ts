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
  const request = async (url, init = {}) => {
    const response = await fetch(url, { credentials: "include", headers: config.headers, ...init });
    if (!response.ok) throw new Error(url + " → " + response.status + " " + response.statusText);
    return response.json();
  };
  const history = [];
  const visited = new Set();
  let nextUrl = config.historyUrl;
  while (nextUrl && !visited.has(nextUrl) && history.length < 100) {
    visited.add(nextUrl);
    const page = await request(nextUrl, {
      method: config.method,
      ...(config.body != null ? { body: config.body } : {}),
    });
    history.push(page);
    const next = page?.response?.pagination?.next_url ?? page?.pagination?.next_url;
    nextUrl = typeof next === "string" && next ? new URL(next, nextUrl).toString() : null;
    console.log("Blinkit history pages:", history.length);
  }

  const targets = new Map();
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
      visit(value);
    }
  };
  visit(history);
  const queue = [...targets.values()];
  const details = [];
  const failures = [];
  const worker = async () => {
    let target;
    while ((target = queue.shift())) {
      const url = "https://blinkit.com/v1/layout/order_details/" + encodeURIComponent(target.orderId) + "?cart_id=" + encodeURIComponent(target.cartId);
      try { details.push(await request(url, { method: "GET" })); }
      catch (error) { failures.push({ orderId: target.orderId, error: String(error) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));

  const payload = { history, details, collection: { targets: targets.size, completed: details.length, failures } };
  const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = "blinkit-orders.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(blobUrl);
  console.log("Blinkit collection complete:", payload.collection, "Downloaded blinkit-orders.json");
})().catch((error) => console.error("Blinkit collection failed:", error));`;

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
