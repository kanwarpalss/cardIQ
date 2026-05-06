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
    <main className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-sm border border-line bg-panel p-8 rounded-lg">
        <h1 className="font-serif text-3xl text-gold mb-2">CardIQ</h1>
        <p className="text-sm opacity-70 mb-6">
          Personal credit-card research, deal tracking, and spend optimization.
        </p>
        <button
          onClick={signIn}
          className="w-full bg-gold text-ink font-medium py-2 rounded hover:opacity-90"
        >
          Continue with Google
        </button>
        <p className="text-xs opacity-50 mt-4">
          Requires Gmail read access to parse credit-card transaction alerts.
        </p>
      </div>
    </main>
  );
}
