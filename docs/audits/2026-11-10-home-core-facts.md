# Home — core card facts and compact wallet

**Agent:** Codex · **Date:** 10 November 2026

KP requested removal of random-looking milestones and anniversary-year clutter, factual core conditions and a denser Home layout. Personal fee arrangements override a product's standard waiver threshold; product defaults must not become a personal target.

## Fact check and resulting design

- [HDFC MITC v4.18, updated 31 October 2026, page 18](https://www.hdfc.bank.in/content/dam/hdfcbankpws/in/en/personal-banking/discover-products/cards/credit-cards/personal-mitc/mitc-in-english.pdf#page=18) specifies Infinia continuity from April 2026: ₹18 lakh primary-plus-add-on spend per April–March financial year **or** ₹50 lakh relationship value. The compact reference shows both alternatives and puts the definition/source behind a disclosure.
- [HDFC's Infinia product page](https://www.hdfc.bank.in/credit-cards/infinia-credit-card) separately states a ₹10 lakh renewal-fee waiver over the preceding 12 months. The old registry comment/default conflated that with the April–March retention period; that default is removed. The standard fee threshold remains reference data.
- [Axis's fee sheet](https://www.axis.bank.in/docs/default-source/credit-cards/terms-and-conditions/sosc-credit-cards.pdf) distinguishes lifetime-free or individually priced accounts from standard fees. A general product fee-waiver threshold therefore cannot establish a personal spend requirement.

Home now shows recorded monthly purchases, refunds separately, card count and compact wallet rows. Each row preserves issuer artwork, name, last four, amount and its card-specific Spend action. All cards are visible together instead of being hidden behind a phone carousel. Generic monthly/annual milestone bars, “reached”/“to go” claims and estimated reward earnings are removed. Saved reward balances, offers and loyalty summaries remain.

Cards no longer presents the inferred milestone tracker or editable spending-year UI. Its account management, add/remove, bill references, connection status and settings remain. The same sourced Infinia note appears beside account management. No saved anniversary dates are deleted or changed, and no universal lifetime-free claim is added to the product registry.

## Review and evidence

- Load-bearing assumption: recorded transaction totals cannot determine bank-qualified retention, fee-waiver or reward eligibility. No qualifying-spend, RLV, remaining amount, percentage or retained-status calculation is introduced. The fixed reference has no user-adjustable year.
- The month view now excludes future-dated records and invalid/negative/non-finite amounts; purchases remain gross, with refunds shown independently.
- New actual-component SSR tests cover both Magnus accounts, amounts immediately below/at/above the retention threshold without a qualification claim, refunds, future records, malformed money, an overridden anniversary, empty wallets, unknown products, long names and preserved Cards controls.
- Nine assertions fail against the prior Home/Cards components in an isolated pre-change source tree. Two baseline guards remain green.
- Authenticated browser checks read complete wallet rows and compared the Infinia row with its matching Spend results. The source disclosure was expanded and read in context. Phone/tablet/desktop widths 320, 375, 390, 430, 768, 1023, 1024 and 1440 retain all seven real cards without whole-page horizontal overflow. Account screenshots stay local outside Git.
- Combined release checks include the pre-existing deal-finder work fetched from GitHub. No deal-finder process, import, reconciliation, database mutation or saved form was manually triggered for this work. Routine existing auto-sync ran on mount.

Observable completion: Home presents useful recorded account information and a sourced retention condition, without assuming an anniversary or showing a standard fee waiver as a personal goal. Runtime evidence and exact release checks live in SPEC §6/§10.
