import { describe, it, expect } from 'vitest';
import { mean } from '../src/stats.js';

describe('mean', () => {
  it('averages two numbers', () => {
    expect(mean([2, 4])).toBe(3);
  });
});
