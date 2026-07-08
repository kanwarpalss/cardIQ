"use client";

import { getCardArt } from "@/lib/card-art";

// A credit-card-shaped tile: issuer-true gradient face, sheen, chip, network
// mark. `children` renders as the metrics strip on the lower half (spend,
// milestone bar, points…). Click-through is optional.
export default function CardVisual({
  productKey, name, issuer, network, last4, onClick, children,
}: {
  productKey: string;
  name: string;
  issuer: string;
  network: string;
  last4: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const art = getCardArt(productKey);
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      onClick={onClick}
      className={`relative w-full text-left rounded-2xl overflow-hidden border border-rim shadow-card group ${
        onClick ? "cursor-pointer transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-dropdown" : ""
      }`}
      style={{ background: art.gradient }}
    >
      {/* Sheen — a diagonal light pass that gives the face a metallic feel */}
      <div className="absolute inset-0 pointer-events-none opacity-60"
        style={{ background: "linear-gradient(115deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.02) 30%, transparent 45%, rgba(255,255,255,0.04) 75%, transparent 100%)" }} />

      <div className="relative p-5">
        {/* Top row: issuer + network */}
        <div className="flex items-start justify-between gap-3">
          <span className="text-xs font-medium tracking-wide text-white/60">{issuer}</span>
          <span className="text-2xs uppercase tracking-widest text-white/45">{network}</span>
        </div>

        {/* Chip */}
        <div className="mt-4 w-9 h-7 rounded-md border border-white/25 bg-gradient-to-br from-white/25 to-white/5" />

        {/* Name + number */}
        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="font-serif text-lg font-semibold truncate" style={{ color: art.accent }}>
              {name}
            </div>
            <div className="text-xs tracking-[0.25em] text-white/55 mt-0.5">•••• {last4}</div>
          </div>
        </div>

        {/* Metrics strip */}
        {children && (
          <div className="mt-4 pt-4 border-t border-white/10">
            {children}
          </div>
        )}
      </div>
    </Tag>
  );
}
