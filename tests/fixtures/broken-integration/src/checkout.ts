import { lineTotal, applyDiscount, formatCurrency } from './pricing';
import type { LineItem } from './pricing';

export function checkoutTotal(items: LineItem[], discountPercent: number): string {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  const total = applyDiscount(subtotal, discountPercent, 'SAVE10');
  return formatCurrency(total);
}
