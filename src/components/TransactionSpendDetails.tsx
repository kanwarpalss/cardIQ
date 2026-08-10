import type { GroupedVoucherSpendDetail } from "@/lib/spend-details";
import type { OrderRow } from "./TransactionsTable";

interface Props {
  transactionId: string;
  order: OrderRow | undefined;
  voucherGroups: GroupedVoucherSpendDetail[];
}

const SOURCE_LABELS: Record<string, string> = {
  swiggy: "Swiggy",
  zomato: "Zomato",
  bigbasket: "BigBasket",
  amazon: "Amazon",
  blinkit: "Blinkit",
  shopify: "Shopify",
  generic: "Online",
};

const fmtExact = (value: number) =>
  "₹" + Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function ConfidenceChip({
  level,
  status,
}: {
  level: OrderRow["match_confidence"];
  status?: OrderRow["review_status"];
}) {
  if (status === "confirmed") {
    return (
      <span className="text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap text-emerald border-emerald/30 bg-emerald/5">
        ✓ confirmed
      </span>
    );
  }
  if (!level) return null;
  const map = {
    high: { label: "✓ matched", cls: "text-emerald border-emerald/30 bg-emerald/5" },
    medium: { label: "≈ likely match", cls: "text-gold border-gold/30 bg-gold/5" },
    low: { label: "? possible match", cls: "text-mist/60 border-rim bg-raised" },
  } as const;
  const { label, cls } = map[level];
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded-md border whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

export default function TransactionSpendDetails({
  transactionId,
  order,
  voucherGroups,
}: Props) {
  const hasOrderItems = Boolean(order?.items?.length);
  return (
    <tr id={`spend-details-${transactionId}`} className="border-b border-wire bg-ink/40">
      <td colSpan={5} className="px-5 py-3">
        <div className="ml-6 space-y-2">
          {order && hasOrderItems && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-2xs uppercase tracking-widest text-gold/70">
                  {SOURCE_LABELS[order.source] ?? order.source}
                  {order.kind === "refund" ? " refund" : " order"}
                </span>
                {order.merchant_name && (
                  <span className="text-xs text-mist/80">{order.merchant_name}</span>
                )}
                <ConfidenceChip level={order.match_confidence} status={order.review_status} />
                {order.order_ref && (
                  <span className="text-2xs text-mist/40 ml-auto tabular-nums">#{order.order_ref}</span>
                )}
              </div>
              <ul className="space-y-0.5">
                {order.items.map((item, index) => (
                  <li key={index} className="flex items-baseline gap-2 text-xs">
                    <span className="text-mist/70">
                      {item.qty != null && item.qty !== 1 ? `${item.qty} × ` : ""}{item.name}
                    </span>
                    {item.price != null && (
                      <span className="text-mist/40 tabular-nums ml-auto">{fmtExact(item.price)}</span>
                    )}
                  </li>
                ))}
              </ul>
              {order.total_amount != null && (
                <div className="text-2xs text-mist/50 pt-1 border-t border-wire/50">
                  Order total {fmtExact(Number(order.total_amount))}
                </div>
              )}
            </div>
          )}
          {voucherGroups.length > 0 && (
            <div className={`space-y-2 ${hasOrderItems ? "pt-2 border-t border-wire/50" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-2xs uppercase tracking-widest text-gold/70">Voucher purchase</span>
                <span className="text-2xs text-mist/40 ml-auto">
                  Face value {fmtExact(voucherGroups.reduce((sum, voucher) => sum + voucher.total, 0))}
                </span>
              </div>
              <ul className="space-y-0.5">
                {voucherGroups.map((voucher) => (
                  <li
                    key={`${voucher.brand}-${voucher.faceValue}`}
                    className="flex items-baseline gap-2 text-xs"
                  >
                    <span className="text-mist/70">
                      {voucher.quantity > 1 ? `${voucher.quantity} × ` : ""}{voucher.brand} voucher
                    </span>
                    <span className="text-mist/40 tabular-nums ml-auto">
                      {voucher.quantity > 1
                        ? `${fmtExact(voucher.faceValue)} each · ${fmtExact(voucher.total)}`
                        : fmtExact(voucher.faceValue)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
