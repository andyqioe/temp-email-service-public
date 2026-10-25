import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import MailComposer from 'nodemailer/lib/mail-composer';
import { inject } from 'vitest';
import { InboxApi, type ListingEntry, type MessageView } from '../../cli/api-client';
import { fakeNotification } from '../support/ses-notification';

export const e2e = () => inject('e2e');
export const api = () => new InboxApi({ apiUrl: e2e().apiUrl, token: e2e().token });

const aws = () => {
  const region = e2e().region;
  return { ses: new SESv2Client({ region }), s3: new S3Client({ region }), sqs: new SQSClient({ region }) };
};

/** A fresh address on the test domain, e.g. echo-k3j9x2@e2e.in.example.com */
export function address(prefix: string): string {
  return `${prefix}${randomBytes(4).toString('hex')}@${e2e().domain}`;
}

/** A unique marker to find a message by subject. */
export function marker(): string {
  return `e2e-${randomBytes(6).toString('hex')}`;
}

export interface ComposeOptions {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
}

export async function compose(o: ComposeOptions): Promise<Buffer> {
  return new MailComposer({
    from: o.from ?? `E2E Sender <sender@${e2e().senderDomain}>`,
    to: o.to,
    cc: o.cc,
    subject: o.subject,
    text: o.text,
    html: o.html,
    attachments: o.attachments,
  })
    .compile()
    .build();
}

let lastSend = 0;

/**
 * Sends real mail through SES (sandbox: 1/s, only to verified identities, which our
 * receiving domain is). It travels the full public path: MX lookup, SMTP, receipt rule.
 */
export async function send(o: ComposeOptions): Promise<void> {
  const wait = lastSend + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSend = Date.now();
  const raw = await compose(o);
  await aws().ses.send(
    new SendEmailCommand({
      FromEmailAddress: `sender@${e2e().senderDomain}`,
      Destination: { ToAddresses: o.to ?? [], CcAddresses: o.cc ?? [], BccAddresses: o.bcc ?? [] },
      Content: { Raw: { Data: raw } },
    }),
  );
}

/**
 * Stores raw bytes where SES would and feeds the ingest queue the notification SES would
 * publish. Used for inputs SES never delivers verbatim: malformed MIME, virus verdicts.
 */
export async function injectRaw(
  raw: Buffer | string,
  o: { recipients: string[]; subject?: string; from?: string; verdicts?: Parameters<typeof fakeNotification>[0]['verdicts']; timestamp?: string },
): Promise<string> {
  const id = `e2e-inject-${randomUUID()}`;
  const { s3, sqs } = aws();
  const bucket = e2e().outputs.BucketName;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `raw/${id}`, Body: raw }));
  const notification = fakeNotification({ messageId: id, bucket, objectKey: `raw/${id}`, ...o });
  await sqs.send(new SendMessageCommand({ QueueUrl: e2e().outputs.IngestQueueUrl, MessageBody: JSON.stringify(notification) }));
  return id;
}

export async function sendToIngestQueue(body: string): Promise<void> {
  await aws().sqs.send(new SendMessageCommand({ QueueUrl: e2e().outputs.IngestQueueUrl, MessageBody: body }));
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { timeoutMs = 180_000, intervalMs = 2_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

/** Waits until a message whose subject contains `subjectMarker` is listed for `to`. */
export function waitForListing(to: string, subjectMarker: string, opts?: { timeoutMs?: number }): Promise<ListingEntry> {
  return waitFor(`mail "${subjectMarker}" for ${to}`, async () => {
    const page = await api().listInbox(to, { limit: 50 });
    return page.messages.find((m) => m.subject.includes(subjectMarker));
  }, opts);
}

/** Waits until a message exists (injected messages are addressed by id). */
export function waitForMessage(id: string, opts?: { timeoutMs?: number }): Promise<MessageView> {
  return waitFor(`message ${id}`, () => api().message(id), opts);
}

export function waitForParser(id: string, parser: string, status: 'ok' | 'error', opts?: { timeoutMs?: number }) {
  return waitFor(`parser ${parser} to be ${status} on ${id}`, async () => {
    const m = await api().message(id);
    return m.parsers[parser]?.status === status ? m : undefined;
  }, opts);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
export const GTUBE = 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X';

/** Runs the `qmail` CLI against the e2e stage: its API with the test token, and your AWS login for account commands. */
export function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'cli/main.ts', '--stage', e2e().stage, ...args], { cwd: REPO, env: { ...cliEnv(), ...opts.env } });
    child.stdin.end(opts.stdin);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Runs the CLI in a pseudo-terminal (through `script`), typing `keys` one at a time once the
 * first screen appears. Returns everything the terminal showed, with escape codes removed.
 * Node gives children a socket for stdin, which macOS `script` rejects ("tcgetattr/ioctl:
 * Operation not supported on socket"), so the keys go through `cat` into a real pipe.
 */
export function runCliInTerminal(
  args: string[],
  keys: string[],
  opts: { settleMs?: number; startWhen?: RegExp; timeoutMs?: number } = {},
): Promise<{ status: number | null; screen: string }> {
  const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const cli = ['npx', 'tsx', 'cli/main.ts', '--stage', e2e().stage, ...args].map(quote).join(' ');
  const inTerminal = process.platform === 'darwin' ? `script -q /dev/null ${cli}` : `script -qfec ${quote(cli)} /dev/null`;
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `cat | ${inTerminal}`], { cwd: REPO, env: cliEnv() });
    let raw = '';
    let typing = false;
    child.stdout.on('data', (d: Buffer) => (raw += d.toString()));
    child.stderr.on('data', (d: Buffer) => (raw += d.toString()));
    child.stdout.on('data', () => {
      // Start typing once the first screen is up (a pager footer by default), then pause between keys so each redraw lands.
      if (typing || !(opts.startWhen ?? /q quit/).test(raw)) return;
      typing = true;
      void (async () => {
        for (const key of keys) {
          await sleep(opts.settleMs ?? 1_500);
          child.stdin.write(key);
        }
        await sleep(500);
        child.stdin.end(); // lets `cat` exit once the CLI has quit
      })();
    });
    // If the expected screen never appears, stop feeding input so `cat`, and with it the run, ends.
    const guard = setTimeout(() => child.stdin.end(), opts.timeoutMs ?? 90_000);
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, screen: stripTerminal(raw) });
    });
  });
}

export const KEYS = { right: '\u001b[C', left: '\u001b[D', quit: 'q', enter: '\r' };

function stripTerminal(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

const REPO = path.resolve(__dirname, '..', '..');
const cliEnv = () => ({
  ...process.env,
  INBOX_API_URL: e2e().apiUrl,
  INBOX_TOKEN: e2e().token,
  INBOX_DOMAINS: e2e().domain,
  NO_COLOR: '1',
});
