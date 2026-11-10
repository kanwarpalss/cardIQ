import { describe, it, expect } from "vitest";
import { runHealth, ranRecently } from "./health";
import type { DealRun } from "./types";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const run = (startedHoursAgo: number, ok: boolean, finished = true, summary = "Checked 10 emails"): DealRun => ({
  started_at: new Date(NOW - startedHoursAgo * 3600000).toISOString(),
  finished_at: finished ? new Date(NOW - startedHoursAgo * 3600000 + 60000).toISOString() : null,
  ok, summary,
});

describe("runHealth — the job reports its own failure", () => {
  it("never run", () => expect(runHealth([], NOW).level).toBe("never"));

  it("a fresh good run is ok", () => {
    expect(runHealth([run(3, true)], NOW)).toEqual({ level: "ok", text: "Last checked 2 hours ago" });
  });

  it("a failed latest run is shown as failed with its reason, even if an older run was fine", () => {
    const h = runHealth([run(2, false, true, "Failed: no Gmail app password"), run(26, true)], NOW);
    expect(h.level).toBe("failed");
    expect(h.text).toMatch(/no Gmail app password/);
    expect(h.text).not.toMatch(/Failed:/);
  });

  it("goes stale when the last good run is older than 36 hours (mini asleep, PM2 not saved)", () => {
    expect(runHealth([run(37, true)], NOW)).toMatchObject({ level: "stale", text: expect.stringContaining("may have stopped") });
    expect(runHealth([run(35, true)], NOW).level).toBe("ok");
    expect(runHealth([run(24 * 5, true)], NOW).text).toMatch(/5 days ago/);
  });

  it("a run that started and never finished: in progress if recent, failed if old", () => {
    expect(runHealth([run(0.2, false, false)], NOW).text).toMatch(/right now/);
    expect(runHealth([run(3, false, false)], NOW).level).toBe("failed");
  });

  it("an unfinished run on top of a good one defers to the good one's age", () => {
    expect(runHealth([run(0.1, false, false), run(40, true)], NOW).level).toBe("stale");
  });
});

describe("ranRecently — the restart guard must never eat the daily run", () => {
  it("does not skip the 08:30 run after a mid-afternoon catch-up the day before (10 Nov 2026)", () => {
    // First run 9 Nov 15:41 IST; cron fired 10 Nov 08:30 IST, ~16.8 hours later.
    expect(ranRecently("2026-11-09T10:11:56.015696+00:00", Date.parse("2026-11-10T03:00:03Z"))).toBe(false);
  });
  it("skips a PM2 restart minutes after a good run", () => {
    expect(ranRecently("2026-11-10T03:00:00Z", Date.parse("2026-11-10T03:20:00Z"))).toBe(true);
  });
  it("runs with no history, a bad timestamp, or a clock that went backwards", () => {
    expect(ranRecently(null, NOW)).toBe(false);
    expect(ranRecently("not a date", NOW)).toBe(false);
    expect(ranRecently(new Date(NOW + 3600000).toISOString(), NOW)).toBe(false);
  });
});
