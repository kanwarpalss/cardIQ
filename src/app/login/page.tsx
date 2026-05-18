"use client";

import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const supabase = createClient();

  async function signIn() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-ink relative overflow-hidden">
      {/* Subtle editorial texture — warm concentric rings */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full border border-gold/8" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full border border-gold/6" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[220px] h-[220px] rounded-full border border-gold/4" />
      </div>

      <div className="relative w-full max-w-sm mx-4">
        {/* Card */}
        <div className="rounded-2xl border border-rim bg-surface shadow-card p-8 space-y-7">

          {/* Logo + wordmark */}
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gold-shimmer flex items-center justify-center shadow-glow-gold">
              {/* Icon must stay dark — it lives on an amber gradient */}
              <svg className="w-5 h-5" style={{ color: "#1C1100" }} fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2.2}>
                <rect x="1" y="4" width="14" height="10" rx="2"/>
                <path d="M1 7h14" strokeLinecap="square"/>
                <circle cx="4.5" cy="11" r="1" fill="#1C1100" stroke="none"/>
              </svg>
            </div>
            <div>
              <div className="font-serif font-semibold text-xl text-gold tracking-tight">CardIQ</div>
              <div className="text-2xs text-mist/35 uppercase tracking-widest font-medium">Credit Intelligence</div>
            </div>
          </div>

          {/* Divider */}
          <hr className="wire" />

          {/* Copy */}
          <div>
            <h1 className="font-serif text-xl text-mist font-semibold mb-2">Welcome back, KP.</h1>
            <p className="text-sm text-mist/50 leading-relaxed">
              Your personal credit-card intelligence hub — spend tracking, dining deals, and reward optimization.
            </p>
          </div>

          {/* CTA */}
          <button
            onClick={signIn}
            className="w-full flex items-center justify-center gap-2.5 py-3 rounded-xl font-semibold text-sm
                       border border-rim bg-surface hover:bg-raised shadow-card hover:shadow-card-hover
                       text-mist transition-all"
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Fine print */}
          <p className="text-2xs text-mist/30 text-center leading-relaxed">
            Requires Gmail read-only access to parse credit card transaction alerts.
            Nothing leaves your account.
          </p>
        </div>
      </div>
    </main>
  );
}
