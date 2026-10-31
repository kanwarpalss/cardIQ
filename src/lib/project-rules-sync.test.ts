// CardIQ's project rules live in TWO files on purpose:
//   .claude/CLAUDE.md  — read by Claude Code
//   AGENTS.md          — read by a second LLM that looks for AGENTS.md
//
// Same invariants, two readers. That is a duplicate source of truth (ARCH-04),
// and the danger is silent drift: someone tightens an invariant in one file,
// the other agent keeps working from the stale copy, and nobody finds out until
// it has already broken something.
//
// We cannot make the other tool read our file, so instead we make divergence
// LOUD — this test fails the moment the two bodies stop matching.
//
// Only the intro differs (each file explains itself to its own reader). The
// contract starts at "## Stack"; everything from there down must be identical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const CLAUDE_MD = join(REPO_ROOT, ".claude", "CLAUDE.md");
const AGENTS_MD = join(REPO_ROOT, "AGENTS.md");

// Anchored to a real line-start heading, NOT a substring: both files mention
// "## Stack" inside their own intro prose, and a bare indexOf() happily matches
// that mention instead of the heading (it did, on the first cut of this test).
const MARKER = /^## Stack$/m;

// AI HQ's sync-project-rules writes marker-delimited blocks into AGENTS.md only,
// for agents that lack Claude Code's hooks. They aren't project rules, and copying
// them into CLAUDE.md would re-break this test on every template update.
const GENERATED_BLOCK = /<!-- BEGIN:([\w-]+)\b[\s\S]*?<!-- END:\1 -->/g;

/** The shared contract: "## Stack" to EOF, minus generated blocks, trailing space normalised. */
function rulesBodyOf(text: string, label: string): string {
  const start = text.search(MARKER);
  if (start === -1) {
    throw new Error(`${label} has no "## Stack" heading on its own line — the sync check cannot locate the shared rules body.`);
  }
  return text
    .slice(start)
    .replace(GENERATED_BLOCK, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function rulesBody(path: string): string {
  return rulesBodyOf(readFileSync(path, "utf8"), path);
}

describe("project rules stay mirrored across CLAUDE.md and AGENTS.md", () => {
  it("ignores a generated block but still sees a real rule change", () => {
    const rules = "## Stack\n\n- rule A";
    const block = "<!-- BEGIN:hq-continuity — generated -->\n\n## Continuity\n\n- anything\n\n<!-- END:hq-continuity -->";

    expect(rulesBodyOf(`${rules}\n\n${block}\n`, "t")).toBe(rulesBodyOf(rules, "t"));
    expect(rulesBodyOf(`${rules}\n\n- rule B\n\n${block}\n`, "t")).not.toBe(rulesBodyOf(rules, "t"));
    expect(rulesBodyOf(`${rules}\n\n${block}\n\n- rule B\n`, "t")).not.toBe(rulesBodyOf(rules, "t"));
    // A block with no END marker must not swallow the rules after it.
    expect(rulesBodyOf(`${rules}\n\n<!-- BEGIN:hq-continuity -->\n\n- rule B\n`, "t")).not.toBe(rulesBodyOf(rules, "t"));
  });

  it("both files exist and contain a rules body", () => {
    expect(rulesBody(CLAUDE_MD).length).toBeGreaterThan(0);
    expect(rulesBody(AGENTS_MD).length).toBeGreaterThan(0);
  });

  it("the rules bodies are identical from '## Stack' onward", () => {
    // On failure vitest prints a line diff pointing at the file you forgot.
    expect(rulesBody(AGENTS_MD)).toBe(rulesBody(CLAUDE_MD));
  });

  it("both still carry every load-bearing invariant heading", () => {
    // Guards against the degenerate pass where someone empties BOTH files:
    // identical-but-gutted would otherwise satisfy the test above.
    for (const path of [CLAUDE_MD, AGENTS_MD]) {
      const body = rulesBody(path);
      expect(body, `${path} lost its Invariants section`).toContain("## Invariants");
      expect(body, `${path} lost its critical-files table`).toContain("## Critical files");
      expect(body, `${path} lost its test commands`).toContain("## Test commands");
      expect(body, `${path} lost the Gmail read-only invariant`).toContain("read-only");
    }
  });
});
