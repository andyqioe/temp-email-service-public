import { recipientMatches, senderMatches, toArray } from './address';
import type { ParserRoute } from './types';

export interface RoutingInput {
  /** Indexed envelope recipients (already lowercased and filtered to our domains). */
  recipients: string[];
  /** First From-header address, lowercased. */
  from?: string;
  subject: string;
  dmarc: string;
  spam: boolean;
  virus: boolean;
}

export interface RouteMatch {
  parser: string;
  matchedRecipients: string[];
}

/**
 * Returns every parser whose rule matches. All conditions in a rule must hold.
 * Nothing runs on mail with a FAIL virus verdict.
 */
export function matchParsers(routes: ParserRoute[], input: RoutingInput): RouteMatch[] {
  if (input.virus) return [];
  const matches: RouteMatch[] = [];
  for (const route of routes) {
    const m = matchOne(route, input);
    if (m) matches.push(m);
  }
  return matches;
}

export function matchOne(route: ParserRoute, input: RoutingInput): RouteMatch | undefined {
  if (input.virus) return undefined;
  if (route.skipSpam && input.spam) return undefined;

  const recipientGlobs = toArray(route.match.recipient);
  const matchedRecipients =
    recipientGlobs.length === 0
      ? input.recipients
      : input.recipients.filter((r) => recipientGlobs.some((g) => recipientMatches(g, r)));
  if (matchedRecipients.length === 0) return undefined;

  const fromGlobs = toArray(route.match.from);
  if (fromGlobs.length > 0) {
    if (!input.from || !fromGlobs.some((g) => senderMatches(g, input.from as string))) return undefined;
    if (route.requireDmarcForFrom && input.dmarc !== 'PASS') return undefined;
  }

  if (route.match.subject !== undefined && !new RegExp(route.match.subject, 'i').test(input.subject)) {
    return undefined;
  }

  return { parser: route.name, matchedRecipients };
}
