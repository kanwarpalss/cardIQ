// Decision logic for automatic background Gmail sync.
//
// KP's ask: "I want the app to be AS UPDATED as possible AUTOMATICALLY" —
// no hunting for a Sync button. The danger in granting that literally is the
// FIRST sync, which pulls 8 YEARS of mail (FIRST_SYNC_LOOKBACK_DAYS in
// api/gmail/sync/route.ts) and runs 20–30 minutes. Auto-firing that on app
// open would be a disaster, so the rules below never do it.
//
// Kept pure and UI-free so every rule is unit-tested; the component and the
// API route both defer to these functions rather than re-deriving "is it time
// to sync?" on their own (ARCH-04).

/** How stale the data must be before an app-open triggers a background sync. */
export const STALE_AFTER_MINUTES = 30;

/**
 * After a FAILED attempt, wait this long before trying again. Without it a
 * dead refresh token would retry on every mount and every window focus —
 * hammering Gmail and the UI with the same error.
 */
export const FAILURE_BACKOFF_MINUTES = 15;

export type SyncStatus = {
  /** Encrypted Google refresh token present in user_settings. */
  hasRefreshToken: boolean;
  /**
   * A forward cursor exists in gmail_sync_state. FALSE means the next sync is
   * the 8-year first sync — the thing we must never start without a click.
   */
  hasCursor: boolean;
  /** Wall-clock time of the last SUCCESSFUL sync (ISO), or null if never. */
  lastSyncedAt: string | null;
};

export type AutoSyncDecision =
  /** Run an incremental background sync now. */
  | { action: "sync"; reason: "stale"; minutesSince: number | null }
  /** Data is fresh enough — do nothing. */
  | { action: "skip"; reason: "fresh"; minutesSince: number }
  /**
   * First ever sync: 8 years of mail, 20–30 min. Show a one-click prompt.
   * NEVER auto-started — a silent half-hour job the user didn't ask for is
   * indistinguishable from the app being broken.
   */
  | { action: "prompt"; reason: "first_sync" }
  /** No Gmail connected (or the grant was removed) — nothing to sync from. */
  | { action: "blocked"; reason: "no_gmail" };

/** Whole minutes between two instants; negative clock skew clamps to 0. */
export function minutesBetween(fromIso: string, now: Date): number | null {
  const then = new Date(fromIso).getTime();
  if (!Number.isFinite(then)) return null; // unparseable timestamp — treat as unknown
  return Math.max(0, Math.floor((now.getTime() - then) / 60_000));
}

/**
 * The core rule set. Order matters: Gmail presence gates everything, then the
 * first-sync guard, and only then freshness.
 */
export function decideAutoSync(
  status: SyncStatus,
  now: Date = new Date(),
  staleAfterMinutes: number = STALE_AFTER_MINUTES
): AutoSyncDecision {
  if (!status.hasRefreshToken) return { action: "blocked", reason: "no_gmail" };

  // The 8-year job. Guarded BEFORE freshness, because a first-time user has
  // no lastSyncedAt and would otherwise read as maximally stale.
  if (!status.hasCursor) return { action: "prompt", reason: "first_sync" };

  // Cursor exists but no recorded success time (older schema, or the legacy
  // timestamp was cleared). Syncing is cheap and incremental here — do it.
  if (!status.lastSyncedAt) {
    return { action: "sync", reason: "stale", minutesSince: null };
  }

  const mins = minutesBetween(status.lastSyncedAt, now);
  // An unparseable timestamp must not silently mean "fresh forever".
  if (mins === null) return { action: "sync", reason: "stale", minutesSince: null };

  return mins >= staleAfterMinutes
    ? { action: "sync", reason: "stale", minutesSince: mins }
    : { action: "skip", reason: "fresh", minutesSince: mins };
}

/**
 * Client-side guard, separate from freshness: may we ATTEMPT a sync at all?
 *
 * A failed sync never advances lastSyncedAt, so `decideAutoSync` would keep
 * saying "stale" forever. This backs off after a failure so a dead token
 * produces one error every 15 minutes, not one per navigation.
 *
 * @param lastAttemptMs epoch ms of the last attempt that FAILED, or null
 */
export function mayAttemptAfterFailure(
  lastFailedAttemptMs: number | null,
  now: Date = new Date(),
  backoffMinutes: number = FAILURE_BACKOFF_MINUTES
): boolean {
  if (lastFailedAttemptMs === null) return true;
  if (!Number.isFinite(lastFailedAttemptMs)) return true; // corrupt storage — don't jam
  const elapsedMin = (now.getTime() - lastFailedAttemptMs) / 60_000;
  if (elapsedMin < 0) return true; // clock moved back / stale storage — allow
  return elapsedMin >= backoffMinutes;
}

/**
 * Is this error the one where re-signing-in is the actual fix?
 * Mirrors the invalid_grant branch of friendlyGmailSyncError, but as a
 * boolean so the UI can escalate a dead grant into a persistent banner
 * instead of a transient toast (EDGE-03 — never fail silently).
 */
export function isReauthRequired(message: string): boolean {
  return /invalid_grant|invalid_token|unauthorized|no refresh token|expired/i.test(message);
}
