import { clamp, average } from './math.js';
import { formatMoney } from './format.ts';

export function summarize(scores) {
  const avg = average(scores);
  return formatMoney({ amount: clamp(avg, 0, 100), currency: 'PTS' });
}
