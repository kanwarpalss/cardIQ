#!/usr/bin/env node
/**
 * predev guard — warns (never blocks) when this machine's branch is behind
 * its remote, so you don't accidentally build on a stale tree.
 *
 * Runs automatically before `npm run dev` (npm's `predev` lifecycle hook),
 * so every machine that clones the repo gets it for free — no setup needed.
 *
 * Design rules:
 *   • NEVER fail the build. Any error (no git, no remote, offline, detached
 *     HEAD, CI, etc.) just exits 0 silently — dev must always start.
 *   • Cross-platform: pure Node, no bash, no deps.
 *   • Can't hang: the network fetch has a hard timeout.
 */

import { execSync } from "node:child_process";

// Tunables
const FETCH_TIMEOUT_MS = 5000;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/** Run a git command, returning trimmed stdout, or null on any failure. */
function git(args, timeout) {
  try {
    return execSync(`git ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout,
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  // Skip in CI / non-interactive automation — it's noise there.
  if (process.env.CI) return;

  // Bail unless we're inside a git work tree.
  if (git("rev-parse --is-inside-work-tree") !== "true") return;

  const branch = git("rev-parse --abbrev-ref HEAD");
  if (!branch || branch === "HEAD") return; // detached HEAD — nothing to compare

  // Need an upstream / matching remote branch. Prefer the configured upstream;
  // fall back to origin/<branch>.
  const upstream =
    git(`rev-parse --abbrev-ref --symbolic-full-name @{u}`) ||
    (git(`rev-parse --verify --quiet origin/${branch}`) ? `origin/${branch}` : null);
  if (!upstream) return;

  const remoteName = upstream.split("/")[0] || "origin";

  // Refresh remote refs (best-effort, hard-timeboxed so a dead network can't
  // stall startup). If it fails we just compare against the last-known refs.
  git(`fetch ${remoteName} ${branch} --quiet`, FETCH_TIMEOUT_MS);

  const behind = Number(git(`rev-list --count HEAD..${upstream}`) ?? "0");
  const ahead = Number(git(`rev-list --count ${upstream}..HEAD`) ?? "0");

  if (behind > 0) {
    const plural = behind === 1 ? "commit" : "commits";
    const divergedNote = ahead > 0
      ? `\n${C.dim}  (you also have ${ahead} local commit${ahead === 1 ? "" : "s"} not pushed — a pull will merge/rebase)${C.reset}`
      : "";
    process.stdout.write(
      `\n${C.yellow}${C.bold}⚠  Heads up: this machine is ${behind} ${plural} behind ${upstream}.${C.reset}\n` +
        `${C.dim}   Someone (maybe you, on another machine) pushed newer work.${C.reset}\n` +
        `${C.cyan}   Run:  git pull --ff-only${C.reset}${divergedNote}\n\n`
    );
  }
}

try {
  main();
} catch {
  // Absolutely never break `npm run dev`.
}
process.exit(0);
