# Candidate Learnings — CardIQ

## 2026-07-27 — Structured transaction fields must beat account-balance fallback

When a bank alert has a labelled `Transaction Amount`, a generic parser must never reinterpret later available-balance, available-limit, or total-limit figures as the purchase amount. If the labelled foreign-currency value is malformed, reject the alert rather than guessing. This was observed in CardIQ's Axis `SGD .1` alert, where fallback had captured ₹11,87,242.78 from Available Limit.

Status: project observation only. It has one project citation, so it is not eligible for promotion to the shared learnings library.
