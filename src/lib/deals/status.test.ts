import { describe, it, expect } from "vitest";
import { dedupKey } from "./score";
import {
  DEFAULT_SECTIONS, formatCounts, formatLiveRow, formatRun, fmtIst, parseStatusArgs, rankLive,
  scoreWallet, toStoredDeal,
} from "./status";
import type { StoredDeal } from "./types";
// The Mac mini checker is a plain .mjs file (piped over ssh), tested here.
import { summarizePm2, fmtIstMs } from "../../../scripts/deals-pm2-status.mjs";

let n = 0;
const deal = (over: Partial<StoredDeal> = {}): StoredDeal => {
  const d: StoredDeal = {
    id: `d${++n}`, dedup_key: "", kind: "transfer_bonus", program: "accor",
    from_bank: "hdfc", from_program: null, from_other: null,
    bonus_pct: 30, discount_pct: null, starts_on: null, ends_on: "2026-11-30",
    targeted: false, headline: `deal ${n}`, evidence: "e", evidence_verified: true,
    sources: [{ kind: "email", item_id: "x", origin: "o", title: "t", url: null, seen_at: "2026-11-01T00:00:00Z" }],
    first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z",
    ...over,
  };
  return { ...d, dedup_key: dedupKey(d) };
};

describe("parseStatusArgs", () => {
  it("no flags → every database section, mini left out (it needs ssh)", () => {
    const a = parseStatusArgs([]);
    expect(a.sections).toEqual(DEFAULT_SECTIONS);
    expect(a.sections).not.toContain("mini");
    expect(a.runs).toBe(5);
  });

  it("a section flag restricts output to that section; order is canonical, not typed", () => {
    expect(parseStatusArgs(["--live", "--counts"]).sections).toEqual(["counts", "live"]);
    expect(parseStatusArgs(["--mini"]).sections).toEqual(["mini"]);
  });

  it("--runs takes an optional count, capped at 100; a following flag is not swallowed", () => {
    expect(parseStatusArgs(["--runs", "12"]).runs).toBe(12);
    expect(parseStatusArgs(["--runs", "5000"]).runs).toBe(100);
    const a = parseStatusArgs(["--runs", "--live"]);
    expect(a.runs).toBe(5);
    expect(a.sections).toEqual(["runs", "live"]);
    expect(() => parseStatusArgs(["--runs", "0"])).toThrow(/at least 1/);
  });

  it("an unknown flag or a stray word fails loudly instead of printing the wrong thing", () => {
    expect(() => parseStatusArgs(["--run"])).toThrow(/Unknown flag "--run"/);
    expect(() => parseStatusArgs(["live"])).toThrow(/Unknown flag "live"/);
    expect(() => parseStatusArgs(["--apply"])).toThrow(/Unknown flag/);
  });

  it("--all adds mini to the defaults; --ended and --help are switches, not sections", () => {
    expect(parseStatusArgs(["--all"]).sections).toEqual([...DEFAULT_SECTIONS, "mini"]);
    const a = parseStatusArgs(["--ended", "--help"]);
    expect(a).toMatchObject({ ended: true, help: true, sections: DEFAULT_SECTIONS });
  });
});

describe("toStoredDeal", () => {
  it("turns PostgREST's numeric strings into numbers and keeps nulls null", () => {
    const d = toStoredDeal({ id: "a", bonus_pct: "55.00", discount_pct: null });
    expect(d.bonus_pct).toBe(55);
    expect(d.discount_pct).toBeNull();
    expect(toStoredDeal({ bonus_pct: undefined }).bonus_pct).toBeNull();
    expect(toStoredDeal({ discount_pct: "0" }).discount_pct).toBe(0);
  });
});

describe("scoreWallet", () => {
  it("one entry per product, and a card with no transfer spec is reported, not crashed on", () => {
    // The old probe did CARD_REGISTRY[k].issuer and threw on an unknown key.
    const w = scoreWallet(["hdfc_infinia", "hdfc_infinia", "made_up_card", "axis_magnus_burgundy"]);
    expect(w.cards.map((c) => c.product_key)).toEqual(["hdfc_infinia", "axis_magnus_burgundy"]);
    expect(w.skipped).toEqual(["made_up_card"]);
    expect(w.cards[0].issuer).toBeTruthy();
  });

  it("an empty wallet is fine", () => {
    expect(scoreWallet([])).toEqual({ cards: [], skipped: [] });
  });
});

describe("rankLive", () => {
  const wallet = scoreWallet(["hdfc_infinia"]).cards;
  const live = deal({ ends_on: "2026-11-30", headline: "live one" });
  const ended = deal({ ends_on: "2026-10-01", headline: "ended one" });

  it("drops ended deals by default and keeps them with includeEnded", () => {
    expect(rankLive([ended, live], wallet, "2026-11-10").map((r) => r.d.headline)).toEqual(["live one"]);
    expect(rankLive([ended, live], wallet, "2026-11-10", true).map((r) => r.d.headline)).toEqual(["live one", "ended one"]);
  });

  it("ranks a deal the wallet can use above one it can't", () => {
    const amex = deal({ from_bank: "amex", program: "marriott", headline: "amex one" });
    const rows = rankLive([amex, live], wallet, "2026-11-10");
    expect(rows.map((r) => r.assessment.reach)).toEqual(["yours", "not_yours"]);
    expect(formatLiveRow(rows[0])).toMatch(/^yours\s+\S+\s+active 20d left\s+live one/);
  });
});

describe("formatting", () => {
  it("counts add up and every outcome is labelled", () => {
    expect(formatCounts(19, 3, { deal: 46, not_deal: 10, skipped: 1250, error: 1 }))
      .toBe("deals stored: 19 | deal_runs: 3 | seen items: 1307 (deal 46, not_deal 10, skipped 1250, error 1)");
  });

  it("shows run times on KP's clock (IST), not UTC", () => {
    expect(fmtIst("2026-11-10T03:00:00Z")).toBe("10 Nov 2026 08:30 IST");
    expect(fmtIst(null)).toBe("—");
    expect(fmtIst("garbage")).toMatch(/invalid date/);
  });

  it("labels ok, failed and unfinished runs differently", () => {
    const base = { started_at: "2026-11-10T03:00:00Z", summary: "s" };
    expect(formatRun({ ...base, finished_at: "2026-11-10T03:04:00Z", ok: true })).toMatch(/08:30 IST\s+ok\s+\(4 min\)\s+s$/);
    expect(formatRun({ ...base, finished_at: "2026-11-10T03:00:20Z", ok: false })).toMatch(/FAILED\s+\(<1 min\)/);
    expect(formatRun({ ...base, finished_at: null, ok: false, summary: "" })).toMatch(/UNFINISHED\s+\(no summary\)$/);
  });
});

describe("summarizePm2 (Mac mini checker)", () => {
  const app = (name: string, env: Record<string, unknown> = {}) => ({
    name,
    pm2_env: {
      status: "stopped", cron_restart: "30 8 * * *", autorestart: false, restart_time: 2,
      pm_uptime: Date.parse("2026-11-10T03:00:00Z"), args: ["--apply"],
      SUPABASE_SERVICE_ROLE_KEY: "sk-SECRET-should-never-print", ...env,
    },
  });

  it("reports cron, autorestart and whether pm2 save captured each app", () => {
    const jlist = JSON.stringify([app("cardiq-deals"), app("cardiq", { status: "online", cron_restart: undefined, autorestart: true, args: ["start", "--port", "3901"] })]);
    const lines = summarizePm2(jlist, JSON.stringify([{ name: "cardiq-deals" }]));
    expect(lines[0]).toBe("cardiq-deals: stopped | cron 30 8 * * * | autorestart false | restarts 2 | last start 10 Nov 2026 08:30 IST | saved yes | args --apply");
    expect(lines[1]).toMatch(/^cardiq: online \| cron none \| autorestart true .*saved NO \| args start --port 3901$/);
  });

  it("never prints environment values (pm2_env carries secrets)", () => {
    const out = summarizePm2(JSON.stringify([app("cardiq-deals")]), "[]").join("\n");
    expect(out).not.toMatch(/SECRET|SERVICE_ROLE/);
  });

  it("says plainly when an app is missing, PM2 was never saved, or output is garbage", () => {
    const lines = summarizePm2("[]", null);
    expect(lines).toContain("cardiq-deals: NOT IN PM2");
    expect(lines.join("\n")).toMatch(/pm2 save` has never run/);
    expect(summarizePm2("not json", null)[0]).toMatch(/did not return JSON/);
    expect(summarizePm2(JSON.stringify([app("cardiq-deals")]), "{oops")).toContain("  (~/.pm2/dump.pm2 is not valid JSON)");
  });

  it("formats a missing start time as a dash", () => {
    expect(fmtIstMs(0)).toBe("—");
    expect(fmtIstMs(undefined)).toBe("—");
  });
});
