import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { domainOf, normalizeAddress, recipientMatches } from '../shared/address';
import { batchWrite, putRequests } from '../shared/ddb';
import { buildListingItems, buildMessageUpdate, isVirus } from '../shared/index-items';
import { assertMessageId, ddbKeys, META, normalizeTimestamp, parserAttr, s3Keys } from '../shared/keys';
import { parseMime } from '../shared/mime';
import { verdictsOf, type ReceivedNotification } from '../shared/notification';
import { matchOne, matchParsers, type RoutingInput } from '../shared/routing';
import type { AttachmentMeta, ParsedEmail, ParserState, ReparseJob } from '../shared/types';
import { runParsers, setParserState, type ParserRunDeps, type ParserRunResult } from './run-parsers';

export interface IngestDeps extends ParserRunDeps {
  domains: string[];
  addressAllowlist?: string[];
  retentionHours: number;
}

export type IngestOutcome =
  | { status: 'indexed'; id: string; recipients: string[]; parsers: ParserRunResult[]; parseError?: string }
  | { status: 'dropped'; id: string; reason: string };

export type ReparseOutcome = { status: 'reparsed'; id: string; parsers: ParserRunResult[] } | { status: 'skipped'; id: string; reason: string };

/**
 * Stores, indexes, and parses one received message. Writes happen in commit order
 * (receipt -> parsed + attachments -> MSG# -> listings -> parser results) and every key
 * derives from the SES message id and receipt time, so a retry after a partial failure
 * converges instead of duplicating. Parsers run after the listings, so a slow parser never
 * delays delivery. Throws only for transient failures; the SQS retry policy handles those.
 */
export async function ingest(n: ReceivedNotification, notificationJson: string, deps: IngestDeps): Promise<IngestOutcome> {
  const id = assertMessageId(n.mail.messageId);
  const receivedAt = normalizeTimestamp(n.mail.timestamp);
  const raw = { bucket: n.receipt.action.bucketName, key: n.receipt.action.objectKey };

  const recipients = [...new Set(n.receipt.recipients.map(normalizeAddress))]
    .filter((r) => deps.domains.includes(domainOf(r)))
    .filter((r) => !deps.addressAllowlist || deps.addressAllowlist.some((g) => recipientMatches(g, r)));
  if (recipients.length === 0) {
    await deps.s3.send(new DeleteObjectCommand({ Bucket: raw.bucket, Key: raw.key }));
    return { status: 'dropped', id, reason: 'no recipient is on a configured domain and allowlisted' };
  }

  const verdicts = verdictsOf(n);
  const virus = verdicts.virus === 'FAIL';
  // Retention counts from ingest, which for real mail is seconds after receipt.
  const ttl = Math.floor(deps.now().getTime() / 1000) + deps.retentionHours * 3600;

  await putJson(deps, s3Keys.receipt(id), notificationJson);

  const obj = await deps.s3.send(new GetObjectCommand({ Bucket: raw.bucket, Key: raw.key }));
  const bytes = Buffer.from(await obj.Body!.transformToByteArray());
  const mime = await parseMime(bytes);

  const attachments: AttachmentMeta[] = [];
  if (mime.ok) {
    for (const a of mime.attachments) {
      const meta: AttachmentMeta = { ...a.meta };
      if (!virus) {
        const key = s3Keys.attachment(id, a.meta.index);
        await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: a.content, ContentType: a.meta.contentType }));
        meta.key = key;
      }
      attachments.push(meta);
    }
  }

  const common = n.mail.commonHeaders;
  const parsed: ParsedEmail = {
    version: 1,
    id,
    receivedAt,
    size: bytes.length,
    envelope: { from: n.mail.source, recipients },
    ...(mime.ok
      ? mime.fields
      : {
          // Best effort from the headers SES already parsed for us.
          headerMessageId: common.messageId,
          date: common.date,
          subject: common.subject ?? '',
          from: (common.from ?? []).map((a) => ({ name: '', address: extractAddress(a) })),
          to: [],
          cc: [],
          replyTo: [],
          headers: [],
        }),
    attachments,
    verdicts,
    ...(mime.ok ? {} : { parseError: mime.error }),
    raw,
  };
  await putJson(deps, s3Keys.parsed(id), JSON.stringify(parsed));

  const matches = matchParsers(deps.routes, routingInput(parsed));
  const nowIso = deps.now().toISOString();
  const update = buildMessageUpdate(parsed, { tableName: deps.table, parsers: matches.map((m) => m.parser), now: nowIso, ttl });
  const { Attributes } = await deps.ddb.send(new UpdateCommand(update));

  await batchWrite(deps.ddb, deps.table, putRequests(buildListingItems(parsed, { indexedAt: nowIso, ttl })));

  const results = await runParsers(
    deps,
    parsed,
    matches.map((m) => ({ parser: m.parser, matchedRecipients: m.matchedRecipients })),
    Attributes,
  );

  return {
    status: 'indexed',
    id,
    recipients,
    parsers: results,
    ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
  };
}

/**
 * Re-runs parsers on a stored message. It never rewrites listings, so a reparse does not make
 * the message look new to clients polling with `since`.
 */
export async function reparse(job: ReparseJob, deps: IngestDeps): Promise<ReparseOutcome> {
  const id = assertMessageId(job.id);
  const { Item: msg } = await deps.ddb.send(new GetCommand({ TableName: deps.table, Key: { pk: ddbKeys.message(id), sk: META } }));
  if (!msg) return { status: 'skipped', id, reason: 'message not found' };
  let parsed: ParsedEmail;
  try {
    const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: s3Keys.parsed(id) }));
    parsed = JSON.parse(await obj.Body!.transformToString()) as ParsedEmail;
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return { status: 'skipped', id, reason: 'message content has expired' };
    throw err;
  }
  if (isVirus(parsed)) return { status: 'skipped', id, reason: 'virus verdict FAIL' };

  const input = routingInput(parsed);
  const requests = job.parsers
    ? job.parsers.map((parser) => {
        const route = deps.routes.find((r) => r.name === parser);
        // A forced parser whose rule does not match sees every recipient.
        const matched = route ? matchOne(route, input)?.matchedRecipients : undefined;
        return { parser, matchedRecipients: matched ?? parsed.envelope.recipients };
      })
    : matchParsers(deps.routes, input).map((m) => ({ parser: m.parser, matchedRecipients: m.matchedRecipients }));

  const updatedAt = deps.now().toISOString();
  for (const r of requests) {
    const previous = msg[parserAttr(r.parser)] as ParserState | undefined;
    await setParserState(deps, id, r.parser, { status: 'pending', attempts: previous?.attempts ?? 0, updatedAt });
  }
  const results = await runParsers(deps, parsed, requests, msg, { force: true });
  return { status: 'reparsed', id, parsers: results };
}

export function routingInput(parsed: ParsedEmail): RoutingInput {
  return {
    recipients: parsed.envelope.recipients,
    from: parsed.from[0]?.address,
    subject: parsed.subject,
    dmarc: parsed.verdicts.dmarc,
    spam: parsed.verdicts.spam === 'FAIL',
    virus: parsed.verdicts.virus === 'FAIL',
  };
}

async function putJson(deps: Pick<IngestDeps, 's3' | 'bucket'>, key: string, body: string) {
  await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: body, ContentType: 'application/json' }));
}

/** "Name <a@b>" -> "a@b" */
function extractAddress(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  return (m?.[1] ?? value).trim().toLowerCase();
}
