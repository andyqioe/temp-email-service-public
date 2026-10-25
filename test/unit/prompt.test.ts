import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { confirmTokenSetup, readLine } from '../../cli/prompt';

const tricky = `R..$ecret !x "q" 'y' \\z`;

describe('readLine', () => {
  it('reads the first piped line exactly, with no shell in between', async () => {
    const input = new PassThrough();
    input.end(`${tricky}\nsecond line\n`);
    expect(await readLine('password: ', input, new PassThrough())).toBe(tricky);
  });

  it('prompts in a terminal and returns what was typed', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let shown = '';
    output.on('data', (d: Buffer) => (shown += d.toString()));
    const answer = readLine('password for jagex: ', input, output);
    input.write(`${tricky}\r`);
    expect(await answer).toBe(tricky);
    expect(shown).toContain('password for jagex: ');
  });
});

describe('token setup confirmation', () => {
  it.each([['', false], ['n', false], ['yes', true], ['Y', true]])('requires explicit consent: %s', async (answer, expected) => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let shown = '';
    output.on('data', (data: Buffer) => { shown += data.toString(); });
    const result = confirmTokenSetup(input, output);
    input.write(`${answer}\r`);
    expect(await result).toBe(expected);
    expect(shown).toContain('[y/N]');
    expect(shown).toContain('AWS authentication once');
  });
  it('refuses piped consent', async () => {
    const input = new PassThrough();
    input.end('yes\n');
    await expect(confirmTokenSetup(input, new PassThrough())).rejects.toThrow('in a terminal');
  });
});
