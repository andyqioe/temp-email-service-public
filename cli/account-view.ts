import type { Account } from './accounts';
import { color, table, visibleLength } from './ui/text';

/**
 * A page of accounts. Everything you need to sign in (email, service, username, password) and
 * the date are never shortened. The URL comes last and takes whatever room is left; when that is
 * too little to be useful, it is left out (`--long` shows it).
 */
export function accountTable(accounts: Account[], width: number): string[] {
  const headers = ['EMAIL', 'SERVICE', 'USERNAME', 'PASSWORD', 'ADDED'];
  const rows = accounts.map((a) => [a.email, a.service, a.username ?? '', a.password ?? '', a.createdAt.slice(0, 10)]);
  const keep = [0, 1, 2, 3, 4];
  const withoutUrl = table(headers, rows, width, { keep });
  const room = width - Math.max(...withoutUrl.map(visibleLength)) - 2;
  if (room < MIN_URL_WIDTH || accounts.every((a) => !a.url)) return withoutUrl;
  return table([...headers, 'URL'], rows.map((r, i) => [...r, accounts[i]!.url ?? '']), width, { keep });
}

/** Narrower than this, a URL is just "https://ac…" and helps nobody. */
const MIN_URL_WIDTH = 16;

/** Every field, one card per account (`account ls --long`). */
export function accountCards(accounts: Account[]): string[] {
  const row = (k: string, v: string | undefined) => (v ? `${color.dim(k.padEnd(10))}${v}` : undefined);
  return accounts.flatMap((a, i) => [
    ...(i > 0 ? [''] : []),
    ...[
      color.bold(`${a.service} · ${a.email}`),
      row('url', a.url),
      row('username', a.username),
      row('password', a.password),
      row('notes', a.notes),
      row('added', a.createdAt),
      row('updated', a.updatedAt),
    ].filter((l): l is string => l !== undefined),
  ]);
}
