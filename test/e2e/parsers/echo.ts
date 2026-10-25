import { createHash } from 'node:crypto';
import { defineParser } from '@ses-inbox/parser-sdk';

/**
 * E2E parser: echoes what it received and proves the presigned URLs work from inside
 * a parser Lambda (which has no bucket permissions of its own).
 */
export const handler = defineParser(async (input) => {
  const raw = await fetch(input.rawUrl);
  const attachments = await Promise.all(
    input.attachments.map(async (a) => {
      if (!a.url) return { index: a.index, sha256: null };
      const res = await fetch(a.url);
      return { index: a.index, sha256: createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex') };
    }),
  );
  return {
    parser: input.parser,
    messageId: input.messageId,
    subject: input.subject,
    from: input.from[0]?.address ?? null,
    recipients: input.recipients,
    matchedRecipients: input.matchedRecipients,
    dmarc: input.verdicts.dmarc,
    textLength: input.text?.length ?? 0,
    bodyTruncated: input.bodyTruncated,
    rawStatus: raw.status,
    rawBytes: (await raw.arrayBuffer()).byteLength,
    attachments,
    invokedAt: new Date().toISOString(),
  };
});
