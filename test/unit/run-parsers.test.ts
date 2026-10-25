import { describe, expect, it } from 'vitest';
import { runParsers, type ParserRunDeps } from '../../services/ingest/run-parsers';
import { reparse, routingInput, type IngestDeps } from '../../services/ingest/ingest';
import { parserAttr } from '../../services/shared/keys';
import type { ParsedEmail, ParserRoute } from '../../services/shared/types';

const parsed = {
  version: 1,
  id: 'm1',
  receivedAt: '2026-09-22T10:00:00.000Z',
  size: 10,
  envelope: { from: 'x@example.org', recipients: ['a@in.example.com'] },
  subject: 'Your code is 123456',
  from: [{ name: '', address: 'x@example.org' }],
  to: [],
  cc: [],
  replyTo: [],
  text: 'Your code is 123456',
  headers: [],
  attachments: [],
  verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', spam: 'PASS', virus: 'PASS' },
  raw: { bucket: 'b', key: 'raw/m1' },
} as ParsedEmail;

const route = (name: string, module = name, timeoutSeconds = 1): ParserRoute => ({
  name,
  module,
  timeoutSeconds,
  match: {},
  requireDmarcForFrom: true,
  skipSpam: false,
});

/** Records every command; parser modules are run in-thread with a Promise.race stand-in for the worker kill. */
function fakeDeps(routes: ParserRoute[], modules: Record<string, (input: unknown) => unknown>) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const record = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => (commands.push({ name: cmd.constructor.name, input: cmd.input }), {}) };
  const deps: ParserRunDeps = {
    s3: record as unknown as ParserRunDeps['s3'],
    ddb: record as unknown as ParserRunDeps['ddb'],
    bucket: 'b',
    table: 't',
    routes,
    sign: async (key) => `https://signed/${key}`,
    runModule: (module, input, timeoutMs) =>
      Promise.race([
        Promise.resolve().then(() => modules[module]!(input)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`parser timed out after ${timeoutMs} ms`)), timeoutMs)),
      ]),
    now: () => new Date('2026-09-22T10:00:01.000Z'),
  };
  const states = () =>
    commands
      .filter((c) => c.name === 'UpdateCommand')
      .map((c) => [(c.input.ExpressionAttributeNames as Record<string, string>)['#p'], (c.input.ExpressionAttributeValues as Record<string, { status: string; error?: string }>)[':s']]);
  return { deps, commands, states };
}

describe('runParsers', () => {
  it('stores output in S3 and marks the parser ok', async () => {
    const { deps, commands, states } = fakeDeps([route('otp')], { otp: () => ({ code: '123456' }) });
    expect(await runParsers(deps, parsed, [{ parser: 'otp', matchedRecipients: ['a@in.example.com'] }], {})).toEqual([{ parser: 'otp', status: 'ok' }]);
    const put = commands.find((c) => c.name === 'PutObjectCommand')!;
    expect(put.input.Key).toBe('messages/m1/parsers/otp.json');
    expect(JSON.parse(put.input.Body as string)).toMatchObject({ parser: 'otp', attempt: 1, output: { code: '123456' } });
    expect(states()).toEqual([[parserAttr('otp'), expect.objectContaining({ status: 'ok', attempts: 1 })]]);
  });

  it('records a throwing or timed-out parser as an error without failing the others', async () => {
    const { deps, states } = fakeDeps([route('bad'), route('slow', 'slow', 0.05), route('good')], {
      bad: () => {
        throw new Error('boom');
      },
      slow: () => new Promise(() => undefined),
      good: () => ({ ok: true }),
    });
    const results = await runParsers(
      deps,
      parsed,
      ['bad', 'slow', 'good'].map((parser) => ({ parser, matchedRecipients: [] })),
      {},
    );
    expect(results.map((r) => [r.parser, r.status])).toEqual([
      ['bad', 'error'],
      ['slow', 'error'],
      ['good', 'ok'],
    ]);
    expect(results[1]!.error).toMatch(/timed out/);
    expect(states().map(([attr, s]) => [attr, (s as { status: string }).status])).toEqual(
      expect.arrayContaining([
        ['p_bad', 'error'],
        ['p_slow', 'error'],
        ['p_good', 'ok'],
      ]),
    );
  });

  it('rejects output over 1 MB', async () => {
    const { deps } = fakeDeps([route('big')], { big: () => ({ blob: 'x'.repeat(1_100_000) }) });
    const [r] = await runParsers(deps, parsed, [{ parser: 'big', matchedRecipients: [] }], {});
    expect(r).toMatchObject({ status: 'error', error: expect.stringMatching(/limit is/) });
  });

  it('skips parsers already ok unless forced, and counts attempts', async () => {
    const { deps, states } = fakeDeps([route('otp')], { otp: () => ({}) });
    const existing = { [parserAttr('otp')]: { status: 'ok', attempts: 2, updatedAt: 'x' } };
    expect(await runParsers(deps, parsed, [{ parser: 'otp', matchedRecipients: [] }], existing)).toEqual([{ parser: 'otp', status: 'skipped' }]);
    await runParsers(deps, parsed, [{ parser: 'otp', matchedRecipients: [] }], existing, { force: true });
    expect(states().at(-1)![1]).toMatchObject({ status: 'ok', attempts: 3 });
  });
});

describe('reparse', () => {
  it('marks forced parsers pending, runs them, and never rewrites listings', async () => {
    const { deps: base, commands } = fakeDeps([route('otp')], { otp: () => ({ code: '1' }) });
    const s3 = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        commands.push({ name: cmd.constructor.name, input: cmd.input });
        return cmd.constructor.name === 'GetObjectCommand' ? { Body: { transformToString: async () => JSON.stringify(parsed) } } : {};
      },
    };
    const ddb = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        commands.push({ name: cmd.constructor.name, input: cmd.input });
        return cmd.constructor.name === 'GetCommand' ? { Item: { id: 'm1', [parserAttr('otp')]: { status: 'error', attempts: 1 } } } : {};
      },
    };
    const deps = { ...base, s3, ddb, domains: ['in.example.com'], retentionHours: 24 } as unknown as IngestDeps;
    const outcome = await reparse({ kind: 'reparse', id: 'm1', parsers: ['otp'] }, deps);
    expect(outcome).toEqual({ status: 'reparsed', id: 'm1', parsers: [{ parser: 'otp', status: 'ok' }] });
    const names = commands.map((c) => c.name);
    expect(names).not.toContain('BatchWriteCommand');
    const updates = commands.filter((c) => c.name === 'UpdateCommand').map((c) => (c.input.ExpressionAttributeValues as Record<string, { status: string; attempts: number }>)[':s']);
    expect(updates).toEqual([expect.objectContaining({ status: 'pending' }), expect.objectContaining({ status: 'ok', attempts: 2 })]);
  });

  it('builds routing input from the stored message', () => {
    expect(routingInput(parsed)).toEqual({ recipients: ['a@in.example.com'], from: 'x@example.org', subject: 'Your code is 123456', dmarc: 'PASS', spam: false, virus: false });
  });
});
