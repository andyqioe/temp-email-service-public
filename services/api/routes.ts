import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { DeleteCommand, GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { domainOf, normalizeAddress } from '../shared/address';
import { batchWrite, deleteRequests } from '../shared/ddb';
import { contentDisposition } from '../shared/http';
import { listingKeys } from '../shared/index-items';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { assertMessageId, BY_INDEXED_AT, ddbKeys, META, s3Keys } from '../shared/keys';
import { matchParsers } from '../shared/routing';
import type { AttachmentMeta, ParsedEmail, ParserRoute, ParserState, ReparseJob } from '../shared/types';

export interface ApiDeps {
  s3: S3Client;
  ddb: DynamoDBDocumentClient;
  sqs: SQSClient;
  bucket: string;
  table: string;
  /** Reparse jobs go to the ingest queue, which runs parsers. */
  ingestQueueUrl: string;
  domains: string[];
  routes: ParserRoute[];
  now: () => Date;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const PRESIGN_SECONDS = 300;
/**
 * `since` polling returns entries by the time they were indexed. A writer computes that
 * time just before its write lands, so the cursor handed back never moves past
 * "now - SINCE_OVERLAP_MS"; clients see a few repeats (dedupe by id) and never miss one.
 */
export const SINCE_OVERLAP_MS = 10_000;

type Query = Record<string, string | undefined>;

// ---- listings -------------------------------------------------------------------------

export async function listInbox(deps: ApiDeps, rawAddress: string, q: Query) {
  const address = parseAddress(deps, rawAddress);
  return listPartition(deps, ddbKeys.address(address), q, { allowSince: true });
}

export async function listFeed(deps: ApiDeps, q: Query) {
  const date = q.date ?? deps.now().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'bad_request', 'date must be YYYY-MM-DD');
  let domain = q.domain?.toLowerCase();
  if (!domain) {
    if (deps.domains.length !== 1) throw new HttpError(400, 'bad_request', `domain is required (one of ${deps.domains.join(', ')})`);
    domain = deps.domains[0]!;
  }
  if (!deps.domains.includes(domain)) throw new HttpError(404, 'not_found', `${domain} is not a receiving domain`);
  const page = await listPartition(deps, ddbKeys.feed(domain, date), q, { allowSince: false });
  return { date, domain, ...page };
}

async function listPartition(deps: ApiDeps, pk: string, q: Query, opts: { allowSince: boolean }) {
  const limit = parseLimit(q.limit);
  if (q.since !== undefined) {
    if (!opts.allowSince) throw new HttpError(400, 'bad_request', 'since is not supported here');
    if (q.before !== undefined) throw new HttpError(400, 'bad_request', 'use either since or before, not both');
    const since = q.since;
    const out = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.table,
        IndexName: BY_INDEXED_AT,
        KeyConditionExpression: 'pk = :pk AND ix > :since',
        ...notExpired(),
        ExpressionAttributeValues: { ':pk': pk, ':since': since, ':now': nowSeconds(deps) },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    const items = out.Items ?? [];
    const lastIx = items.at(-1)?.ix as string | undefined;
    let nextSince: string;
    if (out.LastEvaluatedKey?.ix) {
      // More entries are waiting (some may have been filtered as expired); continue from there.
      nextSince = out.LastEvaluatedKey.ix as string;
    } else {
      const horizon = new Date(deps.now().getTime() - SINCE_OVERLAP_MS).toISOString();
      const candidate = lastIx !== undefined && lastIx < horizon ? lastIx : horizon;
      nextSince = candidate > since ? candidate : since;
    }
    return { messages: items.map(toListing), nextSince };
  }

  const before = q.before;
  const out = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.table,
      KeyConditionExpression: before ? 'pk = :pk AND sk < :before' : 'pk = :pk',
      ...notExpired(),
      ExpressionAttributeValues: { ':pk': pk, ':now': nowSeconds(deps), ...(before ? { ':before': before } : {}) },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  const items = out.Items ?? [];
  const nextBefore = out.LastEvaluatedKey ? (out.LastEvaluatedKey.sk as string) : null;
  return { messages: items.map(toListing), nextBefore };
}

function toListing(item: Record<string, unknown>) {
  const { pk: _pk, sk, ix, ttl: _ttl, ...rest } = item;
  return { ...rest, cursor: sk, indexedCursor: ix };
}

// ---- single message -------------------------------------------------------------------

export async function getMessage(deps: ApiDeps, rawId: string) {
  const msg = await loadMessage(deps, rawId);
  const parsed = await loadParsed(deps, msg.id as string);
  const parsers = await loadParserStates(deps, msg);
  return {
    id: parsed.id,
    receivedAt: parsed.receivedAt,
    size: parsed.size,
    recipients: parsed.envelope.recipients,
    envelopeFrom: parsed.envelope.from,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    replyTo: parsed.replyTo,
    date: parsed.date ?? null,
    headerMessageId: parsed.headerMessageId ?? null,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    headers: parsed.headers,
    attachments: parsed.attachments.map(({ key, ...a }) => ({ ...a, downloadable: key !== undefined })),
    verdicts: parsed.verdicts,
    spam: parsed.verdicts.spam === 'FAIL',
    virus: parsed.verdicts.virus === 'FAIL',
    parseError: parsed.parseError ?? null,
    parsers,
  };
}

export async function rawUrl(deps: ApiDeps, rawId: string) {
  const msg = await loadMessage(deps, rawId);
  assertNotVirus(msg);
  const raw = msg.raw as { bucket: string; key: string };
  return presign(deps, raw.bucket, raw.key, `${msg.id as string}.eml`);
}

export async function attachmentUrl(deps: ApiDeps, rawId: string, rawIndex: string) {
  const msg = await loadMessage(deps, rawId);
  assertNotVirus(msg);
  const index = Number(rawIndex);
  const a = (msg.attachments as AttachmentMeta[] | undefined)?.find((x) => x.index === index);
  if (!Number.isInteger(index) || !a) throw new HttpError(404, 'not_found', 'no such attachment');
  if (!a.key) throw new HttpError(409, 'attachment_unavailable', 'attachment was not extracted');
  return { ...(await presign(deps, deps.bucket, a.key, a.filename ?? `attachment-${index}`)), filename: a.filename ?? null, contentType: a.contentType, size: a.size };
}

/** Deletes listings first (so the message disappears), then content, then MSG# last so a failed delete can be retried. */
export async function deleteMessage(deps: ApiDeps, rawId: string) {
  const msg = await loadMessage(deps, rawId);
  const id = msg.id as string;
  await batchWrite(deps.ddb, deps.table, deleteRequests(listingKeys({ id, receivedAt: msg.receivedAt as string, recipients: msg.recipients as string[] })));

  const keys: string[] = [(msg.raw as { key: string }).key];
  for (const prefix of [s3Keys.messagePrefix(id), s3Keys.attachmentPrefix(id)]) {
    let token: string | undefined;
    do {
      const page = await deps.s3.send(new ListObjectsV2Command({ Bucket: deps.bucket, Prefix: prefix, ContinuationToken: token }));
      keys.push(...(page.Contents ?? []).map((o) => o.Key!));
      token = page.NextContinuationToken;
    } while (token);
  }
  for (let i = 0; i < keys.length; i += 1000) {
    const out = await deps.s3.send(
      new DeleteObjectsCommand({ Bucket: deps.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
    );
    if (out.Errors && out.Errors.length > 0) throw new Error(`failed to delete ${out.Errors.length} objects`);
  }
  await deps.ddb.send(new DeleteCommand({ TableName: deps.table, Key: { pk: ddbKeys.message(id), sk: META } }));
  return { deleted: id };
}

/** Re-runs parsers. Without `parser`, re-evaluates routing with the current config; with it, forces that parser. */
export async function reparse(deps: ApiDeps, rawId: string, parser: string | undefined) {
  const msg = await loadMessage(deps, rawId);
  assertNotVirus(msg);
  const id = msg.id as string;
  let names: string[];
  if (parser) {
    if (!deps.routes.some((r) => r.name === parser)) throw new HttpError(400, 'bad_request', `unknown parser ${parser}`);
    names = [parser];
  } else {
    const parsed = await loadParsed(deps, id);
    names = matchParsers(deps.routes, {
      recipients: parsed.envelope.recipients,
      from: parsed.from[0]?.address,
      subject: parsed.subject,
      dmarc: parsed.verdicts.dmarc,
      spam: parsed.verdicts.spam === 'FAIL',
      virus: false,
    }).map((m) => m.parser);
  }
  if (names.length > 0) {
    // Ingest marks them pending and runs them; if this send fails the caller gets a 500 and retries.
    const job: ReparseJob = { kind: 'reparse', id, parsers: names };
    await deps.sqs.send(new SendMessageCommand({ QueueUrl: deps.ingestQueueUrl, MessageBody: JSON.stringify(job) }));
  }
  return { id, enqueued: names };
}

/** Time budget for one request; the CLI repeats the call while `more` is true. */
const DELETE_BUDGET_MS = 20_000;

/** Deletes every message delivered to an address (and each one everywhere else it landed). */
export async function deleteInbox(deps: ApiDeps, rawAddress: string) {
  const address = parseAddress(deps, rawAddress);
  const started = Date.now();
  let deleted = 0;
  for (;;) {
    const page = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': ddbKeys.address(address) },
        ProjectionExpression: 'pk, sk, id',
        Limit: 25,
      }),
    );
    const items = page.Items ?? [];
    if (items.length === 0) return { address, deleted, more: false };
    for (const item of items) {
      try {
        await deleteMessage(deps, item.id as string);
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
        // Orphaned listing (message already gone): drop just the listing.
        await deps.ddb.send(new DeleteCommand({ TableName: deps.table, Key: { pk: item.pk, sk: item.sk } }));
      }
      deleted++;
      if (Date.now() - started > DELETE_BUDGET_MS) return { address, deleted, more: true };
    }
  }
}

// ---- helpers --------------------------------------------------------------------------

async function loadMessage(deps: ApiDeps, rawId: string): Promise<Record<string, unknown>> {
  let id: string;
  try {
    id = assertMessageId(decodePathParam(rawId));
  } catch {
    throw new HttpError(400, 'bad_request', 'invalid message id');
  }
  const { Item } = await deps.ddb.send(new GetCommand({ TableName: deps.table, Key: { pk: ddbKeys.message(id), sk: META } }));
  if (!Item) throw new HttpError(404, 'not_found', 'no such message');
  if (typeof Item.ttl === 'number' && Item.ttl <= nowSeconds(deps)) throw new HttpError(404, 'expired', 'message has expired');
  return Item;
}

async function loadParsed(deps: ApiDeps, id: string): Promise<ParsedEmail> {
  try {
    const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: s3Keys.parsed(id) }));
    return JSON.parse(await obj.Body!.transformToString()) as ParsedEmail;
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') throw new HttpError(404, 'expired', 'message content has expired');
    throw err;
  }
}

/** DynamoDB TTL deletes lazily, so reads hide expired items themselves. */
function notExpired() {
  return { FilterExpression: 'attribute_not_exists(#ttl) OR #ttl > :now', ExpressionAttributeNames: { '#ttl': 'ttl' } };
}

function nowSeconds(deps: ApiDeps): number {
  return Math.floor(deps.now().getTime() / 1000);
}

async function loadParserStates(deps: ApiDeps, msg: Record<string, unknown>) {
  const id = msg.id as string;
  const entries = Object.entries(msg).filter(([k]) => k.startsWith('p_'));
  const states = await Promise.all(
    entries.map(async ([attr, value]) => {
      const name = attr.slice(2);
      const state = value as ParserState;
      let output: unknown;
      if (state.status === 'ok') {
        try {
          const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: s3Keys.parserOutput(id, name) }));
          output = (JSON.parse(await obj.Body!.transformToString()) as { output: unknown }).output;
        } catch (err) {
          if ((err as { name?: string }).name !== 'NoSuchKey') throw err;
        }
      }
      return [name, { ...state, ...(output === undefined ? {} : { output }) }] as const;
    }),
  );
  return Object.fromEntries(states);
}

function assertNotVirus(msg: Record<string, unknown>) {
  if ((msg.verdicts as { virus?: string } | undefined)?.virus === 'FAIL') {
    throw new HttpError(409, 'virus_detected', 'SES flagged this message as containing a virus; downloads are disabled');
  }
}

async function presign(deps: ApiDeps, bucket: string, key: string, filename: string) {
  const url = await getSignedUrl(
    deps.s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: contentDisposition(filename),
    }),
    { expiresIn: PRESIGN_SECONDS },
  );
  return { url, expiresIn: PRESIGN_SECONDS };
}

function parseAddress(deps: ApiDeps, raw: string): string {
  const address = normalizeAddress(decodePathParam(raw));
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new HttpError(400, 'bad_request', 'invalid address');
  if (!deps.domains.includes(domainOf(address))) {
    throw new HttpError(404, 'not_found', `${domainOf(address)} is not a receiving domain`);
  }
  return address;
}

/**
 * API Gateway may or may not have decoded the path segment. An encoded address has no
 * literal "@" (it is %40), so decode only then; ids never contain "%" or "@".
 */
export function decodePathParam(value: string): string {
  if (!value.includes('%') || value.includes('@')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new HttpError(400, 'bad_request', `limit must be 1-${MAX_LIMIT}`);
  return n;
}
