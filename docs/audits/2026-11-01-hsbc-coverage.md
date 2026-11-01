# HSBC alert coverage — 1 November 2026

This is a dated audit result. Current handoff and release details live in SPEC.md.

The 31 October full-mailbox index contained 353 HSBC sender messages across All Mail, Spam and Trash with no lower date cutoff. The follow-up search through 1 November returned three newer HSBC messages: a downtime notice, an OTP and a completed INR 214.98 PYU*SNABBIT purchase. All three are archived; the purchase already links to a 4502 transaction. Its forwarding headers preserve HSBC as sender and show delivery from the other household mailbox to CardIQ's connected mailbox.

The forwarded `hsbc emails` message contains 50 original email attachments: **32 purchases, 13 OTPs, four limit changes and one aggregate-credit notice**. All 32 purchases already have one matching transaction and archive link under the earlier import's `eml-<SHA256(Message-ID)[:24]>` identity. Every suffix, native currency/amount and debit direction agrees with the shared parser. Six purchases are USD 1.00 Facebook alerts; the other 26 are INR. No additional transaction was inserted or overwritten by this follow-up. The read-back has 33 entries for Premier 4502, including today's automatically forwarded purchase, and 10 for TravelOne 3337.

The old local parser missed the six USD alerts because it detected foreign currency and handed off to a fallback which did not recognize HSBC's wording. It could also misread an aggregate-credit notice's “remaining payment of” footer as spend. The integrated release preserves the newer HSBC/OTP/watch work, validates the entire declared purchase amount, prevents damaged known templates from falling through to INR balances, and parses dates explicitly in India time. Both independent regression suites and a real MIME-decoding integration test remain. The initial boundary cases produced 21 failures on the prior local code; the aggregate-credit case separately failed before its guard. The combined release passed **884 tests across 48 files**, TypeScript, ESLint, production build and post-restart login health.

The running mini watch scanned 15,088 unmatched archived bodies plus 27 mailbox messages. Its only 35 findings were the previously reviewed non-purchase notices; there were zero HSBC candidates, zero check failures, and the authentication rejection returned 401. No new scheduled task was created.

## Remaining source limit

**The reported INR 16,387.79 MYGATE charge dated 31 October on 4502 is absent from the connected mailbox, the attachment batch and the transaction table.** The pasted template parses correctly, but it provides no original Message-ID. The original alert must be forwarded before a deduplicated recovery can be completed. No artificial transaction identity was invented. The known historical email gap on 4502 also remains; this audit establishes available alert coverage, not statement completeness.

Private raw bodies and audit comparison files stay under temporary storage and are excluded from git.
