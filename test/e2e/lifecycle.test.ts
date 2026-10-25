import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addAccount, listAllAccounts, removeAccount, setAccount, toCsv } from '../../cli/accounts';
import { enqueueReparse, findStuckParsers } from '../../cli/admin';
import { stageContext } from '../../cli/stack';
import { listingKeys } from '../../services/shared/index-items';
import { ddbKeys, META, parserAttr } from '../../services/shared/keys';
import { address, api, compose, e2e, injectRaw, KEYS, runCli, runCliInTerminal, waitFor, waitForMessage, waitForParser } from './support';

const ddb = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: e2e().region }));
const table = () => e2e().outputs.TableName;

describe('retention', () => {
  it('stamps every item with a TTL about 24 hours out', async () => {
    const to = address('ttl-');
    const id = await injectRaw(await compose({ to: [to], subject: 'ttl', text: 'x' }), { recipients: [to], subject: 'ttl' });
    await waitForMessage(id);
    const msg = await ddb().send(new GetCommand({ TableName: table(), Key: { pk: ddbKeys.message(id), sk: META } }));
    const hours = ((msg.Item!.ttl as number) * 1000 - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.5);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it('hides mail whose TTL has passed, before DynamoDB gets around to deleting it', async () => {
    const to = address('expired-');
    const id = await injectRaw(await compose({ to: [to], subject: 'old', text: 'x' }), { recipients: [to], subject: 'old' });
    const m = await waitForMessage(id);
    const past = Math.floor(Date.now() / 1000) - 60;
    for (const Key of [{ pk: ddbKeys.message(id), sk: META }, ...listingKeys({ id, receivedAt: m.receivedAt, recipients: m.recipients })]) {
      await ddb().send(
        new UpdateCommand({ TableName: table(), Key, UpdateExpression: 'SET #ttl = :t', ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':t': past } }),
      );
    }
    expect((await api().listInbox(to)).messages).toEqual([]);
    expect((await api().feed({ limit: 100 })).messages.some((x) => x.id === id)).toBe(false);
    await expect(api().message(id)).rejects.toMatchObject({ status: 404, code: 'expired' });
  });
});

describe('deleting an inbox', () => {
  it('removes every message delivered to an address, with its stored content', async () => {
    const to = address('rmaddr-');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await injectRaw(await compose({ to: [to], subject: `m${i}`, text: 'x' }), { recipients: [to], subject: `m${i}` }));
    await waitFor('3 listed messages', async () => ((await api().listInbox(to)).messages.length === 3 ? true : undefined));
    expect(await api().deleteInbox(to)).toEqual({ address: to, deleted: 3, more: false });
    expect((await api().listInbox(to)).messages).toEqual([]);
    const s3 = new S3Client({ region: e2e().region });
    for (const id of ids) {
      await expect(s3.send(new HeadObjectCommand({ Bucket: e2e().outputs.BucketName, Key: `messages/${id}/parsed.json` }))).rejects.toMatchObject({ name: 'NotFound' });
    }
  });
});

describe('recovering stuck parsers', () => {
  it('finds parsers left pending and reruns them through the ingest queue', async () => {
    const to = address('echo-stuck-');
    const id = await injectRaw(await compose({ to: [to], subject: 'stuck', text: 'x' }), { recipients: [to], subject: 'stuck' });
    await waitForParser(id, 'echo', 'ok');
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: { pk: ddbKeys.message(id), sk: META },
        UpdateExpression: 'SET #p = :s',
        ExpressionAttributeNames: { '#p': parserAttr('echo') },
        ExpressionAttributeValues: { ':s': { status: 'pending', attempts: 1, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } },
      }),
    );
    const ctx = await stageContext(e2e().stage);
    const stuck = await findStuckParsers(ctx, 3_600_000);
    expect(stuck).toContainEqual({ id, parsers: ['echo'] });
    await enqueueReparse(ctx, stuck.filter((s) => s.id === id));
    await waitForParser(id, 'echo', 'ok');
  });
});

describe('account registry', () => {
  it('adds, lists, updates, exports, and removes accounts with plain-text passwords', async () => {
    const ctx = await stageContext(e2e().stage);
    const email = address('acct-');
    await addAccount(ctx, email, 'jagex', { url: 'https://account.jagex.com/login', username: 'e2e-user', password: 'pa55word' });
    await expect(addAccount(ctx, email, 'jagex', {})).rejects.toThrow(/already has a jagex account/);
    await addAccount(ctx, email, 'github', { username: 'e2e-gh' });

    expect((await listAllAccounts(ctx, { email })).map((a) => [a.service, a.username, a.password])).toEqual([
      ['github', 'e2e-gh', undefined],
      ['jagex', 'e2e-user', 'pa55word'],
    ]);
    expect((await listAllAccounts(ctx, { service: 'jagex' })).some((a) => a.email === email)).toBe(true);

    await setAccount(ctx, email, 'jagex', { password: 'new-pass', notes: 'rotated' });
    expect((await listAllAccounts(ctx, { email, service: 'jagex' }))[0]).toMatchObject({ password: 'new-pass', notes: 'rotated', url: 'https://account.jagex.com/login' });
    await setAccount(ctx, email, 'jagex', {}, { clearPassword: true });
    expect((await listAllAccounts(ctx, { email, service: 'jagex' }))[0]!.password).toBeUndefined();

    expect(toCsv(await listAllAccounts(ctx, { email }))).toContain(`${email},jagex,https://account.jagex.com/login,e2e-user,,rotated`);

    await removeAccount(ctx, email, 'jagex');
    await removeAccount(ctx, email, 'github');
    expect(await listAllAccounts(ctx, { email })).toEqual([]);
  });

  it('stores a password exactly as typed at the prompt or piped in, and shows it whole', async () => {
    const ctx = await stageContext(e2e().stage);
    const email = address('pw-');
    // Everything a shell would rewrite or split: $variables, !history, quotes, spaces, backslashes.
    const typed = `R..$ecret !x "q" 'y' \\z`;
    const piped = `P@$$ w0rd!* ~/.x`;
    try {
      const t = await runCliInTerminal(['account', 'add', email, '--service', 'jagex', '--username', 'maria84', '--password'], [typed + KEYS.enter], {
        startWhen: /password for jagex: /,
        settleMs: 500,
      });
      expect(t.status, t.screen).toBe(0);
      expect((await listAllAccounts(ctx, { email }))[0]!.password).toBe(typed);

      const set = await runCli(['account', 'set', email, '--service', 'jagex', '--password'], { stdin: `${piped}\n` });
      expect(set.status, set.stderr).toBe(0);
      expect((await listAllAccounts(ctx, { email }))[0]!.password).toBe(piped);

      // A value after --password is refused and nothing is stored: the shell has already rewritten it (`"R..$x"` arrives as `R..`).
      const inline = await runCli(['account', 'set', email, '--password', 'R..']);
      expect(inline.status).toBe(1);
      expect(inline.stderr).toMatch(/^qmail: --password takes no value/);
      expect((await listAllAccounts(ctx, { email }))[0]!.password).toBe(piped);

      // The table never shortens the email, username, or password, even 60 columns wide.
      const table = await runCli(['account', 'ls', '--email', email], { env: { COLUMNS: '60' } });
      expect(table.stdout.split('\n')[1]).toMatch(new RegExp(`^${email}\\s+jagex\\s+maria84\\s+${piped.replace(/[$*.]/g, '\\$&')}\\s+\\d{4}-`));

      // `set` without --service finds the email's only account; blank values keep what is stored.
      const partial = await runCli(['account', 'set', email, '--username', '', '--notes', 'rotated']);
      expect(partial).toMatchObject({ status: 0, stdout: `updated jagex account for ${email}: notes\n` });
      expect((await listAllAccounts(ctx, { email }))[0]).toMatchObject({ username: 'maria84', password: piped, notes: 'rotated' });

      // Nothing but blanks (including an empty answer at the password prompt) changes nothing and says so.
      const empty = await runCli(['account', 'set', email, '--password', '--url', ''], { stdin: '\n' });
      expect(empty.status).toBe(1);
      expect(empty.stderr).toMatch(/^qmail: nothing to change/);

      // With two accounts on the email, `set` needs --service.
      await addAccount(ctx, email, 'github', { username: 'gh' });
      const ambiguous = await runCli(['account', 'set', email, '--notes', 'x']);
      expect(ambiguous).toMatchObject({ status: 1, stderr: `qmail: ${email} has accounts for github, jagex; choose one with --service\n` });
    } finally {
      await removeAccount(ctx, email, 'jagex').catch(() => undefined);
      await removeAccount(ctx, email, 'github').catch(() => undefined);
    }
  });

  it('pages accounts 20 at a time, newest first, through the CLI', async () => {
    const ctx = await stageContext(e2e().stage);
    // A service of our own keeps other tests' accounts out of the counts.
    const service = `e2e-page-${randomBytes(3).toString('hex')}`;
    const emails: string[] = [];
    for (let i = 0; i < 45; i++) {
      const email = address(`page${String(i).padStart(2, '0')}-`);
      emails.push(email);
      await addAccount(ctx, email, service, { username: `user${i}`, password: `pw${i}`, notes: i === 44 ? 'the newest' : undefined });
    }
    const newestFirst = [...emails].reverse();
    try {
      // The indexes are eventually consistent; wait until all 45 show up.
      await waitFor('all accounts in the byService index', async () => ((await listAllAccounts(ctx, { service })).length === 45 ? true : undefined));

      // Piped: one page per call, the next cursor on stderr.
      const seen: string[] = [];
      let cursor: string | undefined;
      for (const expected of [20, 20, 5]) {
        const r = await runCli(['account', 'ls', '--service', service, ...(cursor ? ['--cursor', cursor] : [])]);
        expect(r.status).toBe(0);
        const rows = r.stdout.trim().split('\n').slice(1);
        expect(rows).toHaveLength(expected);
        seen.push(...rows.map((row) => row.split(/\s+/)[0]!));
        cursor = /--cursor (\S+)/.exec(r.stderr)?.[1];
      }
      expect(cursor).toBeUndefined();
      expect(seen).toEqual(newestFirst);

      const json = JSON.parse((await runCli(['account', 'ls', '--service', service, '--json'])).stdout) as { accounts: Array<{ email: string }>; next: string };
      expect(json.accounts.map((a) => a.email)).toEqual(newestFirst.slice(0, 20));
      expect(json.next).toEqual(expect.any(String));

      // Everything, newest first, across all services.
      const all = JSON.parse((await runCli(['account', 'ls', '--all', '--json'])).stdout) as Array<{ email: string; service: string }>;
      expect(all.filter((a) => a.service === service).map((a) => a.email)).toEqual(newestFirst);

      const csv = (await runCli(['account', 'ls', '--service', service, '--csv'])).stdout.trim().split('\n');
      expect(csv).toHaveLength(46);
      expect(csv[1]).toContain(`${newestFirst[0]},${service},,user44,pw44,the newest`);

      const long = await runCli(['account', 'ls', '--email', newestFirst[0]!, '--long']);
      expect(long.stdout).toMatch(/notes\s+the newest/);
      expect(long.stdout).toMatch(/added\s+\d{4}-\d{2}-\d{2}T/);

      // In a real terminal: → → ← q moves 1-20, 21-40, 41-45, back to 21-40, and leaves that page on screen.
      const t = await runCliInTerminal(['account', 'ls', '--service', service], [KEYS.right, KEYS.right, KEYS.left, KEYS.quit]);
      expect(t.status, t.screen).toBe(0);
      const footers = t.screen.split('\n').filter((l) => /^\d+-\d+/.test(l)).map((l) => l.trim().split(/\s{3}/)[0]!);
      // The total may land after the first frame, so only frames that show it are compared.
      const counted = footers.filter((f) => f.includes(' of '));
      expect(counted.filter((f, i) => f !== counted[i - 1])).toEqual(['1-20 of 45', '21-40 of 45', '41-45 of 45', '21-40 of 45']);
      expect(t.screen).toContain(newestFirst[20]);
    } finally {
      for (const email of emails) await removeAccount(ctx, email, service);
    }
  });
});
