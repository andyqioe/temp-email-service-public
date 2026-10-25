import fs from 'node:fs';
import path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { reindex } from '../../cli/admin';
import { stageContext } from '../../cli/stack';
import { listingKeys } from '../../services/shared/index-items';
import { ddbKeys, META } from '../../services/shared/keys';
import { address, api, compose, e2e, EICAR, injectRaw, marker, send, sendToIngestQueue, sleep, waitFor, waitForListing, waitForMessage, waitForParser } from './support';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

describe('robustness', () => {
  it('indexes malformed MIME with a parse error and keeps the raw message', async () => {
    const to = address('echo-broken-');
    const id = await injectRaw(fixture('malformed.eml'), { recipients: [to], subject: 'garbage' });
    const msg = await waitForMessage(id);
    expect(msg.parseError).toBe('no MIME headers found');
    expect(msg.subject).toBe('garbage'); // best effort from the SES-parsed headers
    const [entry] = (await api().listInbox(to)).messages;
    expect(entry).toMatchObject({ id, parseError: true });
    const raw = await fetch((await api().rawUrl(id)).url);
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(fixture('malformed.eml'));
    // Parsers still get a chance: the input carries parseError and the raw URL.
    await waitForParser(id, 'echo', 'ok');
  });

  it('quarantines content with a FAIL virus verdict', async () => {
    const to = address('echo-virus-');
    const raw = await compose({ to: [to], subject: 'eicar', text: 'attached', attachments: [{ filename: 'eicar.com', content: EICAR }] });
    const id = await injectRaw(raw, { recipients: [to], subject: 'eicar', verdicts: { virus: 'FAIL' } });
    const msg = await waitForMessage(id);
    expect(msg.virus).toBe(true);
    expect(msg.attachments).toEqual([expect.objectContaining({ filename: 'eicar.com', downloadable: false })]);
    await expect(api().attachmentUrl(id, 0)).rejects.toMatchObject({ status: 409, code: 'virus_detected' });
    await expect(api().rawUrl(id)).rejects.toMatchObject({ status: 409 });
    await expect(api().reparse(id)).rejects.toMatchObject({ status: 409 });
    await sleep(5_000);
    expect((await api().message(id)).parsers).toEqual({});
    const s3 = new S3Client({ region: e2e().region });
    await expect(s3.send(new HeadObjectCommand({ Bucket: e2e().outputs.BucketName, Key: `attachments/${id}/0` }))).rejects.toMatchObject({
      name: 'NotFound',
    });
  });

  it('is idempotent when SES (or SQS) delivers the same notification twice', async () => {
    const to = address('echo-dup-');
    const m = marker();
    await send({ to: [to], subject: `Dup ${m}`, text: 'once' });
    const entry = await waitForListing(to, m);
    const before = await waitForParser(entry.id, 'echo', 'ok');

    const s3 = new S3Client({ region: e2e().region });
    const receipt = await s3.send(new GetObjectCommand({ Bucket: e2e().outputs.BucketName, Key: `messages/${entry.id}/receipt.json` }));
    await sendToIngestQueue(await receipt.Body!.transformToString());
    await sleep(15_000);

    const after = await api().listInbox(to);
    expect(after.messages.map((x) => x.id)).toEqual([entry.id]);
    // A finished parser is not re-run by a duplicate delivery.
    expect((await api().message(entry.id)).parsers.echo).toEqual(before.parsers.echo);
  });

  it('paginates newest-first and polls oldest-first without gaps', async () => {
    const to = address('page-');
    const since = new Date(Date.now() - 1000).toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      ids.push(await injectRaw(await compose({ to: [to], subject: `page ${i}`, text: String(i) }), { recipients: [to], subject: `page ${i}`, timestamp: ts }));
    }
    await waitFor('25 listed messages', async () => ((await api().listInbox(to, { limit: 100 })).messages.length === 25 ? true : undefined));

    const newestFirst: string[] = [];
    let before: string | undefined;
    do {
      const page = await api().listInbox(to, { limit: 10, before });
      newestFirst.push(...page.messages.map((x) => x.id));
      before = page.nextBefore ?? undefined;
    } while (before);
    expect(newestFirst).toEqual([...ids].reverse());

    const polled = new Set<string>();
    let cursor = since;
    for (let i = 0; i < 10 && polled.size < 25; i++) {
      const page = await api().listInbox(to, { since: cursor, limit: 10 });
      page.messages.forEach((x) => polled.add(x.id));
      cursor = page.nextSince ?? cursor;
    }
    expect([...polled].sort()).toEqual([...ids].sort());
  });

  it('deletes a message from every inbox, the feed, and S3', async () => {
    const recipients = [address('del-a-'), address('del-b-')];
    const id = await injectRaw(await compose({ to: recipients, subject: 'delete me', text: 'bye', attachments: [{ filename: 'a.txt', content: 'a' }] }), {
      recipients,
      subject: 'delete me',
    });
    await waitForMessage(id);
    expect(await api().delete(id)).toEqual({ deleted: id });
    for (const r of recipients) expect((await api().listInbox(r)).messages).toEqual([]);
    expect((await api().feed({ limit: 100 })).messages.some((x) => x.id === id)).toBe(false);
    await expect(api().message(id)).rejects.toMatchObject({ status: 404 });
    const s3 = new S3Client({ region: e2e().region });
    for (const key of [`raw/${id}`, `messages/${id}/parsed.json`, `attachments/${id}/0`]) {
      await expect(s3.send(new HeadObjectCommand({ Bucket: e2e().outputs.BucketName, Key: key }))).rejects.toMatchObject({ name: 'NotFound' });
    }
  });

  it('rebuilds the index from S3 with reindex', async () => {
    const to = address('echo-reindex-');
    const id = await injectRaw(await compose({ to: [to], subject: 'reindex me', text: 'x' }), { recipients: [to], subject: 'reindex me' });
    const before = await waitForParser(id, 'echo', 'ok');

    const ctx = await stageContext(e2e().stage);
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: e2e().region }));
    for (const key of [...listingKeys({ id, receivedAt: before.receivedAt, recipients: before.recipients }), { pk: ddbKeys.message(id), sk: META }]) {
      await ddb.send(new DeleteCommand({ TableName: e2e().outputs.TableName, Key: key }));
    }
    expect((await api().listInbox(to)).messages).toEqual([]);

    expect(await reindex(ctx, { onlyIds: [id] })).toEqual({ indexed: 1, skipped: [] });
    expect((await api().listInbox(to)).messages.map((x) => x.id)).toEqual([id]);
    const after = await api().message(id);
    expect(after.parsers.echo).toMatchObject({ status: 'ok', output: before.parsers.echo!.output });
  });
});
