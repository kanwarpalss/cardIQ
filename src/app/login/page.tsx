"use client";

import { useEffect, useState } from "react";
import { checkSupabaseReachable } from "@/lib/supabase/health";
import { canonicalCardiqUrl } from "@/lib/canonical-host";
import { Brand } from "@/components/AppNavigation";
import SupabaseDownNotice from "@/components/SupabaseDownNotice";

export default function LoginPage() {
  const [down, setDown] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // The proxy redirects here with ?error=connection when a server-side
  // Supabase call fails. Surface the friendly notice straight away.
  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("error");
    if (error === "connection") {
      setDown(true);
    } else if (error === "auth_missing_code") {
      setSignInError("Google did not return a sign-in code. Please try again.");
    } else if (error === "auth_callback") {
      setSignInError("Google sign-in could not finish. Please try again.");
    } else if (error === "auth_start") {
      setSignInError("Could not start Google sign-in. Please try again.");
    }
  }, []);

  async function signIn() {
    setSignInError(null);
    // Belt and suspenders: the proxy normally canonicalizes this before the
    // page renders. Re-check at the last possible moment so a future matcher
    // regression still cannot send a raw Tailscale IP to Supabase/Cloudflare.
    const canonicalUrl = canonicalCardiqUrl(new URL(window.location.href));
    if (canonicalUrl) {
      window.location.replace(canonicalUrl);
      return;
    }

    // Preflight: clicking the button redirects the browser AWAY to
    // <project>.supabase.co. If that host can't resolve (paused project),
    // the user lands on a raw browser DNS error with no way back. Catch it
    // here, while our app is still in control, and show a helpful notice.
    const reachable = await checkSupabaseReachable();
    if (!reachable) {
      setDown(true);
      return;
    }
    // The server sets the one-time PKCE cookie on the SAME response that
    // redirects to Google, so the callback cannot outrun a browser cookie write.
    window.location.assign(new URL("/auth/start", window.location.href).href);
  }

  async function retry() {
    setRetrying(true);
    const reachable = await checkSupabaseReachable();
    setRetrying(false);
    if (reachable) {
      setDown(false);
      // Clear the ?error param so a refresh doesn't re-trigger the notice.
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <Brand inverse />
        <div className="login-story-copy"><p className="eyebrow">THE PERKS OF KNOWING</p>
          <h1>Good cards.<br /><em>Great possibilities.</em></h1>
          <p>A clearer view of your spending.<br />A little more from your rewards.</p>
        </div>
        <div className="login-art" aria-hidden="true">
          <div className="art-card art-card-lilac"><span>THE POSSIBILITIES</span><i /><strong>Go a little further.</strong></div>
          <div className="art-card art-card-peach"><span>THE EVERYDAY</span><i /><strong>Make it count.</strong></div>
          <div className="art-card art-card-teal"><span>CardIQ</span><i /><strong>Well played.</strong><small>YOUR CARDS. ALL TOGETHER.</small></div>
        </div>
        <div className="login-story-footer">SPEND SMARTER <span>✳</span> REWARD YOURSELF</div>
      </section>
      <section className="login-form-side">
      <div className="w-full max-w-sm">
        {down ? (
          <SupabaseDownNotice onRetry={retry} retrying={retrying} />
        ) : (
        /* Card */
        <div className="login-form-card space-y-7">

          <div className="lg:hidden mb-10"><Brand /></div>
          {/* Copy */}
          <div>
            <p className="eyebrow mb-3">YOUR PERSONAL CARD COMPANION</p>
            <h2 className="font-serif text-4xl text-teal mb-4">Hello again.</h2>
            <p className="text-sm text-mist/70 leading-relaxed">
              Your spending, rewards, and next great deal. All your cards, beautifully in one place.
            </p>
          </div>

          {/* CTA */}
          <button
            onClick={signIn}
            className="w-full flex items-center justify-center gap-2.5 bg-white text-teal border border-rim font-medium py-3.5 rounded-xl shadow-card hover:bg-sage transition-all"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {signInError && (
            <p role="alert" className="text-xs text-ruby text-center leading-relaxed">
              {signInError}
            </p>
          )}

          {/* Fine print */}
          <p className="text-2xs text-mist/55 text-center leading-relaxed">
            Requires Gmail read-only access to parse credit card transaction alerts.
            Your data is stored in your private CardIQ account.
          </p>
        </div>
        )}
      </div>
      </section>
    </main>
  );
}
