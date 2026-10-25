import { describe, expect, it } from 'vitest';
import { isParserInput } from '@ses-inbox/parser-sdk';
import { buildParserInput, fitBodies } from '../../services/shared/parser-input';
import type { ParsedEmail } from '../../services/shared/types';

const parsed: ParsedEmail = {
  version: 1,
  id: 'm1',
  receivedAt: '2026-09-22T10:00:00.000Z',
  size: 100,
  envelope: { from: 'bounce@example.org', recipients: ['a@in.example.com', 'b@in.example.com'] },
  subject: 'hi',
  from: [{ name: 'A', address: 'a@example.org' }],
  to: [],
  cc: [],
  replyTo: [],
  text: 'hello',
  html: '<p>hello</p>',
  headers: [['subject', 'hi']],
  attachments: [
    { index: 0, filename: 'x.pdf', contentType: 'application/pdf', size: 3, inline: false, key: 'attachments/m1/0' },
    { index: 1, contentType: 'image/png', size: 3, inline: true },
  ],
  verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', spam: 'PASS', virus: 'PASS' },
  raw: { bucket: 'mail', key: 'raw/m1' },
};

describe('parser input', () => {
  it('carries presigned URLs only for extracted content', async () => {
    const input = await buildParserInput(parsed, 'otp', ['a@in.example.com'], async (key) => `https://signed/${key}`);
    expect(isParserInput(input)).toBe(true);
    expect(input.rawUrl).toBe('https://signed/raw/m1');
    expect(input.attachments.map((a) => a.url)).toEqual(['https://signed/attachments/m1/0', undefined]);
    expect(input.matchedRecipients).toEqual(['a@in.example.com']);
    expect(input.bodyTruncated).toBe(false);
  });

  it('keeps text first and trims HTML to fit the payload budget', () => {
    const r = fitBodies('t'.repeat(600), 'h'.repeat(600), 1000);
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(600);
    expect(JSON.stringify(r.text).length + JSON.stringify(r.html).length).toBeLessThanOrEqual(1000);
  });

  it('accounts for JSON escaping when trimming', () => {
    const r = fitBodies('\u0001'.repeat(1000), undefined, 600);
    expect(Buffer.byteLength(JSON.stringify(r.text))).toBeLessThanOrEqual(600);
  });
});
