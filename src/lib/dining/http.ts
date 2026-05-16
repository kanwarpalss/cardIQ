// Polite HTTP client for dining scrapers.
//
// Centralises everything a scraper must NEVER skip:
//   - jittered delay between requests to the same host
//   - per-host single-flight (no parallel requests to same domain)
//   - real-browser User-Agent
//   - exponential backoff on 429
//   - hard abort on 403 / captcha HTML
//   - session-cookie injection
//   - structured result objects (status + body + headers + reason)
//
// Per L17: pure-ish (mockable fetch), so unit tests can exercise the
// backoff / abort policy without hitting the real network.

export interface FetchOptions {
  /** Encrypted-then-decrypted cookie header string, e.g. "sid=...; csrf=...". */
  cookieHeader?: string;
  /** Extra headers (Accept, x-platform-specific bits, etc.). */
  headers?: Record<string, string>;
  /** POST body, JSON-stringified. Defaults to GET when omitted. */
  body?: string;
  /** HTTP method. Inferred from body when not set. */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Per-call timeout in ms. Default 15s. */
  timeoutMs?: number;
}

export type FetchOutcome =
  | { kind: "ok"; status: number; body: string; headers: Headers }
  | { kind: "rate_limited"; status: number; retryAfterMs?: number }
  | { kind: "blocked"; status: number; reason: "captcha" | "forbidden" | "auth_required" }
  | { kind: "http_error"; status: number; body: string }
  | { kind: "network_error"; message: string };

/**
 * Per-host minimal politeness controller.
 *
 * - Tracks the time of the last completed request per host so we can
 *   honour a minimum gap (with jitter).
 * - Holds an in-flight Promise per host so concurrent callers serialise.
 */
class HostController {
  private lastFetchAt = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();

  /**
   * Wait until it's polite to make a request to `host`, then mark the
   * slot taken. Returns a release fn the caller MUST call when their
   * request finishes (success or failure).
   */
  async acquire(host: string, opts: PolicyOptions): Promise<() => void> {
    // Wait for any in-flight call to this host.
    while (this.inflight.has(host)) {
      await this.inflight.get(host);
    }

    // Now claim the slot.
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = () => {
        this.lastFetchAt.set(host, Date.now());
        this.inflight.delete(host);
        resolve();
      };
    });
    this.inflight.set(host, slot);

    // Honour minimum gap with jitter.
    const last = this.lastFetchAt.get(host) ?? 0;
    const minGap = randInt(opts.minDelayMs, opts.maxDelayMs);
    const elapsed = Date.now() - last;
    const wait = Math.max(0, minGap - elapsed);
    if (wait > 0) await sleep(wait);

    return release;
  }
}

export interface PolicyOptions {
  minDelayMs: number;   // jittered lower bound, default 500
  maxDelayMs: number;   // jittered upper bound, default 2000
  maxRetries: number;   // for 429, default 3
  userAgent: string;
}

const DEFAULT_POLICY: PolicyOptions = {
  minDelayMs: 500,
  maxDelayMs: 2000,
  maxRetries: 3,
  userAgent:
    // A real, current Chrome on Mac UA. Rotate monthly — see /docs.
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

// Shared singleton — all scrapers in one process share politeness state.
const controller = new HostController();

/**
 * The one entry point scrapers should ever call.
 *
 * Behaviour
 * ─────────
 * 1. Acquires the host slot (with jittered delay since last request).
 * 2. Injects cookie + UA + Accept.
 * 3. Fires the fetch with a timeout.
 * 4. Classifies the response:
 *      200–299 → `ok`
 *      401     → `blocked: auth_required` (caller surfaces re-auth banner)
 *      403     → `blocked: forbidden` (HARD ABORT — never bypass)
 *      429     → `rate_limited` with backoff suggestion; caller may retry
 *      else 4xx/5xx → `http_error`
 * 5. Captcha HTML in a 200 body → reclassifies as `blocked: captcha`.
 *
 * The caller is responsible for the retry LOOP — we just classify and
 * return. Keeps backoff policy testable in isolation.
 */
export async function diningFetch(
  url: string,
  opts: FetchOptions = {},
  policy: Partial<PolicyOptions> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> {
  const cfg = { ...DEFAULT_POLICY, ...policy };
  const host = safeHost(url);
  if (!host) return { kind: "network_error", message: `Invalid URL: ${url}` };

  const release = await controller.acquire(host, cfg);

  try {
    const controllerAbort = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const timer = setTimeout(() => controllerAbort.abort(), timeoutMs);

    const method = opts.method ?? (opts.body ? "POST" : "GET");
    const headers: Record<string, string> = {
      "User-Agent": cfg.userAgent,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      ...(opts.cookieHeader ? { "Cookie": opts.cookieHeader } : {}),
      ...(opts.headers ?? {}),
    };
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: opts.body,
        signal: controllerAbort.signal,
        redirect: "follow",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "network_error", message: msg };
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;

    if (status === 401) {
      return { kind: "blocked", status, reason: "auth_required" };
    }
    if (status === 403) {
      return { kind: "blocked", status, reason: "forbidden" };
    }
    if (status === 429) {
      const ra = res.headers.get("retry-after");
      const retryAfterMs = ra ? parseRetryAfter(ra) : undefined;
      return { kind: "rate_limited", status, retryAfterMs };
    }

    const body = await res.text();

    if (status >= 200 && status < 300) {
      if (looksLikeCaptcha(body)) {
        return { kind: "blocked", status, reason: "captcha" };
      }
      return { kind: "ok", status, body, headers: res.headers };
    }

    return { kind: "http_error", status, body };
  } finally {
    release();
  }
}

/**
 * Backoff retry loop. Wraps `diningFetch` and handles `rate_limited`
 * outcomes with exponential backoff. Surfaces every other outcome
 * unchanged. Caller still owns interpretation.
 */
export async function diningFetchWithBackoff(
  url: string,
  opts: FetchOptions = {},
  policy: Partial<PolicyOptions> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> {
  const cfg = { ...DEFAULT_POLICY, ...policy };
  let attempt = 0;
  let lastOutcome: FetchOutcome | null = null;

  while (attempt <= cfg.maxRetries) {
    const out = await diningFetch(url, opts, policy, fetchImpl);
    lastOutcome = out;

    if (out.kind === "rate_limited") {
      const backoff = out.retryAfterMs ?? 2_000 * Math.pow(2, attempt);
      await sleep(backoff);
      attempt++;
      continue;
    }
    return out;
  }
  // Out of retries — return the last 429 unchanged.
  return lastOutcome!;
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Parse Retry-After header (seconds OR HTTP-date) to ms. */
export function parseRetryAfter(value: string): number {
  const asInt = parseInt(value, 10);
  if (!isNaN(asInt) && String(asInt) === value.trim()) {
    return asInt * 1000;
  }
  const dt = Date.parse(value);
  if (!isNaN(dt)) {
    return Math.max(0, dt - Date.now());
  }
  return 2_000; // sensible default
}

/**
 * Best-effort captcha sniff. Looks for hallmark Cloudflare / Akamai
 * challenge markers in the response body. Conservative — we'd rather
 * false-negative (and let the parser fail loud) than false-positive.
 */
export function looksLikeCaptcha(body: string): boolean {
  if (!body) return false;
  if (body.length < 300) return false; // too short to be a challenge page
  const lower = body.slice(0, 4096).toLowerCase();
  return (
    lower.includes("cf-chl-bypass") ||
    lower.includes("cloudflare") && lower.includes("ray id") ||
    lower.includes("akamai") && lower.includes("reference #") ||
    lower.includes("captcha") && lower.includes("verify you are human") ||
    lower.includes("perimeterx") ||
    lower.includes("px-captcha")
  );
}
