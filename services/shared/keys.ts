/**
 * Every S3 key and DynamoDB key in the system is built here, so the ingest path,
 * the API, the CLI, and reindex can never disagree about layout.
 */

/** SES message ids are [0-9a-z-]; injected test ids add a few more safe characters. Never contains "/". */
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function assertMessageId(id: string): string {
  if (!MESSAGE_ID_PATTERN.test(id) || id.includes('..')) throw new Error(`invalid message id: ${id}`);
  return id;
}

export const s3Keys = {
  rawPrefix: 'raw/',
  messagePrefix: (id: string) => `messages/${id}/`,
  receipt: (id: string) => `messages/${id}/receipt.json`,
  parsed: (id: string) => `messages/${id}/parsed.json`,
  parserOutputPrefix: (id: string) => `messages/${id}/parsers/`,
  parserOutput: (id: string, parser: string) => `messages/${id}/parsers/${parser}.json`,
  attachmentPrefix: (id: string) => `attachments/${id}/`,
  attachment: (id: string, index: number) => `attachments/${id}/${index}`,
};

export const META = 'META';

/** GSI on the accounts table: every account of one service, newest first. */
export const ACCOUNTS_BY_SERVICE = 'byService';

/** GSI on the accounts table: every account, newest first (one partition; entry is by hand). */
export const ACCOUNTS_BY_CREATED = 'byCreated';

/** LSI on the listing items, sorted by when each entry was (re)written. */
export const BY_INDEXED_AT = 'byIndexedAt';

export const ddbKeys = {
  address: (address: string) => `ADDR#${address}`,
  feed: (domain: string, day: string) => `FEED#${domain}#${day}`,
  message: (id: string) => `MSG#${id}`,
  token: (hash: string) => `TOKEN#${hash}`,
  tokenIndex: 'TOKENS',
  breaker: 'STATE#breaker',
  /** Base-table sort key for listings: newest-first by SES receipt time; stable across retries. */
  sort: (receivedAt: string, id: string) => `${receivedAt}#${id}`,
  /** Sort key of the byIndexedAt LSI: when the entry was (re)written. Drives `since` polling. */
  indexed: (indexedAt: string, id: string) => `${indexedAt}#${id}`,
};

/** Status attribute for one parser on the MSG# item (top-level so updates never collide). */
export function parserAttr(parser: string): string {
  return `p_${parser}`;
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Normalizes any timestamp SES gives us to a fixed-width ISO string so keys sort correctly. */
export function normalizeTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${ts}`);
  return d.toISOString();
}
