/**
 * Builds the JSON SES publishes after its S3 action stores a message, in the documented
 * shape. The E2E suite uses it to inject messages SES itself would never deliver
 * (malformed MIME, virus verdicts) straight into the ingest queue.
 */
export interface FakeNotificationOptions {
  messageId: string;
  bucket: string;
  objectKey: string;
  recipients: string[];
  source?: string;
  timestamp?: string;
  subject?: string;
  from?: string;
  verdicts?: Partial<Record<'spam' | 'virus' | 'spf' | 'dkim' | 'dmarc', string>>;
}

export function fakeNotification(o: FakeNotificationOptions) {
  const timestamp = o.timestamp ?? new Date().toISOString();
  const v = { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', ...o.verdicts };
  return {
    notificationType: 'Received',
    mail: {
      timestamp,
      source: o.source ?? 'sender@example.org',
      messageId: o.messageId,
      destination: o.recipients,
      headersTruncated: false,
      headers: [],
      commonHeaders: {
        returnPath: o.source ?? 'sender@example.org',
        from: [o.from ?? 'sender@example.org'],
        date: new Date(timestamp).toUTCString(),
        to: o.recipients,
        messageId: `<${o.messageId}@example.org>`,
        subject: o.subject ?? '',
      },
    },
    receipt: {
      timestamp,
      processingTimeMillis: 100,
      recipients: o.recipients,
      spamVerdict: { status: v.spam },
      virusVerdict: { status: v.virus },
      spfVerdict: { status: v.spf },
      dkimVerdict: { status: v.dkim },
      dmarcVerdict: { status: v.dmarc },
      action: { type: 'S3', topicArn: 'arn:aws:sns:us-east-1:123456789012:inbound', bucketName: o.bucket, objectKeyPrefix: 'raw/', objectKey: o.objectKey },
    },
  };
}
