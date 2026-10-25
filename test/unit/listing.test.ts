import { describe, expect, it } from 'vitest';
import { getMessage, listInbox, SINCE_OVERLAP_MS, type ApiDeps } from '../../services/api/routes';
import { buildListingItems, listingKeys } from '../../services/shared/index-items';
import type { ParsedEmail } from '../../services/shared/types';

const now = new Date('2026-09-22T12:00:00.000Z');

function deps(response: Record<string, unknown>, seen: unknown[] = []): ApiDeps {
  return {
    ddb: {
      send: async (cmd: { input: unknown }) => {
        seen.push(cmd.input);
        return response;
      },
    } as unknown as ApiDeps['ddb'],
    s3: {} as ApiDeps['s3'],
    sqs: {} as ApiDeps['sqs'],
    bucket: 'b',
    table: 't',
    ingestQueueUrl: 'q',
    domains: ['in.example.com'],
    routes: [],
    now: () => now,
  };
}

describe('since polling cursor', () => {
  const horizon = new Date(now.getTime() - SINCE_OVERLAP_MS).toISOString();

  it('never advances past now minus the overlap window, so late writes are not missed', async () => {
    const ix = '2026-09-22T11:59:59.000Z#m2';
    const page = await listInbox(deps({ Items: [{ pk: 'p', sk: 's', ix, id: 'm2' }] }), 'a@in.example.com', { since: '2026-09-22T11:00:00.000Z' });
    expect(page).toMatchObject({ nextSince: horizon });
  });

  it('advances to the last entry when it is older than the window', async () => {
    const ix = '2026-09-22T11:30:00.000Z#m1';
    const page = await listInbox(deps({ Items: [{ pk: 'p', sk: 's', ix, id: 'm1' }] }), 'a@in.example.com', { since: '2026-09-22T11:00:00.000Z' });
    expect(page).toMatchObject({ nextSince: ix });
  });

  it('continues from the last evaluated entry when more are waiting, even if they were filtered', async () => {
    const response = { Items: [], LastEvaluatedKey: { pk: 'p', sk: 's9', ix: '2026-09-22T11:10:00.000Z#m9' } };
    const page = await listInbox(deps(response), 'a@in.example.com', { since: '2026-09-22T11:00:00.000Z', limit: '2' });
    expect(page).toMatchObject({ messages: [], nextSince: '2026-09-22T11:10:00.000Z#m9' });
  });

  it('never moves the cursor backwards', async () => {
    const since = '2026-09-22T11:59:55.000Z';
    const page = await listInbox(deps({ Items: [] }), 'a@in.example.com', { since });
    expect(page).toMatchObject({ nextSince: since });
  });

  it('hides expired entries with a TTL filter on every listing query', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await listInbox(deps({ Items: [] }, seen), 'a@in.example.com', {});
    await listInbox(deps({ Items: [] }, seen), 'a@in.example.com', { since: '2026-09-22T11:00:00.000Z' });
    for (const input of seen) {
      expect(input).toMatchObject({
        FilterExpression: 'attribute_not_exists(#ttl) OR #ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: expect.objectContaining({ ':now': Math.floor(now.getTime() / 1000) }),
      });
    }
  });

  it('treats an expired message as gone', async () => {
    const expired = { Item: { id: 'm1', ttl: Math.floor(now.getTime() / 1000) - 1 } };
    await expect(getMessage(deps(expired), 'm1')).rejects.toMatchObject({ status: 404, code: 'expired' });
  });

  it('rejects addresses outside the receiving domains', async () => {
    await expect(listInbox(deps({ Items: [] }), 'a@other.example.com', {})).rejects.toMatchObject({ status: 404 });
  });

  it('accepts percent-encoded addresses', async () => {
    await expect(listInbox(deps({ Items: [] }), 'a%2Btag%40in.example.com', {})).resolves.toMatchObject({ messages: [] });
  });
});

describe('listing items', () => {
  const parsed = {
    id: 'm1',
    receivedAt: '2026-09-22T10:00:00.000Z',
    size: 10,
    envelope: { from: 'x@example.org', recipients: ['a+tag@in.example.com', 'b@in.example.com', 'c@other.example.com'] },
    subject: 's',
    from: [],
    text: 'body',
    attachments: [],
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', spam: 'FAIL', virus: 'PASS' },
  } as unknown as ParsedEmail;

  it('writes one entry per recipient and one feed entry per domain, all with the same keys on retry', () => {
    const items = buildListingItems(parsed, { indexedAt: '2026-09-22T10:00:01.000Z', ttl: 123 });
    expect(items.map((i) => i.pk)).toEqual([
      'ADDR#a+tag@in.example.com',
      'ADDR#b@in.example.com',
      'ADDR#c@other.example.com',
      'FEED#in.example.com#2026-09-22',
      'FEED#other.example.com#2026-09-22',
    ]);
    expect(items[0]).toMatchObject({ tag: 'tag', spam: true, ttl: 123, sk: '2026-09-22T10:00:00.000Z#m1' });
    expect(listingKeys({ id: 'm1', receivedAt: parsed.receivedAt, recipients: parsed.envelope.recipients })).toEqual(
      items.map((i) => ({ pk: i.pk, sk: i.sk })),
    );
  });
});
