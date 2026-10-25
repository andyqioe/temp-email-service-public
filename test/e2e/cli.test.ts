import { describe, expect, it } from 'vitest';
import type { ListingEntry } from '../../cli/api-client';
import { address, marker, runCli, send, sleep, waitForListing } from './support';

/** The mail commands as you type them: real SES mail, the real CLI, piped output. */
describe('qmail ls / open / poll', () => {
  it('lists an inbox and all held mail newest first, and opens messages by id or --latest', async () => {
    const to = address('cli-');
    const subjects = [marker(), marker(), marker()];
    const ids: string[] = [];
    for (const s of subjects) {
      await send({ to: [to], subject: `List ${s}`, text: `body of ${s}` });
      ids.push((await waitForListing(to, s)).id);
    }
    const newestFirst = [...ids].reverse();

    const inbox = await runCli(['ls', to]);
    expect(inbox.status).toBe(0);
    const [header, ...rows] = inbox.stdout.trim().split('\n');
    expect(header).toMatch(/^UTC\s+ID\s+FROM\s+SUBJECT$/);
    expect(rows.map((r) => r.split(/\s+/)[2])).toEqual(newestFirst); // "MM-DD HH:MM" takes two fields
    expect(inbox.stderr).toBe(''); // one page: no "more:" hint

    // Everything held on the domain, newest first; follow cursors until all three show up.
    const found: ListingEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && found.length < 3; page++) {
      const r = JSON.parse((await runCli(['ls', '--json', ...(cursor ? ['--cursor', cursor] : [])])).stdout) as { messages: ListingEntry[]; next: string | null };
      const times = r.messages.map((m) => m.receivedAt);
      expect(times).toEqual([...times].sort().reverse());
      found.push(...r.messages.filter((m) => ids.includes(m.id)));
      if (!r.next) break;
      cursor = r.next;
    }
    expect(found.map((m) => m.id)).toEqual(newestFirst);
    expect(found[0]!.recipients).toEqual([to]);

    const latestHere = await runCli(['open', '--latest', to]);
    expect(latestHere.stdout).toContain(`id:       ${newestFirst[0]}`);
    expect(latestHere.stdout).toContain(`body of ${subjects[2]}`);

    // Other tests send mail too, so the newest overall is ours or something even newer.
    const latestAll = await runCli(['open', '--latest']);
    expect(latestAll.status).toBe(0);
    const received = /received: (\S+)/.exec(latestAll.stdout)![1]!;
    expect(received >= found[0]!.receivedAt).toBe(true);

    const json = JSON.parse((await runCli(['open', ids[0]!, '--json'])).stdout) as { id: string; subject: string };
    expect(json).toMatchObject({ id: ids[0], subject: `List ${subjects[0]}` });

    const raw = await runCli(['open', ids[0]!, '--raw', '-o', '-']);
    expect(raw.stdout).toMatch(new RegExp(`^Subject: List ${subjects[0]}`, 'm'));

    const misuse = await runCli(['open']);
    expect(misuse).toMatchObject({ status: 1, stderr: 'qmail: give a message id, or --latest [address]\n' });
  });

  it('lists the newest message of each address with `ls --latest`', async () => {
    const [a, b] = [address('latest-a-'), address('latest-b-')];
    const sent: Record<string, string> = {};
    for (const [to, name] of [[a, 'a1'], [b, 'b1'], [a, 'a2']] as const) {
      const m = marker();
      await send({ to: [to], subject: `Latest ${name} ${m}`, text: name });
      sent[name] = (await waitForListing(to, m)).id;
    }

    const all = JSON.parse((await runCli(['ls', '--latest', '--json'])).stdout) as { messages: ListingEntry[]; next: string | null };
    const ours = all.messages.filter((m) => m.address === a || m.address === b);
    // One row per address: a's newest (a2, sent last) comes before b's only message.
    expect(ours.map((m) => [m.address, m.id])).toEqual([
      [a, sent.a2],
      [b, sent.b1],
    ]);
    expect(new Set(all.messages.map((m) => m.address)).size).toBe(all.messages.length);

    const one = await runCli(['ls', a, '--latest']);
    const rows = one.stdout.trim().split('\n').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(sent.a2);
  });

  it('prints just the link with `poll --link`, and the whole message with `poll --once --open`', async () => {
    const to = address('otp-');
    const m = marker();
    const link = runCli(['poll', to, '--link', 'otp', '--since', '1m']);
    const opened = runCli(['poll', to, '--once', '--open', '--since', '1m', '--timeout', '120']);
    await sleep(3_000);
    await send({ to: [to], subject: `Verify ${m}`, html: `<p>Confirm your address</p><a href="https://example.org/confirm?t=${m}">Confirm</a>` });

    expect(await link).toMatchObject({ status: 0, stdout: `https://example.org/confirm?t=${m}\n` });
    const full = await opened;
    expect(full.status).toBe(0);
    expect(full.stdout).toContain(`subject:  Verify ${m}`);
    expect(full.stdout).toContain('parser otp: ok'); // waited for the parser instead of printing "pending"
  });

  it('times out with exit code 2 when nothing arrives', async () => {
    const r = await runCli(['poll', address('silent-'), '--code', 'otp', '--timeout', '5']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/timed out after 5s waiting for a otp code/);
  });
});
