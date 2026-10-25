import { isMainThread } from 'node:worker_threads';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { ddb, s3 } from '../shared/aws';
import { intEnv, jsonEnv, requireEnv } from '../shared/env';
import { errorMessage, log } from '../shared/log';
import { parseNotification } from '../shared/notification';
import { s3Signer } from '../shared/parser-input';
import type { ParserRoute } from '../shared/types';
import { ingest, reparse, type IngestDeps } from './ingest';
import { parserWorkerMain, runParserInWorker } from './parser-worker';

// The bundle is also loaded as the parser worker thread (see parser-worker.ts).
if (!isMainThread) void parserWorkerMain();

const bucket = requireEnv('BUCKET');
const deps: IngestDeps = {
  s3,
  ddb,
  bucket,
  table: requireEnv('TABLE'),
  domains: jsonEnv<string[]>('DOMAINS'),
  addressAllowlist: jsonEnv<string[] | null>('ADDRESS_ALLOWLIST', null) ?? undefined,
  routes: jsonEnv<ParserRoute[]>('PARSERS', []),
  retentionHours: intEnv('RETENTION_HOURS', 24),
  sign: s3Signer(s3, bucket),
  runModule: runParserInWorker,
  now: () => new Date(),
};

/**
 * The event source mapping delivers one record per invocation. Only transient failures are
 * reported back to SQS; malformed input and parser failures are handled inside.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const parsed = parseNotification(record.body);
      if (parsed.kind === 'ignored') {
        log('warn', 'notification ignored', { sqsMessageId: record.messageId, reason: parsed.reason });
      } else if (parsed.kind === 'reparse') {
        const outcome = await reparse(parsed.job, deps);
        log('info', `message ${outcome.status}`, { ...outcome });
      } else {
        const outcome = await ingest(parsed.notification, parsed.json, deps);
        log('info', `message ${outcome.status}`, { ...outcome });
      }
    } catch (err) {
      log('error', 'ingest failed; will retry', {
        sqsMessageId: record.messageId,
        receiveCount: record.attributes.ApproximateReceiveCount,
        error: errorMessage(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
