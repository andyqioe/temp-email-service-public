import { beforeEach, describe, expect, it } from 'vitest';
import {
  addAccount,
  countAccounts,
  decodeCursor,
  listAccountsPage,
  listAllAccounts,
  normalizeService,
  presentFields,
  setAccount,
  setAccountsClientForTests,
  soleService,
  toCsv,
  validateUrl,
} from '../../cli/accounts';
import type { StageContext } from '../../cli/stack';

const ctx = { region: 'us-east-2', outputs: { AccountsTableName: 'Accounts' } } as unknown as StageContext;
let sent: Array<{ name: string; input: Record<string, unknown> }> = [];
let reply: Record<string, unknown> = {};
/** When set, answers each Query in turn (for multi-page reads). */
let replies: Array<Record<string, unknown>> | undefined;

beforeEach(() => {
  sent = [];
  reply = {};
  replies = undefined;
  setAccountsClientForTests({
    send: (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return replies ? (replies.shift() ?? {}) : reply;
    }) as never,
  });
});

describe('account registry', () => {
  it('adds an account with a plain-text password, keyed by email and indexed by service', async () => {
    await addAccount(ctx, 'Maria@In.example.com', 'Jagex', { url: 'https://account.jagex.com/login', username: 'maria84', password: 'hunter2' });
    expect(sent[0]).toMatchObject({
      name: 'PutCommand',
      input: {
        TableName: 'Accounts',
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: {
          pk: 'EMAIL#maria@in.example.com',
          sk: 'SVC#jagex',
          gsi1pk: 'SVC#jagex',
          gsi1sk: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*#maria@in\.example\.com$/),
          gsi2pk: 'ACCOUNT',
          gsi2sk: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*#maria@in\.example\.com#jagex$/),
          email: 'maria@in.example.com',
          service: 'jagex',
          url: 'https://account.jagex.com/login',
          username: 'maria84',
          password: 'hunter2',
        },
      },
    });
  });

  it('updates only the given fields and can clear the password', async () => {
    reply = { Attributes: { email: 'a@b.co', service: 'jagex' } };
    await setAccount(ctx, 'a@b.co', 'jagex', { username: 'new' }, { clearPassword: true });
    expect(sent[0]!.input).toMatchObject({
      Key: { pk: 'EMAIL#a@b.co', sk: 'SVC#jagex' },
      UpdateExpression: 'SET updatedAt = :now, #username = :username REMOVE #password',
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('never lets a blank value replace a stored one, and needs at least one change', async () => {
    reply = { Attributes: { email: 'a@b.co', service: 'jagex' } };
    await setAccount(ctx, 'a@b.co', 'jagex', { username: '', url: '   ', notes: 'rotated' });
    expect(sent[0]!.input).toMatchObject({ UpdateExpression: 'SET updatedAt = :now, #notes = :notes', ExpressionAttributeNames: { '#notes': 'notes' } });
    expect(sent[0]!.input.ExpressionAttributeValues).not.toHaveProperty(':username');

    await expect(setAccount(ctx, 'a@b.co', 'jagex', { username: '', password: '' })).rejects.toThrow(/nothing to change/);
    await expect(setAccount(ctx, 'a@b.co', 'jagex', { password: 'x' }, { clearPassword: true })).rejects.toThrow(/not both/);
    expect(sent).toHaveLength(1); // the refused updates never reached DynamoDB
    expect(presentFields({ url: '', username: 'u', password: ' ', notes: undefined })).toEqual({ username: 'u' });
  });

  it('finds the service of an email with one account, and asks when there are several', async () => {
    replies = [{ Items: [{ email: 'a@b.co', service: 'jagex' }] }];
    expect(await soleService(ctx, 'A@b.co')).toBe('jagex');
    replies = [{ Items: [{ email: 'a@b.co', service: 'github' }, { email: 'a@b.co', service: 'jagex' }] }];
    await expect(soleService(ctx, 'a@b.co')).rejects.toThrow('a@b.co has accounts for github, jagex; choose one with --service');
    replies = [{ Items: [] }];
    await expect(soleService(ctx, 'a@b.co')).rejects.toThrow('no accounts for a@b.co');
  });

  it('reads each filter from the right index, newest first', async () => {
    reply = { Items: [] };
    await listAccountsPage(ctx);
    await listAccountsPage(ctx, { service: 'Jagex' });
    await listAccountsPage(ctx, { email: 'a@b.co' });
    expect(sent[0]!.input).toMatchObject({ IndexName: 'byCreated', ExpressionAttributeValues: { ':pk': 'ACCOUNT' }, ScanIndexForward: false, Limit: 21 });
    expect(sent[1]!.input).toMatchObject({ IndexName: 'byService', ExpressionAttributeValues: { ':pk': 'SVC#jagex' }, ScanIndexForward: false });
    expect(sent[2]!.input).toMatchObject({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'EMAIL#a@b.co' } });
    expect(sent[2]!.input.IndexName).toBeUndefined();
  });

  it('pages 20 at a time, reading one extra row to know whether another page exists', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => item(i));
    reply = { Items: rows, LastEvaluatedKey: keyOf(rows[20]!) };
    const page = await listAccountsPage(ctx);
    expect(page.accounts).toHaveLength(20);
    expect(page.accounts[0]).toEqual({ email: 'u0@x.co', service: 's', createdAt: rows[0]!.createdAt, updatedAt: rows[0]!.createdAt });
    // The cursor resumes after the 20th row shown, not after the peeked 21st.
    expect(decodeCursor(page.next!)).toEqual(keyOf(rows[19]!));

    await listAccountsPage(ctx, {}, { cursor: page.next! });
    expect(sent[1]!.input.ExclusiveStartKey).toEqual(keyOf(rows[19]!));

    reply = { Items: rows.slice(0, 20), LastEvaluatedKey: keyOf(rows[19]!) }; // exactly 20 left: DynamoDB still hands back a key
    replies = [reply, { Items: [] }];
    expect((await listAccountsPage(ctx)).next).toBeNull();
  });

  it('keeps reading when DynamoDB stops early at its 1 MB page size', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => item(i));
    replies = [
      { Items: rows.slice(0, 8), LastEvaluatedKey: keyOf(rows[7]!) },
      { Items: rows.slice(8, 21), LastEvaluatedKey: keyOf(rows[20]!) },
    ];
    const page = await listAccountsPage(ctx);
    expect(page.accounts.map((a) => a.email)).toEqual(rows.slice(0, 20).map((r) => r.email));
    expect(sent[1]!.input).toMatchObject({ Limit: 13, ExclusiveStartKey: keyOf(rows[7]!) });
    expect(page.next).not.toBeNull();
  });

  it('counts server-side and reads everything for --all', async () => {
    replies = [{ Count: 3, LastEvaluatedKey: { pk: 'x' } }, { Count: 2 }];
    expect(await countAccounts(ctx)).toBe(5);
    expect(sent[0]!.input.Select).toBe('COUNT');
    replies = [{ Items: [item(0)], LastEvaluatedKey: keyOf(item(0)) }, { Items: [item(1)] }];
    expect((await listAllAccounts(ctx)).map((a) => a.email)).toEqual(['u0@x.co', 'u1@x.co']);
  });

  it('rejects a mangled cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(/invalid cursor/);
  });

  it('validates input and exports CSV safely', () => {
    expect(() => normalizeService('My Site')).toThrow();
    expect(() => validateUrl('javascript:alert(1)')).toThrow();
    const csv = toCsv([{ email: 'a@b.co', service: 'x', password: 'p,"q"', createdAt: 't', updatedAt: 't' }]);
    expect(csv.split('\n')[1]).toBe('a@b.co,x,,,"p,""q""",,t,t');
  });
});

/** A stored row, newest first by index: row 0 is the newest. */
function item(i: number) {
  const createdAt = new Date(Date.UTC(2026, 8, 22) - i * 60_000).toISOString();
  return { pk: `EMAIL#u${i}@x.co`, sk: 'SVC#s', gsi2pk: 'ACCOUNT', gsi2sk: `${createdAt}#u${i}@x.co#s`, email: `u${i}@x.co`, service: 's', createdAt, updatedAt: createdAt };
}

function keyOf(row: ReturnType<typeof item>) {
  return { pk: row.pk, sk: row.sk, gsi2pk: row.gsi2pk, gsi2sk: row.gsi2sk };
}
