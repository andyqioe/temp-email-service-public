/** SES verdict status values, as they appear in the receipt notification. */
export type VerdictStatus = 'PASS' | 'FAIL' | 'GRAY' | 'PROCESSING_FAILED' | 'DISABLED' | string;

export interface Verdicts {
  spf: VerdictStatus;
  dkim: VerdictStatus;
  dmarc: VerdictStatus;
  spam: VerdictStatus;
  virus: VerdictStatus;
}

export interface EmailAddress {
  name: string;
  address: string;
}

export interface AttachmentMeta {
  index: number;
  filename?: string;
  contentType: string;
  size: number;
  contentId?: string;
  inline: boolean;
  /** S3 key of the extracted bytes. Absent when extraction was skipped (virus verdict FAIL). */
  key?: string;
}

/** Canonical parsed form of one received message, stored at messages/<id>/parsed.json. */
export interface ParsedEmail {
  version: 1;
  id: string;
  receivedAt: string;
  size: number;
  envelope: {
    from: string;
    recipients: string[];
  };
  headerMessageId?: string;
  date?: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  text?: string;
  /** Untrusted HTML as sent. Never render it without sanitizing. */
  html?: string;
  headers: Array<[string, string]>;
  attachments: AttachmentMeta[];
  verdicts: Verdicts;
  /** Set when the MIME could not be parsed; the raw message is still stored. */
  parseError?: string;
  raw: { bucket: string; key: string };
}

/** Compact per-inbox listing entry (ADDR# and FEED# items). */
export interface MessageSummary {
  id: string;
  receivedAt: string;
  from: string;
  subject: string;
  snippet: string;
  size: number;
  attachments: number;
  spam: boolean;
  virus: boolean;
  parseError: boolean;
}

export type ParserStatus = 'pending' | 'ok' | 'error';

export interface ParserState {
  status: ParserStatus;
  attempts: number;
  updatedAt: string;
  error?: string;
}

/** A request to re-run parsers on a stored message; travels on the ingest queue. */
export interface ReparseJob {
  kind: 'reparse';
  id: string;
  /** Force exactly these parsers. Omitted: re-evaluate the routing rules. */
  parsers?: string[];
}

/** Parser routing config as shipped to the Lambdas in the PARSERS environment variable. */
export interface ParserRoute {
  name: string;
  /** Key of PARSER_MODULES in parsers/registry.ts. */
  module: string;
  timeoutSeconds: number;
  match: {
    recipient?: string | string[];
    from?: string | string[];
    subject?: string;
  };
  requireDmarcForFrom: boolean;
  skipSpam: boolean;
}
