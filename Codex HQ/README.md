# Superseded — do not write here

**As of 2026-08-10 this folder is a read-only archive.** Its two files were merged into the
shared brain and are indexed there:

- `summaries/cardIQ/2026-07-27-review-vouchers-currency.md`
  → `AI HQ/summaries/cardIQ/2026-07-27-review-vouchers-currency.md`
- `summaries/cardIQ/_observations.md`
  → appended to `AI HQ/summaries/cardIQ/_observations.md`

## Why this existed

Codex's global rulebook had been produced by a find-replace of Claude's, which rewrote every
path: it told Codex to use `~/.Codex-state/`, `~/.Codex/bin/claim-gate` and
`~/.Codex/AGENTS.md` — **none of which exist**. Pointed at a fictional filesystem, Codex did the
sensible thing and improvised a local brain here.

That rulebook is now generated from the same source as Claude's (`AI HQ/System/brain-core.md`)
and `~/.codex/AGENTS.md` is a symlink to it, so the paths are real and shared.

## Where things go now

Both agents write to the one brain:

- summaries → `~/AI HQ/summaries/<project>/`
- observations → `~/AI HQ/summaries/<project>/_observations.md`
- reflections → `~/.ai-state/reflections/`

Open each summary with an `**Agent:** Claude` or `**Agent:** Codex` line so authorship stays clear.

`~/AI HQ/` and `~/.ai-state/` are **shared infrastructure despite the name** — there is no
`.codex` equivalent, and creating one restarts the exact problem this file documents.
