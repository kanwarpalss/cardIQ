"use client";

import { getCardArt } from "@/lib/card-art";

/** Decorative issuer artwork. The account identity and last four stay outside the stock face. */
export function CardFace({ productKey }: { productKey: string }) {
  const art = getCardArt(productKey);
  return <span aria-hidden="true" className="card-face" style={{
    aspectRatio: art.face?.ratio ?? 1.586,
    backgroundImage: art.face ? `url("${art.face.src}")` : art.gradient,
    backgroundSize: art.face?.size ?? "cover", backgroundPosition: art.face?.position ?? "center",
  }} />;
}

export default function CardVisual({ productKey, name, issuer, network, last4, onClick, children }: {
  productKey: string; name: string; issuer: string; network: string; last4: string;
  onClick?: () => void; children?: React.ReactNode;
}) {
  const Tag = onClick ? "button" : "div";
  return <Tag onClick={onClick} className={`card-visual ${onClick ? "card-visual-link" : ""}`}>
    <div className="card-art-stage"><CardFace productKey={productKey} /></div>
    <div className="card-account"><div className="min-w-0"><strong>{name}</strong><small>{issuer} · {network}</small></div><span>••{last4}</span></div>
    {children && <div className="card-metrics">{children}</div>}
  </Tag>;
}
