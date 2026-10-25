import { domainOf, plusTagOf } from './address';
import { dayOf, ddbKeys, META, parserAttr } from './keys';
import { formatAddress, snippetOf, truncate } from './message-text';
import type { MessageSummary, ParsedEmail } from './types';

export const FEED_RECIPIENT_CAP = 50;

export function isSpam(p: Pick<ParsedEmail, 'verdicts'>): boolean {
  return p.verdicts.spam === 'FAIL';
}

export function isVirus(p: Pick<ParsedEmail, 'verdicts'>): boolean {
  return p.verdicts.virus === 'FAIL';
}

export function buildSummary(p: ParsedEmail): MessageSummary {
  return {
    id: p.id,
    receivedAt: p.receivedAt,
    from: truncate(formatAddress(p.from[0]) || p.envelope.from, 200),
    subject: truncate(p.subject, 200),
    snippet: snippetOf(p.text),
    size: p.size,
    attachments: p.attachments.length,
    spam: isSpam(p),
    virus: isVirus(p),
    parseError: p.parseError !== undefined,
  };
}

/** ADDR# entries (one per recipient) and FEED# entries (one per receiving domain). */
export function buildListingItems(
  p: ParsedEmail,
  opts: { indexedAt: string; ttl?: number },
): Record<string, unknown>[] {
  const summary = buildSummary(p);
  const sk = ddbKeys.sort(p.receivedAt, p.id);
  const ix = ddbKeys.indexed(opts.indexedAt, p.id);
  const ttl = opts.ttl === undefined ? {} : { ttl: opts.ttl };

  const perAddress = p.envelope.recipients.map((address) => {
    const tag = plusTagOf(address);
    return {
      pk: ddbKeys.address(address),
      sk,
      ix,
      ...summary,
      address,
      ...(tag === undefined ? {} : { tag }),
      ...ttl,
    };
  });

  const domains = [...new Set(p.envelope.recipients.map(domainOf))];
  const perDomain = domains.map((domain) => ({
    pk: ddbKeys.feed(domain, dayOf(p.receivedAt)),
    sk,
    ix,
    ...summary,
    recipients: p.envelope.recipients.filter((r) => domainOf(r) === domain).slice(0, FEED_RECIPIENT_CAP),
    ...ttl,
  }));

  return [...perAddress, ...perDomain];
}

/** Keys of every listing entry for a message, for deletes. */
export function listingKeys(msg: { id: string; receivedAt: string; recipients: string[] }) {
  const sk = ddbKeys.sort(msg.receivedAt, msg.id);
  const domains = [...new Set(msg.recipients.map(domainOf))];
  return [
    ...msg.recipients.map((r) => ({ pk: ddbKeys.address(r), sk })),
    ...domains.map((d) => ({ pk: ddbKeys.feed(d, dayOf(msg.receivedAt)), sk })),
  ];
}

/**
 * UpdateItem input for the MSG# record. Parser status fields are only initialized
 * when absent, so a retried ingest never resets a parser that already finished.
 */
export function buildMessageUpdate(
  p: ParsedEmail,
  opts: { tableName: string; parsers: string[]; now: string; ttl?: number },
) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':id': p.id,
    ':receivedAt': p.receivedAt,
    ':recipients': p.envelope.recipients,
    ':envelopeFrom': p.envelope.from,
    ':from': buildSummary(p).from,
    ':subject': truncate(p.subject, 200),
    ':size': p.size,
    ':verdicts': p.verdicts,
    ':attachments': p.attachments,
    ':raw': p.raw,
  };
  const set = [
    'id = :id',
    'receivedAt = :receivedAt',
    'recipients = :recipients',
    'envelopeFrom = :envelopeFrom',
    '#from = :from',
    'subject = :subject',
    '#size = :size',
    'verdicts = :verdicts',
    'attachments = :attachments',
    '#raw = :raw',
  ];
  names['#from'] = 'from';
  names['#size'] = 'size';
  names['#raw'] = 'raw';
  const remove: string[] = [];

  if (p.parseError !== undefined) {
    set.push('parseError = :parseError');
    values[':parseError'] = p.parseError;
  } else {
    remove.push('parseError');
  }
  if (opts.ttl !== undefined) {
    set.push('#ttl = :ttl');
    names['#ttl'] = 'ttl';
    values[':ttl'] = opts.ttl;
  }
  opts.parsers.forEach((parser, i) => {
    names[`#p${i}`] = parserAttr(parser);
    set.push(`#p${i} = if_not_exists(#p${i}, :pending)`);
  });
  if (opts.parsers.length > 0) values[':pending'] = { status: 'pending', attempts: 0, updatedAt: opts.now };

  return {
    TableName: opts.tableName,
    Key: { pk: ddbKeys.message(p.id), sk: META },
    UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW' as const,
  };
}
