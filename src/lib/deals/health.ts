// Is the daily deal finder actually running? Shown at the top of the Deals
// screen so a stopped job (mini asleep for days, PM2 not saved, expired app
// password) is visible instead of looking like "no deals lately" (TEST-12).

import type { DealRun } from "./types";

export type HealthLevel = "ok" | "stale" | "failed" | "never";
export type Health = { level: HealthLevel; text: string };

/** A daily job is late once its last good run is older than this. */
export const STALE_AFTER_HOURS = 36;

const ago = (ms: number) => {
  const h = Math.floor(ms / 3600000);
  if (h < 1) return "less than an hour ago";
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(ms / 86400000)} days ago`;
};

/** `runs` newest first. */
export function runHealth(runs: DealRun[], now: number): Health {
  const latest = runs[0];
  const lastGood = runs.find((r) => r.ok && r.finished_at);
  if (!latest) {
    return { level: "never", text: "The deal finder hasn't run yet. It runs daily on the Mac mini once set up." };
  }
  if (!latest.ok && latest.finished_at) {
    return {
      level: "failed",
      text: `Last check failed ${ago(now - Date.parse(latest.finished_at))}: ${latest.summary.replace(/^Failed:\s*/, "")}`,
    };
  }
  if (!lastGood) {
    // Started but never finished: crashed mid-run, or running right now.
    const age = now - Date.parse(latest.started_at);
    return age > 3600000
      ? { level: "failed", text: `A check started ${ago(age)} and never finished` }
      : { level: "ok", text: "Checking for deals right now…" };
  }
  const age = now - Date.parse(lastGood.finished_at!);
  if (!Number.isFinite(age) || age > STALE_AFTER_HOURS * 3600000) {
    return { level: "stale", text: `Last successful check was ${ago(age)} — the daily job may have stopped` };
  }
  return { level: "ok", text: `Last checked ${ago(age)}` };
}
