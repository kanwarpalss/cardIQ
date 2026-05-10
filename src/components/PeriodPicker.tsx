"use client";

// Period picker — chips + custom range, both first-class.
//
// User feedback: the chip-only version was too restrictive. So now:
//
//   • 5 preset chips at the top (This month / Last 30 days / Last 3 months
//     / Last 6 months / Last 1 year) — fast common case.
//   • A "Custom range" section with two date inputs underneath — full
//     flexibility for anything else.
//
// The button label adapts:
//   • "This month" / "Last 3 months" / etc. when a preset is active
//   • "2024-01-15 → 2024-03-22" when on a custom range

import { useEffect, useRef, useState } from "react";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Preset {
  label: string;
  range: () => [string, string];
}

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
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 29);
      return [ymd(from), ymd(to)];
    },
  },
  {
    label: "Last 3 months",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 3);
      return [ymd(from), ymd(to)];
    },
  },
  {
    label: "Last 6 months",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 6);
      return [ymd(from), ymd(to)];
    },
  },
  {
    label: "Last 1 year",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      return [ymd(from), ymd(to)];
    },
  },
  {
    // "All time" — mirrors the 8-year first-sync window so the user can
    // see every transaction we've ever ingested. Lets them confirm e.g.
    // "yes, the foreign-currency panel really does include everything,
    // and there are still only N foreign txns total".
    label: "All time (8 yrs)",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setFullYear(from.getFullYear() - 8);
      return [ymd(from), ymd(to)];
    },
  },
];

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

  // Local state for the custom-range inputs. We don't push to onChange
  // until the user clicks "Apply" so a half-typed date doesn't refilter
  // the dashboard mid-keystroke.
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo,   setCustomTo]   = useState(to);

  // Keep custom inputs in sync when the parent's from/to change (e.g.
  // a chip click) so reopening the picker shows the current window.
  useEffect(() => { setCustomFrom(from); setCustomTo(to); }, [from, to]);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeLabel = detectActivePreset(from, to);
  // Show the preset name when one matches; otherwise show the raw range
  // — including for custom selections, so the user can see what's active
  // without opening the picker.
  const buttonLabel = activeLabel ?? `${from} → ${to}`;

  function pickPreset(p: Preset) {
    const [f, t] = p.range();
    onChange(f, t);
    setOpen(false);
  }

  function applyCustom() {
    if (!customFrom || !customTo) return;
    if (customFrom > customTo) {
      // Swap so users don't have to guess which input is which.
      onChange(customTo, customFrom);
    } else {
      onChange(customFrom, customTo);
    }
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
        <div className="absolute top-full left-0 mt-2 z-50 shadow-dropdown rounded-xl border border-rim bg-raised overflow-hidden min-w-[280px]">
          {/* Presets */}
          <div className="py-1">
            {PRESETS.map((p) => {
              const isActive = activeLabel === p.label;
              return (
                <button
                  key={p.label}
                  onClick={() => pickPreset(p)}
                  className={`w-full text-left px-4 py-2 text-sm transition-colors ${
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

          {/* Custom range */}
          <div className="border-t border-rim p-3 space-y-2 bg-surface/40">
            <div className="text-2xs uppercase tracking-widest text-mist/40">Custom range</div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="flex-1 bg-ink border border-rim rounded px-2 py-1.5 text-xs text-mist focus:border-gold/40 outline-none"
              />
              <span className="text-mist/40 text-xs">→</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="flex-1 bg-ink border border-rim rounded px-2 py-1.5 text-xs text-mist focus:border-gold/40 outline-none"
              />
            </div>
            <button
              onClick={applyCustom}
              disabled={!customFrom || !customTo}
              className="w-full px-3 py-1.5 rounded bg-gold-shimmer text-ink text-xs font-semibold hover:opacity-90 disabled:opacity-40 transition-all"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
