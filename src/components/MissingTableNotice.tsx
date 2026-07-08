// Shown when a query hits a table that doesn't exist yet — i.e. migration 009
// hasn't been run in the Supabase SQL Editor. Plain-English, self-healing:
// disappears on its own once the migration is applied.
export default function MissingTableNotice({ feature }: { feature: string }) {
  return (
    <div className="rounded-2xl border border-amber/40 bg-amber/5 p-5 text-sm leading-relaxed">
      <div className="flex items-center gap-2 font-semibold text-amber mb-1.5">
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.6}>
          <path d="M8 5.5v3.5M8 11.5v.01M2.9 13h10.2a1 1 0 0 0 .87-1.5l-5.1-9a1 1 0 0 0-1.74 0l-5.1 9A1 1 0 0 0 2.9 13z" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        One-time setup needed for {feature}
      </div>
      <p className="text-mist/75">
        The database table for this section doesn&apos;t exist yet. Open your Supabase
        project → <span className="text-mist font-medium">SQL Editor</span>, paste the contents of{" "}
        <code className="text-amber/90 bg-ink px-1.5 py-0.5 rounded text-xs">
          supabase/migrations/009_rewards_offers_loyalty.sql
        </code>{" "}
        and click <span className="text-mist font-medium">Run</span>. This page will work
        immediately after — no redeploy needed.
      </p>
    </div>
  );
}
