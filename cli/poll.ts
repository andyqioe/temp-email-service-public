import type { InboxApi, ListingEntry, MessageView, ParserStateView } from './api-client';

const PAGE = 100;

/**
 * Yields each new message for an address exactly once. The server's `since` cursor is
 * at-least-once (it deliberately overlaps by a few seconds so late writes are never
 * missed), so this dedupes by id.
 */
export async function* pollInbox(
  api: InboxApi,
  address: string,
  opts: { since: string; intervalMs: number; signal?: AbortSignal },
): AsyncGenerator<ListingEntry> {
  let since = opts.since;
  const seen = new Set<string>();
  while (!opts.signal?.aborted) {
    const page = await api.listInbox(address, { since, limit: PAGE });
    for (const m of page.messages) {
      if (opts.signal?.aborted) return;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      yield m;
    }
    since = page.nextSince ?? since;
    if (page.messages.length < PAGE) await sleep(opts.intervalMs, opts.signal);
  }
}

/** Polls a message until none of its parsers is still pending (or the signal fires). */
export async function waitForParsers(api: InboxApi, id: string, opts: { intervalMs: number; signal?: AbortSignal }): Promise<MessageView> {
  for (;;) {
    const message = await api.message(id);
    const pending = Object.values(message.parsers).some((p) => p.status === 'pending');
    if (!pending || opts.signal?.aborted) return message;
    await sleep(opts.intervalMs, opts.signal);
  }
}

/** Polls a message until the named parser finishes (ok or error). */
export async function waitForParser(
  api: InboxApi,
  id: string,
  parser: string,
  opts: { intervalMs: number; signal?: AbortSignal },
): Promise<{ message: MessageView; state: ParserStateView | undefined }> {
  for (;;) {
    const message = await api.message(id);
    const state = message.parsers[parser];
    if (!state || state.status !== 'pending' || opts.signal?.aborted) return { message, state };
    await sleep(opts.intervalMs, opts.signal);
  }
}

/** "5m", "30s", "2h", "1d" -> ISO timestamp that far in the past; ISO strings pass through. */
export function resolveSince(value: string | undefined, now = Date.now()): string {
  if (!value || value === 'now') return new Date(now).toISOString();
  const m = /^(\d+)([smhd])$/.exec(value);
  if (m) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
    return new Date(now - Number(m[1]) * unit).toISOString();
  }
  if (Number.isNaN(Date.parse(value))) throw new Error(`--since must be an ISO time or a duration like 10m: ${value}`);
  return new Date(value).toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const t = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
