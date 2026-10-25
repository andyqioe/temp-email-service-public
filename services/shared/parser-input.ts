import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ParserInputV1 } from '@ses-inbox/parser-sdk';
import { contentDisposition } from './http';
import type { ParsedEmail } from './types';

/** Parsers run in a worker with a small heap; bodies beyond this are trimmed and flagged. */
export const BODY_BUDGET_BYTES = 1024 * 1024;
export const HEADER_BUDGET_BYTES = 256 * 1024;
export const PRESIGN_SECONDS = 15 * 60;

export type Signer = (key: string, filename?: string) => Promise<string>;

/** Presigned GET URLs that force a download, so a browser never renders mail content. */
export function s3Signer(s3: S3Client, bucket: string): Signer {
  return (key, filename) =>
    getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: contentDisposition(filename ?? 'attachment'),
      }),
      { expiresIn: PRESIGN_SECONDS },
    );
}

export async function buildParserInput(
  p: ParsedEmail,
  parser: string,
  matchedRecipients: string[],
  sign: Signer,
  bodyBudget = BODY_BUDGET_BYTES,
): Promise<ParserInputV1> {
  const bodies = fitBodies(p.text, p.html, bodyBudget);
  return {
    version: 1,
    parser,
    messageId: p.id,
    receivedAt: p.receivedAt,
    recipients: p.envelope.recipients,
    matchedRecipients,
    envelopeFrom: p.envelope.from,
    from: p.from,
    to: p.to,
    cc: p.cc,
    replyTo: p.replyTo,
    subject: p.subject,
    ...(p.date ? { date: p.date } : {}),
    ...(p.headerMessageId ? { headerMessageId: p.headerMessageId } : {}),
    ...(bodies.text !== undefined ? { text: bodies.text } : {}),
    ...(bodies.html !== undefined ? { html: bodies.html } : {}),
    bodyTruncated: bodies.truncated,
    headers: capHeaders(p.headers, HEADER_BUDGET_BYTES),
    attachments: await Promise.all(
      p.attachments.map(async (a) => ({
        index: a.index,
        ...(a.filename ? { filename: a.filename } : {}),
        contentType: a.contentType,
        size: a.size,
        inline: a.inline,
        ...(a.key ? { url: await sign(a.key, a.filename) } : {}),
      })),
    ),
    verdicts: p.verdicts,
    ...(p.parseError ? { parseError: p.parseError } : {}),
    rawUrl: await sign(p.raw.key, `${p.id}.eml`),
  };
}

const jsonBytes = (s: string | undefined) => (s === undefined ? 0 : Buffer.byteLength(JSON.stringify(s)));

/** Keeps text first (most parsers want it), then as much HTML as still fits. */
export function fitBodies(text: string | undefined, html: string | undefined, budget: number) {
  if (jsonBytes(text) + jsonBytes(html) <= budget) return { text, html, truncated: false };
  const t = cutToJsonBytes(text, budget);
  const h = cutToJsonBytes(html, budget - jsonBytes(t));
  return { text: t, html: h, truncated: true };
}

function cutToJsonBytes(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  if (max <= 2) return undefined;
  let out = s;
  while (jsonBytes(out) > max) {
    out = out.slice(0, Math.floor(((out.length * max) / jsonBytes(out)) * 0.95));
  }
  return out;
}

function capHeaders(headers: Array<[string, string]>, budget: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let used = 0;
  for (const h of headers) {
    used += Buffer.byteLength(h[0]) + Buffer.byteLength(h[1]) + 8;
    if (used > budget) break;
    out.push(h);
  }
  return out;
}
