# Card alert coverage audit — 31 October 2026

This is a dated audit result. Current project state and release details belong in SPEC.md.

The audit indexed 17,545 unique live Gmail message IDs, with no lower date cutoff, as of **31 October 2026, 14:25:41 IST**. Six complete searches covered bank senders and historical card references in All Mail, Spam and Trash. Each returned envelope count matched its search count. Existing archived bodies were reused; only previously unrecorded diagnostic emails were downloaded. Gmail stayed read-only.

## Recovery

The opening database snapshot contained 4,776 transactions and 20,646 archived messages. **1,110 additional, strictly parsed charges and credits were inserted**, then read back against the exact recovery manifest. All recovered messages now link to their transaction. Eight older transactions also received their missing email archive links.

| Card suffix | New debits | New credits | Total recovered |
|---|---:|---:|---:|
| HDFC 3034 | 4 | 0 | 4 |
| HSBC 3337 | 2 | 0 | 2 |
| Citi 6016 | 103 | 5 | 108 |
| Citi 6589 | 745 | 27 | 772 |
| Citi 0817 | 139 | 3 | 142 |
| ICICI 8006 | 65 | 0 | 65 |
| HDFC 8609 | 0 | 3 | 3 |
| HDFC 0204 | 0 | 14 | 14 |
| **Total** | **1,058** | **52** | **1,110** |

HDFC 3034's four charges total **₹1,894**. HSBC 3337's two charges total **₹10,220**. The earlier Axis 4455 IndiGo recovery of ₹1,14,580 was already present in the opening snapshot and is additional to this audit's 1,110 rows. No additional omitted strict alerts were found for the other registered cards in that snapshot (Axis 4455/2294, HDFC 5906, ICICI 9004).

Historical foreign amounts retain their original currency and amount. **25 old Citi 6589 events have no historical INR rate available**; they retain the application's INR-zero sentinel and must not be described as zero-value purchases or complete INR totals. Mixed currencies were never summed as rupees. Historical card suffixes were preserved without inventing registered card records.

## Post-recovery checks

The database read-back at 15:46:42 IST contained 5,918 transactions and 20,965 archived messages. Other concurrent work contributed 32 transactions and 70 archive rows beyond this audit's recovery; those were preserved. Two final bank-account diagnostic samples were subsequently archived, taking the archive count to 20,967 at that point.

- All 1,110 manifest rows exist with matching amount, currency, card suffix and debit/credit direction.
- No duplicate transaction email IDs, broken archive links, or transactions missing their archive link.
- No remaining unmatched archive message produces a transaction through the supported strict bank parsers.
- The 35 remaining format-watch candidates were reviewed against their bodies: 17 HDFC declined attempts; 7 ICICI contactless-disabled declines; 4 Axis fraud follow-ups for the same declined Apple attempt (the analyst notice explicitly reports status D); 3 EMI schedules; 1 Axis card-blocking notice; 2 ICICI card delivery notices; 1 ICICI terms update. None establishes another completed purchase.
- All exact Citi purchase, merchant-credit, cancellation and provisional-credit alert subjects in the audited corpus are accounted for. Generic historical fallback was rejected because it also turns bill repayments and account notices into apparent spend.

## Prevention and validation

The shared sender inventory now includes HSBC's actual `hsbc.bank.in` domain and legacy `citicorp.com`, and both live sync and format watch use it. Parsers cover the observed old Citi/ICICI/HDFC formats and current HDFC noticed-transaction/HSBC alerts. Format watch independently retains explicit bank transaction subjects even when card fields are damaged, the suffix is unregistered, or a marketing footer appears. Its five new failure-injection tests failed before the watcher changes. Real-format parser tests failed against the prior parsers; boundary tests cover damaged/zero/overflow amounts, impossible dates, PAN suffixes, foreign cancellation credits and balance-notice false positives.

Local release checks: **791 tests across 43 files**, TypeScript, ESLint and production build passed. The stale generated development validator for a separately removed route was discarded before the type check; application source was not changed to conceal it.

## Final runtime checks — 1 November 2026

The fresh read-back has **5,921 transactions**, all 1,110 recovery links intact, no duplicate email IDs, no broken links and no remaining strict-parseable unmatched alerts. Later card-number repairs were preserved: stored Infinia charges totalling ₹5,988 and a retired HDFC charge of ₹199 had blank card numbers, which are now assigned from their own alert bodies.

The signed-in Spend page shows **5,921 results under All time**, matching the database. The old eight-year cutoff hid 280 saved transactions and was removed in `202d08d`; Last 30 days still correctly narrows the result to 118. All other filters retain their checks.

Release `de9f0dc` integrates the parser repairs, existing OAuth repair, HSBC/quiet-card/unlisted-sender/cardless safeguards and archive reuse. The exact mini release passed **852 tests across 46 files**, TypeScript, ESLint, production build and login health. Vercel production `dpl_81KfdpAjNfBz9QiLxjUGT4Dq4qsq` is READY on that revision. The mini warning endpoint rejected an invalid credential with 401, then returned 200 after scanning 15,062 unmatched archived emails and 27 mailbox messages. Its only findings were the 35 already-reviewed non-purchase notices; no check failed. Newly read diagnostic bodies are archived once; existing archive rows and transaction links are never overwritten. At that check there were 21,009 archived emails and zero cardless transactions.

HSBC 4502's separately imported 32-event email dump is present, but its historical source remains incomplete (no alerts from 10 August to 18 September; an outstanding-balance notice also exceeds the dump's spend). The chosen email-only history cannot fill charges that were never supplied. American Express aggregate alerts likewise do not establish an individual-transaction history. These limitations prevent an absolute bank-ledger completeness claim.

## Assurance boundary

This establishes recovery and coverage of the available, identifiable credit-card transaction-alert emails in the audited mailbox scope. It does **not** establish bank-statement completeness. American Express samples are aggregate balance/spend-threshold notices, not a complete individual-transaction feed. Debit-card, bank-account, repayment, OTP and marketing notices are outside credit-card purchase recovery. Charges, fees or credits that never generated an email require statement reconciliation. The existing weekly format-watch task remains the proactive safety net; this audit did not add a second scheduled task.

Raw mailbox bodies, exact manifests, pre-recovery snapshot and read-back evidence are private temporary audit files under `/private/tmp/cardiq-all-card-audit-20261031/`; they are deliberately excluded from git. They expire with temporary storage and are not a permanent backup.
