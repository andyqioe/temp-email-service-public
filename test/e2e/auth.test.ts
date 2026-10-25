import { describe, expect, it } from 'vitest';
import { InboxApi } from '../../cli/api-client';
import { createToken, revokeToken } from '../../cli/admin';
import { stageContext } from '../../cli/stack';
import { address, e2e, waitFor } from './support';

describe('API authentication', () => {
  const to = () => address('auth-');

  it('rejects requests without a valid bearer token', async () => {
    const res = await fetch(`${e2e().apiUrl}/inboxes/${encodeURIComponent(to())}/messages`);
    expect(res.status).toBe(401);
    const forged = new InboxApi({ apiUrl: e2e().apiUrl, token: `sit_${'A'.repeat(43)}` });
    await expect(forged.listInbox(to())).rejects.toMatchObject({ status: 401 });
    const garbage = new InboxApi({ apiUrl: e2e().apiUrl, token: 'not-a-token' });
    await expect(garbage.listInbox(to())).rejects.toMatchObject({ status: 401 });
  });

  it('stops accepting a token soon after it is revoked', async () => {
    const ctx = await stageContext(e2e().stage);
    const name = `e2e-revoke-${Date.now()}`;
    const client = new InboxApi({ apiUrl: e2e().apiUrl, token: await createToken(ctx, name) });
    await expect(client.listInbox(to())).resolves.toMatchObject({ messages: [] });
    await revokeToken(ctx, name);
    await waitFor(
      'the revoked token to be rejected',
      async () => {
        try {
          await client.listInbox(to());
          return undefined;
        } catch (err) {
          return (err as { status?: number }).status === 401 ? true : undefined;
        }
      },
      { timeoutMs: 60_000 },
    );
  });
});
