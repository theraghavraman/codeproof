export interface LineItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export function lineTotal(item: LineItem): number {
  return item.unitPrice * item.quantity;
}

export function applyDiscount(total: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError('percent out of range');
  return total - (total * percent) / 100;
}
