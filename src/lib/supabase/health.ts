/**
 * Supabase reachability helpers.
 *
 * Why this exists: when the Supabase project is paused/deleted (free-tier
 * auto-pause after ~7 days idle) its `*.supabase.co` host stops resolving.
 * The browser then shows a raw "check if there is a typo in <host>" DNS
 * error the moment we redirect into the OAuth flow — at which point our app
 * JS is gone and a React error boundary can't help.
 *
 * The fix is a *preflight* check: ping the host BEFORE we navigate away, so
 * we can show a friendly in-app notice instead. Single source of truth for
 * both the login page and any future `npm run doctor` script.
 */

const SUPABASE_PROJECT_HOST = /^([a-z0-9]{20})\.supabase\.co$/;

/**
 * Public Supabase project URL, normalized to its origin.
 *
 * Fail closed on malformed values and lookalike hosts. A bare `supabase.co`,
 * an HTTP URL, credentials, a non-standard port, or an unexpected path is not
 * a CardIQ project endpoint and must never be used to start authentication.
 */
export function getSupabaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const isProjectHost = SUPABASE_PROJECT_HOST.test(url.hostname);
    const isRootPath = url.pathname === "/";

    if (
      url.protocol !== "https:" ||
      !isProjectHost ||
      url.username ||
      url.password ||
      url.port ||
      !isRootPath ||
      url.search ||
      url.hash
    ) {
      return "";
    }

    return url.origin;
  } catch {
    return "";
  }
}

/** Same validation as getSupabaseUrl(), but fail loudly for API callers. */
export function requireSupabaseUrl(): string {
  const url = getSupabaseUrl();
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be an HTTPS Supabase project URL such as https://yourprojectref.supabase.co"
    );
  }
  return url;
}

/**
 * The project ref is the first label of the Supabase hostname, e.g.
 * `https://abcd1234.supabase.co` → `abcd1234`. Returns "" if unparseable.
 */
export function getProjectRef(): string {
  const url = getSupabaseUrl();
  if (!url) return "";
  return new URL(url).hostname.match(SUPABASE_PROJECT_HOST)?.[1] ?? "";
}

/** Dashboard URL for the configured project (or the dashboard root). */
export function getDashboardUrl(): string {
  const ref = getProjectRef();
  return ref
    ? `https://supabase.com/dashboard/project/${ref}`
    : "https://supabase.com/dashboard";
}

/**
 * Returns true if the Supabase host is reachable, false otherwise.
 *
 * Uses `mode: "no-cors"` deliberately: we don't care about the response body
 * or status, only whether the TCP/DNS connection succeeds. A resolving host
 * yields an opaque response (no throw); only a genuine DNS/connection failure
 * throws — which avoids CORS false-positives that a normal fetch would hit.
 *
 * A short timeout keeps the UI snappy if the host hangs instead of failing.
 */
export async function checkSupabaseReachable(timeoutMs = 6000): Promise<boolean> {
  const url = getSupabaseUrl();
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(`${url}/auth/v1/health`, {
      mode: "no-cors",
      signal: controller.signal,
      cache: "no-store",
    });
    return true; // host resolved & connected (opaque response is fine)
  } catch {
    return false; // DNS failure, connection refused, or timeout
  } finally {
    clearTimeout(timer);
  }
}
