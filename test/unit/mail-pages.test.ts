import { describe, expect, it } from 'vitest';
import type { InboxApi, ListingEntry } from '../../cli/api-client';
import { decodeMailCursor, heldMailPage, latestMessage, latestPerAddress } from '../../cli/mail-pages';

const NOW = new Date('2026-09-22T12:00:00Z');

/** A fake API holding feed entries per UTC day (newest first), paged the way the real one pages. */
function fakeApi(days: Record<string, ListingEntry[]>) {
  const calls: Array<{ date?: string; before?: string; limit?: number }> = [];
  const page = (entries: ListingEntry[], before: string | undefined, limit = 20) => {
    const rest = before ? entries.filter((e) => e.cursor < before) : entries;
    const messages = rest.slice(0, limit);
    return { messages, nextBefore: rest.length > limit ? messages.at(-1)!.cursor : null };
  };
  const api = {
    feed: async (q: { date?: string; before?: string; limit?: number }) => {
      calls.push(q);
      return { date: q.date!, domain: 'in.example.com', ...page(days[q.date!] ?? [], q.before, q.limit) };
    },
    listInbox: async (address: string, q: { before?: string; limit?: number }) =>
      page(Object.values(days).flat().filter((e) => e.recipients?.includes(address)), q.before, q.limit),
  } as unknown as InboxApi;
  return { api, calls };
}

/** `n` entries on `day`, newest first, round-robin across `to`. */
function entries(day: string, n: number, to: string[] = ['a@in.example.com']): ListingEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const receivedAt = `${day}T${String(23 - Math.floor(i / 60)).padStart(2, '0')}:${String(59 - (i % 60)).padStart(2, '0')}:00.000Z`;
    const id = `${day}-${i}`;
    return { id, receivedAt, cursor: `${receivedAt}#${id}`, recipients: [to[i % to.length]!], from: 'x', subject: id } as ListingEntry;
  });
}

describe('mail pages', () => {
  it('reads today, then yesterday, 20 at a time, with no empty last page', async () => {
    const { api } = fakeApi({ '2026-09-22': entries('2026-09-22', 15), '2026-09-21': entries('2026-09-21', 25) });
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await heldMailPage(api, { now: NOW }, cursor);
      sizes.push(page.items.length);
      seen.push(...page.items.map((m) => m.id));
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(sizes).toEqual([20, 20]);
    expect(seen).toEqual([...entries('2026-09-22', 15), ...entries('2026-09-21', 25)].map((m) => m.id));
  });

  it('continues inside a day from the cursor', async () => {
    const { api, calls } = fakeApi({ '2026-09-22': entries('2026-09-22', 45) });
    const first = await heldMailPage(api, { date: '2026-09-22', now: NOW }, undefined);
    expect(decodeMailCursor(first.next!)).toEqual({ s: '2026-09-22', b: first.items[19]!.cursor });
    const second = await heldMailPage(api, { date: '2026-09-22', now: NOW }, first.next!);
    expect(second.items[0]!.id).toBe('2026-09-22-20');
    expect(calls.every((c) => c.limit === 21)).toBe(true);
  });

  it('lists the newest message of each address, newest first', async () => {
    const to = ['a@in.example.com', 'b@in.example.com', 'c@in.example.com'];
    const { api, calls } = fakeApi({ '2026-09-22': entries('2026-09-22', 150, to), '2026-09-21': entries('2026-09-21', 3, ['d@in.example.com']) });
    const rows = await latestPerAddress(api, { now: NOW });
    expect(rows.map((r) => [r.address, r.id])).toEqual([
      ['a@in.example.com', '2026-09-22-0'],
      ['b@in.example.com', '2026-09-22-1'],
      ['c@in.example.com', '2026-09-22-2'],
      ['d@in.example.com', '2026-09-21-0'],
    ]);
    expect(rows[0]!.recipients).toEqual(['a@in.example.com']);
    expect(calls.every((c) => (c.limit ?? 0) <= 100)).toBe(true); // the API caps pages at 100
  });

  it('finds the newest message overall and for one address', async () => {
    const { api } = fakeApi({ '2026-09-21': entries('2026-09-21', 3, ['a@in.example.com', 'b@in.example.com']) });
    expect((await latestMessage(api, { domains: [] }, NOW))?.id).toBe('2026-09-21-0'); // nothing today yet: falls back to yesterday
    expect((await latestMessage(api, { address: 'b@in.example.com' }))?.id).toBe('2026-09-21-1');
  });
});
