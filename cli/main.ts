import { setupCredentials, type SetupOptions } from './setup';
import fs from 'node:fs';
import { Command, Option } from 'commander';
import { ApiError, InboxApi, type ListingEntry, type MessageView } from './api-client';
import { loadConfig } from '../config/load';
import {
  addAccount,
  countAccounts,
  listAccountsPage,
  listAllAccounts,
  presentFields,
  removeAccount,
  setAccount,
  soleService,
  toCsv,
  type Account,
  type AccountFields,
} from './accounts';
import {
  blockIp,
  createToken,
  enqueueReparse,
  findStuckParsers,
  listBlocked,
  listTokens,
  pause,
  redrive,
  reindex,
  resume,
  revokeToken,
  unblockIp,
} from './admin';
import { accountCards, accountTable } from './account-view';
import { ensureAwsSession, useProfile, type AwsIdentity } from './aws-session';
import { collectUsage, RANGES, SlowCache, type RangeKey } from './insights';
import { heldMailPage, inboxPage, latestMessage, latestPerAddress } from './mail-pages';
import { pageThrough } from './ui/pager';
import { color, table, terminalWidth } from './ui/text';
import { renderUsage } from './usage';
import { readLocalConfig, resolveApiTarget, saveStageCredentials } from './local-config';
import { randomLocalPart } from './names';
import { pollInbox, resolveSince, waitForParser, waitForParsers } from './poll';
import { readLine } from './prompt';
import { stageContext } from './stack';

const program = new Command()
  .name('qmail')
  .description('Receive-only inboxes on Amazon SES + S3')
  .addOption(new Option('--stage <stage>', 'stage to act on (default: INBOX_STAGE, then your saved default, then prod)'))
  .addOption(new Option('--profile <profile>', 'AWS profile for AWS-login commands (default: AWS_PROFILE, then awsProfile)'))
  .showHelpAfterError()
  .helpCommand(false)
  .addHelpText('after', '\nRun `qmail <command> --help` for its options.');

const stageFlag = () => program.opts<{ stage?: string }>().stage;
const api = (signal?: AbortSignal) => new InboxApi(resolveApiTarget(stageFlag()), signal);
const adminStage = () => stageFlag() ?? process.env.INBOX_STAGE ?? readLocalConfig().defaultStage ?? 'prod';

/** Account and operations commands use your AWS credentials; an expired SSO session triggers `aws sso login`. */
let awsSession: Promise<AwsIdentity> | undefined;
async function ensureAws(fresh = false): Promise<AwsIdentity> {
  if (fresh) awsSession = undefined;
  awsSession ??= (async () => {
    const config = await loadConfig();
    const profile = useProfile(program.opts<{ profile?: string }>().profile, config.awsProfile);
    return ensureAwsSession(config.region, profile);
  })();
  return awsSession;
}
const adminCtx = async (stage = adminStage()) => {
  await ensureAws();
  return stageContext(stage);
};
const print = (value: unknown): void => {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
};
/** Repeats the global flags in hints, so a copied command acts on the same stage. */
const stageArg = () => (stageFlag() ? ` --stage ${stageFlag()}` : '');

const setupToken = (o: SetupOptions = {}) => setupCredentials(o, adminStage(), program.opts<{ profile?: string }>().profile);

program.command('setup')
  .description('connect using an existing API token or an AWS identity')
  .addOption(new Option('--method <method>', 'connection method').choices(['existing', 'aws']))
  .option('--yes', 'explicitly authorize saving credentials or registering a token')
  .option('--replace', 'authorize replacing saved stage credentials')
  .option('--api-url <url>', 'existing-token API endpoint')
  .option('--region <region>', 'AWS receiving region')
  .option('--stack <name>', 'existing CloudFormation stack')
  .option('--name <name>', 'name for the new AWS-registered token')
  .action(setupToken);

program.hook('preAction', async (_program, command) => {
  if (!['new', 'ls', 'open', 'poll', 'rm', 'reparse'].includes(command.name()) || command.parent !== program) return;
  try {
    resolveApiTarget(stageFlag());
  } catch {
    if (process.stdin.isTTY && process.stderr.isTTY) await setupToken();
  }
});

// ---- mail (API token) -----------------------------------------------------------------

program.commandsGroup('Mail (uses your API token):');

program
  .command('new')
  .summary('print an unused address')
  .description('print a fresh, human-looking address that has no mail yet (nothing is reserved)')
  .option('--prefix <prefix>', 'prefix for the local part, e.g. "signup-"')
  .option('--domain <domain>', "receiving domain (default: the stage's first domain)")
  .action(async (o: { prefix?: string; domain?: string }) => {
    const target = resolveApiTarget(stageFlag());
    const domain = o.domain ?? target.domains[0];
    if (!domain) throw new Error('no domain known for this stage; pass --domain');
    const client = new InboxApi(target);
    for (let i = 0; i < 20; i++) {
      const address = `${randomLocalPart(o.prefix)}@${domain}`;
      if ((await client.listInbox(address, { limit: 1 })).messages.length === 0) return print(address);
    }
    throw new Error('could not find an unused address in 20 tries');
  });

program
  .command('ls [address]')
  .summary('list an inbox, or all mail held, newest first')
  .description('list an inbox, or all mail still held, newest first (20 per page; ←/→ to page in a terminal)')
  .option('--latest', 'only the newest message of each address (with an address: its newest message)')
  .option('--date <yyyy-mm-dd>', 'without an address: only mail received on this UTC day')
  .option('--domain <domain>', 'without an address: the receiving domain, if the stage has several')
  .option('--cursor <cursor>', 'continue from the `more:` hint of a previous listing')
  .option('--json', 'print one page as JSON: { messages, next }')
  .action(async (address: string | undefined, o: { latest?: boolean; date?: string; domain?: string; cursor?: string; json?: boolean }) => {
    if (address && (o.date || o.domain)) throw new Error('--date and --domain apply only when listing all mail (no address)');
    const client = api();
    let fetchPage = (cursor: string | undefined) =>
      address ? inboxPage(client, address, cursor) : heldMailPage(client, { date: o.date, domain: o.domain }, cursor);
    let total: (() => Promise<number>) | undefined;
    if (o.latest) {
      // Grouping by address needs every held entry, so the rows are built once and paged locally.
      const rows = address ? (await inboxPage(client, address, undefined, 1)).items : await latestPerAddress(client, { date: o.date, domain: o.domain });
      fetchPage = async (cursor) => {
        const start = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isInteger(start) || start < 0) throw new Error('invalid cursor; copy it exactly from the previous page');
        return { items: rows.slice(start, start + 20), next: start + 20 < rows.length ? String(start + 20) : null };
      };
      total = async () => rows.length;
    }
    if (o.json) {
      const page = await fetchPage(o.cursor);
      return print({ messages: page.items, next: page.next });
    }
    const scope = [address, o.latest && '--latest', o.date && `--date ${o.date}`, o.domain && `--domain ${o.domain}`].filter(Boolean).join(' ');
    await pageThrough({
      fetchPage: (cursor) => fetchPage(cursor ?? o.cursor),
      render: (items, width) => listingTable(items, width, address ? {} : { recipientsOf: o.domain ? [o.domain] : resolveApiTarget(stageFlag()).domains }),
      total,
      empty: address ? `no mail for ${address}` : 'no mail held',
      moreHint: (next) => `qmail ls${scope ? ` ${scope}` : ''}${stageArg()} --cursor ${next}`,
    });
  });

program
  .command('open [id]')
  .summary('read a message; --latest, --raw, --attachment')
  .description('read a message: sender, verdicts, parser results, then the body')
  .option('--latest [address]', 'open the newest message held (for this address, or across the stage)')
  .option('--html', 'print the HTML body instead of the text body')
  .option('--headers', 'include all headers')
  .option('--raw', 'save the original .eml instead of printing (to <id>.eml, or -o)')
  .option('--attachment <n>', 'save attachment n instead of printing (numbers are listed when you open the message)')
  .option('-o, --output <file>', 'with --raw or --attachment: file to write ("-" for stdout)')
  .option('--json', 'print JSON')
  .action(
    async (
      id: string | undefined,
      o: { latest?: string | true; html?: boolean; headers?: boolean; raw?: boolean; attachment?: string; output?: string; json?: boolean },
    ) => {
      if (Boolean(id) === Boolean(o.latest)) throw new Error('give a message id, or --latest [address]');
      if (o.raw && o.attachment !== undefined) throw new Error('use either --raw or --attachment');
      if (o.output && !o.raw && o.attachment === undefined) throw new Error('-o applies only with --raw or --attachment');
      const client = api();
      let messageId = id;
      if (!messageId) {
        const scope = typeof o.latest === 'string' ? { address: o.latest } : { domains: resolveApiTarget(stageFlag()).domains };
        const latest = await latestMessage(client, scope);
        if (!latest) throw new Error(typeof o.latest === 'string' ? `no mail for ${o.latest}` : 'no mail held');
        messageId = latest.id;
      }
      if (o.raw) {
        const { url } = await client.rawUrl(messageId);
        return download(url, o.output ?? `${messageId}.eml`);
      }
      if (o.attachment !== undefined) {
        const index = Number(o.attachment);
        if (!Number.isInteger(index) || index < 0) throw new Error(`--attachment must be an attachment number, got "${o.attachment}"`);
        const a = await client.attachmentUrl(messageId, index);
        return download(a.url, o.output ?? safeFilename(a.filename ?? `${messageId}-${index}`));
      }
      const m = await client.message(messageId);
      print(o.json ? m : formatMessage(m, o));
    },
  );

program
  .command('poll <address>')
  .summary('wait for mail; --code / --link print just that')
  .description('wait for mail to an address and print it as it arrives')
  .option('--once', 'stop after the first message')
  .option('--open', 'print the whole message (once its parsers finish) instead of a one-line summary')
  .option('--code <parser>', 'print only the code this parser found (e.g. jagex, otp); exits unless --mode=stream')
  .addOption(new Option('--mode <mode>', 'polling mode (default: once with --code/--link, stream otherwise); stream conflicts with --once').choices(['once', 'stream']))
  .option('--link <parser>', 'print only the first link this parser found; exits unless --mode=stream')
  .option('--since <when>', 'also include mail from this long ago (e.g. 10m) or since an ISO time', '5m')
  .option('--interval <seconds>', 'poll interval', '2')
  .option('--timeout <seconds>', 'give up after this long (default: 120 with --code or --link, otherwise never)')
  .option('--json', 'print JSON (one object per line)')
  .addHelpText('after', '\nExit codes: 0 found, 2 timed out (even after stream output), 4 one-shot parser failure, 130 interrupted.')
  .action(
    async (
      address: string,
      o: { mode?: 'once' | 'stream'; once?: boolean; open?: boolean; code?: string; link?: string; since: string; interval: string; timeout?: string; json?: boolean },
    ) => {
      if (o.code && o.link) throw new Error('use either --code or --link');
      if (o.mode === 'stream' && o.once) throw new Error('--mode=stream cannot be combined with --once');
      const extract = o.code ? { parser: o.code, field: 'code' as const } : o.link ? { parser: o.link, field: 'link' as const } : undefined;
      const streaming = (o.mode ?? (extract || o.once ? 'once' : 'stream')) === 'stream';
      const timeout = Number(o.timeout ?? (extract ? 120 : 0));
      const intervalMs = Number(o.interval) * 1000;
      if (!Number.isFinite(timeout) || timeout < 0) throw new Error('--timeout must be a finite non-negative number');
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('--interval must be a finite positive number');
      const since = resolveSince(o.since);
      const controller = new AbortController();
      const client = api(controller.signal);
      let interrupted = false;
      const interrupt = () => { interrupted = true; controller.abort(); };
      process.once('SIGINT', interrupt);
      const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout * 1000) : undefined;
      const poll = pollInbox(client, address, { since, intervalMs, signal: controller.signal });
      try {
        for await (const m of poll) {
          if (extract) {
            const { state } = await waitForParser(client, m.id, extract.parser, { intervalMs: 1000, signal: controller.signal });
            if (controller.signal.aborted) break;
            if (!state) continue; // the parser's rule did not match this message; keep waiting
            const output = state.output as { code?: unknown; links?: unknown } | undefined;
            const value = extract.field === 'code' ? output?.code : Array.isArray(output?.links) ? output.links[0] : undefined;
            if (state.status === 'ok' && typeof value === 'string' && value) {
              print(o.json ? JSON.stringify({ id: m.id, [extract.field]: value }) : value);
              if (streaming) continue;
              return;
            }
            const why = state.status === 'ok' ? `found no ${extract.field}` : state.status;
            process.stderr.write(`parser ${extract.parser} ${why} (message ${m.id})\n`);
            if (streaming) continue;
            process.exitCode = 4;
            return;
          }
          if (o.open) {
            const message = await waitForParsers(client, m.id, { intervalMs: 1000, signal: controller.signal });
            if (controller.signal.aborted) break;
            print(o.json ? JSON.stringify(message) : formatMessage(message, {}));
          } else {
            print(o.json ? JSON.stringify(m) : formatListing(m));
          }
          if (!streaming || controller.signal.aborted) break;
        }
      } catch (err) {
        if (!controller.signal.aborted) throw err;
      } finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupt);
        if (interrupted) process.exitCode = 130;
        else if (controller.signal.aborted) {
          const what = extract ? `a ${extract.parser} ${extract.field}` : 'mail';
          process.stderr.write(`timed out after ${timeout}s waiting for ${what} at ${address}\n`);
          process.exitCode = 2;
        }
      }
    },
  );

program
  .command('rm [id]')
  .summary('delete a message, or all mail of --address')
  .description('delete a message (or every message of --address) from every inbox it landed in, with its stored content')
  .option('-a, --address <address>', 'delete all mail delivered to this address')
  .action(async (id: string | undefined, o: { address?: string }) => {
    if (Boolean(id) === Boolean(o.address)) throw new Error('give either a message id or --address');
    if (id) return print(await api().delete(id));
    let total = 0;
    for (;;) {
      const r = await api().deleteInbox(o.address!);
      total += r.deleted;
      if (!r.more) break;
    }
    print(`deleted ${total} message(s) for ${o.address}`);
  });

program
  .command('reparse <id>')
  .summary('re-run parsers on a message')
  .description('re-run parsers on a message (all matching rules, or one by name)')
  .option('-p, --parser <name>', 'force this parser even if its rule does not match')
  .action(async (id: string, o: { parser?: string }) => print(await api().reparse(id, o.parser)));

// ---- accounts (AWS login; stored as plain text by design) -------------------------------

program.commandsGroup('Accounts (uses your AWS login):');

const account = program.command('account').summary('your signups: add | set | ls | rm').description('services you signed up for with your addresses, and their logins');
/**
 * A password is never taken as an argument: the shell rewrites `$name`, `!`, and quotes before qmail sees it
 * (`--password "R..$ecret1"` arrives as `R..`), so `--password` is a flag that asks for it instead.
 * Excess arguments are allowed only so a value typed after `--password` gets this explanation, not a bare usage error.
 */
const accountFields = (cmd: Command) =>
  cmd
    .option('--url <url>', 'sign-in page')
    .option('-u, --username <username>', 'login username')
    .option('-p, --password', 'ask for the login password (stored as plain text): type it at the prompt, or pipe it in on stdin')
    .option('--notes <text>', 'free-form notes')
    .allowExcessArguments()
    .hook('preAction', (c) => {
      if (c.args.length <= 1) return;
      const usage = `qmail account ${c.name()} <email> --password`;
      if (c.opts<AccountOptions>().password) {
        throw new Error(
          `--password takes no value, because your shell rewrites $, !, and quotes in a password before qmail sees it.\n` +
            `Run \`${usage}\` and type it at the prompt, or pipe it in: printf '%s\\n' '<password>' | ${usage}`,
        );
      }
      c.error(`error: too many arguments for '${c.name()}'. Expected 1 argument but got ${c.args.length}.`, { code: 'commander.excessArguments' });
    })
    .addHelpText('after', "\nThe password is never given on the command line, where your shell would rewrite $, !, and quotes.\n--password asks for it; scripts can pipe it in: printf '%s\\n' \"$PASSWORD\" | qmail account set <email> --password");

type AccountOptions = Omit<AccountFields, 'password'> & { service?: string; password?: boolean };

/**
 * The fields given, with blank values dropped so they never replace what is stored.
 * `--password` reads the password from a prompt or stdin, so the shell never rewrites it.
 */
async function givenFields(o: AccountOptions): Promise<AccountFields> {
  const password = o.password ? await readLine(`password${o.service ? ` for ${o.service}` : ''}: `) : undefined;
  return presentFields({ url: o.url, username: o.username, password, notes: o.notes });
}

accountFields(account.command('add <email>').description('record an account').requiredOption('-s, --service <name>', 'service name, e.g. jagex'))
  .action(async (email: string, o: AccountOptions & { service: string }) => {
    const fields = await givenFields(o);
    const a = await addAccount(await adminCtx(), email, o.service, fields);
    print(`added ${a.service} account for ${a.email}`);
  });

accountFields(
  account
    .command('set <email>')
    .description('change an account: only the fields you give change, and empty values keep what is stored')
    .option('-s, --service <name>', 'which account (optional when the email has only one)'),
)
  .option('--clear-password', 'remove the stored password')
  .action(async (email: string, o: AccountOptions & { clearPassword?: boolean }) => {
    if (o.clearPassword && o.password) throw new Error('use either --password or --clear-password');
    const fields = await givenFields(o);
    const changes = [...Object.keys(fields), ...(o.clearPassword ? ['password cleared'] : [])];
    if (changes.length === 0) {
      throw new Error('nothing to change: give at least one of --url, --username, --password, --notes, or --clear-password (empty values keep what is stored)');
    }
    const ctx = await adminCtx();
    const service = o.service ?? (await soleService(ctx, email));
    const a = await setAccount(ctx, email, service, fields, { clearPassword: o.clearPassword });
    print(`updated ${a.service} account for ${a.email}: ${changes.join(', ')}`);
  });

account
  .command('ls')
  .summary('list accounts, newest first, 20 per page')
  .description('list accounts, newest first (20 per page; ←/→ to page in a terminal)')
  .option('-s, --service <name>', 'only this service')
  .option('-e, --email <email>', 'only this email')
  .option('-l, --long', 'every field (notes, dates), one card per account')
  .option('--all', 'print every account at once instead of a page')
  .option('--csv', 'every account as CSV, passwords included (for backups; implies --all)')
  .option('--cursor <cursor>', 'continue from the `more:` hint of a previous listing')
  .option('--json', 'print JSON: one page as { accounts, next }, or with --all a list')
  .action(
    async (o: { service?: string; email?: string; long?: boolean; all?: boolean; csv?: boolean; cursor?: string; json?: boolean }) => {
      const filter = { service: o.service, email: o.email };
      const ctx = await adminCtx();
      const render = (accounts: Account[], width: number) => (o.long ? accountCards(accounts) : accountTable(accounts, width));
      if (o.all || o.csv) {
        const accounts = await listAllAccounts(ctx, filter);
        if (o.csv) return print(toCsv(accounts));
        if (o.json) return print(accounts);
        return print(accounts.length ? render(accounts, terminalWidth()).join('\n') : 'no accounts');
      }
      if (o.json) {
        const page = await listAccountsPage(ctx, filter, { cursor: o.cursor });
        return print(page);
      }
      // Cards are several lines each; in a terminal, size the page to the screen.
      const cardsPerScreen = Math.max(1, Math.floor(((process.stdout.rows ?? 24) - 2) / 8));
      const limit = o.long && process.stdout.isTTY ? Math.min(20, cardsPerScreen) : 20;
      const scope = [o.service && `--service ${o.service}`, o.email && `--email ${o.email}`, o.long && '--long'].filter(Boolean).join(' ');
      await pageThrough({
        fetchPage: async (cursor) => {
          const page = await listAccountsPage(ctx, filter, { limit, cursor: cursor ?? o.cursor });
          return { items: page.accounts, next: page.next };
        },
        render,
        total: o.cursor ? undefined : () => countAccounts(ctx, filter),
        empty: 'no accounts',
        moreHint: (next) => `qmail account ls${scope ? ` ${scope}` : ''}${stageArg()} --cursor ${next}`,
      });
    },
  );

account
  .command('rm <email>')
  .description('delete an account record')
  .requiredOption('-s, --service <name>')
  .action(async (email: string, o: { service: string }) => {
    await removeAccount(await adminCtx(), email, o.service);
    print(`removed ${o.service} account for ${email}`);
  });

// ---- operations (AWS login) -----------------------------------------------------------

program.commandsGroup('Operations (uses your AWS login):');

program
  .command('usage')
  .summary('dashboard: traffic, parsers, storage, alarms, cost')
  .description('dashboard: receiving state, traffic, parsers, Lambda, queue, storage, alarms, and cost')
  .option('--all-stages', 'show every deployed stage')
  .option('--range <range>', `time range: ${Object.keys(RANGES).join(' | ')}`, '7d')
  .option('--watch <seconds>', 'refresh every N seconds (minimum 60)')
  .option('--json', 'print the raw data as JSON')
  .option('--cost', 'add a Cost Explorer breakdown by service (AWS charges $0.01 per run)')
  .action(async (o: { allStages?: boolean; range: string; watch?: string; json?: boolean; cost?: boolean }) => {
    if (!(o.range in RANGES)) throw new Error(`--range must be one of ${Object.keys(RANGES).join(', ')}`);
    const range = o.range as RangeKey;
    const watchS = o.watch === undefined ? undefined : Math.max(60, Number(o.watch));
    const cache = new SlowCache(10 * 60_000);
    const config = await loadConfig();
    const stages = o.allStages ? Object.keys(config.stages) : [adminStage()];
    for (let first = true; ; first = false) {
      const identity = await ensureAws(!first); // re-check each refresh; prompts if SSO expired
      const lines: string[] = [];
      const json: unknown[] = [];
      for (const stage of stages) {
        let ctx;
        try {
          ctx = await stageContext(stage);
        } catch (err) {
          lines.push(color.dim(`stage ${stage}: ${(err as Error).message}`), '');
          continue;
        }
        const data = await collectUsage(ctx, identity, { range, cost: Boolean(o.cost), cache });
        if (o.json) json.push(data);
        else lines.push(...renderUsage(data), '');
      }
      if (o.json) print(stages.length === 1 ? json[0] : json);
      else {
        if (watchS) process.stdout.write('\u001b[2J\u001b[H');
        print(lines.join('\n').trimEnd());
        if (watchS) print(color.dim(`\nrefreshing every ${watchS}s · ctrl-c to quit`));
      }
      if (!watchS || o.json) return;
      await new Promise((r) => setTimeout(r, watchS * 1000));
    }
  });

program
  .command('pause')
  .summary('stop accepting mail')
  .description('stop accepting mail (SES refuses it during SMTP and does not bill it)')
  .action(async () => print((await pause(await adminCtx())) ? 'receiving paused' : 'receiving was already paused'));

program
  .command('resume')
  .summary('accept mail again')
  .description('accept mail again and reset the auto-pause alarms')
  .action(async () => print((await resume(await adminCtx())) ? 'receiving resumed' : 'receiving was already on'));

program
  .command('block [cidr]')
  .summary('refuse mail from an IP range (no argument: list)')
  .description('refuse mail from an IP or CIDR during SMTP (not billed); with no argument, list what is blocked')
  .action(async (cidr: string | undefined) => {
    const ctx = await adminCtx();
    if (!cidr) {
      const blocked = await listBlocked(ctx);
      return print(blocked.length ? blocked.map((f) => f.cidr).join('\n') : 'nothing blocked');
    }
    print(`blocked ${cidr} (SES IP filter ${await blockIp(ctx, cidr)})`);
  });

program
  .command('unblock <cidr>')
  .summary('accept mail from an IP range again')
  .description('accept mail from an IP or CIDR again')
  .action(async (cidr: string) => {
    await unblockIp(await adminCtx(), cidr);
    print(`unblocked ${cidr}`);
  });

const token = program.command('token').summary('API tokens: create | ls | revoke').description('API tokens for the mail commands');
token
  .command('create <name>')
  .description('create a token (printed once; only its hash is stored)')
  .option('--save', 'save it with the API URL to ~/.config/ses-inbox/config.json')
  .action(async (name: string, o: { save?: boolean }) => {
    const ctx = await adminCtx();
    const value = await createToken(ctx, name);
    if (o.save) {
      saveStageCredentials(ctx.stageName, { apiUrl: ctx.outputs.ApiUrl, token: value, domains: ctx.outputs.Domains.split(',') });
      print(`saved token "${name}" for stage ${ctx.stageName}`);
    } else {
      print(value);
    }
  });
token
  .command('ls')
  .description('list token names')
  .action(async () => {
    for (const t of await listTokens(await adminCtx())) print(`${t.name}\tcreated ${t.createdAt}`);
  });
token
  .command('revoke <name>')
  .description('revoke a token')
  .action(async (name: string) => {
    await revokeToken(await adminCtx(), name);
    print(`revoked ${name} (cached copies expire within the API's token cache window)`);
  });

const repair = program.command('repair').summary('after an incident: index | dlq | parsers').description('recovery after an incident: rebuild the index, redrive failed mail, rerun stuck parsers');
repair
  .command('index')
  .description('rebuild the DynamoDB index from the mail in S3')
  .option('--id <ids...>', 'only these message ids')
  .action(async (o: { id?: string[] }) => {
    const result = await reindex(await adminCtx(), {
      onlyIds: o.id,
      onProgress: (n) => n % 100 === 0 && process.stderr.write(`indexed ${n}\n`),
    });
    print(result);
  });
repair
  .command('dlq')
  .description('move mail that failed ingest back to the ingest queue (after fixing the cause)')
  .action(async () => print(`started move task ${await redrive(await adminCtx())}`));
repair
  .command('parsers')
  .description('re-run every parser left pending (after a crash or a deploy)')
  .option('--stuck <age>', 'pending for longer than this (e.g. 30m, 1h)', '1h')
  .action(async (o: { stuck: string }) => {
    const ctx = await adminCtx();
    const stuck = await findStuckParsers(ctx, Date.now() - Date.parse(resolveSince(o.stuck)));
    await enqueueReparse(ctx, stuck);
    print(stuck.length ? `queued ${stuck.length} message(s) for reparse` : 'no stuck parsers');
  });

// ---- formatting -----------------------------------------------------------------------

function flagsOf(m: ListingEntry): string {
  return [m.spam && '[spam]', m.virus && '[virus]', m.parseError && '[parse-error]', m.attachments > 0 && `[att:${m.attachments}]`]
    .filter(Boolean)
    .join(' ');
}

/** One line per message, for `poll`. */
function formatListing(m: ListingEntry): string {
  const flags = flagsOf(m);
  const when = m.receivedAt.replace('T', ' ').slice(0, 19);
  return `${when}  ${m.id}  ${m.from}  ${m.subject || '(no subject)'}${flags ? `  ${flags}` : ''}`;
}

/**
 * A page of messages for `ls`. The id column is never truncated because you copy it into
 * `open`; senders show their display name, recipients on our own domain drop the domain, and
 * the subject keeps the most room.
 */
function listingTable(items: ListingEntry[], width: number, opts: { recipientsOf?: string[] }): string[] {
  const own = opts.recipientsOf?.length === 1 ? opts.recipientsOf[0]! : undefined;
  const to = (m: ListingEntry) => (m.recipients ?? []).map((r) => (own && r.endsWith(`@${own}`) ? r.slice(0, -own.length - 1) : r)).join(', ');
  const rows = items.map((m) => {
    const flags = flagsOf(m);
    const subject = `${m.subject || '(no subject)'}${flags ? ` ${color.yellow(flags)}` : ''}`;
    const when = `${m.receivedAt.slice(5, 10)} ${m.receivedAt.slice(11, 16)}`;
    return opts.recipientsOf ? [when, m.id, to(m), senderName(m.from), subject] : [when, m.id, senderName(m.from), subject];
  });
  const headers = opts.recipientsOf ? ['UTC', 'ID', 'TO', 'FROM', 'SUBJECT'] : ['UTC', 'ID', 'FROM', 'SUBJECT'];
  return table(headers, rows, width, { keep: [0, 1], weights: headers.map((h) => (h === 'SUBJECT' ? 2 : 1)) });
}

/** "Jagex <no-reply@contact.jagex.com>" -> "Jagex"; a bare address stays as it is. */
function senderName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return from;
  return m[1] || m[2]!;
}

function formatMessage(m: MessageView, o: { html?: boolean; headers?: boolean }): string {
  const lines = [
    `id:       ${m.id}`,
    `received: ${m.receivedAt}`,
    `from:     ${m.from.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ') || m.envelopeFrom}`,
    `to:       ${m.recipients.join(', ')}`,
    `subject:  ${m.subject}`,
    `verdicts: ${Object.entries(m.verdicts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  ];
  if (m.parseError) lines.push(`parse error: ${m.parseError}`);
  for (const a of m.attachments) {
    lines.push(`attachment ${a.index}: ${a.filename ?? '(unnamed)'} ${a.contentType} ${a.size} bytes${a.downloadable ? '' : ' (not downloadable)'}`);
  }
  for (const [name, p] of Object.entries(m.parsers)) {
    lines.push(`parser ${name}: ${p.status}${p.error ? ` (${p.error})` : ''}`);
    if (p.output !== undefined) lines.push(JSON.stringify(p.output, null, 2));
  }
  if (o.headers) for (const [k, v] of m.headers) lines.push(`${k}: ${v}`);
  lines.push('', (o.html ? m.html : m.text) ?? '(empty body)');
  return lines.join('\n');
}

async function download(url: string, output: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (output === '-') process.stdout.write(bytes);
  else {
    fs.writeFileSync(output, bytes);
    process.stderr.write(`wrote ${output} (${bytes.length} bytes)\n`);
  }
}

function safeFilename(name: string): string {
  return name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '_') || 'attachment';
}

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  process.stderr.write(`qmail: ${message}\n`);
  process.exitCode = 1;
});
