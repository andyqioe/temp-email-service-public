import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { randomLocalPart } from '../../cli/names';
import { address, api, e2e, GTUBE, marker, send, waitFor, waitForListing, waitForParser } from './support';

const sha256 = (b: Buffer | ArrayBuffer) => createHash('sha256').update(Buffer.from(b as ArrayBuffer)).digest('hex');

describe('real delivery through SES', () => {
  it('delivers a plain message that is listed, readable, authenticated, and downloadable', async () => {
    const to = address('plain-');
    const m = marker();
    await send({ to: [to], subject: `Plain ${m}`, text: `Hello from ${m}\nSecond line` });

    const entry = await waitForListing(to, m);
    expect(entry).toMatchObject({ address: to, spam: false, virus: false, parseError: false, attachments: 0 });
    expect(entry.from).toContain(`sender@${e2e().senderDomain}`);

    const msg = await api().message(entry.id);
    expect(msg.subject).toBe(`Plain ${m}`);
    expect(msg.text).toContain(`Hello from ${m}`);
    expect(msg.recipients).toEqual([to]);
    // DKIM-signed by SES for our sending domain, and aligned with its DMARC record.
    expect(msg.verdicts).toMatchObject({ dkim: 'PASS', dmarc: 'PASS', virus: 'PASS' });
    expect(msg.parsers).toEqual({});

    const { url } = await api().rawUrl(entry.id);
    const res = await fetch(url);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    const raw = await res.text();
    expect(raw).toContain(`Subject: Plain ${m}`);
    expect(raw).toMatch(/^X-SES-Virus-Verdict: PASS/m);
  });

  it('extracts attachments and serves exact bytes through presigned URLs', async () => {
    const to = address('att-');
    const m = marker();
    const binary = randomBytes(64 * 1024);
    await send({
      to: [to],
      subject: `Attachments ${m}`,
      text: 'see attached',
      html: '<p>see <b>attached</b></p>',
      attachments: [
        { filename: 'data.bin', content: binary, contentType: 'application/octet-stream' },
        { filename: '../../evil "name".txt', content: 'hello attachment', contentType: 'text/plain' },
      ],
    });
    const entry = await waitForListing(to, m);
    expect(entry.attachments).toBe(2);
    const msg = await api().message(entry.id);
    expect(msg.html).toContain('<b>attached</b>');
    expect(msg.attachments.map((a) => [a.filename, a.downloadable])).toEqual([
      ['data.bin', true],
      ['../../evil "name".txt', true],
    ]);

    const first = await api().attachmentUrl(entry.id, 0);
    const res = await fetch(first.url);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('filename="data.bin"');
    expect(sha256(await res.arrayBuffer())).toBe(sha256(binary));

    const second = await api().attachmentUrl(entry.id, 1);
    const res2 = await fetch(second.url);
    expect(res2.headers.get('content-disposition')).toContain(`filename*=UTF-8''..%2F..%2Fevil%20%22name%22.txt`);
    expect(await res2.text()).toBe('hello attachment');
    await expect(api().attachmentUrl(entry.id, 7)).rejects.toMatchObject({ status: 404 });
  });

  it('indexes To, Cc, and BCC envelope recipients from one stored copy', async () => {
    const [a, b, c] = [address('multi-a-'), address('multi-b-'), address('multi-c-')];
    const m = marker();
    await send({ to: [a], cc: [b], bcc: [c], subject: `Multi ${m}`, text: 'to three inboxes' });

    const entries = await Promise.all([a, b, c].map((r) => waitForListing(r, m)));
    expect(new Set(entries.map((e) => e.id)).size).toBe(1);
    const msg = await api().message(entries[0]!.id);
    expect([...msg.recipients].sort()).toEqual([a, b, c].sort());
    // BCC never shows up in the headers; the receipt is the only source of truth for it.
    expect(msg.headers.some(([k, v]) => (k === 'to' || k === 'cc') && v.includes(c))).toBe(false);

    const feed = await api().feed({ limit: 100 });
    expect(feed.messages.filter((x) => x.id === entries[0]!.id)).toHaveLength(1);
    expect([...(feed.messages.find((x) => x.id === entries[0]!.id)?.recipients ?? [])].sort()).toEqual([a, b, c].sort());
  });

  it('treats plus-tagged addresses as their own inbox and records the tag', async () => {
    const base = address('plus-');
    const tagged = base.replace('@', '+shop42@');
    const m = marker();
    await send({ to: [tagged], subject: `Plus ${m}`, text: 'tagged' });
    const entry = await waitForListing(tagged, m);
    expect(entry.tag).toBe('shop42');
    expect((await api().listInbox(base)).messages).toEqual([]);
  });

  it('needs no setup for a never-used address', async () => {
    const fresh = `${randomLocalPart()}${randomBytes(2).toString('hex')}@${e2e().domain}`;
    expect((await api().listInbox(fresh)).messages).toEqual([]);
    const m = marker();
    await send({ to: [fresh], subject: `Fresh ${m}`, text: 'first mail ever' });
    await waitForListing(fresh, m);
  });

  it('rejects addresses on other domains', async () => {
    await expect(api().listInbox('someone@not-our-domain.example')).rejects.toMatchObject({ status: 404 });
  });

  it('flags mail that SES classifies as spam, and still indexes it', async () => {
    const to = address('echo-spam-');
    const m = marker();
    await send({ to: [to], subject: `Spam ${m}`, text: `This is spam.\n${GTUBE}\n` });
    const entry = await waitForListing(to, m);
    const msg = await api().message(entry.id);
    expect(msg.verdicts.spam).toBe('FAIL');
    expect(entry.spam).toBe(true);
    // Verification mail is sometimes misclassified, so parsers still run unless a rule opts out.
    await waitForParser(entry.id, 'echo', 'ok');
  });

  it('accepts a large (~30 MB) message', async () => {
    const to = address('big-');
    const m = marker();
    const big = randomBytes(22 * 1024 * 1024); // ~30 MB once base64-encoded
    await send({ to: [to], subject: `Big ${m}`, text: 'large attachment', attachments: [{ filename: 'big.bin', content: big }] });
    const entry = await waitForListing(to, m, { timeoutMs: 300_000 });
    expect(entry.size).toBeGreaterThan(29 * 1024 * 1024);
    const a = await api().attachmentUrl(entry.id, 0);
    const res = await fetch(a.url);
    expect(sha256(await res.arrayBuffer())).toBe(sha256(big));
  });

  it('polls with `since` without missing or duplicating messages', async () => {
    const to = address('since-');
    const start = new Date().toISOString();
    const markers = [marker(), marker(), marker()];
    for (const m of markers) await send({ to: [to], subject: `Since ${m}`, text: m });
    const seen = new Map<string, string>();
    let since = start;
    await waitFor('all three messages via since polling', async () => {
      const page = await api().listInbox(to, { since });
      for (const e of page.messages) seen.set(e.id, e.subject);
      since = page.nextSince ?? since;
      return seen.size >= 3 ? true : undefined;
    });
    expect([...seen.values()].sort()).toEqual(markers.map((m) => `Since ${m}`).sort());
  });
});
