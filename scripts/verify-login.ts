import { lookup } from "node:dns/promises";
import { config } from "dotenv";
import { CARDIQ_MAGICDNS_HOST } from "../src/lib/canonical-host";
import { runLoginSmoke } from "../src/lib/login-smoke";
import { requireSupabaseUrl } from "../src/lib/supabase/health";

async function main() {
  config({ path: ".env.local" });

  const port = 3901;
  const { address: tailscaleIpv4 } = await lookup(CARDIQ_MAGICDNS_HOST, {
    family: 4,
  });
  const rawLoginUrl = `http://${tailscaleIpv4}:${port}/login?smoke=1`;
  const canonicalLoginUrl = `http://${CARDIQ_MAGICDNS_HOST}:${port}/login?smoke=1`;
  const oauthAuthorizeUrl = new URL("/auth/v1/authorize", requireSupabaseUrl());
  oauthAuthorizeUrl.searchParams.set("provider", "google");
  oauthAuthorizeUrl.searchParams.set(
    "redirect_to",
    `http://${CARDIQ_MAGICDNS_HOST}:${port}/auth/callback`
  );

  await runLoginSmoke({
    rawLoginUrl,
    canonicalLoginUrl,
    oauthAuthorizeUrl: oauthAuthorizeUrl.toString(),
  });

  console.log(
    "CardIQ login is healthy: raw Tailscale links canonicalize, the login page is current, and Supabase hands OAuth to Google."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "CardIQ login check failed");
  process.exitCode = 1;
});
