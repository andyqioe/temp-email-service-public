import { createHash, randomBytes } from 'node:crypto';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ddbKeys, META } from '../shared/keys';

export const TOKEN_PREFIX = 'sit_';
const TOKEN_PATTERN = /^sit_[A-Za-z0-9_-]{43}$/;
const CACHE_MAX = 1000;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface CacheEntry {
  name: string | null;
  expires: number;
}

/**
 * Bearer-token check. Only SHA-256 hashes are stored, so a table dump leaks no usable
 * token, and lookup by hash is not timing-sensitive. Results (hits and misses) are cached
 * briefly per container; revocation therefore takes effect within `cacheSeconds`.
 */
export class TokenAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly cacheSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the token's name, or null when the header is missing or the token is unknown. */
  async authenticate(authorization: string | undefined): Promise<string | null> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const hash = hashToken(token);

    const cached = this.cache.get(hash);
    if (cached && cached.expires > this.now()) return cached.name;

    const { Item } = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { pk: ddbKeys.token(hash), sk: META }, ConsistentRead: true }),
    );
    const name = typeof Item?.name === 'string' ? Item.name : null;
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(hash, { name, expires: this.now() + this.cacheSeconds * 1000 });
    return name;
  }
}
