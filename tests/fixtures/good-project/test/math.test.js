import { describe, it, expect } from 'vitest';
import { clamp, average } from '../src/math.js';
import { summarize } from '../src/index.js';

describe('clamp', () => {
  it('keeps values inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });
  it('rejects inverted bounds', () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});

describe('average', () => {
  it('handles empty input', () => expect(average([])).toBe(0));
  it('averages numbers', () => expect(average([2, 4, 6])).toBe(4));
});

describe('summarize', () => {
  it('formats the clamped average', () => {
    expect(summarize([90, 110])).toBe('100.00 PTS');
  });
});
