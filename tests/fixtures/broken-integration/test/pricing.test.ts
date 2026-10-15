import { describe, it, expect } from 'vitest';
import { applyDiscount, lineTotal } from '../src/pricing';

describe('pricing', () => {
  it('applies a percentage discount', () => {
    expect(applyDiscount(200, 10)).toBe(180);
  });
  it('multiplies unit price by quantity', () => {
    expect(lineTotal({ sku: 'A', unitPrice: 2.5, quantity: 4 })).toBe(10);
  });
  it('rejects negative discounts', () => {
    expect(() => applyDiscount(100, -5)).toThrow(RangeError);
  });
});
