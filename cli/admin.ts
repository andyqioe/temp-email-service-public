import { CloudWatchClient, SetAlarmStateCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { CreateReceiptFilterCommand, DeleteReceiptFilterCommand, ListReceiptFiltersCommand, SESClient } from '@aws-sdk/client-ses';
import { GetQueueAttributesCommand, SendMessageBatchCommand, SQSClient, StartMessageMoveTaskCommand } from '@aws-sdk/client-sqs';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { generateToken, hashToken } from '../services/api/auth';
import { batchWrite, putRequests } from '../services/shared/ddb';
import { buildListingItems, buildMessageUpdate } from '../services/shared/index-items';
import { ddbKeys, META, parserAttr, s3Keys } from '../services/shared/keys';
import { setReceiving } from '../services/shared/receiving';
import type { ParsedEmail } from '../services/shared/types';
import type { StageContext } from './stack';

function clients(ctx: Pick<StageContext, 'region'>) {
  const region = ctx.region;
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }),
    s3: new S3Client({ region }),
    sqs: new SQSClient({ region }),
    ses: new SESClient({ region }),
    cw: new CloudWatchClient({ region }),
  };
}

// ---- tokens ---------------------------------------------------------------------------

export async function createToken(ctx: { region: string; outputs: Pick<StageContext['outputs'], 'TableName'> }, name: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('token name: letters, digits, ".", "_", "-" (max 64)');
  const { ddb } = clients(ctx);
  const token = generateToken();
  const hash = hashToken(token);
  const createdAt = new Date().toISOString();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: ctx.outputs.TableName,
              Item: { pk: ddbKeys.tokenIndex, sk: name, hash, createdAt },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: ctx.outputs.TableName, Item: { pk: ddbKeys.token(hash), sk: META, name, createdAt } } },
        ],
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') throw new Error(`a token named ${name} already exists`, { cause: err });
    throw err;
  }
  return token;
}

export async function listTokens(ctx: StageContext): Promise<Array<{ name: string; createdAt: string }>> {
  const { ddb } = clients(ctx);
  const { Items } = await ddb.send(
    new QueryCommand({ TableName: ctx.outputs.TableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': ddbKeys.tokenIndex } }),
  );
  return (Items ?? []).map((i) => ({ name: i.sk as string, createdAt: i.createdAt as string }));
}

export async function revokeToken(ctx: StageContext, name: string): Promise<void> {
  const { ddb } = clients(ctx);
  const { Item } = await ddb.send(new GetCommand({ TableName: ctx.outputs.TableName, Key: { pk: ddbKeys.tokenIndex, sk: name } }));
  if (!Item) throw new Error(`no token named ${name}`);
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: ctx.outputs.TableName, Key: { pk: ddbKeys.token(Item.hash as string), sk: META } } },
        { Delete: { TableName: ctx.outputs.TableName, Key: { pk: ddbKeys.tokenIndex, sk: name } } },
      ],
    }),
  );
}

// ---- reindex --------------------------------------------------------------------------

/**
 * Rebuilds the DynamoDB index from S3, the source of truth. Idempotent: listing items are
 * overwritten and parser states are only filled in where missing.
 */
export async function reindex(
  ctx: StageContext,
  opts: { onlyIds?: string[]; concurrency?: number; onProgress?: (done: number) => void } = {},
): Promise<{ indexed: number; skipped: string[] }> {
  const { s3, ddb } = clients(ctx);
  const bucket = ctx.outputs.BucketName;
  const table = ctx.outputs.TableName;
  const ids = opts.onlyIds ?? (await listMessageIds(s3, bucket));
  const skipped: string[] = [];
  let indexed = 0;
  const work = async (id: string) => {
    let parsed: ParsedEmail;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Keys.parsed(id) }));
      parsed = JSON.parse(await obj.Body!.transformToString()) as ParsedEmail;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        skipped.push(id);
        return;
      }
      throw err;
    }
    // Rebuilt entries keep the retention window counted from when the mail arrived.
    const ttl = Math.floor(Date.parse(parsed.receivedAt) / 1000) + ctx.stage.retentionHours * 3600;
    const now = new Date().toISOString();
    await ddb.send(new UpdateCommand(buildMessageUpdate(parsed, { tableName: table, parsers: [], now, ttl })));
    const outputs = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: s3Keys.parserOutputPrefix(id) }));
    for (const o of outputs.Contents ?? []) {
      const parser = o.Key!.slice(s3Keys.parserOutputPrefix(id).length).replace(/\.json$/, '');
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: ddbKeys.message(id), sk: META },
          UpdateExpression: 'SET #p = if_not_exists(#p, :s)',
          ExpressionAttributeNames: { '#p': parserAttr(parser) },
          ExpressionAttributeValues: { ':s': { status: 'ok', attempts: 1, updatedAt: now } },
        }),
      );
    }
    await batchWrite(ddb, table, putRequests(buildListingItems(parsed, { indexedAt: now, ttl })));
    indexed++;
    opts.onProgress?.(indexed);
  };
  await pool(ids, opts.concurrency ?? 16, work);
  return { indexed, skipped };
}

async function listMessageIds(s3: S3Client, bucket: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'messages/', Delimiter: '/', ContinuationToken: token }));
    for (const p of page.CommonPrefixes ?? []) ids.push(p.Prefix!.slice('messages/'.length, -1));
    token = page.NextContinuationToken;
  } while (token);
  return ids;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// ---- dead-letter queues ---------------------------------------------------------------

export async function redrive(ctx: StageContext): Promise<string> {
  const { sqs } = clients(ctx);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: ctx.outputs.IngestDlqUrl, AttributeNames: ['QueueArn'] }));
  const { TaskHandle } = await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: Attributes!.QueueArn! }));
  return TaskHandle ?? '';
}

// ---- pause / resume ------------------------------------------------------------------

export async function pause(ctx: StageContext): Promise<boolean> {
  const { ses, ddb } = clients(ctx);
  const changed = await setReceiving(ses, ctx.outputs.RuleSetName, ctx.outputs.RuleName, false);
  await ddb.send(
    new PutCommand({
      TableName: ctx.outputs.TableName,
      Item: { pk: ddbKeys.breaker, sk: META, paused: true, pausedAt: new Date().toISOString(), by: 'manual' },
    }),
  );
  return changed;
}

/** Re-enables the rule and resets the auto-pause alarms so a continuing spike trips them again. */
export async function resume(ctx: StageContext): Promise<boolean> {
  const { ses, ddb, cw } = clients(ctx);
  const changed = await setReceiving(ses, ctx.outputs.RuleSetName, ctx.outputs.RuleName, true);
  for (const AlarmName of [ctx.outputs.HourlyAlarmName, ctx.outputs.DailyAlarmName]) {
    await cw.send(new SetAlarmStateCommand({ AlarmName, StateValue: 'OK', StateReason: 'Receiving resumed with `qmail resume`' }));
  }
  await ddb.send(
    new PutCommand({
      TableName: ctx.outputs.TableName,
      Item: { pk: ddbKeys.breaker, sk: META, paused: false, resumedAt: new Date().toISOString() },
    }),
  );
  return changed;
}

/** The auto-pause breaker's last decision (who paused or resumed receiving, and when). */
export async function breakerState(ctx: StageContext): Promise<Record<string, unknown> | null> {
  const { Item } = await clients(ctx).ddb.send(new GetCommand({ TableName: ctx.outputs.TableName, Key: { pk: ddbKeys.breaker, sk: META } }));
  return Item ?? null;
}

// ---- IP filters -----------------------------------------------------------------------

const filterPrefix = (ctx: StageContext) => `${ctx.config.project}-block-`;

export async function blockIp(ctx: StageContext, cidr: string): Promise<string> {
  if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(cidr) && !/^[0-9a-f:]+(\/\d{1,3})?$/i.test(cidr)) {
    throw new Error(`not an IP address or CIDR: ${cidr}`);
  }
  const name = `${filterPrefix(ctx)}${cidr.replace(/[/:]/g, '-')}`.slice(0, 64);
  await clients(ctx).ses.send(new CreateReceiptFilterCommand({ Filter: { Name: name, IpFilter: { Policy: 'Block', Cidr: cidr } } }));
  return name;
}

export async function unblockIp(ctx: StageContext, cidr: string): Promise<void> {
  const filters = await listBlocked(ctx);
  const match = filters.find((f) => f.cidr === cidr);
  if (!match) throw new Error(`${cidr} is not blocked by this project`);
  await clients(ctx).ses.send(new DeleteReceiptFilterCommand({ FilterName: match.name }));
}

/** IP filters are account-wide in the region; only the ones this project created are listed. */
export async function listBlocked(ctx: StageContext): Promise<Array<{ name: string; cidr: string }>> {
  const { Filters } = await clients(ctx).ses.send(new ListReceiptFiltersCommand({}));
  return (Filters ?? [])
    .filter((f) => f.Name?.startsWith(filterPrefix(ctx)) && f.IpFilter?.Policy === 'Block')
    .map((f) => ({ name: f.Name!, cidr: f.IpFilter!.Cidr! }));
}


// ---- recovery and migration -----------------------------------------------------------

/** Message ids whose parsers are still `pending` after `olderThanMs` (for example after a crash or a migration). */
export async function findStuckParsers(ctx: StageContext, olderThanMs: number): Promise<Array<{ id: string; parsers: string[] }>> {
  const { ddb } = clients(ctx);
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stuck: Array<{ id: string; parsers: string[] }> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: ctx.outputs.TableName,
        FilterExpression: 'begins_with(pk, :msg)',
        ExpressionAttributeValues: { ':msg': 'MSG#' },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of page.Items ?? []) {
      const parsers = Object.entries(item)
        .filter(([k, v]) => k.startsWith('p_') && (v as { status?: string; updatedAt?: string }).status === 'pending' && ((v as { updatedAt?: string }).updatedAt ?? '') < cutoff)
        .map(([k]) => k.slice(2));
      if (parsers.length > 0) stuck.push({ id: item.id as string, parsers });
    }
    start = page.LastEvaluatedKey;
  } while (start);
  return stuck;
}

/** Queues reparse jobs on the ingest queue, which runs them like new mail (throttled by its concurrency). */
export async function enqueueReparse(ctx: StageContext, jobs: Array<{ id: string; parsers?: string[] }>): Promise<number> {
  const { sqs } = clients(ctx);
  for (let i = 0; i < jobs.length; i += 10) {
    const batch = jobs.slice(i, i + 10);
    const out = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: ctx.outputs.IngestQueueUrl,
        Entries: batch.map((job, j) => ({ Id: String(j), MessageBody: JSON.stringify({ kind: 'reparse', ...job }) })),
      }),
    );
    if (out.Failed?.length) throw new Error(`failed to enqueue ${out.Failed.length} reparse jobs`);
  }
  return jobs.length;
}
