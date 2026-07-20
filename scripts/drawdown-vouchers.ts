// Backwards-compatible entry point. The old implementation attributed every
// unmatched same-brand order's FULL total to vouchers, even without payment
// evidence. The evidence-backed ledger rebuild is now the only implementation.
import "./reconcile-voucher-ledger";
