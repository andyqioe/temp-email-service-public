import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { address, api, compose, e2e, injectRaw, marker, runCli, send, sleep, waitFor, waitForListing, waitForMessage, waitForParser } from './support';

describe('custom parsers', () => {
  it('runs a matching parser with presigned access to the raw message and attachments', async () => {
    const to = address('echo-');
    const m = marker();
    const bytes = randomBytes(2048);
    await send({ to: [to], subject: `Echo ${m}`, text: `body ${m}`, attachments: [{ filename: 'x.bin', content: bytes }] });
    const entry = await waitForListing(to, m);
    const msg = await waitForParser(entry.id, 'echo', 'ok');
    const out = msg.parsers.echo!.output as Record<string, unknown>;
    expect(out).toMatchObject({
      parser: 'echo',
      messageId: entry.id,
      subject: `Echo ${m}`,
      matchedRecipients: [to],
      dmarc: 'PASS',
      rawStatus: 200,
      bodyTruncated: false,
    });
    expect(out.rawBytes).toBeGreaterThan(2048);
    expect(out.attachments).toEqual([{ index: 0, sha256: createHash('sha256').update(bytes).digest('hex') }]);
    // Only matching parsers ran.
    expect(Object.keys(msg.parsers)).toEqual(['echo']);
  });

  it('extracts a one-time code with the example parser', async () => {
    const to = address('otp-');
    const m = marker();
    await send({ to: [to], subject: `Sign in ${m}`, html: `<p>Your verification code is</p><h1>407 219</h1><a href="https://example.org/verify?t=${m}">Verify</a>` });
    const entry = await waitForListing(to, m);
    const msg = await waitForParser(entry.id, 'otp', 'ok');
    expect(msg.parsers.otp!.output).toMatchObject({ code: '407219', links: [`https://example.org/verify?t=${m}`] });
  });

  it('runs nothing for addresses no rule matches', async () => {
    const to = address('nomatch-');
    const m = marker();
    await send({ to: [to], subject: `None ${m}`, text: 'x' });
    const entry = await waitForListing(to, m);
    await sleep(5_000);
    expect((await api().message(entry.id)).parsers).toEqual({});
  });

  it('routes on an authenticated sender and refuses a spoofed one', async () => {
    const to = address('sender-');
    const m = marker();
    await send({ to: [to], subject: `Sender ${m}`, text: 'from our own domain, DKIM-aligned' });
    const entry = await waitForListing(to, m);
    await waitForParser(entry.id, 'sender', 'ok');

    // Same From address, but DMARC failed: the From header could be forged, so the rule must not match.
    const spoofed = await injectRaw(await compose({ to: [to], subject: `Spoofed ${m}`, text: 'forged' }), {
      recipients: [to],
      from: `sender@${e2e().senderDomain}`,
      verdicts: { dmarc: 'FAIL' },
    });
    const spoofedMsg = await waitForMessage(spoofed);
    await sleep(5_000);
    expect((await api().message(spoofedMsg.id)).parsers).toEqual({});
  });

  it('routes on a subject pattern', async () => {
    const to = address('subject-');
    const [hit, miss] = [marker(), marker()];
    await send({ to: [to], subject: `[route-me] ${hit}`, text: 'x' });
    await send({ to: [to], subject: `plain ${miss}`, text: 'x' });
    const hitEntry = await waitForListing(to, hit);
    const missEntry = await waitForListing(to, miss);
    await waitForParser(hitEntry.id, 'subject', 'ok');
    await sleep(5_000);
    expect((await api().message(missEntry.id)).parsers).toEqual({});
  });

  it('records a failing parser as an error once, without affecting the message, and reparse retries it', async () => {
    const to = address('fail-');
    const m = marker();
    await send({ to: [to], subject: `Fail ${m}`, text: 'x' });
    const entry = await waitForListing(to, m);
    const msg = await waitForParser(entry.id, 'fail', 'error');
    expect(msg.parsers.fail).toMatchObject({ status: 'error', attempts: 1, error: expect.stringContaining('deliberate failure') });
    expect((await api().listInbox(to)).messages.map((x) => x.id)).toEqual([entry.id]);

    expect(await api().reparse(entry.id, 'fail')).toEqual({ id: entry.id, enqueued: ['fail'] });
    await waitFor('a second recorded attempt', async () => ((await api().message(entry.id)).parsers.fail?.attempts === 2 ? true : undefined));
  });

  it('kills a parser that never returns at its timeout, while other parsers on the same message finish', async () => {
    const to = address('spin-');
    const m = marker();
    await send({ to: [to], subject: `Spin ${m}`, text: 'x' });
    const entry = await waitForListing(to, m);
    const msg = await waitForParser(entry.id, 'spin', 'error');
    expect(msg.parsers.spin!.error).toMatch(/timed out after 2000 ms/);
    await waitForParser(entry.id, 'spinmate', 'ok');
  });

  it('does not make a reparsed message look new to since polling', async () => {
    const to = address('echo-quiet-');
    const m = marker();
    await send({ to: [to], subject: `Quiet ${m}`, text: 'x' });
    const entry = await waitForListing(to, m);
    await waitForParser(entry.id, 'echo', 'ok');
    // Poll until the cursor has moved past the message, then reparse.
    let since = new Date(Date.now() - 60_000).toISOString();
    await waitFor('the cursor to pass the message', async () => {
      const page = await api().listInbox(to, { since });
      since = page.nextSince ?? since;
      return page.messages.length === 0 && since > entry.indexedCursor ? true : undefined;
    }, { timeoutMs: 60_000, intervalMs: 3_000 });
    await api().reparse(entry.id);
    await sleep(8_000);
    expect((await api().listInbox(to, { since })).messages).toEqual([]);
  });

  it('extracts a Jagex code only from authenticated Jagex mail', async () => {
    const to = address('jagex-');
    const raw = await compose({ from: 'Jagex <no-reply@contact.jagex.com>', to: [to], subject: 'K7Q2X is your Jagex verification code', text: 'Welcome' });
    const id = await injectRaw(raw, { recipients: [to], from: 'no-reply@contact.jagex.com', subject: 'K7Q2X is your Jagex verification code' });
    const msg = await waitForParser(id, 'jagex', 'ok');
    expect(msg.parsers.jagex!.output).toEqual({ code: 'K7Q2X', source: 'subject' });

    const spoofTo = address('jagex-');
    const spoof = await injectRaw(raw, { recipients: [spoofTo], from: 'no-reply@contact.jagex.com', subject: 'K7Q2X is your Jagex verification code', verdicts: { dmarc: 'FAIL' } });
    await waitForMessage(spoof);
    await sleep(5_000);
    expect((await api().message(spoof)).parsers).toEqual({});
  });

  it('prints just the code with `qmail poll --code`', async () => {
    const to = address('otp-');
    const m = marker();
    const cli = runCli(['poll', to, '--code', 'otp', '--timeout', '120', '--since', '1m']);
    await sleep(3_000);
    await send({ to: [to], subject: `Code ${m}`, text: 'Your verification code is 604 118.' });
    const result = await cli;
    expect(result).toMatchObject({ status: 0, stdout: '604118\n' });
  });

  it('reparses on demand, and can force a parser whose rule does not match', async () => {
    const to = address('echo-reparse-');
    const m = marker();
    await send({ to: [to], subject: `Reparse ${m}`, text: 'Your code is 551234' });
    const entry = await waitForListing(to, m);
    const first = await waitForParser(entry.id, 'echo', 'ok');
    const firstRun = (first.parsers.echo!.output as { invokedAt: string }).invokedAt;

    expect(await api().reparse(entry.id)).toEqual({ id: entry.id, enqueued: ['echo'] });
    await waitFor('a new echo run', async () => {
      const msg = await api().message(entry.id);
      const run = (msg.parsers.echo?.output as { invokedAt?: string } | undefined)?.invokedAt;
      return msg.parsers.echo?.status === 'ok' && run !== firstRun ? true : undefined;
    });

    expect(await api().reparse(entry.id, 'otp')).toEqual({ id: entry.id, enqueued: ['otp'] });
    const forced = await waitForParser(entry.id, 'otp', 'ok');
    expect(forced.parsers.otp!.output).toMatchObject({ code: '551234' });
    await expect(api().reparse(entry.id, 'nope')).rejects.toMatchObject({ status: 400 });
  });
});
