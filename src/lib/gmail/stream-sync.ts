// Shared NDJSON sync-stream reader.
//
// Extracted verbatim from SyncPanel (2026-08-22) when background auto-sync
// became a second caller. It is NOT duplicated, deliberately: the parse loop
// below encodes a real bug that was already fixed once — a fully-parsed
// message must be handled OUTSIDE the try, or a server-sent {status:"error"}
// gets swallowed by the parse-error catch and the UI hangs forever. A second
// hand-written copy would eventually lose that (ARCH-04).

export type SyncMessage = {
  status?: "listing" | "syncing" | "done" | "error";
  message?: string;
  [k: string]: unknown;
};

/**
 * POSTs to a sync endpoint and hands each parsed NDJSON message to onMsg.
 * Resolves with the final {status:"done"} payload; throws on HTTP errors or a
 * server-sent {status:"error"}.
 *
 * `lookbackDays` is the BACKFILL override. Omit it for an incremental sync —
 * the route then reads its saved cursor and fetches only what is new. Passing
 * a value on a first-ever sync is how the 8-year job gets started, so callers
 * that must never trigger it simply never pass one.
 */
export async function streamNdjson(
  url: string,
  lookbackDays: number | undefined,
  onMsg: (msg: SyncMessage) => void,
  signal?: AbortSignal
): Promise<SyncMessage> {
  const res = await fetch(url, {
    method: "POST",
    headers: lookbackDays ? { "Content-Type": "application/json" } : undefined,
    body: lookbackDays ? JSON.stringify({ lookback_days: lookbackDays }) : undefined,
    signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw new Error(errBody.message || errBody.error || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("Sync returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneMsg: SyncMessage | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // NDJSON can split mid-line across chunks → buffer the tail.
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      // Parse defensively: a half-received line is normal NDJSON behaviour and
      // should be ignored. But a fully-parsed message must be handled OUTSIDE
      // this try — otherwise a server-sent {status:"error"} would be swallowed
      // by the parse-error catch and the UI hangs forever.
      let msg: SyncMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // partial / non-JSON chunk — wait for the rest
      }
      if (msg.status === "error") throw new Error(msg.message || "Sync failed");
      if (msg.status === "done") doneMsg = msg;
      onMsg(msg);
    }
  }
  if (!doneMsg) throw new Error("Sync ended without a result");
  return doneMsg;
}

/**
 * The full two-pass sync, in the order that matters: bank transaction emails
 * FIRST, then order emails — orders match against transactions, so the
 * transactions must already be in the database.
 *
 * An orders-pass failure (e.g. migration 011 not run) is reported but does not
 * discard a successful bank pass.
 */
export async function runFullSync(
  lookbackDays: number | undefined,
  onProgress: (text: string) => void,
  signal?: AbortSignal
): Promise<{ newTxns: number; newOrders: number; matched: number; ordersError: string | null }> {
  const bank = await streamNdjson("/api/gmail/sync", lookbackDays, (msg) => {
    if (msg.status === "listing") {
      onProgress(msg.message || "Scanning Gmail…");
    } else if (msg.status === "syncing") {
      if (typeof msg.fetched === "number" && typeof msg.total === "number" && msg.total) {
        onProgress(`${Math.round((msg.fetched / msg.total) * 100)}% · ${msg.fetched}/${msg.total} emails`);
      } else if (msg.message) {
        onProgress(msg.message);
      }
    }
  }, signal);

  let newOrders = 0;
  let matched = 0;
  let ordersError: string | null = null;
  try {
    const orders = await streamNdjson("/api/gmail/orders/sync", lookbackDays, (msg) => {
      if (msg.message) onProgress(String(msg.message));
    }, signal);
    newOrders = Number(orders.new_orders ?? 0);
    matched = Number(orders.matched ?? 0);
  } catch (e) {
    ordersError = (e as Error).message;
  }

  return { newTxns: Number(bank.new_txns ?? 0), newOrders, matched, ordersError };
}
