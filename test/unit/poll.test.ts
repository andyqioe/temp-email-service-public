import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function fixture(states: Record<string, unknown>, ids = Object.keys(states), hang = false) {
  let listings = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.startsWith('/inboxes/')) {
      listings++;
      if (hang) return;
      expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z');
      res.end(JSON.stringify({ messages: ids.map((id) => ({ id })) }));
    } else {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      res.end(JSON.stringify({ id, parsers: states[id] === null ? {} : { jagex: states[id] } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, listings: () => listings };
}

function run(url: string, flags: string[] = [], onOutput?: () => void) {
  const child = spawn(process.execPath, ['bin/qmail.mjs', 'poll', 'fixture@example.test', '--since', '2026-01-01', '--interval', '0.01', '--timeout', '0.3', ...flags], {
    env: { PATH: process.env.PATH, INBOX_API_URL: url, INBOX_TOKEN: 'fixture-token', XDG_CONFIG_HOME: '/nonexistent-qmail-fixture' },
  });
  cleanup.push(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); onOutput?.(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const result = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
  return { child, result };
}
const ok = (code: unknown) => ({ status: 'ok', output: { code } });
const extraction = ['--code', 'jagex', '--json'];
const stream = [...extraction, '--mode=stream'];

test('default and explicit once preserve the first {id,code} and exit 0', async () => {
  const f = await fixture({ a: ok('FIRST'), b: ok('SECOND') });
  for (const flags of [extraction, [...extraction, '--mode=once'], [...extraction, '--once']]) {
    expect(await run(f.url, flags).result).toEqual({ stdout: '{"id":"a","code":"FIRST"}\n', stderr: '', code: 0 });
  }
});

test('stream skips unusable candidates and deduplicates IDs across polls', async () => {
  const f = await fixture({ unmatched: null, error: { status: 'error', error: 'SECRET-CODE fixture-token' }, empty: ok(''), invalid: ok(123), a: ok('FIRST'), b: ok('SECOND') }, ['unmatched', 'error', 'empty', 'invalid', 'a', 'a', 'b']);
  const result = await run(f.url, stream).result;
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('{"id":"a","code":"FIRST"}\n{"id":"b","code":"SECOND"}\n');
  expect(result.stderr).toContain('timed out');
  expect(result.stderr).not.toMatch(/SECRET-CODE|fixture-token|FIRST|SECOND/);
  expect(f.listings()).toBeGreaterThan(1);
});

test('one-shot still exits 4 on parser failure or missing code', async () => {
  for (const state of [{ status: 'error' }, ok('')]) {
    const f = await fixture({ a: state });
    const result = await run(f.url, extraction).result;
    expect(result.code).toBe(4);
    expect(result.stdout).toBe('');
  }
});

test('timeout stops empty, pending-parser and stalled HTTP polling', async () => {
  for (const [states, hang] of [[{}, false], [{ pending: { status: 'pending' } }, false], [{}, true]] as const) {
    const f = await fixture(states, undefined, hang);
    const result = await run(f.url, stream).result;
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('timed out');
  }
});

test('SIGINT cancels stream after output with exit 130', async () => {
  const f = await fixture({ a: ok('FIRST') });
  const invocation = run(f.url, [...stream, '--timeout', '120'], () => invocation.child.kill('SIGINT'));
  const result = await invocation.result;
  expect(result.code).toBe(130);
  expect(result.stdout).toBe('{"id":"a","code":"FIRST"}\n');
  expect(result.stderr).not.toContain('timed out');
});

test.each([
  ['--mode=unknown'], ['--mode=stream', '--once'],
  [...stream, '--once'], [...stream, '--link', 'jagex'],
  [...stream, '--timeout', 'invalid'], [...stream, '--interval', '0'], [...stream, '--follow'],
])('rejects invalid flags without HTTP requests: %j', async (...flags) => {
  const f = await fixture({});
  const result = await run(f.url, flags).result;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toBe('');
  expect(f.listings()).toBe(0);
});

test('SIGINT cancels an in-flight HTTP request', async () => {
  const f = await fixture({}, undefined, true);
  const invocation = run(f.url, [...stream, '--timeout', '120']);
  for (let tries = 0; f.listings() === 0 && tries < 300; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.listings()).toBeGreaterThan(0);
  invocation.child.kill('SIGINT');
  expect(await invocation.result).toEqual({ stdout: '', stderr: '', code: 130 });
});

test('plain code streaming and default link extraction keep their formats', async () => {
  const f = await fixture({ a: { status: 'ok', output: { code: 'FIRST', links: ['https://example.test/verify'] } } });
  const streamed = await run(f.url, ['--code', 'jagex', '--mode=stream']).result;
  expect(streamed.stdout).toBe('FIRST\n');
  expect(streamed.code).toBe(2);
  expect(await run(f.url, ['--link', 'jagex', '--json']).result).toEqual({
    stdout: '{"id":"a","link":"https://example.test/verify"}\n', stderr: '', code: 0,
  });
});

test('mode controls message polling independently of extraction', async () => {
  const f = await fixture({ a: null, b: null }, ['a', 'a', 'b']);
  for (const flags of [[], ['--mode=stream']]) {
    const result = await run(f.url, [...flags, '--json']).result;
    expect(result.stdout).toBe('{"id":"a"}\n{"id":"b"}\n');
    expect(result.code).toBe(2);
  }
  for (const flags of [['--mode=once'], ['--once']]) {
    expect(await run(f.url, [...flags, '--json']).result).toEqual({ stdout: '{"id":"a"}\n', stderr: '', code: 0 });
  }
});

test('stream supports full messages with --open', async () => {
  const f = await fixture({ a: null, b: null });
  const result = await run(f.url, ['--mode=stream', '--open', '--json']).result;
  expect(result.stdout).toBe('{"id":"a","parsers":{}}\n{"id":"b","parsers":{}}\n');
  expect(result.code).toBe(2);
});

test('link streaming skips unusable candidates and emits successive first links', async () => {
  const f = await fixture({
    bad: { status: 'error', error: 'SECRET-LINK' }, empty: { status: 'ok', output: { links: [] } },
    a: { status: 'ok', output: { links: ['https://example.test/a', 'https://example.test/ignored'] } },
    b: { status: 'ok', output: { links: ['https://example.test/b'] } },
  });
  const result = await run(f.url, ['--mode=stream', '--link', 'jagex', '--json']).result;
  expect(result.stdout).toBe('{"id":"a","link":"https://example.test/a"}\n{"id":"b","link":"https://example.test/b"}\n');
  expect(result.code).toBe(2);
  expect(result.stderr).not.toMatch(/SECRET-LINK|https:/);
});
