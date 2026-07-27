# CardIQ — 2026-07-27: review, vouchers, login, and currency

## Outcome

- The Review queue is now limited to genuine order-to-card-charge pairs. An audit found 294 pending rows: 18 valid pairs and 276 rows without a usable charge. The 276 were returned to `unmatched`; nothing was deleted. The review API now excludes missing, orphaned, or cross-user transaction links. The repair tools are `scripts/audit-review-queue.ts` and dry-run-by-default `scripts/clean-review-queue.ts`.
- Birkenstock order `#525889` (16 July 2026) is recorded from exact evidence as ₹5,000 paid from a Birkenstock gift card bought with Amazon Pay and ₹793 charged directly to the card. Its previous inferred Luxe attribution was removed. Migrations 018 and 019 are applied; the voucher carries `funding_source = amazon_pay` and is kept distinct from card-funded voucher records.
- Amazon Pay gift-card issuance mail is now recognised from `Amazon Pay India <no-reply@amazonpay.in>` in the Gmail orders sync. The importer deliberately accepts only an unambiguous issue email; it does not infer a funding source from a lookalike message.
- The Google OAuth callback no longer silently bounces from `/auth/callback` to `/` and back to Login when session exchange fails. Login now displays a safe retry message. The production deployment for commit `48cf6b2` was Ready; full interactive Google consent remains something to check in KP's signed-in browser.
- The alarming 22 April 2026 `Magnus Burgundy ₹11,87,243` row was an Axis alert for `SGD .1` at UNIQLO CITY. The parser rejected the leading-decimal amount, then generic fallback mistook the email's available-credit-limit field for the transaction. The stored row is now SGD 0.10 with no INR equivalent. A database audit found no other emails declaring a non-INR transaction amount that were stored as INR.

## Engineering guardrails added

- Axis and generic bank-alert amount recognition now accept valid leading-decimal values such as `.1`.
- When an email provides a structured non-INR `Transaction Amount` that is malformed, fallback refuses to scan later account-balance/limit numbers.
- Zero and malformed transaction amounts are rejected. Regression coverage exercises the full strict-parser-plus-fallback path, explicit INR equivalents, zero, malformed input, and the original Axis email shape.

## Evidence and local commits

- Data repair was guarded by the affected transaction ID and Gmail message ID, then re-audited.
- Code checks completed before the final code commit: 459 Vitest cases, TypeScript, lint, and whitespace diff checks.
- Local commits after `origin/main` (`48cf6b2`) are `a7fcecf`, `e428f50`, `eab376d`, and `feab9de`. They are intentionally committed locally and were not pushed in this wrap-up.

## Follow-up

1. In KP's normal browser, complete one Google sign-in to confirm the consent/session path end-to-end.
2. Push the four local commits when KP explicitly wants these changes deployed.
3. For future foreign-currency alerts, treat a displayed account limit or available balance as structurally ineligible transaction evidence.
