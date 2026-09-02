/**
 * Keep OAuth failures on the login screen instead of sending the visitor
 * straight back to `/`, where the proxy redirects them to `/login` with no
 * explanation. Reasons are intentionally short and non-sensitive because
 * they are included in the URL.
 */
export function loginRedirectForAuthCallback(input: {
  hasCode: boolean;
  exchangeError?: unknown;
  hasSession?: boolean;
  hasUser?: boolean;
}): string {
  if (!input.hasCode) return "/login?error=auth_missing_code";
  if (input.exchangeError || !input.hasSession || !input.hasUser) {
    return "/login?error=auth_callback";
  }
  return "/";
}
