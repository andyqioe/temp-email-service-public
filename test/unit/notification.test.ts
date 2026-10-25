import { describe, expect, it } from 'vitest';
import { parseNotification, verdictsOf } from '../../services/shared/notification';
import { fakeNotification } from '../support/ses-notification';

const n = fakeNotification({
  messageId: 'abc123',
  bucket: 'mail',
  objectKey: 'raw/abc123',
  recipients: ['Bob@In.Example.com'],
  verdicts: { spam: 'FAIL' },
});

describe('parseNotification', () => {
  it('accepts raw SES JSON', () => {
    const r = parseNotification(JSON.stringify(n));
    expect(r.kind).toBe('received');
    if (r.kind === 'received') {
      expect(r.notification.receipt.recipients).toEqual(['Bob@In.Example.com']);
      expect(verdictsOf(r.notification)).toMatchObject({ spam: 'FAIL', virus: 'PASS', dmarc: 'PASS' });
    }
  });

  it('unwraps an SNS envelope', () => {
    const r = parseNotification(JSON.stringify({ Type: 'Notification', Message: JSON.stringify(n) }));
    expect(r.kind).toBe('received');
  });

  it('ignores setup notifications, other types, and junk', () => {
    const setup = fakeNotification({ messageId: 'AMAZON_SES_SETUP_NOTIFICATION', bucket: 'b', objectKey: 'raw/AMAZON_SES_SETUP_NOTIFICATION', recipients: ['x@y.z'] });
    expect(parseNotification(JSON.stringify(setup)).kind).toBe('ignored');
    expect(parseNotification(JSON.stringify({ notificationType: 'AmazonSnsSubscriptionSucceeded' })).kind).toBe('ignored');
    expect(parseNotification('not json').kind).toBe('ignored');
    expect(parseNotification(JSON.stringify({ notificationType: 'Received', mail: {} })).kind).toBe('ignored');
  });

  it('defaults verdicts that SES omitted', () => {
    const bare = JSON.parse(JSON.stringify(n));
    delete bare.receipt.spamVerdict;
    delete bare.receipt.dmarcVerdict;
    const r = parseNotification(JSON.stringify(bare));
    if (r.kind !== 'received') throw new Error('expected received');
    expect(verdictsOf(r.notification)).toMatchObject({ spam: 'DISABLED', dmarc: 'GRAY' });
  });
});

describe('reparse jobs on the ingest queue', () => {
  it('recognizes a reparse job and rejects malformed ones', () => {
    expect(parseNotification(JSON.stringify({ kind: 'reparse', id: 'm1', parsers: ['otp'] }))).toEqual({
      kind: 'reparse',
      job: { kind: 'reparse', id: 'm1', parsers: ['otp'] },
    });
    expect(parseNotification(JSON.stringify({ kind: 'reparse' })).kind).toBe('ignored');
  });
});
