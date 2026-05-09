"use client";

import { useEffect, useRef, useState } from "react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const today = new Date();
const THIS_YEAR = today.getFullYear();
const THIS_MONTH = today.getMonth(); // 0-indexed

/** Returns last day of month as YYYY-MM-DD */
function lastDay(year: number, month: number): string {
  return new Date(year, month + 1, 0).toISOString().slice(0, 10);
}
/** Returns first day of month as YYYY-MM-DD */
function firstDay(year: number, month: number): string {
  return new Date(year, month, 1).toISOString().slice(0, 10);
}

interface Preset {
  label: string;
  from: string;
  to: string;
}

function buildPresets(): Preset[] {
  const y = THIS_YEAR, m = THIS_MONTH;
  return [
    {
      label: "This month",
      from: firstDay(y, m),
      to: lastDay(y, m),
    },
    {
      label: "Last month",
      from: firstDay(y, m - 1),
      to: lastDay(y, m - 1),
    },
    {
      label: "Last 3 months",
      from: firstDay(y, m - 2),
      to: lastDay(y, m),
    },
    {
      label: "Last 6 months",
      from: firstDay(y, m - 5),
      to: lastDay(y, m),
    },
    {
      label: "This year",
      from: firstDay(y, 0),
      to: lastDay(y, m),
    },
    {
      label: "Last year",
      from: firstDay(y - 1, 0),
      to: lastDay(y - 1, 11),
    },
    {
      label: "Last 2 years",
      from: firstDay(y - 2, m),
      to: lastDay(y, m),
    },
    {
      label: "Last 3 years",
      from: firstDay(y - 3, m),
      to: lastDay(y, m),
    },
    {
      label: "All time",
      from: firstDay(2019, 0),
      to: lastDay(y, m),
    },
  ];
}

/** Parse YYYY-MM-DD → { year, month } (month is 0-indexed) */
function parseDateStr(s: string): { year: number; month: number } {
  const parts = s.split("-");
  return { year: parseInt(parts[0]), month: parseInt(parts[1]) - 1 };
}

function formatDisplay(from: string, to: string): string {
  const f = parseDateStr(from);
  const t = parseDateStr(to);
  const fStr = `${MONTHS[f.month]} ${f.year}`;
  const tStr = `${MONTHS[t.month]} ${t.year}`;
  return fStr === tStr ? fStr : `${fStr} → ${tStr}`;
}

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

type Picking = "from" | "to";

export default function MonthRangePicker({ from, to, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<Picking>("from");

  const fromParsed = parseDateStr(from);
  const toParsed   = parseDateStr(to);

  const [viewYear, setViewYear] = useState(fromParsed.year);

  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // When switching to "to" picking, jump view to the "to" year
  function startPickingTo() {
    setPicking("to");
    setViewYear(toParsed.year);
  }

  function selectMonth(monthIndex: number) {
    if (picking === "from") {
      const newFrom = firstDay(viewYear, monthIndex);
      // If new from is after current to, collapse to same month
      if (newFrom > to) {
        onChange(newFrom, lastDay(viewYear, monthIndex));
      } else {
        onChange(newFrom, to);
      }
      setPicking("to");
      setViewYear(toParsed.year);
    } else {
      const newTo = lastDay(viewYear, monthIndex);
      if (newTo < from) {
        // Swap: picked an end before start — make it the new start, keep old start as end
        onChange(newTo.slice(0, 8) + "01", lastDay(fromParsed.year, fromParsed.month));
      } else {
        onChange(from, newTo);
      }
      setOpen(false);
      setPicking("from");
    }
  }

  function applyPreset(p: Preset) {
    onChange(p.from, p.to);
    setOpen(false);
    setPicking("from");
  }

  function isFrom(y: number, m: number) {
    return y === fromParsed.year && m === fromParsed.month;
  }
  function isTo(y: number, m: number) {
    return y === toParsed.year && m === toParsed.month;
  }
  function inRange(y: number, m: number) {
    const val = y * 12 + m;
    const lo  = fromParsed.year * 12 + fromParsed.month;
    const hi  = toParsed.year * 12  + toParsed.month;
    return val > lo && val < hi;
  }
  function isFuture(y: number, m: number) {
    return y > THIS_YEAR || (y === THIS_YEAR && m > THIS_MONTH);
  }

  const presets = buildPresets();

  return (
    <div className="relative" ref={ref}>
      {/* Trigger */}
      <button
        onClick={() => { setOpen((v) => !v); setPicking("from"); setViewYear(fromParsed.year); }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-rim bg-raised hover:bg-hover text-sm font-medium text-mist transition-all"
      >
        <svg className="w-3.5 h-3.5 opacity-50" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M5 1v4M11 1v4M2 7h12" />
        </svg>
        <span>{formatDisplay(from, to)}</span>
        <svg className={`w-3 h-3 opacity-40 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 10 6">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-2 z-50 shadow-dropdown rounded-xl border border-rim bg-raised overflow-hidden"
          style={{ minWidth: 340 }}>

          {/* Presets */}
          <div className="p-3 border-b border-wire">
            <div className="text-2xs uppercase tracking-widest text-mist/40 mb-2 px-1">Quick select</div>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => {
                const active = p.from === from && p.to === to;
                return (
                  <button key={p.label} onClick={() => applyPreset(p)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      active
                        ? "bg-gold text-ink"
                        : "bg-surface border border-rim hover:border-gold/40 hover:text-gold text-mist/70"
                    }`}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom range header */}
          <div className="px-4 pt-3 pb-2 border-b border-wire">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-mist/40 uppercase tracking-widest">Custom range:</span>
              <button onClick={() => { setPicking("from"); setViewYear(fromParsed.year); }}
                className={`px-2 py-0.5 rounded font-medium transition-all ${
                  picking === "from" ? "text-gold border-b-2 border-gold" : "text-mist/60 hover:text-mist"
                }`}>
                {MONTHS[fromParsed.month]} {fromParsed.year}
              </button>
              <span className="text-mist/30">→</span>
              <button onClick={startPickingTo}
                className={`px-2 py-0.5 rounded font-medium transition-all ${
                  picking === "to" ? "text-gold border-b-2 border-gold" : "text-mist/60 hover:text-mist"
                }`}>
                {MONTHS[toParsed.month]} {toParsed.year}
              </button>
              <span className="text-mist/30 ml-1 text-2xs">
                {picking === "from" ? "← pick start month" : "← pick end month"}
              </span>
            </div>
          </div>

          {/* Year nav + month grid */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <button onClick={() => setViewYear((y) => y - 1)}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-hover text-mist/60 hover:text-mist transition-all">
                ‹
              </button>
              <span className="font-semibold text-sm text-mist tabular-nums">{viewYear}</span>
              <button onClick={() => setViewYear((y) => Math.min(y + 1, THIS_YEAR))}
                disabled={viewYear >= THIS_YEAR}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-hover text-mist/60 hover:text-mist disabled:opacity-20 disabled:cursor-not-allowed transition-all">
                ›
              </button>
            </div>

            <div className="grid grid-cols-4 gap-1">
              {MONTHS.map((name, idx) => {
                const future   = isFuture(viewYear, idx);
                const fromCell = isFrom(viewYear, idx);
                const toCell   = isTo(viewYear, idx);
                const rangeCell = inRange(viewYear, idx);
                const isEndpoint = fromCell || toCell;

                return (
                  <button key={name}
                    disabled={future}
                    onClick={() => selectMonth(idx)}
                    className={[
                      "py-1.5 rounded-lg text-xs font-medium transition-all",
                      future ? "opacity-20 cursor-not-allowed" : "cursor-pointer",
                      isEndpoint
                        ? "bg-gold text-ink shadow-glow-gold font-semibold"
                        : rangeCell
                          ? "bg-gold/15 text-gold"
                          : "hover:bg-hover text-mist/70 hover:text-mist",
                    ].join(" ")}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
