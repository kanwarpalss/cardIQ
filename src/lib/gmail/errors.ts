// Gmail sync error → plain-English message. Shared by /api/gmail/sync and
// /api/gmail/orders/sync so both routes explain failures identically.
//
// Two DISTINCT failure modes must never be conflated (this exact conflation
// caused the recurring silent Gmail-permission bug, fixed 2026-07-10):
//   • invalid_grant/invalid_token — the refresh token expired or was revoked
//     (common for Google apps in "Testing" mode). Signing in again fixes it.
//   • insufficient scope — the token is valid but was never granted
//     gmail.readonly. Signing in again does NOT fix it, because Google
//     silently reuses the existing grant; the user must revoke CardIQ at
//     myaccount.google.com/permissions first. See /api/gmail/scope-check.

export function friendlyGmailSyncError(e: unknown): string {
  const err = e as Error & { code?: number; errors?: Array<{ reason?: string }> };
  const raw = err.message || String(e);

  const isScopeIssue =
    err.code === 403 ||
    /insufficient.*(scope|permission)/i.test(raw) ||
    err.errors?.some((er) => er.reason === "insufficientPermissions");

  if (isScopeIssue) {
    return "Gmail access is missing read permission, so sync can't fetch emails. Signing in again alone usually won't fix this — go to myaccount.google.com/permissions, remove CardIQ's access there, then sign in again to grant it fresh. (Check Cards → Gmail connection for a live status.)";
  }
  if (/invalid_grant|invalid_token|unauthorized|no refresh token/i.test(raw)) {
    return "Gmail access expired. Please sign out and sign in again to re-grant access.";
  }
  return raw;
}
