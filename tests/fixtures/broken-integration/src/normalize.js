import { DEFAULT_LOCALE } from './parser.js';

const locale = DEFAULT_LOCALE.toLowerCase();

export function normalize(value) {
  return { ...value, locale };
}
