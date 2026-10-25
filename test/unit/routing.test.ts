import { describe, expect, it } from 'vitest';
import { globToRegExp, plusTagOf, recipientMatches, senderMatches } from '../../services/shared/address';
import { matchParsers } from '../../services/shared/routing';
import type { ParserRoute } from '../../services/shared/types';

const route = (name: string, match: ParserRoute['match'], extra: Partial<ParserRoute> = {}): ParserRoute => ({
  name,
  module: 'echo',
  timeoutSeconds: 5,
  match,
  requireDmarcForFrom: true,
  skipSpam: false,
  ...extra,
});

const base = { recipients: ['signup-ann@in.example.com', 'bob@in.example.com'], from: 'noreply@accounts.example.org', subject: 'Your code', dmarc: 'PASS', spam: false, virus: false };

describe('globs', () => {
  it('matches case-insensitively and escapes regex metacharacters', () => {
    expect(globToRegExp('a.b*').test('A.Bcd')).toBe(true);
    expect(globToRegExp('a.b*').test('axbcd')).toBe(false);
    expect(globToRegExp('x?z').test('xyz')).toBe(true);
  });

  it('matches recipients by local part unless the glob has an @', () => {
    expect(recipientMatches('signup-*', 'signup-ann@in.example.com')).toBe(true);
    expect(recipientMatches('signup-*', 'bob@signup-in.example.com')).toBe(false);
    expect(recipientMatches('*@in.example.com', 'bob@in.example.com')).toBe(true);
  });

  it('matches senders by domain unless the glob has an @', () => {
    expect(senderMatches('*.example.org', 'noreply@accounts.example.org')).toBe(true);
    expect(senderMatches('example.org', 'noreply@accounts.example.org')).toBe(false);
    expect(senderMatches('noreply@*', 'noreply@accounts.example.org')).toBe(true);
  });

  it('extracts plus tags', () => {
    expect(plusTagOf('carol+orders@x.com')).toBe('orders');
    expect(plusTagOf('carol@x.com')).toBeUndefined();
  });
});

describe('matchParsers', () => {
  it('runs every matching parser and reports which recipients matched', () => {
    const routes = [route('all', {}), route('signup', { recipient: 'signup-*' }), route('none', { recipient: 'nobody' })];
    expect(matchParsers(routes, base)).toEqual([
      { parser: 'all', matchedRecipients: base.recipients },
      { parser: 'signup', matchedRecipients: ['signup-ann@in.example.com'] },
    ]);
  });

  it('requires DMARC PASS for sender rules unless disabled', () => {
    const strict = route('strict', { from: '*.example.org' });
    const lax = route('lax', { from: '*.example.org' }, { requireDmarcForFrom: false });
    expect(matchParsers([strict, lax], { ...base, dmarc: 'FAIL' }).map((m) => m.parser)).toEqual(['lax']);
    expect(matchParsers([strict, lax], { ...base, dmarc: 'GRAY' }).map((m) => m.parser)).toEqual(['lax']);
    expect(matchParsers([strict], base).map((m) => m.parser)).toEqual(['strict']);
  });

  it('matches subjects as case-insensitive regular expressions', () => {
    expect(matchParsers([route('s', { subject: '^your CODE$' })], base)).toHaveLength(1);
    expect(matchParsers([route('s', { subject: '^code' })], base)).toHaveLength(0);
  });

  it('never runs on virus mail and honors skipSpam', () => {
    const routes = [route('a', {}), route('b', {}, { skipSpam: true })];
    expect(matchParsers(routes, { ...base, virus: true })).toEqual([]);
    expect(matchParsers(routes, { ...base, spam: true }).map((m) => m.parser)).toEqual(['a']);
  });

  it('accepts arrays of globs', () => {
    expect(matchParsers([route('m', { recipient: ['x-*', 'bob'] })], base)[0]?.matchedRecipients).toEqual(['bob@in.example.com']);
  });
});
