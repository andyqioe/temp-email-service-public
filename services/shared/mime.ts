import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { AttachmentMeta, EmailAddress } from './types';

/** Attachments beyond this count are listed in no index and never extracted. */
export const MAX_ATTACHMENTS = 100;
/** Parsing is abandoned (and recorded as a parse error) after this long. */
export const PARSE_TIMEOUT_MS = 60_000;

export interface MimeFields {
  headerMessageId?: string;
  date?: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  text?: string;
  html?: string;
  headers: Array<[string, string]>;
}

export interface ExtractedAttachment {
  meta: Omit<AttachmentMeta, 'key'>;
  content: Buffer;
}

export type MimeResult =
  | { ok: true; fields: MimeFields; attachments: ExtractedAttachment[] }
  | { ok: false; error: string };

/**
 * Parses raw MIME. Never throws: malformed input becomes `{ ok: false }` so the
 * caller can index the message with a parse error instead of retrying forever.
 */
export async function parseMime(
  raw: Buffer,
  { timeoutMs = PARSE_TIMEOUT_MS, parse = simpleParser }: { timeoutMs?: number; parse?: (raw: Buffer, options: object) => Promise<ParsedMail> } = {},
): Promise<MimeResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const mail = await Promise.race([
      parse(raw, { skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MIME parsing exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    // mailparser accepts anything; a message with no well-formed header field is not email.
    if (!mail.headerLines.some((h) => /^[!-9;-~]+$/.test(h.key))) return { ok: false, error: 'no MIME headers found' };
    return { ok: true, fields: toFields(mail), attachments: toAttachments(mail) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function toFields(mail: ParsedMail): MimeFields {
  return {
    headerMessageId: mail.messageId,
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : undefined,
    subject: mail.subject ?? '',
    from: addresses(mail.from),
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    replyTo: addresses(mail.replyTo),
    text: mail.text || undefined,
    html: typeof mail.html === 'string' && mail.html.length > 0 ? mail.html : undefined,
    headers: mail.headerLines.map(({ key, line }) => [key, headerValue(line)]),
  };
}

function toAttachments(mail: ParsedMail): ExtractedAttachment[] {
  return mail.attachments.slice(0, MAX_ATTACHMENTS).map((a, index) => ({
    meta: {
      index,
      filename: a.filename ? a.filename.slice(0, 255) : undefined,
      contentType: sanitizeContentType(a.contentType),
      size: a.size ?? a.content.length,
      contentId: a.contentId,
      inline: a.contentDisposition === 'inline' || a.related === true,
    },
    content: a.content,
  }));
}

function addresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: EmailAddress[] = [];
  const walk = (entries: AddressObject['value']) => {
    for (const e of entries) {
      if (e.group) walk(e.group);
      else if (e.address) out.push({ name: e.name ?? '', address: e.address.toLowerCase() });
    }
  };
  for (const obj of list) walk(obj.value);
  return out;
}

/** "Subject: hello\r\n world" -> "hello world" */
function headerValue(line: string): string {
  const colon = line.indexOf(':');
  const value = colon === -1 ? line : line.slice(colon + 1);
  return value.replace(/\r?\n[ \t]+/g, ' ').trim();
}

export function sanitizeContentType(ct: string | undefined): string {
  const value = (ct ?? '').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) ? value : 'application/octet-stream';
}

export { snippetOf, truncate, formatAddress } from './message-text';
