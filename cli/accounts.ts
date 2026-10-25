import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ACCOUNTS_BY_CREATED, ACCOUNTS_BY_SERVICE } from '../services/shared/keys';
import type { StageContext } from './stack';

/**
 * The account registry: which external services you signed up for with which address, and the
 * login for each. Rows are entered by hand, never expire, and live in their own table with
 * point-in-time recovery. Passwords are stored as plain text by design (these accounts are not
 * sensitive); DynamoDB's default encryption at rest still applies.
 */
export interface Account {
  email: string;
  service: string;
  url?: string;
  username?: string;
  password?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type AccountFields = Partial<Pick<Account, 'url' | 'username' | 'password' | 'notes'>>;

const FIELD_NAMES = ['url', 'username', 'password', 'notes'] as const;

/** Keeps only fields with a value: a missing or blank value never replaces what is stored. */
export function presentFields(fields: AccountFields): AccountFields {
  const out: AccountFields = {};
  for (const name of FIELD_NAMES) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim() !== '') out[name] = value;
  }
  return out;
}

const SERVICE = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`not an email address: ${raw}`);
  return email;
}

export function normalizeService(raw: string): string {
  const service = raw.trim().toLowerCase();
  if (!SERVICE.test(service)) throw new Error(`service must be lowercase letters, digits, "." or "-" (got "${raw}")`);
  return service;
}

export function validateUrl(raw: string): string {
  const url = new URL(raw); // throws on garbage
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`url must be http(s): ${raw}`);
  return url.toString();
}

const keys = (email: string, service: string) => ({ pk: `EMAIL#${email}`, sk: `SVC#${service}` });

type Sender = Pick<DynamoDBDocumentClient, 'send'>;
let makeClient = (ctx: StageContext): Sender =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: ctx.region }), { marshallOptions: { removeUndefinedValues: true } });
const client = (ctx: StageContext) => makeClient(ctx);

/** Tests substitute a fake DynamoDB client. */
export function setAccountsClientForTests(fake: Sender): void {
  makeClient = () => fake;
}

function toAccount(item: Record<string, unknown>): Account {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, gsi2pk: _g3, gsi2sk: _g4, ...rest } = item;
  return rest as unknown as Account;
}

export async function addAccount(ctx: StageContext, rawEmail: string, rawService: string, fields: AccountFields): Promise<Account> {
  const email = normalizeEmail(rawEmail);
  const service = normalizeService(rawService);
  const now = new Date().toISOString();
  const account: Account = {
    email,
    service,
    ...(fields.url ? { url: validateUrl(fields.url) } : {}),
    ...(fields.username ? { username: fields.username } : {}),
    ...(fields.password ? { password: fields.password } : {}),
    ...(fields.notes ? { notes: fields.notes } : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await client(ctx).send(
      new PutCommand({
        TableName: ctx.outputs.AccountsTableName,
        Item: { ...keys(email, service), ...accountIndexKeys(email, service, now), ...account },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new Error(`${email} already has a ${service} account; use \`qmail account set\` to change it`, { cause: err });
    }
    throw err;
  }
  return account;
}

export async function setAccount(
  ctx: StageContext,
  rawEmail: string,
  rawService: string,
  fields: AccountFields,
  opts: { clearPassword?: boolean } = {},
): Promise<Account> {
  const email = normalizeEmail(rawEmail);
  const service = normalizeService(rawService);
  fields = presentFields(fields);
  if (opts.clearPassword && fields.password !== undefined) throw new Error('use either a new password or clear it, not both');
  if (Object.keys(fields).length === 0 && !opts.clearPassword) throw new Error('nothing to change: every value given was empty');
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const set = ['updatedAt = :now'];
  const names: Record<string, string> = {};
  const assign = (field: keyof AccountFields, value: string | undefined) => {
    if (value === undefined) return;
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    set.push(`#${field} = :${field}`);
  };
  assign('url', fields.url === undefined ? undefined : validateUrl(fields.url));
  assign('username', fields.username);
  assign('password', opts.clearPassword ? undefined : fields.password);
  assign('notes', fields.notes);
  let expression = `SET ${set.join(', ')}`;
  if (opts.clearPassword) {
    names['#password'] = 'password';
    expression += ' REMOVE #password';
  }
  try {
    const { Attributes } = await client(ctx).send(
      new UpdateCommand({
        TableName: ctx.outputs.AccountsTableName,
        Key: keys(email, service),
        UpdateExpression: expression,
        ConditionExpression: 'attribute_exists(pk)',
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return toAccount(Attributes ?? {});
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new Error(`no ${service} account for ${email}; use \`qmail account add\` first`, { cause: err });
    }
    throw err;
  }
}

export interface AccountFilter {
  email?: string;
  service?: string;
}

export interface AccountPage {
  accounts: Account[];
  /** Opaque cursor for the next page, or null on the last page. */
  next: string | null;
}

const ALL_ACCOUNTS = 'ACCOUNT';

/** The index keys a row carries so every listing comes back newest first. */
export function accountIndexKeys(email: string, service: string, createdAt: string) {
  return {
    gsi1pk: `SVC#${service}`,
    gsi1sk: `${createdAt}#${email}`,
    gsi2pk: ALL_ACCOUNTS,
    gsi2sk: `${createdAt}#${email}#${service}`,
  };
}

/**
 * Which index answers a filter: one email reads its own partition (sorted by service), one
 * service reads the byService GSI, and everything reads the byCreated GSI. `keyAttrs` are the
 * attributes a cursor needs to resume that query.
 */
function queryFor(ctx: StageContext, filter: AccountFilter) {
  const TableName = ctx.outputs.AccountsTableName;
  if (filter.email) {
    const email = normalizeEmail(filter.email);
    return {
      input: {
        TableName,
        KeyConditionExpression: filter.service ? 'pk = :pk AND sk = :sk' : 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `EMAIL#${email}`, ...(filter.service ? { ':sk': `SVC#${normalizeService(filter.service)}` } : {}) },
      },
      keyAttrs: ['pk', 'sk'],
    };
  }
  if (filter.service) {
    return {
      input: {
        TableName,
        IndexName: ACCOUNTS_BY_SERVICE,
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': `SVC#${normalizeService(filter.service)}` },
        ScanIndexForward: false,
      },
      keyAttrs: ['pk', 'sk', 'gsi1pk', 'gsi1sk'],
    };
  }
  return {
    input: {
      TableName,
      IndexName: ACCOUNTS_BY_CREATED,
      KeyConditionExpression: 'gsi2pk = :pk',
      ExpressionAttributeValues: { ':pk': ALL_ACCOUNTS },
      ScanIndexForward: false,
    },
    keyAttrs: ['pk', 'sk', 'gsi2pk', 'gsi2sk'],
  };
}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (key && typeof key === 'object' && !Array.isArray(key)) return key as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Error('invalid cursor; copy it exactly from the previous page');
}

/**
 * One page of accounts. It reads one row past the page so the last page is known to be last
 * (DynamoDB hands back a resume key whenever it stops at the limit, even with nothing left).
 */
export async function listAccountsPage(
  ctx: StageContext,
  filter: AccountFilter = {},
  opts: { limit?: number; cursor?: string } = {},
): Promise<AccountPage> {
  const limit = opts.limit ?? 20;
  const { input, keyAttrs } = queryFor(ctx, filter);
  const items: Record<string, unknown>[] = [];
  let start = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  do {
    const page = await client(ctx).send(new QueryCommand({ ...input, Limit: limit + 1 - items.length, ExclusiveStartKey: start }));
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start && items.length <= limit);
  const last = items.length > limit ? items[limit - 1]! : undefined;
  return {
    accounts: items.slice(0, limit).map(toAccount),
    next: last ? encodeCursor(Object.fromEntries(keyAttrs.map((k) => [k, last[k]]))) : null,
  };
}

/** Every account matching the filter, in listing order (for `--all` and backups). */
export async function listAllAccounts(ctx: StageContext, filter: AccountFilter = {}): Promise<Account[]> {
  const { input } = queryFor(ctx, filter);
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client(ctx).send(new QueryCommand({ ...input, ExclusiveStartKey: start }));
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items.map(toAccount);
}

/** How many accounts match the filter (DynamoDB counts server-side; nothing is downloaded). */
export async function countAccounts(ctx: StageContext, filter: AccountFilter = {}): Promise<number> {
  const { input } = queryFor(ctx, filter);
  let total = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client(ctx).send(new QueryCommand({ ...input, Select: 'COUNT', ExclusiveStartKey: start }));
    total += page.Count ?? 0;
    start = page.LastEvaluatedKey;
  } while (start);
  return total;
}

/** The service of an email's only account; when it has several, the caller must choose. */
export async function soleService(ctx: StageContext, rawEmail: string): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const accounts = await listAllAccounts(ctx, { email });
  if (accounts.length === 0) throw new Error(`no accounts for ${email}`);
  if (accounts.length > 1) throw new Error(`${email} has accounts for ${accounts.map((a) => a.service).join(', ')}; choose one with --service`);
  return accounts[0]!.service;
}

export async function removeAccount(ctx: StageContext, rawEmail: string, rawService: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const service = normalizeService(rawService);
  try {
    await client(ctx).send(
      new DeleteCommand({ TableName: ctx.outputs.AccountsTableName, Key: keys(email, service), ConditionExpression: 'attribute_exists(pk)' }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new Error(`no ${service} account for ${email}`, { cause: err });
    throw err;
  }
}

const CSV_COLUMNS: Array<keyof Account> = ['email', 'service', 'url', 'username', 'password', 'notes', 'createdAt', 'updatedAt'];

export function toCsv(accounts: Account[]): string {
  const cell = (v: string | undefined) => {
    const s = v ?? '';
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...accounts.map((a) => CSV_COLUMNS.map((c) => cell(a[c])).join(','))].join('\n');
}
