"use client";

import { useMemo, useState } from "react";
import { pairLabel, type CategoryPair } from "@/lib/category-taxonomy";
import { defaultRemember, defaultSelection, selectedTotal, type ApplyTxn } from "@/lib/merchant-apply";

export type ReviewTxn = ApplyTxn & { card_last4: string; notes?: string | null };

const fmt = (n: number) => (n < 0 ? "−" : "") + "₹" + Math.round(Math.abs(n)).toLocaleString("en-IN");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });

/**
 * Step 2 of categorizing: the other transactions from the same merchant,
 * each with a checkbox, so the user SEES exactly what will change and can
 * leave some out before saying yes.
 */
export default function MerchantApplyReview({
  labelId, merchant, pair, candidates, alreadyThere, cardLabel, onApply, onSkip, busy, error,
}: {
  labelId: string;
  merchant: string;
  pair: CategoryPair;
  candidates: ReviewTxn[];
  alreadyThere: number;
  cardLabel: (last4: string) => string;
  onApply: (ids: string[], remember: boolean) => void;
  onSkip: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(candidates));
  const [rememberChoice, setRememberChoice] = useState<boolean | null>(null); // null = follow the default
  const remember = rememberChoice ?? defaultRemember(candidates, selected);
  const total = useMemo(() => selectedTotal(candidates, selected), [candidates, selected]);
  const target = pairLabel(pair.category, pair.subcategory);
  const manualCount = candidates.filter((t) => t.category_manual === true).length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const allTicked = selected.size === candidates.length;
  const n = selected.size;

  return (
    <div className="cat-review">
      <header className="cat-picker-head">
        <div className="min-w-0">
          <p className="cat-saved" role="status"><span aria-hidden="true">✓</span> Saved this one as {target}</p>
          <h2 id={labelId} className="cat-title">
            {candidates.length} more from {merchant}
          </h2>
          <p className="cat-detail">
            Tick the ones that should also become <strong>{target}</strong>. Unticked ones stay as they are.
            {alreadyThere > 0 && <> {alreadyThere} {alreadyThere === 1 ? "is" : "are"} already {target}.</>}
          </p>
        </div>
        <button type="button" className="cat-close" aria-label="Close — keep just this one" onClick={onSkip}>×</button>
      </header>

      <div className="cat-review-bar">
        <label className="cat-review-all">
          <input
            type="checkbox"
            checked={allTicked}
            ref={(el) => { if (el) el.indeterminate = n > 0 && !allTicked; }}
            onChange={() => setSelected(allTicked ? new Set() : new Set(candidates.map((t) => t.id)))}
          />
          {allTicked ? "Untick all" : "Tick all"}
        </label>
        <span className="cat-review-count">{n} of {candidates.length} ticked · {fmt(total)}</span>
      </div>
      {manualCount > 0 && (
        <p className="cat-review-note">
          {manualCount} you categorized by hand {manualCount === 1 ? "starts" : "start"} unticked, so earlier choices aren&apos;t overwritten.
        </p>
      )}

      <ul className="cat-review-list" aria-label={`Other transactions from ${merchant}`}>
        {candidates.map((t) => {
          const checked = selected.has(t.id);
          return (
            <li key={t.id}>
              <label data-checked={checked || undefined}>
                <input type="checkbox" checked={checked} onChange={() => toggle(t.id)} />
                <span className="cat-review-date">{day(t.txn_at)}</span>
                <span className="cat-review-main">
                  <span className="cat-review-cat">
                    {pairLabel(t.category || "Uncategorized", t.subcategory)}
                    {t.category_manual === true && <span className="cat-tag">set by you</span>}
                  </span>
                  <span className="cat-review-meta">
                    {cardLabel(t.card_last4)}{t.notes ? <> · <em>{t.notes}</em></> : null}
                  </span>
                </span>
                <span className={`cat-review-amt${t.txn_type === "credit" ? " is-credit" : ""}`}>
                  {t.txn_type === "credit" ? "+" : ""}{fmt(t.amount_inr)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {error && <p className="cat-error" role="alert">{error}</p>}

      <footer className="cat-review-foot">
        <label className="cat-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRememberChoice(e.target.checked)} />
          <span>
            Also file <strong>future</strong> {merchant} transactions under {target}
            {!allTicked && rememberChoice === null && <small> — off because you left some out</small>}
          </span>
        </label>
        <div className="cat-review-actions">
          <button type="button" className="cat-btn" onClick={onSkip} disabled={busy}>Just this one</button>
          <button
            type="button"
            className="cat-btn cat-btn-primary"
            disabled={busy || (n === 0 && !remember)}
            onClick={() => onApply([...selected], remember)}
          >
            {busy ? "Saving…" : n > 0 ? `Apply to ${n}` : "Save rule only"}
          </button>
        </div>
      </footer>
    </div>
  );
}
