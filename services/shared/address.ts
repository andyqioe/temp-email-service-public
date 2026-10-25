/** Lowercases an address. Local parts are technically case-sensitive, but no real mailbox treats them that way. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

export function localPartOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? address : address.slice(0, at);
}

/** "foo+bar@x" -> "bar"; undefined when there is no plus tag. */
export function plusTagOf(address: string): string | undefined {
  const local = localPartOf(address);
  const plus = local.indexOf('+');
  return plus === -1 ? undefined : local.slice(plus + 1);
}

const globCache = new Map<string, RegExp>();

/** Case-insensitive glob with `*` (any run of characters) and `?` (one character). */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const source = glob
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${source}$`, 'i');
    globCache.set(glob, re);
  }
  return re;
}

/** Recipient glob: with "@" it matches the whole address, without "@" only the local part. */
export function recipientMatches(glob: string, address: string): boolean {
  return globToRegExp(glob).test(glob.includes('@') ? address : localPartOf(address));
}

/** Sender glob: with "@" it matches the whole address, without "@" only the domain. */
export function senderMatches(glob: string, address: string): boolean {
  return globToRegExp(glob).test(glob.includes('@') ? address : domainOf(address));
}

export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
