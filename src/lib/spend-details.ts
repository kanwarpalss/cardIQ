export type VoucherSpendDetail = {
  brand: string;
  face_value: number;
};

export type GroupedVoucherSpendDetail = {
  brand: string;
  faceValue: number;
  quantity: number;
  total: number;
};

/** Normalize voucher rows for the same expandable detail panel as order items. */
export function groupVoucherSpendDetails(
  vouchers: readonly VoucherSpendDetail[] | null | undefined
): GroupedVoucherSpendDetail[] {
  const grouped = new Map<string, GroupedVoucherSpendDetail>();
  for (const voucher of vouchers ?? []) {
    const brand = voucher.brand.trim();
    const faceValue = Number(voucher.face_value);
    if (!brand || !Number.isFinite(faceValue) || faceValue <= 0) continue;

    const key = `${brand.toLocaleLowerCase("en-IN")}\u0000${faceValue}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity++;
      existing.total += faceValue;
    } else {
      grouped.set(key, { brand, faceValue, quantity: 1, total: faceValue });
    }
  }
  return [...grouped.values()];
}

export function hasExpandableSpendDetails(
  orderItems: readonly unknown[] | null | undefined,
  voucherGroups: readonly GroupedVoucherSpendDetail[]
): boolean {
  return Boolean(orderItems?.length) || voucherGroups.length > 0;
}
