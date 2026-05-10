"use client";

// Simple period picker. Five presets, no monthly grid, no custom-range UX.
// Just click one of: This month / Last 30 days / Last 3 months / Last 6 months / Last 1 year.
//
// Returns from/to as YYYY-MM-DD strings via onChange so the rest of the app
// (which already filters by these strings) keeps working unchanged.

import { useEffect, useRef, useState } from "react";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Preset {
  label: string;
  /** Returns [from, to] for the preset, computed at click-time so the
      relative window is always correct (no stale "today" snapshots). */
  range: () => [string, string];
}

// Presets — order matters, this is what the user sees in the dropdown.
const PRESETS: Preset[] = [
  {
    label: "This month",
    range: () => {
      const d = new Date();
      return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(d)];
    },
  },
  {
    label: "Last 30 days",
    range: () => {
      const to   = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 29);
      return [ymd(from), ymd(to)];
    },
  },
  {
    label: "Last 3 months",
    range: () => {
      const to   = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 3);
      return [ymd(from), ymd(to)];
    },
  },
  {
    label: "Last 6 months",
    range: () => {
      const to   = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 6);
      return [ymd(from), ymd(to)];
    },
  },
  {
    label: "Last 1 year",
    range: () => {
      const to   = new Date();
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      return [ymd(from), ymd(to)];
    },
  },
];

// Reverse-lookup: given current from/to, find which preset (if any) matches.
// Used to render the active state in the dropdown.
function detectActivePreset(from: string, to: string): string | null {
  for (const p of PRESETS) {
    const [f, t] = p.range();
    if (f === from && t === to) return p.label;
  }
  return null;
}

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

export default function PeriodPicker({ from, to, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeLabel = detectActivePreset(from, to);
  const buttonLabel = activeLabel ?? `${from} → ${to}`;

  function pick(p: Preset) {
    const [f, t] = p.range();
    onChange(f, t);
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-rim bg-raised hover:bg-hover text-sm font-medium text-mist transition-all"
      >
        <svg className="w-3.5 h-3.5 opacity-50" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M5 1v4M11 1v4M2 7h12" />
        </svg>
        <span>{buttonLabel}</span>
        <svg className={`w-3 h-3 opacity-40 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 10 6">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 z-50 shadow-dropdown rounded-xl border border-rim bg-raised overflow-hidden min-w-[180px]">
          {PRESETS.map((p) => {
            const isActive = activeLabel === p.label;
            return (
              <button
                key={p.label}
                onClick={() => pick(p)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                  isActive
                    ? "bg-gold/15 text-gold font-semibold"
                    : "text-mist/80 hover:bg-hover hover:text-mist"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
