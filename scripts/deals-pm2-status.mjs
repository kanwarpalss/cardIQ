/**
 * deals-pm2-status.mjs — read-only: how PM2 on the Mac mini is set up to run
 * the daily deal finder (`cardiq-deals`) and the web app (`cardiq`).
 *
 * Self-contained on purpose (no project imports, no dependencies), so
 * `npm run deals:status -- --mini` can pipe it over ssh to the mini and it
 * works whatever the mini's checkout looks like. On the mini itself:
 *   node scripts/deals-pm2-status.mjs
 *
 * Prints, per app: status, cron, autorestart, restarts, last start, and
 * whether `pm2 save` captured it (else it vanishes on reboot). Also the
 * commit the mini's checkout is on. Changes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APPS = ["cardiq-deals", "cardiq"];

/** "10 Nov 2026 08:30 IST" for an epoch-ms value. */
export function fmtIstMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(ms);
  return `${s.replace(",", "")} IST`;
}

/**
 * Pure: the read-out lines from `pm2 jlist` output and the text of
 * ~/.pm2/dump.pm2 (null when missing). Never prints env values — pm2_env
 * carries every environment variable, secrets included.
 */
export function summarizePm2(jlistText, dumpText) {
  let list;
  try {
    list = JSON.parse(jlistText);
  } catch {
    return [`pm2 jlist did not return JSON: ${String(jlistText).slice(0, 120)}`];
  }
  if (!Array.isArray(list)) return ["pm2 jlist did not return a list"];
  let saved = new Set();
  let dumpNote = "";
  if (dumpText == null) dumpNote = "  (no ~/.pm2/dump.pm2 — `pm2 save` has never run; nothing survives a reboot)";
  else {
    try {
      const dump = JSON.parse(dumpText);
      saved = new Set((Array.isArray(dump) ? dump : []).map((p) => p && p.name));
    } catch {
      dumpNote = "  (~/.pm2/dump.pm2 is not valid JSON)";
    }
  }
  const lines = [];
  for (const name of APPS) {
    const p = list.find((x) => x && x.name === name);
    if (!p) { lines.push(`${name}: NOT IN PM2`); continue; }
    const e = p.pm2_env || {};
    lines.push(
      `${name}: ${e.status ?? "?"}` +
      ` | cron ${e.cron_restart || "none"}` +
      ` | autorestart ${e.autorestart}` +
      ` | restarts ${e.restart_time ?? "?"}` +
      ` | last start ${fmtIstMs(e.pm_uptime)}` +
      ` | saved ${saved.has(name) ? "yes" : "NO"}` +
      ` | args ${Array.isArray(e.args) ? e.args.join(" ") || "none" : e.args ?? "none"}`,
    );
  }
  if (dumpNote) lines.push(dumpNote);
  return lines;
}

function main() {
  let jlist;
  try {
    jlist = execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.log(`pm2 jlist failed: ${err.message.split("\n")[0]}`);
    process.exitCode = 1;
    return;
  }
  const dumpPath = join(process.env.PM2_HOME || join(homedir(), ".pm2"), "dump.pm2");
  const dump = existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : null;
  for (const line of summarizePm2(jlist, dump)) console.log(line);

  // Which commit is the mini running? Taken from the deal app's own cwd.
  try {
    const app = JSON.parse(jlist).find((x) => x && x.name === "cardiq-deals");
    const cwd = app?.pm2_env?.pm_cwd;
    if (cwd) {
      const head = execFileSync("git", ["-C", cwd, "log", "-1", "--format=%h %cd %s", "--date=format:%d %b %H:%M"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      console.log(`checkout: ${cwd} @ ${head}`);
    }
  } catch {
    console.log("checkout: could not read the git commit");
  }
}

// Vitest imports this file for summarizePm2; only a real run prints.
if (!process.env.VITEST) main();
