import { describe, expect, it } from 'vitest';
import { extractOtp, findCodes, findLinks } from '../../parsers/example-otp';

describe('example-otp parser', () => {
  it('prefers codes next to a keyword', () => {
    expect(findCodes('Order 20261234 shipped. Your verification code is 482913.')).toEqual(['482913', '20261234']);
    expect(findCodes('Use code ABC123 to sign in')).toEqual(['ABC123']);
    expect(findCodes('Your code:\n\n  991 204\n')).toEqual(['991204']);
  });

  it('falls back to six-digit numbers and ignores years, dates, and times', () => {
    expect(findCodes('On 2026-09-22 at 10:30 we sent 551234')).toEqual(['551234']);
    expect(findCodes('Copyright 2026')).toEqual([]);
  });

  it('ignores numbers that are part of a username or word (real Jagex password-reset mail)', () => {
    const text = "Don&apos;t worry, we all forget sometimes\n Hi hello123#1459 , \nYou&apos;ve recently asked to reset the password for this Jagex account: hello123@in.example.com";
    expect(extractOtp({ subject: 'Password Reset', text, html: undefined }).code).toBeNull();
    expect(findCodes('ref ab123456 or 123456xy')).toEqual([]);
    expect(findCodes('Your one-time number: 123456')).toEqual(['123456']);
  });

  it('finds verification links from HTML anchors and plain text', () => {
    const html = '<a href="https://x.example/verify?t=1&amp;u=2">Confirm</a> <a href="https://x.example/unsubscribe">bye</a> <a href="https://x.example/l/abc">Sign in</a>';
    expect(findLinks(html, undefined)).toEqual(['https://x.example/verify?t=1&u=2', 'https://x.example/l/abc']);
    expect(findLinks(undefined, 'Visit https://x.example/magic-link/123. Thanks')).toEqual(['https://x.example/magic-link/123']);
  });

  it('does not duplicate links that html-to-text rendered as "text [url]"', () => {
    const html = '<a href="https://x.example/verify?t=1">Verify</a>';
    expect(findLinks(html, 'Verify [https://x.example/verify?t=1]')).toEqual(['https://x.example/verify?t=1']);
  });

  it('extracts from HTML-only mail', () => {
    const r = extractOtp({ subject: 'Welcome', html: '<p>Your one-time passcode</p><p><b>731 004</b></p>' });
    expect(r.code).toBe('731004');
  });

  it('never reads codes out of URLs', () => {
    const r = extractOtp({
      subject: 'Confirm your account',
      text: 'Your verification code is\n\n738 214\n\nVerify your email [https://example.com/verify?token=abc123&pin=9981]',
    });
    expect(r).toEqual({ code: '738214', codes: ['738214'], links: ['https://example.com/verify?token=abc123&pin=9981'] });
  });
});

describe('example-otp parser on hostile input', () => {
  it('stays fast on thousands of unclosed tags', () => {
    const html = '<a href="https://x.example/verify">'.repeat(20_000) + '<script>'.repeat(20_000);
    const started = performance.now();
    extractOtp({ subject: 'x', html });
    expect(performance.now() - started).toBeLessThan(100);
  });
});
