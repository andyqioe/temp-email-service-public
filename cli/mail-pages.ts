import type { InboxApi, ListingEntry } from './api-client';
import type { Page } from './ui/pager';

type Listing = { messages: ListingEntry[]; nextBefore?: string | null };

/** The API returns at most 100 entries; pages read one past their size. */
const FEED_PAGE = 99;

/** One page of mail, newest first, drawn from one or more listings in order (for example today, then yesterday). */
async function pageAcross(
  sources: Array<{ key: string; fetch: (before: string | undefined, limit: number) => Promise<Listing> }>,
  cursor: string | undefined,
  limit: number,
): Promise<Page<ListingEntry>> {
  const at = cursor ? decodeMailCursor(cursor) : { s: sources[0]?.key ?? '' };
  const startIndex = sources.findIndex((s) => s.key === at.s);
  if (startIndex === -1) return { items: [], next: null }; // the cursor's day has left the retention window
  // Read one entry past the page so the last page is known to be last.
  const items: Array<{ entry: ListingEntry; source: string }> = [];
  let before = at.b;
  for (let i = startIndex; i < sources.length && items.length <= limit; i++, before = undefined) {
    const source = sources[i]!;
    for (;;) {
      const page = await source.fetch(before, limit + 1 - items.length);
      items.push(...page.messages.map((entry) => ({ entry, source: source.key })));
      before = page.nextBefore ?? undefined;
      if (!before || items.length > limit) break;
    }
  }
  const last = items.length > limit ? items[limit - 1]! : undefined;
  return {
    items: items.slice(0, limit).map((i) => i.entry),
    next: last ? encodeMailCursor({ s: last.source, b: last.entry.cursor }) : null,
  };
}

/** Mail for one address, newest first. */
export function inboxPage(api: InboxApi, address: string, cursor: string | undefined, limit = 20): Promise<Page<ListingEntry>> {
  return pageAcross([{ key: 'inbox', fetch: (before, n) => api.listInbox(address, { before, limit: n }) }], cursor, limit);
}

/**
 * Everything a domain still holds, newest first. Mail is kept for a day, so without `date`
 * this reads today's feed and then yesterday's (UTC).
 */
export function heldMailPage(
  api: InboxApi,
  opts: { date?: string; domain?: string; now?: Date },
  cursor: string | undefined,
  limit = 20,
): Promise<Page<ListingEntry>> {
  const now = opts.now ?? new Date();
  const days = opts.date ? [opts.date] : [utcDay(now), utcDay(new Date(now.getTime() - 86_400_000))];
  return pageAcross(
    days.map((date) => ({ key: date, fetch: (before, n) => api.feed({ date, domain: opts.domain, before, limit: n }) })),
    cursor,
    limit,
  );
}

/**
 * The newest held message for each address, newest first. Mail is kept for a day, so this
 * reads at most two days of the feed (a few hundred entries at the expected pace).
 * Each row carries `address` and `recipients` set to that one address.
 */
export async function latestPerAddress(api: InboxApi, opts: { date?: string; domain?: string; now?: Date }): Promise<ListingEntry[]> {
  const newest = new Map<string, ListingEntry>();
  let cursor: string | undefined;
  do {
    const page = await heldMailPage(api, opts, cursor, FEED_PAGE);
    for (const m of page.items) {
      for (const address of m.recipients ?? []) {
        if (!newest.has(address)) newest.set(address, { ...m, address, recipients: [address] });
      }
    }
    cursor = page.next ?? undefined;
  } while (cursor);
  return [...newest.values()];
}

/** The newest message still held for an address, or across the given domains. */
export async function latestMessage(
  api: InboxApi,
  scope: { address: string } | { domains: string[] },
  now = new Date(),
): Promise<ListingEntry | undefined> {
  if ('address' in scope) return (await inboxPage(api, scope.address, undefined, 1)).items[0];
  const domains = scope.domains.length ? scope.domains : [undefined];
  const newest = await Promise.all(domains.map(async (domain) => (await heldMailPage(api, { domain, now }, undefined, 1)).items[0]));
  return newest
    .filter((m): m is ListingEntry => m !== undefined)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function encodeMailCursor(c: { s: string; b?: string }): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeMailCursor(cursor: string): { s: string; b?: string } {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; b?: unknown };
    if (typeof c.s === 'string' && (c.b === undefined || typeof c.b === 'string')) return { s: c.s, b: c.b };
  } catch {
    // fall through
  }
  throw new Error('invalid cursor; copy it exactly from the previous page');
}
