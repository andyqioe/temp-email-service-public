import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ddb, s3, sqs } from '../shared/aws';
import { intEnv, jsonEnv, requireEnv } from '../shared/env';
import { errorMessage, log } from '../shared/log';
import type { ParserRoute } from '../shared/types';
import { TokenAuthenticator } from './auth';
import {
  attachmentUrl,
  deleteInbox,
  deleteMessage,
  getMessage,
  HttpError,
  listFeed,
  listInbox,
  rawUrl,
  reparse,
  type ApiDeps,
} from './routes';

const table = requireEnv('TABLE');
const deps: ApiDeps = {
  s3,
  ddb,
  sqs,
  bucket: requireEnv('BUCKET'),
  table,
  ingestQueueUrl: requireEnv('INGEST_QUEUE_URL'),
  domains: jsonEnv<string[]>('DOMAINS'),
  routes: jsonEnv<ParserRoute[]>('PARSERS', []),
  now: () => new Date(),
};
const auth = new TokenAuthenticator(ddb, table, intEnv('TOKEN_CACHE_SECONDS', 60));

type Handler = (e: APIGatewayProxyEventV2, p: Record<string, string>, q: Record<string, string | undefined>) => Promise<unknown>;

/** Keys are API Gateway route keys, so API Gateway rejects unknown paths before invoking us. */
export const ROUTES: Record<string, Handler> = {
  'GET /inboxes/{address}/messages': (_e, p, q) => listInbox(deps, p.address!, q),
  'GET /feed': (_e, _p, q) => listFeed(deps, q),
  'GET /messages/{id}': (_e, p) => getMessage(deps, p.id!),
  'GET /messages/{id}/raw': (_e, p) => rawUrl(deps, p.id!),
  'GET /messages/{id}/attachments/{index}': (_e, p) => attachmentUrl(deps, p.id!, p.index!),
  'DELETE /messages/{id}': (_e, p) => deleteMessage(deps, p.id!),
  'DELETE /inboxes/{address}/messages': (_e, p) => deleteInbox(deps, p.address!),
  'POST /messages/{id}/reparse': (_e, p, q) => reparse(deps, p.id!, q.parser),
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId;
  try {
    const caller = await auth.authenticate(event.headers.authorization);
    if (!caller) return json(401, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });

    const route = ROUTES[event.routeKey];
    if (!route) return json(404, { error: { code: 'not_found', message: `no route ${event.routeKey}` } });

    const body = await route(event, (event.pathParameters ?? {}) as Record<string, string>, event.queryStringParameters ?? {});
    log('info', 'request', { requestId, route: event.routeKey, caller });
    return json(200, body);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: { code: err.code, message: err.message } });
    log('error', 'request failed', { requestId, route: event.routeKey, error: errorMessage(err) });
    return json(500, { error: { code: 'internal', message: 'internal error', requestId } });
  }
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
