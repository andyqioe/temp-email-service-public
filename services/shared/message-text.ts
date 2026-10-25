import type { EmailAddress } from './types';

/** Whitespace-collapsed preview text for listings. */
export function snippetOf(text: string | undefined, max = 200): string {
  if (!text) return '';
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function formatAddress(a: EmailAddress | undefined): string {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}
