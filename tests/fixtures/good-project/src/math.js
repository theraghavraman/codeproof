/**
 * Clamp a number into an inclusive range.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (min > max) throw new RangeError('min must not exceed max');
  return Math.min(max, Math.max(min, value));
}

/**
 * Average of a list; returns 0 for an empty list.
 * @param {number[]} values
 * @returns {number}
 */
export function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
