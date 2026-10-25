import { z } from 'zod';
import type { ReparseJob, Verdicts } from './types';

const verdict = z.looseObject({ status: z.string() });

/**
 * The notification SES publishes (via the S3 action's topic) after it stores a message.
 * It carries no content, but it is the only source of the envelope recipients (incl. BCC).
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html
 */
export const receivedNotificationSchema = z.looseObject({
  notificationType: z.literal('Received'),
  mail: z.looseObject({
    timestamp: z.string(),
    source: z.string(),
    messageId: z.string(),
    destination: z.array(z.string()).default([]),
    headersTruncated: z.boolean().optional(),
    commonHeaders: z
      .looseObject({
        from: z.array(z.string()).optional(),
        subject: z.string().optional(),
        date: z.string().optional(),
        messageId: z.string().optional(),
      })
      .default({}),
  }),
  receipt: z.looseObject({
    timestamp: z.string(),
    recipients: z.array(z.string()).min(1),
    spamVerdict: verdict.optional(),
    virusVerdict: verdict.optional(),
    spfVerdict: verdict.optional(),
    dkimVerdict: verdict.optional(),
    dmarcVerdict: verdict.optional(),
    action: z.looseObject({
      type: z.literal('S3'),
      bucketName: z.string(),
      objectKey: z.string(),
    }),
  }),
});

export type ReceivedNotification = z.output<typeof receivedNotificationSchema>;

export type NotificationParseResult =
  | { kind: 'received'; notification: ReceivedNotification; json: string }
  | { kind: 'reparse'; job: ReparseJob }
  | { kind: 'ignored'; reason: string };

const reparseJobSchema = z.object({
  kind: z.literal('reparse'),
  id: z.string().min(1),
  parsers: z.array(z.string().min(1)).optional(),
});

/**
 * Accepts either the raw SES JSON (SNS raw message delivery) or an SNS envelope,
 * and classifies it. Anything that is not a well-formed `Received` notification for
 * a stored message is ignored rather than retried: retrying cannot fix it.
 */
export function parseNotification(body: string): NotificationParseResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { kind: 'ignored', reason: 'body is not JSON' };
  }
  if (isRecord(value) && value.Type === 'Notification' && typeof value.Message === 'string') {
    return parseNotification(value.Message);
  }
  if (!isRecord(value)) return { kind: 'ignored', reason: 'body is not an object' };
  if (value.kind === 'reparse') {
    const job = reparseJobSchema.safeParse(value);
    return job.success ? { kind: 'reparse', job: job.data } : { kind: 'ignored', reason: 'malformed reparse job' };
  }
  if (value.notificationType !== 'Received') {
    return { kind: 'ignored', reason: `notificationType ${String(value.notificationType)}` };
  }
  const parsed = receivedNotificationSchema.safeParse(value);
  if (!parsed.success) return { kind: 'ignored', reason: `malformed notification: ${parsed.error.message}` };
  if (parsed.data.receipt.action.objectKey.endsWith('AMAZON_SES_SETUP_NOTIFICATION')) {
    return { kind: 'ignored', reason: 'SES setup notification' };
  }
  return { kind: 'received', notification: parsed.data, json: JSON.stringify(value) };
}

export function verdictsOf(n: ReceivedNotification): Verdicts {
  const r = n.receipt;
  return {
    spf: r.spfVerdict?.status ?? 'GRAY',
    dkim: r.dkimVerdict?.status ?? 'GRAY',
    dmarc: r.dmarcVerdict?.status ?? 'GRAY',
    spam: r.spamVerdict?.status ?? 'DISABLED',
    virus: r.virusVerdict?.status ?? 'DISABLED',
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
