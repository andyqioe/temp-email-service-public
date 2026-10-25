/**
 * Contract between ses-inbox and a parser Lambda.
 *
 * A parser is any Lambda (any runtime) that accepts `ParserInputV1` as its event and
 * returns JSON. ses-inbox stores the returned value at
 * messages/<id>/parsers/<name>.json and shows it on GET /messages/<id>.
 * Throwing (or returning a Lambda function error) marks the run as failed; it is
 * retried with exponential backoff and then parked in the parse dead-letter queue.
 *
 * Parsers get no bucket permissions: everything they may read comes in the input,
 * and large content is reachable through short-lived presigned URLs.
 */

export const PARSER_INPUT_VERSION = 1;

/** Max size of the JSON a parser may return. */
export const MAX_PARSER_OUTPUT_BYTES = 1024 * 1024;

export interface EmailAddress {
  name: string;
  address: string;
}

export interface Verdicts {
  spf: string;
  dkim: string;
  /** PASS means the From domain is authenticated. Anything else means From may be forged. */
  dmarc: string;
  spam: string;
  virus: string;
}

export interface ParserAttachment {
  index: number;
  filename?: string;
  contentType: string;
  size: number;
  inline: boolean;
  /** Presigned GET URL, valid for 15 minutes. Absent when the attachment was not extracted. */
  url?: string;
}

export interface ParserInputV1 {
  version: 1;
  /** Name of the parser rule that matched. */
  parser: string;
  messageId: string;
  receivedAt: string;
  /** Every indexed envelope recipient of the message. */
  recipients: string[];
  /** The recipients this parser's rule matched. */
  matchedRecipients: string[];
  /** SMTP MAIL FROM (return path). */
  envelopeFrom: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  date?: string;
  headerMessageId?: string;
  text?: string;
  /** Untrusted HTML as sent. */
  html?: string;
  /** True when text/html were cut to fit the Lambda payload limit; fetch `rawUrl` for the full message. */
  bodyTruncated: boolean;
  headers: Array<[string, string]>;
  attachments: ParserAttachment[];
  verdicts: Verdicts;
  /** Set when the MIME could not be parsed. */
  parseError?: string;
  /** Presigned GET URL for the raw .eml, valid for 15 minutes. */
  rawUrl: string;
}

export type ParserHandler<TOutput> = (input: ParserInputV1) => TOutput | Promise<TOutput>;

/**
 * Wraps a parser function as a Lambda handler and checks the input version.
 *
 *   export const handler = defineParser(async (input) => ({ code: findCode(input.text) }));
 */
export function defineParser<TOutput>(fn: ParserHandler<TOutput>): (event: unknown) => Promise<TOutput> {
  return async (event: unknown) => {
    if (!isParserInput(event)) {
      throw new Error(`unsupported parser input (expected version ${PARSER_INPUT_VERSION})`);
    }
    return fn(event);
  };
}

export function isParserInput(event: unknown): event is ParserInputV1 {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { version?: unknown }).version === PARSER_INPUT_VERSION &&
    typeof (event as { messageId?: unknown }).messageId === 'string'
  );
}

/** Fetches the full raw message (useful when `bodyTruncated` is true). */
export async function fetchRaw(input: ParserInputV1): Promise<string> {
  const res = await fetch(input.rawUrl);
  if (!res.ok) throw new Error(`failed to fetch raw message: HTTP ${res.status}`);
  return res.text();
}
