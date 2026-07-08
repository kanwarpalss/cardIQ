import { describe, it, expect } from "vitest";
import { anniversaryWindowStart } from "./format";

describe("anniversaryWindowStart", () => {
  it("null anniversary_date falls back to calendar-year start", () => {
    const now = new Date(2026, 5, 15); // 15 Jun 2026
    const start = anniversaryWindowStart(null, now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(1);
  });

  it("anniversary already passed this year uses this year's occurrence", () => {
    const now = new Date(2026, 5, 15); // 15 Jun 2026
    const start = anniversaryWindowStart("2020-03-10", now); // 10 Mar, already passed
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(2);
    expect(start.getDate()).toBe(10);
  });

  it("anniversary not yet reached this year uses LAST year's occurrence", () => {
    const now = new Date(2026, 5, 15); // 15 Jun 2026
    const start = anniversaryWindowStart("2020-11-20", now); // 20 Nov, still ahead
    expect(start.getFullYear()).toBe(2025);
    expect(start.getMonth()).toBe(10);
    expect(start.getDate()).toBe(20);
  });

  it("anniversary is TODAY — boundary must count as already-started, not next year", () => {
    const now = new Date(2026, 5, 15);
    const start = anniversaryWindowStart("2019-06-15", now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(5);
    expect(start.getDate()).toBe(15);
  });

  it("leap-day anniversary (Feb 29) on a non-leap current year doesn't throw", () => {
    const now = new Date(2027, 5, 15); // 2027 is not a leap year
    expect(() => anniversaryWindowStart("2020-02-29", now)).not.toThrow();
  });
});
