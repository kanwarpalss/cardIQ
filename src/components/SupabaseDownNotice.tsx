"use client";

import { getDashboardUrl, getProjectRef } from "@/lib/supabase/health";

type Props = {
  /** Called when the user clicks "Try again". */
  onRetry?: () => void;
  /** Show a spinner / disable the retry button while re-checking. */
  retrying?: boolean;
};

/**
 * Friendly, themed notice shown when the Supabase backend can't be reached.
 *
 * Almost always means the free-tier project auto-paused after inactivity, so
 * we point the user straight at the restore button in the dashboard instead
 * of leaving them staring at a raw browser DNS error.
 */
export default function SupabaseDownNotice({ onRetry, retrying }: Props) {
  const ref = getProjectRef();
  const dashboardUrl = getDashboardUrl();

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-2xl border border-rim bg-surface shadow-card p-8 space-y-5"
    >
      {/* Icon + heading */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 shrink-0 rounded-xl bg-amber/15 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-amber"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div>
          <h1 className="text-mist font-medium text-base mb-1">
            Can&apos;t reach the database
          </h1>
          <p className="text-sm text-mist/50 leading-relaxed">
            CardIQ&apos;s Supabase backend isn&apos;t responding. On the free
            tier, projects automatically pause after about a week of
            inactivity — that&apos;s the usual culprit (not a bug in the app).
          </p>
        </div>
      </div>

      {/* Fix steps */}
      <ol className="text-sm text-mist/60 leading-relaxed space-y-1.5 list-decimal pl-5 marker:text-mist/55">
        <li>
          Open the{" "}
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold underline underline-offset-2 hover:opacity-80"
          >
            Supabase dashboard
          </a>
          .
        </li>
        <li>
          If the project{ref ? <> (<code className="text-mist/80">{ref}</code>)</> : ""} shows{" "}
          <span className="text-mist/80">Paused</span>, click{" "}
          <span className="text-mist/80">Restore</span> and wait a minute or two.
        </li>
        <li>Then come back and try again.</li>
      </ol>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={onRetry}
          disabled={retrying}
          className="flex-1 flex items-center justify-center gap-2 bg-gold-shimmer text-ink font-semibold py-2.5 rounded-xl shadow-glow-gold hover:opacity-90 transition-all disabled:opacity-60 disabled:cursor-wait"
        >
          {retrying ? (
            <>
              <svg
                className="w-4 h-4 animate-spin-slow"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Checking…
            </>
          ) : (
            "Try again"
          )}
        </button>
        <a
          href={dashboardUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-center border border-rim text-mist/80 font-medium py-2.5 rounded-xl hover:bg-hover transition-all"
        >
          Open dashboard
        </a>
      </div>

      <p className="text-2xs text-mist/55 text-center leading-relaxed">
        Tip: if you&apos;re on a corporate network/VPN that blocks Supabase, try
        a hotspot or guest WiFi.
      </p>
    </div>
  );
}
