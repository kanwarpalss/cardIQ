export type LoginSmokeInput = {
  rawLoginUrl: string;
  canonicalLoginUrl: string;
  oauthAuthorizeUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const CLOUDFLARE_BLOCK_MARKERS = [
  "sorry, you have been blocked",
  "cloudflare ray id",
  "performance & security by cloudflare",
];

function isCloudflareBlock(body: string): boolean {
  const normalized = body.toLowerCase();
  return CLOUDFLARE_BLOCK_MARKERS.some((marker) => normalized.includes(marker));
}

function requireLocation(response: Response, label: string): URL {
  const location = response.headers.get("location");
  if (!location) throw new Error(`${label} did not include a Location header`);

  try {
    return new URL(location);
  } catch {
    throw new Error(`${label} returned a malformed Location header`);
  }
}

async function fetchManual(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  timeoutMs: number
): Promise<{ response: Response; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 256_000);
    if (isCloudflareBlock(body)) {
      throw new Error(`${label} reached a Cloudflare blocked page`);
    }
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exercise the complete unauthenticated login handoff without selecting a
 * Google account: raw Tailscale URL -> MagicDNS -> CardIQ -> Supabase -> Google.
 */
export async function runLoginSmoke({
  rawLoginUrl,
  canonicalLoginUrl,
  oauthAuthorizeUrl,
  fetchImpl = fetch,
  timeoutMs = 8_000,
}: LoginSmokeInput): Promise<void> {
  const raw = await fetchManual(fetchImpl, rawLoginUrl, "Raw CardIQ login", timeoutMs);
  if (raw.response.status !== 307) {
    throw new Error(
      `Raw CardIQ login returned HTTP ${raw.response.status}; expected canonical 307 redirect`
    );
  }

  const rawDestination = requireLocation(raw.response, "Raw CardIQ login");
  if (rawDestination.toString() !== canonicalLoginUrl) {
    throw new Error(
      `Raw CardIQ login redirected to ${rawDestination.toString()} instead of ${canonicalLoginUrl}`
    );
  }

  const canonical = await fetchManual(
    fetchImpl,
    canonicalLoginUrl,
    "Canonical CardIQ login",
    timeoutMs
  );
  if (canonical.response.status !== 200) {
    throw new Error(
      `Canonical CardIQ login returned HTTP ${canonical.response.status}; expected 200`
    );
  }
  if (!canonical.body.includes("<title>CardIQ</title>")) {
    throw new Error("Canonical CardIQ login was answered by the wrong application");
  }

  const oauth = await fetchManual(
    fetchImpl,
    oauthAuthorizeUrl,
    "Supabase OAuth authorize",
    timeoutMs
  );
  if (oauth.response.status !== 302) {
    throw new Error(
      `Supabase OAuth authorize returned HTTP ${oauth.response.status}; expected 302`
    );
  }

  const googleDestination = requireLocation(oauth.response, "Supabase OAuth authorize");
  if (
    googleDestination.protocol !== "https:" ||
    googleDestination.hostname !== "accounts.google.com"
  ) {
    throw new Error(
      `Supabase OAuth authorize did not hand off safely to accounts.google.com`
    );
  }
}
