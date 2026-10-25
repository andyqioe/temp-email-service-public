import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { MAX_PARSER_OUTPUT_BYTES } from '@ses-inbox/parser-sdk';
import { ddbKeys, META, parserAttr, s3Keys } from '../shared/keys';
import { errorMessage, log } from '../shared/log';
import { buildParserInput, type Signer } from '../shared/parser-input';
import type { ParsedEmail, ParserRoute, ParserState } from '../shared/types';

/** Runs a parser module with a hard time limit (a worker thread in Lambda, in-thread in tests). */
export type ModuleRunner = (module: string, input: unknown, timeoutMs: number) => Promise<unknown>;

export interface ParserRunDeps {
  s3: S3Client;
  ddb: DynamoDBDocumentClient;
  bucket: string;
  table: string;
  routes: ParserRoute[];
  sign: Signer;
  runModule: ModuleRunner;
  now: () => Date;
}

export interface ParserRequest {
  parser: string;
  matchedRecipients: string[];
}

export type ParserRunResult = { parser: string; status: 'ok' | 'error' | 'skipped'; error?: string };

/**
 * Runs parsers for one message in parallel and records each outcome on the MSG# item.
 * A parser's own failure (exception, timeout, oversized output) is recorded as `error` and not
 * retried: parsers are pure, so a retry would fail the same way. Infrastructure failures
 * (S3, DynamoDB) throw, so the SQS message is redelivered; parsers already `ok` are skipped then.
 */
export async function runParsers(
  deps: ParserRunDeps,
  parsed: ParsedEmail,
  requests: ParserRequest[],
  existing: Record<string, unknown> | undefined,
  opts: { force?: boolean } = {},
): Promise<ParserRunResult[]> {
  return Promise.all(
    requests.map(async ({ parser, matchedRecipients }): Promise<ParserRunResult> => {
      const previous = existing?.[parserAttr(parser)] as ParserState | undefined;
      if (!opts.force && previous?.status === 'ok') return { parser, status: 'skipped' };
      const attempts = (previous?.attempts ?? 0) + 1;
      const route = deps.routes.find((r) => r.name === parser);
      if (!route) {
        const error = 'parser is not configured';
        await setParserState(deps, parsed.id, parser, { status: 'error', attempts, updatedAt: deps.now().toISOString(), error });
        return { parser, status: 'error', error };
      }

      const started = Date.now();
      let output: unknown;
      let failure: string | undefined;
      try {
        const input = await buildParserInput(parsed, parser, matchedRecipients, deps.sign);
        output = (await deps.runModule(route.module, input, route.timeoutSeconds * 1000)) ?? null;
        const size = Buffer.byteLength(JSON.stringify(output));
        if (size > MAX_PARSER_OUTPUT_BYTES) failure = `output is ${size} bytes; the limit is ${MAX_PARSER_OUTPUT_BYTES}`;
      } catch (err) {
        failure = errorMessage(err).slice(0, 500);
      }
      const ms = Date.now() - started;
      const updatedAt = deps.now().toISOString();

      if (failure !== undefined) {
        log('warn', 'parser run', { parser, status: 'error', ms, id: parsed.id, error: failure });
        await setParserState(deps, parsed.id, parser, { status: 'error', attempts, updatedAt, error: failure });
        return { parser, status: 'error', error: failure };
      }
      await deps.s3.send(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: s3Keys.parserOutput(parsed.id, parser),
          Body: JSON.stringify({ parser, messageId: parsed.id, attempt: attempts, completedAt: updatedAt, output }),
          ContentType: 'application/json',
        }),
      );
      await setParserState(deps, parsed.id, parser, { status: 'ok', attempts, updatedAt });
      log('info', 'parser run', { parser, status: 'ok', ms, id: parsed.id });
      return { parser, status: 'ok' };
    }),
  );
}

/** Records a parser state on the MSG# item without resurrecting a deleted message. */
export async function setParserState(
  deps: Pick<ParserRunDeps, 'ddb' | 'table'>,
  id: string,
  parser: string,
  state: ParserState,
): Promise<void> {
  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.table,
        Key: { pk: ddbKeys.message(id), sk: META },
        UpdateExpression: 'SET #p = :s',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#p': parserAttr(parser) },
        ExpressionAttributeValues: { ':s': state },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}
