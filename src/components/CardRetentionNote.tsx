import { HDFC_INFINIA } from "@/lib/cards/hdfc-infinia";

const TERMS_URL = `${HDFC_INFINIA.sources.retention}#page=18`;

/** A sourced condition, not an estimate of bank-qualified spend or a reward. */
export default function CardRetentionNote() {
  return <aside className="retention-note" aria-label="Infinia retention condition">
    <p className="eyebrow">KEEPING INFINIA</p>
    <h3>₹18 lakh <span>card spend / financial year</span></h3>
    <p className="retention-period">1 April–31 March · primary + add-ons</p>
    <div className="retention-alternative"><span>OR</span><p><strong>₹50 lakh</strong> relationship value</p></div>
    <details>
      <summary>How this works &amp; source</summary>
      <p>HDFC&apos;s retention condition applies from 1 April 2026. Relationship value is the combined average monthly balance in savings, current, fixed and recurring deposits. The ₹10 lakh renewal-fee waiver is a separate condition over the preceding 12 months.</p>
      <p>CardIQ does not have HDFC&apos;s qualifying-spend or relationship-value total, so this reference does not claim that retention is met.</p>
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">HDFC terms v4.18 · page 18 ↗</a>
      <small>Checked 10 November 2026</small>
    </details>
  </aside>;
}
