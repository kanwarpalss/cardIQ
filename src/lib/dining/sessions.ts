// Session token storage for the three dining platforms.
//
// Tokens are obtained interactively via scripts/dining-login.ts, stored
// encrypted-at-rest in the dining_sessions Supabase table (one row per
// (user_id, platform) pair), and read back here for every scraper run.
//
// Per the build plan (§3 of DINING_BUILD_PLAN.md): NO silent token
// refresh. If a session is missing/expired, the scraper aborts and a
// banner asks KP to re-run the login CLI. ~2 min of his time, ~once
// every 30–90 days.

import { encrypt, decrypt } from "@/lib/crypto";
import { createClient } from "@supabase/supabase-js";

export type Platform = "zomato" | "swiggy" | "eazydiner";

export const PLATFORMS: Platform[] = ["zomato", "swiggy", "eazydiner"];

export interface SessionPayload {
  /** Cookie header value, e.g. "sid=abc; csrf=xyz". */
  cookieHeader: string;
  /** Optional bearer token if the platform uses one (Swiggy Dineout does). */
  bearerToken?: string;
  /** Captured at login time, for debugging stale sessions. */
  capturedAt: string;
  /** Any extra platform-specific headers worth preserving (x-csrf-token, etc.). */
  extraHeaders?: Record<string, string>;
}

export interface SessionRow {
  platform: Platform;
  payload: SessionPayload;
  expiresAt: string | null;
  lastValidatedAt: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Service-role Supabase client.
//
// The scraper runs from KP's Mac mini (not browser), so we can use the
// service-role key and bypass RLS. Env vars come from .env.local just
// like the rest of CardIQ.
// ────────────────────────────────────────────────────────────────────

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set (needed by scripts only)");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Persist a freshly-captured session, encrypted.
 *
 * Upserts on (user_id, platform) so re-running the login CLI overwrites
 * the previous session cleanly.
 */
export async function saveSession(
  userId: string,
  platform: Platform,
  payload: SessionPayload,
  expiresAt: Date | null = null,
): Promise<void> {
  const supabase = serviceClient();
  const encrypted = encrypt(JSON.stringify(payload));
  const { error } = await supabase
    .from("dining_sessions")
    .upsert(
      {
        user_id: userId,
        platform,
        encrypted_token: encrypted,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        last_validated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform" },
    );
  if (error) throw new Error(`saveSession failed for ${platform}: ${error.message}`);
}

/**
 * Load and decrypt the stored session for a platform. Returns null if
 * no row exists (i.e. KP hasn't logged in for that platform yet).
 */
export async function loadSession(userId: string, platform: Platform): Promise<SessionRow | null> {
  const supabase = serviceClient();
  const { data, error } = await supabase
    .from("dining_sessions")
    .select("platform, encrypted_token, expires_at, last_validated_at")
    .eq("user_id", userId)
    .eq("platform", platform)
    .maybeSingle();
  if (error) throw new Error(`loadSession failed for ${platform}: ${error.message}`);
  if (!data) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decrypt(data.encrypted_token));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Decryption failed for ${platform} session (ENCRYPTION_KEY rotated?): ${msg}`);
  }

  return {
    platform: data.platform as Platform,
    payload,
    expiresAt: data.expires_at,
    lastValidatedAt: data.last_validated_at,
  };
}

/**
 * Mark a session as validated NOW. Called by scrapers after a
 * successful auth-required probe (cheap /me-equivalent call).
 */
export async function touchValidated(userId: string, platform: Platform): Promise<void> {
  const supabase = serviceClient();
  const { error } = await supabase
    .from("dining_sessions")
    .update({ last_validated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("platform", platform);
  if (error) throw new Error(`touchValidated failed for ${platform}: ${error.message}`);
}

/** Drop a session entirely (e.g. after a confirmed auth_required outcome). */
export async function clearSession(userId: string, platform: Platform): Promise<void> {
  const supabase = serviceClient();
  const { error } = await supabase
    .from("dining_sessions")
    .delete()
    .eq("user_id", userId)
    .eq("platform", platform);
  if (error) throw new Error(`clearSession failed for ${platform}: ${error.message}`);
}
