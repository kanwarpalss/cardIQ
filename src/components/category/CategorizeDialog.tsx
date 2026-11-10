"use client";

import { useId, useState } from "react";
import { pairLabel, type CategoryPair, type CreateSuggestion, type Taxonomy } from "@/lib/category-taxonomy";
import { applyCandidates } from "@/lib/merchant-apply";
import Sheet from "./Sheet";
import CategoryPicker from "./CategoryPicker";
import MerchantApplyReview, { type ReviewTxn } from "./MerchantApplyReview";

const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/**
 * Categorize one transaction, then (if the merchant has others) review them:
 *   1. pick — whole tree on one screen; picking saves THIS transaction
 *   2. review — the merchant's other transactions with checkboxes
 * Closing at step 2 keeps just the one change.
 */
export default function CategorizeDialog({
  txn, allTransactions, taxonomy, cardLabel, onSaveOne, onSaveMany, onCreate, onManage, onDone,
}: {
  txn: ReviewTxn | null;
  allTransactions: readonly ReviewTxn[];
  taxonomy: Taxonomy;
  cardLabel: (last4: string) => string;
  onSaveOne: (txnId: string, pair: CategoryPair) => Promise<void>;
  onSaveMany: (ids: string[], pair: CategoryPair, rememberMerchant: string | null) => Promise<{ updated: number; remembered: boolean }>;
  onCreate: (s: CreateSuggestion) => Promise<CategoryPair | null>;
  onManage: () => void;
  /** Closed; `message` = what changed, for the table's confirmation line. */
  onDone: (message?: string) => void;
}) {
  const labelId = useId();
  const [step, setStep] = useState<{ pair: CategoryPair; candidates: ReviewTxn[]; alreadyThere: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(message?: string) {
    setStep(null);
    setError(null);
    setBusy(false);
    onDone(message);
  }

  async function pick(pair: CategoryPair) {
    if (!txn) return;
    setBusy(true);
    setError(null);
    try {
      await onSaveOne(txn.id, pair);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      setBusy(false);
      return;
    }
    setBusy(false);
    const label = pairLabel(pair.category, pair.subcategory);
    const { candidates, alreadyThere } = applyCandidates(allTransactions, txn, pair);
    if (candidates.length === 0) { close(`${txn.merchant ?? "Transaction"} → ${label}`); return; }
    setStep({ pair, candidates, alreadyThere });
  }

  async function apply(ids: string[], remember: boolean) {
    if (!txn || !step) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onSaveMany(ids, step.pair, remember ? txn.merchant : null);
      const label = pairLabel(step.pair.category, step.pair.subcategory);
      close(`${res.updated + 1} ${txn.merchant} transaction${res.updated === 0 ? "" : "s"} → ${label}${res.remembered ? " · future ones too" : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      setBusy(false);
    }
  }

  const open = txn !== null;
  const detail = txn
    ? [fmt(txn.amount_inr), new Date(txn.txn_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }), cardLabel(txn.card_last4)].join(" · ")
    : undefined;

  return (
    <Sheet open={open} onClose={() => close(step ? `${txn?.merchant} → ${pairLabel(step.pair.category, step.pair.subcategory)}` : undefined)} labelledBy={labelId} wide>
      {txn && !step && (
        <CategoryPicker
          labelId={labelId}
          taxonomy={taxonomy}
          current={{ category: txn.category || "Uncategorized", subcategory: txn.subcategory ?? null }}
          heading={`Categorize ${txn.merchant ?? "transaction"}`}
          detail={detail}
          onPick={pick}
          onCreate={onCreate}
          onManage={() => { close(); onManage(); }}
          onCancel={() => close()}
          busy={busy}
          error={error}
        />
      )}
      {txn && step && (
        <MerchantApplyReview
          labelId={labelId}
          merchant={txn.merchant ?? ""}
          pair={step.pair}
          candidates={step.candidates}
          alreadyThere={step.alreadyThere}
          cardLabel={cardLabel}
          onApply={apply}
          onSkip={() => close(`${txn.merchant} → ${pairLabel(step.pair.category, step.pair.subcategory)}`)}
          busy={busy}
          error={error}
        />
      )}
    </Sheet>
  );
}
