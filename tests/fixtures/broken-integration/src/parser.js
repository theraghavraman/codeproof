import { normalize } from './normalize.js';

export function parse(raw) {
  return normalize(typeof raw === 'string' ? JSON.parse(raw) : raw);
}
export const DEFAULT_LOCALE = 'en-US';
