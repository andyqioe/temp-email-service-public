import { describe, expect, it } from 'vitest';
import { extractJagexCode } from '../../parsers/jagex';

describe('jagex parser', () => {
  it('reads the code from the subject', () => {
    expect(extractJagexCode({ subject: 'AB12C is your Jagex verification code', text: '' })).toEqual({ code: 'AB12C', source: 'subject' });
    expect(extractJagexCode({ subject: '482913 is your Jagex verification code' })).toEqual({ code: '482913', source: 'subject' });
    expect(extractJagexCode({ subject: 'QWERTY is your Jagex Verification Code.' }).code).toBe('QWERTY');
  });

  it('does not mistake a word for the code', () => {
    expect(() => extractJagexCode({ subject: 'This is your Jagex verification code', text: 'Thanks' })).toThrow(/no Jagex verification code/);
  });

  it('falls back to the body, including letters-only codes', () => {
    expect(extractJagexCode({ subject: 'Verify your account', text: 'Hello,\n\nYour verification code is: KXQPZ\n' })).toEqual({ code: 'KXQPZ', source: 'body' });
    expect(extractJagexCode({ subject: 'Welcome', text: '7H3K9 is your Jagex verification code.' })).toEqual({ code: '7H3K9', source: 'body' });
  });
});
