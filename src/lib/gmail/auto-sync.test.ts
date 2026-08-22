import { describe, it, expect } from "vitest";
import {
  decideAutoSync,
  mayAttemptAfterFailure,
  minutesBetween,
  isReauthRequired,
  STALE_AFTER_MINUTES,
  type SyncStatus,
} from "./auto-sync";

const NOW = new Date("2026-08-22T12:00:00.000Z");

/** ISO timestamp n minutes before NOW. */
const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  hasRefreshToken: true,
  hasCursor: true,
  lastSyncedAt: minsAgo(5),
  ...over,
});

// ── The first-sync guard — the rule that must never regress ─────────────────

describe("decideAutoSync — first-sync guard", () => {
  it("NEVER auto-starts the 8-year first sync; it prompts instead", () => {
    // Auto-firing a 20–30 minute job on app open is the one genuinely
    // dangerous outcome here. It must prompt no matter how stale things look.
    const d = decideAutoSync(status({ hasCursor: false, lastSyncedAt: null }), NOW);
    expect(d.action).toBe("prompt");
    expect(d.reason).toBe("first_sync");
  });

  it("still prompts (never syncs) even when a stale timestamp exists without a cursor", () => {
    // A cursor-less account with an ancient last_gmail_sync_at would read as
    // maximally stale — the guard must win over freshness.
    const d = decideAutoSync(
      status({ hasCursor: false, lastSyncedAt: minsAgo(60 * 24 * 365) }), NOW
    );
    expect(d.action).toBe("prompt");
  });
});

// ── Gmail presence gates everything ─────────────────────────────────────────

describe("decideAutoSync — no Gmail connected", () => {
  it("is blocked without a refresh token, even with a cursor and stale data", () => {
    const d = decideAutoSync(
      status({ hasRefreshToken: false, lastSyncedAt: minsAgo(9999) }), NOW
    );
    expect(d).toEqual({ action: "blocked", reason: "no_gmail" });
  });

  it("checks the token BEFORE the first-sync prompt — no Gmail beats no cursor", () => {
    const d = decideAutoSync(
      status({ hasRefreshToken: false, hasCursor: false, lastSyncedAt: null }), NOW
    );
    expect(d.reason).toBe("no_gmail");
  });
});

// ── Freshness boundaries ────────────────────────────────────────────────────

describe("decideAutoSync — freshness", () => {
  it("skips when the last sync is recent", () => {
    const d = decideAutoSync(status({ lastSyncedAt: minsAgo(5) }), NOW);
    expect(d).toEqual({ action: "skip", reason: "fresh", minutesSince: 5 });
  });

  it("syncs at exactly the threshold, skips one minute under it", () => {
    expect(decideAutoSync(status({ lastSyncedAt: minsAgo(STALE_AFTER_MINUTES) }), NOW).action)
      .toBe("sync");
    expect(decideAutoSync(status({ lastSyncedAt: minsAgo(STALE_AFTER_MINUTES - 1) }), NOW).action)
      .toBe("skip");
  });

  it("syncs when a cursor exists but no success has ever been recorded", () => {
    const d = decideAutoSync(status({ lastSyncedAt: null }), NOW);
    expect(d).toEqual({ action: "sync", reason: "stale", minutesSince: null });
  });

  it("syncs rather than assuming fresh when the timestamp is unparseable", () => {
    // Silent "fresh forever" on corrupt data would stop all auto-syncing with
    // no visible symptom — the worst possible failure here.
    const d = decideAutoSync(status({ lastSyncedAt: "not-a-date" }), NOW);
    expect(d.action).toBe("sync");
  });

  it("treats a future timestamp (clock skew) as fresh, not as a negative age", () => {
    const future = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    const d = decideAutoSync(status({ lastSyncedAt: future }), NOW);
    expect(d).toEqual({ action: "skip", reason: "fresh", minutesSince: 0 });
  });

  it("honours a custom threshold", () => {
    expect(decideAutoSync(status({ lastSyncedAt: minsAgo(10) }), NOW, 5).action).toBe("sync");
    expect(decideAutoSync(status({ lastSyncedAt: minsAgo(10) }), NOW, 60).action).toBe("skip");
  });
});

// ── minutesBetween ──────────────────────────────────────────────────────────

describe("minutesBetween", () => {
  it("floors partial minutes", () => {
    expect(minutesBetween(new Date(NOW.getTime() - 119_000).toISOString(), NOW)).toBe(1);
  });

  it("clamps negative (future) ages to zero", () => {
    expect(minutesBetween(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(0);
  });

  it("returns null for garbage rather than NaN", () => {
    expect(minutesBetween("", NOW)).toBeNull();
    expect(minutesBetween("tomorrow", NOW)).toBeNull();
  });
});

// ── Failure backoff ─────────────────────────────────────────────────────────

describe("mayAttemptAfterFailure", () => {
  it("allows the first attempt when nothing has failed yet", () => {
    expect(mayAttemptAfterFailure(null, NOW)).toBe(true);
  });

  it("blocks a retry immediately after a failure", () => {
    expect(mayAttemptAfterFailure(NOW.getTime() - 60_000, NOW)).toBe(false);
  });

  it("allows a retry once the backoff has elapsed", () => {
    expect(mayAttemptAfterFailure(NOW.getTime() - 16 * 60_000, NOW)).toBe(true);
  });

  it("does not jam permanently on corrupt stored values", () => {
    // localStorage is user-writable and survives forever — a NaN in there must
    // not disable auto-sync for good.
    expect(mayAttemptAfterFailure(NaN, NOW)).toBe(true);
    expect(mayAttemptAfterFailure(Number.POSITIVE_INFINITY, NOW)).toBe(true);
  });

  it("does not jam when the clock moves backwards", () => {
    expect(mayAttemptAfterFailure(NOW.getTime() + 60 * 60_000, NOW)).toBe(true);
  });
});

// ── Re-auth detection ───────────────────────────────────────────────────────

describe("isReauthRequired", () => {
  it("recognises the real Google dead-grant messages", () => {
    expect(isReauthRequired("invalid_grant")).toBe(true);
    expect(isReauthRequired("Gmail access expired. Please sign out and sign in again.")).toBe(true);
    expect(isReauthRequired("No refresh token")).toBe(true);
  });

  it("does not flag a transient network failure as a dead grant", () => {
    // Escalating a blip into "your Gmail is disconnected" trains the user to
    // ignore the banner.
    expect(isReauthRequired("fetch failed")).toBe(false);
    expect(isReauthRequired("HTTP 503")).toBe(false);
  });
});
