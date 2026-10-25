import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMime, sanitizeContentType, snippetOf } from '../../services/shared/mime';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

describe('parseMime', () => {
  it('parses a plain message', async () => {
    const r = await parseMime(fixture('plain.eml'));
    if (!r.ok) throw new Error(r.error);
    expect(r.fields.subject).toBe('Your verification code');
    expect(r.fields.from).toEqual([{ name: 'Alice Sender', address: 'alice@example.org' }]);
    expect(r.fields.to).toEqual([{ name: '', address: 'bob@in.example.com' }]);
    expect(r.fields.text).toContain('482913');
    expect(r.fields.headerMessageId).toBe('<plain-1@example.org>');
    expect(r.fields.date).toBe('2026-09-22T10:00:00.000Z');
    expect(r.fields.headers.find(([k]) => k === 'subject')?.[1]).toBe('Your verification code');
  });

  it('decodes encoded words, alternatives, and attachments without trusting filenames', async () => {
    const r = await parseMime(fixture('multipart-attachments.eml'));
    if (!r.ok) throw new Error(r.error);
    expect(r.fields.subject).toBe('Ørder confirmed ✓');
    expect(r.fields.to.map((a) => a.address)).toEqual(['carol+orders@in.example.com', 'dave@in.example.com']);
    expect(r.fields.cc.map((a) => a.address)).toEqual(['erin@elsewhere.example.net']);
    expect(r.fields.html).toContain('<a href=');
    expect(r.fields.text).toContain('✓ done');
    expect(r.attachments.map((a) => [a.meta.index, a.meta.filename, a.meta.contentType])).toEqual([
      [0, 'invoice.pdf', 'application/pdf'],
      [1, '../../etc/passwd', 'text/plain'],
    ]);
    expect(r.attachments[0]!.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('decodes legacy charsets', async () => {
    const r = await parseMime(fixture('latin1.eml'));
    if (!r.ok) throw new Error(r.error);
    expect(r.fields.subject).toBe('Código de verificación');
    expect(r.fields.from[0]).toEqual({ name: 'José García', address: 'jose@example.es' });
    expect(r.fields.text).toContain('Su código es: 7731 04');
  });

  it('tolerates broken multipart and bad base64', async () => {
    const r = await parseMime(fixture('broken-multipart.eml'));
    if (!r.ok) throw new Error(r.error);
    expect(r.fields.text).toContain('Body text before a broken part.');
    expect(r.attachments).toHaveLength(1);
  });

  it('flattens address groups and keeps forwarded messages as attachments', async () => {
    const r = await parseMime(fixture('group-and-nested.eml'));
    if (!r.ok) throw new Error(r.error);
    expect(r.fields.to).toEqual([]);
    expect(r.attachments[0]!.meta.contentType).toBe('message/rfc822');
  });

  it('reports input with no header fields as a parse error instead of throwing', async () => {
    const r = await parseMime(fixture('malformed.eml'));
    expect(r).toEqual({ ok: false, error: 'no MIME headers found' });
  });

  it('gives up on parsing after the timeout', async () => {
    const hang = () => new Promise<never>(() => undefined);
    const r = await parseMime(fixture('plain.eml'), { timeoutMs: 10, parse: hang });
    expect(r).toEqual({ ok: false, error: 'MIME parsing exceeded 10 ms' });
  });
});

describe('helpers', () => {
  it('sanitizes content types', () => {
    expect(sanitizeContentType('Application/PDF')).toBe('application/pdf');
    expect(sanitizeContentType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream');
    expect(sanitizeContentType(undefined)).toBe('application/octet-stream');
  });

  it('builds collapsed snippets', () => {
    expect(snippetOf('  a\n\n b\t c ')).toBe('a b c');
    expect(snippetOf('x'.repeat(300))).toHaveLength(200);
  });
});
